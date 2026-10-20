// Seam interfaces for the split-region renderer (design note §11). The whole
// renderer is constructor-injected against these; that is what makes the
// golden-grid tests possible without a PTY and without mock.module.

/** The byte pipe the renderer owns. Real impl wraps process.std*; tests use the Grid. */
export interface Terminal {
  write(s: string): void;
  readonly isTTY: boolean;
  readonly columns: number;
  readonly rows: number;
  setRawMode(on: boolean): void;
  /** Subscribe to resize; returns an unsubscribe fn. */
  onResize(cb: () => void): () => void;
}

/** Injectable timers so the 16ms frame interval advances deterministically. */
export interface Clock {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setImmediate(cb: () => void): unknown;
  clearImmediate(handle: unknown): void;
  now(): number;
}

/** Raw stdin chunk. Buffer-backed sources hand bytes (a multi-byte UTF-8
 * sequence may straddle chunks); string chunks pass through untouched.
 * Widened from `string` in stage 3a -- StdinBuffer's incremental decoder is
 * the only correct place to turn bytes into text (§5); per-chunk
 * toString("utf8") corrupts split sequences into U+FFFD. */
export type KeyChunk = string | Uint8Array;

/** Raw byte chunks from stdin, pre-StdinBuffer. StdinBuffer decodes these. */
export interface KeySource {
  /** Subscribe to raw chunks; returns an unsubscribe fn. Never pauses the stream (pitfall 6). */
  onData(cb: (chunk: KeyChunk) => void): () => void;
}

/** The slice of process the TeardownGuard needs; tests inject a fake so signal wiring is observable. */
export interface SignalHost {
  /** Registers a handler; returns an unsubscribe fn (step 7: default behavior resumes). */
  on(signal: "SIGTERM" | "SIGHUP", cb: () => void): () => void;
  exit(code: number): void;
}
