import { describe, it, expect } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.js";
import { ToolRegistry } from "../../src/core/tool-registry.js";
import { create as createCompactionExtension } from "../../src/extensions/compaction/index.js";

import {
  estimateContextTokens,
  findFirstKeptIndex,
} from "../../src/extensions/compaction/index.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessages(count, content = "x".repeat(100)) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    const isUser = i % 2 === 0;
    messages.push({
      role: isUser ? "user" : "assistant",
      content,
    });
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

function createMockAgent(context, model = "test-model") {
  return {
    context,
    model,
    sessionId: "test-session",
    _llmClient: {
      chatStreamCancellable: () =>
        (async function* () {
          yield { type: "content", content: "test response" };
        })(),
    },
    _context: context,
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

    // The extension should have hooks that can be registered
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks[HOOKS.CONTEXT_FULL]).toBeDefined();
  });

  it("should not trigger compaction when context is small", async () => {
    const core = createMockCore();
    const ext = createCompactionExtension(core);

    const smallContext = makeMessages(4); // Only 2 pairs
    const agent = createMockAgent(smallContext);

    // Call the hook handler directly
    await ext.hooks[HOOKS.CONTEXT_FULL]({ agent, contextSize: 4 });

    // Context should be unchanged
    expect(agent._context.length).toBe(4);
  });

  it("should not trigger compaction when token budget is not exceeded", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 16384,
    });
    const ext = createCompactionExtension(core);

    // Create messages that are under the token budget
    const context = makeMessages(20, "x".repeat(50)); // ~250 tokens total
    const agent = createMockAgent(context);

    // Call the hook handler directly
    await ext.hooks[HOOKS.CONTEXT_FULL]({ agent, contextSize: context.length });

    // Context should be unchanged (tokens well under 32000 - 16384 = 15616)
    expect(agent._context.length).toBe(20);
  });

  it("should trigger compaction when context exceeds token budget", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    // Use a small context limit to force compaction
    // With 50 messages * 500 chars = 25000 chars ≈ 6250 tokens
    // contextLimit(8000) - reserve(100) = 7900 threshold
    // 6250 < 7900... still under. Need more messages.
    // 15 messages * 500 chars = 7500 chars ≈ 1875 tokens — under
    // 40 messages * 500 chars = 20000 chars ≈ 5000 tokens — under
    // Actually the model maxTokens is 32000, so threshold is 31900.
    // Need ~255 messages of 500 chars each for 25000+ tokens.
    // Simpler: override modelRegistry with small maxTokens
    const largeContext = makeMessages(100, "x".repeat(500)); // ~12500 tokens
    const agent = createMockAgent(largeContext);

    // Override model config for this test
    const originalCore = core;
    core.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, maxTokens: 8000 },
    };
    const threshold = 8000 - 100; // 7900
    // 12500 > 7900 → should compact

    await ext.hooks[HOOKS.CONTEXT_FULL]({
      agent,
      contextSize: largeContext.length,
    });

    // Context should be compacted
    expect(agent._context.length).toBeLessThan(largeContext.length);
    const summaryMsg = agent._context[0];
    expect(summaryMsg.role).toBe("user");
    expect(summaryMsg.content).toContain("<m_ckga3qxdoia7896k>");
  });

  it("should use drop strategy when configured", async () => {
    const core = createMockCore({
      enabled: true,
      keepRecentMessages: 2,
      strategy: "drop",
      reserveTokens: 100,
    });
    const ext = createCompactionExtension(core);

    const largeContext = makeMessages(100, "x".repeat(500)); // ~12500 tokens
    const agent = createMockAgent(largeContext);

    // Override model config for this test
    core.modelRegistry = {
      "test-model": { name: "test-model", temperature: null, maxTokens: 8000 },
    };

    await ext.hooks[HOOKS.CONTEXT_FULL]({
      agent,
      contextSize: largeContext.length,
    });

    // Drop strategy: no summary message, just shortened context
    expect(agent._context.length).toBeLessThan(largeContext.length);
    const firstMsg = agent._context[0];
    expect(firstMsg.content).not.toContain("<m_ckga3qxdoia7896k>");
  });
});

// ── Utility Functions ────────────────────────────────────────────────────────

describe("Compaction Utilities", () => {
  it("findFirstKeptIndex returns correct index", () => {
    const messages = makeMessages(10);
    const index = findFirstKeptIndex(messages, 2);
    // With 10 messages and keepRecent=2, keeps last 3 (indices 7,8,9), compacts first 7
    expect(index).toBeGreaterThan(0);
    expect(index).toBeLessThan(messages.length);
  });

  it("findFirstKeptIndex returns 0 for keepRecent=0", () => {
    const messages = makeMessages(10);
    expect(findFirstKeptIndex(messages, 0)).toBe(0);
  });

  it("findFirstKeptIndex skips system messages", () => {
    // 1 system + 8 user/assistant = 9 messages total
    // Non-system: 8 messages. keepRecent=2 → keep 4, compact 4
    const messages = [
      { role: "system", content: "You are helpful" },
      ...makeMessages(8),
    ];
    const index = findFirstKeptIndex(messages, 2);
    // Count from end: indices 8,7,6,5 are 4 non-system → return 6
    expect(index).toBe(6);
  });

  it("estimateContextTokens estimates correctly", () => {
    const messages = makeMessages(4, "x".repeat(100));
    const tokens = estimateContextTokens(messages);
    // Each message ~100 chars / 4 = 25 tokens
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThan(200);
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
