// Extended tests for LlmClient streaming, SSE parsing, cancellation, and escape methods.

import { describe, it, expect } from "bun:test";
import { LlmClient } from "../../src/core/llm-client/client.js";
import { LlmError } from "../../src/core/error.js";
import { Message } from "../../src/core/context/message.js";
import {
  MarkerMangler,
  createMarkerMangler,
} from "../../src/core/marker-mangler.js";

describe("LlmClient._escapeMessages", () => {
  it("escapes string content with mangler", () => {
    const mangler = new MarkerMangler();
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: mangler });
    const messages = [new Message({ role: "user", content: "Hello" })];
    const escaped = client._escapeMessages(messages);
    expect(escaped).toHaveLength(1);
    expect(typeof escaped[0].content).toBe("string");
  });

  it("escapes array content with text parts", () => {
    const mangler = new MarkerMangler();
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: mangler });
    const messages = [
      new Message({
        role: "user",
        content: [
          { type: "text", text: "Hello" },
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc" },
          },
        ],
      }),
    ];
    const escaped = client._escapeMessages(messages);
    expect(escaped).toHaveLength(1);
    expect(Array.isArray(escaped[0].content)).toBe(true);
    expect(escaped[0].content[0].type).toBe("text");
    expect(escaped[0].content[1].type).toBe("image_url");
  });

  it("passes through image_url parts unchanged", () => {
    const mangler = new MarkerMangler();
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: mangler });
    const messages = [
      new Message({
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: { url: "data:image/png;base64,abc" },
          },
        ],
      }),
    ];
    const escaped = client._escapeMessages(messages);
    expect(escaped[0].content[0].type).toBe("image_url");
  });

  it("escapes tool_calls in messages", () => {
    const mangler = new MarkerMangler();
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: mangler });
    const messages = [
      new Message({
        role: "assistant",
        content: "I will run a command",
        toolCalls: [{ id: "tc1", function: { name: "bash", arguments: "{}" } }],
      }),
    ];
    const escaped = client._escapeMessages(messages);
    expect(escaped[0].tool_calls).toHaveLength(1);
  });

  it("returns messages unchanged when mangler is null", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: null });
    const messages = [new Message({ role: "user", content: "Hello" })];
    const escaped = client._escapeMessages(messages);
    expect(escaped).toHaveLength(1);
  });

  it("escapes tool_calls with function name and arguments", () => {
    const mangler = new MarkerMangler();
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: mangler });
    const messages = [
      new Message({
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "tc1",
            function: { name: "read_file", arguments: '{"path":"test.txt"}' },
          },
        ],
      }),
    ];
    const escaped = client._escapeMessages(messages);
    expect(escaped[0].tool_calls).toHaveLength(1);
    expect(escaped[0].tool_calls[0].function.name).toBeDefined();
  });

  it("handles messages with null content", () => {
    const mangler = new MarkerMangler();
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: mangler });
    const messages = [new Message({ role: "assistant", content: null })];
    const escaped = client._escapeMessages(messages);
    expect(escaped).toHaveLength(1);
  });
});

