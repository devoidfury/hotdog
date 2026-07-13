import { describe, it, expect } from "bun:test";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import { LlmError } from "../../src/core/error.ts";
import { Message } from "../../src/core/context/message.ts";

describe("LlmClient constructor", () => {
  it("creates with defaults", () => {
    const client = new LlmClient({
      chatTimeoutSecs: 600,
      maxRetries: 12,
    });
    // No fallback — baseUrl is null when not configured
    expect(client.baseUrl).toBeNull();
    expect(client.apiKey).toBeNull();
    expect(client.stream).toBe(true);
    expect(client.chatTimeoutSecs).toBe(600);
    expect(client.maxRetries).toBe(12);
  });

  it("accepts custom options", () => {
    const client = new LlmClient({
      baseUrl: "http://custom.com",
      apiKey: "test-key",
      stream: false,
      chatTimeoutSecs: 30,
      maxRetries: 5,
    });
    expect(client.baseUrl).toBe("http://custom.com");
    expect(client.apiKey).toBe("test-key");
    expect(client.stream).toBe(false);
    expect(client.chatTimeoutSecs).toBe(30);
    expect(client.maxRetries).toBe(5);
  });

  it("ignores environment variables — config layer handles resolution", () => {
    const client = new LlmClient({
      chatTimeoutSecs: 600,
      maxRetries: 12,
    });
    // baseUrl/apiKey come from options only, not process.env
    expect(client.baseUrl).toBeNull();
    expect(client.apiKey).toBeNull();
  });

  it("explicit options are passed directly", () => {
    const client = new LlmClient({
      baseUrl: "http://explicit.com",
      apiKey: "explicit-key",
      chatTimeoutSecs: 600,
      maxRetries: 12,
    });
    expect(client.baseUrl).toBe("http://explicit.com");
    expect(client.apiKey).toBe("explicit-key");
  });
});

describe("LlmClient.resolveProviderSettings", () => {
  it("falls back to defaults when provider not found", () => {
    const client = new LlmClient({
      baseUrl: "http://default.com",
      apiKey: "default-key",
      chatTimeoutSecs: 600,
      maxRetries: 12,
    });
    const settings = client.resolveProviderSettings("unknown/model");
    expect(settings.url).toBe("http://default.com");
    expect(settings.apiKey).toBe("default-key");
  });

  it("uses provider settings when found", () => {
    const client = new LlmClient({
      baseUrl: "http://default.com",
      apiKey: "default-key",
      chatTimeoutSecs: 600,
      maxRetries: 12,
      providers: [
        { name: "openai", url: "http://openai.com", apiKey: "openai-key" },
      ],
    });
    const settings = client.resolveProviderSettings("openai/gpt-4");
    expect(settings.url).toBe("http://openai.com");
    expect(settings.apiKey).toBe("openai-key");
  });

  it("uses provider URL but falls back to client apiKey", () => {
    const client = new LlmClient({
      baseUrl: "http://default.com",
      apiKey: "default-key",
      chatTimeoutSecs: 600,
      maxRetries: 12,
      providers: [{ name: "openai", url: "http://openai.com" }],
    });
    const settings = client.resolveProviderSettings("openai/gpt-4");
    expect(settings.url).toBe("http://openai.com");
    expect(settings.apiKey).toBe("default-key");
  });
});

