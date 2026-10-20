// EditorView end-to-end (§11 suites 3+4): raw byte chunks -> StdinBuffer ->
// EditorView, driven against the FakeClock and rendered into the in-memory
// Grid. Adversarial coverage that spans layers: multibyte split across chunks,
// combining clusters, CJK wrap row counts and straddle, emoji, the lone-ESC
// race, bracketed paste with CR/LF and lookalikes, 0x03 mid-buffer, Ctrl-D
// empty-vs-text, popup accept at mid-cursor, and history dedupe on submit.
//
// No process access anywhere (inverted-dependency law): the harness injects
// the ChunkSource, Clock, and Grid.

import { describe, it, expect } from "bun:test";
import { StdinBuffer } from "@utils/cli/renderer/stdin-buffer.ts";
import { EditorView, type EditorEvent } from "@utils/cli/renderer/editor-view.ts";
import { History } from "@utils/cli/renderer/history.ts";
import { FakeClock } from "@utils/cli/renderer/fake-clock.ts";
import { GridTerminal } from "@utils/cli/renderer/grid.ts";
import type { KeyChunk, KeySource } from "@utils/cli/renderer/seams.ts";

class ChunkSource implements KeySource {
  private subs = new Set<(chunk: KeyChunk) => void>();
  onData(cb: (chunk: KeyChunk) => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }
  push(chunk: KeyChunk): void {
    for (const cb of [...this.subs]) cb(chunk);
  }
}

function make(width = 40): {
  source: ChunkSource;
  clock: FakeClock;
  view: EditorView;
  events: EditorEvent[];
  feed: (s: string) => void;
  feedBytes: (b: Uint8Array, from?: number, to?: number) => void;
  submitTexts: () => string[];
  types: () => string[];
} {
  const clock = new FakeClock();
  const source = new ChunkSource();
  const stdin = new StdinBuffer(source, clock);
  const view = new EditorView({ history: new History(), width: () => width });
  view.setPrompt("(m)> ");
  const events: EditorEvent[] = [];
  view.onEvent((e) => events.push(e));
  view.attachStdin(stdin);
  return {
    source,
    clock,
    view,
    events,
    feed: (s) => source.push(s),
    feedBytes: (b, from = 0, to = b.length) => source.push(b.slice(from, to)),
    submitTexts: () => events.filter((e) => e.type === "submit").map((e) => (e as { text: string }).text),
    types: () => events.map((e) => e.type),
  };
}

describe("EditorView -- submit + interrupt + quit", () => {
  it("types, edits, and submits on Enter; buffer resets, history records", () => {
    const h = make();
    h.feed("hello");
    expect(h.view.text).toBe("hello");
    h.feed("\x7f"); // backspace kills the "o"
    h.feed("o world"); // re-type it plus more
    h.feed("\r");
    expect(h.submitTexts()).toEqual(["hello world"]);
    expect(h.view.text).toBe("");
    expect(h.view.history.list()).toEqual(["hello world"]);
  });

  it("LF (ctrl-j) submits too -- raw Enter is CR but LF submits per the map", () => {
    const h = make();
    h.feed("go\n");
    expect(h.submitTexts()).toEqual(["go"]);
  });

  it("0x03 mid-buffer: INTERRUPT emitted, text not submitted, survives to draft (§4)", () => {
    const h = make();
    h.feed("keep-this");
    h.feed("\x03");
    expect(h.types()).toContain("interrupt");
    expect(h.submitTexts()).toEqual([]); // never submitted
    expect(h.view.text).toBe(""); // blanked like today's handler
    // ...but recoverable (§4: stash-to-draft, not destructive): Down restores it
    h.feed("\x1b[B"); // down arrow at the empty buffer's only row
    expect(h.view.text).toBe("keep-this");
  });

  it("Ctrl-D on an EMPTY buffer emits QUIT (Decisions 2: the only key-exit)", () => {
    const h = make();
    h.feed("\x04");
    expect(h.types()).toContain("quit");
  });

  it("Ctrl-D with text deletes forward, never quits (§4/Decisions 2)", () => {
    const h = make();
    h.feed("abc");
    h.feed("\x1b[D"); // left once -> cursor before "c"
    h.feed("\x04"); // delete-forward the "c"
    expect(h.view.text).toBe("ab");
    expect(h.types()).not.toContain("quit");
  });

  it("Esc with no popup interrupts; Esc with popup open only closes it", () => {
    const h = make();
    h.feed("abc");
    h.source.push("\x1b"); // lone Esc: needs the timeout to decode
    h.clock.advance(10);
    expect(h.types()).toContain("interrupt");
    h.events.length = 0;
    h.feed("/mo");
    h.feed("\t"); // request popup
    h.view.openPopup([{ label: "/model" }, { label: "/models" }], 0);
    expect(h.view.popupOpen).toBe(true);
    h.events.length = 0;
    h.source.push("\x1b"); // Esc with popup open: close only
    h.clock.advance(10);
    expect(h.types()).toContain("popup"); // close, not interrupt
    expect(h.types()).not.toContain("interrupt");
    expect(h.view.popupOpen).toBe(false);
    expect(h.view.text).toBe("/mo"); // untouched by the dismiss
  });

  it("Ctrl-L emits redraw; Ctrl-X is UNHANDLED for 3b (dictation)", () => {
    const h = make();
    h.feed("x\x0c\x18"); // text x, Ctrl-L, Ctrl-X
    expect(h.types()).toContain("redraw");
    const unhandled = h.events.find((e) => e.type === "unhandled");
    expect(unhandled).toEqual({ type: "unhandled", key: "ctrl-x" });
  });
});

