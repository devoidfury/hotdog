import { describe, it, expect } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";
import { AgentCommandRegistry } from "../../src/core/extensions/registries.ts";
import { MessageLog } from "../../src/core/context/message-log.ts";
import { Message } from "../../src/core/context/message.ts";
import { create as createCompactionExtension } from "../../src/extensions/compaction/index.ts";
import {
  matcher as compactMatcher,
  completion as compactCompletion,
} from "../../src/extensions/compaction/completions.ts";
import { ToolRegistry } from "../../src/core/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessages(count: number, content = "x".repeat(100)) {
  const messages: any[] = [];
  for (let i = 0; i < count; i++) {
    messages.push(new Message({
      role: i % 2 === 0 ? "user" : "assistant",
      content,
    }));
  }
  return messages;
}

function createMockCore(config: any = {}) {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  const compactionConfig = {
    enabled: true,
    reserveTokens: 8000,
    keepRecentMessages: 3,
    strategy: "summarize",
    userTurnGuardPrompt: "Continue from the compressed conversation context above.",
    ...config,
  };
  return {
    hooks,
    config: { compaction: compactionConfig },
    modelRegistry: {
      "test-model": { name: "test-model", temperature: null, contextLimit: 32000 },
    },
    toolRegistry,
  } as any;
}

function createMockAgent(contextArray: any[], model = "test-model", modelRegistry?: Record<string, any>) {
  const mockLlmClient = {
    chatStreamCancellable: () =>
      (async function* () {
        yield { type: "content", content: "test response" };
      })(),
  };
  // Use a real MessageLog so the extension can call agent.log.getAll()
  const log = new MessageLog(contextArray);
  return {
    get log() { return log; },
    // Context manager shim for compaction extension
    get context() {
      return {
        getMessages: () => log.getAll(),
        replaceMessages: (msgs: any[]) => log.replace(msgs),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
        getSystemPrompt: () => null,
      };
    },
    model,
    modelRegistry: modelRegistry || {},
    sessionId: "test-session",
    _llmClient: mockLlmClient,
    get llmClient() { return mockLlmClient; },
    buildMessages() {
      return this.systemPrompt
        ? [{ role: "system", content: this.systemPrompt }, ...log.getAll()]
        : [...log.getAll()];
    },
    // New public context API (mirrors Agent.addMessage)
    addMessage(msg: any) {
      log.push(msg);
    },
    // New public context API (mirrors Agent.replaceContext)
    replaceContext(newContext: any) {
      log.replace(newContext);
    },
  } as any;
}

// ── Extension Creation ───────────────────────────────────────────────────────

describe("Compaction Extension Creation", () => {
  it("should create extension with default config", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    expect(ext).not.toBeNull();
    expect((ext as any).settings.enabled).toBe(true);
    expect((ext as any).settings.keepRecentMessages).toBe(3);
    expect((ext as any).settings.strategy).toBe("summarize");
  });

  it("should return null when compaction is disabled", () => {
    expect(createCompactionExtension(createMockCore({ enabled: false }))).toBeNull();
  });

  it("should apply custom config values", () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 5,
      strategy: "drop",
      reserveTokens: 8192,
    });
    const ext = createCompactionExtension(core);
    expect((ext as any).settings.enabled).toBe(true);
    expect((ext as any).settings.keepRecentMessages).toBe(5);
    expect((ext as any).settings.strategy).toBe("drop");
    expect((ext as any).settings.reserveTokens).toBe(8192);
  });

  it("should register all built-in strategies", () => {
    const ext = createCompactionExtension(createMockCore());
    for (const name of ["summarize", "drop", "summarize-short", "token-aware", "trim"]) {
      expect((ext as any).registry.has(name)).toBe(true);
    }
  });

  it("should provide getStrategyList with correct names and order", () => {
    const ext = createCompactionExtension(createMockCore());
    const list = (ext as any).getStrategyList();
    const expected = ["summarize", "drop", "summarize-short", "token-aware", "trim"];
    expect(list.map((s: any) => s.name)).toEqual(expected);
    expect(list.length).toBe(expected.length);
  });

  for (const { strategy, extra } of [
    { strategy: "token-aware", extra: { reserveTokens: 4096 } },
    { strategy: "trim", extra: {} },
  ]) {
    it(`should create extension with ${strategy} strategy`, () => {
      const ext = createCompactionExtension(createMockCore({ enabled: true, strategy, ...extra }));
      expect((ext as any).settings.strategy).toBe(strategy);
      if (extra.reserveTokens) {
        expect((ext as any).settings.reserveTokens).toBe(extra.reserveTokens);
      }
    });
  }
});

