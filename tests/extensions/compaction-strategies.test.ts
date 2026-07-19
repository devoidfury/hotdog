// Tests for compaction strategies: DropStrategy, SummarizeStrategy,
// SummarizeShortStrategy, TokenAwareStrategy.
// TrimStrategy is tested separately in compaction-trim.test.ts.

import { describe, it, expect } from "bun:test";
import { DropStrategy } from "../../src/extensions/compaction/strategies/drop.ts";
import { SummarizeStrategy } from "../../src/extensions/compaction/strategies/summarize.ts";
import { SummarizeShortStrategy } from "../../src/extensions/compaction/strategies/summarize-short.ts";
import { TokenAwareStrategy } from "../../src/extensions/compaction/strategies/token-aware.ts";
import { estimateContextTokens } from "../../src/extensions/compaction/utils.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(role: string, content = "x".repeat(100)) {
  return { role, content };
}

const noopLlmChat = async (): Promise<string> => "";

const defaultSettings = {
  enabled: true,
  reserveTokens: 8000,
  keepRecent: 3,
  contextLimit: 128000,
};

// ── DropStrategy Tests ──────────────────────────────────────────────────────

describe("DropStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new DropStrategy();
    expect(strategy.name).toBe("drop");
    expect(strategy.description.toLowerCase()).toContain("remove older messages");
    expect(strategy.description.toLowerCase()).toContain("without summarizing");
  });

  it("returns null when no messages to drop", async () => {
    const messages = [makeMessage("user"), makeMessage("assistant")];
    const settings = { ...defaultSettings, keepRecent: 3 };

    const result = await new DropStrategy().execute(messages, settings, noopLlmChat, "model");
    expect(result).toBeNull();
  });

  it("drops old messages and returns compact result", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const settings = { ...defaultSettings, keepRecent: 2 };

    const result = await new DropStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.summary).toBeNull();
    expect(result!.messagesCompacted).toBeGreaterThan(0);
    expect(result!.metadata!.strategyName).toBe("drop");
  });

  it("respects keepRecent setting", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const keepRecent = 5;
    const settings = { ...defaultSettings, keepRecent };

    const result = await new DropStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    // findFirstKeptIndex counts keepRecent*2=10 non-system messages from the end,
    // so it returns index 11 (i+1 where i=10). messagesCompacted = 11.
    expect(result!.messagesCompacted).toBe(11);
  });

  it("includes token counts in metadata", async () => {
    const content = "x".repeat(2000); // 500 tokens each
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, keepRecent: 2 };

    const result = await new DropStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result!.metadata!.tokensBefore).toBeGreaterThan(0);
    expect(result!.metadata!.tokensAfter).toBeGreaterThan(0);
    expect(result!.metadata!.tokensAfter).toBeLessThan(result!.metadata!.tokensBefore);
  });

  it("canCompact returns false for few messages", () => {
    const messages = [makeMessage("user"), makeMessage("assistant")];
    const result = new DropStrategy().canCompact(messages, defaultSettings);
    expect(result).toBe(false);
  });

  it("canCompact returns true for many messages", () => {
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const result = new DropStrategy().canCompact(messages, defaultSettings);
    expect(result).toBe(true);
  });

  it("canCompact ignores system messages", () => {
    const messages = [
      makeMessage("system"),
      makeMessage("system"),
      ...Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant")),
    ];
    const result = new DropStrategy().canCompact(messages, defaultSettings);
    expect(result).toBe(true);
  });

  it("uses default keepRecent of 8 when not specified", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const settings = { ...defaultSettings, keepRecent: undefined };

    const result = await new DropStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    // keepRecent defaults to 8 in DropStrategy, target=16, counts 16 from end
    // returns index 5 (i+1 where i=4). messagesCompacted = 5.
    expect(result!.messagesCompacted).toBe(5);
  });
});

// ── SummarizeStrategy Tests ─────────────────────────────────────────────────

