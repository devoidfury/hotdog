// Tests for ToolContext class methods.

import { describe, it, expect } from "bun:test";
import { ToolContext } from "../../src/core/extensions/tool-context.ts";

describe("ToolContext", () => {
  it("creates empty context", () => {
    const ctx = new ToolContext();
    expect(ctx.keys()).toEqual([]);
    expect(ctx.toJSON()).toEqual({});
  });

  it("creates context with initial data", () => {
    const ctx = new ToolContext({ agent: "agent1", input: "input1" });
    expect(ctx.get("agent")).toBe("agent1");
    expect(ctx.get("input")).toBe("input1");
    expect(ctx.has("agent")).toBe(true);
    expect(ctx.has("missing")).toBe(false);
  });

  it("set adds/overwrites key-value pairs and supports chaining", () => {
    const ctx = new ToolContext({ key1: "old" });
    const result = ctx.set("key1", "new").set("key2", "value2");
    expect(result).toBe(ctx); // chaining
    expect(ctx.get("key1")).toBe("new");
    expect(ctx.get("key2")).toBe("value2");
  });

  it("get returns undefined for missing key", () => {
    expect(new ToolContext().get("missing")).toBeUndefined();
  });

  it("delete removes a key safely", () => {
    const ctx = new ToolContext({ key1: "value1" });
    expect(ctx.has("key1")).toBe(true);
    ctx.delete("key1");
    expect(ctx.has("key1")).toBe(false);
    expect(() => ctx.delete("missing")).not.toThrow();
  });

  it("keys returns all mounted keys", () => {
    const ctx = new ToolContext({ a: 1, b: 2, c: 3 });
    expect(ctx.keys().sort()).toEqual(["a", "b", "c"]);
  });

  it("toJSON returns a plain object", () => {
    const ctx = new ToolContext({ agent: "agent1", input: "input1" });
    const json = ctx.toJSON();
    expect(json).toEqual({ agent: "agent1", input: "input1" });
    expect(Array.isArray(json)).toBe(false);
  });

  it("mount adds multiple properties and supports chaining", () => {
    const ctx = new ToolContext({ key1: "old" });
    const result = ctx.mount({ key1: "new", key2: "value2" });
    expect(result).toBe(ctx); // chaining
    expect(ctx.get("key1")).toBe("new");
    expect(ctx.get("key2")).toBe("value2");
  });

  it("supports complex, null, and undefined values", () => {
    const ctx = new ToolContext();
    const obj = { nested: { value: 1 } };
    ctx.set("object", obj).set("array", [1, 2, 3]).set("nullVal", null).set("undefVal", undefined);
    expect(ctx.get("object")).toBe(obj);
    expect(ctx.get("array")).toEqual([1, 2, 3]);
    expect(ctx.has("nullVal")).toBe(true);
    expect(ctx.get("nullVal")).toBeNull();
    expect(ctx.get("undefVal")).toBeUndefined();
  });
});
