// Token estimation — chars/4 heuristic shared by core (ContextManager) and
// extensions (compaction). Deliberately overestimates; it only gates
// decisions, it is never a billing number.

import { contentToText } from "@core/context/message.ts";

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

export function estimateMessageTokens(msg: MessageLike): number {
  const chars = _messageCharCount(msg);
  return Math.ceil(chars / 4);
}

function _messageCharCount(msg: MessageLike): number {
  // contentToText() flattens part arrays (text/untrusted parts, wrapper
  // parts rendered at rest; images dropped) -- String()ing a part object
  // would count "[object Object]", not its payload.
  const getContentLength = (content: string | Array<unknown> | undefined): number =>
    contentToText(content).length;

  if (msg.role !== "assistant") {
    return getContentLength(msg.content);
  }

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

export function estimateContextTokens(messages: MessageLike[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}
