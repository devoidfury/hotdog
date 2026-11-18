// The editor's PURE half, driven directly: the buffer, the transaction
// seam (insert/delete spans, coalescing, undo/redo), auto-indent, tab
// stops, the visual-column geometry, and the save/dirty machine. No DOM,
// no wire -- editor.tsx/app.tsx behavior is pinned in app.test.tsx.
import { describe, expect, it } from "bun:test";
import {
  COALESCE_MS,
  EDIT_CHAR_CAP,
  EDIT_PAGE_LINES,
  TAB_STOP,
  allSelText,
  applySaveResult,
  backwardWordCol,
  backspace,
  bufferFromContent,
  bufferFromStash,
  colForX,
  confirmDiscard,
  contentOf,
  dedentChars,
  dedentLines,
  deleteForward,
  deleteWord,
  docEnd,
  duplicateLine,
  forwardWordCol,
  hitPos,
  indentTab,
  insertText,
  markSaved,
  moveWordHorizontal,
  pressEnter,
  quoteContentRange,
  redo,
  selectAll,
  selectInsideQuotes,
  selectWordAt,
  setCaret,
  smartEnd,
  smartHome,
  toggleLineComment,
  typeChar,
  undo,
  visualCol,
  colAtVisual,
  wordRange,
  xForCol,
  type EditorSession,
  type TextBuffer,
} from "@extensions/webui/ui/editor-buffer.ts";
import { MAX_FILE_READ_CHARS, MAX_FILE_WRITE_BYTES, MAX_READ_LINES } from "@extensions/websocket/protocol.ts";

const t = (n: number) => ({ kind: "typing" as const, time: n });
const caretAt = (s: ReturnType<typeof bufferFromContent>, line: number, col: number) =>
  setCaret(s, { line, col });

describe("bufferFromContent / contentOf", () => {
  it("round-trips bytes exactly (the trailing newline is a fact, not a line)", () => {
    expect(contentOf(bufferFromContent("ab\n"))).toBe("ab\n");
    expect(contentOf(bufferFromContent(""))).toBe("");
    expect(contentOf(bufferFromContent("a\n\nb"))).toBe("a\n\nb");
    expect(bufferFromContent("ab\n").lines).toEqual(["ab"]); // no phantom last line
    expect(bufferFromContent("ab").lines).toEqual(["ab"]);
    expect(contentOf(bufferFromContent("ab\n"))).toBe("ab\n"); // endsNL survives a no-op edit
  });
});

describe("insert/delete spans", () => {
  it("typing inserts at the caret and leaves a zero-width selection there", () => {
    let b = caretAt(bufferFromContent("hello world"), 0, 5);
    b = insertText(b, "!", t(0));
    expect(contentOf(b)).toBe("hello! world");
    const sel = b.sels[b.primary]!;
    expect(sel.anchor).toEqual({ line: 0, col: 6 });
    expect(sel.head).toEqual({ line: 0, col: 6 });
  });

  it("typing REPLACES a selection; a multi-line span collapses into the insert", () => {
    let b = bufferFromContent("abc\ndef\n");
    b = { ...b, sels: [{ anchor: { line: 0, col: 2 }, head: { line: 1, col: 2 } }], primary: 0 };
    b = insertText(b, "X", t(0)); // the span covers "c\nde"
    expect(contentOf(b)).toBe("abXf\n"); // joined, no stranded tail line
    b = backspace(b, 10); // caret sits right after the X: one press eats it
    expect(contentOf(b)).toBe("abf\n");
    const u = undo(b); // eats only the backspace
    expect(contentOf(u)).toBe("abXf\n");
    expect(contentOf(redo(u))).toBe("abf\n");
  });

  it("Ctrl+A then type replaces the whole file; allSelText joins range texts", () => {
    let b = selectAll(bufferFromContent("one\ntwo\n"));
    expect(allSelText(b)).toBe("one\ntwo");
    b = insertText(b, "z", t(0));
    expect(contentOf(b)).toBe("z\n");
  });

  it("multi-range edits apply to EVERY range in one step, descending, undo as one", () => {
    let b = bufferFromContent("one\ntwo\n");
    b = {
      ...b,
      sels: [
        { anchor: { line: 0, col: 3 }, head: { line: 0, col: 3 } },
        { anchor: { line: 1, col: 3 }, head: { line: 1, col: 3 } },
      ],
      primary: 0,
    };
    b = insertText(b, "!", t(0));
    expect(contentOf(b)).toBe("one!\ntwo!\n");
    const back = undo(b); // ONE step eats both
    expect(contentOf(back)).toBe("one\ntwo\n");
    expect(back.sels).toHaveLength(2);
  });

  it("backspace at column 0 joins the lines; Delete at EOL does the same", () => {
    let b = caretAt(bufferFromContent("ab\ncd\n"), 1, 0);
    expect(contentOf(backspace(b, 0))).toBe("abcd\n");
    b = caretAt(bufferFromContent("ab\ncd\n"), 0, 2);
    expect(contentOf(deleteForward(b, 0))).toBe("abcd\n");
  });

  it("surrogate pairs stay whole: a mid-pair caret clamps to the pair start, backspace eats the pair", () => {
    const pair = caretAt(bufferFromContent("a\u{1F600}b"), 0, 3); // after the whole pair
    expect(contentOf(backspace(pair, 0))).toBe("ab");
    const inside = caretAt(bufferFromContent("a\u{1F600}b"), 0, 2); // between the halves
    expect(inside.sels[inside.primary]!.head).toEqual({ line: 0, col: 1 }); // clamped back
    expect(contentOf(insertText(inside, "-", t(0)))).toBe("a-\u{1F600}b");
    const del = deleteForward(caretAt(bufferFromContent("a\u{1F600}b"), 0, 1), 0);
    expect(contentOf(del)).toBe("ab");
  });
});

