// visibleWidth -- the single geometry utility (design note §7). Every wrap,
// pad, erase-count, popup placement, and cursor motion goes through this file.
//
// Scoped hand table per the §7 ruling (Decisions 5):
//   - codepoint width 0 for combining Mn/Me/Cf/ZWJ classes
//   - 2 for East Asian Wide + Fullwidth ranges (transcribed from Unicode
//     EastAsianWidth.txt) and the emoji-presentation ranges
//   - 1 otherwise
// OSC 8 hyperlink spans are zero-width at measure time; the bytes survive at
// write time (§7, codex terminal_hyperlinks precedent).
//
// Known ceiling (accepted in §7, no full RGI grapheme clustering): ZWJ
// sequences measure as summed cells and will overflow on some terminals;
// flags are wrong; combining marks from scripts outside the transcribed
// blocks below measure as 1.
//
// Halfwidth kana and halfwidth sound marks (U+FF61..U+FF9F) are deliberately
// NOT in the wide table -- they are EAW class H, not W/F. The naive
// "0xFF00..0xFFEF => 2" shortcut is the codex width.rs regression this table
// must keep passing (tests: "halfwidth sound marks" corpus).

const ESC = "\x1b";

// Zero-width codepoint ranges. Covers C0/C1 controls, the transcribed Mn/Me/Cf
// blocks (Latin/Greek/Cyrillic diacritics, Hebrew, Arabic, Syriac, Devanagari,
// extended diacriticals, combining marks for symbols), ZWSP..RLM (incl. ZWJ
// U+200D), bidi isolates, variation selectors (BMP + supplement), BOM, and tag
// chars. All range tables in this file are [start, end] pairs, sorted
// ascending and non-overlapping -- charWidth binary-searches them, so a
// misordered pair silently misclassifies (invariant pinned in
// tests/utils/cli/renderer/width.test.ts).
const ZERO_RANGES: readonly number[] = [
  0x0000, 0x001f,
  0x007f, 0x009f,
  0x0300, 0x036f,
  0x0483, 0x0489,
  0x0591, 0x05bd, 0x05bf, 0x05bf,
  0x05c1, 0x05c2, 0x05c4, 0x05c5, 0x05c7, 0x05c7,
  0x0600, 0x0605,
  0x0610, 0x061a,
  0x061c, 0x061c,
  0x064b, 0x065f,
  0x0670, 0x0670,
  0x06d6, 0x06dc, 0x06df, 0x06e4, 0x06e7, 0x06e8, 0x06ea, 0x06ed,
  0x070f, 0x070f,
  0x0711, 0x0711,
  0x0730, 0x074a,
  0x07a6, 0x07b0,
  0x07eb, 0x07f3, 0x07fd, 0x07fd,
  0x0816, 0x0819, 0x081b, 0x0823, 0x0825, 0x0827, 0x0829, 0x082d,
  0x0859, 0x085b,
  0x08d3, 0x08e1, 0x08e3, 0x0902,
  0x093a, 0x093a, 0x093c, 0x093c, 0x0941, 0x0948, 0x094d, 0x094d,
  0x0951, 0x0957, 0x0962, 0x0963,
  0x0981, 0x0981, 0x09bc, 0x09bc, 0x09c1, 0x09c4, 0x09cd, 0x09cd,
  0x09e2, 0x09e3,
  0x180e, 0x180e,
  0x1ab0, 0x1aff,
  0x1dc0, 0x1dff,
  0x200b, 0x200f,
  0x202a, 0x202e,
  0x2060, 0x2064,
  0x2066, 0x206f,
  0x20d0, 0x20f0,
  0xfe00, 0xfe0f,
  0xfe20, 0xfe2f,
  0xfeff, 0xfeff,
  0xe0001, 0xe0001,
  0xe0020, 0xe007f,
  0xe0100, 0xe01ef,
];

