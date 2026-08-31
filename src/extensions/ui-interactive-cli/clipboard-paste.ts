// Clipboard paste support for the interactive CLI line editor.
//
// This wraps a readline Interface (Bun's node:readline parses 'data' bytes on
// the input stream itself) and swaps that listener for a dispatcher that:
//   - swallows bracketed paste payloads and inserts a `[Paste #N - M lines]`
//     marker into the line buffer instead (the real content is kept in an
//     index keyed by N and restored in `normalize()` at submit time), except
//     for single-line pastes under 80 characters, which are inserted as-is,
//   - deletes an entire marker with one backspace or the Delete key when the
//     cursor is on it,
//   - forwards every other byte to readline untouched, so completion,
//     history, arrows, question(), pause/resume, etc. all keep working.
//
// The interceptor is a no-op unless the readline input stream is a TTY.

import type readline from "node:readline";
import { ExtensionError, formatError } from "@core/error.ts";
import { logger } from "@core/logger.ts";

// xterm bracketed paste https://www.xfree86.org/current/ctlseqs.html#Bracketed%20Paste%20Mode
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const ENABLE_PASTE = "\x1b[?2004h";
const DISABLE_PASTE = "\x1b[?2004l";
// xterm forward-delete (the Delete key). readline decodes it internally, so
// the raw sequence must be intercepted here to be atomic on markers.
const DELETE_FWD = "\x1b[3~";

type DataListener = (chunk: unknown) => void;

interface InputLike {
  isTTY?: boolean;
  listeners(event: string): unknown[];
  removeListener(event: string, listener: DataListener): unknown;
  on(event: string, listener: DataListener): unknown;
}

interface OutputLike {
  isTTY?: boolean;
  write(data: string): unknown;
}

interface LineBuffer {
  line?: string;
  cursor?: number;
  _refreshLine?: () => void;
}

interface PasteEntry {
  content: string;
  /** true once the content has been rendered into a submitted line */
  seen: boolean;
}

function markerMatches(line: string): Iterable<RegExpExecArray> {
  return line.matchAll(/\[Paste #(\d+) - \d+ lines?\]/g);
}

// Single process-level exit hook for all instances (terminal paste mode must
// be turned off even if the process dies without rl.close()).
const liveInterceptors = new Set<ClipboardPasteInterceptor>();
let exitHookInstalled = false;
function ensureExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const interceptor of liveInterceptors) interceptor.teardown();
  });
}

export interface ClipboardPasteInterceptorOptions {
  /**
   * Required. Minimum length (characters) for a single-line paste to get a
   * marker; shorter single-line pastes are inserted as-is. 0 = always marker.
   * Source of truth for the value is the `pasteMarkerMinChars` config key.
   */
  pasteMarkerMinChars: number;
}

export class ClipboardPasteInterceptor {
  readonly #rl: readline.Interface;
  readonly #origData: DataListener | null;
  readonly #stdin: InputLike | null;
  readonly #stdout: OutputLike | null;
  readonly #markerMinChars: number;
  #input: DataListener | null = null;
  /** sequential marker number; incremented per paste, never reset */
  #seq = 0;
  /** marker number -> pasted content */
  #index = new Map<number, PasteEntry>();
  #pasteBuf: string | null = null;
  /** suffix held back because it may be the start of a split paste delimiter */
  #pending = "";
  /** set by onInterrupt() mid-paste; the in-flight payload is dropped at END */
  #discard = false;

  constructor(rl: readline.Interface, options: ClipboardPasteInterceptorOptions) {
    this.#rl = rl;
    // config values arrive untyped from the config layer; fail loud rather
    // than guess a threshold
    if (typeof options.pasteMarkerMinChars !== "number" || options.pasteMarkerMinChars < 0) {
      throw new ExtensionError(
        `clipboard-paste: pasteMarkerMinChars must be a non-negative number, got ${String(
          options.pasteMarkerMinChars,
        )}`,
      );
    }
    this.#markerMinChars = options.pasteMarkerMinChars;
    const input = (rl as { input?: unknown }).input as InputLike | undefined;
    const output = (rl as { output?: unknown }).output as OutputLike | undefined;
    const dataListeners = (input?.listeners?.("data") ?? []) as DataListener[];
    // readline registers its data listener when the interface is created; it is the last one on the stream.
    const orig = dataListeners[dataListeners.length - 1] ?? null;
    const enabled =
      input?.isTTY === true &&
      orig !== null &&
      typeof input?.removeListener === "function" &&
      typeof input?.on === "function" &&
      typeof output?.write === "function";

    this.#stdin = enabled ? input : null;
    this.#stdout = enabled ? output : null;
    this.#origData = enabled ? orig : null;

    if (!enabled) return;

    this.#stdin!.removeListener("data", orig!);
    const onInput: DataListener = (chunk) => this.#onData(chunk);
    this.#stdin!.on("data", onInput);
    this.#input = onInput;

    this.#writeEscape(ENABLE_PASTE);
    liveInterceptors.add(this);
    ensureExitHook();
    // rl.close() is the guaranteed teardown point even if dispose() is never called.
    rl.on("close", () => this.dispose());
  }

