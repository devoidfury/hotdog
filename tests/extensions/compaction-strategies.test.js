// Tests for compaction strategies and utilities.
// Merged from compaction-strategies.test.js + compaction.test.js to reduce duplication.

import { describe, it, expect } from "bun:test";
import { SummarizeShortStrategy } from "../../src/extensions/compaction/strategies/summarize-short.js";
import { TokenAwareStrategy } from "../../src/extensions/compaction/strategies/token-aware.js";
import { DropStrategy } from "../../src/extensions/compaction/strategies/drop.js";
import { SummarizeStrategy } from "../../src/extensions/compaction/strategies/summarize.js";
import { CompactionStrategyRegistry } from "../../src/extensions/compaction/strategies.js";
import {
  estimateMessageTokens,
  estimateContextTokens,
  serializeConversation,
  findFirstKeptIndex,
  shouldCompact,
  compactMessages,
} from "../../src/extensions/compaction/utils.js";

// ── Utility Functions ───────────────────────────────────────────────────────

describe("estimateMessageTokens", () => {
  it("estimates tokens for user message", () => {
    const msg = { role: "user", content: "Hello world" };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBeGreaterThan(0);
    expect(tokens).toBeLessThanOrEqual(Math.ceil("Hello world".length / 4));
  });

  it("estimates tokens for assistant with reasoning", () => {
    const msg = { role: "assistant", content: "Hi", reasoning_content: "Thinking about it" };
    const tokens = estimateMessageTokens(msg);
    const totalChars = "Hi".length + "Thinking about it".length;
    expect(tokens).toBe(Math.ceil(totalChars / 4));
  });

  it("estimates tokens for assistant with tool calls", () => {
    const msg = {
      role: "assistant",
      content: "Done",
      tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "ls"}' } }],
    };
    const tokens = estimateMessageTokens(msg);
    const chars = "Done".length + "bash".length + '{"cmd": "ls"}'.length;
    expect(tokens).toBe(Math.ceil(chars / 4));
  });

  it("estimates tokens for tool and system messages", () => {
    expect(estimateMessageTokens({ role: "tool", content: "Output here" })).toBeGreaterThan(0);
    expect(estimateMessageTokens({ role: "system", content: "You are helpful" })).toBeGreaterThan(0);
  });
});

describe("estimateContextTokens", () => {
  it("sums tokens for all messages", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
    ];
    const total = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    expect(estimateContextTokens(messages)).toBe(total);
  });

  it("returns 0 for empty array", () => {
    expect(estimateContextTokens([])).toBe(0);
  });
});

describe("shouldCompact", () => {
  it("returns true when over limit", () => {
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
    ];
    expect(shouldCompact(messages, 100, 50)).toBe(true);
  });

  it("returns false when under limit", () => {
    const messages = [{ role: "user", content: "Hi" }];
    expect(shouldCompact(messages, 1000, 100)).toBe(false);
  });

  it("accounts for reserve tokens", () => {
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
    ];
    expect(shouldCompact(messages, 100, 50)).toBe(true);
  });
});

describe("findFirstKeptIndex", () => {
  it("returns 0 when keepRecent is 0", () => {
    expect(findFirstKeptIndex([{ role: "user", content: "test" }], 0)).toBe(0);
  });

  it("returns 0 when not enough messages", () => {
    const messages = [{ role: "user", content: "test" }];
    expect(findFirstKeptIndex(messages, 1)).toBe(0);
  });

  it("skips system messages", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "user", content: "test1" },
      { role: "assistant", content: "test2" },
      { role: "user", content: "test3" },
      { role: "assistant", content: "test4" },
    ];
    // 4 non-system messages, keepRecent=1 => need 2 from end => return 4
    expect(findFirstKeptIndex(messages, 1)).toBe(4);
  });

  it("returns correct index for keepRecent=2", () => {
    const messages = [
      { role: "user", content: "1" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
      { role: "user", content: "5" },
      { role: "assistant", content: "6" },
    ];
    expect(findFirstKeptIndex(messages, 2)).toBe(3);
  });

  it("returns 0 when all messages are system", () => {
    const messages = [
      { role: "system", content: "a" },
      { role: "system", content: "b" },
    ];
    expect(findFirstKeptIndex(messages, 1)).toBe(0);
  });
});

describe("serializeConversation", () => {
  it("includes tool calls in serialized conversation", async () => {
    const messages = [
      { role: "assistant", content: "I will run a command", tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "ls"}' } }] },
      { role: "user", content: "Next message" },
    ];

    const serialized = serializeConversation(messages);
    expect(serialized).toContain("[Assistant tool calls]");
    expect(serialized).toContain("bash");
  });

  it("truncates long tool results", () => {
    const longContent = "x".repeat(3000);
    const messages = [
      { role: "tool", content: longContent },
      { role: "user", content: "Next message" },
    ];

    const serialized = serializeConversation(messages);
    expect(serialized).toContain("more characters truncated");
    expect(serialized.length).toBeLessThan(longContent.length);
  });

  it("skips system messages in serialization", () => {
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];

    const serialized = serializeConversation(messages);
    expect(serialized).not.toContain("[System]");
    expect(serialized).toContain("[User]: Hello");
  });
});

