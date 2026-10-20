// KeySource seam contract (§11): MemoryKeySource is the scripted stdin the
// stage-3 StdinBuffer will sit behind. Input stops ONLY by unsubscribing --
// the seam has no pause path at all, which is the pitfall-6 lesson pinned in
// the type (steal 20: pin listener state on every path).

import { describe, it, expect } from "bun:test";
import { MemoryKeySource } from "@utils/cli/renderer/memory-keysource.ts";

describe("MemoryKeySource (KeySource seam)", () => {
  it("delivers raw chunks to every subscriber, in push order", () => {
    const ks = new MemoryKeySource();
    const a: string[] = [];
    const b: string[] = [];
    ks.onData((c) => a.push(c));
    ks.onData((c) => b.push(c));
    ks.push("\x1b[A");
    ks.push("x");
    expect(a).toEqual(["\x1b[A", "x"]);
    expect(b).toEqual(["\x1b[A", "x"]);
    expect(ks.listenerCount).toBe(2);
  });

  it("unsubscribe stops delivery and drops the listener count", () => {
    const ks = new MemoryKeySource();
    const got: string[] = [];
    const off = ks.onData((c) => got.push(c));
    ks.push("a");
    off();
    ks.push("b");
    off(); // double unsubscribe is a no-op
    expect(got).toEqual(["a"]);
    expect(ks.listenerCount).toBe(0);
  });

  it("push with no subscribers is inert", () => {
    const ks = new MemoryKeySource();
    expect(() => ks.push("hello")).not.toThrow();
  });
});