describe("LlmClient._parseStreamData", () => {
  it("parses content delta", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [{ delta: { content: "Hello" } }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("content");
    expect(events[0].content).toBe("Hello");
  });

  it("parses reasoning_content delta", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [{ delta: { reasoning_content: "Thinking..." } }],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("reasoning");
    expect(events[0].content).toBe("Thinking...");
  });

  it("parses tool call name", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: "tc1", function: { name: "bash" } }],
          },
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("toolName");
    expect(events[0].name).toBe("bash");
    expect(events[0].index).toBe(0);
    expect(events[0].toolCallId).toBe("tc1");
  });

  it("parses tool call arguments", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { arguments: '{"path":"test"}' } },
            ],
          },
        },
      ],
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("toolArgument");
    expect(events[0].arguments).toBe('{"path":"test"}');
  });

  it("parses usage data", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("usage");
    expect(events[0].data.prompt_tokens).toBe(10);
  });

  it("returns empty array for data with no choices", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({});
    expect(events).toEqual([]);
  });

  it("parses multiple events from single data block", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [
        {
          delta: {
            content: "Hello",
            tool_calls: [{ index: 0, id: "tc1", function: { name: "bash" } }],
          },
        },
      ],
    });
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it("handles empty content delta", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [{ delta: {} }],
    });
    expect(events).toEqual([]);
  });

  it("handles null content in delta", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [{ delta: { content: null } }],
    });
    expect(events).toEqual([]);
  });

  it("handles undefined choices", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({ choices: undefined });
    expect(events).toEqual([]);
  });

  it("unescape content with mangler", () => {
    const mangler = new MarkerMangler();
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: mangler });
    const rawContent = mangler.escape("Hello World");
    const events = client._parseStreamData({
      choices: [{ delta: { content: rawContent } }],
    });
    expect(events[0].type).toBe("content");
    expect(events[0].content).toBe("Hello World");
  });

  it("unescape reasoning content with mangler", () => {
    const mangler = new MarkerMangler();
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: mangler });
    const rawContent = mangler.escape("Thinking process");
    const events = client._parseStreamData({
      choices: [{ delta: { reasoning_content: rawContent } }],
    });
    expect(events[0].type).toBe("reasoning");
    expect(events[0].content).toBe("Thinking process");
  });

  it("handles tool call without id", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, function: { name: "bash" } }],
          },
        },
      ],
    });
    expect(events[0].type).toBe("toolName");
    expect(events[0].toolCallId).toBe("");
  });

  it("handles tool call without index", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [
        {
          delta: {
            tool_calls: [{ function: { name: "bash" } }],
          },
        },
      ],
    });
    expect(events[0].index).toBe(0);
  });

  it("handles tool call with only arguments (no name)", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [
        {
          delta: {
            tool_calls: [{ function: { arguments: "arg" } }],
          },
        },
      ],
    });
    // Should only have toolArgument event, not toolName
    const types = events.map((e) => e.type);
    expect(types).toContain("toolArgument");
    expect(types).not.toContain("toolName");
  });

  it("handles tool call with only name (no arguments)", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [
        {
          delta: {
            tool_calls: [{ function: { name: "bash" } }],
          },
        },
      ],
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("toolName");
    expect(types).not.toContain("toolArgument");
  });

  it("handles empty string content", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    const events = client._parseStreamData({
      choices: [{ delta: { content: "" } }],
    });
    // Empty string is falsy, so _parseStreamData skips it (source checks `if (delta.content)`)
    expect(events).toHaveLength(0);
  });
});

describe("LlmClient.chatStreamCancellable", () => {
  it("returns an async generator", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const gen = client.chatStreamCancellable(
      [{ role: "user", content: "Hi" }],
      { name: "test-model", temperature: null, maxTokens: 100 },
    );
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });

  it("accepts a cancelToken parameter", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const abortController = new AbortController();
    const gen = client.chatStreamCancellable(
      [{ role: "user", content: "Hi" }],
      { name: "test-model", temperature: null, maxTokens: 100 },
      [],
      abortController,
    );
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });

  it("accepts custom cancel token with .aborted property", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const customCancel = { aborted: false };
    const gen = client.chatStreamCancellable(
      [{ role: "user", content: "Hi" }],
      { name: "test-model", temperature: null, maxTokens: 100 },
      [],
      customCancel,
    );
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });

  it("accepts already-aborted cancel token", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const abortController = new AbortController();
    abortController.abort();
    const gen = client.chatStreamCancellable(
      [{ role: "user", content: "Hi" }],
      { name: "test-model", temperature: null, maxTokens: 100 },
      [],
      abortController,
    );
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });

  it("accepts cancel token with signal property", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const customCancel = {
      signal: new AbortController().signal,
    };
    const gen = client.chatStreamCancellable(
      [{ role: "user", content: "Hi" }],
      { name: "test-model", temperature: null, maxTokens: 100 },
      [],
      customCancel,
    );
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });
});