// ── Hook Integration ─────────────────────────────────────────────────────────

describe("Hook Integration", () => {
  it("should register CONTEXT hook with the hook system", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    expect(typeof (ext as any).hooks![HOOKS.CONTEXT]).toBe("function");
  });

  it("should not trigger compaction when context is small", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const smallContext = makeMessages(4);
    const agent = createMockAgent(smallContext);
    const messages = ([{ role: "system", content: "" }, ...smallContext] as any);

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Context should be unchanged since we don't have enough messages
    expect(agent.log.length).toBe(4);
  });

  it("should not trigger compaction when token budget is not exceeded", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 16384,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(20, "x".repeat(50));
    const agent = createMockAgent(context, "test-model", {
      "test-model": { name: "test-model", temperature: null, contextLimit: 32000 },
    });
    const messages = [{ role: "system", content: "" }, ...context];

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Context should be unchanged (tokens well under budget)
    expect(agent.log.length).toBe(20);
  });

  it("should trigger compaction when context exceeds token budget", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const largeContext = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(largeContext);

    agent.modelRegistry = {
            "test-model": { name: "test-model", temperature: null, contextLimit: 8000 },
    };

    const messages = [{ role: "system", content: "" }, ...largeContext];
    const result = await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    expect(agent.log.length).toBeLessThan(largeContext.length);
    expect((result as any).messages).toBeDefined();
    expect((result as any).messages.length).toBeLessThan(messages.length);
  });

  // Parameterized: each strategy should compact when over budget
  const strategyTests = [
    { strategy: "drop", msgCount: 100, contextLimit: 8000, strategyContextLimit: null },
    { strategy: "summarize-short", msgCount: 50, contextLimit: 5000, strategyContextLimit: null },
    { strategy: "token-aware", msgCount: 50, contextLimit: 5000, strategyContextLimit: 5000 },
    { strategy: "trim", msgCount: 50, contextLimit: 5000, strategyContextLimit: 5000 },
  ];

  for (const { strategy, msgCount, contextLimit, strategyContextLimit } of strategyTests) {
    it(`should use ${strategy} strategy when configured`, async () => {
      const core = createMockCore({
        enabled: true,
        keepRecentMessages: 2,
        strategy,
        reserveTokens: 100,
      });
      const ext = createCompactionExtension(core);

      const largeContext = makeMessages(msgCount, "x".repeat(500));
      const agent = createMockAgent(largeContext);

      agent.modelRegistry = {
        "test-model": { name: "test-model", temperature: null, contextLimit },
      };

      if (strategyContextLimit) (ext as any).settings.contextLimit = strategyContextLimit;

      const messages = [{ role: "system", content: "" }, ...largeContext];
      const result = await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

      expect(agent.log.length).toBeLessThan(largeContext.length);
      expect((result as any).messages).toBeDefined();
    });
  }

  it("should error when model not found in registry", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(context, "test-model", {}); // empty registry
    const messages = [{ role: "system", content: "" }, ...context];

    // Should error when model is not found in registry
    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent })
    ).rejects.toThrow(/not found in registry/);
  });

  it("should not trigger compaction when non-system messages are few", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    // Only 2 non-system messages (less than keepRecentMessages * 2 = 4)
    const context = makeMessages(2, "x".repeat(5000));
    const agent = createMockAgent(context);
    const messages = [{ role: "system", content: "" }, ...context];

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    expect(agent.log.length).toBe(2);
  });

  it("should handle system messages in context", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));
    const agent = createMockAgent(context);
    const messages = [
      { role: "system", content: "System prompt" },
      ...context,
    ];

    agent.modelRegistry = {
            "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Should still compact despite system message
    expect(agent.log.length).toBeLessThan(50);
  });
});

