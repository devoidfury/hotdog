// FakeClock: deterministic test double for the Clock seam (§11). The 16ms
// frame interval and the stdin timers advance only when the test says so, and
// cancellations are observable -- the input-bypass test asserts the pending
// paint timer was actually cleared, not merely overwritten.

import type { Clock } from "./seams.ts";

interface TimerRecord {
  at: number;
  cb: () => void;
}

export class FakeClock implements Clock {
  private timeMs = 0;
  private nextId = 1;
  private immediates = new Map<number, () => void>();
  private timers = new Map<number, TimerRecord>();
  /** Every handle explicitly cleared, in cancellation order. */
  readonly canceled: unknown[] = [];

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.timeMs + Math.max(0, ms), cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    if (this.timers.delete(handle as number)) this.canceled.push(handle);
  }

  setImmediate(cb: () => void): unknown {
    const id = this.nextId++;
    this.immediates.set(id, cb);
    return id;
  }

  clearImmediate(handle: unknown): void {
    if (this.immediates.delete(handle as number)) this.canceled.push(handle);
  }

  now(): number {
    return this.timeMs;
  }

  // ── test drivers ───────────────────────────────────────────────────────

  /** Drains the immediate queue FIFO; work scheduled during the drain joins it. */
  runImmediates(): void {
    while (this.immediates.size > 0) {
      const [id, cb] = this.immediates.entries().next().value as [number, () => void];
      this.immediates.delete(id);
      cb();
    }
  }

  /** Moves time forward ms and runs everything that becomes due. */
  advance(ms: number): void {
    const until = this.timeMs + Math.max(0, ms);
    for (;;) {
      const due = this.earliestDueTimer(until);
      if (!due) break;
      this.timeMs = due.at;
      this.timers.delete(due.id);
      due.cb();
      this.runImmediates();
    }
    this.timeMs = until;
    this.runImmediates();
  }

  /** Runs immediates and all timers to exhaustion. Bounded: an endless self-reschedule fails, not hangs. */
  runAll(maxRounds = 1000): void {
    for (let round = 0; round < maxRounds; round++) {
      this.runImmediates();
      const earliest = this.earliestDueTimer(Infinity);
      if (!earliest) return;
      this.advance(earliest.at - this.timeMs);
    }
    throw new Error(`FakeClock.runAll: still busy after ${maxRounds} rounds -- runaway reschedule`);
  }

  get pendingCount(): number {
    return this.timers.size + this.immediates.size;
  }

  private earliestDueTimer(until: number): { id: number; at: number; cb: () => void } | null {
    let best: { id: number; at: number; cb: () => void } | null = null;
    for (const [id, rec] of this.timers) {
      if (rec.at > until) continue;
      if (!best || rec.at < best.at) best = { id, ...rec };
    }
    return best;
  }
}
