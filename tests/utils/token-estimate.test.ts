// Tests for src/utils/token-estimate.ts — shared token estimation heuristic.
// The compaction extension re-exports these (covered by
// tests/extensions/compaction-utils.test.ts); this file pins the utility
// module itself, including compatibility with core Message instances.

import { describe, it, expect } from "bun:test";
import {
  estimateMessageTokens,
  estimateContextTokens,
  type MessageLike,
} from "../../src/utils/token-estimate.ts";
import { Message } from "../../src/core/context/message.ts";
describe("estimateMessageTokens", () => {
  it("estimates plain string content (chars/4, rounded up)", () => {
    expect(estimateMessageTokens({ role: "user", content: "Hello world" })).toBe(3); // ceil(11/4)
    expect(estimateMessageTokens({ role: "system", content: "abcd" })).toBe(1);
  });

  it("estimates empty and missing content as zero", () => {
    expect(estimateMessageTokens({ role: "user" })).toBe(0);
    expect(estimateMessageTokens({ role: "user", content: "" })).toBe(0);
  });

  it("flattens content part arrays", () => {
    const msg: MessageLike = {
      role: "user",
      content: [
        { type: "text", text: "12345" },
        { type: "untrusted", text: "678" },
        { type: "image_url", image_url: { url: "x" } },
      ],
    };
    // 5 + 3 + String(image part) — images are counted as their stringified form
    expect(estimateMessageTokens(msg)).toBeGreaterThan(1);
  });

  it("counts assistant reasoning and tool calls", () => {
    const msg: MessageLike = {
      role: "assistant",
      content: "Answer", // 6
      reasoningContent: "Let me think.", // 13
      toolCalls: [{ function: { name: "read", arguments: '{"path":"a"}' } }],
    };
    // 6 + 13 + (4 + 13) = 36 chars
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(36 / 4));
  });
});

describe("estimateContextTokens", () => {
  it("sums per-message estimates", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "12345" }, // ceil(5/4) = 2
      { role: "assistant", content: "12345678" }, // 2
    ];
    expect(estimateContextTokens(messages)).toBe(4);
  });

  it("returns 0 for an empty context", () => {
    expect(estimateContextTokens([])).toBe(0);
  });

  it("works with core Message instances (ContextManager integration)", () => {
    const messages = [
      new Message({ role: "user", content: "12345678", source: "user" }),
      new Message({ role: "assistant", content: "12345678", source: "model" }),
    ];
    expect(estimateContextTokens(messages)).toBe(4);
  });
});