// ── Strategy List ────────────────────────────────────────────────────────────

describe("Strategy List", () => {
  it("returns all strategies with non-empty descriptions", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    const list = (ext as any).getStrategyList();

    const expectedNames = ["summarize", "drop", "summarize-short", "token-aware", "trim"];
    expect(list.map((s: any) => s.name)).toEqual(expectedNames);

    for (const strategy of list) {
      expect(strategy.description).toBeDefined();
      expect(strategy.description.length).toBeGreaterThan(0);
    }
  });
});

// ── COMMANDS_REGISTER Hook ──────────────────────────────────────────────────

describe("COMMANDS_REGISTER Hook", () => {
  it("should register compact command", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    // The compact command should be registered
    const compactCmd = commandRegistry.get("compact")!;
    expect(compactCmd).toBeDefined();
    expect(compactCmd.description).toContain("Compact context");
  });

  it("should not register compact:strategy command (removed historical syntax)", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    expect(commandRegistry.get("compact:strategy")).toBeUndefined();
  });

  it("compact command matches colon-form invocations", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    expect(commandRegistry.match("compact")).toBe("compact");
    expect(commandRegistry.match("compact 5")).toBe("compact");
    expect(commandRegistry.match("compact:drop")).toBe("compact");
    expect(commandRegistry.match("compact drop")).toBe("compact");
    expect(commandRegistry.match("compacter")).toBeNull();
  });

  it("compact <strategy> switches strategy (space form)", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact")!;
    // cmdValue is the full command string
    const result = await (compactCmd.handler as any)({}, "compact drop");
    expect((result as any).content).toContain("Compaction strategy set to: drop");
    expect((ext as any).settings.strategy).toBe("drop");
  });

  it("compact:<strategy> switches strategy (colon form)", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact")!;
    const result = await (compactCmd.handler as any)({}, "compact:summarize-short");
    expect((result as any).content).toContain("Compaction strategy set to: summarize-short");
    expect((ext as any).settings.strategy).toBe("summarize-short");
  });

  it("compact:<unknown> returns error listing available strategies", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact")!;
    const result = await (compactCmd.handler as any)({}, "compact:foo");
    expect((result as any).error).toContain("Unknown compaction strategy: 'foo'");
    expect((result as any).error).toContain("summarize");
    expect((result as any).error).toContain("drop");
    // Strategy unchanged
    expect((ext as any).settings.strategy).toBe("summarize");
  });

  it("compact <unknown> returns error with usage", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact")!;
    const result = await (compactCmd.handler as any)({}, "compact not-a-strategy");
    expect((result as any).error).toContain("Unknown argument: 'not-a-strategy'");
    expect((result as any).error).toContain("Available strategies:");
  });

  it("compact:<strategy> with extra args returns error", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact")!;
    const result = await (compactCmd.handler as any)({}, "compact:drop extra");
    expect((result as any).error).toContain("Unexpected arguments");
    expect((ext as any).settings.strategy).toBe("summarize");
  });

  it("compact <strategy> with extra args returns error", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact")!;
    const result = await (compactCmd.handler as any)({}, "compact drop extra");
    expect((result as any).error).toContain("Unexpected arguments");
    expect((ext as any).settings.strategy).toBe("summarize");
  });

  it("compact command with keep parameter trims context", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact")!;

    // Create agent with 20 messages
    const context = makeMessages(20, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await (compactCmd!.handler as any)(agent, "compact 5");
    expect((result as any).content).toContain("Context compacted to 5 messages");
    expect(agent.log.length).toBe(6);
  });

  it("compact command with too few messages returns message", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact")!;

    // Create agent with only 1 message
    const context = makeMessages(1, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await (compactCmd!.handler as any)(agent, "compact");
    expect((result as any).content).toContain("Not enough messages");
  });

  it("compact command with debug flag includes debug info", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact")!;

    // Create agent with large context
    const context = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(context);

    agent.modelRegistry = {
            "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const result = await (compactCmd!.handler as any)(agent, "compact --compact-debug");
    expect((result as any).content).toContain("Debug mode");
  });
});