describe("undo coalescing (typing runs, word/timeout bounded)", () => {
  it("a fast typing run is ONE undo step", () => {
    let b = bufferFromContent("");
    b = insertText(b, "a", t(0));
    b = insertText(b, "b", t(10));
    b = insertText(b, "c", t(20));
    expect(b.undo.length).toBe(1);
    expect(contentOf(undo(b))).toBe("");
  });

  it("a typed SPACE bounds the run: word, space, word undo separately", () => {
    let b = bufferFromContent("");
    b = insertText(b, "a", t(0));
    b = insertText(b, "b", t(10));
    b = insertText(b, " ", t(20)); // whitespace closes both runs
    b = insertText(b, "c", t(30));
    expect(b.undo.length).toBe(3);
    expect(contentOf(undo(b))).toBe("ab ");
    expect(contentOf(undo(undo(b)))).toBe("ab");
  });

  it("past COALESCE_MS the run splits; an insert/delete polarity flip splits", () => {
    let b = bufferFromContent("");
    b = insertText(b, "a", t(0));
    b = insertText(b, "b", t(COALESCE_MS + 1));
    expect(b.undo.length).toBe(2);
    b = insertText(b, "c", t(COALESCE_MS + 2));
    b = backspace(b, COALESCE_MS + 3); // delete vs insert: its own step
    expect(b.undo.length).toBe(3);
    expect(contentOf(undo(b))).toBe("abc");
  });

  it("block ops (Enter, paste, IME commit) never merge into a typing run", () => {
    let b = bufferFromContent("");
    b = insertText(b, "a", t(0));
    b = pressEnter(b, t(10).time);
    expect(b.undo.length).toBe(2);
    b = insertText(b, "multi", t(20)); // >1 char is a block step
    expect(b.undo.length).toBe(3);
    expect(contentOf(undo(b))).toBe("a\n");
  });

  it("redo re-applies; a fresh edit clears the redo stack", () => {
    const start = setCaret(bufferFromContent("x"), { line: 0, col: 1 });
    const before = undo(insertText(start, "y", t(0)));
    expect(contentOf(redo(before))).toBe("xy");
    const typed = insertText(before, "z", t(100));
    expect(typed.redo).toHaveLength(0);
  });

  it("undo restores the selections exactly as they were (the caret rides the step)", () => {
    let b = caretAt(bufferFromContent("hello\nworld\n"), 0, 2);
    b = insertText(b, "AB", t(0));
    const back = undo(b);
    expect(back.sels[back.primary]!.head).toEqual({ line: 0, col: 2 });
    expect(back.sels[back.primary]!.anchor).toEqual({ line: 0, col: 2 });
  });
});