describe("EditorView -- multibyte / cluster / CJK through the byte pipe", () => {
  const enc = new TextEncoder();

  it("multibyte split across chunks lands whole in the buffer", () => {
    const h = make();
    const bytes = enc.encode("caf\u00e9"); // "café"
    h.feedBytes(bytes, 0, 4); // "caf"
    h.feedBytes(bytes, 4, 5); // é (2 bytes) arrives complete after split
    expect(h.view.text).toBe("caf\u00e9");
  });

  it("combining e+acute backspaces as one cluster, end-to-end", () => {
    const h = make();
    const bytes = enc.encode("e\u0301"); // 3 bytes
    h.feedBytes(bytes, 0, 2); // "e" + first mark byte
    h.feedBytes(bytes, 2); // rest of the mark
    expect(h.view.text).toBe("e\u0301");
    h.feed("\x7f"); // one backspace kills the whole cluster
    expect(h.view.text).toBe("");
  });

  it("emoji surrogate pair: one glyph, one backspace, correct cursor cells", () => {
    const h = make(40);
    h.feed("\u{1F600}"); // 😀
    expect(h.view.text).toBe("\u{1F600}");
    const v = h.view.view(40);
    expect(v.rows[0]).toBe("(m)> \u{1F600}");
    expect(v.cursorCol).toBe(7); // prompt(5) + emoji(2 cells)
    h.feed("\x7f");
    expect(h.view.text).toBe("");
  });

  it("CJK wrap at the straddle width: correct row count and cursor row", () => {
    const h = make(10);
    h.feed("\u4f60\u597d\u4e16\u754c"); // 4 wide = 8 cells
    const v = h.view.view(10);
    // "(m)> " (5) + 你好 (4) = 9; 世 needs 2 -> 11 > 10 wraps to row 1
    expect(v.rows).toEqual(["(m)> \u4f60\u597d", "\u4e16\u754c"]);
    expect(v.cursorRow).toBe(1);
    expect(v.totalRows).toBe(2);
  });
});

describe("EditorView -- the lone-ESC race end-to-end", () => {
  it("a fragmented arrow at <10ms never splits into Esc + text", () => {
    const h = make();
    h.feed("ab");
    h.source.push("\x1b");
    h.clock.advance(9);
    h.source.push("[A"); // up arrow, still inside the esc window
    // Two visual rows? no: single row buffer, up at the top edge -> history walk,
    // NOT an interrupt and NOT a stray 'a'/'[' text insert.
    expect(h.types()).not.toContain("interrupt");
    expect(h.view.text).toBe("ab"); // the escape bytes never leaked as text
  });

  it("a true Esc fires at 10ms without waiting the CSI hold", () => {
    const h = make();
    h.source.push("\x1b");
    h.clock.advance(10);
    expect(h.types()).toContain("interrupt");
  });
});

