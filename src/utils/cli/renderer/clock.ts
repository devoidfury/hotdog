// Real Clock: the process timers behind the Clock seam (§11).

import type { Clock } from "./seams.ts";

export class SystemClock implements Clock {
  setTimeout(cb: () => void, ms: number): unknown {
    return setTimeout(cb, ms);
  }

  clearTimeout(handle: unknown): void {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  }

  setImmediate(cb: () => void): unknown {
    return setImmediate(cb);
  }

  clearImmediate(handle: unknown): void {
    clearImmediate(handle as ReturnType<typeof setImmediate>);
  }

  now(): number {
    return Date.now();
  }
}
