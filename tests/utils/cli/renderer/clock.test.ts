// SystemClock: the real-timer side of the Clock seam (§11). Determinism is
// FakeClock's job; this file pins the pass-through wiring instead -- handles
// round-trip back to clearTimeout/clearImmediate, callbacks land on the real
// event loop, and now() is wall clock.

import { describe, it, expect } from "bun:test";
import { SystemClock } from "@utils/cli/renderer/clock.ts";

/** Let real timers advance past a 1ms callback. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 15));

describe("SystemClock (real Clock seam)", () => {
  it("setTimeout fires on the event loop; clearTimeout with the returned handle cancels", async () => {
    const clock = new SystemClock();
    let fired = 0;

    const handle = clock.setTimeout(() => {
      fired++;
    }, 1);
    expect(handle).toBeDefined();
    await settle();
    expect(fired).toBe(1);

    const doomed = clock.setTimeout(() => {
      fired++;
    }, 1);
    clock.clearTimeout(doomed);
    await settle();
    expect(fired).toBe(1); // the cancelled timer never fired
  });

  it("setImmediate defers past the synchronous task; clearImmediate cancels", async () => {
    const clock = new SystemClock();
    const order: string[] = [];

    clock.setImmediate(() => order.push("immediate"));
    order.push("sync");
    const cancelled = clock.setImmediate(() => order.push("never"));
    clock.clearImmediate(cancelled);

    await settle();
    expect(order).toEqual(["sync", "immediate"]);
  });

  it("now() is Date.now within a millisecond band", () => {
    const clock = new SystemClock();
    const before = Date.now();
    const got = clock.now();
    const after = Date.now();
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(after);
  });
});