describe("auto-indent and tab stops", () => {
  it("Enter copies the previous line's leading whitespace and parks the caret after it", () => {
    let b = caretAt(bufferFromContent("    foo\nbar"), 0, 7);
    b = pressEnter(b, 0);
    expect(b.lines).toEqual(["    foo", "    ", "bar"]);
    expect(b.sels[b.primary]!.head).toEqual({ line: 1, col: 4 });
  });

  it("Enter on an unindented line is a bare newline", () => {
    const b = pressEnter(caretAt(bufferFromContent("foo"), 0, 3), 0);
    expect(b.lines).toEqual(["foo", ""]);
  });

  it("Tab pads to the NEXT multiple of 4 (visual, so real tabs count too)", () => {
    let b = caretAt(bufferFromContent("x"), 0, 1);
    b = indentTab(b, 0);
    expect(b.lines).toEqual(["x   "]);
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 4 });
    b = indentTab(b, 10); // col 4 -> next stop is 8: four more
    expect(b.lines).toEqual(["x       "]); // x + 7 spaces, caret at col 8
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 8 });
    const tabbed = indentTab(caretAt(bufferFromContent("\tab"), 0, 1), 0); // after the tab char: visual 4
    expect(tabbed.lines).toEqual(["\t    ab"]); // the pad goes AT THE CARET: 4 spaces to stop 8
    expect(TAB_STOP).toBe(4);
  });

  it("Shift+Tab dedents to the previous stop (min 4-step: a 2-space line drops to 0)", () => {
    let b = caretAt(bufferFromContent("    x"), 0, 4);
    b = dedentLines(b, 0);
    expect(b.lines).toEqual(["x"]);
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 0 }); // caret shifts with the strip
    b = dedentLines(caretAt(bufferFromContent("  x"), 0, 3), 0);
    expect(b.lines).toEqual(["x"]);
    b = dedentLines(caretAt(bufferFromContent("\t\tx"), 0, 2), 0); // tabs are indivisible
    expect(b.lines).toEqual(["\tx"]);
    expect(dedentChars("\t x")).toBe(1); // target 1 cell below stop 4: the whole (indivisible) tab goes, the space stays
  });

  it("Shift+Tab across a multi-line selection dedents EVERY touched line in one undo step", () => {
    let b = bufferFromContent("  a\n  b\n");
    b = { ...b, sels: [{ anchor: { line: 0, col: 1 }, head: { line: 1, col: 1 } }], primary: 0 };
    b = dedentLines(b, 0);
    expect(b.lines).toEqual(["a", "b"]); // endsNL is a fact, not a phantom line
    expect(b.undo.length).toBe(1);
    expect(contentOf(undo(b))).toBe("  a\n  b\n");
  });
});

describe("visual columns and hit-testing", () => {
  it("a tab advances to its stop in BOTH directions (click inside a tab lands ON it)", () => {
    expect(visualCol("\tab", 1)).toBe(4);
    expect(visualCol("\tab", 2)).toBe(5);
    expect(colAtVisual("\tab", 2)).toBe(0); // mid-tab cell -> the tab itself
    expect(colAtVisual("\tab", 4)).toBe(1);
    for (const [line, col] of [["\ta\tb", 0], ["\ta\tb", 1], ["\ta\tb", 3], ["x  y", 4]] as const) {
      expect(colAtVisual(line, visualCol(line, col))).toBe(col);
    }
  });

  it("hitPos maps pixels to (line, col), clamped", () => {
    const lines = ["ab", "cdef"];
    const m = { charW: 10, lineH: 20 };
    expect(hitPos(lines, m, 5, 10, 0)).toEqual({ line: 0, col: 1 });
    expect(hitPos(lines, m, 10, 30, 0)).toEqual({ line: 1, col: 1 });
    expect(hitPos(lines, m, 999, 9999, 0)).toEqual({ line: 1, col: 4 });
  });

  it("smart Home: first press to the first non-whitespace, second to column 0", () => {
    let b = caretAt(bufferFromContent("    x"), 0, 5);
    b = smartHome(b, false);
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 4 });
    b = smartHome(b, false);
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 0 });
    b = smartHome(b, false);
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 4 });
  });
});

describe("the column<->x mapping (the ONE function caret + hit-test share)", () => {
  it("round-trips col -> x -> col at column 1, 100, 400 for a faked cell width", () => {
    // A 400-char line; cw is whatever the page measured (or a test fake). The
    // caret paints at xForCol; a click at that x must return the SAME column.
    const line = "x".repeat(400);
    for (const cw of [8, 7.4, 10]) {
      for (const col of [1, 100, 400]) {
        expect(colForX(line, xForCol(line, col, cw), cw)).toBe(col);
      }
    }
  });

  it("horizontal scroll cannot drift the two sides apart (one shared origin)", () => {
    // Scroll is folded into the code element's live rect: hit and caret both
    // measure x from that SAME origin, so adding a scrollLeft offset to both
    // cancels -- there is no second scrollLeft term to diverge. Prove it on
    // both sides of a tab seam too (tab -> stop columns).
    const line = "\tx".repeat(40); // tabs early, mixed columns (80 code units)
    const cw = 8;
    const scrollLeft = 640; // scrolled well past column 80
    for (const col of [0, 1, 4, 5, 40, 79]) {
      const caretX = xForCol(line, col, cw); // caret left (document space)
      // A click at the caret's viewport x = caretX - scrollLeft, measured
      // back against an origin already shifted by the same scrollLeft.
      const clickViewportX = caretX - scrollLeft;
      const hitDocX = clickViewportX + scrollLeft; // the shared origin re-adds it
      expect(colForX(line, hitDocX, cw)).toBe(col);
    }
  });

  it("the cell model is linear-in-column ONLY when cw matches the advance", () => {
    // Regression shape for the caret-drift bug: caret_x(col) must be
    // visualCol(col) * cw, exactly linear in the cell count. A wrong cw
    // (sans face / pre-webfont) makes the error grow with the column.
    const line = "abcdefghij";
    const cw = 8.4;
    for (let col = 0; col <= line.length; col++) {
      expect(xForCol(line, col, cw)).toBe(visualCol(line, col) * cw);
    }
  });
});

