// StdinBuffer (§5, §11 suite 3): raw chunk replays against MemoryKeySource-style
// feeds and the FakeClock -- UTF-8 fragmentation, the lone-ESC vs CSI-prefix
// race (10ms/50ms), bracketed paste framing with delimiter splits and
// lookalikes, control decoding (0x03 INTERRUPT, 0x04 EOF, the §4 ctrl set),
// and the documented drop policy. Exotica uses explicit \x escapes.

import { describe, it, expect } from "bun:test";
import { StdinBuffer, ESC_KEY_MS, SEQ_HOLD_MS } from "@utils/cli/renderer/stdin-buffer.ts";
import type { KeyEvent } from "@utils/cli/renderer/keyevents.ts";
import type { Clock, KeyChunk, KeySource } from "@utils/cli/renderer/seams.ts";
import { FakeClock } from "@utils/cli/renderer/fake-clock.ts";

/** KeyChunk-native scripted source: the stage-3 sibling of MemoryKeySource. */
class ChunkSource implements KeySource {
  private subs = new Set<(chunk: KeyChunk) => void>();
  onData(cb: (chunk: KeyChunk) => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }
  push(chunk: KeyChunk): void {
    for (const cb of [...this.subs]) cb(chunk);
  }
  get listenerCount(): number {
    return this.subs.size;
  }
}

function harness(): {
  clock: FakeClock;
  source: ChunkSource;
  out: () => string[];
  dropped: () => readonly string[];
  off: () => void;
} {
  const clock = new FakeClock();
  const source = new ChunkSource();
  const stdin = new StdinBuffer(source, clock);
  const events: KeyEvent[] = [];
  const off = stdin.subscribe((e) => events.push(e));
  const fmt = (e: KeyEvent): string =>
    e.kind === "text" ? `text:${e.text}` : e.kind === "paste" ? `paste:${e.text}` : `key:${e.name}`;
  return {
    clock,
    source,
    out: () => events.map(fmt),
    dropped: () => stdin.droppedSequences,
    off,
  };
}

describe("StdinBuffer -- plain decoding", () => {
  it("batches printable runs into single text events", () => {
    const h = harness();
    h.source.push("hello");
    h.source.push(" world");
    expect(h.out()).toEqual(["text:hello", "text: world"]);
  });

  it("decodes the §4 control set: ctrl-a/e/w/u/k/l/y, tab, enter, backspace", () => {
    const h = harness();
    h.source.push("\x01\x05\x17\x15\x0b\x19\x0c\t\r\x7f");
    expect(h.out()).toEqual([
      "key:ctrl-a", "key:ctrl-e", "key:ctrl-w", "key:ctrl-u", "key:ctrl-k",
      "key:ctrl-y", "key:ctrl-l", "key:tab", "key:enter", "key:backspace",
    ]);
  });

  it("LF is ctrl-j (raw-mode Enter is CR; the editor submits on both)", () => {
    const h = harness();
    h.source.push("\n");
    expect(h.out()).toEqual(["key:ctrl-j"]);
  });

  it("0x03 is a pure INTERRUPT key event, text around it survives", () => {
    const h = harness();
    h.source.push("ab\x03cd");
    expect(h.out()).toEqual(["text:ab", "key:interrupt", "text:cd"]);
  });

  it("0x04 is the EOF key event -- no quit semantics in the buffer", () => {
    const h = harness();
    h.source.push("x\x04");
    expect(h.out()).toEqual(["text:x", "key:eof"]);
  });

  it("NUL is ctrl-space; ctrl-_ (0x1f) decodes too", () => {
    const h = harness();
    h.source.push("\x00\x1f");
    expect(h.out()).toEqual(["key:ctrl-space", "key:ctrl-_"]);
  });
});

describe("StdinBuffer -- UTF-8 across chunk boundaries", () => {
  const enc = new TextEncoder();

  it("emoji split mid-sequence reassembles; text before it flushes early", () => {
    const h = harness();
    const bytes = enc.encode("a😀日b"); // 1 + 4 + 3 + 1 bytes
    h.source.push(bytes.slice(0, 1)); // "a"
    h.source.push(bytes.slice(1, 3)); // F0 9F -- half an emoji
    expect(h.out()).toEqual(["text:a"]); // nothing invented for the pending tail
    h.source.push(bytes.slice(3)); // 98 80, 日, b
    expect(h.out()).toEqual(["text:a", "text:😀日b"]);
  });

  it("combining sequence split across chunks arrives intact", () => {
    const h = harness();
    const bytes = enc.encode("e\u0301"); // e + combining acute (U+0301: CC 81)
    h.source.push(bytes.slice(0, 2)); // "e" + first byte of the mark
    h.source.push(bytes.slice(2));
    expect(h.out()).toEqual(["text:e", "text:\u0301"]);
  });

  it("undecodable bytes drop as U+FFFD and never reach the editor", () => {
    const h = harness();
    h.source.push(new Uint8Array([0xff, 0xfe, 0x41]));
    expect(h.out()).toEqual(["text:A"]);
  });
});

