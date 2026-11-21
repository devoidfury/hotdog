// Token estimation is general-purpose (core's ContextManager uses it too), so
// it lives in src/utils and is re-exported here to keep the extension API stable.
import {
  estimateMessageTokens,
  estimateContextTokens,
  type MessageLike as EstimatableMessageLike,
  type ToolResultEstimator,
} from "@utils/token-estimate.ts";
import { contentToText, Message, type ImageAttachment } from "@core/context/message.ts";
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
  // usage predates whatever was appended since). Callers may pass
  // max(last-call usage, billed-anchor + appended-delta) so the second
  // opinion tracks the live context, not a stale snapshot; the raw usage
  // stays inside that max as the floor when no anchor is alive.
  return (actualPromptTokens ?? 0) > gate;
}

// ── Image downgrade (overflow rescue) ───────────────────────────────────────

/**
 * Placeholder text left where a stripped image payload used to ride.
 * Anti-hallucination copy in the opencode idiom (survey run
 * adhoc-20261118-image-compaction-survey): the pixels are gone, so a bare
 * "[image omitted]" invites the model to describe them from whatever it
 * remembers -- the line must say what happened, forbid memory claims, and
 * point at the real recovery paths (re-attach the image, or re-read the
 * on-disk path the tool text kept -- hedged "if the tool recorded one":
 * inline pasted base64 never touches disk, and an unqualified pointer there
 * would be confabulation-bait itself). One line: every stripped payload
 * pays its cost in every later request.
 */
export const IMAGE_OMITTED_NOTICE =
  "[image removed by compaction - do not describe or make claims about its contents from memory; if you need it, re-attach the image or re-read its saved on-disk path, if the tool recorded one]";

/** True when this message already carries the placeholder (FROZEN below). */
function hasImageNotice(msg: Message): boolean {
  return contentToText(msg.content).includes(IMAGE_OMITTED_NOTICE);
}

/**
 * Replace the payloads of all but the NEWEST `keepRecentImages` images with
 * a text placeholder, keeping every message (and its text) in place. Old
 * screenshots are ephemeral -- tool results record the on-disk path, so the
 * model can still re-read one it genuinely needs -- while their base64 is
 * the weight the estimator can least calibrate against the provider.
 *
 * MONOTONIC / FROZEN: a message that already carries the placeholder is
 * returned untouched -- downgrades advance only FORWARD through the
 * transcript, and every message before the new cut line keeps its exact
 * bytes so the provider's prompt-cache prefix survives the next rescue.
 * The cost: a payload that survived an earlier partial downgrade on a
 * notice-carrying message is never squeezed later (rare; cache stability
 * wins).
 *
 * Returns the rewritten array and how many image payloads were dropped;
 * `strippedImages === 0` means the array came back untouched (nothing to
 * downgrade). Messages are rebuilt, never mutated: context messages are
 * shared with the session log and anything else holding the reference.
 */
export function downgradeOlderImages(
  messages: Message[],
  keepRecentImages: number,
): { messages: Message[]; strippedImages: number } {
  // Count images from the newest end; everything past the budget goes.
  let seen = 0;
  const keepFrom: number[] = []; // per-message index where kept images start
  for (let i = messages.length - 1; i >= 0; i--) {
    const images = messages[i]!.images;
    if (!images || images.length === 0) continue;
    const remaining = Math.max(0, keepRecentImages - seen);
    keepFrom[i] = images.length - Math.min(images.length, remaining);
    seen += images.length;
  }
  if (seen <= keepRecentImages) return { messages, strippedImages: 0 };

  let strippedImages = 0;
  const out = messages.map((msg, i) => {
    const images = msg.images;
    if (!images || images.length === 0) return msg;
    if (hasImageNotice(msg)) return msg; // frozen: byte-stable across rescues
    const from = keepFrom[i] ?? images.length;
    if (from === 0) return msg; // fully inside the recent-image budget
    strippedImages += from;
    const kept: ImageAttachment[] | undefined = images.slice(from);
    const text = `\n${IMAGE_OMITTED_NOTICE}`;
    let content: Message["content"];
    if (typeof msg.content === "string") content = msg.content + text;
    else if (Array.isArray(msg.content)) content = [...msg.content, { type: "text", text: IMAGE_OMITTED_NOTICE }];
    else content = IMAGE_OMITTED_NOTICE;
    return new Message({
      role: msg.role,
      content,
      reasoningContent: msg.reasoningContent,
      toolCalls: msg.toolCalls,
      toolCallId: msg.toolCallId,
      images: kept.length > 0 ? kept : undefined,
      source: msg.source,
    });
  });
  return { messages: out, strippedImages };
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