describe("the empty-area click's target + the double-click word classes", () => {
  it("docEnd lands at the last line's end (what the full-height empty area maps to)", () => {
    // A short file in a taller pane: a click in the sheet painted BELOW the
    // last line must map to the END of the buffer, never a phantom line. The
    // viewport's mousedown routes that click to docEnd.
    let b = caretAt(bufferFromContent("ab\ncdef\n"), 0, 0);
    b = docEnd(b, false);
    expect(b.sels[b.primary]!.head).toEqual({ line: 1, col: 4 }); // last content line "cdef", end
    expect(b.sels[b.primary]!.anchor).toEqual({ line: 1, col: 4 });
    // Shift-click/drag extends from the caret to the end (anchor preserved).
    let e = caretAt(bufferFromContent("ab\ncdef\n"), 0, 1);
    e = docEnd(e, true);
    expect(e.sels[e.primary]!.anchor).toEqual({ line: 0, col: 1 });
    expect(e.sels[e.primary]!.head).toEqual({ line: 1, col: 4 });
  });

  it("double-click splits three ways and a punctuation run stops AT whitespace", () => {
    // word / whitespace / punctuation. The punctuation class is non-word AND
    // non-space -- /\W/ would have swallowed the adjacent spaces here.
    expect(wordRange("foo bar", 1)).toEqual({ anchor: { line: 0, col: 0 }, head: { line: 0, col: 3 } });
    expect(wordRange("foo bar", 4)).toEqual({ anchor: { line: 0, col: 4 }, head: { line: 0, col: 7 } }); // "bar"
    expect(wordRange("foo bar", 3)).toEqual({ anchor: { line: 0, col: 3 }, head: { line: 0, col: 4 } }); // the single space
    expect(wordRange("a ++ b", 2)).toEqual({ anchor: { line: 0, col: 2 }, head: { line: 0, col: 4 } }); // "++", stops at the spaces
    // selectWordAt maps a hit point onto that run.
    const w = selectWordAt(bufferFromContent("a ++ b"), { line: 0, col: 3 });
    expect(w.sels[0]).toEqual({ anchor: { line: 0, col: 2 }, head: { line: 0, col: 4 } });
  });
});

describe("save/dirty machine + the cap twins", () => {
  const session = (dirty: boolean): EditorSession => {
    let b = bufferFromContent("x\n");
    if (dirty) b = insertText(b, "y", t(0));
    return { path: "/p", buffer: b, baseMtimeMs: 100, saving: false };
  };

  it("success: clean, base moves to the reply's NEW mtime; a missing mtime rides 0 (the gate then refuses)", () => {
    const { session: s, outcome } = applySaveResult(session(true), { type: "fileOpResult", requestId: 1, path: "/p", mtimeMs: 200 });
    expect(outcome).toEqual({ type: "saved", mtimeMs: 200 });
    expect(s.buffer.dirty).toBe(false);
    expect(s.baseMtimeMs).toBe(200);
    expect(s.saving).toBe(false);
    expect(applySaveResult(s, { type: "fileOpResult", requestId: 2, path: "/p" }).session.baseMtimeMs).toBe(0);
  });

  it("conflict: still dirty, saving off, the fresh mtime handed up for the Overwrite door", () => {
    const { session: s, outcome } = applySaveResult(
      { ...session(true), saving: true },
      { type: "fileOpResult", requestId: 1, conflict: true, mtimeMs: 555, error: "changed" },
    );
    expect(outcome).toEqual({ type: "conflict", mtimeMs: 555, error: "changed" });
    expect(s.buffer.dirty).toBe(true);
    expect(s.saving).toBe(false);
    expect(s.baseMtimeMs).toBe(100); // untouched until the user picks Overwrite
  });

  it("confirmDiscard: a clean buffer never asks, a dirty one goes through the app's gate", () => {
    const asked: string[] = [];
    expect(confirmDiscard(session(false), "p", (m) => (asked.push(m), true))).toBe(true);
    expect(asked).toHaveLength(0);
    expect(confirmDiscard(session(true), "p", () => false)).toBe(false);
    expect(confirmDiscard(session(true), "p", () => true)).toBe(true);
  });

  it("the twins: the client's edit cap/page size equal the server's read/write ceilings", () => {
    expect(EDIT_CHAR_CAP).toBe(MAX_FILE_READ_CHARS);
    expect(MAX_FILE_WRITE_BYTES).toBe(MAX_FILE_READ_CHARS);
    expect(EDIT_PAGE_LINES).toBe(MAX_READ_LINES);
  });
});

