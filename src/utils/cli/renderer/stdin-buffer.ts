// StdinBuffer (design note §5): raw stdin chunks -> decoded KeyEvents.
// Sits between the KeySource seam and the editor; the only code that turns
// input bytes into text. Responsibilities:
//
// - UTF-8 reassembly across chunk boundaries (incremental TextDecoder; a
//   multi-byte sequence split mid-sequence never corrupts);
// - escape-sequence state machine with the §5 timers: a lone ESC decodes as
//   Esc after ESC_KEY_MS (10ms), an incomplete CSI/SS3 prefix holds its bytes
//   for SEQ_HOLD_MS (50ms). A fragmented arrow key never decodes into
//   Esc+junk, and a true Esc never waits 50ms;
// - bracketed paste framing: ESC[200~ ... ESC[201~ surfaces as ONE paste
//   event carrying the raw text (CR/LF/0x03 inside the frame are literal);
// - 0x03 outside paste framing is the INTERRUPT key (Decisions 2: Ctrl-C is
//   a pure interrupt, no quit semantics, no arm window); 0x04 is the EOF key
//   (the editor decides empty-buffer-quit).
//
// Documented drop policy (never throws, never emits a garbage key):
// 1. Incomplete CSI/SS3 when SEQ_HOLD_MS elapses -> bytes dropped.
// 2. A complete sequence with no mapping (F5, stray ESC[201~ outside paste,
//    unknown finals) -> dropped.
// 3. A control byte inside a CSI body -> bytes up to it dropped; the control
//    byte itself reprocesses as a key (ESC Ctrl-G stays a Ctrl-G).
// 4. U+FFFD (undecodable bytes, flushed split tails) -> dropped.
// Every drop increments droppedBytes; droppedLog (capped) keeps the bytes for
// tests and diagnostics.
//
// Paste lookalikes: the paste body is scanned for the FIRST ESC[201~; a
// lookalike inside pasted bytes terminates the paste there (in-band framing
// cannot express otherwise -- real terminals have the same limit). The
// remainder continues as normal input. A held partial delimiter (e.g. a chunk
// ending "...\x1b[20") waits SEQ_HOLD_MS, then becomes literal paste text.
//
// Unsubscribing the last event listener releases the KeySource listener and
// discards any in-flight partial state -- teardown-safe (pitfall 6: stopping
// input means letting go of listeners, never pausing).

import type { Clock, KeyChunk, KeySource } from "./seams.ts";
import type { KeyEvent, KeyName } from "./keyevents.ts";

/** §5: lone ESC -> Esc key after this much quiet. pi stdin-buffer.ts parity. */
export const ESC_KEY_MS = 10;
/** §5: incomplete CSI/SS3 prefix hold window. */
export const SEQ_HOLD_MS = 50;

const ESC = "\x1b";
const PASTE_END = "\x1b[201~";
const DROP_LOG_MAX = 100;

/** control byte -> key name (§4 bindings: a,e,k,u,w,l,y ride the ctrl-* set) */
export function controlName(b: number): KeyName {
  if (b === 0x00) return "ctrl-space";
  if (b === 0x03) return "interrupt"; // Ctrl-C: pure interrupt (Decisions 2)
  if (b === 0x04) return "eof"; // Ctrl-D: editor decides (QUIT when buffer empty)
  if (b === 0x08) return "ctrl-h"; // readline binds Ctrl-H to backspace
  if (b === 0x09) return "tab";
  if (b === 0x0a) return "ctrl-j"; // raw-mode Enter is CR; LF is Ctrl-J
  if (b === 0x0d) return "enter";
  if (b === 0x7f) return "backspace";
  // 0x01..0x1a spell as ctrl-a..ctrl-z; 0x1c..0x1f spell as ctrl-\ ] ^ _
  if (b < 0x20) return "ctrl-" + String.fromCharCode(b + (b <= 0x1a ? 96 : 64));
  return "del";
}

// CSI cursor/final keys and the keypad ("~"-form) codes.
const CSI_KEYS: Record<string, KeyName> = {
  A: "up", B: "down", C: "right", D: "left", H: "home", F: "end",
};
const TILDE_KEYS: Record<number, KeyName> = {
  1: "home", 2: "insert", 3: "delete", 4: "end", 5: "pageup", 6: "pagedown", 7: "home", 8: "end",
};
// SS3 finals, lowercased: A/a both arrive depending on mode.
const SS3_KEYS: Record<string, KeyName> = {
  a: "up", b: "down", c: "right", d: "left", f: "end", h: "home",
};

/** xterm modifier param (1 + bits) -> name prefixes in fixed order. */
function modPrefix(mod: number | undefined): string {
  const m = (mod ?? 0) - 1;
  if (m <= 0) return "";
  return (m & 4 ? "ctrl-" : "") + (m & 2 ? "alt-" : "") + (m & 1 ? "shift-" : "");
}

