// Tests for ToolRegistry caching and enhanced ToolResult.

import { describe, it, expect, test } from "bun:test";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { ToolResult } from "../../src/core/extensions/tool-utils.ts";
import { Agent } from "../../src/core/agent.ts";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";
import { createToolRegistry } from "../../src/core/extensions/tool-registry.ts";

describe("ToolRegistry", () => {
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

describe("ToolResult", () => {
  it("supports metadata via withEntries for structured data", () => {
    // Metadata already supports arbitrary string values — callers can
    // JSON.stringify objects to pass structured data through metadata.
    const result = ToolResult.ok("success").withEntries({
      data: JSON.stringify({ key: "value", count: 42 }),
    });
    const xml = result.toApiContent("test_tool");
    expect(xml).toContain("<data>");
    expect(xml).toContain('"key":"value"');
  });
});

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
