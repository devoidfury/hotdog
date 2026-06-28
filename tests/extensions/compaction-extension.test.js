import { describe, it, expect } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.js";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.js";
import { MessageLog } from "../../src/core/context/message-log.js";
import { Message } from "../../src/core/context/message.js";
import { create as createCompactionExtension } from "../../src/extensions/compaction/index.js";

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
    expect(ext.settings.keepRecentMessages).toBe(3);
    expect(ext.settings.strategy).toBe("summarize");
  });

  it("should return null when compaction is disabled", () => {
    const core = createMockCore({ enabled: false });
    const ext = createCompactionExtension(core);
    expect(ext).toBeNull();
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
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    expect(ext.registry.has("summarize")).toBe(true);
    expect(ext.registry.has("drop")).toBe(true);
    expect(ext.registry.has("summarize-short")).toBe(true);
    expect(ext.registry.has("token-aware")).toBe(true);
  });

  it("should provide getStrategyList", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    const list = ext.getStrategyList();
    expect(list.length).toBe(4);
    expect(list.map((s) => s.name)).toEqual([
      "summarize",
      "drop",
      "summarize-short",
      "token-aware",
    ]);
  });
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

    // Override model config with small maxTokens to force compaction
    core.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, maxTokens: 8000 },
    };

    const messages = [{ role: "system", content: "" }, ...largeContext];

    const result = await ext.hooks[HOOKS.CONTEXT]({ messages, agent });

    // Context should be compacted (fewer messages)
    expect(agent.log.length).toBeLessThan(largeContext.length);

    // Should return the new messages array
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeLessThan(messages.length);
  });

  it("should use drop strategy when configured", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "drop",
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

    // Drop strategy: just shortened context without summary marker
    expect(agent.log.length).toBeLessThan(largeContext.length);

    // Should return the new messages array
    expect(result.messages).toBeDefined();
    expect(result.messages.length).toBeLessThan(messages.length);
  });
});

// ── Strategy List ────────────────────────────────────────────────────────────

describe("Strategy List", () => {
  it("should return all strategies with descriptions", () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);
    const list = ext.getStrategyList();

    expect(list.length).toBe(4);
    for (const s of list) {
      expect(s.name).toBeDefined();
      expect(s.description).toBeDefined();
      expect(s.description.length).toBeGreaterThan(0);
    }
  });
});