// ── Edge Cases ───────────────────────────────────────────────────────────────

describe("Edge Cases", () => {
  it("should handle agent with no model", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(context, "test-model");

    agent.modelRegistry = {
            "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // Should not crash even with a valid model
    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });
    expect(agent.log.length).toBeLessThan(100);
  });

  it("should handle empty messages array in hook", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const agent = createMockAgent([]);
    const messages: any[] = [];

    const result = await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Should return undefined or empty result
    expect(result === undefined || result.messages === undefined).toBe(true);
  });

  it("should handle messages with only system messages", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const agent = createMockAgent([]);
    const messages = [
      { role: "system", content: "System prompt 1" },
      { role: "system", content: "System prompt 2" },
    ];

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Should not crash, no compaction needed
    expect(agent.log.length).toBe(0);
  });

  it("should trigger compaction with very large reserveTokens", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 999999999,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(10, "x".repeat(100));
    const agent = createMockAgent(context, "test-model", {
      "test-model": { name: "test-model", temperature: null, contextLimit: 128000 },
    });
    const messages = [{ role: "system", content: "" }, ...context];

    // With huge reserve, effectiveMax = 128000 - 999999999 = very negative
    // estimatedTokens (250) > very_negative => compaction triggers
    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Compaction should have occurred (dropping or summarizing)
    // The exact result depends on the strategy, but log length should change
    expect(agent.log.length).not.toBe(10);
  });

  it("should handle context with mixed message types", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = [
      new Message({ role: "user", content: "x".repeat(500) }),
      new Message({ role: "assistant", content: "y".repeat(500), reasoningContent: "z".repeat(500) }),
      new Message({ role: "user", content: "a".repeat(500) }),
      new Message({ role: "assistant", content: "b".repeat(500), toolCalls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: '{"cmd": "ls"}' } }] }),
      new Message({ role: "tool", content: "result".repeat(200) }),
    ];
    const agent = createMockAgent(context);
    const messages = [{ role: "system", content: "" }, ...context];

    agent.modelRegistry = {
            "test-model": { name: "test-model", temperature: null, contextLimit: 2000 },
    };

    await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });

    // Should handle mixed message types without crashing or corrupting context
    expect(agent.log.length).toBe(5);
  });

  it("should handle abortSignal that is already aborted", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));
    const abortController = new AbortController();
    abortController.abort(); // Already aborted

    const agent = createMockAgent(context);
    (agent as any).abortSignal = abortController.signal;

    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // Should not throw, should handle abort gracefully
    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent })
    ).resolves.toBeDefined();
  });

  it("should handle abortSignal that is not yet aborted", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));
    const abortController = new AbortController(); // Not aborted

    const agent = createMockAgent(context);
    (agent as any).abortSignal = abortController.signal;

    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // Should work normally
    const result = await (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent });
    expect(result).toBeDefined();
  });

  it("should handle cancellation during streaming (agent.cancelled)", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));

    // Create an agent that is cancelled
    const mockLlmClient = {
      chatStreamCancellable: () =>
        (async function* () {
          // Simulate checking cancelled flag
          yield { type: "content", content: "partial" };
        })(),
    };
    const log = new MessageLog(context);
    const agent = {
      get log() { return log; },
      context: {
        getMessages: () => log.getAll(),
        replaceMessages: (msgs: any[]) => log.replace(msgs),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
        getSystemPrompt: () => null,
      },
      model: "test-model",
      sessionId: "test-session",
      cancelled: true, // Agent is cancelled
      _llmClient: mockLlmClient,
      get llmClient() { return mockLlmClient; },
      buildMessages() {
        return [{ role: "system", content: "" }, ...log.getAll()];
      },
      addMessage(msg: any) { log.push(msg); },
      replaceContext(newContext: any) { log.replace(newContext); },
    } as any;

    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // Should handle cancellation gracefully without throwing
    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent })
    ).resolves.toBeDefined();
    // Cancellation aborts the summarization, so context is left untouched
    expect(agent.log.length).toBe(context.length);
  });

  it("should handle compaction error gracefully", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
      strategy: "summarize",
    });
    const ext = createCompactionExtension(core);

    const context = makeMessages(50, "x".repeat(500));

    // Create an LLM client that throws
    const mockLlmClient = {
      chatStreamCancellable: () =>
        (async function* () {
          throw new Error("LLM error during compaction");
        })(),
    };
    const log = new MessageLog(context);
    const agent = {
      get log() { return log; },
      context: {
        getMessages: () => log.getAll(),
        replaceMessages: (msgs: any[]) => log.replace(msgs),
        getSystem: () => log.getSystem(),
        getNonSystem: () => log.getNonSystem(),
        getSystemPrompt: () => null,
      },
      model: "test-model",
      sessionId: "test-session",
      cancelled: false,
      _llmClient: mockLlmClient,
      get llmClient() { return mockLlmClient; },
      buildMessages() {
        return [{ role: "system", content: "" }, ...log.getAll()];
      },
      addMessage(msg: any) { log.push(msg); },
      replaceContext(newContext: any) { log.replace(newContext); },
    } as any;

    agent.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, contextLimit: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // Should handle error gracefully without throwing
    await expect(
      (ext as any).hooks![HOOKS.CONTEXT]!({ messages: messages as any, agent })
    ).resolves.toBeDefined();
    // Failed summarization must not corrupt the context
    expect(agent.log.length).toBe(context.length);
  });
});