describe("compactMessages", () => {
  it("returns null when compaction is disabled", async () => {
    const messages = [{ role: "user", content: "test" }];
    const result = await compactMessages(messages, async () => "summary", "model", { enabled: false });
    expect(result).toBeNull();
  });

  it("returns null when not enough messages to compact", async () => {
    const messages = [{ role: "user", content: "test" }];
    const llmChat = async () => { throw new Error("Should not be called"); };
    const result = await compactMessages(messages, llmChat, "model", { enabled: true, keepRecent: 1 });
    expect(result).toBeNull();
  });

  it("calls LLM with summary prompt and serializes conversation", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs, model) => {
      capturedMessages = msgs;
      return "Summarized conversation";
    };

    const result = await compactMessages(messages, llmChat, "test-model", { enabled: true, keepRecent: 1 });

    expect(result).toEqual({ summary: "Summarized conversation", messagesCompacted: 2 });
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe("system");
    expect(capturedMessages[1].role).toBe("user");
    expect(capturedMessages[1].content).toContain("[User]: Hello");
    expect(capturedMessages[1].content).toContain("[Assistant]: Hi there");
  });

  it("throws on LLM chat failure", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "How?" },
    ];

    const llmChat = async () => { throw new Error("API error"); };

    await expect(compactMessages(messages, llmChat, "model", { enabled: true, keepRecent: 1 }))
      .rejects.toThrow("Summarization failed: API error");
  });
});

// ── SummarizeShortStrategy ───────────────────────────────────────────────────

describe("SummarizeShortStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new SummarizeShortStrategy();
    expect(strategy.name).toBe("summarize-short");
    expect(strategy.description).toContain("Aggressive");
  });

  it("returns null when not enough messages to compact", async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = await strategy.execute(messages, { keepRecent: 2 }, async () => "summary", "model");
    expect(result).toBeNull();
  });

  it("compacts messages and returns summary", async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = [
      { role: "user", content: "First message" },
      { role: "assistant", content: "First response" },
      { role: "user", content: "Second message" },
      { role: "assistant", content: "Second response" },
      { role: "user", content: "Third message" },
      { role: "assistant", content: "Third response" },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "This is a summary";
    };

    const result = await strategy.execute(messages, { keepRecent: 2 }, llmChat, "test-model");

    expect(result).not.toBeNull();
    expect(result.summary).toBe("This is a summary");
    expect(result.messagesCompacted).toBeGreaterThan(0);
    expect(result.metadata.strategyName).toBe("summarize-short");
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe("system");
    expect(capturedMessages[1].role).toBe("user");
  });

  it("throws on LLM failure", async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "resp1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "resp2" },
    ];
    const llmChat = async () => { throw new Error("API error"); };

    await expect(strategy.execute(messages, { keepRecent: 1 }, llmChat, "model"))
      .rejects.toThrow("Summarization failed: API error");
  });

  it("includes token metadata in result", async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = [
      { role: "user", content: "x".repeat(100) },
      { role: "assistant", content: "y".repeat(100) },
      { role: "user", content: "z".repeat(50) },
      { role: "assistant", content: "w".repeat(50) },
    ];
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result.metadata.tokensBefore).toBeGreaterThan(0);
    expect(result.metadata.tokensAfter).toBeGreaterThan(0);
  });
});

// ── TokenAwareStrategy ───────────────────────────────────────────────────────

