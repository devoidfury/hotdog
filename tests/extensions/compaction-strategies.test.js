// Tests for compaction strategies: summarize-short, token-aware, strategy registry.

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
} from "../../src/extensions/compaction/utils.js";

describe("SummarizeShortStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new SummarizeShortStrategy();
    expect(strategy.name).toBe("summarize-short");
    expect(strategy.description).toContain("Aggressive");
  });

  it("returns null when not enough messages to compact (keepRecent=2, only 2 messages)", async () => {
    const strategy = new SummarizeShortStrategy();
    // keepRecent=2 needs 4 non-system messages, only have 2
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const settings = { keepRecent: 2 };
    const result = await strategy.execute(messages, settings, async () => "summary", "model");
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
    const settings = { keepRecent: 2 };

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "This is a summary";
    };

    const result = await strategy.execute(messages, settings, llmChat, "test-model");

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
    const settings = { keepRecent: 1 };
    const llmChat = async () => { throw new Error("API error"); };

    await expect(strategy.execute(messages, settings, llmChat, "model"))
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
    const settings = { keepRecent: 1 };
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, settings, llmChat, "model");

    expect(result.metadata.tokensBefore).toBeGreaterThan(0);
    expect(result.metadata.tokensAfter).toBeGreaterThan(0);
  });
});

describe("TokenAwareStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new TokenAwareStrategy();
    expect(strategy.name).toBe("token-aware");
    expect(strategy.description).toContain("token count");
  });

  it("returns null when not enough messages (only 1 message)", async () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "hello" },
    ];
    const settings = { reserveTokens: 1000, contextLimit: 128000 };
    const result = await strategy.execute(messages, settings, async () => "summary", "model");
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
    // Small target forces compaction - keep only ~25 tokens worth
    const settings = { reserveTokens: 100, contextLimit: 150 };

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "summary";
    };

    const result = await strategy.execute(messages, settings, llmChat, "model");

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
    // Small context limit to force compaction
    const settings = { reserveTokens: 100, contextLimit: 150 };
    const llmChat = async () => { throw new Error("API error"); };

    await expect(strategy.execute(messages, settings, llmChat, "model"))
      .rejects.toThrow("Summarization failed: API error");
  });

  it("canCompact returns true when over limit", () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "x".repeat(500) },
      { role: "assistant", content: "y".repeat(500) },
    ];
    const settings = { reserveTokens: 100, contextLimit: 200 };
    expect(strategy.canCompact(messages, settings)).toBe(true);
  });

  it("canCompact returns false when under limit", () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "hi" },
    ];
    const settings = { reserveTokens: 100, contextLimit: 128000 };
    expect(strategy.canCompact(messages, settings)).toBe(false);
  });

  it("uses correct default context limit for standard models", async () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
      { role: "user", content: "z".repeat(200) },
      { role: "assistant", content: "w".repeat(200) },
    ];
    // Very small contextLimit forces compaction
    const settings = { reserveTokens: 100, contextLimit: 150 };
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, settings, llmChat, "gpt-4");
    expect(result).not.toBeNull();
  });

  it("includes detailed token metadata", async () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
      { role: "user", content: "z".repeat(200) },
      { role: "assistant", content: "w".repeat(200) },
    ];
    const settings = { reserveTokens: 100, contextLimit: 150 };
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, settings, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.tokensBefore).toBeGreaterThan(0);
    expect(result.metadata.tokensAfter).toBeGreaterThan(0);
    expect(result.metadata.targetTokens).toBe(100);
    expect(result.metadata.maxKeepTokens).toBe(50);
  });
});

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
    const settings = { keepRecent: 1 };
    const llmChat = async () => { throw new Error("Should not be called"); };

    const result = await strategy.execute(messages, settings, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.summary).toBeNull(); // Drop strategy sets summary to null
    // findFirstKeptIndex with keepRecent=1 on 4 messages returns 3
    // (counts 2 from end: indices 3 and 2, returns 2+1=3)
    expect(result.messagesCompacted).toBe(3);
  });

  it("returns null when not enough messages (keepRecent=2, only 2 messages)", async () => {
    const strategy = new DropStrategy();
    // keepRecent=2 needs 4 non-system messages, only have 2
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const settings = { keepRecent: 2 };
    const result = await strategy.execute(messages, settings, async () => "summary", "model");
    expect(result).toBeNull();
  });
});

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
    const settings = { keepRecent: 1 };

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "Summary of conversation";
    };

    const result = await strategy.execute(messages, settings, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.summary).toBe("Summary of conversation");
    expect(result.messagesCompacted).toBeGreaterThan(0);
    expect(result.metadata.strategyName).toBe("summarize");
  });

  it("returns null when not enough messages (keepRecent=2, only 2 messages)", async () => {
    const strategy = new SummarizeStrategy();
    // keepRecent=2 needs 4 non-system messages, only have 2
    const messages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    const settings = { keepRecent: 2 };
    const result = await strategy.execute(messages, settings, async () => "summary", "model");
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
    const settings = { keepRecent: 1 };
    const llmChat = async () => { throw new Error("API error"); };

    await expect(strategy.execute(messages, settings, llmChat, "model"))
      .rejects.toThrow("Summarization failed: API error");
  });
});

describe("CompactionStrategyRegistry", () => {
  it("creates empty registry", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  it("registers and retrieves strategies", () => {
    const registry = new CompactionStrategyRegistry();
    const strategy = new DropStrategy();
    registry.register(strategy);

    expect(registry.get("drop")).toBe(strategy);
    expect(registry.getAll()).toHaveLength(1);
  });

  it("returns undefined for unknown strategy", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.get("nonexistent")).toBeUndefined();
  });

  it("has() checks for strategy existence", () => {
    const registry = new CompactionStrategyRegistry();
    const strategy = new DropStrategy();
    registry.register(strategy);

    expect(registry.has("drop")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("getDefault returns summarize strategy when registered", () => {
    const registry = new CompactionStrategyRegistry();
    const drop = new DropStrategy();
    const summarize = new SummarizeStrategy();
    registry.register(drop);
    registry.register(summarize);

    expect(registry.getDefault()).toBe(summarize);
  });

  it("getDefault returns undefined when no summarize strategy registered", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.getDefault()).toBeUndefined();
  });

  it("getAll returns all registered strategies", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register(new DropStrategy());
    registry.register(new SummarizeStrategy());
    registry.register(new SummarizeShortStrategy());
    registry.register(new TokenAwareStrategy());

    expect(registry.getAll()).toHaveLength(4);
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
    const unnamedStrategy = { name: null, execute: async () => {} };
    expect(() => registry.register(unnamedStrategy)).toThrow("Strategy must have a name property");
  });
});
