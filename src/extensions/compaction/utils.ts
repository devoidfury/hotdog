import { SUMMARIZATION_SYSTEM_PROMPT, SUMMARIZATION_USER_PROMPT_TEMPLATE } from "./prompts.ts";
import { AgentError } from "@core/error.ts";

const TOOL_RESULT_MAX_CHARS = 2000;

// Use a local interface for flexibility (accepts both core Message and plain objects)
interface MessageLike {
  role: string | undefined;
  content?: string | Array<unknown> | undefined;
  reasoningContent?: string | null;
  reasoning_content?: string;
  toolCalls?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
  toolCallId?: string | null;
  images?: unknown[] | null;
}

// ── Token Estimation ────────────────────────────────────────────────────────

// chars/4 heuristic; deliberately overestimates.
export function estimateMessageTokens(msg: MessageLike): number {
  const chars = _messageCharCount(msg);
  return Math.ceil(chars / 4);
}

function _messageCharCount(msg: MessageLike): number {
  const getContentLength = (content: string | Array<unknown> | undefined): number => {
    if (typeof content === "string") return content.length;
    if (Array.isArray(content)) return content.map((p) => String(p).length).reduce((a, b) => a + b, 0);
    return 0;
  };

  switch (msg.role) {
    case "user":
    case "system":
      return getContentLength(msg.content);
    case "assistant": {
      let chars = getContentLength(msg.content);
      const reasoning = msg.reasoningContent ?? msg.reasoning_content;
      if (reasoning) chars += reasoning.length;
      const toolCalls = msg.toolCalls ?? msg.tool_calls;
      if (Array.isArray(toolCalls)) {
        for (const tc of toolCalls) {
          const fn = (tc as { function?: { name?: string; arguments?: string } }).function;
          chars += (fn?.name || "").length + (fn?.arguments || "").length;
        }
      }
      return chars;
    }
    case "tool":
      return getContentLength(msg.content);
    default:
      return getContentLength(msg.content);
  }
}

export function estimateContextTokens(messages: MessageLike[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
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
): boolean {
  const estimated = estimateContextTokens(messages);
  return estimated > contextLimit - reserveTokens;
}

// ── Serialization ───────────────────────────────────────────────────────────

// Role tags on each line stop the model from treating the dump as a live conversation.
export function serializeConversation(messages: MessageLike[]): string {
  const parts: string[] = [];

  const getContentStr = (content: string | Array<unknown> | undefined): string => {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) return content.map((p) => String(p)).join("\n");
    return "";
  };

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        parts.push(`[User]: ${getContentStr(msg.content)}`);
        break;
      case "assistant": {
        const reasoning = msg.reasoningContent ?? msg.reasoning_content;
        if (reasoning) {
          parts.push(`[Assistant thinking]: ${reasoning}`);
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
                `${(tc as { function?: { name?: string; arguments?: string } }).function?.name}(${(tc as { function?: { name?: string; arguments?: string } }).function?.arguments || ""})`,
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

interface CompactionSettings {
  enabled: boolean;
  reserveTokens: number;
  keepRecentMessages: number;
}

interface CompactResult {
  summary: string;
  messagesCompacted: number;
}

export async function compactMessages(
  messages: MessageLike[],
  llmChat: (messages: Array<{ role: string; content: string }>, model: string) => Promise<string>,
  model: string,
  settings: CompactionSettings,
): Promise<CompactResult | null> {
  if (!settings.enabled) return null;

  const firstKept = findFirstKeptIndex(messages, settings.keepRecentMessages);
  if (firstKept === 0) return null;

  const messagesToCompact = messages.slice(0, firstKept);
  const conversation = serializeConversation(messagesToCompact);
  const userPrompt = SUMMARIZATION_USER_PROMPT_TEMPLATE.replace("{conversation}", () => conversation);

  const summaryMessages = [
    { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let summary: string;
  try {
    summary = await llmChat(summaryMessages, model);
  } catch (e: unknown) {
    throw AgentError.SummarizationFailed((e as Error).message);
  }

  return { summary, messagesCompacted: firstKept };
}
