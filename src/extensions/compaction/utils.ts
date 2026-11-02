// Token estimation is general-purpose (core's ContextManager uses it too), so
// it lives in src/utils and is re-exported here to keep the extension API stable.
import {
  estimateMessageTokens,
  estimateContextTokens,
  type MessageLike as EstimatableMessageLike,
  type ToolResultEstimator,
} from "@utils/token-estimate.ts";
import { contentToText, type Message } from "@core/context/message.ts";
import { isWrapperPart, renderWrapperForWire } from "@core/context/wrappers.ts";
import type { WireFormat } from "@core/extensions/wire-format.ts";
import type { MarkerMangler } from "@core/marker-mangler.ts";
import { AgentError } from "@core/error.ts";
import { SUMMARIZATION_SYSTEM_PROMPT } from "./prompts.ts";

export { estimateMessageTokens, estimateContextTokens };

const TOOL_RESULT_MAX_CHARS = 2000;

// Use a local interface for flexibility (accepts both core Message and plain objects)
interface MessageLike extends EstimatableMessageLike {
  toolCallId?: string | null;
  images?: unknown[] | null;
}

// ── Compaction Decision ─────────────────────────────────────────────────────

/**
 * Find the index of the first message to keep verbatim.
 * Counts from the end, skipping system messages, until we have
 * `keepRecent * 2` messages (roughly `keepRecent` user+assistant pairs).
 * Returns 0 if keepRecent=0 or not enough messages found.
 *
 * The boundary is backed up so it never splits an assistant tool_calls
 * message from its tool results: strict OpenAI-compatible backends reject
 * a tool message that is not preceded by the assistant message containing
 * the matching tool_call_id.
 */
export function findFirstKeptIndex(messages: MessageLike[], keepRecent: number): number {
  if (keepRecent === 0) return 0;

  let count = 0;
  const target = keepRecent * 2;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "system") continue;
    count++;
    if (count >= target) {
      let firstKept = i + 1;
      // Back up across tool results so their parent assistant message stays
      // in the kept window. Stops at 0 if no parent exists in the context.
      while (firstKept > 0 && messages[firstKept]!.role === "tool") {
        firstKept--;
      }
      return firstKept;
    }
  }

  return 0;
}

export function shouldCompact(
  messages: MessageLike[],
  contextLimit: number,
  reserveTokens: number = 16384,
  wire?: WireRenderContext | null,
  actualPromptTokens?: number,
): boolean {
  const gate = contextLimit - reserveTokens;
  const estimated = estimateContextTokens(messages, estimatorFor(wire));
  if (estimated > gate) return true;
  // chars/4 UNDERcounts dense code (real tokenizers run ~3.2 chars/token there),
  // so the estimate can sit below the gate while the provider is already at 100%.
  // The provider's own count from the last call is ground truth for the shared
  // prefix; treat it as a second opinion, not a replacement (a fresh turn's
  // usage predates whatever was appended since).
  return (actualPromptTokens ?? 0) > gate;
}

// ── Model-facing wire render ────────────────────────────────────────────────
//
// The summarization dump goes to a model, so it must speak the session's
// presentation: genuine harness wrappers, aliased tool payloads, one
// consistent shape per session (the same WireFormat the main loop uses). The
// dump is PRE-mangled and sent as a harness-sourced message
// (_performCompaction.llmChat) -- otherwise the wire serializer would treat
// the whole dump as untrusted text and alias the genuine wrappers right back
// out of it.
export interface WireRenderContext {
  mangler: MarkerMangler | null;
  wireFormat: WireFormat | null;
}

/** Estimator measuring tool-result parts at the session's wire size. */
export function estimatorFor(wire?: WireRenderContext | null): ToolResultEstimator | undefined {
  const fmt = wire?.wireFormat ?? null;
  return fmt ? (part) => fmt.renderToolResult(part) : undefined;
}

