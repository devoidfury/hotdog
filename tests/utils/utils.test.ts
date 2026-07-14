import { describe, it, expect } from "bun:test";
import { validateNameable } from "../../src/utils/file-utils.ts";
import { deepMerge } from "../../src/utils/objects.ts";

const hasWarning = (warnings, substring) =>
  warnings.some((w) => w.includes(substring));

describe("validateNameable", () => {
  it("returns no warnings for valid names", () => {
    expect(validateNameable("my-tool", "Tool", "my-tool")).toEqual([]);
    expect(validateNameable("my-tool-name", "Tool", "my-tool-name")).toEqual([]);
    expect(validateNameable("tool-123", "Tool", "tool-123")).toEqual([]);
    expect(validateNameable("a", "Tool", "a")).toEqual([]);
    expect(validateNameable("a".repeat(64), "Tool", "a".repeat(64))).toEqual([]);
  });

  it("warns for name mismatches and empty names", () => {
    expect(hasWarning(validateNameable("my-tool", "Tool", "different"), "does not match")).toBe(true);
    expect(hasWarning(validateNameable("", "Tool", "my-tool"), "name is empty")).toBe(true);
    expect(hasWarning(validateNameable(null, "Tool", "my-tool"), "name is empty")).toBe(true);
  });

  it("warns for invalid characters and formatting", () => {
    expect(hasWarning(validateNameable("MyTool", "Tool", "mytool"), "contains invalid character")).toBe(true);
    expect(hasWarning(validateNameable("my_tool", "Tool", "my-tool"), "contains invalid character")).toBe(true);
    expect(hasWarning(validateNameable("my tool", "Tool", "my-tool"), "contains invalid character")).toBe(true);
    expect(hasWarning(validateNameable("-tool", "Tool", "tool"), "must not start or end with a hyphen")).toBe(true);
    expect(hasWarning(validateNameable("tool--name", "Tool", "tool-name"), "must not contain consecutive hyphens")).toBe(true);
    expect(hasWarning(validateNameable("a".repeat(65), "Tool", "a".repeat(65)), "exceeds 64 characters")).toBe(true);
  });

  it("accumulates multiple warnings", () => {
    const warnings = validateNameable("-MyTool--", "Tool", "different");
    expect(warnings.length).toBeGreaterThan(1);
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

  it("deeply merges nested plain objects", () => {
    const result = deepMerge({ a: { b: 1, c: 2 } }, { a: { c: 3, d: 4 } });
    expect(result).toEqual({ a: { b: 1, c: 3, d: 4 } });
  });

  it("handles deeply nested merging (3+ levels)", () => {
    const result = deepMerge(
      { a: { b: { c: { d: 1, e: 2 } } } },
      { a: { b: { c: { e: 3, f: 4 } } } },
    );
    expect(result).toEqual({ a: { b: { c: { d: 1, e: 3, f: 4 } } } });
  });

  it("replaces arrays (does not concatenate)", () => {
    expect(deepMerge({ items: [1, 2, 3] }, { items: [4, 5] })).toEqual({ items: [4, 5] });
  });

  it("handles null, undefined, primitives, and empty sources", () => {
    expect(deepMerge({ a: 1 }, null, undefined, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(deepMerge({ a: { nested: { x: 1 } } }, { a: 42 })).toEqual({ a: 42 });
    expect(deepMerge({ a: 1 }, {}, { b: 2 })).toEqual({ a: 1, b: 2 });
    expect(deepMerge()).toEqual({});
    expect(deepMerge({ a: 1 }, "string", { b: 2 })).toEqual({ a: 1, b: 2 });
  });

  it("preserves non-plain-object values like Date", () => {
    const date = new Date("2024-01-01");
    const result = deepMerge({ ts: date }, { other: true });
    expect(result.ts).toBe(date);
    expect(result.other).toBe(true);
  });
});
