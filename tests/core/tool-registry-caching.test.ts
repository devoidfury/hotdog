// Tests for ToolRegistry caching.

import { describe, it, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { Agent } from "../../src/core/agent.ts";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";
import { createToolRegistry } from "../../src/core/extensions/tool-registry.ts";

describe("ToolRegistry — basic operations", () => {
  it("registers, gets, and checks tools", () => {
    const registry = new ToolRegistry();
    const tool = { execute: async () => "ok" };
    registry.register("my-tool", tool);
    expect(registry.has("my-tool")).toBe(true);
    expect(registry.get("my-tool")).toBe(tool);
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("getAll returns all registered tools", () => {
    const registry = new ToolRegistry();
    registry.register("a", { execute: async () => "a" });
    registry.register("b", { execute: async () => "b" });
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    const names = all.map(([name]) => name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("remove deletes a single tool and returns true", () => {
    const registry = new ToolRegistry();
    registry.register("my-tool", { execute: async () => "ok" });
    expect(registry.remove("my-tool")).toBe(true);
    expect(registry.has("my-tool")).toBe(false);
  });

  it("remove returns false for non-existent tool", () => {
    const registry = new ToolRegistry();
    expect(registry.remove("nonexistent")).toBe(false);
  });

  it("removeAll deletes multiple tools", () => {
    const registry = new ToolRegistry();
    registry.register("a", { execute: async () => "a" });
    registry.register("b", { execute: async () => "b" });
    registry.register("c", { execute: async () => "c" });
    expect(registry.removeAll(["a", "b", "nonexistent"])).toBe(2);
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(false);
    expect(registry.has("c")).toBe(true);
  });

  it("clear removes all tools", () => {
    const registry = new ToolRegistry();
    registry.register("a", { execute: async () => "a" });
    registry.register("b", { execute: async () => "b" });
    registry.clear();
    expect(registry.getAll()).toHaveLength(0);
  });

  it("filter with whitelist keeps only matching tools", () => {
    const registry = new ToolRegistry();
    registry.register("read", { execute: async () => "read" });
    registry.register("write", { execute: async () => "write" });
    registry.register("bash", { execute: async () => "bash" });
    const filtered = registry.filter(["read", "bash"]);
    expect(filtered.has("read")).toBe(true);
    expect(filtered.has("bash")).toBe(true);
    expect(filtered.has("write")).toBe(false);
  });

  it("filter with blacklist excludes matching tools", () => {
    const registry = new ToolRegistry();
    registry.register("read", { execute: async () => "read" });
    registry.register("write", { execute: async () => "write" });
    registry.register("bash", { execute: async () => "bash" });
    const filtered = registry.filter(undefined, ["write"]);
    expect(filtered.has("read")).toBe(true);
    expect(filtered.has("bash")).toBe(true);
    expect(filtered.has("write")).toBe(false);
  });

  it("filter with both whitelist and blacklist", () => {
    const registry = new ToolRegistry();
    registry.register("read", { execute: async () => "read" });
    registry.register("write", { execute: async () => "write" });
    registry.register("bash", { execute: async () => "bash" });
    const filtered = registry.filter(["read", "write", "bash"], ["write"]);
    expect(filtered.has("read")).toBe(true);
    expect(filtered.has("bash")).toBe(true);
    expect(filtered.has("write")).toBe(false);
  });
});

describe("ToolRegistry — validateToolArgs", () => {
  it("validates valid JSON string args", async () => {
    const registry = new ToolRegistry();
    registry.register("search", {
      toToolDef: () => ({
        type: "function",
        function: {
          name: "search",
          description: "Search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      }),
    });
    const err = await registry.validateToolArgs("search", '{"query": "hello"}');
    expect(err).toBeNull();
  });

  it("validates valid object args", async () => {
    const registry = new ToolRegistry();
    registry.register("search", {
      toToolDef: () => ({
        type: "function",
        function: {
          name: "search",
          description: "Search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      }),
    });
    const err = await registry.validateToolArgs("search", { query: "hello" });
    expect(err).toBeNull();
  });

  it("returns error for missing required field", async () => {
    const registry = new ToolRegistry();
    registry.register("search", {
      toToolDef: () => ({
        type: "function",
        function: {
          name: "search",
          description: "Search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      }),
    });
    const err = await registry.validateToolArgs("search", '{}');
    expect(err).toContain("query");
  });

  it("returns error for wrong type", async () => {
    const registry = new ToolRegistry();
    registry.register("search", {
      toToolDef: () => ({
        type: "function",
        function: {
          name: "search",
          description: "Search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      }),
    });
    const err = await registry.validateToolArgs("search", '{"query": 42}');
    expect(err).toContain("string");
  });

  it("returns error for non-object input", async () => {
    const registry = new ToolRegistry();
    registry.register("search", {
      toToolDef: () => ({
        type: "function",
        function: {
          name: "search",
          description: "Search",
          parameters: {
            type: "object",
            properties: { query: { type: "string" } },
            required: ["query"],
          },
        },
      }),
    });
    const err1 = await registry.validateToolArgs("search", null);
    expect(err1).toContain("null");
    const err2 = await registry.validateToolArgs("search", [1, 2]);
    expect(err2).toContain("array");
  });

  it("returns null for unregistered tool", async () => {
    const registry = new ToolRegistry();
    const err = await registry.validateToolArgs("nonexistent", '{}');
    expect(err).toBeNull();
  });

  it("returns null for tool without parameters schema", async () => {
    const registry = new ToolRegistry();
    registry.register("simple", {
      toToolDef: () => ({
        type: "function",
        function: {
          name: "simple",
          description: "Simple",
          parameters: { type: "object", properties: {} },
        },
      }),
    });
    const err = await registry.validateToolArgs("simple", '{"anything": "goes"}');
    expect(err).toBeNull();
  });
});

describe("ToolRegistry — caching", () => {
  it("caches tool definitions on first call", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;

    const tool = {
      toToolDef: () => {
        callCount++;
        return { type: "function", function: { name: "test", description: "test", parameters: { type: "object", properties: {} } } };
      },
    };

    registry.register("test", tool);

    // First call computes and caches
    const defs1 = await registry.getToolDefs();
    expect(callCount).toBe(1);

    // Second call uses cache
    const defs2 = await registry.getToolDefs();
    expect(callCount).toBe(1); // Still 1, not 2
    expect(defs1).toEqual(defs2);
  });

  it("invalidates cache when tool is re-registered", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;

    const tool = {
      toToolDef: () => {
        callCount++;
        return { type: "function", function: { name: "test", description: "v1", parameters: { type: "object", properties: {} } } };
      },
    };

    registry.register("test", tool);
    await registry.getToolDefs();
    expect(callCount).toBe(1);

    // Re-register with new toToolDef
    const tool2 = {
      toToolDef: () => {
        callCount++;
        return { type: "function", function: { name: "test", description: "v2", parameters: { type: "object", properties: {} } } };
      },
    };
    registry.register("test", tool2);

    // Cache should be invalidated, so toToolDef is called again
    const defs = await registry.getToolDefs();
    expect(callCount).toBe(2);
    expect(defs[0]!.function.description).toBe("v2");
  });

  it("clearToolDefs clears the cache", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;

    const tool = {
      toToolDef: () => {
        callCount++;
        return { type: "function", function: { name: "test", description: "test", parameters: { type: "object", properties: {} } } };
      },
    };

    registry.register("test", tool);
    await registry.getToolDefs();
    expect(callCount).toBe(1);

    registry.clearToolDefs();

    // After clearing, toToolDef should be called again
    await registry.getToolDefs();
    expect(callCount).toBe(2);
  });

  it("getToolDef caches individual tool definitions", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;

    const tool = {
      toToolDef: () => {
        callCount++;
        return { type: "function", function: { name: "test", description: "test", parameters: { type: "object", properties: {} } } };
      },
    };

    registry.register("test", tool);

    const def1 = await registry.getToolDef("test");
    expect(callCount).toBe(1);

    const def2 = await registry.getToolDef("test");
    expect(callCount).toBe(1); // Cached
    expect(def1).toEqual(def2);
  });

  it("getToolDef returns null for unregistered tools", async () => {
    const registry = new ToolRegistry();
    const def = await registry.getToolDef("nonexistent");
    expect(def).toBeNull();
  });

  it("validateToolArgs uses cached tool definition", async () => {
    const registry = new ToolRegistry();
    let callCount = 0;

    const tool = {
      toToolDef: () => {
        callCount++;
        return {
          type: "function",
          function: {
            name: "test",
            description: "test",
            parameters: {
              type: "object",
              properties: {
                query: { type: "string", description: "Search query" },
              },
              required: ["query"],
            },
          },
        };
      },
    };

    registry.register("test", tool);

    // First validation triggers cache
    const err1 = await registry.validateToolArgs("test", '{"query": "hello"}');
    expect(callCount).toBe(1);
    expect(err1).toBeNull();

    // Second validation uses cache
    const err2 = await registry.validateToolArgs("test", '{"query": "world"}');
    expect(callCount).toBe(1); // Still 1
    expect(err2).toBeNull();
  });
});

// NOTE: Full ToolResult tests are in tests/extensions/tool-utils-and-file-utils.test.ts

describe("Agent model setter clears tool def cache", () => {
  it("clears the tool registry cache when model changes", async () => {
    const hooks = new HookSystem();
    const toolRegistry = createToolRegistry();

    let callCount = 0;
    const tool = {
      toToolDef: () => {
        callCount++;
        return {
          type: "function",
          function: {
            name: "test",
            description: "test",
            parameters: { type: "object", properties: {} },
          },
        };
      },
      execute: async () => "ok",
    };
    toolRegistry.register("test", tool);

    const llmClient = {
      chatStreamCancellable: async function* () {},
    } as unknown as import("../../src/core/llm-client/client.ts").LlmClient;

    const agent = new Agent({
      hooks,
      toolRegistry,
      llmClient,
      model: "test-model-v1",
      modelRegistry: { "test-model-v1": {}, "test-model-v2": {} },
      maxIterations: 100,
      contextLimit: 128000,
    });

    // Prime the cache by getting tool defs
    await agent.getToolDefs();
    expect(callCount).toBe(1);

    // Switch model — should clear the cache
    agent.model = "test-model-v2";

    // Next getToolDefs should re-call toToolDef
    await agent.getToolDefs();
    expect(callCount).toBe(2);
  });
});
