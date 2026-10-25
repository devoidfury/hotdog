// Fuzz suite for StdinBuffer's split-renderer input path (§5): the SSE-style
// differential between one-feed decoding and arbitrary byte-chunk feeding.
//
// Owner-visible stakes: a wedged parser or phantom event lands directly on
// the dogfooding split-mode user. Invariants audited on every generated
// stream:
//   I1 no phantom events / no swallowed content: the decoded event sequence
//      equals the generator's reference expectation (each atom declares the
//      events its bytes MUST produce, written from the module contract).
//   I2 split equivalence: byte-at-a-time, random, adversarial, and UTF-16
//      string chunking all decode identically to a one-feed -- both
//      immediately after the feed (timers never fire) and after the clock
//      passes ESC_KEY_MS + SEQ_HOLD_MS. droppedBytes/droppedSequences match
//      across arms too.
//   I3 an incomplete escape at feed end is HELD (no ESC+junk), and resolves
//      per the documented timer policy afterwards.
//   I4 control shapes: CR=enter, LF=ctrl-j, BS=ctrl-h, TAB=tab,
//      0x03=interrupt, 0x04=eof, 0x7f=backspace -- pinned via an explicit
//      table cross-checked against controlName.
//
// Paste-envelope rule AS IMPLEMENTED (pinned, see also the module header):
// a FORGED FULL ESC[201~ inside pasted bytes terminates the paste (in-band
// framing cannot express otherwise); a forged full ESC[200~ is literal
// content; a partial terminator prefix is HELD and flushes into the paste as
// text after SEQ_HOLD_MS. The remainder past a forged terminator continues
// as normal input, and a stray real ESC[201~ outside paste is dropped.
//
// Text batching is a legitimate chunking artifact (a run split across feeds
// yields split text events), so all comparisons pass through the same
// merge-adjacent-text normalization on both reference and arm sides.

import { describe, it, expect } from "bun:test";
import {
  StdinBuffer,
  controlName,
  ESC_KEY_MS,
  SEQ_HOLD_MS,
} from "@utils/cli/renderer/stdin-buffer.ts";
import type { KeyEvent } from "@utils/cli/renderer/keyevents.ts";
import type { KeyChunk, KeySource } from "@utils/cli/renderer/seams.ts";
import { FakeClock } from "@utils/cli/renderer/fake-clock.ts";
import { makeRng, randomChunks, randomChunksBytes, type Rng } from "../../../fuzz/prng.ts";

const ENC = new TextEncoder();
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

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

// ── Control contract (§4), written out explicitly and cross-checked ──

const CTRL_NAMES: Record<number, string> = {
  0x00: "ctrl-space",
  0x01: "ctrl-a", 0x02: "ctrl-b", 0x03: "interrupt", 0x04: "eof",
  0x05: "ctrl-e", 0x06: "ctrl-f", 0x07: "ctrl-g", 0x08: "ctrl-h",
  0x09: "tab", 0x0a: "ctrl-j", 0x0b: "ctrl-k", 0x0c: "ctrl-l",
  0x0d: "enter", 0x0e: "ctrl-n", 0x0f: "ctrl-o", 0x10: "ctrl-p",
  0x11: "ctrl-q", 0x12: "ctrl-r", 0x13: "ctrl-s", 0x14: "ctrl-t",
  0x15: "ctrl-u", 0x16: "ctrl-v", 0x17: "ctrl-w", 0x18: "ctrl-x",
  0x19: "ctrl-y", 0x1a: "ctrl-z",
  0x1c: "ctrl-\\", 0x1d: "ctrl-]", 0x1e: "ctrl-^", 0x1f: "ctrl-_",
  0x7f: "backspace",
};

// ── Event normalization ─────────────────────────────────────────────

const fmt = (e: KeyEvent): string =>
  e.kind === "text" ? `text:${e.text}` : e.kind === "paste" ? `paste:${e.text}` : `key:${e.name}`;