// Ranges rendered two cells wide: East Asian Wide (W) + Fullwidth (F), plus
// the emoji-presentation block U+1F300..U+1FAFF scoped as the note §7 states
// it (whole block; the precise Unicode W list has text-default gaps we
// deliberately fill, matching what terminals actually do). Halfwidth ranges
// (FF61..FFDC, FFE8..FFEE) are absent by design -- see header.
const WIDE_RANGES: readonly number[] = [
  0x1100, 0x115f,
  0x231a, 0x231b,
  0x2329, 0x232a,
  0x23e9, 0x23ec,
  0x23f0, 0x23f0,
  0x23f3, 0x23f3,
  0x25fd, 0x25fe,
  0x2614, 0x2615,
  0x2630, 0x2637, // trigrams (EAW W)
  0x2648, 0x2653,
  0x267f, 0x267f,
  0x268a, 0x268f, // dice faces (EAW W)
  0x2693, 0x2693,
  0x26a1, 0x26a1,
  0x26aa, 0x26ab,
  0x26bd, 0x26be,
  0x26c4, 0x26c5,
  0x26ce, 0x26ce,
  0x26d4, 0x26d4,
  0x26ea, 0x26ea,
  0x26f2, 0x26f3,
  0x26f5, 0x26f5,
  0x26fa, 0x26fa,
  0x26fd, 0x26fd,
  0x2705, 0x2705,
  0x270a, 0x270b,
  0x2728, 0x2728,
  0x274c, 0x274c,
  0x274e, 0x274e,
  0x2753, 0x2755,
  0x2757, 0x2757,
  0x2795, 0x2797,
  0x27b0, 0x27b0,
  0x27bf, 0x27bf,
  0x2b1b, 0x2b1c,
  0x2b50, 0x2b50,
  0x2b55, 0x2b55,
  0x2e80, 0x2e99,
  0x2e9b, 0x2ef3,
  0x2f00, 0x2fd5,
  0x2ff0, 0x2fff, // component forms run through 2FFF
  0x3000, 0x303e,
  0x3041, 0x3096,
  0x3099, 0x30ff,
  0x3105, 0x312f,
  0x3131, 0x318e,
  0x3190, 0x31e3,
  0x31e4, 0x31e5, // CJK phonetic extensions (EAW W; the gap after is N)
  0x31ef, 0x31ef, // bopomofo extended tone mark (EAW W)
  0x31f0, 0x321e,
  0x3220, 0x3247,
  0x3250, 0x4dbf,
  0x4dc0, 0x4dff, // Yijing hexagram symbols (EAW W)
  0x4e00, 0xa48c,
  0xa490, 0xa4c6, // Yi radicals (EAW W)
  0xa960, 0xa97c,
  0xac00, 0xd7a3,
  // Hangul Jamo Extended-B (D7B0..D7C6, D7CB..D7FB) is EAW class N in
  // EastAsianWidth-16.0.0.txt -- conjoining jungseong/jongseong never appear
  // standalone -- so it is deliberately absent (a prior draft had it as W).
  0xf900, 0xfaff,
  0xfe10, 0xfe19,
  0xfe30, 0xfe52,
  0xfe54, 0xfe66,
  0xfe68, 0xfe6b,
  0xff01, 0xff60, // Fullwidth forms; stops before the halfwidth marks at FF61
  // FFE0..FFE6 are ALL EAW class F (CENT/POUND/.../WON signs). The genuine
  // halfwidth forms are FF61..FFDC and FFE8..FFEE and stay out of this table.
  0xffe0, 0xffe6,
  0x16fe0, 0x16fe4,
  0x16ff0, 0x16ff1,
  0x17000, 0x187f7,
  0x18800, 0x18cd5,
  0x18cff, 0x18cff, // Soyombo logo (EAW W)
  0x18d00, 0x18d08,
  0x1aff0, 0x1aff3,
  0x1aff5, 0x1affb,
  0x1affd, 0x1affe,
  0x1b000, 0x1b122,
  0x1b132, 0x1b132,
  0x1b150, 0x1b152,
  0x1b155, 0x1b155,
  0x1b164, 0x1b167,
  0x1b170, 0x1b2fb,
  0x1d300, 0x1d356, // Tai Xuan Jing symbols (EAW W)
  0x1d360, 0x1d376, // Tai Xuan Jing counters (EAW W)
  0x1f004, 0x1f004,
  0x1f0cf, 0x1f0cf,
  0x1f18e, 0x1f18e,
  0x1f191, 0x1f19a,
  0x1f200, 0x1f2ff,
  0x1f300, 0x1faff, // emoji-presentation block, §7 scoped wording (whole block; subsumes 1F7E0/1F900 et al.)
  0x20000, 0x2fffd,
  0x30000, 0x3fffd,
];