describe("StdinBuffer -- escape decoding", () => {
  it("CSI arrows, SS3 arrows, home/end, delete/insert/pgup/pgdn", () => {
    const h = harness();
    h.source.push("\x1b[A\x1b[B\x1b[C\x1b[D\x1b[H\x1b[F\x1b[3~\x1b[2~\x1b[5~\x1b[6~");
    expect(h.out()).toEqual([
      "key:up", "key:down", "key:right", "key:left",
      "key:home", "key:end", "key:delete", "key:insert", "key:pageup", "key:pagedown",
    ]);
  });

  it("application-mode SS3 and the xterm 1~/4~ home/end variants", () => {
    const h = harness();
    h.source.push("\x1bOA\x1bOD\x1bOH\x1b[1~\x1b[4~");
    expect(h.out()).toEqual(["key:up", "key:left", "key:home", "key:home", "key:end"]);
  });

  it("modifier params compose ctrl-/alt-/shift- prefixes", () => {
    const h = harness();
    h.source.push("\x1b[1;5D\x1b[1;5C\x1b[1;3A\x1b[Z\x1b[3;5~");
    expect(h.out()).toEqual([
      "key:ctrl-left", "key:ctrl-right", "key:alt-up", "key:shift-tab", "key:ctrl-delete",
    ]);
  });

  it("meta form: ESC b is alt-b (no timer wait when the byte rides along)", () => {
    const h = harness();
    h.source.push("\x1bb\x1bf");
    expect(h.out()).toEqual(["key:alt-b", "key:alt-f"]);
  });

  it("ESC Ctrl-? is alt-backspace; ESC space is alt-space", () => {
    const h = harness();
    h.source.push("\x1b\x7f\x1b ");
    expect(h.out()).toEqual(["key:alt-backspace", "key:alt-space"]);
  });
});

describe("StdinBuffer -- the ESC race (§5 timers)", () => {
  it("a lone ESC decodes as Esc exactly at ESC_KEY_MS", () => {
    const h = harness();
    h.source.push("\x1b");
    h.clock.advance(ESC_KEY_MS - 1);
    expect(h.out()).toEqual([]); // still waiting: a CSI may follow
    h.clock.advance(1);
    expect(h.out()).toEqual(["key:esc"]);
  });

  it("ESC at 9ms then [A completes as an arrow -- no spurious Esc (fragmented arrow)", () => {
    const h = harness();
    h.source.push("\x1b");
    h.clock.advance(ESC_KEY_MS - 1);
    h.source.push("[A");
    expect(h.out()).toEqual(["key:up"]);
    expect(h.clock.pendingCount).toBe(0); // the esc timer was CANCELED, not leaked
  });

  it("ESC then a byte at 9ms is the alt form", () => {
    const h = harness();
    h.source.push("\x1b");
    h.clock.advance(ESC_KEY_MS - 1);
    h.source.push("b");
    expect(h.out()).toEqual(["key:alt-b"]);
  });

  it("ESC ESC emits Esc for the first byte and re-arms for the second", () => {
    const h = harness();
    h.source.push("\x1b\x1b");
    expect(h.out()).toEqual(["key:esc"]);
    h.clock.advance(ESC_KEY_MS);
    expect(h.out()).toEqual(["key:esc", "key:esc"]);
  });

  it("CSI split like pi's documented fragmentation case reassembles under the hold", () => {
    const h = harness();
    h.source.push("\x1b[1;");
    h.clock.advance(30);
    h.source.push("5D"); // ctrl-left, split mid-parameter
    expect(h.out()).toEqual(["key:ctrl-left"]);
  });

  it("incomplete CSI at SEQ_HOLD_MS is dropped, never half-decoded", () => {
    const h = harness();
    h.source.push("\x1b[1;");
    h.clock.advance(SEQ_HOLD_MS - 1);
    expect(h.out()).toEqual([]);
    h.clock.advance(1);
    expect(h.out()).toEqual([]);
    expect(h.dropped()).toEqual(["\x1b[1;"]);
  });

  it("control byte inside a CSI drops the sequence; the control itself survives", () => {
    const h = harness();
    h.source.push("\x1b[0\x07x"); // BEL interrupts the CSI: drop ESC[0, keep ctrl-g
    expect(h.out()).toEqual(["key:ctrl-g", "text:x"]);
    expect(h.dropped()).toEqual(["\x1b[0"]);
  });

  it("unmapped complete sequences (F5, stray paste-end) drop silently", () => {
    const h = harness();
    h.source.push("\x1b[15~\x1b[201~");
    expect(h.out()).toEqual([]);
    expect(h.dropped()).toEqual(["\x1b[15~", "\x1b[201~"]);
  });
});