describe("content-based dirty (owner ruling 2026-11-16)", () => {
  it("type a char then delete it: back to the baseline bytes means CLEAN", () => {
    let b = bufferFromContent("ab\n");
    expect(b.dirty).toBe(false); // the load seeds the baseline
    b = insertText(b, "x", t(0));
    expect(b.dirty).toBe(true);
    b = backspace(b, 10);
    expect(contentOf(b)).toBe("ab\n");
    expect(b.dirty).toBe(false);
  });

  it("a multi-caret insert undoes to the baseline: clean; redo flips dirty; the stacks survive the clean transition", () => {
    let b = bufferFromContent("aa\nbb\n");
    b = {
      ...b,
      sels: [
        { anchor: { line: 0, col: 1 }, head: { line: 0, col: 1 } },
        { anchor: { line: 1, col: 1 }, head: { line: 1, col: 1 } },
      ],
      primary: 0,
    };
    b = insertText(b, "Z", t(0)); // one step, TWO edits
    expect(b.dirty).toBe(true);
    b = undo(b);
    expect(contentOf(b)).toBe("aa\nbb\n");
    expect(b.dirty).toBe(false);
    expect(b.redo).toHaveLength(1); // undo/redo stacks do NOT reset on the flip
    b = redo(b);
    expect(b.dirty).toBe(true);
  });

  it("back to the baseline by another route (paste then retype) is clean too", () => {
    let b = bufferFromContent("ab\ncd\n");
    b = insertText(selectAll(b), "ab\nc", t(0)); // paste lands short of the baseline
    expect(b.dirty).toBe(true);
    b = insertText(b, "d", t(10)); // retype the tail: caret rides the edit
    expect(contentOf(b)).toBe("ab\ncd\n");
    expect(b.dirty).toBe(false);
  });

  it("markSaved re-seeds: the baseline moves to the saved text, so the pre-save edit turns dirty again on undo", () => {
    let b = markSaved(insertText(bufferFromContent("x"), "y", t(0))); // save "yx"
    expect(b.dirty).toBe(false);
    b = undo(b); // "x" -- no longer the baseline
    expect(contentOf(b)).toBe("x");
    expect(b.dirty).toBe(true);
  });
});

// ── The cheap keyboard layer (TASK K): word geometry, word delete, quote
//    select, comment toggle, duplicate line. Bindings live in editor.tsx;
//    the app-level pins ride app.test.tsx.

