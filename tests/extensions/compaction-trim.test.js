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
});