/** Merge adjacent text events: legit batching artifact of chunked feeding. */
function normalize(events: readonly KeyEvent[]): string[] {
  const out: string[] = [];
  for (const e of events) {
    if (e.kind === "text" && out.length > 0 && out[out.length - 1]!.startsWith("text:")) {
      out[out.length - 1] = out[out.length - 1]! + e.text;
    } else {
      out.push(fmt(e));
    }
  }
  return out;
}

// ── Atom model: each atom declares (bytes, events, post-timer events) ──

interface Atom {
  bytes: Uint8Array;
  events: KeyEvent[]; // expected immediately after the full stream is fed
  afterTimer?: KeyEvent[]; // additional events once ESC/SEQ timers fire
  terminalOnly?: boolean; // leaves held state in the buffer; must end the stream
}

const atomText = (s: string): Atom => ({ bytes: ENC.encode(s), events: [{ kind: "text", text: s }] });
const atomKey = (s: string, name: string): Atom => ({ bytes: ENC.encode(s), events: [{ kind: "key", name }] });
const atomDrop = (s: string): Atom => ({ bytes: ENC.encode(s), events: [] }); // complete-but-unmapped: dropped

const CSI_ATOMS: [string, string][] = [
  ["\x1b[A", "up"], ["\x1b[B", "down"], ["\x1b[C", "right"], ["\x1b[D", "left"],
  ["\x1b[H", "home"], ["\x1b[F", "end"],
  ["\x1b[1~", "home"], ["\x1b[4~", "end"], ["\x1b[3~", "delete"], ["\x1b[2~", "insert"],
  ["\x1b[5~", "pageup"], ["\x1b[6~", "pagedown"],
  ["\x1b[Z", "shift-tab"],
  ["\x1b[1;5D", "ctrl-left"], ["\x1b[1;5C", "ctrl-right"], ["\x1b[1;3A", "alt-up"],
  ["\x1b[1;2C", "shift-right"], ["\x1b[3;5~", "ctrl-delete"],
];
const SS3_ATOMS: [string, string][] = [
  ["\x1bOA", "up"], ["\x1bOb", "down"], ["\x1bOc", "right"], ["\x1bOd", "left"],
  ["\x1bOH", "home"], ["\x1bOf", "end"],
];
const ALT_ATOMS: [string, string][] = [
  ["\x1bb", "alt-b"], ["\x1bB", "alt-B"], ["\x1b ", "alt-space"],
  ["\x1b\x7f", "alt-backspace"], ["\x1b\x01", "alt-ctrl-a"],
];

const UNI_TEXTS = [
  "\u00e9\u00fc\u00f1",
  "\u{1f600}",
  "\u4e2d\u6587",
  "\u{1f468}\u200d\u{1f469}\u200d\u{1f467}", // ZWJ family arrives as text
  "\u05e9\u05b8\u05dc\u05d5\u05dd", // Hebrew + vowel mark
  "\u0645\u0631\u062d\u0628\u0627", // Arabic
  "\u{1f1fa}\u{1f1f8}", // regional-indicator flag pair
  "\u2764\ufe0f", // heart + VS16
  "\u{1f44d}\u{1f3fd}", // skin-tone modifier
  "\u200d\u200c", // ZWJ/ZWNJ as content
  "\uff71\uff9f", // halfwidth katakana
  "\u0301", // lone combining acute
  "\u{1d400}", // astral Latin math bold A
];

// Printable ASCII run (0x20..0x7e); ESC is 0x1b, out of range by construction.
function printableRun(rng: Rng, min = 1, max = 12): string {
  const n = min + rng.int(max - min + 1);
  let s = "";
  for (let i = 0; i < n; i++) s += String.fromCharCode(0x20 + rng.int(0x5f));
  return s;
}

