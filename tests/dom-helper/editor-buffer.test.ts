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
  backspace,
  bufferFromContent,
  colForX,
  confirmDiscard,
  contentOf,
  dedentChars,
  dedentLines,
  deleteForward,
  docEnd,
  hitPos,
  indentTab,
  insertText,
  markSaved,
  pressEnter,
  redo,
  selectAll,
  selectWordAt,
  setCaret,
  smartHome,
  undo,
  visualCol,
  colAtVisual,
  wordRange,
  xForCol,
  type EditorSession,
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