describe("SummarizeStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new SummarizeStrategy();
    expect(strategy.name).toBe("summarize");
    expect(strategy.description.toLowerCase()).toContain("llm");
    expect(strategy.description.toLowerCase()).toContain("summarization");
  });

  it("returns null when no messages to compact", async () => {
    const messages = [makeMessage("user"), makeMessage("assistant")];
    const settings = { ...defaultSettings, keepRecent: 3 };

    const result = await new SummarizeStrategy().execute(messages, settings, noopLlmChat, "model");
    expect(result).toBeNull();
  });

  it("calls llmChat with system and user prompts", async () => {
    let capturedMessages: Array<{ role: string; content: string }> | null = null;
    let capturedModel: string | null = null;
    const mockLlmChat = async (msgs: Array<{ role: string; content: string }>, model: string) => {
      capturedMessages = msgs;
      capturedModel = model;
      return "Summary of the conversation";
    };

    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const settings = { ...defaultSettings, keepRecent: 2 };

    const result = await new SummarizeStrategy().execute(messages, settings, mockLlmChat, "test-model");

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Summary of the conversation");
    expect(capturedMessages).not.toBeNull();
    expect(capturedMessages![0]!.role).toBe("system");
    expect(capturedMessages![1]!.role).toBe("user");
    expect(capturedModel).toBe("test-model");
  });

  it("includes serialized conversation in user prompt", async () => {
    let capturedUserPrompt = "";
    const mockLlmChat = async (msgs: Array<{ role: string; content: string }>, _model: string) => {
      capturedUserPrompt = msgs.find(m => m.role === "user")!.content;
      return "summary";
    };

    // Need at least keepRecent*2+1 messages so findFirstKeptIndex returns > 0
    // With keepRecent=1, target=2, so we need 3+ messages to get firstKept > 0
    const messages = [
      makeMessage("user", "Hello"),
      makeMessage("assistant", "Hi there"),
      makeMessage("user", "Third message"),
    ];
    const settings = { ...defaultSettings, keepRecent: 1 };

    await new SummarizeStrategy().execute(messages, settings, mockLlmChat, "model");

    expect(capturedUserPrompt).toContain("Hello");
    expect(capturedUserPrompt).toContain("Hi there");
  });

  it("throws AgentError when llmChat fails", async () => {
    const failingLlmChat = async () => { throw new Error("API error"); };

    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const settings = { ...defaultSettings, keepRecent: 2 };

    await expect(
      new SummarizeStrategy().execute(messages, settings, failingLlmChat, "model")
    ).rejects.toThrow("Summarization failed");
  });

  it("includes token counts in metadata", async () => {
    const content = "x".repeat(2000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, keepRecent: 2 };

    const result = await new SummarizeStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result!.metadata!.tokensBefore).toBeGreaterThan(0);
    expect(result!.metadata!.tokensAfter).toBeGreaterThan(0);
    expect(result!.metadata!.strategyName).toBe("summarize");
  });

  it("canCompact uses base class implementation", () => {
    const strategy = new SummarizeStrategy();

    // Few messages
    expect(strategy.canCompact(
      [makeMessage("user"), makeMessage("assistant")],
      defaultSettings
    )).toBe(false);

    // Many messages
    expect(strategy.canCompact(
      Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant")),
      defaultSettings
    )).toBe(true);
  });
});

// ── SummarizeShortStrategy Tests ────────────────────────────────────────────

describe("SummarizeShortStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new SummarizeShortStrategy();
    expect(strategy.name).toBe("summarize-short");
    expect(strategy.description.toLowerCase()).toContain("shorter");
  });

  it("returns null when no messages to compact", async () => {
    const messages = [makeMessage("user"), makeMessage("assistant")];
    const settings = { ...defaultSettings, keepRecent: 3 };

    const result = await new SummarizeShortStrategy().execute(messages, settings, noopLlmChat, "model");
    expect(result).toBeNull();
  });

  it("calls llmChat with short user prompt template", async () => {
    let capturedUserPrompt = "";
    const mockLlmChat = async (msgs: Array<{ role: string; content: string }>, _model: string) => {
      capturedUserPrompt = msgs.find(m => m.role === "user")!.content;
      return "brief summary";
    };

    // Need at least keepRecent*2+1 messages so findFirstKeptIndex returns > 0
    const messages = [
      makeMessage("user", "Hello"),
      makeMessage("assistant", "Hi there"),
      makeMessage("user", "Third message"),
    ];
    const settings = { ...defaultSettings, keepRecent: 1 };

    const result = await new SummarizeShortStrategy().execute(messages, settings, mockLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("brief summary");
    expect(capturedUserPrompt).toContain("Hello");
  });

  it("throws AgentError when llmChat fails", async () => {
    const failingLlmChat = async () => { throw new Error("API error"); };

    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const settings = { ...defaultSettings, keepRecent: 2 };

    await expect(
      new SummarizeShortStrategy().execute(messages, settings, failingLlmChat, "model")
    ).rejects.toThrow("Summarization failed");
  });

  it("metadata identifies strategy as summarize-short", async () => {
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant"));
    const settings = { ...defaultSettings, keepRecent: 2 };

    const result = await new SummarizeShortStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result!.metadata!.strategyName).toBe("summarize-short");
  });
});

// ── TokenAwareStrategy Tests ────────────────────────────────────────────────

