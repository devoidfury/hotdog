// Tests for src/utils/token-estimate.ts — shared token estimation heuristic.
// The compaction extension re-exports these from
// src/extensions/compaction/utils.ts; this file is the single source of
// truth for the heuristic, including compatibility with core Message
// instances and snake_case persistence JSON.

import { describe, it, expect } from "bun:test";
import {
  estimateMessageTokens,
  estimateContextTokens,
  type MessageLike,
} from "@utils/token-estimate.ts";
import { Message } from "@core/context/message.ts";
import type { ToolResultPart } from "@core/context/wrappers.ts";

describe("estimateMessageTokens", () => {
  it("estimates plain string content (chars/4, rounded up)", () => {
    expect(estimateMessageTokens({ role: "user", content: "Hello world" })).toBe(3); // ceil(11/4)
    expect(estimateMessageTokens({ role: "system", content: "You are a helpful assistant." })).toBe(7); // ceil(27/4)
    expect(estimateMessageTokens({ role: "tool", content: "File contents here" })).toBe(5); // ceil(18/4)
  });

  it("estimates empty and missing content as zero", () => {
    expect(estimateMessageTokens({ role: "user" })).toBe(0);
    expect(estimateMessageTokens({ role: "user", content: "" })).toBe(0);
  });

  it("estimates unknown role by content only", () => {
    expect(estimateMessageTokens({ role: "unknown", content: "test" })).toBe(1); // ceil(4/4)
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
    // "12345\n678" = 9 chars (parts join with a newline) -- images are
    // dropped, not stringified
    expect(estimateMessageTokens(msg)).toBe(3);
  });

  it("counts wrapper parts by their at-rest JSON, not the part object", () => {
    // String()ing the part object would count "[object Object]" (15 chars),
    // not the data form the flattener produces (see wrappers.ts).
    const part = { type: "file-include", path: "note.md", content: "some file payload here" };
    const msg: MessageLike = { role: "user", content: [part] };
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(JSON.stringify(part).length / 4));
  });

  it("counts assistant reasoning and tool calls", () => {
    const msg: MessageLike = {
      role: "assistant",
      content: "Answer", // 6
      reasoningContent: "Let me think about this carefully.", // 33
    };
    // 6 + 33 = 39
    expect(estimateMessageTokens(msg)).toBe(10); // ceil(39/4)
  });

  it("counts reasoning_content (snake_case)", () => {
    const msg: MessageLike = {
      role: "assistant",
      content: "Answer", // 6
      reasoning_content: "Thinking here.", // 14
    };
    expect(estimateMessageTokens(msg)).toBe(5); // ceil(20/4)
  });

  it("counts tool calls", () => {
    const msg: MessageLike = {
      role: "assistant",
      content: "Running command", // 15
      toolCalls: [
        { function: { name: "bash", arguments: '{"cmd": "ls"}' } }, // 4 + 13
        { function: { name: "read", arguments: '{"path": "file.txt"}' } }, // 4 + 19
      ],
    };
    // 15 + 4 + 13 + 4 + 19 = 55
    expect(estimateMessageTokens(msg)).toBe(14); // ceil(55/4)
  });

  it("counts tool_calls (snake_case)", () => {
    const msg: MessageLike = {
      role: "assistant",
      content: "Running", // 7
      tool_calls: [{ function: { name: "bash", arguments: '{"cmd": "ls"}' } }], // 4 + 13
    };
    expect(estimateMessageTokens(msg)).toBe(6); // ceil(24/4)
  });

  it("ignores null reasoningContent and empty/invalid tool calls", () => {
    expect(
      estimateMessageTokens({ role: "assistant", content: "Answer", reasoningContent: null }),
    ).toBe(2); // ceil(6/4)
    expect(
      estimateMessageTokens({ role: "assistant", content: "Answer", toolCalls: [] }),
    ).toBe(2);
    expect(
      estimateMessageTokens({ role: "assistant", content: "Answer", toolCalls: [{}] }),
    ).toBe(2); // missing function property contributes nothing
  });
});

describe("estimateContextTokens", () => {
  it("sums per-message estimates", () => {
    const messages: MessageLike[] = [
      { role: "user", content: "Hello" }, // ceil(5/4) = 2
      { role: "assistant", content: "Hi there" }, // 2
      { role: "user", content: "How are you?" }, // 3
    ];
    expect(estimateContextTokens(messages)).toBe(7);
  });

  it("handles mixed message types", () => {
    const messages: MessageLike[] = [
      { role: "system", content: "System prompt" },
      { role: "user", content: "User message" },
      { role: "assistant", content: "Assistant reply", reasoningContent: "Thinking..." },
      { role: "tool", content: "Tool output" },
    ];
    expect(estimateContextTokens(messages)).toBeGreaterThan(0);
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

// ── session-format estimator ────────────────────────────────────────────────

const toolPart: ToolResultPart = {
  type: "tool-result",
  tool: "read",
  status: "success",
  meta: [],
  error: null,
  hint: null,
  output: "payload",
};

describe("estimator override (wire-size measurement)", () => {
  it("without an estimator a tool-result part counts as its at-rest JSON", () => {
    expect(estimateMessageTokens({ role: "tool", content: [toolPart] })).toBe(
      Math.ceil(JSON.stringify(toolPart).length / 4),
    );
  });

  it("with an estimator the part counts as the rendered shape", () => {
    // Toy "wire": a wrapper is ~40 chars around the payload.
    const wire = (p: typeof toolPart) => `t ${p.tool} ${p.status}\n${p.output}\n/t`;
    expect(estimateMessageTokens({ role: "tool", content: [toolPart] }, wire)).toBe(
      Math.ceil(wire(toolPart).length / 4),
    );
    // Strictly cheaper than the JSON here -- the point of measuring at wire size.
    expect(wire(toolPart).length).toBeLessThan(JSON.stringify(toolPart).length);
  });

  it("the estimator applies only to tool-result parts", () => {
    const msgs = [
      { role: "user" as const, content: "plain" },
      { role: "user" as const, content: [{ type: "text", text: "plain" }] },
    ];
    const bogus = () => "x".repeat(4000);
    for (const msg of msgs) {
      expect(estimateContextTokens([msg], bogus)).toBe(estimateContextTokens([msg]));
    }
  });

  it("core Message instances work with the estimator too", () => {
    const msg = new Message({ role: "tool", content: [toolPart], toolCallId: "tc", source: "tool" });
    const wire = () => "0123456789"; // 10 chars
    expect(estimateMessageTokens(msg, wire)).toBe(3); // ceil(10/4)
  });
});