describe("word-boundary geometry (the three-class VS Code-ish split)", () => {
  it("forward: identifier runs whole, gaps are crossed, EOL is its own stop", () => {
    expect(forwardWordCol("hello world", 0)).toBe(5); // end of "hello"
    expect(forwardWordCol("hello world", 5)).toBe(11); // gap + "world" -> EOL
    expect(forwardWordCol("hello world", 11)).toBe(11); // dead at EOL (the caller crosses)
    expect(forwardWordCol("hello  world", 5)).toBe(12); // multi-space gap
    expect(forwardWordCol("a  ", 1)).toBe(3); // gap to EOL, no phantom word
    expect(forwardWordCol("  x", 0)).toBe(3); // leading gap + word
    expect(forwardWordCol("", 0)).toBe(0);
    expect(forwardWordCol("a\tb", 1)).toBe(3); // a tab is whitespace
  });
  it("identifier = [letter|number|_], UNICODE: CJK is one run, digits stick", () => {
    expect(forwardWordCol("foo_bar9 x", 0)).toBe(8); // underscore + digits ride the run
    expect(forwardWordCol("你好 world", 0)).toBe(2); // 你好 = ONE identifier run
    expect(forwardWordCol("你好 world", 2)).toBe(8); // gap + "world"
    expect(backwardWordCol("你好世界", 4)).toBe(0); // the WHOLE CJK run is one word
    expect(backwardWordCol("你好 world", 8)).toBe(3); // back over "world", stop at the gap
  });
  it("punctuation is its own run and STOPS at whitespace and word chars", () => {
    expect(forwardWordCol("foo-bar", 0)).toBe(3); // word, stop at the '-'
    expect(forwardWordCol("foo-bar", 3)).toBe(4); // the '-' run alone
    expect(forwardWordCol("foo-bar", 4)).toBe(7); // "bar"
    expect(forwardWordCol("a ++ b", 2)).toBe(4); // "++" stops AT the spaces
    expect(forwardWordCol("a ++ b", 4)).toBe(6); // gap + "b"
    expect(backwardWordCol("foo - bar", 9)).toBe(6);
    expect(backwardWordCol("foo - bar", 6)).toBe(4); // the gap + '-' -> stop past it
    expect(backwardWordCol("foo - bar", 4)).toBe(0); // gap + "foo"
  });
  it("surrogate pairs read whole: boundaries never split an emoji", () => {
    const line = "a\u{1F600}b"; // a, pair (cols 1-2), b
    expect(forwardWordCol(line, 0)).toBe(1);
    expect(forwardWordCol(line, 1)).toBe(3); // the emoji punctuation run, whole
    expect(forwardWordCol(line, 3)).toBe(4);
    expect(backwardWordCol(line, 4)).toBe(3);
    expect(backwardWordCol(line, 3)).toBe(1); // back over the WHOLE pair
    expect(backwardWordCol(line, 1)).toBe(0);
  });
  it("moveWordHorizontal: the plain-arrow line wrap, the buffer edge is dead, shift extends", () => {
    let b = caretAt(bufferFromContent("abc\ndef"), 0, 3);
    b = moveWordHorizontal(b, 1, false); // EOL -> next line col 0
    expect(b.sels[b.primary]!.head).toEqual({ line: 1, col: 0 });
    b = moveWordHorizontal(b, -1, false); // col 0 -> previous line's end
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 3 });
    const deadBack = moveWordHorizontal(caretAt(b, 0, 0), -1, false);
    expect(deadBack.sels[deadBack.primary]!.head).toEqual({ line: 0, col: 0 }); // no move, no step
    const deadFwd = moveWordHorizontal(caretAt(bufferFromContent("abc"), 0, 3), 1, false); // EOL AND last line
    expect(deadFwd.sels[deadFwd.primary]!.head).toEqual({ line: 0, col: 3 });
    let e = caretAt(bufferFromContent("ab cd ef"), 0, 0);
    e = moveWordHorizontal(e, 1, true);
    expect(e.sels[e.primary]!.anchor).toEqual({ line: 0, col: 0 }); // anchor rides
    expect(e.sels[e.primary]!.head).toEqual({ line: 0, col: 2 });
  });
  it("a plain word-move collapses a multi-caret list to the primary (the arrow doctrine)", () => {
    let b = caretAt(bufferFromContent("aa bb\ncc dd"), 0, 0);
    b = {
      ...b,
      sels: [
        { anchor: { line: 0, col: 0 }, head: { line: 0, col: 0 } },
        { anchor: { line: 1, col: 3 }, head: { line: 1, col: 3 } },
      ],
      primary: 1,
    };
    b = moveWordHorizontal(b, 1, false);
    expect(b.sels).toHaveLength(1);
    expect(b.sels[0]!.head).toEqual({ line: 1, col: 5 });
  });
});

describe("word delete (alt+Backspace / alt+Delete)", () => {
  it("backward to the boundary; each press is ONE block step (no coalescing); undo back to baseline is CLEAN", () => {
    let b = caretAt(bufferFromContent("alpha beta gamma\n"), 0, 10);
    b = deleteWord(b, -1, 0);
    expect(contentOf(b)).toBe("alpha  gamma\n");
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 6 });
    expect(b.undo).toHaveLength(1);
    b = deleteWord(b, -1, 1); // gap + "alpha" go together (forward's mirror)
    expect(contentOf(b)).toBe(" gamma\n");
    expect(b.undo).toHaveLength(2); // one step PER PRESS, even inside COALESCE_MS
    expect(contentOf(undo(b))).toBe("alpha  gamma\n");
    const back = undo(undo(b));
    expect(contentOf(back)).toBe("alpha beta gamma\n");
    expect(back.dirty).toBe(false); // undo-to-baseline reads clean (derived)
  });
  it("forward deletes to the next boundary; EOL/col-0 eat the line break like Delete/backspace", () => {
    let b = caretAt(bufferFromContent("alpha beta\n"), 0, 0);
    expect(contentOf(deleteWord(b, 1, 0))).toBe(" beta\n");
    b = caretAt(bufferFromContent("ab\ncd\n"), 0, 2); // EOL: the join
    expect(contentOf(deleteWord(b, 1, 0))).toBe("abcd\n");
    b = caretAt(bufferFromContent("ab\ncd\n"), 1, 0); // col 0 back: the join
    expect(contentOf(deleteWord(b, -1, 0))).toBe("abcd\n");
  });
  it("dead at the buffer edges: identity, no step, no dirty", () => {
    const b = caretAt(bufferFromContent(""), 0, 0); // the ONE dead-in-both-places spot
    expect(deleteWord(b, -1, 0)).toBe(b);
    expect(deleteWord(b, 1, 0)).toBe(b);
    const firstChar = caretAt(bufferFromContent("x"), 0, 0);
    expect(deleteWord(firstChar, -1, 0)).toBe(firstChar); // doc start, backward
    const docEol = caretAt(bufferFromContent("x"), 0, 1);
    expect(deleteWord(docEol, 1, 0)).toBe(docEol); // doc end, forward
  });
  it("with any selection the selection goes instead (the plain-delete doctrine); zero-width carets survive", () => {
    let b = bufferFromContent("hello world");
    b = {
      ...b,
      sels: [
        { anchor: { line: 0, col: 0 }, head: { line: 0, col: 2 } },
        { anchor: { line: 0, col: 9 }, head: { line: 0, col: 9 } },
      ],
      primary: 0,
    };
    b = deleteWord(b, -1, 0);
    expect(contentOf(b)).toBe("llo world"); // the range went; the caret did not eat "o"
    expect(b.sels).toHaveLength(2);
  });
});