type SeqResult =
  | { kind: "incomplete" }
  | { kind: "invalid"; next: number } // drop [at, next); reprocess the rest
  | { kind: "done"; next: number; event: KeyEvent | null; pasteStart: boolean };

function parseSequence(buf: string, at: number): SeqResult {
  // ESC already at buf[at]
  const intro = buf[at + 1];
  if (intro === undefined) return { kind: "incomplete" };
  if (intro === "O") {
    const f = buf[at + 2];
    if (f === undefined) return { kind: "incomplete" };
    if (f < " " || f === ESC) return { kind: "invalid", next: at + 2 };
    const name = SS3_KEYS[f.toLowerCase()];
    return { kind: "done", next: at + 3, event: name ? { kind: "key", name } : null, pasteStart: false };
  }
  if (intro !== "[") return { kind: "invalid", next: at + 1 }; // caller pre-checks; belt
  let i = at + 2;
  let params = "";
  for (;;) {
    if (i >= buf.length) return { kind: "incomplete" };
    const c = buf[i]!;
    const cc = buf.charCodeAt(i);
    if (c >= "0" && c <= "?") { params += c; i++; continue; } // parameter bytes
    if (c >= " " && c <= "/") { i++; continue; } // intermediate bytes: ignore
    if (cc >= 0x40 && cc <= 0x7e) break; // final byte
    return { kind: "invalid", next: i }; // control byte mid-CSI (incl. bare ESC)
  }
  const final = buf[i]!;
  const nums = params.split(";").map((p) => parseInt(p, 10) || 0);
  const next = i + 1;
  if (final === "Z") {
    // CSI Z is shift-tab even with no params; params may carry further mods.
    const p = modPrefix(nums[1]) || "shift-";
    return { kind: "done", next, event: { kind: "key", name: p + "tab" }, pasteStart: false };
  }
  if (final === "~") {
    const code = nums[0] ?? 0;
    if (code === 200) return { kind: "done", next, event: null, pasteStart: true };
    const name = TILDE_KEYS[code];
    if (!name) return { kind: "done", next, event: null, pasteStart: false };
    return { kind: "done", next, event: { kind: "key", name: modPrefix(nums[1]) + name }, pasteStart: false };
  }
  const base = CSI_KEYS[final];
  if (!base) return { kind: "done", next, event: null, pasteStart: false };
  return { kind: "done", next, event: { kind: "key", name: modPrefix(nums[1]) + base }, pasteStart: false };
}

export class StdinBuffer {
  private decoder = new TextDecoder("utf-8", { fatal: false });
  private readonly subs = new Set<(e: KeyEvent) => void>();
  private offSource: (() => void) | null = null;
  private buf = ""; // undelivered tail: pending ESC/CSI or paste-delimiter hold
  private paste = "";
  private inPaste = false;
  private escTimer: unknown = null;
  private seqTimer: unknown = null;
  private dropped = 0;
  private readonly dropLog: string[] = [];

  constructor(
    private readonly source: KeySource,
    private readonly clock: Clock,
  ) {}

  /** Subscribe to decoded events. First subscriber attaches the KeySource
   * listener; the last one releases it and discards in-flight state. */
  subscribe(cb: (e: KeyEvent) => void): () => void {
    this.subs.add(cb);
    if (!this.offSource) this.offSource = this.source.onData((chunk) => this.handleChunk(chunk));
    return () => {
      this.subs.delete(cb);
      if (this.subs.size === 0) this.release();
    };
  }

  get droppedBytes(): number {
    return this.dropped;
  }