describe("EditorView -- bracketed paste through the whole stack", () => {
  it("pasted CR/LF do NOT submit; text lands with hard newlines in the buffer", () => {
    const h = make();
    h.feed("\x1b[200~one\r\ntwo\rthree\x1b[201~");
    expect(h.submitTexts()).toEqual([]); // no submit from any embedded newline
    expect(h.view.text).toBe("one\ntwo\nthree"); // CRLF and CR normalized to \n
    expect(h.view.view(80).totalRows).toBe(3); // three logical rows now
  });

  it("a paste lookalike terminator ends the paste; trailing bytes stay literal text", () => {
    const h = make();
    h.feed("\x1b[200~data\x1b[201~tail");
    expect(h.view.text).toBe("datatail"); // "data" pasted, then "tail" typed literally
  });

  it("0x03 INSIDE bracketed paste is literal paste content, never INTERRUPT", () => {
    const h = make();
    h.feed("\x1b[200~A\x03B\x1b[201~");
    expect(h.types()).not.toContain("interrupt");
    // the sanitizer drops the raw 0x03 control (not \n or \t); text survives
    expect(h.view.text).toBe("AB");
  });

  it("paste start delimiter split mid-sequence still frames a paste", () => {
    const h = make();
    h.source.push("\x1b[20");
    h.source.push("0~hi\x1b[201~");
    expect(h.view.text).toBe("hi");
    expect(h.types()).toContain("change");
  });
});

describe("EditorView -- history navigation with draft", () => {
  it("Up/Down walk history; the in-progress text is stashed and recoverable", () => {
    const h = make();
    h.feed("first\r");
    h.feed("second\r");
    h.feed("draft"); // in-progress, not submitted
    h.feed("\x1b[A"); // up -> second
    expect(h.view.text).toBe("second");
    h.feed("\x1b[A"); // up -> first
    expect(h.view.text).toBe("first");
    h.feed("\x1b[B"); // down -> second
    expect(h.view.text).toBe("second");
    h.feed("\x1b[B"); // down past newest -> draft restored
    expect(h.view.text).toBe("draft");
  });

  it("submitting a consecutive duplicate does not grow history", () => {
    const h = make();
    h.feed("same\r");
    h.feed("same\r");
    expect(h.view.history.list()).toEqual(["same"]);
  });

  it("editing after an Up breaks the walk cleanly (next Up continues the list)", () => {
    const h = make();
    h.feed("one\r");
    h.feed("two\r");
    h.feed("\x1b[A"); // two
    h.feed("x"); // edit -> "twox"
    expect(h.view.text).toBe("twox");
    h.feed("\x1b[A"); // up -> one (walk resumes from the stored position)
    expect(h.view.text).toBe("one");
  });
});

