// Golden-request test (phase 1): pins the exact wire bytes for the OpenAI
// protocol so the extraction from LlmClient is provably behavior-preserving.

import { describe, it, expect } from "bun:test";
import { LlmClient } from "../../../src/core/llm-client/client.ts";
import { Message } from "../../../src/core/context/message.ts";
import type { ModelConfig } from "../../../src/core/config/providers.ts";

function mc(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { name: "prov/gpt-4", temperature: null, contextLimit: 128000, tags: [], ...overrides };
}

describe("golden request: OpenAI protocol wire bytes", () => {
  it("pins the exact JSON body for a representative request", () => {
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null });
    const messages = [
      new Message({ role: "system", source: "system", content: "You are helpful." }),
      new Message({ role: "user", source: "user", content: "Hello" }),
      new Message({
        role: "assistant",
        source: "model",
        content: "Let me check",
        toolCalls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } }],
      }),
      new Message({ role: "tool", source: "tool", content: "file.txt", toolCallId: "tc1" }),
    ];

    const tools = [
      {
        type: "function",
        function: {
          name: "bash",
          description: "Run bash",
          parameters: { type: "object", properties: { cmd: { type: "string" } }, required: ["cmd"] },
        },
      },
    ];

    const request = client.buildChatRequest(messages, mc({ temperature: 0.7, reasoningEffort: "high" }), tools, true);

    // Pin the exact shape and field order (JSON.stringify preserves insertion order).
    const json = JSON.stringify(request, null, 2);
    expect(json).toBe(
      JSON.stringify(
        {
          model: "gpt-4",
          messages: [
            { role: "system", content: "You are helpful." },
            { role: "user", content: "Hello" },
            {
              role: "assistant",
              content: "Let me check",
              tool_calls: [
                { id: "tc1", type: "function", function: { name: "bash", arguments: '{"cmd":"ls"}' } },
              ],
            },
            { role: "tool", content: "file.txt", tool_call_id: "tc1" },
          ],
          stream: true,
          temperature: 0.7,
          tools,
          tool_choice: "auto",
          parallel_tool_calls: true,
          reasoning_effort: "high",
          stream_options: { include_usage: true },
        },
        null,
        2,
      ),
    );
  });

  it("omits optional fields when not set", () => {
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null });
    const request = client.buildChatRequest(
      [new Message({ role: "user", content: "Hi" })],
      mc(),
      null,
      false,
    );

    expect(request.model).toBe("gpt-4");
    expect(request.stream).toBe(false);
    expect(request.temperature).toBeUndefined();
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.parallel_tool_calls).toBeUndefined();
    expect(request.reasoning_effort).toBeUndefined();
    expect(request.stream_options).toBeUndefined();
  });

  it("strips provider prefix from model name", () => {
    const client = new LlmClient({ chatTimeoutSecs: 60, maxRetries: 3, markerMangler: null });
    const request = client.buildChatRequest([], mc({ name: "anthropic/claude-sonnet-4" }), null, false);
    expect(request.model).toBe("claude-sonnet-4");
  });
});
