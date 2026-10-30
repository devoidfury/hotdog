// The central char cap on tool results (review H-6 / open thread O-1).
//
// One knob -- `maxToolResultChars` (core.config.json, resolved and passed down
// as ToolExecutorDeps.maxToolResultChars) -- bounds every finalized tool
// result at the executor seam, structurally closing the per-tool char-discipline
// gaps (read H-6, grep M-19, project_info M-21) instead of patching each tool.
//
// Two enforcement points, one policy (this module):
//   1. before the TOOL_RESULT hook pipeline runs, so in-pipeline observers
//      (loop-detect's resultDigest) can never observe or digest over-cap output;
//   2. binding pass on the finalized ToolResultPart, after hook replacement --
//      a handler's { result } swap re-enters the same cap.
// The cap is idempotent (capped output never exceeds maxChars), so the second
// pass on an already-capped result is a no-op and costs a length check.
//
// Cutting is codepoint-safe: never a lone surrogate, and with Intl.Segmenter
// never mid-grapheme-cluster (combining marks, ZWJ families, skin tones stay
// whole; the repo's writer.ts tolerates cluster splits only because it re-renders
// within one stream -- at-rest result bytes must stay clean for the log, replay,
// and the wire mangler). The count N in the marker is elided UTF-16 code units,
// the same unit the cap is measured in.

import type { ToolResultPart } from "./context/wrappers.ts";

/** Marker line appended to a truncated text part; N = elided code units. */
function marker(n: number): string {
  return `--- [output truncated, ${n} chars elided] ---`;
}

/** Whole marker line including its leading newline. */
function markerRoom(n: number): number {
  return marker(n).length + 1;
}

/**
 * The plain-text floor under which the marker itself would not fit; below it
 * the cap falls back to a bare codepoint-safe slice (still a bound, no marker).
 */
const MIN_MARKER_ROOM = 80;

// Guarded like extensions/string-length: absent Intl.Segmenter degrades to
// surrogate-only backing-off (writer.ts precedent), never a crash.
let segmenter: Intl.Segmenter | null | undefined;
function getSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    const Ctor = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
    segmenter = typeof Ctor === "function" ? new Ctor(undefined, { granularity: "grapheme" }) : null;
  }
  return segmenter;
}

/**
 * Largest grapheme-cluster boundary <= end (0 <= end <= s.length). A cut inside
 * a cluster would orphan a combining mark or split a ZWJ family; a cut between
 * surrogate halves would corrupt the pair. Fast path: both sides ASCII cannot
 * split a cluster (every extender/pair-half is >= U+0300 / U+D800).
 */
function graphemeFloor(s: string, end: number): number {
  if (end <= 0) return 0;
  if (end >= s.length) return s.length;
  const before = s.charCodeAt(end - 1);
  const after = s.charCodeAt(end);
  // Fast path: both sides plain ASCII cannot split a cluster (every extender
  // and pair half is >= U+0300/U+D800) -- except CR before LF, the one
  // control sequence that IS a single cluster (UAX#29 GB3).
  if (before < 0x80 && after < 0x80 && before !== 0x0d) return end;

  const seg = getSegmenter();
  if (seg) {
    let last = 0;
    // Lazy iteration: stops at the first cluster starting at/after `end`.
    for (const g of seg.segment(s)) {
      if (g.index >= end) return g.index === end ? end : last;
      last = g.index;
    }
    return s.length;
  }
  // Surrogate-only fallback: never cut after a high surrogate.
  return before >= 0xd800 && before <= 0xdbff ? end - 1 : end;
}

/**
 * Cap one text payload at maxChars UTF-16 units: keep a grapheme-safe prefix
 * plus a trailing marker line naming the elided count, total length never
 * exceeding maxChars (so re-applying the cap is a no-op). The marker reserve
 * uses the ORIGINAL length's digit count, which only over-reserves: kept
 * shrinks, never grows, and the result still fits.
 */
export function capToolResultText(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  if (maxChars < MIN_MARKER_ROOM) {
    // Tighter than the marker: a bare bound still holds; the marker would not.
    return text.slice(0, graphemeFloor(text, maxChars));
  }
  const kept = graphemeFloor(text, maxChars - markerRoom(text.length));
  const n = text.length - kept;
  return `${text.slice(0, kept)}\n${marker(n)}`;
}

/**
 * Pre-pipeline guard on the raw tool outcome (ToolExecutor): caps a plain
 * string or a ToolResult-shaped object (output/error/hint). The copy keeps the
 * prototype and own symbol properties (TOOL_STOP_LOOP), so formatToolResult
 * duck-typing and the stop-loop check see the same shape. Anything else
 * (plain object, number, null) passes through -- its serialized size is not
 * knowable without stringifying, and the binding pass on the part bounds it.
 */
export function capToolResult(result: unknown, maxChars: number): unknown {
  if (!(maxChars > 0)) return result;
  if (typeof result === "string") return capToolResultText(result, maxChars);
  if (!result || typeof result !== "object") return result;

  const r = result as { output?: unknown; error?: unknown; hint?: unknown };
  const output = typeof r.output === "string" ? capToolResultText(r.output, maxChars) : r.output;
  const error = typeof r.error === "string" ? capToolResultText(r.error, maxChars) : r.error;
  const hint = typeof r.hint === "string" ? capToolResultText(r.hint, maxChars) : r.hint;
  if (output === r.output && error === r.error && hint === r.hint) return result;

  const copy = Object.create(Object.getPrototypeOf(result));
  Object.assign(copy, result);
  copy.output = output;
  copy.error = error;
  copy.hint = hint;
  return copy;
}

/**
 * Binding pass on the finalized part (ToolExecutor, after the TOOL_RESULT
 * pipeline and formatToolResult): caps each text field -- output, error, hint,
 * and metadata values -- to maxChars independently. Images never ride the part
 * (they travel as Message.attachments) and pass through untouched. Returns the
 * same object when nothing exceeds (the common path allocates nothing).
 */
export function capToolResultPart(part: ToolResultPart, maxChars: number): ToolResultPart {
  if (!(maxChars > 0)) return part;
  const output = capToolResultText(part.output, maxChars);
  const error = part.error === null ? null : capToolResultText(part.error, maxChars);
  const hint = part.hint === null ? null : capToolResultText(part.hint, maxChars);
  let meta = part.meta;
  let metaCapped = false;
  for (const [, value] of meta) {
    if (value.length > maxChars) {
      meta = meta.map(([k, v]): [string, string] => [k, capToolResultText(v, maxChars)]);
      metaCapped = true;
      break;
    }
  }
  if (output === part.output && error === part.error && hint === part.hint && !metaCapped) {
    return part;
  }
  return { ...part, output, error, hint, meta };
}
