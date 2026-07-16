// Tests for compaction/utils.ts — token estimation, serialization, compaction helpers.

import { describe, it, expect } from "bun:test";
import {
  estimateMessageTokens,
  estimateContextTokens,
  findFirstKeptIndex,
  shouldCompact,
  serializeConversation,
  compactMessages,
} from "../../src/extensions/compaction/utils.ts";

// ── Token Estimation ────────────────────────────────────────────────────────

describe("estimateMessageTokens", () => {
  it("estimates user message tokens", () => {
    const msg = { role: "user", content: "Hello world" }; // 11 chars
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(3); // ceil(11/4)
  });

  it("estimates system message tokens", () => {
    const msg = { role: "system", content: "You are a helpful assistant." }; // 27 chars
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(7); // ceil(27/4)
  });

  it("estimates assistant message tokens", () => {
    const msg = { role: "assistant", content: "Here is the answer." }; // 19 chars
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(5); // ceil(19/4)
  });

  it("estimates tool result message tokens", () => {
    const msg = { role: "tool", content: "File contents here" }; // 18 chars
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(5); // ceil(18/4)
  });

  it("estimates assistant message with reasoning content", () => {
    const msg = {
      role: "assistant",
      content: "Answer",
      reasoningContent: "Let me think about this carefully.",
    };
    const tokens = estimateMessageTokens(msg);
    // "Answer" = 6 chars, "Let me think..." = 33 chars, total = 39
    expect(tokens).toBe(10); // ceil(39/4)
  });

  it("estimates assistant message with reasoning_content (snake_case)", () => {
    const msg = {
      role: "assistant",
      content: "Answer",
      reasoning_content: "Thinking here.",
    };
    const tokens = estimateMessageTokens(msg);
    // "Answer" = 6, "Thinking here." = 14, total = 20
    expect(tokens).toBe(5); // ceil(20/4)
  });

  it("estimates assistant message with tool calls", () => {
    const msg = {
      role: "assistant",
      content: "Running command",
      toolCalls: [
        { function: { name: "bash", arguments: '{"cmd": "ls"}' } },
        { function: { name: "read", arguments: '{"path": "file.txt"}' } },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // "Running command" = 15 + "bash" + '{"cmd": "ls"}' + "read" + '{"path": "file.txt"}'
    // 15 + 4 + 13 + 4 + 19 = 55 chars
    expect(tokens).toBe(14); // ceil(55/4)
  });

  it("estimates assistant message with tool_calls (snake_case)", () => {
    const msg = {
      role: "assistant",
      content: "Running",
      tool_calls: [
        { function: { name: "bash", arguments: '{"cmd": "ls"}' } },
      ],
    };
    const tokens = estimateMessageTokens(msg);
    // "Running" = 7 + "bash" + '{"cmd": "ls"}' = 7 + 4 + 13 = 24
    expect(tokens).toBe(6); // ceil(24/4)
  });

  it("estimates message with array content", () => {
    const msg = {
      role: "user",
      content: [{ type: "text", text: "Hello" }, { type: "image", url: "http://img.png" }],
    };
    const tokens = estimateMessageTokens(msg);
    // "[object Object]" + "[object Object]" = 15 + 15 = 30
    expect(tokens).toBeGreaterThan(0);
  });

  it("estimates message with empty content", () => {
    const msg = { role: "user", content: "" };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(0);
  });

  it("estimates message with undefined content", () => {
    const msg = { role: "user" };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(0);
  });

  it("estimates unknown role message", () => {
    const msg = { role: "unknown", content: "test" };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(1); // ceil(4/4)
  });

  it("handles null reasoningContent", () => {
    const msg = {
      role: "assistant",
      content: "Answer",
      reasoningContent: null,
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(2); // ceil(6/4)
  });

  it("handles empty tool calls array", () => {
    const msg = {
      role: "assistant",
      content: "Answer",
      toolCalls: [],
    };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(2); // ceil(6/4)
  });

  it("handles tool call without function property", () => {
    const msg = {
      role: "assistant",
      content: "Answer",
      toolCalls: [{}],
    };
    const tokens = estimateMessageTokens(msg);
    // "Answer" = 6 + "" + "" = 6
    expect(tokens).toBe(2); // ceil(6/4)
  });
});

describe("estimateContextTokens", () => {
  it("estimates total tokens for multiple messages", () => {
    const messages = [
      { role: "user", content: "Hello" }, // 5 chars -> 2 tokens
      { role: "assistant", content: "Hi there" }, // 8 chars -> 2 tokens
      { role: "user", content: "How are you?" }, // 12 chars -> 3 tokens
    ];
    const total = estimateContextTokens(messages);
    expect(total).toBe(7);
  });

  it("returns 0 for empty array", () => {
    expect(estimateContextTokens([])).toBe(0);
  });

  it("handles mixed message types", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "User message" },
      { role: "assistant", content: "Assistant reply", reasoningContent: "Thinking..." },
      { role: "tool", content: "Tool output" },
    ];
    const total = estimateContextTokens(messages);
    expect(total).toBeGreaterThan(0);
  });
});

// ── Compaction Decision ─────────────────────────────────────────────────────

