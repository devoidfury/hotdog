// Token estimation — chars/4 heuristic shared by core (ContextManager) and
// extensions (compaction). Deliberately overestimates; it only gates
// decisions, it is never a billing number.

/**
 * Structural type for anything message-shaped: core `Message` instances and
 * plain persistence JSON both satisfy it.
 */
export interface MessageLike {
  role?: string;
  content?: string | Array<unknown>;
  reasoningContent?: string | null;
  reasoning_content?: string;
  toolCalls?: unknown;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

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