// Paste bodies: printable/unicode text, literal control bytes (CR, LF, 0x03
// stay LITERAL inside the frame), and forged start/partial-terminator
// lookalikes. Assembled body is rejected if it accidentally spells a
// complete ESC[201~ (that case gets its own dedicated atom below).
const PASTE_LITERALS = ["\r", "\n", "\x03", "\x00", "\x7f", "\x08"];
const PASTE_LOOKALIKES = ["\x1b", "\x1b[", "\x1b[2", "\x1b[20", "\x1b[201", "\x1b[200~", "\x1bO"];

function pasteBody(rng: Rng): string {
  for (let attempt = 0; attempt < 12; attempt++) {
    let body = "";
    const parts = 1 + rng.int(5);
    for (let i = 0; i < parts; i++) {
      const roll = rng.float();
      if (roll < 0.45) body += printableRun(rng, 1, 8);
      else if (roll < 0.65) body += rng.pick(UNI_TEXTS);
      else if (roll < 0.8) body += rng.pick(PASTE_LITERALS);
      else body += rng.pick(PASTE_LOOKALIKES);
    }
    if (!body.includes(PASTE_END)) return body;
  }
  return printableRun(rng, 4, 16); // fallback: provably clean
}

function genAtom(rng: Rng): Atom {
  const roll = rng.int(100);
  if (roll < 25) return atomText(printableRun(rng));
  if (roll < 33) return atomText(rng.pick(UNI_TEXTS));
  if (roll < 48) { const [s, n] = rng.pick(CSI_ATOMS); return atomKey(s, n); }
  if (roll < 53) { const [s, n] = rng.pick(SS3_ATOMS); return atomKey(s, n); }
  if (roll < 58) { const [s, n] = rng.pick(ALT_ATOMS); return atomKey(s, n); }
  if (roll < 66) {
    const b = rng.pick(Object.keys(CTRL_NAMES).map(Number));
    return { bytes: new Uint8Array([b]), events: [{ kind: "key", name: CTRL_NAMES[b]! }] };
  }
  if (roll < 82) {
    // clean bracketed paste: ONE event, body incl. lookalikes is literal
    const body = pasteBody(rng);
    return {
      bytes: ENC.encode(PASTE_START + body + PASTE_END),
      events: [{ kind: "paste", text: body }],
    };
  }
  if (roll < 87) {
    // FORGED full terminator inside the paste (the pinned in-band limit):
    // paste closes at the forgery, printable suffix continues as text,
    // the real trailing terminator falls outside the frame and is dropped.
    const prefix = printableRun(rng, 1, 6);
    const suffix = printableRun(rng, 1, 6);
    return {
      bytes: ENC.encode(PASTE_START + prefix + PASTE_END + suffix + PASTE_END),
      events: [
        { kind: "paste", text: prefix },
        { kind: "text", text: suffix },
      ],
    };
  }
  if (roll < 90) return atomDrop(PASTE_END); // stray end outside paste: dropped
  if (roll < 93) return atomDrop("\x1b[15~"); // unmapped complete CSI: dropped
  if (roll < 95) return atomDrop("\x1bOq"); // unmapped SS3 final: dropped
  if (roll < 98) {
    // control byte mid-CSI: sequence bytes up to it drop; the control itself
    // reprocesses as its own key (documented drop policy #3)
    const b = rng.pick([0x07, 0x03, 0x0d, 0x09]);
    return {
      bytes: new Uint8Array([0x1b, 0x5b, 0x30, b]),
      events: [{ kind: "key", name: CTRL_NAMES[b]! }],
    };
  }
  // undecodable bytes drop as U+FFFD; a trailing printable survives as text
  return { bytes: new Uint8Array([0xff, 0xfe, 0x41]), events: [{ kind: "text", text: "A" }] };
}

