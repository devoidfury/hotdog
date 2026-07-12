// Tests for compaction strategies and utilities.
// Merged from compaction-strategies.test.ts + compaction.test.ts to reduce duplication.

import { describe, it, expect } from "bun:test";
import { SummarizeShortStrategy } from "../../src/extensions/compaction/strategies/summarize-short.ts";
import { TokenAwareStrategy } from "../../src/extensions/compaction/strategies/token-aware.ts";
import { DropStrategy } from "../../src/extensions/compaction/strategies/drop.ts";
import { SummarizeStrategy } from "../../src/extensions/compaction/strategies/summarize.ts";
import { CompactionStrategyRegistry } from "../../src/extensions/compaction/strategies.ts";
import {
  estimateMessageTokens,
  estimateContextTokens,
  serializeConversation,
  findFirstKeptIndex,
  shouldCompact,
  compactMessages,
} from "../../src/extensions/compaction/utils.ts";

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

  it("estimates tokens for assistant with multiple tool calls", () => {
    const msg = {
      role: "assistant",
      content: "Running two commands",
      tool_calls: [
        { function: { name: "bash", arguments: '{"cmd": "ls"}' } },
        { function: { name: "read", arguments: '{"path": "file.txt"}' } },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    const chars = "Running two commands".length + "bash".length + '{"cmd": "ls"}'.length + "read".length + '{"path": "file.txt"}'.length;
    expect(tokens).toBe(Math.ceil(chars / 4));
  });

  it("estimates tokens for assistant without reasoning or tool calls", () => {
    const msg = { role: "assistant", content: "Simple response" };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(Math.ceil("Simple response".length / 4));
  });

  it("handles edge cases: unknown role, empty reasoning, no tool_calls", () => {
    // Unknown role should still estimate > 0
    expect(estimateMessageTokens({ role: "unknown", content: "something" })).toBeGreaterThan(0);
    // Empty reasoning_content adds 0 chars
    expect(estimateMessageTokens({ role: "assistant", content: "Hi", reasoning_content: "" }))
      .toBe(Math.ceil("Hi".length / 4));
    // No tool_calls property is same as empty
    expect(estimateMessageTokens({ role: "assistant", content: "Hi" }))
      .toBe(Math.ceil("Hi".length / 4));
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

  it("handles messages with mixed roles", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "User message" },
      { role: "assistant", content: "Assistant response" },
      { role: "tool", content: "Tool output" },
    ];
    const total = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    expect(estimateContextTokens(messages)).toBe(total);
  });

  it("handles messages with tool_calls", () => {
    const messages = [
      { role: "assistant", content: "Let me check", tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "ls -la"}' } }] },
    ];
    const tokens = estimateContextTokens(messages);
    expect(tokens).toBeGreaterThan(Math.ceil("Let me check".length / 4));
  });
});

describe("shouldCompact", () => {
  const scenarios = [
    { name: "over limit", messages: [{ role: "user", content: "x".repeat(200) }, { role: "assistant", content: "y".repeat(200) }], limit: 100, reserve: 50, expected: true },
    { name: "under limit", messages: [{ role: "user", content: "Hi" }], limit: 1000, reserve: 100, expected: false },
    { name: "exactly at limit", messages: [{ role: "user", content: "x".repeat(400) }, { role: "assistant", content: "x".repeat(400) }], limit: 200, reserve: 0, expected: false },
    { name: "just over limit", messages: [{ role: "user", content: "x".repeat(404) }, { role: "assistant", content: "x".repeat(404) }], limit: 200, reserve: 0, expected: true },
    { name: "empty messages", messages: [], limit: 100, reserve: 50, expected: false },
  ];

  for (const { name, messages, limit, reserve, expected } of scenarios) {
    it(`returns ${expected} when ${name}`, () => {
      expect(shouldCompact(messages, limit, reserve)).toBe(expected);
    });
  }
});