  get enabled(): boolean {
    return this.#origData !== null;
  }

  /**
   * Replace paste markers with their real content. Call exactly once per
   * submitted line (main prompt or question answers). Each marker's content
   * is inserted at most once (per # marker, for the lifetime of the
   * session); later occurrences of the same marker are left as plain text.
   */
  normalize(line: string): string {
    if (this.#index.size === 0) return line;
    let out = "";
    let last = 0;
    for (const m of markerMatches(line)) {
      const entry = this.#index.get(Number(m[1]));
      const idx = m.index;
      if (entry && !entry.seen) {
        out += line.slice(last, idx) + entry.content;
        entry.seen = true;
        last = idx + m[0].length;
      }
    }
    out += line.slice(last);
    // Any live marker missing from a submitted line was removed by line
    // editing (ctrl-U, ctrl-K, ...) without being rendered; drop it so its
    // content can never be substituted into a later line.
    for (const [num, entry] of this.#index) {
      if (!entry.seen) this.#index.delete(num);
    }
    return out;
  }

  /**
   * Reset editor state after an interrupt. The in-flight paste payload (if
   * any) is discarded when its END delimiter arrives; recorded markers are
   * dropped because the app clears the line buffer.
   */
  onInterrupt(): void {
    if (this.#pasteBuf !== null) this.#discard = true;
    this.#pending = "";
    // #seq keeps incrementing so marker numbers stay unique per session.
    this.#index.clear();
  }

  dispose(): void {
    this.teardown();
    liveInterceptors.delete(this);
  }

  /** Idempotent; called from both dispose() and the process exit hook. */
  teardown(): void {
    if (this.#stdin && this.#input) {
      try {
        this.#stdin.removeListener("data", this.#input);
      } catch (e) {
        logger.debug(`clipboard-paste: teardown: ${formatError(e)}`);
      }
      this.#input = null;
    }
    this.#writeEscape(DISABLE_PASTE);
  }

  #writeEscape(seq: string): void {
    if (this.#stdout?.isTTY !== true) return;
    try {
      this.#stdout.write(seq);
    } catch (e) {
      logger.debug(`clipboard-paste: terminal write failed: ${formatError(e)}`);
    }
  }

  #onData(chunk: unknown): void {
    const raw =
      typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    let rest = this.#pending + raw;
    this.#pending = "";

    while (rest.length > 0) {
      if (this.#pasteBuf === null) {
        const startIdx = rest.indexOf(PASTE_START);
        const delIdx = rest.indexOf(DELETE_FWD);
        let cut = -1;
        let isPaste = false;
        if (startIdx !== -1 && (delIdx === -1 || startIdx < delIdx)) {
          cut = startIdx;
          isPaste = true;
        } else if (delIdx !== -1) {
          cut = delIdx;
        }

        if (cut !== -1) {
          if (cut > 0) this.#forwardText(rest.slice(0, cut));
          if (isPaste) {
            this.#discard = false;
            this.#pasteBuf = "";
            rest = rest.slice(cut + PASTE_START.length);
          } else {
            if (!this.#atomicForwardDelete()) this.#origData!(DELETE_FWD);
            rest = rest.slice(cut + DELETE_FWD.length);
          }
        } else {
          // A paste delimiter or the Delete sequence may arrive in the next
          // chunk; hold back any trailing partial prefix so it is not
          // committed as content.
          const hold = longestPrefixSuffix(rest, PASTE_START, DELETE_FWD);
          if (hold > 0) {
            this.#forwardText(rest.slice(0, rest.length - hold));
            this.#pending = rest.slice(rest.length - hold);
          } else {
            this.#forwardText(rest);
          }
          rest = "";
        }
      } else {
        const endIdx = rest.indexOf(PASTE_END);
        const c3 = rest.indexOf("\x03");
        const c4 = rest.indexOf("\x04");
        const ctrlIdx = Math.min(c3 === -1 ? Infinity : c3, c4 === -1 ? Infinity : c4);

        if (endIdx !== -1 && endIdx < ctrlIdx) {
          this.#pasteBuf += rest.slice(0, endIdx);
          rest = rest.slice(endIdx + PASTE_END.length);
          this.#finishPaste();
        } else if (ctrlIdx !== Infinity) {
          // Let ctrl-C / ctrl-D reach readline even mid-paste (interrupt and
          // close still work); the payload is dropped at its END delimiter.
          this.#pasteBuf += rest.slice(0, ctrlIdx);
          this.#origData!(rest[ctrlIdx]!);
          rest = rest.slice(ctrlIdx + 1);
        } else {
          // The END delimiter may arrive in the next chunk; hold back any
          // trailing partial prefix so it is not committed as content.
          const hold = longestPrefixSuffix(rest, PASTE_END);
          if (hold > 0) {
            this.#pasteBuf += rest.slice(0, rest.length - hold);
            this.#pending = rest.slice(rest.length - hold);
          } else {
            this.#pasteBuf += rest;
          }
          rest = "";
        }
      }
    }
  }

  #finishPaste(): void {
    const raw = this.#pasteBuf ?? "";
    this.#pasteBuf = null;
    const discard = this.#discard;
    this.#discard = false;
    if (discard || raw.length === 0) return;

    // The TTY line discipline can deliver pasted newlines as \r (ICRNL),
    // which breaks the line count below and corrupts the stored content;
    // restore \n so we keep what was actually on the clipboard.
    const content = raw.replace(/\r\n|\r/g, "\n");

    // Short single-line pastes are indistinguishable from typing and are
    // cheaper to show as-is; only multi-line or long pastes get a marker.
    if (!content.includes("\n") && content.length < this.#markerMinChars) {
      this.#forwardText(content);
      return;
    }

    const trimmed = content.endsWith("\n") ? content.slice(0, -1) : content;
    const lines = trimmed.length === 0 && content.length > 0 ? 1 : trimmed.split("\n").length;
    this.#seq += 1;
    const token = `[Paste #${this.#seq} - ${lines} line${lines === 1 ? "" : "s"}]`;
    this.#index.set(this.#seq, { content, seen: false });
    this.#forwardText(token);
  }

  /** Forward text to readline, intercepting backspaces that hit a paste marker. */
  #forwardText(text: string): void {
    let i = 0;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === "\x7f" || ch === "\b") {
        if (!this.#atomicBackspace()) this.#origData!(ch);
        i++;
      } else {
        let j = i + 1;
        while (j < text.length && text[j] !== "\x7f" && text[j] !== "\b") j++;
        this.#origData!(text.slice(i, j));
        i = j;
      }
    }
  }

  /**
   * If the pending backspace lands on (cursor inside or at the end of) a
   * live paste marker, remove the whole marker from the line buffer and
   * redraw. A marker whose content was already rendered is plain text now
   * (e.g., recalled from history) and is not atomic. Returns true when it
   * consumed the backspace.
   */
  #atomicBackspace(): boolean {
    const rl = this.#rl as unknown as LineBuffer;
    const line = rl.line ?? "";
    const cursor = rl.cursor ?? 0;
    if (cursor === 0) return false;
    for (const m of markerMatches(line)) {
      const entry = this.#index.get(Number(m[1]));
      if (!entry || entry.seen) continue;
      const idx = m.index;
      const end = idx + m[0].length;
      // backspace removes the char at cursor-1; consume it if that char is
      // part of this marker
      if (cursor > idx && cursor <= end) {
        rl.line = line.slice(0, idx) + line.slice(end);
        rl.cursor = idx;
        this.#index.delete(Number(m[1]));
        rl._refreshLine?.();
        return true;
      }
    }
    return false;
  }

  /**
   * Mirror of #atomicBackspace for the Delete key: if the pending
   * forward-delete removes a char of a live paste marker (cursor inside it),
   * remove the whole marker instead. Returns true when it consumed the
   * keypress.
   */
  #atomicForwardDelete(): boolean {
    const rl = this.#rl as unknown as LineBuffer;
    const line = rl.line ?? "";
    const cursor = rl.cursor ?? 0;
    if (cursor >= line.length) return false;
    for (const m of markerMatches(line)) {
      const entry = this.#index.get(Number(m[1]));
      if (!entry || entry.seen) continue;
      const idx = m.index;
      const end = idx + m[0].length;
      // forward-delete removes the char at cursor; consume it if that char is
      // part of this marker
      if (cursor >= idx && cursor < end) {
        rl.line = line.slice(0, idx) + line.slice(end);
        rl.cursor = idx;
        this.#index.delete(Number(m[1]));
        rl._refreshLine?.();
        return true;
      }
    }
    return false;
  }
}

/** Largest k such that text ends with candidate.slice(0, k) for some candidate (k < candidate.length). */
function longestPrefixSuffix(text: string, ...candidates: string[]): number {
  let best = 0;
  for (const candidate of candidates) {
    const max = Math.min(text.length, candidate.length - 1);
    for (let k = max; k > best; k--) {
      if (text.endsWith(candidate.slice(0, k))) {
        best = k;
        break;
      }
    }
  }
  return best;
}
