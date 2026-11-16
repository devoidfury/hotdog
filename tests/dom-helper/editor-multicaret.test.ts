// The multicaret + brace-matching half of the editor core, driven PURE (no
// DOM, no wire): the caret-list collapse rules, per-caret editing with the
// descending-offset apply order, box-select clamping, one-undo reverts the
// whole multi-op, the auto-close/skip ruleset matrix, the overtype rule, the
// empty-pair backspace, Enter-in-empty-block indent math, and the capped
// match scan.
import { describe, expect, it } from "bun:test";
import {
  MATCH_SCAN_CELLS,
  TAB_STOP,
  addCaretVertical,
  allSelText,
  altClickCaret,
  boxSelect,
  braceTypeAt,
  bufferFromContent,
  collapseSels,
  collapseSelections,
  contentOf,
  insertText,
  matchBracket,
  moveHorizontal,
  pressEnterSmart,
  redo,
  setCaret,
  typeChar,
  backspaceSmart,
  undo,
  type TextBuffer,
} from "@extensions/webui/ui/editor-buffer.ts";

const t = (n: number) => ({ kind: "typing" as const, time: n });
const at = (b: TextBuffer, line: number, col: number) => setCaret(b, { line, col });

describe("multi-caret collapse invariants", () => {
  it("alt+click adds carets, keeps the list sorted, and the click-point caret becomes primary", () => {
    let b = at(bufferFromContent("alpha\nbravo\ncharlie"), 0, 2);
    b = altClickCaret(b, { line: 2, col: 3 });
    b = altClickCaret(b, { line: 1, col: 1 });
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 2], [1, 1], [2, 3]]);
    expect(b.primary).toBe(1); // the last click owns the primary
  });

  it("alt+click on an existing caret REMOVES it; the last caret can never die", () => {
    let b = at(bufferFromContent("aa\nbb\ncc"), 0, 1);
    b = altClickCaret(b, { line: 2, col: 1 });
    expect(b.sels.length).toBe(2);
    b = altClickCaret(b, { line: 2, col: 1 }); // same point again -> remove
    expect(b.sels.length).toBe(1);
    expect(b.sels[0]!.head).toEqual({ line: 0, col: 1 });
    b = altClickCaret(b, { line: 0, col: 1 }); // clicking the ONLY caret: no-op
    expect(b.sels.length).toBe(1);
  });

  it("duplicate/out-of-order adds dedupe; a click INSIDE a range replaces that range", () => {
    let b = at(bufferFromContent("hello world"), 0, 2);
    b = altClickCaret(b, { line: 0, col: 2 }); // exact duplicate -> still one
    expect(b.sels.length).toBe(1);
    // Two carets, then widen the second into a range; clicking inside it
    // drops the RANGE and lands a caret at the point (the single-caret case
    // can never remove, checked above).
    b = altClickCaret(b, { line: 0, col: 8 });
    const widened = {
      ...b,
      sels: [b.sels[0]!, { anchor: { line: 0, col: 4 }, head: { line: 0, col: 7 } }],
      primary: 1,
    };
    const after = altClickCaret(widened, { line: 0, col: 5 });
    expect(after.sels).toEqual([
      { anchor: { line: 0, col: 2 }, head: { line: 0, col: 2 } },
      { anchor: { line: 0, col: 5 }, head: { line: 0, col: 5 } },
    ]);
    expect(after.primary).toBe(1);
  });
});

