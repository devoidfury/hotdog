// Token estimation — chars/4 heuristic shared by core (ContextManager) and
// extensions (compaction). Deliberately overestimates; it only gates
// decisions, it is never a billing number.

import { contentToText } from "@core/context/message.ts";
import { isToolResultPart, type ToolResultPart } from "@core/context/wrappers.ts";

/**
 * Estimates tool-result parts at their WIRE size. A session whose WireFormat
 * renders results differently (wrapper overhead differs) must be measured the
 * way the model will actually see them, or the compaction gate fires early.
 * Callers without a resolved format leave this undefined and get the at-rest
 * (JSON data) form.
 */
export type ToolResultEstimator = (part: ToolResultPart) => string;

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

export function estimateMessageTokens(
  msg: MessageLike,
  toolResultText?: ToolResultEstimator | null,
): number {
  const chars = _messageCharCount(msg, toolResultText);
  return Math.ceil(chars / 4);
}

function _messageCharCount(msg: MessageLike, toolResultText?: ToolResultEstimator | null): number {
  const getContentLength = (content: string | Array<unknown> | undefined): number =>
    estimateContentChars(content, toolResultText);

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

/**
 * Char count of a content value. Without an estimator this is
 * contentToText() (part arrays flattened, tool-result parts counted as their
 * at-rest JSON). With one, tool-result parts are measured in the session's
 * format shape instead -- every other part type is core's, unchanged.
 */
export function estimateContentChars(
  content: string | Array<unknown> | null | undefined,
  toolResultText?: ToolResultEstimator | null,
): number {
  if (!toolResultText) return contentToText(content).length;
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  let total = 0;
  for (const part of content) {
    if (isToolResultPart(part)) total += toolResultText(part).length;
    else total += contentToText([part]).length;
  }
  return total;
}

export function estimateContextTokens(
  messages: MessageLike[],
  toolResultText?: ToolResultEstimator | null,
): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg, toolResultText), 0);
}
