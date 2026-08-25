import { describe, it, expect } from "bun:test";
import { TrimStrategy } from "../../src/extensions/compaction/strategies/trim.ts";
import { estimateContextTokens, findFirstKeptIndex } from "../../src/extensions/compaction/utils.ts";
import { Message } from "../../src/core/context/message.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(role: string, content = "x".repeat(100)) {
  return new Message({ role, content });
}

const noopLlmChat = async (): Promise<string> => "";

const defaultSettings = {
  enabled: true,
  reserveTokens: 8000,
  keepRecentMessages: 3,
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

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "test-model");
    expect(result).toBeNull();
  });

  it("returns null when no non-system messages to drop", async () => {
    const messages = [makeMessage("user")];
    const settings = { ...defaultSettings, contextLimit: 10 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "test-model");
    expect(result).toBeNull();
  });

  it("drops minimum messages to fit under budget", async () => {
    // Create messages that total ~500 tokens each (2000 chars / 4)
    const content = "x".repeat(2000);
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    // Budget: only room for ~10 messages (10 * 500 = 5000 tokens)
    const settings = { ...defaultSettings, contextLimit: 6000, reserveTokens: 0, keepRecentMessages: 2 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "test-model");

    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.messagesCompacted).toBeGreaterThan(0);
    expect(result!.metadata!.strategyName).toBe("trim");
    expect(result!.metadata!.tokensBefore).toBeGreaterThan(6000);
    expect(result!.metadata!.tokensAfter).toBeLessThanOrEqual(6000);
  });

  it("preserves system messages while trimming", async () => {
    const content = "x".repeat(4000); // 1000 tokens each
    const messages = [
      makeMessage("system", "You are helpful."),
      ...Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content)),
    ];

    // Budget: 20000 tokens -> room for ~20 messages but we have 21 total (1 system + 20 non-system)
    const settings = { ...defaultSettings, contextLimit: 18000, reserveTokens: 0, keepRecentMessages: 2 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "test-model");

    expect(result).not.toBeNull();
    // messagesCompacted should be > 1 (skipping system message at index 0)
    expect(result!.messagesCompacted).toBeGreaterThan(1);
  });

  it("respects keepRecent zone", async () => {
    const content = "x".repeat(2000);
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    const keepRecent = 3;
    const settings = { ...defaultSettings, contextLimit: 5000, reserveTokens: 0, keepRecent };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "test-model");

    expect(result).not.toBeNull();
    // The firstKept index from findFirstKeptIndex should not be trimmed
    const firstKept = findFirstKeptIndex(messages, keepRecent);
    expect(result!.messagesCompacted).toBeLessThanOrEqual(firstKept);
  });

  it("never leaves a tool result without its parent assistant tool_calls message", async () => {
    const content = "x".repeat(2000); // 500 tokens each
    // Tool pair mid-conversation: the minimum drop that fits the budget
    // lands exactly on the first tool result, so the strategy must back up
    // to the parent (overshooting the budget) instead of orphaning results.
    const messages = [
      ...Array.from({ length: 6 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content)),
      new Message({
        role: "assistant",
        content: "x".repeat(2000),
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } },
          { id: "call-2", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      }),
      makeMessage("tool", "y".repeat(2000)),
      makeMessage("tool", "y".repeat(2000)),
      makeMessage("user", content),
      makeMessage("assistant", content),
      makeMessage("user", content),
      makeMessage("assistant", content),
    ];

    const settings = { ...defaultSettings, contextLimit: 2500, reserveTokens: 0, keepRecentMessages: 1 };
    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "test-model");

    expect(result).not.toBeNull();
    // Kept window starts at the parent assistant message, not a tool result.
    expect(messages[result!.messagesCompacted]!.role).toBe("assistant");
    // Keeping the parent overshoots the 2500 budget -- that is the accepted
    // trade-off (a hard API error would be worse).
    expect(result!.metadata!.tokensAfter).toBeGreaterThan(2500);
  });

  it("declines to trim when even the protected recent zone does not fit", async () => {
    const content = "x".repeat(2000); // 500 tokens each
    const messages = [
      ...Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content)),
      new Message({
        role: "assistant",
        content: "x".repeat(2000),
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } },
          { id: "call-2", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      }),
      makeMessage("tool", "y".repeat(2000)),
      makeMessage("tool", "y".repeat(2000)),
    ];

    // Budget (1200) fits the two tool results alone but not their parent,
    // and dropping into the keep-recent zone is not allowed -> decline.
    const settings = { ...defaultSettings, contextLimit: 1200, reserveTokens: 0, keepRecentMessages: 1 };
    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "test-model");

    expect(result).toBeNull();
  });

  it("returns null when even the protected recent messages don't fit the budget", async () => {
    const content = "x".repeat(20000); // 5000 tokens each
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    // Budget: 3000 tokens; even a single protected recent message
    // (5000 tokens) exceeds it, so the strategy must decline rather than
    // trim into the keep-recent zone.
    const settings = { ...defaultSettings, contextLimit: 3000, reserveTokens: 0, keepRecentMessages: 1 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "test-model");

    expect(result).toBeNull();
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
    const settings = { ...defaultSettings, contextLimit: 5000, reserveTokens: 0, keepRecentMessages: 2 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "test-model");

    expect(result).not.toBeNull();
    // After dropping 5 messages, we have 5 * 1000 = 5000 tokens (fits exactly)
    // But keepRecentMessages=2 means last 4 messages are protected, so we can drop up to 6
    expect(result!.metadata!.messagesDropped).toBeGreaterThanOrEqual(5);
    expect(result!.metadata!.tokensAfter).toBeLessThanOrEqual(5000);
  });

  it("infers context limit from the model name when not configured", async () => {
    // 130 * 1000 = 130000 tokens, reserve 0: under the "128k" model limit
    // (131072) but over the unknown-model default (128000). The divergent
    // outcomes prove the model name is honored, not silently bumped.
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 130 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: undefined, reserveTokens: 0 };

    expect(await new TrimStrategy().execute(messages, settings, noopLlmChat, "gpt-4o-128k")).toBeNull();
    expect(await new TrimStrategy().execute(messages, settings, noopLlmChat, "unknown-model")).not.toBeNull();
  });

  it("handles empty messages array", async () => {
    const strategy = new TrimStrategy();
    const result = await strategy.execute([], { ...defaultSettings, contextLimit: 100, reserveTokens: 0 }, noopLlmChat, "model");
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
    const settings = { ...defaultSettings, contextLimit: 2000, reserveTokens: 0, keepRecentMessages: 1 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    // The kept portion must fit the budget even though system messages
    // (which are never dropped) count toward it.
    const keptTokens = estimateContextTokens(messages.slice(result!.messagesCompacted));
    expect(keptTokens).toBeLessThanOrEqual(2000);
  });

  it("handles messages with reasoning_content", async () => {
    const content = "x".repeat(2000);
    const messages = [
      new Message({ role: "user", content }),
      new Message({ role: "assistant", content: "response", reasoningContent: content }),
      new Message({ role: "user", content }),
      new Message({ role: "assistant", content: "response", reasoningContent: content }),
      new Message({ role: "user", content }),
      new Message({ role: "assistant", content: "response", reasoningContent: content }),
      new Message({ role: "user", content }),
      new Message({ role: "assistant", content: "response", reasoningContent: content }),
    ];

    // Each message: ~500 (content) + ~500 (reasoning) = ~1000 tokens
    // Total: 8000 tokens. Budget: 4000 -> need to drop
    const settings = { ...defaultSettings, contextLimit: 4000, reserveTokens: 0, keepRecentMessages: 2 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.metadata!.tokensBefore).toBeGreaterThan(4000);
    expect(result!.metadata!.tokensAfter).toBeLessThanOrEqual(4000);
  });

  it("handles messages with tool_calls", async () => {
    const content = "x".repeat(4000); // 1000 tokens each
    const messages = [
      new Message({ role: "user", content }),
      new Message({ role: "assistant", content: "Running", toolCalls: [{ id: "1", type: "function", function: { name: "bash", arguments: '{"cmd": "ls -la"}' } }] }),
      new Message({ role: "user", content }),
      new Message({ role: "assistant", content: "Running", toolCalls: [{ id: "2", type: "function", function: { name: "read", arguments: '{"path": "file.txt"}' } }] }),
      new Message({ role: "user", content }),
      new Message({ role: "assistant", content: "Running", toolCalls: [{ id: "3", type: "function", function: { name: "bash", arguments: '{"cmd": "cat"}' } }] }),
      new Message({ role: "user", content }),
      new Message({ role: "assistant", content: "Running", toolCalls: [{ id: "4", type: "function", function: { name: "read", arguments: '{"path": "other.txt"}' } }] }),
    ];

    // Each user message: ~1000 tokens, each assistant: ~1000 + ~30 = ~1030 tokens
    // Total: ~8120 tokens. Budget: 4000 -> need to drop
    const settings = { ...defaultSettings, contextLimit: 4000, reserveTokens: 0, keepRecentMessages: 2 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.metadata!.tokensAfter).toBeLessThanOrEqual(4000);
  });

  it("returns null when keepRecentMessages=0 and no messages can be dropped", async () => {
    const strategy = new TrimStrategy();
    const messages = [makeMessage("user"), makeMessage("assistant")];
    const settings = { ...defaultSettings, contextLimit: 10, reserveTokens: 0, keepRecentMessages: 0 };

    const result = await strategy.execute(messages, settings, noopLlmChat, "model");
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
    const settings = { ...defaultSettings, contextLimit: 5000, reserveTokens: 0, keepRecentMessages: 2 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.metadata!.contextLimit).toBe(5000);
  });

  it("metadata includes messagesDropped", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: 3000, reserveTokens: 0, keepRecentMessages: 2 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.metadata!.messagesDropped).toBeGreaterThan(0);
  });

  it("messagesCompacted is correct index into original messages", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: 3000, reserveTokens: 0, keepRecentMessages: 2 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    // The kept messages should be messages.slice(result.messagesCompacted)
    const keptMessages = messages.slice(result!.messagesCompacted);
    const keptTokens = estimateContextTokens(keptMessages);
    expect(keptTokens).toBeLessThanOrEqual(3000);
  });

  it("handles single non-system message that fits budget", async () => {
    const strategy = new TrimStrategy();
    const messages = [makeMessage("user", "x".repeat(100))];
    const settings = { ...defaultSettings, contextLimit: 128000, reserveTokens: 0 };

    const result = await strategy.execute(messages, settings, noopLlmChat, "model");
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
    const settings = { ...defaultSettings, contextLimit: 2000, reserveTokens: 0, keepRecentMessages: 1 };

    const result = await new TrimStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.metadata!.tokensAfter).toBeLessThanOrEqual(2000);
    // The binary search should find the minimum number of messages to drop
    expect(result!.metadata!.messagesDropped).toBeGreaterThanOrEqual(1);
  });

});
