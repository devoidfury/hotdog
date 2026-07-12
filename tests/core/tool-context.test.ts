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
  });

  it("set adds a key-value pair", () => {
    const ctx = new ToolContext();
    ctx.set("key1", "value1");
    expect(ctx.get("key1")).toBe("value1");
  });

  it("set returns this for chaining", () => {
    const ctx = new ToolContext();
    const result = ctx.set("key1", "value1");
    expect(result).toBe(ctx);
  });

  it("get returns undefined for missing key", () => {
    const ctx = new ToolContext();
    expect(ctx.get("missing")).toBeUndefined();
  });

  it("has checks for key existence", () => {
    const ctx = new ToolContext({ key1: "value1" });
    expect(ctx.has("key1")).toBe(true);
    expect(ctx.has("key2")).toBe(false);
  });

  it("delete removes a key", () => {
    const ctx = new ToolContext({ key1: "value1" });
    expect(ctx.has("key1")).toBe(true);
    ctx.delete("key1");
    expect(ctx.has("key1")).toBe(false);
    expect(ctx.get("key1")).toBeUndefined();
  });

  it("delete on missing key does not throw", () => {
    const ctx = new ToolContext();
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
    expect(json).not.toBe(ctx._data); // should be a plain object, not the Map
  });

  it("mount adds multiple properties", () => {
    const ctx = new ToolContext();
    ctx.mount({ key1: "value1", key2: "value2" });
    expect(ctx.get("key1")).toBe("value1");
    expect(ctx.get("key2")).toBe("value2");
  });

  it("mount returns this for chaining", () => {
    const ctx = new ToolContext();
    const result = ctx.mount({ key1: "value1" });
    expect(result).toBe(ctx);
  });

  it("mount overwrites existing keys", () => {
    const ctx = new ToolContext({ key1: "old" });
    ctx.mount({ key1: "new" });
    expect(ctx.get("key1")).toBe("new");
  });

  it("set overwrites existing keys", () => {
    const ctx = new ToolContext({ key1: "old" });
    ctx.set("key1", "new");
    expect(ctx.get("key1")).toBe("new");
  });

  it("supports complex values", () => {
    const ctx = new ToolContext();
    const obj = { nested: { value: 1 } };
    const arr = [1, 2, 3];
    ctx.set("object", obj);
    ctx.set("array", arr);
    expect(ctx.get("object")).toBe(obj);
    expect(ctx.get("array")).toBe(arr);
  });

  it("supports null and undefined values", () => {
    const ctx = new ToolContext();
    ctx.set("nullValue", null);
    ctx.set("undefinedValue", undefined);
    expect(ctx.has("nullValue")).toBe(true);
    expect(ctx.has("undefinedValue")).toBe(true);
    expect(ctx.get("nullValue")).toBeNull();
    expect(ctx.get("undefinedValue")).toBeUndefined();
  });
});