// Terminal atoms leave held state (esc state, CSI hold, paste mode); they may
// only ever be the last atom of a stream, per the class contract.
function genTerminalAtom(rng: Rng): Atom {
  switch (rng.int(6)) {
    case 0: // lone ESC: HELD now, decodes as Esc after ESC_KEY_MS
      return { bytes: ENC.encode("\x1b"), events: [], afterTimer: [{ kind: "key", name: "esc" }], terminalOnly: true };
    case 1: // ESC ESC: first emits Esc immediately, second re-enters esc state
      return { bytes: ENC.encode("\x1b\x1b"), events: [{ kind: "key", name: "esc" }], afterTimer: [{ kind: "key", name: "esc" }], terminalOnly: true };
    case 2: // incomplete CSI at feed end: held, then dropped at SEQ_HOLD_MS
      return { bytes: ENC.encode("\x1b[1;"), events: [], terminalOnly: true };
    case 3: // bare CSI prefix: held, then dropped
      return { bytes: ENC.encode("\x1b["), events: [], terminalOnly: true };
    case 4: // partial paste-start delimiter: held, then dropped
      return { bytes: ENC.encode("\x1b[200"), events: [], terminalOnly: true };
    default: // unterminated paste: content accumulates, no event ever fires
      return { bytes: ENC.encode(PASTE_START + printableRun(rng, 1, 10)), events: [], terminalOnly: true };
  }
}

interface Stream {
  bytes: Uint8Array;
  expected: string[]; // normalized events after full feed
  afterTimer: string[]; // normalized events once timers drain
}

function genStream(rng: Rng): Stream {
  const atoms: Atom[] = [];
  const count = 1 + rng.int(9);
  for (let i = 0; i < count; i++) atoms.push(genAtom(rng));
  if (rng.bool(0.35)) atoms.push(genTerminalAtom(rng));

  const expected: KeyEvent[] = [];
  const after: KeyEvent[] = [];
  let bytes = new Uint8Array(0);
  for (const a of atoms) {
    const merged = new Uint8Array(bytes.length + a.bytes.length);
    merged.set(bytes, 0);
    merged.set(a.bytes, bytes.length);
    bytes = merged;
    for (const e of a.events) {
      const last = expected[expected.length - 1];
      if (last && last.kind === "text" && e.kind === "text") last.text += e.text;
      else expected.push({ ...e });
    }
    for (const e of a.afterTimer ?? []) after.push(e);
  }
  return { bytes, expected: normalize(expected), afterTimer: normalize([...expected, ...after]) };
}

// ── Drive arms ──────────────────────────────────────────────────────

interface ArmResult {
  before: string[];
  after: string[];
  drops: string;
  dropped: number;
}

function drive(chunks: KeyChunk[]): ArmResult {
  const clock = new FakeClock();
  const source = new ChunkSource();
  const stdin = new StdinBuffer(source, clock);
  const events: KeyEvent[] = [];
  const off = stdin.subscribe((e) => events.push(e));
  for (const c of chunks) source.push(c);
  const before = normalize(events);
  clock.advance(SEQ_HOLD_MS + ESC_KEY_MS + 1);
  const after = normalize(events);
  const drops = stdin.droppedSequences.join(" | ");
  const dropped = stdin.droppedBytes;
  off();
  return { before, after, drops, dropped };
}

const hex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function armsFor(rng: Rng, bytes: Uint8Array): [string, KeyChunk[]][] {
  const dec = new TextDecoder("utf-8", { fatal: false });
  const str = dec.decode(bytes);
  const oneByOne: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i++) oneByOne.push(bytes.subarray(i, i + 1));
  return [
    ["one-feed", [bytes]],
    ["byte-at-a-time", oneByOne],
    ["bytes-random", randomChunksBytes(rng, bytes, 1 + rng.int(5))],
    ["bytes-adversarial", randomChunksBytes(rng, bytes, 8, "adversarial")],
    ["string-random", randomChunks(rng, str, 4)],
    ["string-adversarial", randomChunks(rng, str, 6, "adversarial")],
  ];
}

// ── Fuzz ────────────────────────────────────────────────────────────

