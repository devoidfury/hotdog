// Tests for tool filtering via Agent.getToolDefs().

import { describe, it, expect } from "bun:test";
import { create } from "../../src/extensions/core-tools/index.ts";
import { createToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { createHooks } from "../../src/core/hooks.ts";
import { Agent } from "../../src/core/agent.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

describe("Tool Filtering (Agent.getToolDefs)", () => {
  function createMockCore(config: Record<string, unknown> = {}) {
    const toolRegistry = createToolRegistry();
    const hooks = createHooks();
    const core: CoreContext = {
      hooks,
      toolRegistry,
      extensions: {} as any,
      services: {} as any,
      completion: { register: () => {}, request: async () => [] } as any,
      config: { ...config } as any,
      cliSubcommandRegistry: {} as any,
      configRegistry: { validateConfigByKey: () => ({ valid: true, errors: [] }) } as any,
      toolFormatRegistry: {} as any,
      llmProtocolRegistry: {} as any,
      createLlmClient: (() => { throw new Error("not implemented in test"); }) as any,
      service: () => null,
    };

    // Register core tools
    const ext = create(core);
    if (ext.hooks?.["tools:register"]) {
      ext.hooks["tools:register"]({
        register: (name: string, tool: any) => core.toolRegistry.register(name, tool),
        getAll: () => core.toolRegistry.getAll(),
      } as any);
    }

    return core;
  }

  function createAgent(
    core: CoreContext,
    configOverrides: Record<string, unknown> = {},
    modelRegistry: Record<string, any> = {},
  ) {
    return new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient: {
        chatStreamCancellable: async () => ({ [Symbol.asyncIterator]: async function* () {} }),
      } as any,
      model: "test/model",
      maxIterations: 10,
      contextLimit: 4096,
      config: {
        maxToolCallsPerIteration: 10,
        maxRetries: 5,
        toolRetryDelay: 1,
        ...core.config,
        ...configOverrides,
      } as any,
      modelRegistry,
    });
  }

  it("returns all tools when no filtering is configured", async () => {
    const core = createMockCore({
      sandboxMode: false,
      maxToolDifficulty: null,
      defaultMaxToolDifficulty: null,
    });
    const agent = createAgent(core);

    const toolDefs = await agent.getToolDefs();
    const names = toolDefs.map((d: any) => d.function.name);

    // Should include both safe and unsafe tools
    expect(names).toContain("read");
    expect(names).toContain("overwrite");
    expect(names).toContain("append");
    expect(names).toContain("edit");
  });

  it("filters out tools with side effects in sandbox mode", async () => {
    const core = createMockCore({ sandboxMode: true, maxToolDifficulty: null });
    const agent = createAgent(core);

    const toolDefs = await agent.getToolDefs();
    const names = toolDefs.map((d: any) => d.function.name);

    // Safe tools should be included
    expect(names).toContain("read");
    expect(names).toContain("grep");
    expect(names).toContain("find");

    // Write tools should be excluded
    expect(names).not.toContain("overwrite");
    expect(names).not.toContain("append");
    expect(names).not.toContain("edit");
  });

  it("filters out high-difficulty tools when CLI maxToolDifficulty is set", async () => {
    const core = createMockCore({ sandboxMode: false, maxToolDifficulty: 1 });
    const agent = createAgent(core);

    const toolDefs = await agent.getToolDefs();
    const names = toolDefs.map((d: any) => d.function.name);

    // Easy tools (difficulty 1) should be included
    expect(names).toContain("read");
    expect(names).toContain("overwrite");
    expect(names).toContain("grep");

    // Medium difficulty tools should be excluded
    expect(names).not.toContain("edit"); // difficulty 2
  });

  it("applies modelConfig maxToolDifficulty over config defaultMaxToolDifficulty", async () => {
    const core = createMockCore({ sandboxMode: false, defaultMaxToolDifficulty: 5 });
    const agent = createAgent(core, {}, { "test/model": { maxToolDifficulty: 1 } });

    const toolDefs = await agent.getToolDefs();
    const names = toolDefs.map((d: any) => d.function.name);

    // Should use model config (1) not config default (5)
    expect(names).toContain("read");
    expect(names).not.toContain("edit"); // difficulty 2
  });

  it("applies CLI maxToolDifficulty over model and config defaults", async () => {
    const core = createMockCore({
      sandboxMode: false,
      maxToolDifficulty: 1, // CLI override
      defaultMaxToolDifficulty: 5, // config default (should be ignored)
    });
    const agent = createAgent(core, {}, { "test/model": { maxToolDifficulty: 3 } });

    const toolDefs = await agent.getToolDefs();
    const names = toolDefs.map((d: any) => d.function.name);

    // Should use CLI (1) — edit is difficulty 2, so excluded
    expect(names).toContain("read");
    expect(names).not.toContain("edit");
  });

  it("applies both sandbox mode and CLI difficulty filtering together", async () => {
    const core = createMockCore({ sandboxMode: true, maxToolDifficulty: 1 });
    const agent = createAgent(core);

    const toolDefs = await agent.getToolDefs();
    const names = toolDefs.map((d: any) => d.function.name);

    // Only safe AND easy tools
    expect(names).toContain("read");
    expect(names).toContain("grep");
    expect(names).not.toContain("overwrite"); // has side effects
    expect(names).not.toContain("edit"); // has side effects AND difficulty 2
  });

  it("rejects tools without metadata at registration time", () => {
    const core = createMockCore({ sandboxMode: true });

    // Registering a tool without metadata should throw
    const toolNoMeta = {
      toToolDef: () => ({
        type: "function",
        function: { name: "no_meta_tool", description: "no meta", parameters: {} },
      }),
      callDisplay: () => "no_meta_tool",
      execute: async () => "ok",
      // no metadata
    };

    expect(() => {
      core.toolRegistry.register("no_meta_tool", toolNoMeta as any);
    }).toThrow('Tool "no_meta_tool" is missing required metadata');
  });

  it("rejects tool names outside the OpenAI function-name charset at registration", () => {
    const core = createMockCore({ sandboxMode: true });
    const tool = {
      toToolDef: () => ({
        type: "function",
        function: { name: "x", description: "x", parameters: {} },
      }),
      callDisplay: () => "x",
      execute: async () => "ok",
      metadata: { sideEffects: false, difficulty: 1 },
    };

    // A "/" (e.g. "server/tool" from MCP or a hand-rolled extension) would be
    // rejected by strict OpenAI-compatible APIs for the whole request.
    expect(() => core.toolRegistry.register("server/tool", tool as any)).toThrow(
      'Tool name "server/tool" is invalid',
    );
    expect(() => core.toolRegistry.register("bad name", tool as any)).toThrow(
      'Tool name "bad name" is invalid',
    );
    expect(() => core.toolRegistry.register("", tool as any)).toThrow(
      'Tool name "" is invalid',
    );

    // Valid names still register fine.
    expect(() => core.toolRegistry.register("good-name_1", tool as any)).not.toThrow();
  });
});