describe("LlmClient.buildChatRequest", () => {
  it("builds request with all fields", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const messages = [new Message({ role: "user", content: "Hello" })];
    const request = client.buildChatRequest(
      messages,
      { name: "gpt-4", temperature: 0.7, maxTokens: 100 },
      [{ type: "function", function: { name: "bash" } }],
    );
    expect(request.model).toBe("gpt-4");
    expect(request.messages).toHaveLength(1);
    expect(request.temperature).toBe(0.7);
    expect(request.max_tokens).toBe(100);
    expect(request.stream).toBe(true);
    expect(request.parallel_tool_calls).toBe(true);
    expect(request.tools).toHaveLength(1);
  });

  it("strips provider prefix from model name", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest(
      [],
      {
        name: "anthropic/claude-sonnet-4-20250514",
        temperature: null,
        maxTokens: 50,
      },
      null,
    );
    expect(request.model).toBe("claude-sonnet-4-20250514");
  });

  it("disables stream when requested", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest(
      [],
      { name: "gpt-4", maxTokens: 32000 },
      null,
      false,
    );
    expect(request.stream).toBe(false);
    expect(request.stream_options).toBeUndefined();
  });

  it("handles Message objects with tool_calls", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const msg = new Message({
      role: "assistant",
      content: "I will run a command",
      toolCalls: [{ id: "tc1", function: { name: "bash", arguments: "{}" } }],
    });
    const request = client.buildChatRequest(
      [msg],
      { name: "gpt-4", maxTokens: 32000 },
      null,
    );
    expect(request.messages[0].tool_calls).toHaveLength(1);
  });

  it("handles Message objects with toolCallId", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const msg = new Message({
      role: "tool",
      content: "output",
      toolCallId: "tc1",
    });
    const request = client.buildChatRequest(
      [msg],
      { name: "gpt-4", maxTokens: 32000 },
      null,
    );
    // Messages are escaped to JSON which includes tool_call_id
    expect(request.messages[0].tool_call_id).toBe("tc1");
  });
});

describe("LlmClient.chatStream", () => {
  it("returns an async generator", () => {
    const client = new LlmClient({
      baseUrl: "http://test.com",
      chatTimeoutSecs: 600,
      maxRetries: 12,
    });
    const gen = client.chatStream(
      [{ role: "user", content: "Hi" }],
      "test-model",
      [],
      32000,
    );
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });
});

describe("LlmClient.buildChatRequest reasoning_effort", () => {
  it("includes reasoning_effort when present in modelConfig", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest(
      [],
      {
        name: "gpt-4",
        temperature: null,
        maxTokens: 100,
        reasoningEffort: "high",
      },
      null,
    );
    expect(request.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort when undefined in modelConfig", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest(
      [],
      { name: "gpt-4", temperature: null, maxTokens: 100 },
      null,
    );
    expect(request.reasoning_effort).toBeUndefined();
  });

  it("omits reasoning_effort when null in modelConfig", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest(
      [],
      {
        name: "gpt-4",
        temperature: null,
        maxTokens: 100,
        reasoningEffort: null,
      },
      null,
    );
    expect(request.reasoning_effort).toBeUndefined();
  });

  it("supports all reasoning effort values", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const values = ["none", "minimal", "low", "high", "xhigh", "max"];
    for (const v of values) {
      const request = client.buildChatRequest(
        [],
        {
          name: "gpt-4",
          temperature: null,
          maxTokens: 100,
          reasoningEffort: v,
        },
        null,
      );
      expect(request.reasoning_effort).toBe(v);
    }
  });
});

describe("LlmClient — sessionId/loud/cancelled flags", () => {
  it("sets sessionId from options", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, sessionId: "session-123" });
    expect(client.sessionId).toBe("session-123");
  });

  it("sessionId defaults to empty string", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    expect(client.sessionId).toBe("");
  });

  it("accepts loud option", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, loud: true });
    expect(client.loud).toBe(true);
  });

  it("loud defaults to false", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    expect(client.loud).toBe(false);
  });

  it("cancelled defaults to false", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    expect(client.cancelled).toBe(false);
  });
});

describe("LlmClient.buildChatRequest — edge cases", () => {
  it("does not include tools fields when no tools provided", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest([], { name: "gpt-4" }, []);
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.parallel_tool_calls).toBeUndefined();
  });

  it("does not include tools fields when tools is null", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest([], { name: "gpt-4" }, null);
    expect(request.tools).toBeUndefined();
  });

  it("does not include temperature when null", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest([], { name: "gpt-4", temperature: null }, null);
    expect(request.temperature).toBeUndefined();
  });

  it("does not include temperature when undefined", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest([], { name: "gpt-4", temperature: undefined }, null);
    expect(request.temperature).toBeUndefined();
  });

  it("includes temperature 0", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest([], { name: "gpt-4", temperature: 0 }, null);
    expect(request.temperature).toBe(0);
  });
});