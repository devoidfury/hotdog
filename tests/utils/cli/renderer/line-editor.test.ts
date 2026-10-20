// LineEditor (§4): grapheme-cluster motion, CJK/emoji cursor math, wrapped
// view row counts and windowing, kill ops. Exotica uses explicit escapes --
// literal combining marks in source are invisible landmines.

import { describe, it, expect } from "bun:test";
import { LineEditor } from "@utils/cli/renderer/line-editor.ts";

describe("LineEditor -- cluster-safe insertion and deletion", () => {
  it("combining sequence inserts and backspaces as ONE cluster", () => {
    const ed = new LineEditor();
    ed.insert("e\u0301"); // e + combining acute
    expect(ed.buffer).toBe("e\u0301");
    expect(ed.cursorOffset).toBe(2);
    ed.insert("x");
    expect(ed.backspace()).toBe(true); // removes x
    expect(ed.buffer).toBe("e\u0301");
    expect(ed.backspace()).toBe(true); // removes the WHOLE cluster, not just the mark
    expect(ed.buffer).toBe("");
    expect(ed.backspace()).toBe(false); // start of buffer
  });

  it("left cannot stop inside a combining sequence", () => {
    const ed = new LineEditor();
    ed.insert("a\u0301b"); // [a+acute][b]
    ed.moveLeft(); // over b
    expect(ed.cursorOffset).toBe(2); // boundary between [a+acute] and [b]
    ed.moveLeft(); // over the whole a+acute cluster -- never stops at 1, mid-cluster
    expect(ed.cursorOffset).toBe(0);
    ed.moveRight();
    expect(ed.cursorOffset).toBe(2);
    ed.moveRight();
    expect(ed.cursorOffset).toBe(3);
  });

  it("deleteForward removes a whole cluster under the cursor", () => {
    const ed = new LineEditor();
    ed.insert("e\u0301x");
    ed.moveToStart();
    expect(ed.deleteForward()).toBe(true);
    expect(ed.buffer).toBe("x");
    expect(ed.deleteForward()).toBe(true);
    expect(ed.deleteForward()).toBe(false); // at end
  });

  it("surrogate-pair emoji moves and deletes as one unit", () => {
    const ed = new LineEditor();
    ed.insert("a😀b"); // a + emoji (2 UTF-16 units) + b
    expect(ed.buffer.length).toBe(4);
    ed.moveToEnd(); // cursor 4
    expect(ed.moveLeft()).toBe(true);
    expect(ed.cursorOffset).toBe(3); // before b (never inside the pair)
    expect(ed.moveLeft()).toBe(true);
    expect(ed.cursorOffset).toBe(1); // before the emoji, jumped whole pair -- never 2
    // backspace deletes the cluster BEFORE the cursor: "a"
    expect(ed.backspace()).toBe(true);
    expect(ed.buffer).toBe("😀b");
    expect(ed.cursorOffset).toBe(0);
    // forward-delete the emoji: whole pair dies at once
    expect(ed.deleteForward()).toBe(true);
    expect(ed.buffer).toBe("b");
  });

  it("insert with replace span rewrites [from, cursor) (popup accept path)", () => {
    const ed = new LineEditor();
    ed.insert("ab cd xy");
    ed.moveToEnd();
    ed.moveLeft();
    ed.moveLeft(); // cursor before "xy" (offset 6)
    ed.insert("z", 6); // replace [6, cursor=6) -- pure insert at cursor
    expect(ed.buffer).toBe("ab cd zxy");
    // Now replace the word "zxy": from = word start (6), cursor = buffer end (9).
    ed.backwardWord(); // cursor -> start of "zxy" (6)
    const wordFrom = ed.cursorOffset;
    ed.moveToEnd(); // cursor -> 9; span [6,9) covers "zxy"
    ed.insert("done", wordFrom); // replace [6, 9) with "done"
    expect(ed.buffer).toBe("ab cd done");
  });
});

