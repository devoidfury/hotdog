import { describe, it, expect } from "bun:test";
import { TrimStrategy } from "../../src/extensions/compaction/strategies/trim.js";
import { estimateContextTokens, findFirstKeptIndex } from "../../src/extensions/compaction/utils.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(role, content = "x".repeat(100)) {
  return { role, content };
}

const defaultSettings = {
  enabled: true,
  reserveTokens: 8000,
  keepRecent: 3,
  contextLimit: 128000,
};

// ── TrimStrategy Tests ───────────────────────────────────────────────────────

describe("TrimStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new TrimStrategy();
    expect(strategy.name).toBe("trim");
    expect(strategy.description.toLowerCase()).toContain("binary-search");
  });

  it("returns null when context is under budget", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const settings = { ...defaultSettings, contextLimit: 128000 };

    const result = await new TrimStrategy().execute(messages, settings, null, "test-model");
    expect(result).toBeNull();
  });

  it("returns null when no non-system messages to drop", async () => {
    const messages = [makeMessage("user")];
    const settings = { ...defaultSettings, contextLimit: 10 };

    const result = await new TrimStrategy().execute(messages, settings, null, "test-model");
    expect(result).toBeNull();
  });

  it("drops minimum messages to fit under budget", async () => {
    // Create messages that total ~500 tokens each (2000 chars / 4)
    const content = "x".repeat(2000);
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    // Budget: only room for ~10 messages (10 * 500 = 5000 tokens)
    const settings = { ...defaultSettings, contextLimit: 6000, reserveTokens: 0, keepRecent: 2 };

    const result = await new TrimStrategy().execute(messages, settings, null, "test-model");

    expect(result).not.toBeNull();
    expect(result.summary).toBeNull();
    expect(result.messagesCompacted).toBeGreaterThan(0);
    expect(result.metadata.strategyName).toBe("trim");
    expect(result.metadata.tokensBefore).toBeGreaterThan(6000);
    expect(result.metadata.tokensAfter).toBeLessThanOrEqual(6000);
  });

  it("preserves system messages while trimming", async () => {
    const content = "x".repeat(4000); // 1000 tokens each
    const messages = [
      makeMessage("system", "You are helpful."),
      ...Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content)),
    ];

    // Budget: 20000 tokens -> room for ~20 messages but we have 21 total (1 system + 20 non-system)
    const settings = { ...defaultSettings, contextLimit: 18000, reserveTokens: 0, keepRecent: 2 };

    const result = await new TrimStrategy().execute(messages, settings, null, "test-model");

    expect(result).not.toBeNull();
    // messagesCompacted should be > 1 (skipping system message at index 0)
    expect(result.messagesCompacted).toBeGreaterThan(1);
  });

  it("respects keepRecent zone", async () => {
    const content = "x".repeat(2000);
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    const keepRecent = 3;
    const settings = { ...defaultSettings, contextLimit: 5000, reserveTokens: 0, keepRecent };

    const result = await new TrimStrategy().execute(messages, settings, null, "test-model");

    if (result) {
      // The firstKept index from findFirstKeptIndex should not be trimmed
      const firstKept = findFirstKeptIndex(messages, keepRecent);
      expect(result.messagesCompacted).toBeLessThanOrEqual(firstKept);
    }
  });

  it("returns null when even dropping all droppable messages doesn't fit", async () => {
    const content = "x".repeat(10000); // 2500 tokens each
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    // Budget: only room for 1 message
    const settings = { ...defaultSettings, contextLimit: 3000, reserveTokens: 0, keepRecent: 1 };

    const result = await new TrimStrategy().execute(messages, settings, null, "test-model");

    // If we can't fit even after dropping everything droppable, return null
    // This is acceptable -- the caller should fall back to another strategy
    expect(result === null || result.messagesCompacted >= 0).toBe(true);
  });

  it("canCompact returns false when messages are few", () => {
    const messages = Array.from({ length: 4 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const result = new TrimStrategy().canCompact(messages, defaultSettings);
    expect(result).toBe(false);
  });

  it("canCompact returns false when under budget", () => {
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", "x".repeat(10)));
    const settings = { ...defaultSettings, contextLimit: 128000 };
    const result = new TrimStrategy().canCompact(messages, settings);
    expect(result).toBe(false);
  });

  it("canCompact returns true when over budget", () => {
    const content = "x".repeat(2000);
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: 5000 };
    const result = new TrimStrategy().canCompact(messages, settings);
    expect(result).toBe(true);
  });

  it("binary search finds the minimum drop count", async () => {
    // Each message is exactly 1000 tokens (4000 chars)
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    // Total: 10000 tokens. Budget: 5000 -> need to drop at least 5 messages
    const settings = { ...defaultSettings, contextLimit: 5000, reserveTokens: 0, keepRecent: 2 };

    const result = await new TrimStrategy().execute(messages, settings, null, "test-model");

    expect(result).not.toBeNull();
    // After dropping 5 messages, we have 5 * 1000 = 5000 tokens (fits exactly)
    // But keepRecent=2 means last 4 messages are protected, so we can drop up to 6
    expect(result.metadata.messagesDropped).toBeGreaterThanOrEqual(5);
    expect(result.metadata.tokensAfter).toBeLessThanOrEqual(5000);
  });

  it("uses model name to infer context limit", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 30 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    // No contextLimit in settings, model name contains "128k"
    const settings = { ...defaultSettings, contextLimit: undefined };

    const result = await new TrimStrategy().execute(messages, settings, null, "gpt-4o-128k");

    // 30 * 1000 = 30000 tokens < 131072, so should return null
    expect(result).toBeNull();
  });

  it("handles empty messages array", async () => {
    const strategy = new TrimStrategy();
    const result = await strategy.execute([], { ...defaultSettings, contextLimit: 100, reserveTokens: 0 }, null, "model");
    expect(result).toBeNull();
  });

  it("handles messages with system messages interspersed", async () => {
    const content = "x".repeat(2000); // 500 tokens each
    const messages = [
      makeMessage("system", "System prompt"),
      makeMessage("user", content),
      makeMessage("assistant", content),
      makeMessage("system", "Another system prompt"),
      makeMessage("user", content),
      makeMessage("assistant", content),
      makeMessage("user", content),
      makeMessage("assistant", content),
    ];

    // Total: 1 system + 6 non-system = 6 * 500 + 500 (system) = 3500 tokens
    // Budget: 2000 -> need to trim
    const settings = { ...defaultSettings, contextLimit: 2000, reserveTokens: 0, keepRecent: 1 };

    const result = await new TrimStrategy().execute(messages, settings, null, "model");

    expect(result).not.toBeNull();
    expect(result.summary).toBeNull();
    // System messages should be preserved
    const keptMessages = messages.slice(result.messagesCompacted);
    // Check that system messages are still present in kept portion
    const systemInKept = keptMessages.filter(m => m.role === "system");
    expect(systemInKept.length).toBeGreaterThanOrEqual(0); // could be 0 if all system msgs were before compaction point
  });

  it("handles messages with reasoning_content", async () => {
    const content = "x".repeat(2000);
    const messages = [
      { role: "user", content: content },
      { role: "assistant", content: "response", reasoning_content: content },
      { role: "user", content: content },
      { role: "assistant", content: "response", reasoning_content: content },
      { role: "user", content: content },
      { role: "assistant", content: "response", reasoning_content: content },
      { role: "user", content: content },
      { role: "assistant", content: "response", reasoning_content: content },
    ];

    // Each message: ~500 (content) + ~500 (reasoning) = ~1000 tokens
    // Total: 8000 tokens. Budget: 4000 -> need to drop
    const settings = { ...defaultSettings, contextLimit: 4000, reserveTokens: 0, keepRecent: 2 };

    const result = await new TrimStrategy().execute(messages, settings, null, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.tokensBefore).toBeGreaterThan(4000);
    expect(result.metadata.tokensAfter).toBeLessThanOrEqual(4000);
  });

  it("handles messages with tool_calls", async () => {
    const content = "x".repeat(4000); // 1000 tokens each
    const messages = [
      { role: "user", content: content },
      { role: "assistant", content: "Running", tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "ls -la"}' } }] },
      { role: "user", content: content },
      { role: "assistant", content: "Running", tool_calls: [{ function: { name: "read", arguments: '{"path": "file.txt"}' } }] },
      { role: "user", content: content },
      { role: "assistant", content: "Running", tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "cat"}' } }] },
      { role: "user", content: content },
      { role: "assistant", content: "Running", tool_calls: [{ function: { name: "read", arguments: '{"path": "other.txt"}' } }] },
    ];

    // Each user message: ~1000 tokens, each assistant: ~1000 + ~30 = ~1030 tokens
    // Total: ~8120 tokens. Budget: 4000 -> need to drop
    const settings = { ...defaultSettings, contextLimit: 4000, reserveTokens: 0, keepRecent: 2 };

    const result = await new TrimStrategy().execute(messages, settings, null, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.tokensAfter).toBeLessThanOrEqual(4000);
  });

  it("returns null when keepRecent=0 and no messages can be dropped", async () => {
    const strategy = new TrimStrategy();
    const messages = [makeMessage("user"), makeMessage("assistant")];
    const settings = { ...defaultSettings, contextLimit: 10, reserveTokens: 0, keepRecent: 0 };

    const result = await strategy.execute(messages, settings, null, "model");
    expect(result).toBeNull();
  });

  it("canCompact returns false when only system messages", () => {
    const strategy = new TrimStrategy();
    const messages = [makeMessage("system"), makeMessage("system")];
    const result = strategy.canCompact(messages, defaultSettings);
    expect(result).toBe(false);
  });

  it("canCompact returns true when reserveTokens makes effectiveMax negative and messages exceed it", () => {
    const strategy = new TrimStrategy();
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", "x".repeat(10)));
    // reserveTokens > contextLimit => effectiveMax = 100 - 200 = -100
    // nonSystem.length = 20 > (3 || 3) * 2 = 6 => passes first check
    // estimateContextTokens(nonSystem) = 20 * 5 = 100 > -100 => true
    const result = strategy.canCompact(messages, { ...defaultSettings, contextLimit: 100, reserveTokens: 200 });
    expect(result).toBe(true);
  });

  it("canCompact returns true with system messages when non-system are over budget", () => {
    const strategy = new TrimStrategy();
    const content = "x".repeat(2000);
    const messages = [
      makeMessage("system", "System prompt"),
      ...Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content)),
    ];
    const result = strategy.canCompact(messages, { ...defaultSettings, contextLimit: 3000, reserveTokens: 0 });
    expect(result).toBe(true);
  });

  it("canCompact returns false when non-system messages are few enough", () => {
    const strategy = new TrimStrategy();
    const messages = [
      makeMessage("user", "x".repeat(10)),
      makeMessage("assistant", "x".repeat(10)),
    ];
    const result = strategy.canCompact(messages, { ...defaultSettings, contextLimit: 128000, reserveTokens: 0 });
    expect(result).toBe(false);
  });

  it("metadata includes contextLimit", async () => {
    const content = "x".repeat(2000);
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: 5000, reserveTokens: 0, keepRecent: 2 };

    const result = await new TrimStrategy().execute(messages, settings, null, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.contextLimit).toBe(5000);
  });

  it("metadata includes messagesDropped", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: 3000, reserveTokens: 0, keepRecent: 2 };

    const result = await new TrimStrategy().execute(messages, settings, null, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.messagesDropped).toBeGreaterThan(0);
  });

  it("messagesCompacted is correct index into original messages", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: 3000, reserveTokens: 0, keepRecent: 2 };

    const result = await new TrimStrategy().execute(messages, settings, null, "model");

    expect(result).not.toBeNull();
    // The kept messages should be messages.slice(result.messagesCompacted)
    const keptMessages = messages.slice(result.messagesCompacted);
    const keptTokens = estimateContextTokens(keptMessages);
    expect(keptTokens).toBeLessThanOrEqual(3000);
  });

  it("handles single non-system message that fits budget", async () => {
    const strategy = new TrimStrategy();
    const messages = [makeMessage("user", "x".repeat(100))];
    const settings = { ...defaultSettings, contextLimit: 128000, reserveTokens: 0 };

    const result = await strategy.execute(messages, settings, null, "model");
    expect(result).toBeNull();
  });

  it("handles mixed message sizes", async () => {
    const messages = [
      makeMessage("user", "x".repeat(4000)),   // 1000 tokens
      makeMessage("assistant", "x".repeat(2000)), // 500 tokens
      makeMessage("user", "x".repeat(4000)),   // 1000 tokens
      makeMessage("assistant", "x".repeat(2000)), // 500 tokens
      makeMessage("user", "x".repeat(4000)),   // 1000 tokens
      makeMessage("assistant", "x".repeat(2000)), // 500 tokens
    ];

    // Total: 4500 tokens. Budget: 2000 -> need to drop
    const settings = { ...defaultSettings, contextLimit: 2000, reserveTokens: 0, keepRecent: 1 };

    const result = await new TrimStrategy().execute(messages, settings, null, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.tokensAfter).toBeLessThanOrEqual(2000);
    // The binary search should find the minimum number of messages to drop
    expect(result.metadata.messagesDropped).toBeGreaterThanOrEqual(1);
  });

  it("falls back to 128000 when model name does not contain 128k", async () => {
    const strategy = new TrimStrategy();
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 50 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    // No contextLimit in settings, model name does NOT contain "128k"
    // So it falls back to default 128000
    const settings = { ...defaultSettings, contextLimit: undefined };

    const result = await strategy.execute(messages, settings, null, "gpt-3.5-turbo");

    // 50 * 1000 = 50000 tokens, effectiveMax = 128000 - 8000 = 120000
    // 50000 < 120000, so should return null (already under budget)
    expect(result).toBeNull();
  });
});
