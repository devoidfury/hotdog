// Extended tests for LlmClient — _parseStreamData, _escapeMessages, cancel tokens.
import { describe, it, expect } from "bun:test";
import { LlmClient } from "../../src/core/llm-client/client.js";
import { Message } from "../../src/core/context/message.js";

describe("LlmClient._parseStreamData", () => {
  it("parses content delta", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const data = {
      choices: [{ delta: { content: "Hello" } }],
    };
    const events = client._parseStreamData(data);
    expect(events).toEqual([{ type: "content", content: "Hello" }]);
  });

  it("parses reasoning_content delta", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const data = {
      choices: [{ delta: { reasoning_content: "Let me think..." } }],
    };
    const events = client._parseStreamData(data);
    expect(events).toEqual([{ type: "reasoning", content: "Let me think..." }]);
  });

  it("parses both content and reasoning in same chunk", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const data = {
      choices: [
        {
          delta: {
            reasoning_content: "Thinking...",
            content: "Answer",
          },
        },
      ],
    };
    const events = client._parseStreamData(data);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("reasoning");
    expect(events[1].type).toBe("content");
  });

  it("parses tool call name", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const data = {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "call_abc", function: { name: "bash" } },
            ],
          },
        },
      ],
    };
    const events = client._parseStreamData(data);
    expect(events).toEqual([
      { type: "toolName", index: 0, name: "bash", toolCallId: "call_abc" },
    ]);
  });

  it("parses tool call arguments", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const data = {
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"cmd":"ls"}' } }],
          },
        },
      ],
    };
    const events = client._parseStreamData(data);
    expect(events).toEqual([
      {
        type: "toolArgument",
        index: 0,
        arguments: '{"cmd":"ls"}',
      },
    ]);
  });

  it("parses tool name and arguments together", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const data = {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                function: { name: "read", arguments: '{"path":"file"}' },
              },
            ],
          },
        },
      ],
    };
    const events = client._parseStreamData(data);
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe("toolName");
    expect(events[1].type).toBe("toolArgument");
  });

  it("parses usage data", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const data = {
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    };
    const events = client._parseStreamData(data);
    expect(events).toEqual([
      {
        type: "usage",
        data: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      },
    ]);
  });

  it("returns empty array for empty choices", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({ choices: [] });
    expect(events).toEqual([]);
  });

  it("returns empty array for null/undefined input", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    expect(client._parseStreamData({})).toEqual([]);
    expect(client._parseStreamData({ choices: null })).toEqual([]);
  });

  it("parses multiple tool calls", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const data = {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: "tc1", function: { name: "read" } },
              { index: 1, id: "tc2", function: { name: "write" } },
            ],
          },
        },
      ],
    };
    const events = client._parseStreamData(data);
    expect(events).toHaveLength(2);
    expect(events[0].name).toBe("read");
    expect(events[1].name).toBe("write");
  });

  it("uses default index 0 when not provided", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const data = {
      choices: [
        {
          delta: {
            tool_calls: [{ function: { name: "bash" } }],
          },
        },
      ],
    };
    const events = client._parseStreamData(data);
    expect(events[0].index).toBe(0);
    expect(events[0].toolCallId).toBe("");
  });
});

describe("LlmClient._escapeMessages — array content", () => {
  it("escapes text parts in array content", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const msg = new Message({
      role: "user",
      content: [
        { type: "text", text: "Hello\n<ctrl>marker</ctrl>" },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });
    const result = client._escapeMessages([msg]);
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0].type).toBe("text");
    // Text part should be escaped
    expect(typeof result[0].content[0].text).toBe("string");
    // Image part should pass through unchanged
    expect(result[0].content[1].type).toBe("image_url");
  });

  it("escapes tool_calls in assistant messages", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const msg = new Message({
      role: "assistant",
      content: null,
      toolCalls: [
        {
          id: "call_1",
          function: { name: "bash", arguments: '{"cmd":"ls"}' },
        },
      ],
    });
    const result = client._escapeMessages([msg]);
    expect(result[0].tool_calls).toHaveLength(1);
    expect(typeof result[0].tool_calls[0].function.name).toBe("string");
  });

  it("handles empty messages array", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const result = client._escapeMessages([]);
    expect(result).toEqual([]);
  });

  it("handles message with no content", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const msg = new Message({ role: "system", content: "" });
    const result = client._escapeMessages([msg]);
    expect(result).toHaveLength(1);
  });

  it("handles message with null content", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const msg = new Message({ role: "assistant", content: null });
    const result = client._escapeMessages([msg]);
    expect(result).toHaveLength(1);
  });
});

describe("LlmClient — sessionId header", () => {
  it("sets sessionId on client", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, sessionId: "session-123" });
    expect(client.sessionId).toBe("session-123");
  });

  it("sessionId defaults to empty string", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    expect(client.sessionId).toBe("");
  });
});

describe("LlmClient — loud flag", () => {
  it("accepts loud option", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, loud: true });
    expect(client.loud).toBe(true);
  });

  it("loud defaults to false", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    expect(client.loud).toBe(false);
  });
});

describe("LlmClient — cancelled flag", () => {
  it("cancelled defaults to false", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    expect(client.cancelled).toBe(false);
  });
});

describe("LlmClient.buildChatRequest — no tools", () => {
  it("does not include tools fields when no tools provided", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const request = client.buildChatRequest([], { name: "gpt-4" }, []);
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.parallel_tool_calls).toBeUndefined();
  });

  it("does not include tools fields when tools is null", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const request = client.buildChatRequest([], { name: "gpt-4" }, null);
    expect(request.tools).toBeUndefined();
  });

  it("does not include temperature when null", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const request = client.buildChatRequest(
      [],
      { name: "gpt-4", temperature: null },
      null,
    );
    expect(request.temperature).toBeUndefined();
  });

  it("does not include temperature when undefined", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const request = client.buildChatRequest(
      [],
      { name: "gpt-4", temperature: undefined },
      null,
    );
    expect(request.temperature).toBeUndefined();
  });

  it("includes temperature 0", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const request = client.buildChatRequest(
      [],
      { name: "gpt-4", temperature: 0 },
      null,
    );
    expect(request.temperature).toBe(0);
  });
});
