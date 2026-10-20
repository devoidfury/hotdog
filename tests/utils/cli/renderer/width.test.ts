// visibleWidth corpus per design note §7: the zero-width classes (combining
// Mn/Me/Cf/ZWJ), East Asian Wide/Fullwidth, the emoji-presentation ranges,
// OSC 8/SGR zero geometry, and the codex-style halfwidth-sound-marks
// regression class (pitfall 5: a naive FF00..FFEF=>2 table reads halfwidth
// kana/marks as wide). All exotica uses explicit \uXXXX escapes -- literal
// combining marks in source are invisible landmines.

import { describe, it, expect } from "bun:test";
import { charWidth, visibleWidth, wrapToWidth, WIDTH_RANGE_TABLES } from "@utils/cli/renderer/width.ts";

const ESC = "\x1b";
const BEL = "\x07";

describe("visibleWidth -- basics", () => {
  it("counts ASCII as one cell per char", () => {
    expect(visibleWidth("")).toBe(0);
    expect(visibleWidth("hello")).toBe(5);
    expect(visibleWidth("a b c")).toBe(5);
  });

  it("zero-width: combining marks (Mn)", () => {
    expect(visibleWidth("é")).toBe(1); // e + combining acute
    expect(visibleWidth("à̂b")).toBe(2); // a + grave + circumflex + b
    expect(visibleWidth("x⃗")).toBe(1); // x + combining vector arrow (survives as literal U+20D7)
    expect(visibleWidth("ẍ")).toBe(1); // x + combining diaeresis
  });

  it("zero-width: ZWJ, ZWSP, BOM, bidi controls (Cf)", () => {
    expect(visibleWidth("​")).toBe(0); // ZWSP
    expect(visibleWidth("‍")).toBe(0); // ZWJ
    expect(visibleWidth("﻿")).toBe(0); // BOM
    expect(visibleWidth("‮rtl")).toBe(3); // RLO + "rtl"
    expect(visibleWidth("؜x")).toBe(1); // Arabic letter mark + x
  });

  it("controls measure zero (content is split on newlines before measuring)", () => {
    expect(visibleWidth("a\nb")).toBe(2);
    expect(visibleWidth(`a${String.fromCharCode(0)}b`)).toBe(2); // NUL is zero-cell; "ab" remains
  });

  it("zero-width: variation selectors", () => {
    // Documented §7 ceiling: VS16 does not promote a text-default glyph.
    expect(visibleWidth("❤️")).toBe(1); // U+2764 (EAW N) + VS16 (Mn)
    expect(visibleWidth("️")).toBe(0); // VS17 alone
  });
});

describe("visibleWidth -- East Asian Wide/Fullwidth", () => {
  it("CJK ideographs, kana, and Hangul syllables are 2", () => {
    expect(visibleWidth("你好")).toBe(4); // 你好
    expect(visibleWidth("テスト")).toBe(6); // テスト
    expect(visibleWidth("가")).toBe(2); // U+AC00 Hangul syllable
    expect(visibleWidth("ㄱ")).toBe(2); // U+3131 Hangul Jamo initial
    expect(visibleWidth("中文")).toBe(4); // 中文
  });

  it("Fullwidth forms are 2", () => {
    expect(visibleWidth("？！")).toBe(4); // U+FF1F U+FF01
    expect(visibleWidth("Ａ")).toBe(2); // U+FF21
    expect(visibleWidth("　")).toBe(2); // U+3000 ideographic space
    expect(visibleWidth("￥")).toBe(2); // U+FFE5 fullwidth yen sign
  });

  it("ambiguous and neutral symbols are 1", () => {
    expect(visibleWidth("Ω")).toBe(1); // Greek capital omega
    expect(visibleWidth("→")).toBe(1); // rightwards arrow
    expect(visibleWidth("①")).toBe(1); // U+2460 circled one (EAW A)
    expect(visibleWidth("é")).toBe(1); // precomposed Latin-1
  });

  it("supplementary CJK planes are 2", () => {
    expect(visibleWidth("𠀀")).toBe(2); // U+20000
  });

  it("U+3013 wide vs U+303F neutral (table boundary)", () => {
    expect(visibleWidth("〓")).toBe(2); // U+3013
    expect(visibleWidth("〿")).toBe(1); // U+303F (Na)
  });
});