// Internal data exported for the table-consistency contract test only.
export const WIDTH_RANGE_TABLES = { zero: ZERO_RANGES, wide: WIDE_RANGES };

function inRanges(cp: number, ranges: readonly number[]): boolean {
  let lo = 0;
  let hi = ranges.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < ranges[mid * 2]!) hi = mid - 1;
    else if (cp > ranges[mid * 2 + 1]!) lo = mid + 1;
    else return true;
  }
  return false;
}

/** Cell width of a single codepoint: 0, 1, or 2. Never call per-char in hot paths; prefer visibleWidth. */
export function charWidth(cp: number): number {
  if (inRanges(cp, ZERO_RANGES)) return 0;
  if (inRanges(cp, WIDE_RANGES)) return 2;
  return 1;
}

// OSC (incl. OSC 8 hyperlinks) and CSI (SGR et al.) spans carry zero
// geometry; §7 mandates OSC 8 stripping inside the utility, and SGR gets the
// same treatment because CliOutputSink hands this layer pre-colored rows --
// measuring escape bytes as printable would miswrap every of them (the same
// bug kimi-cli hit; the single-utility rule kills it structurally).
const ANSI_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;

/** Printable cell width of a string: escape spans stripped, codepoints summed per the table above. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (const ch of s.replace(ANSI_RE, "")) {
    w += charWidth(ch.codePointAt(0)!);
  }
  return w;
}

/**
 * Hard-wrap to a visible width (app owns wrap, §7 DECAWM decision: the
 * terminal's autowrap never fires on our content). Newlines in the input
 * split rows; zero-width codepoints attach to the current row; a wide
 * glyph never splits. width < 1 is clamped to 1 (degenerate terminals).
 */
export function wrapToWidth(s: string, width: number): string[] {
  const max = Math.max(1, width);
  const out: string[] = [];
  for (const segment of s.split("\n")) {
    let line = "";
    let lineW = 0;
    // Measure against the OSC8-stripped text but cut the ORIGINAL string --
    // escape bytes ride along on the line they start on (zero geometry).
    for (const token of splitMeasureTokens(segment)) {
      const cw = token.w;
      if (lineW + cw > max && line !== "") {
        out.push(line);
        line = "";
        lineW = 0;
      }
      line += token.t;
      lineW += cw;
    }
    out.push(line);
  }
  return out;
}

// Tokens: plain codepoints with their width, and escape spans (OSC, CSI) with
// width 0. Sweeping the original string keeps escape bytes out of the
// geometry while keeping them on the emitted line.
function splitMeasureTokens(segment: string): { t: string; w: number }[] {
  const tokens: { t: string; w: number }[] = [];
  let i = 0;
  while (i < segment.length) {
    if (segment[i] === ESC) {
      const span = escapeSpanAt(segment, i);
      tokens.push({ t: span, w: 0 });
      i += span.length;
      continue;
    }
    const cp = segment.codePointAt(i)!;
    tokens.push({ t: String.fromCodePoint(cp), w: charWidth(cp) });
    i += cp > 0xffff ? 2 : 1;
  }
  return tokens;
}

function escapeSpanAt(s: string, start: number): string {
  if (s[start + 1] === "]") {
    // OSC: terminated by BEL or ST (ESC \); an inner ESC ends it conservatively.
    for (let i = start + 2; i < s.length; i++) {
      if (s[i] === "\x07") return s.slice(start, i + 1);
      if (s[i] === ESC) return s.slice(start, s[i + 1] === "\\" ? i + 2 : i);
    }
    return s.slice(start); // unterminated: ride to end of line
  }
  if (s[start + 1] === "[") {
    let i = start + 2;
    while (i < s.length && s[i]! >= "0" && s[i]! <= "?") i++; // parameter bytes
    while (i < s.length && s[i]! >= " " && s[i]! <= "/") i++; // intermediate bytes
    if (i < s.length) i++; // final byte @..~
    return s.slice(start, i);
  }
  return s.slice(start, start + 2); // two-byte escape (or lone ESC): zero-width
}