describe("select inside quotes (innermost pair, escape-aware)", () => {
  it("double / single / backtick pairs yield their content (quote chars excluded)", () => {
    expect(quoteContentRange('say "hello there"', 12)).toEqual({ from: 5, to: 16 });
    expect(quoteContentRange("let x = 'a b'", 9)).toEqual({ from: 9, to: 12 });
    expect(quoteContentRange("let `a b` = 1", 6)).toEqual({ from: 5, to: 8 });
  });
  it("escaped quotes never split a pair; an escaped backslash still lets the closer close", () => {
    expect(quoteContentRange("'it\\'s fine'", 6)).toEqual({ from: 1, to: 11 }); // the \\' is content, not the closer
    expect(quoteContentRange('"a\\\\"', 3)).toEqual({ from: 1, to: 4 }); // line "a\\" -- closer after \\
  });
  it("unpaired is honest: no span for an open quote, a caret on a quote char, or outside every pair", () => {
    expect(quoteContentRange('a "b|c', 4)).toBeUndefined(); // never closed
    expect(quoteContentRange('"ab"', 0)).toBeUndefined(); // ON the opening quote
    expect(quoteContentRange('"a" "b"', 2)).toBeUndefined(); // between two pairs
    expect(quoteContentRange("f(x) plain", 9)).toBeUndefined(); // no quotes at all
  });
  it("mixed quotes: the SMALLEST containing pair wins (the inner double, not the outer single)", () => {
    expect(quoteContentRange(`f('a "b" d')`, 6)).toEqual({ from: 6, to: 7 }); // inside the "..." only
    expect(quoteContentRange(`f('a "b" d')`, 3)).toEqual({ from: 3, to: 10 }); // inside the '...' only
  });
  it("selectInsideQuotes paints a range with NO undo step and NO dirty; no-op keeps identity", () => {
    let b = caretAt(bufferFromContent('say "hello there" ok'), 0, 12);
    b = selectInsideQuotes(b);
    expect(b.sels[b.primary]).toEqual({
      anchor: { line: 0, col: 5 },
      head: { line: 0, col: 16 },
    });
    expect(b.undo).toHaveLength(0);
    expect(b.dirty).toBe(false);
    const out = caretAt(bufferFromContent("no quotes here"), 0, 4);
    expect(selectInsideQuotes(out)).toBe(out);
  });
});

describe("line-comment toggle (Ctrl/Cmd+/)", () => {
  const at = (content: string, line: number, col: number) => caretAt(bufferFromContent(content), line, col);

  it("round-trip per lang family: //, #, --, % (token lands AFTER the indent, with one space)", () => {
    const block = (content: string): TextBuffer => {
      const b = bufferFromContent(content);
      return { ...b, sels: [{ anchor: { line: 0, col: 0 }, head: { line: 1, col: 2 } }], primary: 0 };
    };
    for (const [lang, token] of [
      ["typescript", "//"],
      ["python", "#"],
      ["lua", "--"],
      ["erlang", "%"],
    ] as const) {
      let b = toggleLineComment(block("  code\nmore\n"), lang, 1);
      expect(b.lines).toEqual([`  ${token} code`, `${token} more`]);
      expect(b.undo).toHaveLength(1); // ONE step for the whole block
      b = undo(b);
      expect(contentOf(b)).toBe("  code\nmore\n");
      expect(b.dirty).toBe(false); // undone-to-baseline is clean (derived)
      const u = toggleLineComment(block(`  ${token} code\n${token} more\n`), lang, 2);
      expect(u.lines).toEqual(["  code", "more"]); // uncomment eats the token + ONE space
    }
  });
  it("carets shift by what their line gained or lost (anchor and head), clamped at 0", () => {
    let b = at("  foo\n", 0, 2);
    b = toggleLineComment(b, "go", 1); // +3 on the line
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 5 });
    b = toggleLineComment(b, "go", 2); // uncomment: back
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 2 });
    expect(contentOf(b)).toBe("  foo\n");
    expect(b.dirty).toBe(false);
  });
  it("the PRIMARY selection's line block toggles; a caret inside a line targets just that line", () => {
    let b = bufferFromContent("a\nb\nc\n");
    b = { ...b, sels: [{ anchor: { line: 0, col: 1 }, head: { line: 1, col: 1 } }], primary: 0 };
    b = toggleLineComment(b, "rust", 1);
    expect(b.lines).toEqual(["// a", "// b", "c"]); // line 2 untouched
  });
  it("blank lines are never marked, an all-blank block is a dead key; whitespace-only content counts as blank", () => {
    let b = bufferFromContent("x\n\ny\n");
    b = { ...b, sels: [{ anchor: { line: 0, col: 0 }, head: { line: 2, col: 1 } }], primary: 0 };
    b = toggleLineComment(b, "yaml", 1);
    expect(b.lines).toEqual(["# x", "", "# y"]);
    const blank = at("\n   \n", 1, 1);
    expect(toggleLineComment(blank, "yaml", 2)).toBe(blank);
  });
  it("no line comment = honest no-op: json, block-only langs, unknown names, plain, no lang", () => {
    for (const lang of ["json", "css", "html", "xml", "markdown", "diff", "plain", "klingon", undefined]) {
      const b = at("x\n", 0, 0);
      expect(toggleLineComment(b, lang, 1)).toBe(b);
    }
  });
});