describe("per-caret editing (descending apply order)", () => {
  const three = () => {
    let b = at(bufferFromContent("aaa\nbbb\nccc"), 0, 1);
    b = altClickCaret(b, { line: 1, col: 2 });
    b = altClickCaret(b, { line: 2, col: 1 });
    return b;
  };

  it("typing at 3 carets: later offsets first, earlier carets stay valid", () => {
    const b = typeChar(three(), "X", 1000);
    expect(contentOf(b)).toBe("aXaa\nbbXb\ncXcc");
    // Carets advanced by exactly one each, list still sorted.
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 2], [1, 3], [2, 2]]);
  });

  it("Backspace at 3 carets deletes one code unit per caret, independently", () => {
    const b = backspaceSmart(three(), 1000);
    expect(contentOf(b)).toBe("aa\nbb\ncc");
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 0], [1, 1], [2, 0]]);
  });

  it("Enter at 3 carets splits every line (one block step), carets land on the new lines", () => {
    const b = pressEnterSmart(three(), 1000);
    expect(contentOf(b)).toBe("a\naa\nbb\nb\nc\ncc");
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[1, 0], [3, 0], [5, 0]]);
  });

  it("paste (multi-char block) lands at every caret", () => {
    const b = insertText(three(), "Z9", t(1000));
    expect(contentOf(b)).toBe("aZ9aa\nbbZ9b\ncZ9cc");
  });

  it("a caret right of a LOWER insertion shifts with it (offset-shift correctness)", () => {
    let b = at(bufferFromContent("x y z"), 0, 1);
    b = altClickCaret(b, { line: 0, col: 3 });
    b = typeChar(b, "Q", 1000); // applied 3 first, then 1: the (0,3) caret must ride to 5
    expect(contentOf(b)).toBe("xQ yQ z");
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 2], [0, 5]]);
  });

  it("selection-delete at 3 carets removes every range", () => {
    let b = at(bufferFromContent("aaa\nbbb\nccc"), 0, 0);
    b = {
      ...b,
      sels: [
        { anchor: { line: 0, col: 0 }, head: { line: 0, col: 2 } },
        { anchor: { line: 1, col: 1 }, head: { line: 1, col: 3 } },
        { anchor: { line: 2, col: 0 }, head: { line: 2, col: 1 } },
      ],
      primary: 1,
    };
    const out = backspaceSmart(b, 1000);
    expect(contentOf(out)).toBe("a\nb\ncc"); // "aa"->"a", "bb"->"b" (col 1..3), "cc"->"c"
  });
});

describe("multi-selection copy", () => {
  it("multiple ranges join with newlines (VS Code idiom, pinned)", () => {
    let b = at(bufferFromContent("alpha\nbravo"), 0, 0);
    b = {
      ...b,
      sels: [
        { anchor: { line: 0, col: 0 }, head: { line: 0, col: 5 } },
        { anchor: { line: 1, col: 0 }, head: { line: 1, col: 5 } },
      ],
      primary: 0,
    };
    expect(allSelText(b)).toBe("alpha\nbravo");
  });
});

describe("caret collapse", () => {
  it("a plain arrow after a multi-selection keeps the PRIMARY only", () => {
    let b = at(bufferFromContent("aaa\nbbb\nccc"), 0, 1);
    b = altClickCaret(b, { line: 2, col: 1 });
    b = moveHorizontal(b, 1, false);
    expect(b.sels.length).toBe(1);
    expect(b.sels[0]!.head).toEqual({ line: 2, col: 2 }); // moved from the primary (2,1)
  });

  it("Escape collapses every range to the primary head", () => {
    let b = at(bufferFromContent("aaa\nbbb"), 1, 2);
    b = altClickCaret(b, { line: 0, col: 0 });
    b = collapseSelections(b);
    expect(b.sels).toEqual([{ anchor: { line: 0, col: 0 }, head: { line: 0, col: 0 } }]);
    expect(b.primary).toBe(0);
  });
});

describe("add-caret-below/above (Alt+Shift+Arrow)", () => {
  it("adds at the SAME column, walking down line after line", () => {
    let b = at(bufferFromContent("aaaa\nbbbb\ncccc"), 0, 2);
    b = addCaretVertical(b, 1);
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 2], [1, 2]]);
    b = addCaretVertical(b, 1);
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 2], [1, 2], [2, 2]]);
  });

  it("clamps to short lines (never pads) and stops honestly off-buffer", () => {
    let b = at(bufferFromContent("aaaaaaaa\nb\ncc"), 0, 6);
    const off = addCaretVertical(b, -1); // primary sits on line 0; line -1 does not exist
    expect(off).toBe(b); // unchanged, no throw
    b = addCaretVertical(b, 1);
    expect(b.sels.at(-1)!.head).toEqual({ line: 1, col: 1 }); // clamped to "b"
  });
});

