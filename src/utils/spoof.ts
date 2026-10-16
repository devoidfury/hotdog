// Spoof neutralization for human-facing render boundaries (SPF-1).
//
// The marker mangler protects the MODEL's eyes; this protects the HUMAN's.
// Every approval surface (user-gate prompts, tool-call lines, the bash echo, question prompts, the webui)
// renders model/external text into a terminal that runs escape sequences and honors bidi --
// a crafted path can make an approval prompt READ differently than the command RUNS
// (the `git di<U+202E>ff` class), fake `rm -rf ./` as `rm -rf /`, or print a convincing fake "approved" line.
//
// Every spoofing code point becomes a visible `[U+XXXX]` token and is COUNTED not silently stripped;
// seeing that something was there is the alert.
//
// INVARIANT: neutralize at RENDER, never at storage. The session log keeps original bytes (audit); every human surface neutralizes.
// The mangler and this pass are the two arms of one policy -- tokens are pure ASCII, so the pass is idempotent across stacked choke points.

/**
 * The spoofing set: C0 controls except tab/LF (\r re-winds the line, BS overwrites, ESC introduces CSI/OSC sequences --
 * terminal control is a vector where Unicode isn't), plus DEL and all C1 controls;
 * zero-widths and directional marks (ZWSP, ZWNJ, ZWJ, LRM, RLM);
 * bidi embeddings/overrides U+202A..U+202E and isolates U+2066..U+2069 (trojan-source);
 * word joiner and invisible operators U+2060..U+2064; BOM U+FEFF; interlinear controls U+FFF9..U+FFFB.
 * Tab and LF survive -- prompts are multi-line and columnss are alignment, not spoofing.
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

/** Replace every spoofing code point with a visible token and count it. Pure and idempotent. */
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