describe("LlmClient._processSSE", () => {
  it("handles empty stream", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const mockResponse = {
      body: {
        getReader: () => ({
          read: async () => ({ done: true, value: undefined }),
          releaseLock: () => {},
        }),
      },
    };

    const events = [];
    for await (const event of client._processSSE(mockResponse)) {
      events.push(event);
    }
    expect(events).toEqual([]);
  });

  it("parses SSE content events", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const sseData = `data: {"choices":[{"delta":{"content":"Hello"}}]}
data: {"choices":[{"delta":{"content":" World"}}]}
data: [DONE]
`;
    const mockResponse = {
      body: {
        getReader: () => ({
          read: async () => {
            return { done: false, value: new TextEncoder().encode(sseData) };
          },
          releaseLock: () => {},
        }),
      },
    };

    // We need to make the reader return done after first call
    let called = false;
    mockResponse.body.getReader = () => ({
      read: async () => {
        if (called) return { done: true, value: undefined };
        called = true;
        return { done: false, value: new TextEncoder().encode(sseData) };
      },
      releaseLock: () => {},
    });

    const events = [];
    for await (const event of client._processSSE(mockResponse)) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThanOrEqual(2);
    const contentEvents = events.filter((e) => e.type === "content");
    expect(contentEvents[0].content).toBe("Hello");
  });

  it("skips non-data lines", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const sseData = `event: message
data: {"choices":[{"delta":{"content":"test"}}]}

`;
    let called = false;
    const mockResponse = {
      body: {
        getReader: () => ({
          read: async () => {
            if (called) return { done: true, value: undefined };
            called = true;
            return { done: false, value: new TextEncoder().encode(sseData) };
          },
          releaseLock: () => {},
        }),
      },
    };

    const events = [];
    for await (const event of client._processSSE(mockResponse)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("test");
  });

  it("handles malformed JSON gracefully", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const sseData = `data: {invalid json}
data: {"choices":[{"delta":{"content":"valid"}}]}
`;
    let called = false;
    const mockResponse = {
      body: {
        getReader: () => ({
          read: async () => {
            if (called) return { done: true, value: undefined };
            called = true;
            return { done: false, value: new TextEncoder().encode(sseData) };
          },
          releaseLock: () => {},
        }),
      },
    };

    const events = [];
    for await (const event of client._processSSE(mockResponse)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("valid");
  });

  it("handles multi-chunk streams", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    let callCount = 0;
    const mockResponse = {
      body: {
        getReader: () => ({
          read: async () => {
            callCount++;
            if (callCount === 1) {
              return {
                done: false,
                value: new TextEncoder().encode(
                  'data: {"choices":[{"delta":{"content":"Hello"}}]}',
                ),
              };
            }
            if (callCount === 2) {
              return {
                done: false,
                value: new TextEncoder().encode("\ndata: [DONE]\n\n"),
              };
            }
            return { done: true, value: undefined };
          },
          releaseLock: () => {},
        }),
      },
    };

    const events = [];
    for await (const event of client._processSSE(mockResponse)) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    expect(events[0].content).toBe("Hello");
  });
});

describe("LlmClient constructor edge cases", () => {
  it("creates with markerMangler option", () => {
    const mangler = createMarkerMangler();
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: mangler });
    expect(client._mangler).toBe(mangler);
  });

  it("creates default mangler when not provided", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    expect(client._mangler).toBeDefined();
    expect(typeof client._mangler.escape).toBe("function");
  });

  it("accepts null markerMangler", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, markerMangler: null });
    expect(client._mangler).toBeNull();
  });

  it("sets cancelled flag to false by default", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    expect(client.cancelled).toBe(false);
  });

  it("sets sessionId from options", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, sessionId: "test-session" });
    expect(client.sessionId).toBe("test-session");
  });

  it("sets loud flag from options", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, loud: true });
    expect(client.loud).toBe(true);
  });

  it("stream defaults to true", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3 });
    expect(client.stream).toBe(true);
  });

  it("stream can be set to false", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, stream: false });
    expect(client.stream).toBe(false);
  });
});