  /** Dropped byte runs (capped at DROP_LOG_MAX entries). */
  get droppedSequences(): readonly string[] {
    return this.dropLog;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private release(): void {
    if (this.offSource) {
      this.offSource();
      this.offSource = null;
    }
    this.clearTimers();
    this.buf = "";
    this.paste = "";
    this.inPaste = false;
    // The decoder keeps its own partial-sequence state: without the rebuild,
    // a multi-byte sequence split at the unsubscribe moment materializes as a
    // phantom glyph for the next subscriber (3b suspend/resume round-trips
    // through here within one session). Rebuild, not reset(): the spec's
    // TextDecoder.reset() is missing in Bun.
    this.decoder = new TextDecoder("utf-8", { fatal: false });
  }

  private handleChunk(chunk: KeyChunk): void {
    // Bytes decode incrementally: a trailing incomplete sequence stays inside
    // the decoder until the next chunk. String chunks (tests, cooked sources)
    // skip the decoder untouched.
    if (typeof chunk === "string") this.buf += chunk;
    else this.buf += this.decoder.decode(chunk, { stream: true });
    this.consume();
  }

  private consume(): void {
    const buf = this.buf;
    let i = 0;
    while (i < buf.length) {
      if (this.inPaste) {
        const hit = buf.indexOf(PASTE_END, i);
        if (hit >= 0) {
          this.paste += buf.slice(i, hit);
          const text = this.paste;
          this.paste = "";
          this.inPaste = false;
          i = hit + PASTE_END.length;
          this.emit({ kind: "paste", text });
          continue;
        }
        const hold = partialSuffixLen(buf, i, PASTE_END);
        this.paste += buf.slice(i, buf.length - hold);
        i = buf.length - hold;
        break;
      }
      if (buf[i] === ESC) {
        const nx = buf[i + 1];
        if (nx === undefined) break; // esc state: wait for the timer or more bytes
        if (nx === "[" || nx === "O") {
          const r = parseSequence(buf, i);
          if (r.kind === "incomplete") break; // hold, seq timer guards
          if (r.kind === "invalid") {
            this.drop(buf.slice(i, r.next));
            i = r.next;
            continue;
          }
          if (r.pasteStart) {
            this.inPaste = true;
            i = r.next;
            continue;
          }
          if (r.event) this.emit(r.event);
          else this.drop(buf.slice(i, r.next));
          i = r.next;
          continue;
        }
        if (nx === ESC) {
          // ESC ESC: the first decodes as Esc, the second re-enters esc state.
          this.emit({ kind: "key", name: "esc" });
          i += 1;
          continue;
        }
        // meta form: ESC <char> = alt-<char>; ESC <control> = alt-<ctrlname>
        const nc = buf.charCodeAt(i + 1);
        const mname = nc < 0x20 || nc === 0x7f ? controlName(nc) : nx === " " ? "space" : nx;
        this.emit({ kind: "key", name: "alt-" + mname });
        i += 2;
        continue;
      }
      let j = i;
      while (j < buf.length && buf[j] !== ESC) j++;
      i = this.consumeRun(buf, i, j);
    }
    this.buf = buf.slice(i);
    this.rearmTimers();
  }

  /** Consume a run of [from,to) with no ESC in it: text batches, controls emit. */
  private consumeRun(buf: string, from: number, to: number): number {
    let runStart = from;
    let i = from;
    const flush = (end: number): void => {
      if (end > runStart) this.emit({ kind: "text", text: buf.slice(runStart, end) });
    };
    while (i < to) {
      const cc = buf.charCodeAt(i);
      if (cc >= 0x20 && cc !== 0x7f && cc !== 0xfffd) {
        const cp = buf.codePointAt(i)!;
        i += cp > 0xffff ? 2 : 1;
        continue;
      }
      flush(i);
      if (cc === 0xfffd) this.dropped++;
      else this.emit({ kind: "key", name: controlName(cc) });
      i++;
      runStart = i;
    }
    flush(to);
    return to;
  }

  private rearmTimers(): void {
    this.clearTimers();
    if (this.buf === "") return;
    if (this.inPaste) {
      // Held partial delimiter: after the hold window it was really text.
      this.seqTimer = this.clock.setTimeout(() => {
        this.seqTimer = null;
        this.paste += this.buf;
        this.buf = "";
      }, SEQ_HOLD_MS);
      return;
    }
    if (this.buf === ESC) {
      this.escTimer = this.clock.setTimeout(() => {
        this.escTimer = null;
        this.buf = "";
        this.emit({ kind: "key", name: "esc" });
      }, ESC_KEY_MS);
      return;
    }
    this.seqTimer = this.clock.setTimeout(() => {
      this.seqTimer = null;
      const bytes = this.buf;
      this.buf = "";
      this.drop(bytes);
    }, SEQ_HOLD_MS);
  }

  private clearTimers(): void {
    if (this.escTimer !== null) {
      this.clock.clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    if (this.seqTimer !== null) {
      this.clock.clearTimeout(this.seqTimer);
      this.seqTimer = null;
    }
  }

  /** Records a dropped byte run only; callers own this.buf. */
  private drop(bytes: string): void {
    this.dropped += bytes.length;
    if (this.dropLog.length < DROP_LOG_MAX) this.dropLog.push(bytes);
  }

  private emit(e: KeyEvent): void {
    for (const cb of [...this.subs]) cb(e);
  }
}

/** Longest strict-prefix-of-term that ends buf (from `i` on). */
function partialSuffixLen(buf: string, i: number, term: string): number {
  const max = Math.min(term.length - 1, buf.length - i);
  for (let k = max; k > 0; k--) {
    if (buf.endsWith(term.slice(0, k))) return k;
  }
  return 0;
}
