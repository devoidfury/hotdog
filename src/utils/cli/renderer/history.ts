// History (design note §4, steal 12): file-backed dedup history is an
// ADDITION of stage 3, not a preservation (today's readline history is
// in-memory only). This module is the pure model: navigation walks with the
// draft slot (§4 stash-on-first-navigation, recoverable at the newest
// position, interrupt stashes too), consecutive-duplicate dedupe,
// append-on-submit, bounded size, and corrupt-tolerant loading.
//
// No fs here: persistence is the injected `save` callback (called on append)
// and the `load(text)` entry point -- stage 3b owns the config-dir file.
// Load NEVER throws: garbage lines are skipped, an unreadable shape reads as
// empty (§4/§9 degrade posture).
//
// Caps (documented, this module is their single owner):
// - HISTORY_MAX: 1000 entries kept; the oldest are evicted on append.
// - HISTORY_LINE_MAX: 4096 cells; longer lines are skipped at load.

export const HISTORY_MAX = 1000;
export const HISTORY_LINE_MAX = 4096;

export interface HistoryOptions {
  max?: number;
  /** Serialized-content sink (the whole list, newline-terminated). 3b wires it to the config-dir file. */
  save?: (serialized: string) => void;
}

export class History {
  private readonly max: number;
  private readonly save: ((serialized: string) => void) | undefined;
  private entries: string[] = [];
  /** Navigation position: entries.length == "the current line" (no entry shown). */
  private nav = 0;
  private draft: string | null = null;

  constructor(opts: HistoryOptions = {}) {
    this.max = Math.max(1, opts.max ?? HISTORY_MAX);
    this.save = opts.save;
  }

  get size(): number {
    return this.entries.length;
  }

  /** Newest-first view for tests/diagnostics. */
  list(): readonly string[] {
    return this.entries;
  }

  /** Append a submitted line: blank and consecutive duplicates are skipped. */
  append(text: string): void {
    if (text === "") return;
    if (this.entries[this.entries.length - 1] === text) {
      this.resetNav();
      return;
    }
    this.entries.push(text);
    if (this.entries.length > this.max) this.entries.splice(0, this.entries.length - this.max);
    this.resetNav();
    if (this.save) this.save(this.serialize());
  }

  // ── navigation (§4 draft-restore walk) ─────────────────────────────────

  /**
   * Start a walk: stashes the in-progress text into the draft slot unless a
   * draft is already pending (the interrupt stash outranks a fresh line).
   */
  beginWalk(current: string): void {
    if (this.draft === null) this.draft = current;
    this.nav = this.entries.length;
  }

  get walkActive(): boolean {
    return this.draft !== null;
  }

  /** Previous entry, or null at the oldest end (position stays). */
  prev(): string | null {
    if (this.nav <= 0) return null;
    this.nav--;
    return this.entries[this.nav] ?? null;
  }

  /** Next entry, or null at/past the newest -- the caller restores the draft. */
  next(): string | null {
    if (this.nav + 1 >= this.entries.length) return null;
    this.nav++;
    return this.entries[this.nav] ?? null;
  }

  /** Newest position reached: hand back the draft and close the walk. */
  takeDraft(): string | null {
    const d = this.draft;
    this.draft = null;
    this.nav = this.entries.length;
    return d;
  }

  /** §4: interrupt stashes the buffer as draft (recoverable, not destructive). */
  saveDraft(text: string): void {
    this.draft = text;
    this.nav = this.entries.length;
  }

  resetNav(): void {
    this.draft = null;
    this.nav = this.entries.length;
  }

  // ── persistence ────────────────────────────────────────────────────────

  /**
   * One entry per line, newline-terminated -- the file shape 3b writes.
   * Entries may contain \n (pasted multi-line submits): backslashes escape to
   * `\\` and newlines to `\n` so the round-trip is lossless (bash does the
   * same). Backslashes escape FIRST, or `5 \n 3` would escape into a fake
   * newline.
   */
  serialize(): string {
    return this.entries.map((e) => e.replaceAll("\\", "\\\\").replaceAll("\n", "\\n") + "\n").join("");
  }

  /**
   * Replace the list from file content. Garbage tolerance (never throws):
   * blank lines ignored; a trailing CR is stripped (CRLF files); lines
   * containing control characters (any binary debris, stray NULs, mid-line
   * CRs) skipped -- a lone CR cannot be content because serialize() writes
   * one entry per line; lines longer than HISTORY_LINE_MAX skipped; only the
   * newest `max` entries kept. A binary blob without newlines reads as one
   * over-long line: zero entries, not an error. Escapes (`\\`, `\n`) are
   * reversed after the checks; an unknown escape keeps both bytes verbatim.
   */
  load(text: string): void {
    const kept: string[] = [];
    for (const line of text.split("\n")) {
      const entry = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (entry === "") continue;
      if (entry.length > HISTORY_LINE_MAX) continue;
      // eslint-disable-next-line no-control-regex -- the point is to detect control bytes
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(entry)) continue;
      kept.push(unescapeEntry(entry));
    }
    this.entries = kept.length > this.max ? kept.slice(kept.length - this.max) : kept;
    this.resetNav();
  }
}

/** Reverse of serialize()'s escaping, single pass so `\\n` reads as
 * backslash-then-n and never as an escaped newline. Unknown escapes (a
 * hand-mangled file) keep both bytes -- lossy is fine, throwing is not. */
function unescapeEntry(line: string): string {
  if (!line.includes("\\")) return line;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const n = line[++i];
    if (n === "\\") out += "\\";
    else if (n === "n") out += "\n";
    else out += n === undefined ? "\\" : "\\" + n;
  }
  return out;
}