/** Mangle text headed for the wire; identity when no mangler is configured. */
function wireEscape(s: string, wire?: WireRenderContext | null): string {
  return wire?.mangler ? (wire.mangler.escape(s) ?? s) : s;
}

/**
 * Flatten message content for the dump. With a wire context: every
 * non-harness field is mangled and wrapper parts render through
 * renderWrapperForWire (real framing, session format). Without one: the
 * at-rest flatten of contentToText (legacy callers, tests).
 */
function dumpContent(
  content: string | Array<unknown> | null | undefined,
  wire?: WireRenderContext | null,
): string {
  if (content == null) return "";
  if (!wire) return contentToText(content);
  if (typeof content === "string") return wireEscape(content, wire);
  const rendered: string[] = [];
  for (const part of content) {
    if (isWrapperPart(part)) {
      rendered.push(renderWrapperForWire(part, wire.mangler, wire.wireFormat));
    } else if (part && typeof part === "object") {
      const p = part as Record<string, unknown>;
      if ((p.type === "text" || p.type === "untrusted") && typeof p.text === "string") {
        rendered.push(wireEscape(p.text, wire));
      }
    }
  }
  return rendered.join("\n");
}

// ── Serialization ───────────────────────────────────────────────────────────

// Role tags on each line stop the model from treating the dump as a live conversation.
export function serializeConversation(
  messages: MessageLike[],
  wire?: WireRenderContext | null,
): string {
  const parts: string[] = [];

  // With a wire context the dump is pre-mangled and format-rendered (see
  // dumpContent); without one, contentToText() flattens part arrays at rest.
  const getContentStr = (content: string | Array<unknown> | undefined): string =>
    dumpContent(content, wire);

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        parts.push(`[User]: ${getContentStr(msg.content)}`);
        break;
      case "assistant": {
        const reasoning = msg.reasoningContent ?? msg.reasoning_content;
        if (reasoning) {
          parts.push(`[Assistant thinking]: ${wireEscape(reasoning, wire)}`);
        }
        const content = getContentStr(msg.content);
        if (content) {
          parts.push(`[Assistant]: ${content}`);
        }
        const toolCalls = msg.toolCalls ?? msg.tool_calls;
        if (Array.isArray(toolCalls)) {
          const calls = toolCalls
            .map(
              (tc) =>
                `${wireEscape((tc as { function?: { name?: string } }).function?.name ?? "", wire)}(${wireEscape((tc as { function?: { name?: string; arguments?: string } }).function?.arguments || "", wire)})`,
            )
            .join("; ");
          parts.push(`[Assistant tool calls]: ${calls}`);
        }
        break;
      }
      case "tool": {
        const contentStr = getContentStr(msg.content);
        const truncated =
          contentStr.length > TOOL_RESULT_MAX_CHARS
            ? `${contentStr.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${contentStr.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`
            : contentStr;
        parts.push(`[Tool result]: ${truncated}`);
        break;
      }
      case "system":
        // Skip system messages in summary (they're re-injected)
        break;
      default:
        parts.push(`[${msg.role ?? "unknown"}]: ${getContentStr(msg.content)}`);
    }
  }

  return parts.join("\n\n");
}

// ── Summarization call ──────────────────────────────────────────────────────

/**
 * Shared LLM-summarization call for the summarize strategies: serialize the
 * compacted conversation into the strategy's user prompt template, run the
 * chat call, and wrap failures in AgentError.SummarizationFailed.
 */
export async function runSummarization(
  messagesToSummarize: Message[],
  wire: WireRenderContext | null | undefined,
  llmChat: (messages: Array<{ role: string; content: string }>, model: string) => Promise<string>,
  model: string,
  userPromptTemplate: string,
): Promise<string> {
  const conversation = serializeConversation(messagesToSummarize, wire);
  const userPrompt = userPromptTemplate.replace("{conversation}", () => conversation);

  const summaryMessages = [
    { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  try {
    return await llmChat(summaryMessages, model);
  } catch (e: unknown) {
    throw AgentError.SummarizationFailed((e as Error).message);
  }
}
