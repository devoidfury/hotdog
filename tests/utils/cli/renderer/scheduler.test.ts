// FrameScheduler (§3, pi's shape): next-tick coalescing, MIN_RENDER_INTERVAL_MS
// between paints, input bypass that cancels the pending timer first. Driven
// entirely through the injected FakeClock -- no real timers anywhere.

import { describe, it, expect } from "bun:test";
import { FakeClock } from "@utils/cli/renderer/fake-clock.ts";
import { FrameScheduler, MIN_RENDER_INTERVAL_MS } from "@utils/cli/renderer/scheduler.ts";

function setup() {
  const clock = new FakeClock();
  let paints = 0;
  const sched = new FrameScheduler(clock, () => paints++);
  return { clock, sched, paints: () => paints };
}

describe("FrameScheduler coalescing (steal 5/7)", () => {
  it("many requests in one tick paint exactly once", () => {
    const { clock, sched, paints } = setup();
    for (let i = 0; i < 50; i++) sched.requestRender();
    expect(paints()).toBe(0); // next-tick, not synchronous
    clock.runAll();
    expect(paints()).toBe(1);
  });

  it("a request arriving during the paint window joins the next tick, not a second paint", () => {
    const { clock, sched, paints } = setup();
    sched.requestRender();
    clock.runImmediates();
    expect(paints()).toBe(1);
    sched.requestRender();
    clock.runAll(); // throttle defers to t=16, then paints once
    expect(paints()).toBe(2);
    expect(clock.pendingCount).toBe(0);
  });

  it(`enforces MIN_RENDER_INTERVAL_MS (${MIN_RENDER_INTERVAL_MS}ms) between paints`, () => {
    const { clock, sched, paints } = setup();
    sched.paintNow(); // t=0, paints=1
    sched.requestRender();
    clock.runImmediates(); // tick sees since=0 and defers via a 16ms timer
    expect(paints()).toBe(1);
    clock.advance(MIN_RENDER_INTERVAL_MS - 8); // t=8
    expect(paints()).toBe(1);
    clock.advance(8); // t=16
    expect(paints()).toBe(2);
  });

  it("paints without throttle when the interval already elapsed", () => {
    const { clock, sched, paints } = setup();
    sched.paintNow();
    clock.advance(MIN_RENDER_INTERVAL_MS * 3);
    sched.requestRender();
    clock.runImmediates();
    expect(paints()).toBe(2);
  });
});

describe("FrameScheduler input bypass", () => {
  it("paintNow cancels the pending immediate FIRST and paints immediately", () => {
    const { clock, sched, paints } = setup();
    sched.requestRender(); // coalesced paint pending
    sched.paintNow(); // keystroke: paint now, cancel the pending one
    expect(paints()).toBe(1);
    expect(clock.canceled.length).toBe(1); // the immediate was really cleared
    expect(clock.pendingCount).toBe(0);
    clock.runAll(); // a stale deferred paint would double-paint here
    expect(paints()).toBe(1);
  });

  it("paintNow cancels a pending throttle timer too", () => {
    const { clock, sched, paints } = setup();
    sched.paintNow(); // t=0
    sched.requestRender();
    clock.runImmediates(); // tick defers paint to t=16
    sched.paintNow(); // keystroke at t=0: paint + cancel the 16ms timer
    expect(paints()).toBe(2);
    clock.advance(100);
    expect(paints()).toBe(2); // cancelled timer never fired
    expect(clock.canceled.length).toBe(1);
  });
});

describe("FrameScheduler stop (§10 step 1)", () => {
  it("stop cancels all pending work and kills future requests", () => {
    const { clock, sched, paints } = setup();
    sched.requestRender();
    sched.stop();
    expect(sched.isStopped).toBe(true);
    expect(clock.pendingCount).toBe(0);
    clock.runAll();
    expect(paints()).toBe(0);
    sched.requestRender();
    sched.paintNow();
    clock.runAll();
    expect(paints()).toBe(0);
    expect(sched.pending).toBe(false);
  });
});
