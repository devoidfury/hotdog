// Tests for TokenAwareStrategy. The rendered prompts themselves are covered
// behaviorally (via captured llmChat calls) in
// compaction-strategy-summarize.test.ts.
// DropStrategy and SummarizeStrategy/SummarizeShortStrategy are covered by
// their dedicated files; TrimStrategy in compaction-trim.test.ts.

import { describe, it, expect } from "bun:test";
import { TokenAwareStrategy } from "../../src/extensions/compaction/strategies/token-aware.ts";
import { Message } from "../../src/core/context/message.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessage(role: string, content = "x".repeat(100)) {
  return new Message({ role, content });
}

const noopLlmChat = async (_messages: Array<{ role: string; content: string }>, _model: string): Promise<string> => "";

const defaultSettings = {
  enabled: true,
  reserveTokens: 8000,
  keepRecentMessages: 3,
  contextLimit: 128000,
};

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

  it("keeps the parent assistant tool_calls message with retained tool results", async () => {
    const messages = [
      makeMessage("user", "u".repeat(1000)), // 250 tokens
      new Message({
        role: "assistant",
        content: "a".repeat(800), // 200 tokens + tool calls
        toolCalls: [
          { id: "call-1", type: "function", function: { name: "bash", arguments: "{}" } },
          { id: "call-2", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      }),
      makeMessage("tool", "t".repeat(1000)), // 250 tokens
      makeMessage("tool", "t".repeat(1000)), // 250 tokens
    ];

    // maxKeepTokens = 700 - 200 = 500: fits the two tool results (500)
    // but not their parent assistant message. The kept window must back up
    // to include the parent, never start with an orphaned tool result.
    const settings = { ...defaultSettings, targetTokens: 200, contextLimit: 700 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(messages[result!.messagesCompacted]!.role).not.toBe("tool");
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

  it("uses reserveTokens when targetTokens not set", async () => {
    // 200 * 1000 = 200000 tokens, well over the 120000 keep budget, so
    // compaction actually happens and the metadata is real.
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 200 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: 128000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.metadata!.targetTokens).toBe(defaultSettings.reserveTokens);
    expect(result!.metadata!.maxKeepTokens).toBe(128000 - defaultSettings.reserveTokens);
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

  it("infers context limit from the model name when not configured", async () => {
    const content = "x".repeat(4000); // 1000 tokens per message
    const messages = Array.from({ length: 30 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    // 30 * 1000 = 30000 tokens, targetTokens 5000:
    //   32k model  -> keep budget 27768, over budget  -> must compact
    //   128k model -> keep budget 126072, under budget -> null
    // The divergent outcomes prove the model name is honored, not silently
    // bumped to the 128k default.
    const settings = { ...defaultSettings, contextLimit: undefined, targetTokens: 5000 };

    const result32k = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "claude-3-32k");
    expect(result32k).not.toBeNull();
    expect(result32k!.metadata!.maxKeepTokens).toBe(32768 - 5000);

    const result128k = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "gpt-4o-128k");
    expect(result128k).toBeNull();
  });

  it("handles null/undefined messages in backward scan", async () => {
    const content = "x".repeat(4000);
    const messages: Message[] = [
      makeMessage("user", content),
      makeMessage("assistant", content),
      null as unknown as Message,
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

  it("handles null messages interspersed that get filtered during summarization", async () => {
    const content = "x".repeat(4000);
    // Place nulls in the range that will be summarized (before lastKeptIndex)
    const messages: Message[] = [
      makeMessage("user", content),
      null as unknown as Message,
      makeMessage("assistant", content),
      null as unknown as Message,
      makeMessage("user", content),
      makeMessage("assistant", content),
      makeMessage("user", content),
      makeMessage("assistant", content),
    ];
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 5000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).not.toBeNull();
    expect(result!.messagesCompacted).toBeGreaterThan(0);
    // Verify the nulls were properly filtered out and didn't crash
    expect(result!.summary).toBe("");
  });

  it("canCompact returns false for empty messages", () => {
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 10000 };

    const result = new TokenAwareStrategy().canCompact([], settings);
    expect(result).toBe(false);
  });

  it("canCompact returns false when only system messages present", () => {
    const messages = [
      makeMessage("system", "You are helpful"),
      makeMessage("system", "Follow rules"),
    ];
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 10000 };

    const result = new TokenAwareStrategy().canCompact(messages, settings);
    expect(result).toBe(false);
  });

  it("execute compacts only non-system messages when system messages interspersed", async () => {
    const messages = [
      makeMessage("system", "You are helpful"),
      makeMessage("user", "hello"),
      makeMessage("system", "Follow rules"),
    ];
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 10000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    // Keeps the user message, compacts the system message before it
    expect(result).not.toBeNull();
    expect(result!.messagesCompacted).toBe(1);
  });

  it("execute returns null when all messages are system messages", async () => {
    const messages = [
      makeMessage("system", "You are helpful"),
      makeMessage("system", "Follow rules"),
    ];
    const settings = { ...defaultSettings, targetTokens: 1000, contextLimit: 10000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "model");

    expect(result).toBeNull();
  });

  it("uses default context limit of 128000 when not specified and model unknown", async () => {
    const content = "x".repeat(4000);
    const messages = Array.from({ length: 10 }, (_, i) => makeMessage(i % 2 === 0 ? "user" : "assistant", content));
    const settings = { ...defaultSettings, contextLimit: undefined, targetTokens: 1000 };

    const result = await new TokenAwareStrategy().execute(messages, settings, noopLlmChat, "unknown-model");

    // 10 * 1000 = 10000 tokens, maxKeepTokens = 128000 - 1000 = 127000
    // Should be under budget, so result should be null
    expect(result).toBeNull();
  });
});
