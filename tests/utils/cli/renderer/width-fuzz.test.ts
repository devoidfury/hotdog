// Fuzz suite for the width utility (src/utils/cli/renderer/width.ts) that
// every wrap, pad, and cursor motion in the split renderer goes through
// (§7). Wrong widths are owner-visible: the editor miswraps or misplaces.
//
// THE MODULE-DEFINED GEOMETRY (transcribed from the source, pinned here --
// stated, not invented; the file header calls out its own ceilings):
//   - width = SUM of per-codepoint cells; no RGI grapheme clustering.
//   - 0 cells: C0/C1 controls, DEL, transcribed Mn/Me/Cf blocks (Latin/
//     Greek/Cyrillic diacritics, Hebrew, Arabic, Indic marks, mark-like
//     symbol additions), ZWSP..RLM (incl. ZWJ U+200D and ZWNJ U+200C),
//     bidi isolates, variation selectors, BOM, tag chars, U+FFFD is NOT 0.
//   - 2 cells: East Asian Wide/Fullwidth ranges + emoji-presentation block
//     U+1F300..U+1FAFF. Halfwidth FF61..FF9F / FFE8..FFEE deliberately 1
//     (the codex "FF00..FFEF => 2" regression this table exists to dodge).
//   - 1 otherwise -- INCLUDING lone surrogates (for..of yields the lone
//     code unit; it matches no table; pinned below).
//   - OSC (incl. OSC 8) and CSI/SGR spans: zero geometry, bytes survive.
//   - Documented ceilings pinned as-is: ZWJ sequences measure as SUMMED
//     cells (4-person family = 8, not 2); flags are "wrong" -- each
//     regional indicator counts 1, so a flag pair sums to 2; VS16 does not
//     promote text-default glyphs (heart+VS16 = 1).
//
// wrapToWidth real rules pinned:
//   - "\n" splits rows and is CONSUMED by the split; reassembly invariant:
//     lines.join("") === s with every "\n" removed. Empty segments still
//     emit empty lines (wrapToWidth("") === [""]).
//   - width < 1 clamps to 1 (degenerate terminals); no infinite loop.
//   - "a wide glyph never splits": on an EMPTY line a 2-cell token is
//     placed even at target 1, so at width 1 lines may reach width 2.
//     General bound: width(line) <= max(target, 2), and <= target for
//     target >= 2. Zero-width tokens never trigger a wrap; they attach to
//     the current row.
//   - escape spans ride on the line where they start (zero geometry).

import { describe, it, expect } from "bun:test";
import { charWidth, visibleWidth, wrapToWidth } from "@utils/cli/renderer/width.ts";
import { makeRng, type Rng } from "../../../fuzz/prng.ts";

// All exotica uses explicit escapes: literal combining marks in source are
// invisible landmines (house rule from width.test.ts).

// ── Seeded grapheme corpus ──────────────────────────────────────────

const CORPUS: string[] = [
  "",
  "hello world",
  "ASCII 0123456789 !@#$%^&*()",
  "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}", // ZWJ family, 4 members
  "\u{1f469}\u200d\u{1f4bb}", // woman + laptop ZWJ sequence
  "\u{1f469}\u200d\u{1f469}\u200d\u{1f466}\u200d\u{1f466}", // two-mom family
  "\u{1f44d}\u{1f3fd}", // thumbs-up + skin-tone modifier
  "\u{1f3ff}\u{1f600}", // dark skin tone modifier + emoji
  "e\u0301", // combining acute
  "a\u0300\u0301\u0302\u0303\u0304", // five stacked marks
  "\u0301\u0302\u0303", // stacked marks with no base
  "\u00e9", // precomposed e-acute
  "\u2764\ufe0f", // heart + VS16
  "\u{1f600}\ufe0f", // emoji + redundant VS16
  "\u2764\ufe0e", // heart + VS15
  "\u05d0\u05b0\u05d1\u05b7", // Hebrew + niqqud
  "\u05de\u05d9\u05dc\u05d4", // Hebrew word (RTL)
  "\u0645\u064e\u0631\u0652\u062d\u0628\u0627", // Arabic fathatan/shadda stack (RTL)
  "\u0644\u063a\u0629 \u0639\u0631\u0628\u064a\u0629", // Arabic word
  "\u4e2d\u6587\u597d", // CJK
  "\u30c6\u30b9\u30c8", // katakana
  "\ud55c\uad6d\uc5b4", // Hangul syllables
  "\u3131\u3132", // Hangul Jamo initials
  "\u{1f1fa}\u{1f1f8}", // regional-indicator flag pair
  "\u{1f1e9}\u{1f1ea}\u{1f1ef}\u{1f1f5}", // two flag pairs
  "\u200d", // lone ZWJ
  "\u200c", // lone ZWNJ
  "\u200b", // ZWSP
  "\ufeff", // BOM
  "\u202e\u2066\ufeff\u200f", // bidi controls
  "\u{e0041}", // tag char
  "\ud800", // lone high surrogate
  "\udfff", // lone low surrogate
  "\u4e2d\ud800x\udfff", // lone surrogates mixed with wide text
  "\u0001\u001f", // C0 controls (no \n: that splits rows in wrap)
  "\u007f", // DEL
  "\u0080\u009f", // C1 controls
  "\uff71\uff72\uff73", // halfwidth katakana (must stay 1)
  "\uff61\uff9f", // halfwidth sound marks (codex regression)
  "\uff01\uff03\uff3a", // fullwidth forms (must be 2)
  "\uffe0\ufe5b", // fullwidth signs / small form punctuation
  "\u{20000}", // supplementary CJK plane 2
  "\u{1f000}", // emoji-block gap: EAW N, stays 1 per table
  "\u231a\u231b", // watch + alarm clock (EAW W)
  "x".repeat(40),
  "\u4e2d".repeat(15),
  "\u0316".repeat(20), // long unbreakable zero-width run
  "\u{1f468}\u200d".repeat(6), // ZWJ spam
  "\u001b[31mred\u001b[0m", // SGR span
  "\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007", // OSC 8 span
  "caf\u00e9 \u2192 \u03c0 \u00bd \u2460 \u2705", // ambiguous mix + one wide emoji
];