describe("LineEditor -- word motion and kills", () => {
  it("alt-b/alt-f stop at word edges (readline semantics)", () => {
    const ed = new LineEditor();
    ed.insert("hello brave world");
    ed.moveToEnd();
    ed.backwardWord();
    expect(ed.cursorOffset).toBe(12); // start of "world"
    ed.backwardWord();
    expect(ed.cursorOffset).toBe(6); // start of "brave"
    ed.backwardWord();
    expect(ed.cursorOffset).toBe(0);
    ed.forwardWord();
    expect(ed.cursorOffset).toBe(5); // end of "hello"
    ed.forwardWord();
    expect(ed.cursorOffset).toBe(11);
    ed.forwardWord();
    expect(ed.cursorOffset).toBe(17); // end
  });

  it("CJK counts as word content", () => {
    const ed = new LineEditor();
    ed.insert("say 你好 now");
    ed.moveToEnd();
    ed.backwardWord();
    expect(ed.cursorOffset).toBe(7); // start of "now"
    ed.backwardWord();
    expect(ed.cursorOffset).toBe(4); // start of 你好
  });

  it("ctrl-W kills whitespace plus the preceding word", () => {
    const ed = new LineEditor();
    ed.insert("rm -rf  tmp ");
    const killed = ed.killWordBackward(); // trailing whitespace + the word (documented map choice)
    expect(killed).toBe("tmp ");
    expect(ed.buffer).toBe("rm -rf  ");
  });

  it("ctrl-K kills to end of logical line; on a newline it eats the newline", () => {
    const ed = new LineEditor();
    ed.insert("head tail");
    ed.moveToStart();
    ed.forwardWord();
    ed.forwardWord();
    expect(ed.killLine()).toBe(""); // already at end
    ed.moveToStart();
    expect(ed.killLine()).toBe("head tail");
    expect(ed.buffer).toBe("");
    ed.insert("ab\ncd");
    ed.moveToStart();
    expect(ed.killLine()).toBe("ab\n"); // newline included (readline at EOL)
    expect(ed.buffer).toBe("cd");
  });

  it("ctrl-U kills to start of the LOGICAL line, not past the newline", () => {
    const ed = new LineEditor();
    ed.insert("ab\ncd");
    ed.moveToEnd();
    expect(ed.killToStart()).toBe("cd");
    expect(ed.buffer).toBe("ab\n");
  });

  it("ctrl-Delete kills whitespace plus the following word, stopping at a newline", () => {
    const ed = new LineEditor();
    ed.insert("one  two\nthree");
    ed.moveToStart();
    expect(ed.killWordForward()).toBe("one  two");
    expect(ed.buffer).toBe("\nthree");
  });
});

describe("LineEditor -- prompt participation", () => {
  it("prompt renders on row 0 and the cursor measures past it", () => {
    const ed = new LineEditor();
    ed.setPrompt("(model)> ");
    ed.insert("hi");
    const layout = ed.layout(40);
    expect(layout.rows).toEqual(["(model)> hi"]);
    expect(layout.cursorRow).toBe(0);
    expect(layout.cursorCol).toBe(11); // 9-cell prompt + 2 chars
    ed.moveToStart();
    expect(ed.cursorOffset).toBe(0); // buffer coords: prompt is untouchable
    expect(ed.layout(40).cursorCol).toBe(9); // the cursor cannot enter the prompt
  });

  it("prompt retarget re-wraps the view (MODEL_CHANGE)", () => {
    const ed = new LineEditor();
    ed.setPrompt("(a) ");
    ed.insert("x");
    expect(ed.layout(40).rows).toEqual(["(a) x"]);
    ed.setPrompt("(a-long-model-name) ");
    expect(ed.layout(40).rows).toEqual(["(a-long-model-name) x"]);
    expect(ed.buffer).toBe("x");
  });

  it("newlines in a prompt are stripped, never wrap-broken", () => {
    const ed = new LineEditor();
    ed.setPrompt("a\r\nb\nc");
    expect(ed.promptText).toBe("abc");
  });
});

describe("LineEditor -- wrapped view (CJK math, windowing)", () => {
  it("double-wide glyph that would straddle the edge moves whole to the next row", () => {
    const ed = new LineEditor();
    ed.insert("abc\u4f60"); // abc + 你 (wide)
    const narrow = ed.layout(4);
    expect(narrow.rows).toEqual(["abc", "\u4f60"]); // 3 + 2 > 4: never split 你
    expect(narrow.cursorRow).toBe(1);
    expect(narrow.cursorCol).toBe(2); // pending-wrap at end of the row it fills
    const fits = ed.layout(5);
    expect(fits.rows).toEqual(["abc\u4f60"]); // 3 + 2 == 5 fits exactly
    expect(fits.cursorCol).toBe(5); // pending-wrap cell at the row edge
  });

  it("wrap row counts with prompt + CJK + emoji corpus", () => {
    const ed = new LineEditor();
    ed.setPrompt("(m)> "); // 5 cells
    ed.insert("\u4f60\u597d\u4e16\u754c"); // 4 wide CJK = 8 cells
    const layout = ed.layout(10);
    // row0: (m)> + 你好 (5+4=9, 世 needs 2 -> 11 > 10 wraps)
    expect(layout.rows).toEqual(["(m)> \u4f60\u597d", "\u4e16\u754c"]);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorCol).toBe(4);
    expect(ed.view(10).totalRows).toBe(2);
  });

  it("hard newlines create rows even when empty", () => {
    const ed = new LineEditor();
    ed.setPrompt("$ ");
    ed.insert("a\n\nb");
    expect(ed.layout(20).rows).toEqual(["$ a", "", "b"]);
  });

  it("windowing keeps the cursor visible past both viewport edges", () => {
    const ed = new LineEditor();
    ed.insert("x".repeat(23)); // rows of 10 at width 10: 3 rows
    let v = ed.view(10, 2);
    expect(v.totalRows).toBe(3);
    expect(v.rows.length).toBe(2);
    expect(v.top).toBe(1); // cursor on the last row: window slid down
    expect(v.cursorRow).toBe(1); // and visible
    ed.moveToStart();
    v = ed.view(10, 2);
    expect(v.top).toBe(0);
    expect(v.cursorRow).toBe(0); // visible at the top edge
    ed.moveToEnd();
    v = ed.view(10, 2);
    expect(v.top).toBe(1);
    expect(v.cursorRow).toBe(1);
  });

  it("visual up/down moves across wrapped rows with a remembered column", () => {
    const ed = new LineEditor();
    ed.insert("0123456789ab"); // width 10: row0 10 cells, row1 "ab"
    ed.moveToStart();
    for (let i = 0; i < 8; i++) ed.moveRight(); // cursor col 8 on row 0
    expect(ed.layout(10).cursorRow).toBe(0);
    const r = ed.moveVisual(1, 10); // down
    expect(r).toBe("moved");
    const layout = ed.layout(10);
    expect(layout.cursorRow).toBe(1);
    expect(layout.cursorCol).toBe(2); // row1 is short: lands at its end (best effort)
    expect(ed.moveVisual(1, 10)).toBe("edge-bottom");
    expect(ed.moveVisual(-1, 10)).toBe("moved");
    expect(ed.layout(10).cursorRow).toBe(0);
    expect(ed.layout(10).cursorCol).toBe(8); // remembered column restored
    expect(ed.moveVisual(-1, 10)).toBe("edge-top");
  });
});

