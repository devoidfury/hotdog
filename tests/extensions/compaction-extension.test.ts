import { describe, it, expect } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";
import { MessageLog } from "../../src/core/context/message-log.ts";
import { Message } from "../../src/core/context/message.ts";
import { create as createCompactionExtension } from "../../src/extensions/compaction/index.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessages(count, content = "x".repeat(100)) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    messages.push(new Message({
      role: i % 2 === 0 ? "user" : "assistant",
      content,
    }));
  }
  return messages;
}

function createMockCore(config = {}) {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  return {
    hooks,
    config: { compaction: config },
    modelRegistry: {
      "test-model": { name: "test-model", temperature: null, maxTokens: 32000 },
    },
    toolRegistry,
  };
}

function createMockAgent(contextArray, model = "test-model") {
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
    model,
    sessionId: "test-session",
    _llmClient: mockLlmClient,
    get llmClient() { return mockLlmClient; },
    buildMessages() {
      return this.systemPrompt
        ? [{ role: "system", content: this.systemPrompt }, ...log.getAll()]
        : [...log.getAll()];
    },
    // New public context API (mirrors Agent.addMessage)
    addMessage(msg) {
      log.push(msg);
    },
    // New public context API (mirrors Agent.replaceContext)
    replaceContext(newContext) {
      log.replace(newContext);
    },
  };
}

// ── Extension Creation ───────────────────────────────────────────────────────

describe("Compaction Extension Creation", () => {
  it("should create extension with default config", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    expect(ext).not.toBeNull();
    expect(ext.settings.enabled).toBe(true);
    expect(ext.settings.keepRecentMessages).toBe(8);
    expect(ext.settings.strategy).toBe("summarize");
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
    expect(ext.settings.enabled).toBe(true);
    expect(ext.settings.keepRecentMessages).toBe(5);
    expect(ext.settings.strategy).toBe("drop");
    expect(ext.settings.reserveTokens).toBe(8192);
  });

  it("should register all built-in strategies", () => {
    const ext = createCompactionExtension(createMockCore());
    for (const name of ["summarize", "drop", "summarize-short", "token-aware", "trim"]) {
      expect(ext.registry.has(name)).toBe(true);
    }
  });

  it("should provide getStrategyList with correct names and order", () => {
    const ext = createCompactionExtension(createMockCore());
    const list = ext.getStrategyList();
    expect(list.length).toBe(5);
    expect(list.map((s) => s.name)).toEqual([
      "summarize", "drop", "summarize-short", "token-aware", "trim",
    ]);
  });

  it("should normalize keepRecentMessages to keepRecent in settings", () => {
    const ext = createCompactionExtension(createMockCore({ enabled: true, keepRecentMessages: 4 }));
    expect(ext.settings.keepRecent).toBe(4);
    expect(ext.settings.keepRecentMessages).toBe(4);
  });
 
  for (const { strategy, extra } of [
    { strategy: "token-aware", extra: { reserveTokens: 4096 } },
    { strategy: "trim", extra: {} },
  ]) {
    it(`should create extension with ${strategy} strategy`, () => {
      const ext = createCompactionExtension(createMockCore({ enabled: true, strategy, ...extra }));
      expect(ext.settings.strategy).toBe(strategy);
      if (extra.reserveTokens) {
        expect(ext.settings.reserveTokens).toBe(extra.reserveTokens);
      }
    });
  }
});

// ── Hook Integration ─────────────────────────────────────────────────────────

describe("Hook Integration", () => {
  it("should register hooks with the hook system", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks[HOOKS.CONTEXT]).toBeDefined();
  });

  it("should not trigger compaction when context is small", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const smallContext = makeMessages(4);
    const agent = createMockAgent(smallContext);
    const messages = [{ role: "system", content: "" }, ...smallContext];

    await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

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
    const agent = createMockAgent(context);
    const messages = [{ role: "system", content: "" }, ...context];

    await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

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

    core.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, maxTokens: 8000 },
    };

    const messages = [{ role: "system", content: "" }, ...largeContext];
    const result = await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

    expect(agent.log.length).toBeLessThan(largeContext.length);
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  // Parameterized: each strategy should compact when over budget
  const strategyTests = [
    { strategy: "drop", msgCount: 100, maxTokens: 8000, contextLimit: null },
    { strategy: "summarize-short", msgCount: 50, maxTokens: 5000, contextLimit: null },
    { strategy: "token-aware", msgCount: 50, maxTokens: 5000, contextLimit: 5000 },
    { strategy: "trim", msgCount: 50, maxTokens: 5000, contextLimit: 5000 },
  ];

  for (const { strategy, msgCount, maxTokens, contextLimit } of strategyTests) {
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

      core.modelRegistry = {
        "test-model": { name: "test-model", temperature: null, maxTokens },
      };

      if (contextLimit) ext.settings.contextLimit = contextLimit;

      const messages = [{ role: "system", content: "" }, ...largeContext];
      const result = await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

      expect(agent.log.length).toBeLessThan(largeContext.length);
      expect(result.messages).toBeDefined();
    });
  }

  it("should not trigger compaction when no modelRegistry", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    // Remove modelRegistry
    delete core.modelRegistry;
    const ext = createCompactionExtension(core);

    const context = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(context);
    const messages = [{ role: "system", content: "" }, ...context];

    // Should fall back to default 128000 context limit, so no compaction
    await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

    // With default 128000 limit, 100 * 125 = 12500 tokens, well under budget
    expect(agent.log.length).toBe(100);
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

    await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

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

    core.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, maxTokens: 5000 },
    };

    await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

    // Should still compact despite system message
    expect(agent.log.length).toBeLessThan(50);
  });
});