describe("findFirstKeptIndex", () => {
  it("returns 0 for edge cases: keepRecent=0, not enough messages, all system, empty array", () => {
    expect(findFirstKeptIndex([{ role: "user", content: "test" }], 0)).toBe(0);
    expect(findFirstKeptIndex([{ role: "user", content: "test" }], 1)).toBe(0);
    expect(findFirstKeptIndex([{ role: "system", content: "a" }, { role: "system", content: "b" }], 1)).toBe(0);
    expect(findFirstKeptIndex([], 1)).toBe(0);
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

  it("returns correct index when system messages are interspersed", () => {
    const messages = [
      { role: "user", content: "1" },
      { role: "system", content: "mid-prompt" },
      { role: "assistant", content: "2" },
      { role: "user", content: "3" },
      { role: "assistant", content: "4" },
    ];
    // Non-system: user(0), assistant(2), user(3), assistant(4) = 4 messages
    // keepRecent=1 => need 2 from end => keep assistant(4), user(3) => firstKept = 4
    expect(findFirstKeptIndex(messages, 1)).toBe(4);
  });

  // Parameterized keepRecent tests
  const keepRecentScenarios = [
    { keepRecent: 2, messages: 6, expected: 3 },
    { keepRecent: 3, messages: 8, expected: 3 },
  ];

  for (const { keepRecent, messages, expected } of keepRecentScenarios) {
    it(`returns correct index for keepRecent=${keepRecent} with ${messages} messages`, () => {
      const msgs = Array.from({ length: messages }, (_, i) => ({
        role: i % 2 === 0 ? "user" : "assistant",
        content: String(i + 1),
      }));
      expect(findFirstKeptIndex(msgs, keepRecent)).toBe(expected);
    });
  }
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

  it("includes reasoning_content in serialized conversation", () => {
    const messages = [
      { role: "assistant", content: "I think the answer is 42", reasoning_content: "Let me calculate this step by step..." },
      { role: "user", content: "What is 6 * 7?" },
    ];

    const serialized = serializeConversation(messages);
    expect(serialized).toContain("[Assistant thinking]");
    expect(serialized).toContain("Let me calculate this step by step...");
    expect(serialized).toContain("[Assistant]: I think the answer is 42");
  });

  it("includes both content and tool_calls for assistant", () => {
    const messages = [
      { role: "assistant", content: "I'll run these commands", tool_calls: [
        { function: { name: "bash", arguments: '{"cmd": "ls"}' } },
        { function: { name: "read", arguments: '{"path": "file.txt"}' } },
      ]},
    ];

    const serialized = serializeConversation(messages);
    expect(serialized).toContain("[Assistant]: I'll run these commands");
    expect(serialized).toContain("[Assistant tool calls]");
    expect(serialized).toContain("bash");
    expect(serialized).toContain("read");
  });

  it("returns empty string for empty messages", () => {
    expect(serializeConversation([])).toBe("");
  });

  it("handles edge cases: unknown role, reasoning-only, tool_calls-only", () => {
    expect(serializeConversation([{ role: "custom", content: "custom message" }]))
      .toContain("[custom]: custom message");

    const reasoningOnly = serializeConversation([{ role: "assistant", reasoning_content: "Thinking..." }]);
    expect(reasoningOnly).toContain("[Assistant thinking]: Thinking...");
    expect(reasoningOnly).not.toContain("[Assistant]: ");

    const toolCallsOnly = serializeConversation([{
      role: "assistant", tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "echo"}' } }]
    }]);
    expect(toolCallsOnly).toContain("[Assistant tool calls]");
    expect(toolCallsOnly).not.toContain("[Assistant]: ");
  });

  it("handles tool result under truncation threshold", () => {
    const messages = [
      { role: "tool", content: "short output" },
    ];
    const serialized = serializeConversation(messages);
    expect(serialized).toBe("[Tool result]: short output");
    expect(serialized).not.toContain("truncated");
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

  it("skips system messages when compacting", async () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "Summary";
    };

    const result = await compactMessages(messages, llmChat, "model", { enabled: true, keepRecent: 1 });

    expect(result).not.toBeNull();
    // System message should be excluded from the conversation sent to LLM
    for (const msg of capturedMessages) {
      if (msg.role === "user") {
        expect(msg.content).not.toContain("System prompt");
      }
    }
  });

  it("passes model to llmChat", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];

    let capturedModel = null;
    const llmChat = async (msgs, model) => {
      capturedModel = model;
      return "Summary";
    };

    await compactMessages(messages, llmChat, "my-custom-model", { enabled: true, keepRecent: 1 });
    expect(capturedModel).toBe("my-custom-model");
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

  it("uses the short prompt template (not the full template)", async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];

    let capturedUserPrompt = null;
    const llmChat = async (msgs) => {
      capturedUserPrompt = msgs.find(m => m.role === "user").content;
      return "summary";
    };

    await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    // The short prompt should contain "CONCISE" and NOT contain "In Progress" or "Blocked"
    expect(capturedUserPrompt).toContain("CONCISE");
    expect(capturedUserPrompt).not.toContain("### Blocked");
  });

  it("handles messages with reasoning_content", async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4", reasoning_content: "Let me think about this..." },
      { role: "user", content: "And 3+3?" },
      { role: "assistant", content: "6", reasoning_content: "Simple math..." },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "summary";
    };

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result).not.toBeNull();
    // The serialized conversation should include thinking content
    const userMsg = capturedMessages.find(m => m.role === "user");
    expect(userMsg.content).toContain("thinking");
  });

  it("handles messages with tool_calls", async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = [
      { role: "user", content: "List files" },
      { role: "assistant", content: "Running ls", tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "ls"}' } }] },
      { role: "tool", content: "file1.txt", role: "tool" },
      { role: "user", content: "And now read file1.txt" },
      { role: "assistant", content: "Reading file", tool_calls: [{ function: { name: "read", arguments: '{"path": "file1.txt"}' } }] },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "summary";
    };

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result).not.toBeNull();
    const userMsg = capturedMessages.find(m => m.role === "user");
    expect(userMsg.content).toContain("tool calls");
  });

  it("passes model to llmChat", async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "How?" },
    ];

    let capturedModel = null;
    const llmChat = async (msgs, model) => {
      capturedModel = model;
      return "summary";
    };

    await strategy.execute(messages, { keepRecent: 1 }, llmChat, "my-model");
    expect(capturedModel).toBe("my-model");
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

  it("uses targetTokens when explicitly provided", async () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
      { role: "user", content: "z".repeat(200) },
      { role: "assistant", content: "w".repeat(200) },
    ];
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, { targetTokens: 50, contextLimit: 150 }, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.targetTokens).toBe(50);
  });

  it("infers context limit from 32k model name", async () => {
    const strategy = new TokenAwareStrategy();
    // Need enough messages to exceed 32k context. Each message ~1250 tokens.
    // 30 messages = ~37500 tokens > 32768.
    const bigContent = "x".repeat(5000);
    const messages = Array.from({ length: 30 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: bigContent,
    }));
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, { reserveTokens: 100 }, llmChat, "gpt-3.5-turbo-32k");

    expect(result).not.toBeNull();
    // contextLimit should be ~32768, so maxKeepTokens = 32768 - 100 = 32668
    expect(result.metadata.maxKeepTokens).toBe(32668);
  });

  it("infers context limit from 128k model name", async () => {
    const strategy = new TokenAwareStrategy();
    // Need enough messages to exceed 128k context. Each ~1250 tokens.
    // 110 messages = ~137500 tokens > 131072.
    const bigContent = "x".repeat(5000);
    const messages = Array.from({ length: 110 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: bigContent,
    }));
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, { reserveTokens: 100 }, llmChat, "gpt-4o-128k");

    expect(result).not.toBeNull();
    expect(result.metadata.maxKeepTokens).toBe(130972); // 131072 - 100
  });

  it("falls back to 128000 context limit for unknown model", async () => {
    const strategy = new TokenAwareStrategy();
    const bigContent = "x".repeat(5000);
    const messages = Array.from({ length: 110 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: bigContent,
    }));
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, { reserveTokens: 100 }, llmChat, "some-unknown-model");

    expect(result).not.toBeNull();
    expect(result.metadata.maxKeepTokens).toBe(127900); // 128000 - 100
  });

  it("skips system messages when counting tokens", async () => {
    const strategy = new TokenAwareStrategy();
    // Use small enough messages that at least one fits in maxKeepTokens
    const messages = [
      { role: "system", content: "x".repeat(10000) }, // 2500 tokens (skipped)
      { role: "user", content: "x".repeat(200) },     // 50 tokens
      { role: "assistant", content: "y".repeat(200) }, // 50 tokens
      { role: "user", content: "z".repeat(200) },     // 50 tokens
      { role: "assistant", content: "w".repeat(200) }, // 50 tokens
    ];
    const llmChat = async () => "summary";

    // Note: reserveTokens: 0 is treated as falsy, so targetTokens falls back to 16384.
    // Use targetTokens explicitly to test system message skipping.
    // maxKeepTokens = 100 - 10 = 90. Non-system: 4 * 50 = 200 > 90 => need compact.
    // From end: assistant(50) => cumulative=50, fits. lastKeptIndex=4.
    // user(50): 50+50=100 > 90. break.
    // lastKeptIndex=4, messagesToCompact=4
    const result = await strategy.execute(messages, { targetTokens: 10, contextLimit: 100 }, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.maxKeepTokens).toBe(90);
  });

  it("returns null when cumulative tokens for all non-system messages exceed maxKeepTokens immediately", async () => {
    const strategy = new TokenAwareStrategy();
    // Single large message that exceeds maxKeepTokens
    const messages = [
      { role: "user", content: "x".repeat(1000) }, // 250 tokens
    ];
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, { reserveTokens: 0, contextLimit: 100 }, llmChat, "model");

    // maxKeepTokens = 100, first message is 250 tokens > 100 => lastKeptIndex stays 0 => return null
    expect(result).toBeNull();
  });

  it("canCompact returns false when non-system messages are under budget", () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    expect(strategy.canCompact(messages, { reserveTokens: 1000, contextLimit: 128000 })).toBe(false);
  });

  it("canCompact returns true when non-system messages exceed budget", () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "user", content: "x".repeat(5000) }, // ~1250 tokens
      { role: "assistant", content: "y".repeat(5000) }, // ~1250 tokens
    ];
    expect(strategy.canCompact(messages, { reserveTokens: 100, contextLimit: 2000 })).toBe(true);
  });

  it("canCompact ignores system messages", () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: "system", content: "x".repeat(10000) }, // 2500 tokens
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    // Non-system: 2 + 6 = 8 chars => 2 tokens, well under budget
    expect(strategy.canCompact(messages, { reserveTokens: 100, contextLimit: 128000 })).toBe(false);
  });

  it("passes model to llmChat", async () => {
    const strategy = new TokenAwareStrategy();
    // Use small enough messages that at least one fits in maxKeepTokens=50
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(100), // ~25 tokens each
    }));

    let capturedModel = null;
    const llmChat = async (msgs, model) => {
      capturedModel = model;
      return "summary";
    };

    await strategy.execute(messages, { reserveTokens: 100, contextLimit: 150 }, llmChat, "my-model");
    expect(capturedModel).toBe("my-model");
  });

  it("uses reserveTokens as targetTokens when targetTokens not set", async () => {
    const strategy = new TokenAwareStrategy();
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(100), // ~25 tokens each
    }));
    const llmChat = async () => "summary";

    // targetTokens = 200 (from reserveTokens), contextLimit = 150
    // maxKeepTokens = 150 - 200 = -50. No messages fit.
    // Use different values: reserveTokens=50, contextLimit=150 => maxKeepTokens=100
    const result = await strategy.execute(messages, { reserveTokens: 50, contextLimit: 150 }, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.targetTokens).toBe(50);
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

  it("handles messages with system messages mixed in", async () => {
    const strategy = new DropStrategy();
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "old1" },
      { role: "assistant", content: "old2" },
      { role: "user", content: "recent1" },
      { role: "assistant", content: "recent2" },
    ];
    const llmChat = async () => { throw new Error("Should not be called"); };

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.summary).toBeNull();
    // Should compact past the system message and the first pair
    expect(result.messagesCompacted).toBeGreaterThan(0);
  });

  it("handles messages with tool_calls and reasoning_content", async () => {
    const strategy = new DropStrategy();
    const messages = [
      { role: "user", content: "List files" },
      { role: "assistant", content: "Running ls", tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "ls"}' } }] },
      { role: "tool", content: "file1.txt" },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4", reasoning_content: "Simple math" },
    ];
    const llmChat = async () => { throw new Error("Should not be called"); };

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result).not.toBeNull();
    expect(result.metadata.tokensBefore).toBeGreaterThan(result.metadata.tokensAfter);
  });

  it("returns null when all messages are system", async () => {
    const strategy = new DropStrategy();
    const messages = [
      { role: "system", content: "prompt1" },
      { role: "system", content: "prompt2" },
    ];
    const result = await strategy.execute(messages, { keepRecent: 1 }, async () => "summary", "model");
    expect(result).toBeNull();
  });

  // Parameterized canCompact tests
  const canCompactScenarios = [
    { name: "few non-system messages", messages: [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }], opts: { keepRecent: 3 }, expected: false },
    { name: "enough non-system messages", messages: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" })), opts: { keepRecent: 1 }, expected: true },
    { name: "ignores system messages", messages: [{ role: "system", content: "p" }, { role: "system", content: "p2" }, { role: "user", content: "hi" }, { role: "assistant", content: "hello" }], opts: { keepRecent: 3 }, expected: false },
    { name: "default keepRecent of 3, 6 messages (equal)", messages: Array.from({ length: 6 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" })), opts: {}, expected: false },
    { name: "default keepRecent of 3, 7 messages (exceeds)", messages: Array.from({ length: 7 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: "x" })), opts: {}, expected: true },
  ];

  for (const { name, messages, opts, expected } of canCompactScenarios) {
    it(`canCompact returns ${expected} when ${name}`, () => {
      const strategy = new DropStrategy();
      expect(strategy.canCompact(messages, opts)).toBe(expected);
    });
  }

  it("includes correct token metadata", async () => {
    const strategy = new DropStrategy();
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
      { role: "user", content: "z".repeat(200) },
      { role: "assistant", content: "w".repeat(200) },
    ];
    const llmChat = async () => { throw new Error("Should not be called"); };

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result.metadata.tokensBefore).toBeGreaterThan(0);
    expect(result.metadata.tokensAfter).toBeLessThan(result.metadata.tokensBefore);
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

  it("uses the full prompt template (not the short one)", async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];

    let capturedUserPrompt = null;
    const llmChat = async (msgs) => {
      capturedUserPrompt = msgs.find(m => m.role === "user").content;
      return "summary";
    };

    await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    // The full prompt should contain "In Progress" and "Blocked"
    expect(capturedUserPrompt).toContain("### In Progress");
    expect(capturedUserPrompt).toContain("### Blocked");
    // Should NOT contain "CONCISE" (which is the short prompt indicator)
    expect(capturedUserPrompt).not.toContain("CONCISE");
  });

  it("handles messages with reasoning_content", async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4", reasoning_content: "Let me think about this..." },
      { role: "user", content: "And 3+3?" },
      { role: "assistant", content: "6", reasoning_content: "Simple math..." },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "summary";
    };

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result).not.toBeNull();
    const userMsg = capturedMessages.find(m => m.role === "user");
    expect(userMsg.content).toContain("thinking");
  });

  it("handles messages with tool_calls", async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: "user", content: "List files" },
      { role: "assistant", content: "Running ls", tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "ls"}' } }] },
      { role: "tool", content: "file1.txt" },
      { role: "user", content: "And now read file1.txt" },
      { role: "assistant", content: "Reading file", tool_calls: [{ function: { name: "read", arguments: '{"path": "file1.txt"}' } }] },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "summary";
    };

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result).not.toBeNull();
    const userMsg = capturedMessages.find(m => m.role === "user");
    expect(userMsg.content).toContain("tool calls");
  });

  it("passes model to llmChat", async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "user", content: "How?" },
    ];

    let capturedModel = null;
    const llmChat = async (msgs, model) => {
      capturedModel = model;
      return "summary";
    };

    await strategy.execute(messages, { keepRecent: 1 }, llmChat, "my-model");
    expect(capturedModel).toBe("my-model");
  });

  it("skips system messages in the conversation sent to LLM", async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: "system", content: "You are helpful" },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi there" },
      { role: "user", content: "How are you?" },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs) => {
      capturedMessages = msgs;
      return "summary";
    };

    await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    // The conversation sent to LLM should not include the system message
    const userMsg = capturedMessages.find(m => m.role === "user");
    expect(userMsg.content).not.toContain("You are helpful");
  });

  it("includes correct token metadata", async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: "user", content: "x".repeat(200) },
      { role: "assistant", content: "y".repeat(200) },
      { role: "user", content: "z".repeat(200) },
      { role: "assistant", content: "w".repeat(200) },
    ];
    const llmChat = async () => "summary";

    const result = await strategy.execute(messages, { keepRecent: 1 }, llmChat, "model");

    expect(result.metadata.tokensBefore).toBeGreaterThan(0);
    expect(result.metadata.tokensAfter).toBeGreaterThan(0);
  });
});

