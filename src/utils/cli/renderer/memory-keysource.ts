// MemoryKeySource: feeds raw byte chunks to KeySource subscribers by hand
// (§11; the stage-3 StdinBuffer will sit behind this seam).

import type { KeySource } from "./seams.ts";

export class MemoryKeySource implements KeySource {
  private subs = new Set<(chunk: string) => void>();

  onData(cb: (chunk: string) => void): () => void {
    this.subs.add(cb);
    return () => void this.subs.delete(cb);
  }

  push(chunk: string): void {
    for (const cb of [...this.subs]) cb(chunk);
  }

  get listenerCount(): number {
    return this.subs.size;
  }
}
