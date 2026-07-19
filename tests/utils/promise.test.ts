// Tests for utils/promise.ts — isPromise.

import { describe, it, expect } from "bun:test";
import { isPromise } from "../../src/utils/promise.ts";

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
