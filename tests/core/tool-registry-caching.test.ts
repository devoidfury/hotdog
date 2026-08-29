// Tests for ToolRegistry caching.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { ToolRegistry, type Tool } from "../../src/core/extensions/tool-registry.ts";
import { Agent } from "../../src/core/agent.ts";
import { HookSystem } from "../../src/core/hooks.ts";
import { createToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { initializeLogger, resetLoggerForTesting } from "../../src/core/logger.ts";

/** Create a minimal test tool (def name defaults to the registered name) */
function mkTool(execute: () => unknown | Promise<unknown>, name = "test"): Tool {
  return {
    metadata: { sideEffects: false, difficulty: 1 },
    toToolDef: () => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }),
    callDisplay: () => `${name}()`,
    execute: async () => execute(),
  };
}

describe("ToolRegistry — basic operations", () => {
  it("registers, gets, and checks tools", () => {
    const registry = new ToolRegistry();
    const tool = mkTool(async () => "ok");
    registry.register("my-tool", tool);
    expect(registry.has("my-tool")).toBe(true);
    expect(registry.get("my-tool")).toBe(tool);
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("getAll returns all registered tools", () => {
    const registry = new ToolRegistry();
    registry.register("a", mkTool(async () => "a"));
    registry.register("b", mkTool(async () => "b"));
    const all = registry.getAll();
    expect(all).toHaveLength(2);
    const names = all.map(([name]) => name).sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("remove deletes a single tool and returns true", () => {
    const registry = new ToolRegistry();
    registry.register("my-tool", mkTool(async () => "ok"));
    expect(registry.remove("my-tool")).toBe(true);
    expect(registry.has("my-tool")).toBe(false);
  });

  it("remove returns false for non-existent tool", () => {
    const registry = new ToolRegistry();
    expect(registry.remove("nonexistent")).toBe(false);
  });

  it("removeAll deletes multiple tools", () => {
    const registry = new ToolRegistry();
    registry.register("a", mkTool(async () => "a"));
    registry.register("b", mkTool(async () => "b"));
    registry.register("c", mkTool(async () => "c"));
    expect(registry.removeAll(["a", "b", "nonexistent"])).toBe(2);
    expect(registry.has("a")).toBe(false);
    expect(registry.has("b")).toBe(false);
    expect(registry.has("c")).toBe(true);
  });

  it("clear removes all tools", () => {
    const registry = new ToolRegistry();
    registry.register("a", mkTool(async () => "a"));
    registry.register("b", mkTool(async () => "b"));
    registry.clear();
    expect(registry.getAll()).toHaveLength(0);
  });

  it("filter with whitelist keeps only matching tools", () => {
    const registry = new ToolRegistry();
    registry.register("read", mkTool(async () => "read"));
    registry.register("overwrite", mkTool(async () => "overwrite"));
    registry.register("bash", mkTool(async () => "bash"));
    const filtered = registry.filter(["read", "bash"]);
    expect(filtered.has("read")).toBe(true);
    expect(filtered.has("bash")).toBe(true);
    expect(filtered.has("overwrite")).toBe(false);
  });

  it("filter with blacklist excludes matching tools", () => {
    const registry = new ToolRegistry();
    registry.register("read", mkTool(async () => "read"));
    registry.register("overwrite", mkTool(async () => "overwrite"));
    registry.register("bash", mkTool(async () => "bash"));
    const filtered = registry.filter(undefined, ["overwrite"]);
    expect(filtered.has("read")).toBe(true);
    expect(filtered.has("bash")).toBe(true);
    expect(filtered.has("overwrite")).toBe(false);
  });

  it("filter with both whitelist and blacklist", () => {
    const registry = new ToolRegistry();
    registry.register("read", mkTool(async () => "read"));
    registry.register("overwrite", mkTool(async () => "overwrite"));
    registry.register("bash", mkTool(async () => "bash"));
    const filtered = registry.filter(["read", "overwrite", "bash"], ["overwrite"]);
    expect(filtered.has("read")).toBe(true);
    expect(filtered.has("bash")).toBe(true);
    expect(filtered.has("overwrite")).toBe(false);
  });
});

describe("ToolRegistry — validateToolArgs", () => {
  const searchToolDef = () => ({
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
  });

  const searchTool = {
    metadata: { sideEffects: false, difficulty: 1 },
    toToolDef: searchToolDef,
    callDisplay: () => "search()",
    execute: async () => "ok",
  };

  it("validates valid JSON string args", async () => {
    const registry = new ToolRegistry();
    registry.register("search", searchTool);
    const err = await registry.validateToolArgs("search", '{"query": "hello"}');
    expect(err).toBeNull();
  });

  it("validates valid object args", async () => {
    const registry = new ToolRegistry();
    registry.register("search", searchTool);
    const err = await registry.validateToolArgs("search", { query: "hello" });
    expect(err).toBeNull();
  });

  it("returns error for missing required field", async () => {
    const registry = new ToolRegistry();
    registry.register("search", searchTool);
    const err = await registry.validateToolArgs("search", '{}');
    expect(err).toContain("query");
  });

  it("returns error for wrong type", async () => {
    const registry = new ToolRegistry();
    registry.register("search", searchTool);
    const err = await registry.validateToolArgs("search", '{"query": 42}');
    expect(err).toContain("string");
  });

  it("returns error for non-object input", async () => {
    const registry = new ToolRegistry();
    registry.register("search", searchTool);
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
      metadata: { sideEffects: false, difficulty: 1 },
      toToolDef: () => ({
        type: "function",
        function: {
          name: "simple",
          description: "Simple",
          parameters: { type: "object", properties: {} },
        },
      }),
      callDisplay: () => "simple()",
      execute: async () => "ok",
    });
    const err = await registry.validateToolArgs("simple", '{"anything": "goes"}');
    expect(err).toBeNull();
  });
});

describe("ToolRegistry — caching", () => {
  function mkCountedTool(name: string, desc: string, counter: { value: number }) {
    return {
      metadata: { sideEffects: false, difficulty: 1 },
      toToolDef: () => {
        counter.value++;
        return { type: "function", function: { name, description: desc, parameters: { type: "object", properties: {} } } };
      },
      callDisplay: () => `${name}()`,
      execute: async () => "ok",
    } as Tool;
  }

  it("caches tool definitions and serves from cache on repeated calls", async () => {
    const registry = new ToolRegistry();
    const counter = { value: 0 };
    registry.register("test", mkCountedTool("test", "test", counter));

    const defs1 = await registry.getToolDefs();
    expect(counter.value).toBe(1);

    const defs2 = await registry.getToolDefs();
    expect(counter.value).toBe(1); // cached
    expect(defs1).toEqual(defs2);
  });

  it("invalidates cache when tool is re-registered", async () => {
    const registry = new ToolRegistry();
    const counter = { value: 0 };

    registry.register("test", mkCountedTool("test", "v1", counter));
    await registry.getToolDefs();
    expect(counter.value).toBe(1);

    // Re-register with new toToolDef
    registry.register("test", mkCountedTool("test", "v2", counter));

    const defs = await registry.getToolDefs();
    expect(counter.value).toBe(2);
    expect(defs[0]!.function.description).toBe("v2");
  });

  it("clearToolDefs clears the cache", async () => {
    const registry = new ToolRegistry();
    const counter = { value: 0 };
    registry.register("test", mkCountedTool("test", "test", counter));

    await registry.getToolDefs();
    expect(counter.value).toBe(1);

    registry.clearToolDefs();
    await registry.getToolDefs();
    expect(counter.value).toBe(2);
  });

  it("getToolDef caches individual tool definitions", async () => {
    const registry = new ToolRegistry();
    const counter = { value: 0 };
    registry.register("test", mkCountedTool("test", "test", counter));

    await registry.getToolDef("test");
    await registry.getToolDef("test");
    expect(counter.value).toBe(1); // cached
  });

  it("getToolDef returns null for unregistered tools", async () => {
    const registry = new ToolRegistry();
    expect(await registry.getToolDef("nonexistent")).toBeNull();
  });

  it("validateToolArgs uses cached tool definition", async () => {
    const registry = new ToolRegistry();
    const counter = { value: 0 };

    const tool: Tool = {
      metadata: { sideEffects: false, difficulty: 1 },
      toToolDef: () => {
        counter.value++;
        return {
          type: "function",
          function: {
            name: "test",
            description: "test",
            parameters: {
              type: "object",
              properties: { query: { type: "string", description: "Search query" } },
              required: ["query"],
            },
          },
        };
      },
      callDisplay: () => "test()",
      execute: async () => "ok",
    };

    registry.register("test", tool);

    await registry.validateToolArgs("test", '{"query": "hello"}');
    await registry.validateToolArgs("test", '{"query": "world"}');
    expect(counter.value).toBe(1); // cached
  });
});

describe("ToolRegistry — getToolDefs error handling", () => {
  const hooks = new HookSystem();
  const warnings: string[] = [];

  beforeAll(() => {
    hooks.on("log", (data: { level: string; message: string }) => {
      if (data.level === "warn") warnings.push(data.message);
    });
    resetLoggerForTesting();
    initializeLogger({ hooks, minLevel: "debug", target: "none" });
  });

  afterAll(() => {
    resetLoggerForTesting();
  });

  afterEach(() => {
    warnings.length = 0;
  });

  it("skips a tool whose toToolDef throws and logs the tool's actual name", async () => {
    const registry = new ToolRegistry();
    registry.register("good", mkTool(async () => "ok", "good"));
    registry.register("broken", {
      metadata: { sideEffects: false, difficulty: 1 },
      toToolDef: () => {
        throw new Error("boom");
      },
      callDisplay: () => "broken()",
      execute: async () => "ok",
    });

    const defs = await registry.getToolDefs();
    // Only the healthy tool survives, under its own registered name.
    expect(defs.map((d) => d.function.name)).toEqual(["good"]);

    // The failed tool must be named in the warning, not "unknown".
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('for "broken"');
    expect(warnings[0]).not.toContain('"unknown"');

    // The cache is not poisoned by a failure: the next call retries.
    const defs2 = await registry.getToolDefs();
    expect(defs2.map((d) => d.function.name)).toEqual(["good"]);
    expect(warnings.length).toBe(2);
  });
});

// NOTE: Full ToolResult tests are in tests/extensions/tool-utils.test.ts

describe("Agent model setter clears tool def cache", () => {
  it("clears the tool registry cache when model changes", async () => {
    const hooks = new HookSystem();
    const toolRegistry = createToolRegistry();

    let callCount = 0;
    const tool: Tool = {
      metadata: { sideEffects: false, difficulty: 1 },
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
      callDisplay: () => "test()",
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
      modelRegistry: {
        "test-model-v1": { name: "test-model-v1", temperature: 0.7, contextLimit: 128000, tags: [], capabilities: {} },
        "test-model-v2": { name: "test-model-v2", temperature: 0.7, contextLimit: 128000, tags: [], capabilities: {} },
      },
      maxIterations: 100,
      contextLimit: 128000,
      config: { maxToolCallsPerIteration: 10, maxRetries: 5, toolRetryDelay: 1 },
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
