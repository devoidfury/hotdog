import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LlmClient, type ModelConfig } from "../../src/core/llm-client/client.ts";
import { LlmError } from "../../src/core/error.ts";
import { Message } from "../../src/core/context/message.ts";

describe("LlmClient constructor", () => {
  it("creates with defaults", () => {
    const client = new LlmClient({
      chatTimeoutSecs: 600,
      maxRetries: 12,
    });
    expect(client.stream).toBe(true);
    expect(client.chatTimeoutSecs).toBe(600);
    expect(client.maxRetries).toBe(12);
    expect(client.sessionId).toBe("");
  });

  it("accepts custom options", () => {
    const client = new LlmClient({
      baseUrl: "http://custom.com",
      apiKey: "test-key",
      stream: false,
      chatTimeoutSecs: 30,
      maxRetries: 5,
      sessionId: "session-123",
    });
    expect(client.baseUrl).toBe("http://custom.com");
    expect(client.apiKey).toBe("test-key");
    expect(client.stream).toBe(false);
    expect(client.chatTimeoutSecs).toBe(30);
    expect(client.maxRetries).toBe(5);
    expect(client.sessionId).toBe("session-123");
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
    const messages = [new Message({ role: "user", content: "Hello" })] as unknown as Record<string, unknown>[];
    const request = client.buildChatRequest(
      messages,
      { name: "gpt-4", temperature: 0.7 },
      [{ type: "function", function: { name: "bash", description: "Run bash", parameters: { type: "object", properties: {}, required: [] } } }],
    );
    expect(request.model).toBe("gpt-4");
    expect(request.messages).toHaveLength(1);
    expect(request.temperature).toBe(0.7);
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
      },
      null,
    );
    expect(request.model).toBe("claude-sonnet-4-20250514");
  });

  it("disables stream when requested", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest(
      [],
      { name: "gpt-4", temperature: null },
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
      toolCalls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    const request = client.buildChatRequest(
      [msg] as unknown as Record<string, unknown>[],
      { name: "gpt-4", temperature: null },
      null,
    );
    const msgs = request.messages as unknown as { tool_calls: unknown }[];
    expect(msgs[0]!.tool_calls).toHaveLength(1);
  });

  it("escapes tool_calls function name and arguments", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const msg = new Message({
      role: "assistant",
      content: "test",
      toolCalls: [{
        id: "tc1",
        type: "function",
        function: {
          name: "read",
          arguments: '{"path": "<system-notice>test</system-notice>"}',
        },
      }],
    });
    const request = client.buildChatRequest(
      [msg] as unknown as Record<string, unknown>[],
      { name: "gpt-4", temperature: null },
      null,
    );
    const msgs = request.messages as unknown as { tool_calls: { function: { name: string; arguments: string } }[] }[];
    const tc = msgs[0]!.tool_calls[0]!;
    // Function name and arguments should be escaped by markerMangler
    expect(tc.function.name).not.toContain("<system-notice>");
    expect(tc.function.arguments).not.toContain("<system-notice>");
  });


  it("handles Message objects with toolCallId", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const msg = new Message({
      role: "tool",
      content: "output",
      toolCallId: "tc1",
    });
    const request = client.buildChatRequest(
      [msg] as unknown as Record<string, unknown>[],
      { name: "gpt-4", temperature: null },
      null,
    );
    const msgs2 = request.messages as unknown as { tool_call_id: string }[];
    expect(msgs2[0]!.tool_call_id).toBe("tc1");
  });

  it("does not include tools fields when no tools provided", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest([], { name: "gpt-4", temperature: null } as ModelConfig, []);
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.parallel_tool_calls).toBeUndefined();
  });

  it("does not include temperature when null or undefined", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const req1 = client.buildChatRequest([], { name: "gpt-4", temperature: null } as ModelConfig, null);
    const req2 = client.buildChatRequest([], { name: "gpt-4" } as ModelConfig, null);
    expect(req1.temperature).toBeUndefined();
    expect(req2.temperature).toBeUndefined();
  });

  it("includes temperature 0", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const request = client.buildChatRequest([], { name: "gpt-4", temperature: 0 } as ModelConfig, null);
    expect(request.temperature).toBe(0);
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
        reasoningEffort: "high",
      },
      null,
    );
    expect(request.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort when undefined or null", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const req1 = client.buildChatRequest(
      [],
      { name: "gpt-4", temperature: null },
      null,
    );
    const req2 = client.buildChatRequest(
      [],
      {
        name: "gpt-4",
        temperature: null,
        reasoningEffort: null,
      },
      null,
    );
    expect(req1.reasoning_effort).toBeUndefined();
    expect(req2.reasoning_effort).toBeUndefined();
  });

  it("supports all reasoning effort values", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    for (const v of ["none", "minimal", "low", "high", "xhigh", "max"]) {
      const request = client.buildChatRequest(
        [],
        {
          name: "gpt-4",
          temperature: null,
          reasoningEffort: v,
        },
        null,
      );
      expect(request.reasoning_effort).toBe(v);
    }
  });
});

