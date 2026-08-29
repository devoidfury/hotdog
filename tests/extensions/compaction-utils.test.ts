// Tests for compaction/utils.ts — compaction decision and serialization helpers.
// Note: estimateMessageTokens/estimateContextTokens are re-exports of
// src/utils/token-estimate.ts; they are covered in tests/utils/token-estimate.test.ts.

import { describe, it, expect } from "bun:test";
import {
  findFirstKeptIndex,
  shouldCompact,
  serializeConversation,
} from "../../src/extensions/compaction/utils.ts";

// ── Compaction Decision ─────────────────────────────────────────────────────

describe("findFirstKeptIndex", () => {
  it("returns 0 when keepRecentMessages is 0", () => {
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

  it("finds correct index for keepRecentMessages=1", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
    ];
    // keepRecentMessages=1 means target=2, count from end: msg4(1), msg3(2>=2) -> return 3
    expect(findFirstKeptIndex(messages, 1)).toBe(3);
  });

  it("finds correct index for keepRecentMessages=2", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      { role: "assistant", content: "msg4" },
      { role: "user", content: "msg5" },
      { role: "assistant", content: "msg6" },
    ];
    // keepRecentMessages=2 means target=4, count from end: msg6(1), msg5(2), msg4(3), msg3(4>=4) -> return 3
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
    // keepRecentMessages=1 -> target=2, skip system, count from end: msg4(1), msg3(2>=2) -> return 4
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
    // keepRecentMessages=1 -> target=2, skip system, count from end: msg4(1), msg3(2>=2) -> return 5
    expect(findFirstKeptIndex(messages, 1)).toBe(5);
  });

  it("returns 0 for empty array", () => {
    expect(findFirstKeptIndex([], 5)).toBe(0);
  });

  it("backtracks the boundary when the first kept message is a tool result", () => {
    const messages = [
      { role: "user", content: "msg1" },
      { role: "assistant", content: "msg2" },
      { role: "user", content: "msg3" },
      {
        role: "assistant",
        content: "calling tools",
        toolCalls: [
          { function: { name: "bash", arguments: "{}" } },
          { function: { name: "read", arguments: "{}" } },
        ],
      },
      { role: "tool", content: "result-a" },
      { role: "tool", content: "result-b" },
    ];
    // target=2, count from end: result-b(1), result-a(2) -> naive boundary is 4.
    // messages[4] is a tool result whose parent (index 3) would be compacted
    // away, orphaning it; the boundary must back up so the parent is kept.
    expect(findFirstKeptIndex(messages, 1)).toBe(3);
  });

  it("returns 0 when backtracking past orphaned tool results consumes the context", () => {
    const messages = [
      { role: "tool", content: "orphan-1" },
      { role: "tool", content: "orphan-2" },
    ];
    expect(findFirstKeptIndex(messages, 1)).toBe(0);
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