describe("StdinBuffer -- bracketed paste framing", () => {
  it("paste frames as ONE event; CR, LF and 0x03 inside are literal text", () => {
    const h = harness();
    h.source.push("\x1b[200~line1\rline2\x03tail\x1b[201~");
    expect(h.out()).toEqual(["paste:line1\rline2\x03tail"]);
  });

  it("paste start and end delimiters split mid-sequence across chunks", () => {
    const h = harness();
    h.source.push("\x1b[20"); // partial start delimiter: held
    h.source.push("0~multi\r\nline\x1b[201"); // partial end delimiter: held
    expect(h.out()).toEqual([]); // nothing emitted until the paste closes
    h.source.push("~");
    expect(h.out()).toEqual(["paste:multi\r\nline"]);
  });

  it("paste body may span many chunks; keys after it decode normally", () => {
    const h = harness();
    h.source.push("\x1b[200~one");
    h.source.push(" two\r\n");
    h.source.push("three\x1b[201~");
    h.source.push("\x1b[A");
    expect(h.out()).toEqual(["paste:one two\r\nthree", "key:up"]);
  });

  it("a lookalike terminator inside pasted bytes ends the paste there (in-band limit)", () => {
    const h = harness();
    h.source.push("\x1b[200~A\x1b[201~B\x1b[201~");
    expect(h.out()).toEqual(["paste:A", "text:B"]);
    expect(h.dropped()).toEqual(["\x1b[201~"]); // stray tail delimiter dropped
  });

  it("a held partial delimiter that never completes flushes into the paste as text", () => {
    const h = harness();
    h.source.push("\x1b[200~tail\x1b[20"); // looks like a terminator prefix
    h.clock.advance(SEQ_HOLD_MS); // hold window: it was really paste content
    h.source.push("--more\x1b[201~");
    expect(h.out()).toEqual(["paste:tail\x1b[20--more"]);
  });

  it("empty paste surfaces as an empty paste event (editor ignores it)", () => {
    const h = harness();
    h.source.push("\x1b[200~\x1b[201~");
    expect(h.out()).toEqual(["paste:"]);
  });
});

describe("StdinBuffer -- subscription discipline", () => {
  it("the last unsubscribe releases the KeySource listener and discards state", () => {
    const h = harness();
    expect(h.source.listenerCount).toBe(1);
    h.source.push("\x1b[1;"); // in-flight partial sequence
    h.off();
    expect(h.source.listenerCount).toBe(0);
    h.source.push("5D"); // would have completed ctrl-left
    expect(h.out()).toEqual([]);
    expect(h.clock.pendingCount).toBe(0); // timers cleared on release
  });

  it("push with no subscriber is inert", () => {
    const clock: Clock = new FakeClock();
    const source = new ChunkSource();
    new StdinBuffer(source, clock); // subscribes to nothing; chunks are dropped unread
    expect(() => source.push("hello\x1b")).not.toThrow();
  });

  it("release resets the incremental decoder (3b suspend/resume safety)", () => {
    const clock = new FakeClock();
    const source = new ChunkSource();
    const stdin = new StdinBuffer(source, clock);
    const first = stdin.subscribe(() => {});
    source.push(new Uint8Array([0xe3])); // "あ" split mid-sequence; lead byte sits in the decoder
    first(); // release must discard decoder state, not hand it to the next session
    const events: KeyEvent[] = [];
    stdin.subscribe((e) => events.push(e));
    source.push("hi");
    source.push(new Uint8Array([0x81, 0x82])); // abandoned continuation: undecodable, U+FFFD-dropped
    expect(events).toEqual([{ kind: "text", text: "hi" }]); // no phantom "あ"
  });
});