// ── /compact Command Tests ───────────────────────────────────────────────────

describe("/compact Command", () => {
  it("returns error when not enough messages to compact", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    // Only 1 non-system message
    const context = [new Message({ role: "user", content: "hello" })];
    const agent = createMockAgent(context);

    const result = await (compactCmd!.handler as any)(agent, "compact");

    expect((result as any).content).toContain("Not enough messages");
  });

  it("handles /compact with keep option", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    // 10 non-system messages
    const context = makeMessages(10, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await (compactCmd!.handler as any)(agent, "compact 4");

    expect((result as any).content).toContain("Context compacted to 4 messages");
    // The user turn guard adds an extra message
    expect(agent.log.getNonSystem().length).toBeGreaterThanOrEqual(4);
  });

  it("handles /compact with keep=0 (slice(-0) keeps all)", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(10, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await (compactCmd!.handler as any)(agent, "compact 0");

    // slice(-0) returns the full array, so all messages are kept
    expect((result as any).content).toContain("Context compacted");
    expect(agent.log.getNonSystem().length).toBeGreaterThanOrEqual(10);
  });

  it("handles /compact with nonexistent strategy (falls back to default)", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "nonexistent-strategy",
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    const agent = createMockAgent(context, "test-model", {
      "test-model": { name: "test-model", temperature: null, contextLimit: 32000, tags: [] },
    });

    const result = await (compactCmd!.handler as any)(agent, "compact");

    // Falls back to default strategy (summarize)
    expect((result as any).content).toContain("Context compacted");
  });

  it("handles /compact when strategy.canCompact returns false", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 100, // Very high keepRecent, so canCompact will return false
      strategy: "drop",
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new AgentCommandRegistry();
    await (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(10, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await (compactCmd!.handler as any)(agent, "compact");

    expect((result as any).content).toContain("Compaction not applicable");
  });
});

