// Spoof neutralization for human-facing render boundaries (SPF-1).
//
// The marker mangler protects the MODEL's eyes. This protects the HUMAN's.
// Every approval surface (user-gate prompts, tool-call display lines, the
// bash command echo, question prompts, the webui) renders model/external
// text into a terminal that executes escape sequences and honors bidi: a
// crafted path or argument can make the approval prompt READ differently
// than the command RUNS (the `git di<U+202E>ff` class), overwrite the
// prompt line with ANSI, fake `rm -rf ./` as `rm -rf /` with zero-widths,
// or print a convincing fake "approved" line.
//
// Every code point in the spoofing set is replaced with a visible
// `[U+XXXX]` token and COUNTED -- never silently stripped. The human seeing
// THAT something was there is itself the alert.
//
// INVARIANT: neutralize at RENDER, never at storage. The session log keeps
// original bytes (audit); every human-facing surface neutralizes (display).
// The mangler and this pass are the two arms: one for the model's eyes, one
// for yours. The replacement tokens are pure ASCII, so applying the pass
// twice is a no-op (idempotent across stacked choke points).

/**
 * The spoofing set:
 * - C0 controls except tab and LF (\r re-winds the line, BS overwrites
 *   earlier chars, ESC introduces CSI/OSC sequences -- terminal control is a
 *   spoofing vector where Unicode isn't), plus DEL.
 * - C1 controls, including the 8-bit CSI introducer.
 * - Zero-widths and directional marks: ZWSP, ZWNJ, ZWJ, LRM, RLM.
 * - Bidi embeddings/overrides U+202A..U+202E (the trojan-source set).
 * - Bidi isolates U+2066..U+2069.
 * - Word joiner and invisible operators U+2060..U+2064.
 * - BOM U+FEFF.
 * - Interlinear annotation controls U+FFF9..U+FFFB.
 * Tab and LF survive: prompts are multi-line and columns are alignment, not
 * spoofing.
 */
const SPOOFING_RE =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\uFFF9-\uFFFB]/g;

export interface SpoofScan {
  /** The text with every spoofing code point replaced by a `[U+XXXX]` token. */
  text: string;
  /** How many code points were replaced. > 0 is itself the alert. */
  count: number;
}

function tokenFor(ch: string): string {
  return `[U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}]`;
}

/**
 * Replace every spoofing code point with a visible token and count it.
 * Pure and idempotent: output contains only code points outside the set.
 */
export function neutralizeSpoofing(input: string): SpoofScan {
  let count = 0;
  const text = input.replace(SPOOFING_RE, (ch) => {
    count++;
    return tokenFor(ch);
  });
  return { text, count };
}

/** Convenience for render choke points that only need the text. */
export function spoofSafe(input: string): string {
  return neutralizeSpoofing(input).text;
}