/** Random corpus mash: whole items, random slices (slice cuts fabricate
 * lone surrogates -- prime stress material), raw random code units, and
 * occasional newlines for the wrap tests. */
function mash(rng: Rng, allowNewlines: boolean): string {
  const n = 1 + rng.int(6);
  let s = "";
  for (let i = 0; i < n; i++) {
    const roll = rng.int(100);
    if (roll < 55) {
      s += rng.pick(CORPUS);
    } else if (roll < 75) {
      const src = rng.pick(CORPUS);
      if (src.length > 0) {
        const a = rng.int(src.length);
        const b = a + rng.int(src.length - a);
        s += src.slice(a, b); // may bisect a surrogate pair or a ZWJ sequence
      }
    } else if (roll < 88) {
      let k = 1 + rng.int(8);
      while (k-- > 0) s += String.fromCharCode(rng.int(0x10000)); // raw units incl. surrogates
    } else {
      s += "ab".slice(0, 1 + rng.int(2));
    }
    if (allowNewlines && rng.bool(0.18)) s += "\n";
  }
  return s;
}

const hexRepr = (s: string): string =>
  Array.from(s, (c) => c.codePointAt(0)!.toString(16)).join(" ");

// Same escape-span shape as width.ts's ANSI_RE: complete OSC (BEL- or
// ST-terminated) plus complete CSI. Used only to detect DANGLING escape
// residue for the wrap bound below.
const ANSI_SPAN_RE = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]/g;

// ── visibleWidth fuzz ───────────────────────────────────────────────