// ── auditor regression: moveVisual coordinate/render fixes (stage 3a audit) ──

describe("LineEditor -- visual moves: prompt coords and render row invariants (audit)", () => {
  it("visual up/down use BUFFER coords with a non-empty prompt (no prompt leak)", () => {
    const ed = new LineEditor();
    ed.setPrompt("(m)> "); // 5 cells
    ed.insert("ab\ncd");
    ed.moveToEnd(); // row 1, after "cd"
    expect(ed.layout(40).cursorRow).toBe(1);
    expect(ed.moveVisual(-1, 40)).toBe("moved"); // col 2 is inside the prompt: clamps to buffer start
    expect(ed.cursorOffset).toBe(0); // NOT 5 (combined coord) and never past the buffer
    expect(ed.layout(40).cursorRow).toBe(0);
  });

  it("down from a wrapped row's edge advances even when the next row starts double-wide", () => {
    const ed = new LineEditor();
    ed.insert("a\u65e5b\u672c\u8a9e\u3061"); // width 2: rows a | \u65e5 | b | \u672c | \u8a9e | \u3061
    ed.moveToStart();
    for (let i = 0; i < 3; i++) ed.moveRight(); // cursor before \u672c: renders pending at row 2's edge
    const l0 = ed.layout(2);
    expect(l0.cursorRow).toBe(2);
    expect(ed.moveVisual(1, 2)).toBe("moved");
    const l1 = ed.layout(2);
    expect(l1.cursorRow).toBe(3); // used to stall: the tie landed on the same offset
    const before = ed.cursorOffset;
    expect(ed.moveVisual(-1, 2)).toBe("moved");
    expect(ed.layout(2).cursorRow).toBe(2);
    expect(ed.moveVisual(1, 2)).toBe("moved");
    expect(ed.cursorOffset).toBe(before); // round trip stable
  });

  it("a prompt wider than the viewport: up lands at buffer start, then reports edge-top", () => {
    const ed = new LineEditor();
    ed.setPrompt("(deepseek-v4) > "); // 16 cells > width 10
    ed.insert("hello");
    const l0 = ed.layout(10);
    expect(l0.cursorRow).toBeGreaterThan(1); // the prompt wraps; text starts below row 0
    expect(ed.moveVisual(-1, 10)).toBe("moved"); // first up: buffer start (row below the prompt)
    expect(ed.cursorOffset).toBe(0);
    expect(ed.moveVisual(-1, 10)).toBe("edge-top"); // row 0 is pure prompt: history gets its turn
    expect(ed.cursorOffset).toBe(0); // cursor untouched by the edge report
  });

  it("down->up round-trips every offset across prompt x width x corpus combinations", () => {
    const prompts = ["", "> ", "(m)> ", "(deepseek-v4) > "];
    const texts = ["0123456789ab", "ab\ncd", "a\u65e5b\u672c\u8a9e\u3061", "one two three four five"];
    for (const p of prompts) for (const t of texts) for (const w of [2, 3, 4, 6, 10, 40]) {
      const probe = new LineEditor();
      probe.insert(t);
      let steps = 0;
      probe.moveToStart();
      while (probe.moveRight()) steps++;
      for (let s = 0; s <= steps; s++) {
        const ed = new LineEditor();
        ed.setPrompt(p);
        ed.insert(t);
        ed.moveToStart();
        for (let i = 0; i < s; i++) ed.moveRight();
        const c0 = ed.cursorOffset;
        const r0 = ed.layout(w);
        if (ed.moveVisual(1, w) === "moved") {
          const l1 = ed.layout(w);
          expect(l1.cursorRow).toBe(r0.cursorRow + 1);
          expect(ed.cursorOffset).toBeGreaterThanOrEqual(0);
          expect(ed.cursorOffset).toBeLessThanOrEqual(t.length);
          expect(ed.moveVisual(-1, w)).toBe("moved");
          expect(ed.cursorOffset).toBe(c0);
        }
      }
    }
  });
});
