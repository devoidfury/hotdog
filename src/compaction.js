// Context compaction for long sessions.
//
// When the conversation context approaches the model's context window limit,
// compaction summarizes older messages and replaces them with a structured
// summary, preserving recent messages verbatim.
//
// ## Flow
//
// 1. `estimateContextTokens()` — approximate token count of current context
// 2. `shouldCompact()` — check if compaction is needed
// 3. `compactMessages()` — generate LLM summary and replace old messages

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
    case 'user':
    case 'system':
      return msg.content.length;
    case 'assistant': {
      let chars = msg.content.length;
      if (msg.reasoning_content) chars += msg.reasoning_content.length;
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          chars += (tc.function?.name || '').length + (tc.function?.arguments || '').length;
        }
      }
      return chars;
    }
    case 'tool':
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
 * Check if compaction should be triggered.
 */
export function shouldCompact(messages, contextLimit, reserveTokens) {
  const estimated = estimateContextTokens(messages);
  return estimated > contextLimit - reserveTokens;
}

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
    if (messages[i].role === 'system') continue;
    count++;
    if (count >= target) return i + 1;
  }

  return 0;
}

// ── Summarization Prompts ──────────────────────────────────────────────────

export const SUMMARIZATION_SYSTEM_PROMPT =
  'You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.\n\nDo NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary.';

export const SUMMARIZATION_USER_PROMPT_TEMPLATE = `
The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

## Goal
[What is the user trying to accomplish? Can be multiple items if the session covers different tasks.]

## Progress
### Done
- [x] [Completed tasks/changes]

### In Progress
- [ ] [Current work]

### Blocked
- [Issues preventing progress, if any]

## Key Decisions
- **[Decision]**: [Brief rationale]

## Next Steps
1. [Ordered list of what should happen next]

## Critical Context
- [Any data, examples, or references needed to continue]
- [Or "(none)" if not applicable]

Keep each section concise. Preserve exact file paths, function names, and error messages.

<conversation>
{conversation}
</conversation>`;

const TOOL_RESULT_MAX_CHARS = 2000;

/**
 * Serialize messages to text for summarization.
 * Wraps in role tags to prevent the model from treating it as a conversation.
 */
export function serializeConversation(messages) {
  const parts = [];

  for (const msg of messages) {
    switch (msg.role) {
      case 'user':
        parts.push(`[User]: ${msg.content}`);
        break;
      case 'assistant': {
        if (msg.reasoning_content) {
          parts.push(`[Assistant thinking]: ${msg.reasoning_content}`);
        }
        if (msg.content) {
          parts.push(`[Assistant]: ${msg.content}`);
        }
        if (msg.tool_calls) {
          const calls = msg.tool_calls
            .map(tc => `${tc.function?.name}(${tc.function?.arguments || ''})`)
            .join('; ');
          parts.push(`[Assistant tool calls]: ${calls}`);
        }
        break;
      }
      case 'tool': {
        const truncated = msg.content.length > TOOL_RESULT_MAX_CHARS
          ? `${msg.content.slice(0, TOOL_RESULT_MAX_CHARS)}\n\n[... ${msg.content.length - TOOL_RESULT_MAX_CHARS} more characters truncated]`
          : msg.content;
        parts.push(`[Tool result]: ${truncated}`);
        break;
      }
      case 'system':
        // Skip system messages in summary (they're re-injected)
        break;
      default:
        parts.push(`[${msg.role}]: ${msg.content}`);
    }
  }

  return parts.join('\n\n');
}

// ── Public API ──────────────────────────────────────────────────────────────

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
  const userPrompt = SUMMARIZATION_USER_PROMPT_TEMPLATE.replace('{conversation}', conversation);

  const summaryMessages = [
    { role: 'system', content: SUMMARIZATION_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt },
  ];

  let summary;
  try {
    summary = await llmChat(summaryMessages, model);
  } catch (e) {
    throw new Error(`Summarization failed: ${e.message}`);
  }

  return { summary, messagesCompacted: firstKept };
}