// ── CompactionStrategyRegistry ───────────────────────────────────────────────

describe("CompactionStrategyRegistry", () => {
  it("creates empty registry", () => {
    const registry = new CompactionStrategyRegistry();
    expect(registry.getAll()).toEqual([]);
  });

  it("registers, retrieves, and checks strategy existence", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register(new DropStrategy());
    expect(registry.get("drop")).toBeDefined();
    expect(registry.getAll()).toHaveLength(1);
    expect(registry.get("nonexistent")).toBeUndefined();
    expect(registry.has("drop")).toBe(true);
    expect(registry.has("nonexistent")).toBe(false);
  });

  it("getDefault returns summarize when registered, undefined otherwise", () => {
    const empty = new CompactionStrategyRegistry();
    expect(empty.getDefault()).toBeUndefined();

    const withSummarize = new CompactionStrategyRegistry();
    withSummarize.register(new SummarizeStrategy());
    expect(withSummarize.getDefault()).toBeDefined();
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

  it("registers all built-in strategies", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register(new SummarizeStrategy());
    registry.register(new SummarizeShortStrategy());
    registry.register(new DropStrategy());
    registry.register(new TokenAwareStrategy());
    registry.register({ name: "trim", execute: async () => null });

    expect(registry.getAll()).toHaveLength(5);
    expect(registry.has("summarize")).toBe(true);
    expect(registry.has("summarize-short")).toBe(true);
    expect(registry.has("drop")).toBe(true);
    expect(registry.has("token-aware")).toBe(true);
    expect(registry.has("trim")).toBe(true);
  });

  it("getAll returns strategies in insertion order", () => {
    const registry = new CompactionStrategyRegistry();
    registry.register(new DropStrategy());
    registry.register(new SummarizeStrategy());
    registry.register(new SummarizeShortStrategy());

    const all = registry.getAll();
    expect(all[0].name).toBe("drop");
    expect(all[1].name).toBe("summarize");
    expect(all[2].name).toBe("summarize-short");
  });

  it("get returns the exact registered instance", () => {
    const registry = new CompactionStrategyRegistry();
    const strategy = new DropStrategy();
    registry.register(strategy);
    expect(registry.get("drop")).toBe(strategy);
  });
});