describe("findFirstKeptIndex", () => {
  it("returns 0 when keepRecent is 0", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
    ];
    expect(findFirstKeptIndex(messages, 0)).toBe(0);
  });

  it("returns 0 when not enough messages", () => {
    const messages = [
      { role: "user", content: "msg1" },
    ];
    expect(findFirstKeptIndex(messages, 2)).toBe(0);
  });

  it("finds correct index for keepRecent=1", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
    ];
    // keepRecent=1 means target=2, count from end: msg4(1), msg3(2>=2) -> return 3
    expect(findFirstKeptIndex(messages, 1)).toBe(3);
  });

  it("finds correct index for keepRecent=2", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
      { role: "user", content: "msg5" },
      { role: "assistant", content: "msg6" },
    ];
    // keepRecent=2 means target=4, count from end: msg6(1), msg5(2), msg4(3), msg3(4>=4) -> return 3
    expect(findFirstKeptIndex(messages, 2)).toBe(3);
  });

  it("skips system messages when counting", () => {
    const messages = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
    ];
    // keepRecent=1 -> target=2, skip system, count from end: msg4(1), msg3(2>=2) -> return 4
    expect(findFirstKeptIndex(messages, 1)).toBe(4);
  });

  it("handles all system messages", () => {
    const messages = [
      { role: "system", content: "prompt1" },
      { role: "system", content: "prompt2" },
    ];
    expect(findFirstKeptIndex(messages, 2)).toBe(0);
  });

  it("handles mixed system and non-system messages", () => {
    const messages = [
      { role: "system", content: "prompt" },
      { role: "user", content: "msg1" },
      { role: "system", content: "another prompt" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
    ];
    // keepRecent=1 -> target=2, skip system, count from end: msg4(1), msg3(2>=2) -> return 5
    expect(findFirstKeptIndex(messages, 1)).toBe(5);
  });

  it("returns 0 for empty array", () => {
    expect(findFirstKeptIndex([], 5)).toBe(0);
  });
});

describe("shouldCompact", () => {
  it("returns true when tokens exceed budget", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(1000),
    }));
    // 100 * 250 tokens = 25000 tokens, budget = 10000 - 16384 = -6384
    // 25000 > -6384 => true
    expect(shouldCompact(messages, 10000)).toBe(true);
  });

  it("returns false when tokens are under budget", () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    // 2 tokens, budget = 128000 - 16384 = 111616
    expect(shouldCompact(messages, 128000)).toBe(false);
  });

  it("uses default reserveTokens", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(1000),
    }));
    // 25000 tokens, default reserve = 16384, budget = 40000 - 16384 = 23616
    // 25000 > 23616 => true
    expect(shouldCompact(messages, 40000)).toBe(true);
  });

  it("respects custom reserveTokens", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: "x".repeat(1000),
    }));
    // 25000 tokens, reserve = 0, budget = 30000
    // 25000 < 30000 => false
    expect(shouldCompact(messages, 30000, 0)).toBe(false);
  });

  it("handles zero context limit", () => {
    const messages = [{ role: "user", content: "Hello" }];
    // 2 tokens, budget = 0 - 16384 = -16384
    // 2 > -16384 => true
    expect(shouldCompact(messages, 0)).toBe(true);
  });
});

// ── Serialization ───────────────────────────────────────────────────────────