describe("visibleWidth fuzz", () => {
  it("never throws and never goes negative on 800 seeded mash strings", () => {
    const rng = makeRng(0x5eed_01d3);
    const failures: { iter: number; input: string; err: string }[] = [];
    for (let i = 0; i < 800; i++) {
      const s = mash(rng, true);
      try {
        const w = visibleWidth(s);
        if (!(w >= 0) || !Number.isFinite(w)) {
          failures.push({ iter: i, input: hexRepr(s), err: `width=${w}` });
        }
        // every codepoint contributes at most 2 cells
        if (w > 2 * [...s].length) {
          failures.push({ iter: i, input: hexRepr(s), err: `width=${w} exceeds 2/cp` });
        }
      } catch (e) {
        failures.push({ iter: i, input: hexRepr(s), err: `${e}` });
      }
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
  });

  it("ASCII length equality on seeded runs", () => {
    const rng = makeRng(0xa5c10a5c);
    for (let i = 0; i < 200; i++) {
      const n = rng.int(120);
      let s = "";
      for (let k = 0; k < n; k++) s += String.fromCharCode(0x20 + rng.int(0x5f));
      expect(visibleWidth(s)).toBe(s.length);
    }
  });

  it("combining marks contribute 0 (module rule: transcribed Mn blocks are zero-cell)", () => {
    const marks = [
      0x0301, 0x0300, 0x036f, // Latin combining
      0x05b0, 0x05bf, // Hebrew niqqud
      0x064b, 0x065f, // Arabic diacritics
      0x20d0, 0x20f0, // combining marks for symbols
      0xfe20, // combining halant
    ];
    for (const m of marks) {
      const mark = String.fromCodePoint(m);
      expect(charWidth(m)).toBe(0);
      expect(visibleWidth(mark)).toBe(0);
      for (let stack = 1; stack <= 5; stack++) {
        expect(visibleWidth("x" + mark.repeat(stack))).toBe(1);
        expect(visibleWidth("\u4e2d" + mark.repeat(stack))).toBe(2);
      }
    }
    // variation selectors and joiners are zero too
    for (const z of [0x200b, 0x200c, 0x200d, 0xfe0f, 0xfe00, 0xfeff, 0xe0041]) {
      expect(visibleWidth("x" + String.fromCodePoint(z))).toBe(1);
    }
  });

  it("lone surrogates measure 1 each (pinned real handling)", () => {
    expect(visibleWidth("\ud800")).toBe(1);
    expect(visibleWidth("\udfff")).toBe(1);
    // subtle: "\ud800\ud800\udc00" is NOT three lone units -- the trailing
    // D800+DC00 pair forms a valid U+10000 (width 1), so total = 1 + 1.
    expect(visibleWidth("\ud800\ud800\udc00")).toBe(2);
    expect(visibleWidth("\ud800x\udc00")).toBe(3); // genuinely unpaired units
    expect(visibleWidth("\u4e2d\ud800a")).toBe(4); // 2 + 1 + 1
  });

  it("documented spot list agrees with the module's table", () => {
    const spots: [string, number][] = [
      ["", 0],
      ["hello", 5],
      ["a\tb", 2], // TAB zero-cell (content is split on \n before measuring)
      ["\u4e2d\u6587", 4], // CJK 2+2
      ["\u30c6\u30b9\u30c8", 6], // katakana
      ["\u{1f468}\u200d\u{1f469}\u200d\u{1f467}\u200d\u{1f466}", 8], // family: SUMMED cells (documented ceiling)
      ["\u{1f469}\u200d\u{1f4bb}", 4], // ZWJ sequence: 2 + 0 + 2
      ["\u{1f44d}\u{1f3fd}", 4], // skin tone rides as its own emoji cell
      ["\u{1f1fa}\u{1f1f8}", 2], // flag: RI sum (documented "flags are wrong" ceiling)
      ["\u2764\ufe0f", 1], // VS16 does not promote (documented)
      ["\u{1f600}\ufe0f", 2], // VS adds nothing
      ["e\u0301\u0302\u0303", 1], // stacked marks
      ["\u05d0\u05b0", 1], // Hebrew base + mark
      ["\u0645\u064e", 1], // Arabic base + mark
      ["\uff71", 1], // halfwidth katakana (codex regression guard)
      ["\uff61", 1], // halfwidth sound mark (codex regression guard)
      ["\uff01", 2], // fullwidth exclamation
      ["\uffe5", 2], // fullwidth yen
      ["\ud800", 1], // lone surrogate
      ["\u0000\u001f\u007f\u009f", 0], // controls zero
      ["\u200b\u200d\u200c\ufeff\u202e\u2066", 0], // joiners/bidi zero
      ["\u{e0041}", 0], // tag char
      ["\u231a\u231b", 4], // EAW-wide symbols
      ["\u2705", 2], // white check mark (in table)
      ["\u{1f000}", 1], // emoji-block gap stays 1
      ["\u001b[31mred\u001b[0m", 3], // SGR stripped
      ["\u001b]8;;https://x\u0007link\u001b]8;;\u0007", 4], // OSC 8 stripped
      ["\u001b[", 1], // INCOMPLETE CSI: ANSI_RE needs a final byte, so the
      // dangling prefix measures as literal bytes (ESC=0, '['=1). wrapToWidth
      // differs: escapeSpanAt rides it at zero geometry. Pin both sides.
    ];
    const bad: string[] = [];
    for (const [s, w] of spots) {
      const got = visibleWidth(s);
      if (got !== w) bad.push(`spot ${hexRepr(s)}: got ${got}, want ${w}`);
    }
    expect(bad).toEqual([]);
  });

  it("additive across concatenation for ESC-free corpus strings", () => {
    const rng = makeRng(0xa4d1717);
    const clean = CORPUS.filter((c) => !c.includes("\u001b"));
    for (let i = 0; i < 300; i++) {
      const a = rng.pick(clean);
      const b = rng.pick(clean);
      expect(visibleWidth(a + b)).toBe(visibleWidth(a) + visibleWidth(b));
    }
  });
});

// ── wrapToWidth fuzz ────────────────────────────────────────────────

describe("wrapToWidth fuzz", () => {
  function auditWrap(s: string, width: number): string[] {
    const problems: string[] = [];
    const lines = wrapToWidth(s, width);
    const joined = lines.join("");
    const want = s.replaceAll("\n", "");
    if (joined !== want) {
      problems.push(`lost/reordered chars at width ${width}: got ${hexRepr(joined)} want ${hexRepr(want)}`);
    }
    const minLines = (s.match(/\n/g)?.length ?? 0) + 1;
    if (lines.length < minLines) problems.push(`fewer lines than newlines at width ${width}`);
    const bound = Math.max(width, 2);
    for (const line of lines) {
      // visibleWidth agrees with wrapToWidth's geometry on COMPLETE OSC/CSI
      // spans but counts DANGLING prefixes (slice/mash-fabricated "\x1b[3",
      // unterminated OSC) as literal bytes while wrap rides them at zero
      // geometry. That documented asymmetry (run notes) is not a wrap failure:
      // such lines skip the bound; reassembly still applies to every line.
      if (line.replace(ANSI_SPAN_RE, "").includes("\u001b")) continue;
      const lw = visibleWidth(line);
      if (lw > bound) problems.push(`line width ${lw} > ${bound} at width ${width}: ${hexRepr(line)}`);
      if (width >= 2 && lw > width) problems.push(`line width ${lw} > target ${width}: ${hexRepr(line)}`);
    }
    return problems;
  }

  it("full corpus across widths 1..80: order-preserving reassembly, per-line bounds", () => {
    const failures: { input: string; problems: string[] }[] = [];
    for (const s of CORPUS) {
      for (let w = 1; w <= 80; w++) {
        const problems = auditWrap(s, w);
        if (problems.length > 0) failures.push({ input: hexRepr(s), problems: problems.slice(0, 4) });
        if (failures.length >= 3) break;
      }
    }
    expect(failures).toEqual([]);
  });

  it("seeded mash across widths 1..80 and degenerate 0/-1/-99: same invariants", () => {
    const rng = makeRng(0x07a7_5c5c);
    const failures: { iter: number; input: string; problems: string[] }[] = [];
    const widths = [1, 2, 3, 5, 8, 13, 34, 80, 0, -1, -99];
    for (let i = 0; i < 300; i++) {
      const s = mash(rng, true);
      for (const w of widths) {
        const problems = auditWrap(s, w); // clamp rule: 0/negative behave as 1
        if (problems.length > 0) failures.push({ iter: i, input: hexRepr(s), problems: problems.slice(0, 4) });
        if (failures.length >= 3) break;
      }
      if (failures.length >= 3) break;
    }
    expect(failures).toEqual([]);
  });

  it("wrapToWidth('') is [''] and newline-only inputs keep empty rows", () => {
    expect(wrapToWidth("", 5)).toEqual([""]);
    expect(wrapToWidth("\n\n", 5)).toEqual(["", "", ""]);
    expect(wrapToWidth("a\n\nb", 5)).toEqual(["a", "", "b"]);
  });

  it("unbreakable runs terminate at width 0/-5/1 without a hang", () => {
    // The clamp (width < 1 -> 1) plus "never split a wide glyph" is what
    // keeps these finite; an infinite loop would fail on the test timeout.
    const t0 = performance.now();
    const cjk = "\u4e2d".repeat(2000);
    for (const w of [0, -5, 1]) {
      const lines = wrapToWidth(cjk, w);
      expect(lines.join("")).toBe(cjk);
      expect(lines.length).toBe(2000); // width-1 target: one 2-cell glyph per row
    }
    // pure zero-width run attaches to ONE row at any width
    const marks = "\u0316".repeat(3000);
    for (const w of [0, 1, 40]) {
      const lines = wrapToWidth(marks, w);
      expect(lines.length).toBe(1);
      expect(lines[0]).toBe(marks);
    }
    // alternating wide/zero-width and astral ZWJ spam at the tightest target
    const mixed = ("\u4e2d\u0316\u{1f468}\u200d").repeat(500);
    for (const w of [-1, 1, 2]) {
      const lines = wrapToWidth(mixed, w);
      expect(lines.join("")).toBe(mixed);
      for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(Math.max(w, 2));
    }
    // budget: ~100x the measured cost; catches quadratic/hang regressions
    expect(performance.now() - t0).toBeLessThan(2000);
  });
});