describe("TokenAwareStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new TokenAwareStrategy();
    expect(strategy.name).toBe("token-aware");
    expect(strategy.description).toContain("token count");
  });

  it("returns null when not enough messages", async () => {
    const strategy = new TokenAwareStrategy();
    const messages = [{ role: "user", content: "hello" }];
    const result = await strategy.execute(messages, { reserveTokens: 1000, contextLimit: 128000 }, async () => "summary", "model");
    expect(result).toBeNull();
  });

  it("compacts to target token count", async () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
      { role: "user", content: "z".repeat(200) },
      { role: "assistant", content: "w".repeat(200) },
      { role: "user", content: "a".repeat(200) },
      { role: "assistant", content: "b".repeat(200) },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "summary";
    };

    const result = await strategy.execute(messages, { reserveTokens: 100, contextLimit: 150 }, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.summary).toBe("summary");
    expect(result.messagesCompacted).toBeGreaterThan(0);
    expect(result.metadata.strategyName).toBe("token-aware");
    expect(result.metadata.targetTokens).toBe(100);
  });

  it("throws on LLM failure", async () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
      { role: "user", content: "z".repeat(200) },
      { role: "assistant", content: "w".repeat(200) },
    ];
    const llmChat = async () => { throw new Error("API error"); };

    await expect(strategy.execute(messages, { reserveTokens: 100, contextLimit: 150 }, llmChat, "model"))
      .rejects.toThrow("Summarization failed: API error");
  });

  it("canCompact returns true when over limit", () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "x".repeat(500) },
      { role: "assistant", content: "y".repeat(500) },
    ];
    expect(strategy.canCompact(messages, { reserveTokens: 100, contextLimit: 200 })).toBe(true);
  });

  it("canCompact returns false when under limit", () => {
    const strategy = new TokenAwareStrategy();
    const messages = [{ role: "user", content: "hi" }];
    expect(strategy.canCompact(messages, { reserveTokens: 100, contextLimit: 128000 })).toBe(false);
  });

  it("includes detailed token metadata", async () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
      { role: "user", content: "z".repeat(200) },
      { role: "assistant", content: "w".repeat(200) },
    ];
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, { reserveTokens: 100, contextLimit: 150 }, llmChat, "model");

    expect(result.metadata.tokensBefore).toBeGreaterThan(0);
    expect(result.metadata.tokensAfter).toBeGreaterThan(0);
    expect(result.metadata.targetTokens).toBe(100);
    expect(result.metadata.maxKeepTokens).toBe(50);
  });
});

// ── DropStrategy ─────────────────────────────────────────────────────────────

describe("DropStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new DropStrategy();
    expect(strategy.name).toBe("drop");
    expect(strategy.description).toContain("without summarizing");
  });

  it("drops old messages without summarization", async () => {
    const strategy = new DropStrategy();
    const messages = [
      { role: "user", content: "old1" },
      { role: "assistant", content: "old2" },
      { role: "user", content: "recent1" },
      { role: "assistant", content: "recent2" },
    ];
    const llmChat = async () => { throw new Error("Should not be called"); };

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.summary).toBeNull();
    expect(result.messagesCompacted).toBe(3);
  });

  it("returns null when not enough messages", async () => {
    const strategy = new DropStrategy();
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = await strategy.execute(messages, { keepRecent: 2 }, async () => "summary", "model");
    expect(result).toBeNull();
  });
});

// ── SummarizeStrategy ────────────────────────────────────────────────────────

describe("SummarizeStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new SummarizeStrategy();
    expect(strategy.name).toBe("summarize");
    expect(strategy.description).toContain("summarization");
  });

  it("compacts messages with LLM summarization", async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: "user", content: "First message" },
      { role: "assistant", content: "First response" },
      { role: "user", content: "Second message" },
      { role: "assistant", content: "Second response" },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "Summary of conversation";
    };

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.summary).toBe("Summary of conversation");
    expect(result.messagesCompacted).toBeGreaterThan(0);
    expect(result.metadata.strategyName).toBe("summarize");
  });

  it("returns null when not enough messages", async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const result = await strategy.execute(messages, { keepRecent: 2 }, async () => "summary", "model");
    expect(result).toBeNull();
  });

  it("throws on LLM failure", async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "resp1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "resp2" },
    ];
    const llmChat = async () => { throw new Error("API error"); };

    await expect(strategy.execute(messages, { keepRecent: 1 }, llmChat, "model"))
      .rejects.toThrow("Summarization failed: API error");
  });
});

// ── CompactionStrategyRegistry ───────────────────────────────────────────────

describe("CompactionStrategyRegistry", () => {
  it("creates empty registry", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  it("registers and retrieves strategies", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register(new DropStrategy());
    expect(registry.get("drop")).toBeDefined();
    expect(registry.getAll()).toHaveLength(1);
  });

  it("returns undefined for unknown strategy", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("has() checks for strategy existence", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register(new DropStrategy());
    expect(registry.has("drop")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("getDefault returns summarize strategy when registered", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register(new DropStrategy());
    registry.register(new SummarizeStrategy());
    expect(registry.getDefault()).toBeDefined();
  });

  it("getDefault returns undefined when no summarize strategy registered", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.getDefault()).toBeUndefined();
  });

  it("overwrites strategy with same name", () => {
    const registry = new CompactionStrategyRegistry();
    const drop1 = new DropStrategy();
    const drop2 = new DropStrategy();
    registry.register(drop1);
    registry.register(drop2);
    expect(registry.get("drop")).toBe(drop2);
    expect(registry.getAll()).toHaveLength(1);
  });

  it("throws when registering strategy without name", () => {
    const registry = new CompactionStrategyRegistry();
    expect(() => registry.register({ name: null, execute: async () => {} })).toThrow("Strategy must have a name property");
  });
});