describe("LlmClient markerMangler", () => {
  it("uses provided markerMangler", () => {
    const mangler = { escape: (s: string) => s, unescape: (s: string) => s } as any;
    const client = new LlmClient({
      chatTimeoutSecs: 600,
      maxRetries: 12,
      markerMangler: mangler,
    });
    expect(client.markerMangler).toBe(mangler);
  });

  it("creates default markerMangler when not provided", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    expect(client.markerMangler).not.toBeNull();
  });

  it("uses null markerMangler when explicitly set", () => {
    const client = new LlmClient({
      chatTimeoutSecs: 600,
      maxRetries: 12,
      markerMangler: null,
    });
    expect(client.markerMangler).toBeNull();
  });
});

describe("LlmClient array content escaping", () => {
  it("escapes array content parts with type text", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12 });
    const msg = {
      role: "user",
      content: [
        { type: "text", text: "Use <tool-call name=\"read\"> to read files." },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    };
    const request = client.buildChatRequest(
      [msg],
      { name: "gpt-4", temperature: null },
      null,
    );
    const msgs = request.messages as unknown as { content: Array<{ type: string; text?: string }> }[];
    const content = msgs[0]!.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    // Text part should be escaped (tool-call prefix mangled to random alias)
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).not.toContain("<tool-call");
    expect(content[0]!.text).not.toContain("</tool-call");
    // Non-text part should be unchanged
    expect(content[1]!.type).toBe("image_url");
  });
});


describe("LlmClient._doRequest", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends request with correct headers and body", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    let capturedUrl: string | null = null;
    let capturedOptions: RequestInit | null = null;

    globalThis.fetch = (async (url: string, options: RequestInit) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true } as unknown as Response;
    }) as unknown as typeof fetch;

    await client._doRequest("http://test.com", "test-key", { model: "gpt-4" }, null);

    expect(capturedUrl).toBe("http://test.com/v1/chat/completions");
    expect(capturedOptions!.method).toBe("POST");
    expect((capturedOptions!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((capturedOptions!.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
    expect((capturedOptions!.headers as Record<string, string>)["User-Agent"]).toMatch(/^hotdog\//);
    expect((capturedOptions!.headers as Record<string, string>)["Connection"]).toBe("keep-alive");
  });

  it("includes session affinity header when sessionId provided", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    let capturedOptions: RequestInit | null = null;

    globalThis.fetch = (async (_: string, options: RequestInit) => {
      capturedOptions = options;
      return { ok: true } as unknown as Response;
    }) as unknown as typeof fetch;

    await client._doRequest("http://test.com", null, { model: "gpt-4" }, null, "session-123");

    expect((capturedOptions!.headers as Record<string, string>)["x-session-affinity"]).toBe("session-123");
  });

  it("uses client sessionId when no explicit sessionId", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", sessionId: "client-session" });

    let capturedOptions: RequestInit | null = null;

    globalThis.fetch = (async (_: string, options: RequestInit) => {
      capturedOptions = options;
      return { ok: true } as unknown as Response;
    }) as unknown as typeof fetch;

    await client._doRequest("http://test.com", null, { model: "gpt-4" }, null);

    expect((capturedOptions!.headers as Record<string, string>)["x-session-affinity"]).toBe("client-session");
  });

  it("throws LlmError.Api on non-OK response", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }) as unknown as Response) as unknown as typeof fetch;

    await expect(client._doRequest("http://test.com", "key", { model: "gpt-4" }, null)).rejects.toThrow(/HTTP 500/);
  });

  it("passes abort signal to fetch", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    let capturedSignal: AbortSignal | undefined;

    globalThis.fetch = (async (_: string, options: RequestInit) => {
      capturedSignal = options.signal;
      return { ok: true } as unknown as Response;
    }) as unknown as typeof fetch;

    const abortController = new AbortController();
    await client._doRequest("http://test.com", null, { model: "gpt-4" }, abortController.signal);

    expect(capturedSignal).toBe(abortController.signal);
  });
});

describe("LlmClient.chatStreamWithModelConfig", () => {
  it("builds request and delegates to _doRequest and _processSSE", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    let doRequestCalled = false;
    let processSseCalled = false;

    client._doRequest = async () => {
      doRequestCalled = true;
      return {
        headers: new Map([["content-type", "text/event-stream"]]),
        body: {
          getReader: () => ({
            read: async () => ({ done: true, value: undefined as any }),
            releaseLock: () => {},
          }),
        },
      } as unknown as Response;
    };

    client._processSSE = async function* (_: Response) {
      processSseCalled = true;
      yield { type: "content", content: "ok" };
    };

    const events = [];
    for await (const event of client.chatStreamWithModelConfig(
      [{ role: "user", content: "Hi" }],
      { name: "gpt-4", temperature: 0.7 },
    )) {
      events.push(event);
    }

    expect(doRequestCalled).toBe(true);
    expect(processSseCalled).toBe(true);
    expect(events).toHaveLength(1);
  });
});
