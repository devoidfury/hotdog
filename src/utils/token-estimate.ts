// Token estimation — chars/4 heuristic shared by core (ContextManager) and
// extensions (compaction). Heuristic only: it overestimates prose but
// UNDERcounts dense code (real tokenizers hit ~3.2 chars/token there), so
// compaction gates on it alongside the provider's reported usage, never on
// this number alone as a safety margin.
//
// Image payloads ride a separate weight (see estimateImageTokens): some
// providers bill image tokens outside the usage they REPORT (2026-11-18
// incident: a session whose last provider usage read 66,569 tokens actually
// carried ~7.9 MB of base64 screenshots and got a 400 at 262,144), so an
// estimator that drops images makes the trigger, the rescue gate, and the
// gauge all lie at exactly the wrong moment.

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
 * Per-image ceiling for the base64-payload weight below. Measured vision
 * encoders bill one image at roughly 10^3 tokens regardless of payload size:
 * OpenAI high-detail tops out at ~1,105 tiles, Anthropic ~1,600, and a
 * llama.cpp/Qwen-VL grid prices a 1280x900 capture around 1,500. The
 * 2026-11-18 incident proves a floor of ~850/image for the victim provider
 * (the text alone provably fit the 262,144 window; ~28 images pushed it
 * over). ceil(base64Length/4) tracks byte-size scaling the way real
 * encoders do (bigger capture, more patches), and the 4,096 cap keeps a
 * single huge payload from claiming 1.5% of a large window or pinning the
 * gauge to an absurd number; both biases err high so compaction fires early
 * rather than the provider 400ing. Provider-side image accounting remains
 * an unknown (usage numbers may exclude image tokens entirely) -- this is a
 * budget floor, not a billing replica.
 */
export const IMAGE_TOKEN_CAP = 4096;

/** Image weight for one base64 payload / data-URL string (0 for empty). */
export function estimateImageTokens(payload: string | null | undefined): number {
  if (typeof payload !== "string" || payload.length === 0) return 0;
  // Charge the payload's CHARS through the same chars/4 lens as text, then
  // clamp to a per-image ceiling (see IMAGE_TOKEN_CAP).
  return Math.min(Math.ceil(payload.length / 4), IMAGE_TOKEN_CAP);
}

/** Total image weight of a Message.images-style attachment array. */
function estimateImagesTokens(images: unknown): number {
  if (!Array.isArray(images)) return 0;
  let total = 0;
  for (const attachment of images) {
    if (attachment && typeof attachment === "object") {
      const data = (attachment as { data?: unknown }).data;
      total += estimateImageTokens(typeof data === "string" ? data : "");
    }
  }
  return total;
}

/**
 * Weight for inline `{ type: "image_url", image_url: { url } }` content
 * parts. contentToText() DROPS these (the text surfaces must never see
 * base64), so without this the estimator would not see an image riding
 * content at all. Only `data:` URLs bill: a plain http(s) URL is a handful
 * of ordinary text tokens on the wire, and the at-rest flatten already
 * established that references contribute nothing here.
 */
function estimateInlineImagePartsChars(content: unknown): number {
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if ((part as { type?: string }).type !== "image_url") continue;
    const url = (part as { image_url?: { url?: unknown } }).image_url?.url;
    if (typeof url === "string" && url.startsWith("data:")) {
      total += estimateImageTokens(url) * 4;
    }
  }
  return total;
}

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
  images?: unknown;
}

export function estimateMessageTokens(
  msg: MessageLike,
  toolResultText?: ToolResultEstimator | null,
): number {
  const chars = _messageCharCount(msg, toolResultText);
  // Image payloads bill as image tokens (see IMAGE_TOKEN_CAP), not as the
  // base64 text the wire serializer embeds in `content`.
  return Math.ceil(chars / 4) + estimateImagesTokens(msg.images);
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
 * Inline image parts are weight-only: contentToText drops them, so the
 * image share is added on top (converted back to chars so the message-level
 * chars/4 lens yields the documented image weight).
 */
export function estimateContentChars(
  content: string | Array<unknown> | null | undefined,
  toolResultText?: ToolResultEstimator | null,
): number {
  const inlineImages = estimateInlineImagePartsChars(content);
  if (!toolResultText) return contentToText(content).length + inlineImages;
  if (content == null) return 0;
  if (typeof content === "string") return content.length;
  let total = 0;
  for (const part of content) {
    if (isToolResultPart(part)) total += toolResultText(part).length;
    else total += contentToText([part]).length;
  }
  return total + inlineImages;
}

export function estimateContextTokens(
  messages: MessageLike[],
  toolResultText?: ToolResultEstimator | null,
): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg, toolResultText), 0);
}