describe("serializeConversation", () => {
  it("serializes user message", () => {
    const messages = [{ role: "user", content: "Hello" }];
    const result = serializeConversation(messages);
    expect(result).toBe("[User]: Hello");
  });

  it("serializes assistant message", () => {
    const messages = [{ role: "assistant", content: "Hi there" }];
    const result = serializeConversation(messages);
    expect(result).toBe("[Assistant]: Hi there");
  });

  it("serializes assistant message with reasoning", () => {
    const messages = [{
      role: "assistant",
      content: "The answer is 42",
      reasoningContent: "Let me think...",
    }];
    const result = serializeConversation(messages);
    expect(result).toContain("[Assistant thinking]: Let me think...");
    expect(result).toContain("[Assistant]: The answer is 42");
  });

  it("serializes assistant message with reasoning_content (snake_case)", () => {
    const messages = [{
      role: "assistant",
      content: "The answer is 42",
      reasoning_content: "Thinking...",
    }];
    const result = serializeConversation(messages);
    expect(result).toContain("[Assistant thinking]: Thinking...");
  });

  it("serializes tool result", () => {
    const messages = [{ role: "tool", content: "File contents" }];
    const result = serializeConversation(messages);
    expect(result).toBe("[Tool result]: File contents");
  });

  it("truncates long tool results", () => {
    const longContent = "x".repeat(3000);
    const messages = [{ role: "tool", content: longContent }];
    const result = serializeConversation(messages);
    expect(result).toContain("[Tool result]:");
    expect(result).toContain("[... 1000 more characters truncated]");
  });

  it("skips system messages", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hello" },
    ];
    const result = serializeConversation(messages);
    expect(result).not.toContain("You are helpful");
    expect(result).toContain("[User]: Hello");
  });

  it("serializes assistant message with tool calls", () => {
    const messages = [{
      role: "assistant",
      content: "Running command",
      toolCalls: [
        { function: { name: "bash", arguments: '{"cmd": "ls"}' } },
        { function: { name: "read", arguments: '{"path": "file.txt"}' } },
      ],
    }];
    const result = serializeConversation(messages);
    expect(result).toContain("[Assistant]: Running command");
    expect(result).toContain("[Assistant tool calls]: bash({\"cmd\": \"ls\"}); read({\"path\": \"file.txt\"})");
  });

  it("serializes assistant message with tool_calls (snake_case)", () => {
    const messages = [{
      role: "assistant",
      content: "Running",
      tool_calls: [
        { function: { name: "bash", arguments: '{"cmd": "ls"}' } },
      ],
    }];
    const result = serializeConversation(messages);
    expect(result).toContain("[Assistant tool calls]: bash({\"cmd\": \"ls\"})");
  });

  it("serializes assistant message with only reasoning (no content)", () => {
    const messages = [{
      role: "assistant",
      reasoningContent: "Let me think about this.",
    }];
    const result = serializeConversation(messages);
    expect(result).toBe("[Assistant thinking]: Let me think about this.");
  });

  it("serializes assistant message with only tool calls (no content)", () => {
    const messages = [{
      role: "assistant",
      toolCalls: [
        { function: { name: "bash", arguments: '{}' } },
      ],
    }];
    const result = serializeConversation(messages);
    expect(result).toBe("[Assistant tool calls]: bash({})");
  });

  it("serializes mixed conversation", () => {
    const messages = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "What is 2+2?" },
      { role: "assistant", content: "4", reasoningContent: "Simple math" },
      { role: "user", content: "Thanks" },
    ];
    const result = serializeConversation(messages);
    expect(result).toContain("[User]: What is 2+2?");
    expect(result).toContain("[Assistant thinking]: Simple math");
    expect(result).toContain("[Assistant]: 4");
    expect(result).toContain("[User]: Thanks");
    expect(result).not.toContain("You are helpful");
  });

  it("handles unknown role", () => {
    const messages = [{ role: "custom", content: "custom content" }];
    const result = serializeConversation(messages);
    expect(result).toBe("[custom]: custom content");
  });

  it("handles null role", () => {
    const messages = [{ role: undefined, content: "null role content" }];
    const result = serializeConversation(messages);
    expect(result).toBe("[unknown]: null role content");
  });

  it("handles array content for user message", () => {
    const messages = [{
      role: "user",
      content: [{ type: "text", text: "Hello" }, { type: "image", url: "http://img.png" }],
    }];
    const result = serializeConversation(messages);
    expect(result).toContain("[User]:");
  });

  it("handles empty messages array", () => {
    const result = serializeConversation([]);
    expect(result).toBe("");
  });

  it("joins parts with double newline", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
    ];
    const result = serializeConversation(messages);
    expect(result).toBe("[User]: msg1\n\n[Assistant]: msg2");
  });
});

// ── compactMessages ─────────────────────────────────────────────────────────

describe("compactMessages", () => {
  const mockLlmChat = async (messages: Array<{ role: string; content: string }>, _model: string): Promise<string> => {
    return "Summary of the conversation";
  };

  it("returns null when compaction is disabled", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const result = await compactMessages(messages, mockLlmChat, "test-model", { enabled: false });
    expect(result).toBeNull();
  });

  it("returns null when not enough messages to compact", async () => {
    const messages = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
    ];
    const result = await compactMessages(
      messages,
      mockLlmChat,
      "test-model",
      { enabled: true, keepRecent: 8 },
    );
    expect(result).toBeNull();
  });

  it("compacts messages when there are enough", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    }));

    const result = await compactMessages(
      messages,
      mockLlmChat,
      "test-model",
      { enabled: true, keepRecent: 2 },
    );

    expect(result).not.toBeNull();
    expect(result!.summary).toBe("Summary of the conversation");
    expect(result!.messagesCompacted).toBeGreaterThan(0);
  });

  it("throws AgentError when LLM call fails", async () => {
    const failingLlmChat = async () => {
      throw new Error("LLM error");
    };

    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    }));

    await expect(
      compactMessages(messages, failingLlmChat, "test-model", { enabled: true, keepRecent: 2 }),
    ).rejects.toThrow();
  });

  it("uses keepRecent to determine messages to compact", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    }));

    const result = await compactMessages(
      messages,
      mockLlmChat,
      "test-model",
      { enabled: true, keepRecent: 1 },
    );

    expect(result).not.toBeNull();
    // keepRecent=1 means target=2, findFirstKeptIndex returns 19, so 19 messages compacted
    expect(result!.messagesCompacted).toBe(19);
  });

  it("uses default keepRecent when not specified", async () => {
    const messages = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i}`,
    }));

    const result = await compactMessages(
      messages,
      mockLlmChat,
      "test-model",
      { enabled: true },
    );

    expect(result).not.toBeNull();
    // Default keepRecent=8, target=16, findFirstKeptIndex returns 5, so 5 messages compacted
    expect(result!.messagesCompacted).toBe(5);
  });
});
