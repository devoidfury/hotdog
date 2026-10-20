// Process-backed Terminal and KeySource: the real side of the §11 seams.
// This is plumbing only -- no frame/escape policy lives here (mode bytes are
// owned by TeardownGuard, §10).

import type { KeySource, Terminal } from "./seams.ts";

/** stdin slice the real seams need; process.stdin satisfies it structurally. */
interface StdinLike {
  isTTY?: boolean | null;
  setRawMode?(mode: boolean): unknown;
  on(event: "data", cb: (chunk: Buffer | string) => void): unknown;
  off(event: "data", cb: (chunk: Buffer | string) => void): unknown;
}

interface StdoutLike {
  isTTY?: boolean | null;
  columns?: number;
  rows?: number;
  write(s: string): unknown;
  on(event: "resize", cb: () => void): unknown;
  off(event: "resize", cb: () => void): unknown;
}

export class ProcessTerminal implements Terminal {
  constructor(
    private readonly out: StdoutLike = process.stdout,
    private readonly stdin: StdinLike = process.stdin,
  ) {}

  write(s: string): void {
    this.out.write(s);
  }

  get isTTY(): boolean {
    return this.out.isTTY === true;
  }

  get columns(): number {
    return this.out.columns ?? 80;
  }

  get rows(): number {
    return this.out.rows ?? 24;
  }

  setRawMode(on: boolean): void {
    this.stdin.setRawMode?.(on);
  }

  onResize(cb: () => void): () => void {
    this.out.on("resize", cb);
    return () => void this.out.off("resize", cb);
  }
}

/** Raw stdin chunks. Unsubscribing is the ONLY way input stops -- never stdin.pause() (pitfall 6, §5). */
export class StdinKeySource implements KeySource {
  constructor(private readonly stdin: StdinLike = process.stdin) {}

  onData(cb: (chunk: string) => void): () => void {
    const handler = (chunk: Buffer | string): void => {
      cb(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    };
    this.stdin.on("data", handler);
    return () => void this.stdin.off("data", handler);
  }
}