describe("LlmClient._doRequest", () => {
  it("includes Authorization header when apiKey is set", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 30,
      maxRetries: 3,
      baseUrl: "http://test.com",
      apiKey: "secret",
    });
    let capturedHeaders = null;

    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      throw new Error("mock");
    };

    try {
      await client._doRequest(
        "http://test.com",
        "secret",
        { model: "test" },
        new AbortController().signal,
      );
    } catch (e) {
      // Expected to fail
    }

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders["Authorization"]).toBe("Bearer secret");
  });

  it("includes x-session-affinity header when sessionId is set", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 30,
      maxRetries: 3,
      baseUrl: "http://test.com",
      sessionId: "sess-123",
    });
    let capturedHeaders = null;

    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      throw new Error("mock");
    };

    try {
      await client._doRequest(
        "http://test.com",
        null,
        { model: "test" },
        new AbortController().signal,
      );
    } catch (e) {
      // Expected to fail
    }

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders["x-session-affinity"]).toBe("sess-123");
  });

  it("does not include Authorization header when apiKey is null", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", apiKey: null });
    let capturedHeaders = null;

    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      throw new Error("mock");
    };

    try {
      await client._doRequest(
        "http://test.com",
        null,
        { model: "test" },
        new AbortController().signal,
      );
    } catch (e) {
      // Expected to fail
    }

    expect(capturedHeaders).toBeDefined();
    expect(capturedHeaders["Authorization"]).toBeUndefined();
  });

  it("throws LlmError.Api on non-OK response", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = async () => {
      return {
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      };
    };

    await expect(
      client._doRequest(
        "http://test.com",
        "key",
        { model: "test" },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/HTTP 500/);
  });

  it("sets Connection: keep-alive header", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    let capturedHeaders = null;

    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      throw new Error("mock");
    };

    try {
      await client._doRequest(
        "http://test.com",
        "key",
        { model: "test" },
        new AbortController().signal,
      );
    } catch (e) {
      // Expected to fail
    }

    expect(capturedHeaders["Connection"]).toBe("keep-alive");
  });

  it("sets User-Agent header", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    let capturedHeaders = null;

    globalThis.fetch = async (url, opts) => {
      capturedHeaders = opts.headers;
      throw new Error("mock");
    };

    try {
      await client._doRequest(
        "http://test.com",
        "key",
        { model: "test" },
        new AbortController().signal,
      );
    } catch (e) {
      // Expected to fail
    }

    expect(capturedHeaders["User-Agent"]).toBe("hotdog/alpha");
  });

  it("sends request to /v1/chat/completions endpoint", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    let capturedUrl = null;

    globalThis.fetch = async (url, opts) => {
      capturedUrl = url;
      throw new Error("mock");
    };

    try {
      await client._doRequest(
        "http://test.com",
        "key",
        { model: "test" },
        new AbortController().signal,
      );
    } catch (e) {
      // Expected to fail
    }

    expect(capturedUrl).toBe("http://test.com/v1/chat/completions");
  });

  it("sends request body as JSON", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    let capturedBody = null;

    globalThis.fetch = async (url, opts) => {
      capturedBody = opts.body;
      throw new Error("mock");
    };

    try {
      await client._doRequest(
        "http://test.com",
        "key",
        { model: "test", messages: [] },
        new AbortController().signal,
      );
    } catch (e) {
      // Expected to fail
    }

    const parsed = JSON.parse(capturedBody);
    expect(parsed.model).toBe("test");
    expect(parsed.messages).toEqual([]);
  });

  it("passes signal to fetch", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    let capturedSignal = null;
    const abortController = new AbortController();

    globalThis.fetch = async (url, opts) => {
      capturedSignal = opts.signal;
      throw new Error("mock");
    };

    try {
      await client._doRequest(
        "http://test.com",
        "key",
        { model: "test" },
        abortController.signal,
      );
    } catch (e) {
      // Expected to fail
    }

    expect(capturedSignal).toBe(abortController.signal);
  });
});

describe("LlmClient.ping", () => {
  it("returns undefined on successful health check", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = async () => ({ ok: true });

    const result = await client.ping();
    expect(result).toBeUndefined();
  });

  it("throws LlmError.Api on non-OK health check", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = async () => ({ ok: false, status: 503 });

    await expect(client.ping()).rejects.toThrow(/HTTP 503/);
  });

  it("throws LlmError.Http on network error", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = async () => {
      throw new Error("ECONNREFUSED");
    };

    await expect(client.ping()).rejects.toThrow(/ECONNREFUSED/);
  });

  it("re-throws LlmError without wrapping", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = async () => {
      throw LlmError.Api("already typed");
    };

    await expect(client.ping()).rejects.toThrow(/already typed/);
  });
});

describe("LlmClient.chatStream", () => {
  it("yields stream events from chatStreamWithModelConfig", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    // Override chatStreamWithModelConfig to return known events
    client.chatStreamWithModelConfig = async function* () {
      yield { type: "content", content: "Hello" };
      yield { type: "content", content: " World" };
    };

    const events = [];
    for await (const event of client.chatStream(
      [{ role: "user", content: "Hi" }],
      "test-model",
    )) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].content).toBe("Hello");
  });

  it("passes tools to chatStreamWithModelConfig", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    let capturedTools = null;

    client.chatStreamWithModelConfig = async function* (
      messages,
      modelConfig,
      tools,
    ) {
      capturedTools = tools;
    };

    const tools = [{ type: "function", function: { name: "bash" } }];
    const gen = client.chatStream(
      [{ role: "user", content: "Hi" }],
      "test-model",
      tools,
    );

    // Consume the generator
    try {
      for await (const _ of gen) {
      }
    } catch {}

    expect(capturedTools).toBe(tools);
  });
});