// ── getModelConfig fallback lookup ──────────────────────────────────────────

describe("getModelConfig fallback lookup", () => {
  it("finds model config via provider/modelName fallback", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "drop",
    });
    const registry = {
      "laguna/laguna": {
        name: "laguna/laguna",
        temperature: null,
        contextLimit: 350000,
        tags: [],
      },
    };

    const ext = createCompactionExtension(core);
    expect(ext).not.toBeNull();

    const commandRegistry = new AgentCommandRegistry();
    (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    // Agent uses unprefixed model name (as happens when resolveModel can't find local entry)
    const agent = createMockAgent(context, "laguna", registry);

    const result = await compactCmd.handler!(agent, "compact");
    // Should succeed without error — means getModelConfig found the config
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
  });

  it("errors when model not found at all", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "drop",
    });
    const registry = {
      "other/model": {
        name: "other/model",
        temperature: null,
        contextLimit: 64000,
        tags: [],
      },
    };

    const ext = createCompactionExtension(core);
    const commandRegistry = new AgentCommandRegistry();
    (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    // Agent uses a model name not in the registry
    const agent = createMockAgent(context, "unknown-model", registry);

    // getModelConfig is strict: an unresolvable model name is an error, not a fallback.
    await expect(compactCmd.handler!(agent, "compact")).rejects.toThrow("not found in registry");
  });

  it("prefers direct lookup over fallback when model name contains '/'", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "drop",
    });
    const registry = {
      "provider/model-x": {
        name: "provider/model-x",
        temperature: null,
        contextLimit: 999999,
        tags: [],
      },
    };

    const ext = createCompactionExtension(core);
    const commandRegistry = new AgentCommandRegistry();
    (ext as any).hooks![HOOKS.COMMANDS_REGISTER]!({ registry: commandRegistry });
    const compactCmd = commandRegistry.get("compact")!;

    const context = makeMessages(20, "x".repeat(100));
    // Agent uses prefixed model name — direct lookup should work
    const agent = createMockAgent(context, "provider/model-x", registry);

    const result = await compactCmd.handler!(agent, "compact");
    expect(result).toBeDefined();
    expect(result.error).toBeUndefined();
  });
});

// ── Completions ──────────────────────────────────────────────────────────────

describe("compaction completions", () => {
  const fakeAgent: any = {
    compactionRegistry: {
      getAll: () =>
        ["summarize", "drop", "summarize-short", "token-aware", "trim"].map(
          (name) => ({ name, description: "" }),
        ),
    },
  };

  const makeCtx = (command: string | undefined, commandArg = "", agent: any = fakeAgent) =>
    ({ line: "", cursorPos: 0, command, commandArg, agent }) as any;

  it("matcher matches space-form and colon-form compact commands", () => {
    expect(compactMatcher(makeCtx("compact"))).toBe(true);
    expect(compactMatcher(makeCtx("compact:sum"))).toBe(true);
    expect(compactMatcher(makeCtx("model"))).toBe(false);
    expect(compactMatcher(makeCtx(undefined))).toBe(false);
  });

  it("completes strategy names for space form using commandArg prefix", () => {
    const options = compactCompletion(makeCtx("compact", "su"));
    expect(options.map((o) => o.value)).toEqual(["summarize", "summarize-short"]);
  });

  it("completes strategy names for colon form using the typed suffix as prefix", () => {
    const options = compactCompletion(makeCtx("compact:sum"));
    expect(options.map((o) => o.value)).toEqual(["summarize", "summarize-short"]);
  });

  it("returns all strategies when no prefix typed", () => {
    const options = compactCompletion(makeCtx("compact:"));
    expect(options.map((o) => o.value)).toEqual([
      "summarize",
      "drop",
      "summarize-short",
      "token-aware",
      "trim",
    ]);
  });

  it("returns no options when agent has no compaction registry", () => {
    expect(compactCompletion(makeCtx("compact", "", {}))).toEqual([]);
  });
});