// ── Strategy List ────────────────────────────────────────────────────────────

describe("Strategy List", () => {
  it("returns all strategies with correct names and descriptions", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    const list = ext.getStrategyList();

    expect(list.length).toBe(5);

    const strategies = {
      summarize: "summarization",
      drop: "without summarizing",
      "summarize-short": "Aggressive",
      "token-aware": "token count",
      trim: "binary-search",
    };

    for (const s of list) {
      expect(s.name).toBeDefined();
      expect(s.description).toBeDefined();
      expect(s.description.length).toBeGreaterThan(0);
    }

    for (const [name, keyword] of Object.entries(strategies)) {
      const strategy = list.find(s => s.name === name);
      expect(strategy).toBeDefined();
      expect(strategy.description.toLowerCase()).toContain(keyword.toLowerCase());
    }
  });
});

// ── COMMANDS_REGISTER Hook ──────────────────────────────────────────────────

describe("COMMANDS_REGISTER Hook", () => {
  it("should register compact command", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new ToolRegistry();
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: commandRegistry });

    // The compact command should be registered
    const compactCmd = commandRegistry.get("compact");
    expect(compactCmd).toBeDefined();
    expect(compactCmd.description).toContain("Compact context");
  });

  it("should register compact:strategy command", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new ToolRegistry();
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: commandRegistry });

    const strategyCmd = commandRegistry.get("compact:strategy");
    expect(strategyCmd).toBeDefined();
    expect(strategyCmd.description).toContain("Manage compaction strategy");
  });

  it("compact:strategy list shows all strategies", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new ToolRegistry();
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: commandRegistry });

    const strategyCmd = commandRegistry.get("compact:strategy");
    // cmdValue is the full command string
    const result = await strategyCmd.handler({}, "compact:strategy list");
    expect(result.content).toContain("Available compaction strategies:");
    expect(result.content).toContain("summarize");
    expect(result.content).toContain("drop");
    expect(result.content).toContain("summarize-short");
    expect(result.content).toContain("token-aware");
    expect(result.content).toContain("trim");
  });

  it("compact:strategy help shows usage", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new ToolRegistry();
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: commandRegistry });

    const strategyCmd = commandRegistry.get("compact:strategy");
    // cmdValue is the full command string, handler slices off "compact:strategy" (16 chars)
    const result = await strategyCmd.handler({}, "compact:strategy help");
    expect(result.content).toContain("Usage:");
    expect(result.content).toContain("list");
    expect(result.content).toContain("set");
  });

  it("compact:strategy set changes strategy", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new ToolRegistry();
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: commandRegistry });

    const strategyCmd = commandRegistry.get("compact:strategy");
    // cmdValue is the full command string
    const result = await strategyCmd.handler({}, "compact:strategy drop");
    expect(result.content).toContain("Compaction strategy set to: drop");
    expect(ext.settings.strategy).toBe("drop");
  });

  it("compact command with keep parameter trims context", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new ToolRegistry();
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact");

    // Create agent with 20 messages
    const context = makeMessages(20, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await compactCmd.handler(agent, "compact 5");
    expect(result.content).toContain("Context compacted to 5 messages");
    expect(agent.log.length).toBe(6);
  });

  it("compact command with too few messages returns message", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const commandRegistry = new ToolRegistry();
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact");

    // Create agent with only 1 message
    const context = makeMessages(1, "x".repeat(100));
    const agent = createMockAgent(context);

    const result = await compactCmd.handler(agent, "compact");
    expect(result.content).toContain("Not enough messages");
  });

  it("compact command with debug flag includes debug info", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const commandRegistry = new ToolRegistry();
    await ext.hooks[HOOKS.COMMANDS_REGISTER]({ registry: commandRegistry });

    const compactCmd = commandRegistry.get("compact");

    // Create agent with large context
    const context = makeMessages(100, "x".repeat(500));
    const agent = createMockAgent(context);

    core.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, maxTokens: 5000 },
    };

    const result = await compactCmd.handler(agent, "compact --compact-debug");
    expect(result.content).toContain("Debug mode");
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
    const agent = createMockAgent(context, null);

    core.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, maxTokens: 5000 },
    };

    const messages = [{ role: "system", content: "" }, ...context];

    // Should not crash even with null model
    await ext.hooks[HOOKS.CONTEXT]({ messages, agent });
  });

  it("should handle empty messages array in hook", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const agent = createMockAgent([]);
    const messages = [];

    const result = await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

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

    await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

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
    const agent = createMockAgent(context);
    const messages = [{ role: "system", content: "" }, ...context];

    // With huge reserve, effectiveMax = 128000 - 999999999 = very negative
    // estimatedTokens (250) > very_negative => compaction triggers
    await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

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
      new Message({ role: "assistant", content: "y".repeat(500), reasoning_content: "z".repeat(500) }),
      new Message({ role: "user", content: "a".repeat(500) }),
      new Message({ role: "assistant", content: "b".repeat(500), tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "ls"}' } }] }),
      new Message({ role: "tool", content: "result".repeat(200) }),
    ];
    const agent = createMockAgent(context);
    const messages = [{ role: "system", content: "" }, ...context];

    core.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, maxTokens: 2000 },
    };

    await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

    // Should handle mixed messages without crashing
    expect(agent.log.length).toBeDefined();
  });
});