describe("box (column) selection", () => {
  it("every line in the drag gets a range; short lines CLAMP, never pad", () => {
    const b0 = at(bufferFromContent("abcdefgh\nab\nabcdef"), 0, 2);
    const b = boxSelect(b0, { line: 0, vcol: 1 }, { line: 2, vcol: 5 });
    expect(b.sels.map((r) => [r.anchor.line, r.anchor.col, r.head.line, r.head.col])).toEqual([
      [0, 1, 0, 5],
      [1, 1, 1, 2], // "ab" clamps at its length (2), no padding
      [2, 1, 2, 5],
    ]);
    expect(b.primary).toBe(2); // the b.line row owns the primary
  });

  it("a zero-width box is one caret per line; typing CLAMPS short lines (inserts at their end)", () => {
    let b = at(bufferFromContent("abcdefgh\nab\nabcdef"), 0, 0);
    b = boxSelect(b, { line: 0, vcol: 4 }, { line: 2, vcol: 4 });
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 4], [1, 2], [2, 4]]);
    b = typeChar(b, "X", 1000);
    expect(contentOf(b)).toBe("abcdXefgh\nabX\nabcdXef"); // "ab" gains X at its end, no leading pad
  });

  it("upward drags keep anchor/head direction sane (anchor on the a-side)", () => {
    const b = boxSelect(at(bufferFromContent("aaaa\nbbbb"), 1, 0), { line: 1, vcol: 3 }, { line: 0, vcol: 1 });
    expect(b.sels[0]).toEqual({ anchor: { line: 0, col: 3 }, head: { line: 0, col: 1 } });
    expect(b.sels[1]).toEqual({ anchor: { line: 1, col: 3 }, head: { line: 1, col: 1 } });
  });
});

describe("undo: one multi-caret operation is ONE step", () => {
  it("one Ctrl+Z reverts ALL carets (and the caret list) together; redo re-applies", () => {
    let b = at(bufferFromContent("aaa\nbbb\nccc"), 0, 1);
    b = altClickCaret(b, { line: 1, col: 2 });
    b = altClickCaret(b, { line: 2, col: 1 });
    const before = b;
    b = typeChar(b, "X", 1000);
    b = typeChar(b, "Y", 5000); // far past the coalesce window: a second step
    expect(contentOf(b)).toBe("aXYaa\nbbXYb\ncXYcc");
    b = undo(b);
    expect(contentOf(b)).toBe("aXaa\nbbXb\ncXcc");
    b = undo(b);
    expect(contentOf(b)).toBe("aaa\nbbb\nccc");
    expect(b.sels).toEqual(before.sels); // the caret LIST reverts too
    expect(b.primary).toBe(before.primary);
    b = redo(b);
    expect(contentOf(b)).toBe("aXaa\nbbXb\ncXcc");
  });

  it("auto-inserted pair + immediate backspace: pair insert is ONE step, undo leaves no orphan closer", () => {
    let b = at(bufferFromContent("let x = "), 0, 8);
    b = typeChar(b, "{", 1000); // pair inserted as ONE step (not "{" then "}")
    expect(contentOf(b)).toBe("let x = {}");
    b = backspaceSmart(b, 1000); // empty pair: BOTH halves go (delete polarity: its own step)
    expect(contentOf(b)).toBe("let x = ");
    b = undo(b);
    expect(contentOf(b)).toBe("let x = {}"); // the pair returns WHOLE (no orphan "{")
    b = undo(b);
    expect(contentOf(b)).toBe("let x = "); // no half-pair residue at any stop
  });
});

describe("auto-close conditions matrix (per opening char)", () => {
  it("( [ { close when right is EOL, whitespace, or ANY closer; never on a word char", () => {
    const close = { "(": ")", "[": "]", "{": "}" } as Record<string, string>;
    for (const opener of ["(", "[", "{"]) {
      expect(braceTypeAt(["x"], { line: 0, col: 1 }, opener)?.insert).toBe(opener + close[opener]); // EOL
      expect(braceTypeAt(["x "], { line: 0, col: 1 }, opener)?.insert).toBe(opener + close[opener]); // space
      for (const closer of [")", "]", "}", '"', "'", "`"]) {
        expect(braceTypeAt(["x" + closer], { line: 0, col: 1 }, opener)?.insert).toBe(opener + close[opener]);
      }
      expect(braceTypeAt(["xa"], { line: 0, col: 1 }, opener)).toBeUndefined(); // word char right: no pair
    }
  });
  it("quotes close when right is empty/space/closer, NEVER inside a word", () => {
    for (const q of ['"', "'", "`"]) {
      expect(braceTypeAt(["x "], { line: 0, col: 1 }, q)?.insert).toBe(q + q); // space right (word left) closes
      expect(braceTypeAt(["x)"], { line: 0, col: 1 }, q)?.insert).toBe(q + q); // closer right closes
      expect(braceTypeAt(["foobar"], { line: 0, col: 3 }, q)).toBeUndefined(); // word on BOTH sides: no pair
      // Right is a WORD CHAR at the line start: the general closer condition
      // (right must be EOL/space/closer) dominates -- no pair (pinned rule:
      // the inside-word quote guard is a SECOND veto, not the only one).
      expect(braceTypeAt(["foo"], { line: 0, col: 0 }, q)).toBeUndefined();
    }
  });
  it("typing lands the caret INSIDE the pair", () => {
    let b = at(bufferFromContent("f()"), 0, 2); // between an existing pair is NOT re-paired: right is a closer -> still pairs ("()" rule holds)
    b = typeChar(b, "{", 1000);
    expect(contentOf(b)).toBe("f({})");
    const h = b.sels[b.primary]!.head;
    expect(h).toEqual({ line: 0, col: 3 }); // inside: between { and }
  });
});