describe("duplicate line (Ctrl+Shift+D)", () => {
  it("dupes the caret's line below, caret lands on the copy, ONE undo step, clean back to baseline", () => {
    let b = caretAt(bufferFromContent("one\ntwo\n"), 0, 2);
    b = duplicateLine(b, 1);
    expect(b.lines).toEqual(["one", "one", "two"]);
    expect(b.sels[b.primary]!.head).toEqual({ line: 1, col: 2 }); // ON the copy
    expect(b.undo).toHaveLength(1);
    const back = undo(b);
    expect(contentOf(back)).toBe("one\ntwo\n");
    expect(back.dirty).toBe(false);
    expect(contentOf(redo(back))).toBe("one\none\ntwo\n");
  });
  it("a selection collapses to the caret; the endsNL fact survives; duplicating the last line is fine", () => {
    let b = bufferFromContent("solo"); // no trailing newline
    b = { ...b, sels: [{ anchor: { line: 0, col: 0 }, head: { line: 0, col: 4 } }], primary: 0 };
    b = duplicateLine(b, 1);
    expect(contentOf(b)).toBe("solo\nsolo"); // still no trailing NL (it is a fact, not a line)
    expect(b.sels[b.primary]).toEqual({ anchor: { line: 1, col: 4 }, head: { line: 1, col: 4 } });
  });
});

describe("Shift+Home / Shift+End (the already-shipped selection path, pinned)", () => {
  it("extend selects to the smart-Home stops and the line end; anchors ride", () => {
    let b = caretAt(bufferFromContent("    x"), 0, 5);
    b = smartHome(b, true); // press 1: back to first non-whitespace
    expect(b.sels[b.primary]!.anchor).toEqual({ line: 0, col: 5 });
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 4 });
    b = smartHome(b, true); // press 2: column 0 (full-line select)
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 0 });
    b = smartEnd(b, true); // Shift+End: out to the line end again
    expect(b.sels[b.primary]!.head).toEqual({ line: 0, col: 5 });
    expect(b.undo).toHaveLength(0); // selection moves never enter the history
    // A line with no indent: smart Home IS column 0 (the trivial case the
    // spec asks about -- no separate first-press rule was needed).
    const flat = smartHome(caretAt(bufferFromContent("x\n"), 0, 1), true);
    expect(flat.sels[flat.primary]!.head).toEqual({ line: 0, col: 0 });
  });
});

describe("HOT EXIT: bufferFromStash (preserved text over the disk baseline)", () => {
  it("differs from disk -> the stash reads dirty; re-serializing equal reads clean", () => {
    const b = bufferFromStash("kept\n", "disk\n");
    expect(contentOf(b)).toBe("kept\n"); // the buffer's bytes are the PRESERVED text
    expect(b.baseline).toBe("disk\n"); // ...but dirty derives against DISK
    expect(b.dirty).toBe(true);
    const same = bufferFromStash("x\n", "x\n");
    expect(same.dirty).toBe(false); // a stash that equals disk brings nothing back
    // endsNL is a real byte fact in the comparison, not decoration.
    const nl = bufferFromStash("x", "x\n");
    expect(nl.dirty).toBe(true);
    expect(contentOf(nl)).toBe("x");
    // The undo ladder of a RESTORED buffer reverts edits back onto the
    // preserved text and stays dirty against disk -- undo never "cleans" a
    // restore, and clean can only be earned by the bytes matching (above).
    let c = bufferFromStash("kept\n", "disk\n");
    c = typeChar(c, "!", 10);
    expect(contentOf(c)).toBe("!kept\n");
    c = undo(c);
    expect(contentOf(c)).toBe("kept\n"); // ONE step back onto the preserved text
    expect(c.dirty).toBe(true); // still unsaved: the disk baseline never moved
  });
});
