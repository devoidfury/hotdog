// Compaction utilities — token estimation, message serialization, helpers.

// ── Token Estimation ────────────────────────────────────────────────────────

/**
 * Estimate token count for a message using chars/4 heuristic (conservative overestimate).
 */
export function estimateMessageTokens(msg) {
  const chars = _messageCharCount(msg);
  return Math.ceil(chars / 4);
}

/**
 * Count characters in a message for token estimation.
 */
function _messageCharCount(msg) {
  switch (msg.role) {
    case "user":
    case "system":
      return msg.content.length;
    case "assistant": {
      let chars = msg.content.length;
      if (msg.reasoning_content) chars += msg.reasoning_content.length;
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chars +=
            (tc.function?.name || "").length +
            (tc.function?.arguments || "").length;
        }
      }
      return chars;
    }
    case "tool":
      return msg.content.length;
    default:
      return msg.content.length;
  }
}

/**
 * Estimate total token count for all messages in context.
 */
export function estimateContextTokens(messages) {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

// ── Compaction Decision ─────────────────────────────────────────────────────

/**
 * Find the index of the first message to keep verbatim.
 * Counts from the end, skipping system messages, until we have
 * `keepRecent * 2` messages (roughly `keepRecent` user+assistant pairs).
 * Returns 0 if keepRecent=0 or not enough messages found.
 */
export function findFirstKeptIndex(messages, keepRecent) {
  if (keepRecent === 0) return 0;

  let count = 0;
  const target = keepRecent * 2;

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "system") continue;
    count++;
    if (count >= target) return i + 1;
  }

  return 0;
}

// ── Compaction Decision ─────────────────────────────────────────────────────

/**
 * Check if compaction should be triggered.
 */
export function shouldCompact(messages, contextLimit, reserveTokens) {
  const estimated = estimateContextTokens(messages);
  return estimated > contextLimit - reserveTokens;
}

// ── Serialization ───────────────────────────────────────────────────────────

const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Serialize messages to text for summarization.
 * Wraps in role tags to prevent the model from treating it as a conversation.
 */
export function serializeConversation(messages) {
  const parts = [];

  for (const msg of messages) {
    switch (msg.role) {
      case "user":
        parts.push(`[User]: ${msg.content}`);
        break;
      case "assistant": {
        if (msg.reasoning_content) {
          parts.push(`[Assistant thinking]: ${msg.reasoning_content}`);
        }
        if (msg.content) {
          parts.push(`[Assistant]: ${msg.content}`);
        }
        if (msg.tool_calls) {
          const calls = msg.tool_calls
            .map(
              (tc) => `${tc.function?.name}(${tc.function?.arguments || ""})`,
            )
            .join("; ");
          parts.push(`[Assistant tool calls]: ${calls}`);
        }
        break;
      }
      case "tool": {
        const truncated =
          msg.content.length > TOOL_RESULT_MAX_CHARS
            ? `${msg.content.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${msg.content.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`
            : msg.content;
        parts.push(`[Tool result]: ${truncated}`);
        break;
      }
      case "system":
        // Skip system messages in summary (they're re-injected)
        break;
      default:
        parts.push(`[${msg.role}]: ${msg.content}`);
    }
  }

  return parts.join("\n\n");
}

// ── Public API ──────────────────────────────────────────────────────────────

import {
  SUMMARIZATION_SYSTEM_PROMPT,
  SUMMARIZATION_USER_PROMPT_TEMPLATE,
} from "./prompts.js";

/**
 * Compact the context by summarizing older messages.
 *
 * @param {Array} messages - Current messages in context.
 * @param {Function} llmChat - Async function that calls the LLM: (messages, model) => string.
 * @param {string} model - Model name to use for summarization.
 * @param {object} settings - Compaction settings.
 * @param {boolean} settings.enabled - Whether compaction is enabled.
 * @param {number} settings.reserveTokens - Token reserve to maintain after compaction.
 * @param {number} settings.keepRecent - Number of recent messages to keep verbatim.
 * @returns {{ summary: string, messagesCompacted: number } | null} Summary result, or null if compaction skipped.
 */
export async function compactMessages(messages, llmChat, model, settings) {
  if (!settings.enabled) return null;

  const firstKept = findFirstKeptIndex(messages, settings.keepRecent);
  if (firstKept === 0) return null;

  const messagesToCompact = messages.slice(0, firstKept);
  const conversation = serializeConversation(messagesToCompact);
  const userPrompt = SUMMARIZATION_USER_PROMPT_TEMPLATE.replace(
    "{conversation}",
    conversation,
  );

  const summaryMessages = [
    { role: "system", content: SUMMARIZATION_SYSTEM_PROMPT },
    { role: "user", content: userPrompt },
  ];

  let summary;
  try {
    summary = await llmChat(summaryMessages, model);
  } catch (e) {
    throw new Error(`Summarization failed: ${e.message}`);
  }

  return { summary, messagesCompacted: firstKept };
}
