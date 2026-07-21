// Tests for utils/objects.ts — getNested, stripNulls, deepMerge.

import { describe, it, expect } from "bun:test";
import { getNested, stripNulls, deepMerge } from "../../src/utils/objects.ts";

describe("getNested", () => {
  it("returns top-level and nested properties", () => {
    expect(getNested<string>({ url: "http://test" }, "url")).toBe("http://test");
    expect(getNested<number>({ nested: { value: 42 } }, "nested.value")).toBe(42);
    expect(getNested<number>({ a: { b: { c: { d: 42 } } } }, "a.b.c.d")).toBe(42);
  });

  it("returns undefined for missing, null, or empty paths", () => {
    expect(getNested({ a: 1 }, "b.c")).toBeUndefined();
    expect(getNested({ a: null }, "a.b")).toBeUndefined();
    expect(getNested(null, "a.b")).toBeUndefined();
    expect(getNested({ a: 1 }, "")).toBeUndefined();
    expect(getNested({ a: 42 }, "a.b")).toBeUndefined();
  });
});

describe("stripNulls", () => {
  it("removes null values only", () => {
    const result = stripNulls({ a: 1, b: null, c: "hello" });
    expect(result).toEqual({ a: 1, c: "hello" });
  });

  it("preserves other falsy values", () => {
    const result = stripNulls({ a: 0, b: false, c: "", d: undefined, e: null });
    expect(result).toEqual({ a: 0, b: false, c: "", d: undefined });
    expect(result).not.toHaveProperty("e");
  });

  it("handles edge cases", () => {
    expect(stripNulls({ a: null, b: null })).toEqual({});
    expect(stripNulls({})).toEqual({});
    // Shallow — nested nulls are preserved
    expect(stripNulls({ a: { b: 1, c: null }, d: null })).toEqual({ a: { b: 1, c: null } });
  });
});

describe("deepMerge", () => {
  it("merges top-level keys without mutating sources", () => {
    const a = { x: 1 };
    const b = { y: 2 };
    const result = deepMerge(a, b);
    expect(result).toEqual({ x: 1, y: 2 });
    expect(a).toEqual({ x: 1 });
    expect(b).toEqual({ y: 2 });
  });

  it("later source overrides earlier for same key", () => {
    expect(deepMerge({ x: 1 }, { x: 2 })).toEqual({ x: 2 });
  });

  it("deeply merges nested plain objects (3+ levels)", () => {
    const result = deepMerge(
      { a: { b: { c: { d: 1, e: 2 } } } },
      { a: { b: { c: { e: 3, f: 4 } } } },
    );
    expect(result).toEqual({ a: { b: { c: { d: 1, e: 3, f: 4 } } } });
  });

  it("replaces arrays and non-plain-object values", () => {
    expect(deepMerge({ items: [1, 2, 3] }, { items: [4, 5] })).toEqual({ items: [4, 5] });
    const date = new Date("2024-01-01");
    const result = deepMerge({ ts: date }, { other: true });
    expect(result.ts).toBe(date);
    expect(result.other).toBe(true);
  });

  it("handles null, undefined, primitives, and empty sources", () => {
    expect(deepMerge({ a: 1 }, null, undefined, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(deepMerge({ a: { nested: { x: 1 } } }, { a: 42 })).toEqual({ a: 42 });
    expect(deepMerge({ a: 1 }, {}, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(deepMerge()).toEqual({});
    expect(deepMerge({ a: 1 }, "string", { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("handles multiple sources", () => {
    expect(deepMerge({ a: 1 }, { b: 2 }, { c: 3 })).toEqual({ a: 1, b: 2, c: 3 });
  });
});
