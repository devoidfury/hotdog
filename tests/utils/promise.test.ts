// Tests for utils/promise.ts — isPromise, sleep, raceAbort.

import { describe, it, expect } from "bun:test";
import { ABORTED, isPromise, raceAbort, sleep } from "@utils/promise.ts";

// Spy on a signal's add/removeEventListener (leak check: shared controllers
// outlive many races, so listeners must be detached either way).
function trackSignal(signal: AbortSignal): {
  added: Array<() => void>;
  removed: Array<() => void>;
  restore: () => void;
} {
  const proto = AbortSignal.prototype;
  const origAdd = proto.addEventListener;
  const origRemove = proto.removeEventListener;
  const added: Array<() => void> = [];
  const removed: Array<() => void> = [];
  proto.addEventListener = function (
    this: AbortSignal,
    type: string,
    listener: any,
    options?: boolean | AddEventListenerOptions,
  ) {
    if (this === signal && type === "abort") added.push(listener as () => void);
    return origAdd.call(this, type, listener, options);
  };
  proto.removeEventListener = function (
    this: AbortSignal,
    type: string,
    listener: any,
    options?: boolean | EventListenerOptions,
  ) {
    if (this === signal && type === "abort") removed.push(listener as () => void);
    return origRemove.call(this, type, listener, options);
  };
  return {
    added,
    removed,
    restore: () => {
      proto.addEventListener = origAdd;
      proto.removeEventListener = origRemove;
    },
  };
}

describe("isPromise", () => {
  it("returns true for thenable objects", () => {
    expect(isPromise({ then: () => {} })).toBe(true);
  });

  it("returns false for null, undefined, and primitives", () => {
    expect(isPromise(null)).toBe(false);
    expect(isPromise(undefined)).toBe(false);
    expect(isPromise(42)).toBe(false);
    expect(isPromise("string")).toBe(false);
    expect(isPromise(true)).toBe(false);
    expect(isPromise(Symbol("test"))).toBe(false);
  });

  it("returns false for objects without a function then", () => {
    expect(isPromise({})).toBe(false);
    expect(isPromise({ foo: "bar" })).toBe(false);
    expect(isPromise([])).toBe(false);
    expect(isPromise({ then: "not a function" })).toBe(false);
  });

  it("returns true for async function return value", async () => {
    const result = (async () => 42)();
    expect(isPromise(result)).toBe(true);
    result.then(() => {}); // suppress unhandled rejection
  });
});

describe("sleep", () => {
  it("resolves after the delay", async () => {
    const start = Date.now();
    await sleep(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("resolves early when the signal aborts", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const p = sleep(60_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await p;
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    // A past "abort" never re-fires the listener, so without the up-front
    // check this would hang for the full backoff (60s) instead of
    // resolving now.
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await sleep(60_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(500);
  });

  // Spy on the signal's add/removeEventListener to verify the listener is
  // detached whichever way the wait ends (leak check: the shared abort
  // controller outlives many retries).

  it("removes its abort listener when the delay elapses", async () => {
    const controller = new AbortController();
    const spy = trackSignal(controller.signal);
    try {
      await sleep(20, controller.signal);
    } finally {
      spy.restore();
    }
    expect(spy.added).toHaveLength(1);
    expect(spy.removed).toEqual(spy.added);
  });

  it("removes its abort listener when the signal aborts", async () => {
    const controller = new AbortController();
    const spy = trackSignal(controller.signal);
    try {
      const p = sleep(60_000, controller.signal);
      setTimeout(() => controller.abort(), 10);
      await p;
    } finally {
      spy.restore();
    }
    expect(spy.added).toHaveLength(1);
    expect(spy.removed).toEqual(spy.added);
  });
});

describe("raceAbort", () => {
  it("resolves with the work result when no signals are given", async () => {
    expect(await raceAbort(() => Promise.resolve("done"), [])).toBe("done");
    expect(await raceAbort(() => 7, [null, undefined])).toBe(7);
  });

  it("propagates a work rejection when nobody aborts", async () => {
    await expect(raceAbort(() => Promise.reject(new Error("boom")), [])).rejects.toThrow("boom");
  });

  it("turns a synchronous throw into a rejection (same path as async)", async () => {
    await expect(
      raceAbort(() => {
        throw new Error("sync boom");
      }, []),
    ).rejects.toThrow("sync boom");
  });

  it("resolves ABORTED when the signal aborts while the work is pending", async () => {
    const controller = new AbortController();
    const p = raceAbort(() => sleep(60_000).then(() => "late"), [controller.signal]);
    setTimeout(() => controller.abort(), 10);
    expect(await p).toBe(ABORTED);
  });

  it("resolves ABORTED immediately for an already-aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    expect(await raceAbort(() => sleep(60_000).then(() => "late"), [controller.signal])).toBe(ABORTED);
    expect(Date.now() - start).toBeLessThan(500);
  });

  it("resolves ABORTED when ANY of several signals aborts", async () => {
    const a = new AbortController();
    const b = new AbortController();
    const p = raceAbort(() => sleep(60_000).then(() => "late"), [a.signal, b.signal]);
    setTimeout(() => b.abort(), 10);
    expect(await p).toBe(ABORTED);
  });

  it("removes its abort listeners when the work wins the race", async () => {
    const controller = new AbortController();
    const spy = trackSignal(controller.signal);
    try {
      await raceAbort(() => Promise.resolve("done"), [controller.signal]);
    } finally {
      spy.restore();
    }
    expect(spy.added).toHaveLength(1);
    expect(spy.removed).toEqual(spy.added);
  });

  it("detaches remaining listeners when a signal aborts", async () => {
    const a = new AbortController();
    const b = new AbortController();
    const spyA = trackSignal(a.signal);
    const spyB = trackSignal(b.signal);
    try {
      const p = raceAbort(() => sleep(60_000), [a.signal, b.signal]);
      setTimeout(() => b.abort(), 10);
      expect(await p).toBe(ABORTED);
    } finally {
      spyA.restore();
      spyB.restore();
    }
    expect(spyA.removed).toEqual(spyA.added);
  });

  it("swallows a late work rejection after the abort won (no unhandled rejection)", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new AbortController();
      const p = raceAbort(
        () =>
          sleep(30).then(() => {
            throw new Error("late fail");
          }),
        [controller.signal],
      );
      setTimeout(() => controller.abort(), 5);
      expect(await p).toBe(ABORTED);
      // Let the work's rejection land and any unhandled report fire.
      await sleep(80);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen).toEqual([]);
  });
});