describe("StdinBuffer split-feed fuzz", () => {
  const SEED = 0x7d01_1c0d;
  const ITERATIONS = 300;

  it("chunked feeds decode identically to one-feed with zero phantom/swallowed events", () => {
    const rng = makeRng(SEED);
    const failures: { iter: number; stream: string; arm: string; got: string[]; want: string[] }[] = [];
    const dropMismatch: { iter: number; stream: string; seen: string[] }[] = [];

    for (let i = 0; i < ITERATIONS; i++) {
      const stream = genStream(rng);
      const arms = armsFor(rng, stream.bytes);
      const dropSets = new Set<string>();
      for (const [name, chunks] of arms) {
        const r = drive(chunks);
        if (JSON.stringify(r.before) !== JSON.stringify(stream.expected)) {
          failures.push({ iter: i, stream: hex(stream.bytes), arm: `${name}:feed`, got: r.before, want: stream.expected });
        }
        if (JSON.stringify(r.after) !== JSON.stringify(stream.afterTimer)) {
          failures.push({ iter: i, stream: hex(stream.bytes), arm: `${name}:timers`, got: r.after, want: stream.afterTimer });
        }
        dropSets.add(`${r.dropped}\x00${r.drops}`);
        if (failures.length >= 3) break;
      }
      if (dropSets.size > 1) dropMismatch.push({ iter: i, stream: hex(stream.bytes), seen: [...dropSets] });
      if (failures.length >= 3 || dropMismatch.length >= 3) break;
    }

    expect(failures).toEqual([]);
    expect(dropMismatch).toEqual([]);
  });

  it("reconstructed event text equals the stream's plain-text content in every arm", () => {
    const rng = makeRng(0x5eed_0a7e);
    const failures: { iter: number; stream: string; arm: string; got: string; want: string }[] = [];

    for (let i = 0; i < 200; i++) {
      const stream = genStream(rng);
      // Reference plain text: everything the atoms declare as text/paste.
      const want = stream.expected
        .filter((e) => e.startsWith("text:") || e.startsWith("paste:"))
        .map((e) => e.slice(e.indexOf(":") + 1))
        .join("");
      for (const [name, chunks] of armsFor(rng, stream.bytes)) {
        const r = drive(chunks);
        const got = r.after
          .filter((e) => e.startsWith("text:") || e.startsWith("paste:"))
          .map((e) => e.slice(e.indexOf(":") + 1))
          .join("");
        if (got !== want) failures.push({ iter: i, stream: hex(stream.bytes), arm: name, got, want });
        if (failures.length >= 3) break;
      }
      if (failures.length >= 3) break;
    }

    expect(failures).toEqual([]);
  });

  it("controlName matches the explicit §4 contract table", () => {
    for (const [b, name] of Object.entries(CTRL_NAMES)) {
      expect(controlName(Number(b))).toBe(name);
    }
    // 0x1b is ESC proper, never routed through controlName by the parser;
    // 0x20+ is a printable/batch text, its controlName spelling is "del".
    expect(controlName(0x21)).toBe("del");
  });
});

// ── Targeted pins for the split path (non-fuzz regressions) ────────

function harness() {
  const clock = new FakeClock();
  const source = new ChunkSource();
  const stdin = new StdinBuffer(source, clock);
  const events: KeyEvent[] = [];
  const off = stdin.subscribe((e) => events.push(e));
  return { clock, source, stdin, events, off };
}