describe("overtype the closer", () => {
  it(") ] } walk over with NO text change and NO undo step", () => {
    let b = at(bufferFromContent("f()"), 0, 2);
    const before = b;
    b = typeChar(b, ")", 1000);
    expect(contentOf(b)).toBe("f()");
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 3 });
    expect(b.undo.length).toBe(before.undo.length); // pure move, not an edit
    expect(b.dirty).toBe(before.dirty);
  });
  it("quotes skip over only with an ODD count left (the open pair we inserted)", () => {
    let b = at(bufferFromContent('say ""'), 0, 5); // inside "" -> one " left: odd -> overtype
    b = typeChar(b, '"', 1000);
    expect(contentOf(b)).toBe('say ""');
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 6 });
    // Even count left (closed string / prose): no skip-over; EOL right means
    // the auto-close rule applies instead -- a NEW pair is inserted.
    let c = at(bufferFromContent('""'), 0, 2);
    c = typeChar(c, '"', 1000);
    expect(contentOf(c)).toBe('""""');
  });
});

describe("backspace deletes the empty pair", () => {
  it("{ | } -> both halves go, one caret remains there", () => {
    let b = at(bufferFromContent("[]"), 0, 1);
    b = backspaceSmart(b, 1000);
    expect(contentOf(b)).toBe("");
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 0 });
    let q = at(bufferFromContent('""'), 0, 1);
    q = backspaceSmart(q, 1000);
    expect(contentOf(q)).toBe("");
  });
  it("at 3 carets each pair dies independently, one undo step", () => {
    let b = at(bufferFromContent("[]\n{}\n()"), 0, 1);
    b = altClickCaret(b, { line: 1, col: 1 });
    b = altClickCaret(b, { line: 2, col: 1 });
    b = backspaceSmart(b, 1000);
    expect(contentOf(b)).toBe("\n\n");
    b = undo(b);
    expect(contentOf(b)).toBe("[]\n{}\n()");
  });
});

describe("Enter in an empty block: indent math", () => {
  it("{ | } becomes three lines: opener / caret at opener indent + one stop / closer at opener indent", () => {
    let b = at(bufferFromContent("  {}"), 0, 3); // caret between { and }
    b = pressEnterSmart(b, 1000);
    // ws = two spaces; pad rides to the NEXT stop: 2 + 2 = the 4-cell line.
    expect(b.lines).toEqual(["  {", "  " + " ".repeat(TAB_STOP - 2), "  }"]);
    expect(b.sels[b.primary]!.head).toEqual({ line: 1, col: 4 });
  });
  it("tab-indented opener: the mid line lands on the NEXT stop past the opener indent", () => {
    const buf0 = bufferFromContent("\t{}");
    let b = at(buf0, 0, 2);
    b = pressEnterSmart(b, 1000);
    expect(b.lines).toEqual(["\t{", `\t${" ".repeat(TAB_STOP)}`, "\t}"]);
    expect(b.sels[b.primary]!.head).toEqual({ line: 1, col: 1 + TAB_STOP });
  });
  it("content inside the braces: plain newline + auto-indent only (no reindent engine)", () => {
    let b = at(bufferFromContent("  {a}"), 0, 4); // caret after "a", before }
    b = pressEnterSmart(b, 1000);
    expect(b.lines).toEqual(["  {a", "  }"]); // plain \n + leading WS copy, stated ceiling
  });
  it("quotes never expand", () => {
    let b = at(bufferFromContent('""'), 0, 1);
    b = pressEnterSmart(b, 1000);
    expect(b.lines).toEqual(['"', '"']); // plain newline + auto-indent (ws is empty here)
  });
});