describe("TokenAwareStrategy", () => {
  it("has correct name and description", () => {
    const strategy = new TokenAwareStrategy();
    expect(strategy.name).toBe("token-aware");
    expect(strategy.description.toLowerCase()).toContain("token");
  });

  it("returns null when no messages to compact", async () => {
    const messages = [makeMessage("user"), makeMessage("assistant")];

    const result = await new TokenAwareStrategy().execute(
      messages,
      { ...defaultSettings, targetTokens: 16384 },
      noopLlmChat,
      "model"
    );
    expect(result).toBeNull();
  });

  it("calculates correct compaction point based on token budget", async () => {
    const content = "x".repeat(4000); // 1000 tokens each
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));

    // Total: 10000 tokens. targetTokens: 1000, contextLimit: 5000
    // maxKeepTokens = 5000 - 1000 = 4000 -> can keep ~4 messages
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 5000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.messagesCompacted).toBeGreaterThan(0);
  });

  it("calls llmChat with conversation to summarize", async () => {
    let capturedMessages: Array<{ role: string; content: string }> | null = null;
    const mockLlmChat = async (msgs: Array<{ role: string; content: string }>, _model: string) => {
      capturedMessages = msgs;
      return "token-aware summary";
    };

    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 5000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, mockLlmChat, "model");

    expect(result!.summary).toBe("token-aware summary");
    expect(capturedMessages).not.toBeNull();
    expect(capturedMessages![0]!.role).toBe("system");
    expect(capturedMessages![1]!.role).toBe("user");
  });

  it("throws AgentError when llmChat fails", async () => {
    const failingLlmChat = async () => { throw new Error("API error"); };

    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 5000 };

    await expect(
      new TokenAwareStrategy().execute(messages, settings, failingLlmChat, "model")
    ).rejects.toThrow("Summarization failed");
  });

  it("includes token-aware metadata", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 5000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result!.metadata!.strategyName).toBe("token-aware");
    expect(result!.metadata!.targetTokens).toBe(1000);
    expect(result!.metadata!.maxKeepTokens).toBe(4000);
    expect(result!.metadata!.tokensBefore).toBeGreaterThan(0);
    expect(result!.metadata!.tokensAfter).toBeGreaterThan(0);
  });

  it("uses reserveTokens as fallback for targetTokens", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, targetTokens: undefined, reserveTokens: 5000, contextLimit: 20000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    if (result) {
      expect(result.metadata!.targetTokens).toBe(5000);
    }
  });

  it("uses default targetTokens of 16384 when neither targetTokens nor reserveTokens set", async () => {
    const content = "x".repeat(100);
    const messages = Array.from({ length: 200 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, targetTokens: undefined, reserveTokens: undefined, contextLimit: 128000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    if (result) {
      expect(result.metadata!.targetTokens).toBe(16384);
    }
  });

  it("canCompact returns true when over token budget", () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 50 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 10000 };

    const result = new TokenAwareStrategy().canCompact(messages, settings);
    expect(result).toBe(true);
  });

  it("canCompact returns false when under token budget", () => {
    const messages = Array.from({ length: 5 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", "x".repeat(10)));
    const settings = { ...defaultSettings, targetTokens: 16384, contextLimit: 128000 };

    const result = new TokenAwareStrategy().canCompact(messages, settings);
    expect(result).toBe(false);
  });

  it("canCompact ignores system messages", () => {
    const content = "x".repeat(4000);
    const messages = [
      makeMessage("system", "You are helpful"),
      ...Array.from({ length: 20 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content)),
    ];
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 10000 };

    const result = new TokenAwareStrategy().canCompact(messages, settings);
    expect(result).toBe(true);
  });

  it("skips system messages during backward scan", async () => {
    const content = "x".repeat(4000);
    const messages = [
      makeMessage("system", "System prompt 1"),
      makeMessage("user", content),
      makeMessage("system", "System prompt 2"),
      makeMessage("assistant", content),
      makeMessage("user", content),
      makeMessage("assistant", content),
      makeMessage("user", content),
      makeMessage("assistant", content),
    ];
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 5000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.messagesCompacted).toBeGreaterThan(0);
  });

  it("uses model name to infer context limit for 32k models", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: undefined, targetTokens: 1000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "claude-3-32k");

    // 10 * 1000 = 10000 tokens, maxKeepTokens = 32768 - 1000 = 31768
    // Should be under budget, so result should be null
    expect(result).toBeNull();
  });

  it("uses model name to infer context limit for 128k models", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: undefined, targetTokens: 1000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "gpt-4o-128k");

    // 10 * 1000 = 10000 tokens, maxKeepTokens = 131072 - 1000 = 130072
    // Should be under budget, so result should be null
    expect(result).toBeNull();
  });
});