describe("visibleWidth -- halfwidth sound marks (codex regression class)", () => {
  it("halfwidth katakana + sound marks are 1, not 2", () => {
    expect(visibleWidth("ﾞ")).toBe(1); // U+FF9E halfwidth voiced sound mark
    expect(visibleWidth("ﾟ")).toBe(1); // U+FF9F semi-voiced sound mark
    expect(visibleWidth("ｶﾞｷﾞｸﾞ")).toBe(6); // three kana+mark pairs = 6 cells
    expect(visibleWidth("｡｢｣､･")).toBe(5); // U+FF61..U+FF65 halfwidth punctuation
  });

  it("fullwidth vs halfwidth lookalikes", () => {
    // Explicit escapes only -- the first draft carried literal bytes here and
    // both the fullwidth and the halfwidth line had silently become U+30FC.
    expect(visibleWidth("\u30fc")).toBe(2); // katakana prolonged sound mark (W)
    expect(visibleWidth("\uff0d")).toBe(2); // fullwidth hyphen-minus (F)
    expect(visibleWidth("\uff70")).toBe(1); // halfwidth prolonged sound mark (H)
    expect(visibleWidth("\uffe0")).toBe(2); // fullwidth cent sign (F)
    expect(visibleWidth("\uffe1")).toBe(2); // fullwidth pound sign (F) -- EAW-16 lists FFE0..FFE6 all as class F
    expect(visibleWidth("\uffe2\uffe6")).toBe(4); // U+FFE2 fullwidth not + U+FFE6 fullwidth won (F)
  });

  it("halfwidth Hangul jamo is 1, wide jamo is 2", () => {
    expect(visibleWidth("ᅡ")).toBe(1); // U+1161 Hangul Jamo medial vowel (H)
    expect(visibleWidth("ᄀ")).toBe(2); // U+1100 Hangul Jamo initial (W)
  });

  it("Hangul Jamo Extended-B is EAW N (conjoining jamo), surrounding boundaries hold", () => {
    // EastAsianWidth-16.0.0.txt classes D7B0..D7C6 and D7CB..D7FB as N --
    // these V/T jamo only occur inside L+V+T syllable clusters, never alone.
    expect(charWidth(0xd7b0)).toBe(1); // first codepoint of the V run (N)
    expect(charWidth(0xd7c6)).toBe(1);
    expect(charWidth(0xd7cb)).toBe(1); // first codepoint of the T run (N)
    expect(charWidth(0xd7fb)).toBe(1);
    expect(charWidth(0xd7a3)).toBe(2); // final Hangul syllable (W)
    expect(charWidth(0xd7a4)).toBe(1); // unassigned gap
    expect(charWidth(0xd7fc)).toBe(1);
  });

  it("the whole U+FF61..U+FFDC halfwidth block never enters the wide table", () => {
    for (let cp = 0xff61; cp <= 0xffdc; cp++) {
      expect(charWidth(cp)).toBe(1);
    }
    // Same class at FFE0..FFE6: Unicode lists the WHOLE run as class F
    // (cent, pound, not, macron, broken-bar, yen, won) -- no halfwidth member.
    expect(charWidth(0xffe1)).toBe(2);
    for (const cp of [0xffe0, 0xffe2, 0xffe3, 0xffe4, 0xffe5, 0xffe6]) {
      expect(charWidth(cp)).toBe(2);
    }
  });
});

describe("visibleWidth -- emoji presentation", () => {
  it("emoji-presentation ranges are 2", () => {
    expect(visibleWidth("\u{1f600}")).toBe(2); // grinning face
    expect(visibleWidth("\u{1f389}\u{1f680}")).toBe(4); // party + rocket
    expect(visibleWidth("⛄")).toBe(2); // U+26C4 snowman without snow (EAW W)
    expect(visibleWidth("✅")).toBe(2); // U+2705 white heavy check mark
  });

  it("non-emoji symbols in the 2600 range stay 1", () => {
    expect(visibleWidth("☃")).toBe(1); // U+2603 snowman
    expect(visibleWidth("♠")).toBe(1); // U+2660 spade
  });

  it("ZWJ sequences measure as summed cells (documented §7 ceiling)", () => {
    expect(visibleWidth("\u{1f468}‍\u{1f469}‍\u{1f467}")).toBe(6); // family ZWJ sequence
  });
});

describe("visibleWidth -- escape spans are zero geometry", () => {
  it("OSC 8 hyperlink spans measure zero (BEL and ST terminated)", () => {
    const bel = `${ESC}]8;;https://example.com/x${BEL}link${ESC}]8;;${BEL}`;
    expect(visibleWidth(bel)).toBe(4);
    const st = `${ESC}]8;;https://example.com/x${ESC}\\link${ESC}]8;;${ESC}\\`; // ST = ESC backslash
    expect(visibleWidth(st)).toBe(4);
    expect(visibleWidth(`a${bel}b`)).toBe(6);
  });

  it("SGR color codes measure zero", () => {
    expect(visibleWidth(`${ESC}[31mred${ESC}[0m`)).toBe(3);
    expect(visibleWidth(`${ESC}[1;38;5;244mmid${ESC}[0m`)).toBe(3);
  });

  it("surrogate pairs never throw", () => {
    expect(visibleWidth("\u{1f600}x")).toBe(3);
    const loneHigh = "\u{1f600}".slice(0, 1);
    expect(() => visibleWidth(loneHigh)).not.toThrow();
  });
});

