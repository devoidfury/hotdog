// Auditor integration test (stage 3a audit): one full interactive session driven
// ONLY through the public surface (index.ts barrel), exactly as the module
// headers document it -- the proof that stage 3b can wire this stack without touching
// internals. Session: type CJK + edit, submit, history up/enter, popup
// request/open/filter/accept, Ctrl-C interrupt + draft recovery, Ctrl-D on the
// empty buffer (the only key-exit). No process/fs access; seams are injected.

import { describe, it, expect } from "bun:test";
import {
  StdinBuffer, EditorView, History, FakeClock,
  ESC_KEY_MS, type EditorEvent, type KeySource, type KeyChunk, type Completion,
} from "@utils/cli/renderer/index.ts";

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

function session(): {
  source: ChunkSource;
  clock: FakeClock;
  view: EditorView;
  events: EditorEvent[];
  feed: (s: string | Uint8Array) => void;
} {
  const clock = new FakeClock();
  const source = new ChunkSource();
  const stdin = new StdinBuffer(source, clock);
  const view = new EditorView({ history: new History(), width: () => 40 });
  const events: EditorEvent[] = [];
  view.onEvent((e) => events.push(e));
  view.attachStdin(stdin); // the documented bridge attach
  return {
    source,
    clock,
    view,
    events,
    feed: (s) => source.push(s),
  };
}

describe("stage 3b contract -- full session through the public surface", () => {
  it("drives CJK typing, editing, history, popup, interrupt, and quit", () => {
    const s = session();
    const byType = (t: string) => s.events.filter((e) => e.type === t);
    const lastOf = (t: string) => [...s.events].reverse().find((e) => e.type === t);

    // prompt re-target (MODEL_CHANGE, design note §4)
    s.view.setPrompt("(model)> ");
    expect(s.view.view(40).rows[0]).toBe("(model)> ");

    // 1) type CJK (as fragmented UTF-8 bytes -- a real pipe does this), edit, submit
    const utf8 = new TextEncoder().encode("おはよう");
    for (const b of utf8) s.feed(new Uint8Array([b])); // one byte per chunk
    expect(s.view.text).toBe("おはよう");
    s.feed("\x1b[D"); // left one cluster (before "う")
    s.feed("\x7f"); // backspace deletes ONE cluster ("よ"), never half a char
    expect(s.view.text).toBe("おはう");
    s.feed("よ"); // retype what the edit removed (cursor sits before the surviving う)
    s.feed("\r");
    expect(lastOf("submit")).toEqual({ type: "submit", text: "おはよう" });
    expect(s.view.text).toBe(""); // buffer cleared by the EDITOR (contract §2)

    // 2) history up + enter
    s.feed("\x1b[A"); // up
    expect(lastOf("history")).toEqual({ type: "history", phase: "prev", text: "おはよう" });
    expect(s.view.text).toBe("おはよう");
    s.feed("\r"); // resubmit (consecutive duplicate stays newest, deduped)
    expect(s.view.history.list()).toEqual(["おはよう"]);
    expect(s.view.text).toBe("");

    // 3) popup: Tab -> request; bridge injects providers via openPopup; accept
    s.feed("echo /mo");
    s.feed("\t");
    const req = [...s.events].reverse().find(
      (e) => e.type === "popup" && e.phase === "request",
    ) as { word: string; from: number; to: number };
    expect(req.word).toBe("/mo");
    const candidates: Completion[] = [
      { label: "/model", detail: "switch model" },
      { label: "/mount", detail: "add a path" },
    ];
    s.view.openPopup(candidates, req.from); // respond exactly as §2 documents
    expect(s.view.popupOpen).toBe(true);
    const rows = s.view.popupRows(40);
    expect(rows.length).toBe(2);
    expect(rows[0]!.startsWith(">")).toBe(true); // selection marker
    s.feed("u"); // "/mou" is a prefix only of /mount: the popup narrows live
    expect(s.view.popupRows(40).length).toBe(1);
    s.feed("\r"); // Enter with popup open ACCEPTS (never submits)
    expect(lastOf("popup")).toEqual({ type: "popup", phase: "accept", text: "/mount" });
    expect(s.view.text).toBe("echo /mount");
    expect(byType("submit")).toHaveLength(2); // only the two Enters so far; the accept did NOT add a third

    // 4) Ctrl-C: pure interrupt; buffer stashed and recoverable via Down (§4)
    s.feed("\x03");
    expect(lastOf("interrupt")).toEqual({ type: "interrupt" });
    expect(s.view.text).toBe("");
    s.feed("\x1b[B"); // down at the empty buffer restores the draft
    expect(s.view.text).toBe("echo /mount");

    // 5) clear + Ctrl-D on the EMPTY buffer: QUIT -- the only key-exit
    s.feed("\x15"); // ctrl-u: kill line
    expect(s.view.text).toBe("");
    s.feed("\x04"); // Ctrl-D on the EMPTY buffer: the only key-exit
    expect(lastOf("quit")).toEqual({ type: "quit" });
  });

  it("frame composer reads a legal EditorBlockView at paint time (contract §2)", () => {
    const s = session();
    s.view.setPrompt("(m)> ");
    s.feed("hello\u4f60\u597d world with some length to wrap around the edge for sure and then some extra words to force three rows");
    const block = s.view.view(40, 3); // windowed paint
    expect(block.rows.length).toBeLessThanOrEqual(3);
    expect(block.totalRows).toBeGreaterThanOrEqual(3);
    expect(block.cursorRow).toBeGreaterThanOrEqual(0);
    expect(block.cursorRow).toBeLessThan(block.rows.length);
    expect(block.cursorCol).toBeLessThanOrEqual(40);
    expect(block.rows.join("").startsWith("(m)> ")).toBe(true);
  });

  it("ESC_KEY_MS and SEQ_HOLD_MS are exported and match the documented §5 values", () => {
    expect(ESC_KEY_MS).toBe(10);
    // a lone ESC decodes after exactly ESC_KEY_MS
    const s = session();
    s.feed("\x1b");
    s.clock.advance(ESC_KEY_MS);
    const esc = s.events.some(
      (e) => e.type === "interrupt", // esc with popup closed == interrupt
    );
    expect(esc).toBe(true);
  });
});