describe("EditorView -- completion popup lifecycle", () => {
  it("Tab requests, provider opens, filter narrows, Enter accepts at mid-cursor", () => {
    const h = make();
    h.feed("run /mo here");
    // cursor is at end (after "here"); move back into "/mo" region is not the
    // popup's job -- instead open a fresh span the way the bridge does:
    h.view.setText("echo /mo 2"); // cursor at end
    // position the cursor right after "/mo":
    h.feed("\x1b[D\x1b[D"); // left left -> before " 2"? cursor after "/mo"
    const reqBefore = h.events.filter((e) => e.type === "popup").length;
    h.feed("\t");
    const req = h.events.slice(reqBefore).find((e) => e.type === "popup" && e.phase === "request");
    expect(req).toBeDefined();
    // The bridge resolves providers and opens at the requested span:
    h.view.openPopup([{ label: "/model", insert: "/model " }, { label: "/mount" }], 5);
    expect(h.view.popupOpen).toBe(true);
    h.events.length = 0;
    h.feed("\r"); // Enter accepts (popup open)
    expect(h.view.popupOpen).toBe(false);
    const acc = h.events.find((e) => e.type === "popup" && e.phase === "accept");
    expect(acc).toBeDefined();
    // accept replaces the [from, cursor) span and does NOT submit
    expect(h.submitTexts()).toEqual([]);
    expect(h.view.text).toContain("/model");
  });

  it("Tab cycles, Shift-Tab back-cycles, Up/Down cycle while open (history frozen)", () => {
    const h = make();
    h.feed("ab\r"); // a history entry exists
    h.feed("/mo");
    h.view.openPopup([{ label: "/model" }, { label: "/models" }, { label: "/mount" }], 0);
    expect(h.view.popup.selectedIndex).toBe(0);
    h.feed("\t");
    expect(h.view.popup.selectedIndex).toBe(1);
    h.feed("\x1b[Z"); // shift-tab
    expect(h.view.popup.selectedIndex).toBe(0);
    h.feed("\x1b[A"); // up cycles backward (wrap to last)
    expect(h.view.popup.selectedIndex).toBe(2);
    expect(h.view.text).toBe("/mo"); // history never touched while popup open
  });

  it("typing into the span filters; zero matches auto-closes (reason no-match)", () => {
    const h = make();
    h.feed("/mo");
    h.view.openPopup([{ label: "/model" }, { label: "/mount" }], 0);
    h.feed("x"); // "/mox" matches nothing
    expect(h.view.popupOpen).toBe(false);
    const close = [...h.events].reverse().find(
      (e) => e.type === "popup" && e.phase === "close",
    );
    expect(close).toEqual({ type: "popup", phase: "close", reason: "no-match" });
    expect(h.view.text).toBe("/mox");
  });

  it("zero-match provider response never opens; Enter stays SUBMIT (no phantom popup)", () => {
    const h = make();
    h.feed("/zz\t"); // Tab requests; bridge answers with off-topic candidates
    h.events.length = 0;
    h.view.openPopup([{ label: "/alpha" }, { label: "/beta" }], 1); // none match "zz"
    expect(h.view.popupOpen).toBe(false);
    expect(h.types()).toEqual([]); // no open, no close: a refused open is silent
    h.feed("\r");
    expect(h.submitTexts()).toEqual(["/zz"]); // Enter is Enter again, first press
  });

  it("open event reports matchCount; a zero-match re-open closes the open popup", () => {
    const h = make();
    h.feed("/mo");
    h.view.openPopup([{ label: "/model" }, { label: "/moose" }, { label: "/mount" }], 0);
    const open = [...h.events].reverse().find(
      (e) => e.type === "popup" && e.phase === "open",
    );
    expect(open).toEqual({ type: "popup", phase: "open", count: 3 }); // all match "/mo"
    h.events.length = 0;
    h.view.openPopup([{ label: "/alpha" }], 0); // late provider junk
    expect(h.view.popupOpen).toBe(false);
    const close = [...h.events].reverse().find(
      (e) => e.type === "popup" && e.phase === "close",
    );
    expect(close).toEqual({ type: "popup", phase: "close", reason: "no-match" });
  });
});

describe("EditorView -- grid harness (frame composer contract)", () => {
  it("renders the wrapped editor block + projects the cursor cell into a Grid", () => {
    const grid = new GridTerminal({ rows: 6, cols: 10 });
    const clock = new FakeClock();
    const src = new ChunkSource();
    const sb = new StdinBuffer(src, clock);
    const view = new EditorView({ history: new History(), width: () => grid.columns });
    view.setPrompt("(m)> ");
    view.attachStdin(sb);
    src.push("hello\u4f60\u597d"); // "(m)> hello" fills row 0 exactly; CJK wraps
    const block = view.view(10);
    for (const row of block.rows) grid.write(row + "\r\n");
    const snap = grid.grid.snapshot();
    expect(snap.screen[0]).toBe("(m)> hello");
    expect(snap.screen[1]).toBe("\u4f60\u597d");
    expect(block.cursorRow).toBe(1);
    expect(block.cursorCol).toBe(4);
  });

  it("windowed view keeps the cursor inside maxRows past the bottom edge", () => {
    const clock = new FakeClock();
    const src = new ChunkSource();
    const sb = new StdinBuffer(src, clock);
    const view = new EditorView({ history: new History(), width: () => 10 });
    view.setPrompt("");
    view.attachStdin(sb);
    src.push("x".repeat(35)); // 4 rows of 10 at width 10 (35 -> rows 10,10,10,5)
    const v = view.view(10, 2); // show at most 2 rows
    expect(v.totalRows).toBe(4);
    expect(v.rows.length).toBe(2);
    expect(v.cursorRow).toBe(1); // last row shown and cursor visible
    expect(v.top).toBe(2);
  });
});