describe("wrapToWidth", () => {
  it("hard-wraps at the visible width", () => {
    expect(wrapToWidth("abcdef", 2)).toEqual(["ab", "cd", "ef"]);
    expect(wrapToWidth("abcd", 4)).toEqual(["abcd"]); // exact fit stays one row
    expect(wrapToWidth("", 5)).toEqual([""]);
  });

  it("splits input newlines", () => {
    expect(wrapToWidth("ab\ncd", 5)).toEqual(["ab", "cd"]);
    expect(wrapToWidth("a\n\nb", 5)).toEqual(["a", "", "b"]);
  });

  it("never splits a wide glyph across rows", () => {
    expect(wrapToWidth("你好", 3)).toEqual(["你", "好"]);
    expect(wrapToWidth(`a\u{1f600}b`, 3)).toEqual([`a\u{1f600}`, "b"]);
  });

  it("combining marks attach without eating the budget", () => {
    const pair = "e\u0301"; // base + combining acute = ONE cell (draft had a precomposed U+00E9 here)
    expect(visibleWidth(pair)).toBe(1);
    const lines = wrapToWidth(pair.repeat(3), 2); // 3 cells at width 2 => 2 rows
    expect(lines.map(visibleWidth)).toEqual([2, 1]);
    // A combining mark rides with its base; no row may start with one.
    for (const line of lines) expect("\u0301".indexOf(line[0] as string)).toBe(-1);
  });

  it("escape spans ride on the line they start on, zero geometry", () => {
    const s = `ab${ESC}]8;;u${BEL}cd${ESC}]8;;${BEL}ef`;
    const lines = wrapToWidth(s, 4);
    expect(lines.length).toBe(2);
    expect(visibleWidth(lines[0]!)).toBe(4);
    expect(visibleWidth(lines[1]!)).toBe(2);
  });

  it("clamps a degenerate width to 1", () => {
    expect(wrapToWidth("ab", 0)).toEqual(["a", "b"]);
  });
});

describe("width table consistency (binary-search contract)", () => {
  // charWidth binary-searches the range tables, so sortedness + non-overlap
  // is a load-bearing invariant: the first draft's misordered 0x0610 pair
  // made U+061C (Arabic letter mark) measure 1 while its neighbors read 0.
  for (const [name, ranges] of Object.entries(WIDTH_RANGE_TABLES)) {
    it(`${name} table: even length, sorted ascending, non-overlapping`, () => {
      expect(ranges.length % 2).toBe(0);
      for (let i = 0; i < ranges.length; i += 2) {
        const start = ranges[i]!;
        const end = ranges[i + 1]!;
        expect(start).toBeLessThanOrEqual(end);
        if (i > 0) expect(ranges[i - 1]!).toBeLessThan(start);
      }
    });

    it(`${name} table: binary search agrees with linear scan at every edge`, () => {
      const referenceWidth = (cp: number): number => {
        for (let i = 0; i < WIDTH_RANGE_TABLES.zero.length; i += 2) {
          if (cp >= WIDTH_RANGE_TABLES.zero[i]! && cp <= WIDTH_RANGE_TABLES.zero[i + 1]!) return 0;
        }
        for (let i = 0; i < WIDTH_RANGE_TABLES.wide.length; i += 2) {
          if (cp >= WIDTH_RANGE_TABLES.wide[i]! && cp <= WIDTH_RANGE_TABLES.wide[i + 1]!) return 2;
        }
        return 1;
      };
      const probes: number[] = [0x20, 0x7e, 0x1000, 0xfffd, 0x10ffff];
      for (const ranges of Object.values(WIDTH_RANGE_TABLES)) {
        for (let i = 0; i < ranges.length; i += 2) {
          probes.push(ranges[i]! - 1, ranges[i]!, ranges[i]! + 1, ranges[i + 1]! - 1, ranges[i + 1]!, ranges[i + 1]! + 1);
        }
      }
      for (const cp of probes) {
        if (cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) continue;
        expect(charWidth(cp)).toBe(referenceWidth(cp));
      }
    });
  }
});