describe("matched-bracket highlight scan", () => {
  it("adjacency finds the mate (right char preferred), moves off it vanishes", () => {
    const m = matchBracket(["f(a + b)"], { line: 0, col: 2 }); // caret right of (
    expect(m).toEqual({ a: { line: 0, col: 1 }, b: { line: 0, col: 7 } });
    expect(matchBracket(["f(a + b)"], { line: 0, col: 7 })).toEqual({ a: { line: 0, col: 7 }, b: { line: 0, col: 1 } });
    expect(matchBracket(["f(a + b)"], { line: 0, col: 4 })).toBeUndefined(); // mid-content: nothing adjacent
  });
  it("multi-line pairs match; string contents never do", () => {
    const m = matchBracket(["if (x) {", "  y();", "}"], { line: 0, col: 7 });
    expect(m!.b).toEqual({ line: 2, col: 0 });
    expect(matchBracket(['f(")")'], { line: 0, col: 1 })).toEqual({ a: { line: 0, col: 1 }, b: { line: 0, col: 5 } });
    expect(matchBracket(['f("nope")'], { line: 0, col: 4 })).toBeUndefined(); // inside the string, no adjacency
  });
  it("crossed brackets and no-mates report undefined; the scan CAPS and cannot crash", () => {
    expect(matchBracket(["(a]b)"], { line: 0, col: 1 })).toBeUndefined(); // crossed: honest no-match
    expect(matchBracket(["(((aaa"], { line: 0, col: 1 })).toBeUndefined(); // no closer at all
    // Past the cap: the mate exists but is unreachable -> undefined, no hang.
    const huge = "(" + "x".repeat(MATCH_SCAN_CELLS + 10) + ")";
    expect(matchBracket([huge], { line: 0, col: 1 })).toBeUndefined();
    // Brackets spread across many lines still terminate at the cap.
    expect(matchBracket(["(".repeat(50), ")".repeat(50)], { line: 0, col: 49 })!.b).toEqual({ line: 1, col: 0 });
  });
});

describe("caret-onto-caret dedupe + per-caret overtype parity", () => {
  it("walking a caret back onto an existing caret re-seats primary and NEVER duplicates", () => {
    let b = at(bufferFromContent("aaaa\nbbbb"), 0, 2);
    b = addCaretVertical(b, 1); // [(0,2),(1,2)]
    expect(b.sels.length).toBe(2);
    b = addCaretVertical(b, -1); // (0,2) already there -> collapseSels dedupes...
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 2], [1, 2]]);
    expect(b.primary).toBe(0); // ...and re-seats the primary onto the survivor
    b = typeChar(b, "X", 1000);
    expect(contentOf(b)).toBe("aaXaa\nbbXbb"); // ONCE per caret
    b = backspaceSmart(b, 5000);
    expect(contentOf(b)).toBe("aaaa\nbbbb"); // one code unit per caret
  });

  it("collapseSels merges identical carets (want survives); a caret touching a range end stays distinct", () => {
    const a = { anchor: { line: 0, col: 3 }, head: { line: 0, col: 3 } };
    const b2 = { anchor: { line: 0, col: 3 }, head: { line: 0, col: 3 } };
    const m = collapseSels([a, b2], b2);
    expect(m.sels.length).toBe(1);
    expect(m.primary).toBe(0); // the want flag rode onto the survivor
    const touch = collapseSels([
      { anchor: { line: 0, col: 1 }, head: { line: 0, col: 3 } },
      { anchor: { line: 0, col: 3 }, head: { line: 0, col: 3 } },
    ]);
    expect(touch.sels.length).toBe(2); // deliberate VS Code rule preserved
  });

  it("an overtype at one caret does NOT swallow the keystroke at a plain caret", () => {
    let b = at(bufferFromContent("f() ab"), 0, 2); // right is ")" -> overtype
    b = altClickCaret(b, { line: 0, col: 5 }); // plain caret between a and b
    b = typeChar(b, ")", 1000);
    expect(contentOf(b)).toBe("f() a)b"); // the plain caret INSERTED
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 3], [0, 6]]);
  });

  it("an overtype at one caret does NOT swallow a SELECTION replace at another", () => {
    let b = at(bufferFromContent("de() xy"), 0, 0);
    b = {
      ...b,
      sels: [
        { anchor: { line: 0, col: 0 }, head: { line: 0, col: 2 } }, // "de" -> replace
        { anchor: { line: 0, col: 3 }, head: { line: 0, col: 3 } }, // before ")" -> over
      ],
      primary: 0,
    };
    b = typeChar(b, ")", 1000);
    expect(contentOf(b)).toBe(")() xy");
    // The over caret's pre-state walk follows the (higher) selection edit:
    // (0,4) -> (0,3) once "de" became ")" (shiftPastEdit through it).
    expect(b.sels.map((r) => [r.head.line, r.head.col])).toEqual([[0, 1], [0, 3]]);
  });
});