describe("StdinBuffer split-feed pins", () => {
  it("incomplete CSI at feed end is HELD: no ESC+junk, dropped only at SEQ_HOLD_MS", () => {
    const h = harness();
    h.source.push("ab\x1b[1;");
    expect(h.events).toEqual([{ kind: "text", text: "ab" }]); // nothing invented
    h.clock.advance(SEQ_HOLD_MS - 1);
    expect(h.events.length).toBe(1);
    h.clock.advance(1);
    expect(h.events.length).toBe(1); // bytes dropped, still no phantom key
    expect(h.stdin.droppedSequences).toEqual(["\x1b[1;"]);
  });

  it("lone ESC is held, emits Esc exactly at ESC_KEY_MS, never before", () => {
    const h = harness();
    h.source.push("\x1b");
    h.clock.advance(ESC_KEY_MS - 1);
    expect(h.events).toEqual([]);
    h.clock.advance(1);
    expect(h.events).toEqual([{ kind: "key", name: "esc" }]);
  });

  it("lone ESC then a non-CSI byte resolves as the alt form, no Esc key", () => {
    const h = harness();
    h.source.push("\x1b");
    h.source.push("x");
    expect(h.events).toEqual([{ kind: "key", name: "alt-x" }]);
    h.clock.advance(ESC_KEY_MS + SEQ_HOLD_MS);
    expect(h.events.length).toBe(1); // nothing extra when timers would have fired
  });

  it("ESC at 9ms then [A completes as an arrow: fragmented arrow never becomes Esc+junk", () => {
    const h = harness();
    h.source.push("\x1b");
    h.clock.advance(ESC_KEY_MS - 1);
    h.source.push("[A");
    expect(h.events).toEqual([{ kind: "key", name: "up" }]);
  });

  it("CR is enter, LF is ctrl-j, BS is ctrl-h, TAB is tab, Ctrl-C is interrupt, Ctrl-D is eof", () => {
    const h = harness();
    h.source.push("\r\n\x08\t\x03\x04");
    expect(h.events).toEqual([
      { kind: "key", name: "enter" },
      { kind: "key", name: "ctrl-j" },
      { kind: "key", name: "ctrl-h" },
      { kind: "key", name: "tab" },
      { kind: "key", name: "interrupt" },
      { kind: "key", name: "eof" },
    ]);
  });

  it("forged FULL paste terminator closes the paste (pinned in-band limit); stray tail terminator drops", () => {
    const h = harness();
    h.source.push(`${PASTE_START}A${PASTE_END}B${PASTE_END}`);
    expect(h.events).toEqual([
      { kind: "paste", text: "A" },
      { kind: "text", text: "B" },
    ]);
    expect(h.stdin.droppedSequences).toEqual([PASTE_END]);
  });

  it("forged full paste START inside a body is literal content", () => {
    const h = harness();
    h.source.push(`${PASTE_START}x${PASTE_START}y${PASTE_END}`);
    expect(h.events).toEqual([{ kind: "paste", text: `x${PASTE_START}y` }]);
  });

  it("partial terminator held inside a paste flushes as literal text after SEQ_HOLD_MS", () => {
    const h = harness();
    h.source.push(`${PASTE_START}tail\x1b[20`);
    h.clock.advance(SEQ_HOLD_MS); // hold window elapses: really paste content
    h.source.push(`--more${PASTE_END}`);
    expect(h.events).toEqual([{ kind: "paste", text: `tail\x1b[20--more` }]);
  });

  it("CR, LF, 0x03 inside a paste frame stay literal; 0x03 outside is interrupt", () => {
    const h = harness();
    h.source.push(`${PASTE_START}l1\r\nl2\x03end${PASTE_END}\x03`);
    expect(h.events).toEqual([
      { kind: "paste", text: "l1\r\nl2\x03end" },
      { kind: "key", name: "interrupt" },
    ]);
  });

  it("mid-codepoint byte split never corrupts and never emits per-byte phantom runs", () => {
    const h = harness();
    const bytes = ENC.encode("\u{1f600}\u4e2d");
    for (let i = 0; i < bytes.length; i++) h.source.push(bytes.subarray(i, i + 1));
    const text = h.events.filter((e) => e.kind === "text").map((e) => (e as { text: string }).text).join("");
    expect(text).toBe("\u{1f600}\u4e2d");
    expect(h.events.every((e) => e.kind === "text"));
  });
});
