// Tests for reactive-state.ts — reactive atoms and multi-dependency effects.

import { describe, it, expect } from "bun:test";
import { reactiveState, effect } from "../../src/utils/reactive-state.ts";

describe("reactiveState", () => {
  it("creates an atom with initial value", () => {
    const atom = reactiveState(0);
    expect(atom()).toBe(0);
  });

  it("sets and gets value", () => {
    const atom = reactiveState(0);
    atom(42);
    expect(atom()).toBe(42);
  });

  it("returns current value when setting", () => {
    const atom = reactiveState(0);
    const returned = atom(10);
    expect(returned).toBe(10);
    expect(atom()).toBe(10);
  });

  it("triggers effects on value change", () => {
    const atom = reactiveState(0);
    const calls: number[] = [];
    atom.effect(() => {
      calls.push(atom());
    });

    atom(1);
    atom(2);
    expect(calls).toEqual([1, 2]);
  });

  it("does not trigger effect when setting same primitive value", () => {
    const atom = reactiveState(42);
    const calls: number[] = [];
    atom.effect(() => {
      calls.push(atom());
    });

    atom(42); // same value
    expect(calls).toEqual([]);
  });

  it("always triggers effect for object values (reference change)", () => {
    const atom = reactiveState({ count: 0 });
    const calls: number[] = [];
    atom.effect(() => {
      calls.push(atom().count);
    });

    atom({ count: 1 });
    atom({ count: 2 });
    expect(calls).toEqual([1, 2]);
  });

  it("supports multiple effects", () => {
    const atom = reactiveState(0);
    const a: number[] = [];
    const b: number[] = [];

    atom.effect(() => { a.push(atom()); });
    atom.effect(() => { b.push(atom() * 2); });

    atom(5);
    expect(a).toEqual([5]);
    expect(b).toEqual([10]);
  });

  it("cleanup function unsubscribes effect", () => {
    const atom = reactiveState(0);
    const calls: number[] = [];

    const stop = atom.effect(() => {
      calls.push(atom());
    });

    atom(1);
    stop();
    atom(2);

    expect(calls).toEqual([1]); // only first change triggered
  });

  it("works with string values", () => {
    const atom = reactiveState("hello");
    expect(atom()).toBe("hello");
    atom("world");
    expect(atom()).toBe("world");
  });

  it("works with boolean values", () => {
    const atom = reactiveState(true);
    expect(atom()).toBe(true);
    atom(false);
    expect(atom()).toBe(false);
  });

  it("works with null/undefined values", () => {
    const atom = reactiveState(null as null | undefined);
    expect(atom()).toBeNull();
    atom(undefined);
    expect(atom()).toBeUndefined();
  });

  it("effect runs synchronously", () => {
    const atom = reactiveState(0);
    let effectValue = -1;

    atom.effect(() => {
      effectValue = atom();
    });

    atom(42);
    expect(effectValue).toBe(42); // synchronous, not async
  });
});

describe("effect (multi-dependency)", () => {
  it("runs immediately and subscribes to all dependencies", () => {
    const a = reactiveState(1);
    const b = reactiveState(2);
    const calls: number[] = [];

    const stop = effect(() => {
      calls.push(a() + b());
    }, [a, b]);

    expect(calls).toEqual([3]); // initial run

    a(10);
    expect(calls).toEqual([3, 12]);

    b(20);
    expect(calls).toEqual([3, 12, 30]);

    stop();
    a(100);
    expect(calls).toEqual([3, 12, 30]); // no more calls after stop
  });

  it("cleanup unsubscribes from all dependencies", () => {
    const a = reactiveState(0);
    const b = reactiveState(0);
    const calls: number[] = [];

    const stop = effect(() => {
      calls.push(a() + b());
    }, [a, b]);

    stop();
    a(1);
    b(1);
    expect(calls.length).toBe(1); // only initial call
  });

  it("works with single dependency", () => {
    const a = reactiveState(0);
    const calls: number[] = [];

    effect(() => {
      calls.push(a());
    }, [a]);

    expect(calls).toEqual([0]);
    a(5);
    expect(calls).toEqual([0, 5]);
  });

  it("works with no dependencies", () => {
    const calls: string[] = [];

    effect(() => {
      calls.push("run");
    }, []);

    expect(calls).toEqual(["run"]); // runs once initially
  });

  it("runs effect for each dependency change independently", () => {
    const a = reactiveState(0);
    const b = reactiveState(0);
    const calls: number[] = [];

    effect(() => {
      calls.push(a() + b());
    }, [a, b]);

    a(1); // calls: [0, 1]
    a(2); // calls: [0, 1, 2]
    b(10); // calls: [0, 1, 2, 12]
    expect(calls).toEqual([0, 1, 2, 12]);
  });

  it("throws when an effect throws", () => {
    const a = reactiveState(0);

    a.effect(() => { throw new Error("boom"); });

    expect(() => a(1)).toThrow("boom");
  });

  it("stops at first throwing effect (subsequent effects not run)", () => {
    const a = reactiveState(0);
    const calls: string[] = [];

    a.effect(() => { throw new Error("boom"); });
    a.effect(() => { calls.push("should not run"); });

    expect(() => a(1)).toThrow("boom");
    expect(calls).toEqual([]); // second effect never runs
  });

  it("handles same object reference set twice", () => {
    const obj = { x: 1 };
    const atom = reactiveState(obj);
    const calls: number[] = [];

    atom.effect(() => { calls.push(atom().x); });

    atom(obj); // same reference — still triggers (objects always trigger)
    expect(calls.length).toBe(1); // triggered once for same reference
  });

  it("handles three or more dependencies", () => {
    const a = reactiveState(1);
    const b = reactiveState(2);
    const c = reactiveState(3);
    const calls: number[] = [];

    effect(() => {
      calls.push(a() + b() + c());
    }, [a, b, c]);

    expect(calls).toEqual([6]); // initial
    a(10);
    expect(calls).toEqual([6, 15]);
    b(20);
    expect(calls).toEqual([6, 15, 33]);
    c(30);
    expect(calls).toEqual([6, 15, 33, 60]);
  });
});
