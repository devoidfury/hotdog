import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import type { ModelConfig } from "../../src/core/config/providers.ts";
import { LlmError } from "../../src/core/error.ts";
import { Message } from "../../src/core/context/message.ts";

/** Build a valid ModelConfig (requires contextLimit + tags now). */
function mc(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { name: "gpt-4", temperature: null, contextLimit: 128000, tags: [], ...overrides };
}

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
        { name: "openai", url: "http://openai.com", apiKey: "openai-key", models: [] },
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
      providers: [{ name: "openai", url: "http://openai.com", models: [] }],
    });
    const settings = client.resolveProviderSettings("openai/gpt-4");
    expect(settings.url).toBe("http://openai.com");
    expect(settings.apiKey).toBe("default-key");
  });
});

describe("LlmClient.buildChatRequest", () => {
  it("builds request with all fields", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const messages = [new Message({ role: "user", content: "Hello" })];
    const request = client.buildChatRequest(
      messages,
      mc({ temperature: 0.7 }),
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
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const request = client.buildChatRequest(
      [],
      mc({ name: "anthropic/claude-sonnet-4-20250514" }),
      null,
    );
    expect(request.model).toBe("claude-sonnet-4-20250514");
  });

  it("disables stream when requested", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const request = client.buildChatRequest(
      [],
      mc(),
      null,
      false,
    );
    expect(request.stream).toBe(false);
    expect(request.stream_options).toBeUndefined();
  });

  it("handles Message objects with tool_calls", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const msg = new Message({
      role: "assistant",
      content: "I will run a command",
      toolCalls: [{ id: "tc1", type: "function", function: { name: "bash", arguments: "{}" } }],
    });
    const request = client.buildChatRequest(
      [msg],
      mc(),
      null,
    );
    const msgs = request.messages as unknown as { tool_calls: unknown }[];
    expect(msgs[0]!.tool_calls).toHaveLength(1);
  });

  it("escapes tool_calls function name and arguments", () => {
    const MARKER = "m_pbc8misbbcxouboa";
    const mangler = { escape: (s: string) => s.replace(new RegExp(MARKER, "g"), "m_aliased"), unescape: (s: string) => s, addPrefixes: () => {} } as any;
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
    const argsJson = JSON.stringify({ path: `<${MARKER}>test</${MARKER}>` });
    const msg = new Message({
      role: "assistant",
      content: "test",
      toolCalls: [{
        id: "tc1",
        type: "function",
        function: {
          name: "read",
          arguments: argsJson,
        },
      }],
    });
    const request = client.buildChatRequest(
      [msg],
      mc(),
      null,
    );
    const msgs = request.messages as unknown as { tool_calls: { function: { name: string; arguments: string } }[] }[];
    const tc = msgs[0]!.tool_calls[0]!;
    // Function name and arguments should be escaped by markerMangler
    expect(tc.function.name).not.toContain(`<${MARKER}>`);
    expect(tc.function.arguments).not.toContain(`<${MARKER}>`);
  });


  it("handles Message objects with toolCallId", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const msg = new Message({
      role: "tool",
      content: "output",
      toolCallId: "tc1",
    });
    const request = client.buildChatRequest(
      [msg],
      mc(),
      null,
    );
    const msgs2 = request.messages as unknown as { tool_call_id: string }[];
    expect(msgs2[0]!.tool_call_id).toBe("tc1");
  });

  it("does not include tools fields when no tools provided", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const request = client.buildChatRequest([], mc(), []);
    expect(request.tools).toBeUndefined();
    expect(request.tool_choice).toBeUndefined();
    expect(request.parallel_tool_calls).toBeUndefined();
  });

  it("does not include temperature when null or undefined", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const req1 = client.buildChatRequest([], mc(), null);
    const req2 = client.buildChatRequest([], mc({ temperature: undefined }), null);
    expect(req1.temperature).toBeUndefined();
    expect(req2.temperature).toBeUndefined();
  });

  it("includes temperature 0", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const request = client.buildChatRequest([], mc({ temperature: 0 }), null);
    expect(request.temperature).toBe(0);
  });
});

describe("LlmClient.buildChatRequest reasoning_effort", () => {
  it("includes reasoning_effort when present in modelConfig", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const request = client.buildChatRequest([], mc({ reasoningEffort: "high" }), null);
    expect(request.reasoning_effort).toBe("high");
  });

  it("omits reasoning_effort when undefined", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    const req1 = client.buildChatRequest([], mc(), null);
    const req2 = client.buildChatRequest([], mc({ reasoningEffort: undefined }), null);
    expect(req1.reasoning_effort).toBeUndefined();
    expect(req2.reasoning_effort).toBeUndefined();
  });

  it("supports all reasoning effort values", () => {
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: null });
    for (const v of ["none", "minimal", "low", "high", "xhigh", "max"]) {
      const request = client.buildChatRequest([], mc({ reasoningEffort: v }), null);
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
    const MARKER = "m_7mqcm4tufjt4sujb-call";
    const mangler = { escape: (s: string) => s.replace(new RegExp(MARKER, "g"), "m_aliased"), unescape: (s: string) => s, addPrefixes: () => {} } as any;
    const client = new LlmClient({ chatTimeoutSecs: 600, maxRetries: 12, markerMangler: mangler });
    const toolCallTag = MARKER.slice(2);
    const msg = new Message({
      role: "user",
      content: [
        { type: "text", text: `Use <${toolCallTag} name="read"> to read files.` },
        { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
      ],
    });
    const request = client.buildChatRequest(
      [msg],
      mc(),
      null,
    );
    const msgs = request.messages as unknown as { content: Array<{ type: string; text?: string }> }[];
    const content = msgs[0]!.content as Array<{ type: string; text?: string }>;
    expect(content).toHaveLength(2);
    // Text part should be escaped (tool-call prefix mangled to random alias)
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).not.toContain(`<${MARKER}>`);
    expect(content[0]!.text).not.toContain(`</${MARKER}>`);
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
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    let capturedUrl: string | null = null;
    let capturedOptions: RequestInit | null = null;

    globalThis.fetch = (async (url: string, options: RequestInit) => {
      capturedUrl = url;
      capturedOptions = options;
      return { ok: true } as unknown as Response;
    }) as unknown as typeof fetch;

    await client._doRequest("http://test.com", "test-key", { model: "gpt-4" }, null, mc(), "/v1/chat/completions");

    expect(capturedUrl!).toBe("http://test.com/v1/chat/completions");
    expect(capturedOptions!.method).toBe("POST");
    expect((capturedOptions!.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((capturedOptions!.headers as Record<string, string>)["Authorization"]).toBe("Bearer test-key");
    expect((capturedOptions!.headers as Record<string, string>)["User-Agent"]).toMatch(/^hotdog\//);
    expect((capturedOptions!.headers as Record<string, string>)["Connection"]).toBe("keep-alive");
  });

  it("includes session affinity header when sessionId provided", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    let capturedOptions: RequestInit | null = null;

    globalThis.fetch = (async (_: string, options: RequestInit) => {
      capturedOptions = options;
      return { ok: true } as unknown as Response;
    }) as unknown as typeof fetch;

    await client._doRequest("http://test.com", null, { model: "gpt-4" }, null, mc(), "/v1/chat/completions", "session-123");

    expect((capturedOptions!.headers as Record<string, string>)["x-session-affinity"]).toBe("session-123");
  });

  it("uses client sessionId when no explicit sessionId", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", sessionId: "client-session" });

    let capturedOptions: RequestInit | null = null;

    globalThis.fetch = (async (_: string, options: RequestInit) => {
      capturedOptions = options;
      return { ok: true } as unknown as Response;
    }) as unknown as typeof fetch;

    await client._doRequest("http://test.com", null, { model: "gpt-4" }, null, mc(), "/v1/chat/completions");

    expect((capturedOptions!.headers as Record<string, string>)["x-session-affinity"]).toBe("client-session");
  });

  it("throws LlmError.Api on non-OK response", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    }) as unknown as Response) as unknown as typeof fetch;

    await expect(client._doRequest("http://test.com", "key", { model: "gpt-4" }, null, mc(), "/v1/chat/completions")).rejects.toMatchObject({
      type: "api",
      status: 500,
    });
  });

  it("attaches a parsed Retry-After hint to the api error", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async () =>
      new Response("slow down", { status: 429, headers: { "retry-after": "3" } })) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await client._doRequest("http://test.com", "key", { model: "gpt-4" }, null, mc(), "/v1/chat/completions");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmError);
    const err = caught as LlmError;
    expect(err.status).toBe(429);
    expect(err.retryAfterMs).toBe(3000);
  });

  it("leaves retryAfterMs unset when the header is absent or malformed", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    for (const headers of [undefined, { "retry-after": "later" }]) {
      globalThis.fetch = (async () =>
        new Response("nope", { status: 503, headers })) as unknown as typeof fetch;

      let caught: unknown;
      try {
        await client._doRequest("http://test.com", "key", { model: "gpt-4" }, null, mc(), "/v1/chat/completions");
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(LlmError);
      expect((caught as LlmError).retryAfterMs).toBeUndefined();
    }
  });

  it("caps oversized error bodies and keeps the status prefix", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async () => ({
      ok: false,
      status: 500,
      text: async () => "x".repeat(200_001),
    }) as unknown as Response) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await client._doRequest("http://test.com", "key", { model: "gpt-4" }, null, mc(), "/v1/chat/completions");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(LlmError);
    const err = caught as LlmError;
    expect(err.status).toBe(500);
    expect(err.message).toContain("[truncated]");
    // The message quotes at most the 2K quote cap, not the 200K read cap.
    expect(err.message.length).toBeLessThan(2_100);
    // The prefix must stay parseable by the retry fallback.
    expect(err.message.startsWith("HTTP 500 ")).toBe(true);
  });

  it("truncates a mid-size body in the message even below the read cap", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    // 5KB body: under the 200K read cap (passes through reading untouched)
    // but over the 2K quote cap.
    globalThis.fetch = (async () => ({
      ok: false,
      status: 503,
      headers: new Map(),
      body: null,
      text: async () => "y".repeat(5_000),
    }) as unknown as Response) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await client._doRequest("http://test.com", "key", { model: "gpt-4" }, null, mc(), "/v1/chat/completions");
    } catch (e) {
      caught = e;
    }
    const err = caught as LlmError;
    expect(err).toBeInstanceOf(LlmError);
    expect(err.message).toContain("[truncated]");
    expect(err.message.length).toBeLessThan(2_100);
    expect(err.message.startsWith("HTTP 503 (body: y")).toBe(true);
  });

  it("quotes a small error body in full with no truncation marker", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async () => ({
      ok: false,
      status: 400,
      headers: new Map(),
      body: null,
      text: async () => "invalid request",
    }) as unknown as Response) as unknown as typeof fetch;

    let caught: unknown;
    try {
      await client._doRequest("http://test.com", "key", { model: "gpt-4" }, null, mc(), "/v1/chat/completions");
    } catch (e) {
      caught = e;
    }
    const err = caught as LlmError;
    expect(err.message).toBe("HTTP 400 (body: invalid request)");
  });

  it("passes abort signal to fetch", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    let capturedSignal: AbortSignal | null | undefined;

    globalThis.fetch = (async (_: string, options: RequestInit) => {
      capturedSignal = options.signal;
      return { ok: true } as unknown as Response;
    }) as unknown as typeof fetch;

    const abortController = new AbortController();
    await client._doRequest("http://test.com", null, { model: "gpt-4" }, abortController.signal, mc(), "/v1/chat/completions");

    expect(capturedSignal).toBe(abortController.signal);
  });

  it("translates raw network failures into LlmError.Http", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      client._doRequest("http://test.com", null, { model: "gpt-4" }, null, mc(), "/v1/chat/completions"),
    ).rejects.toMatchObject({ type: "http", name: "Error" });
  });

  it("translates aborted shared signal into LlmError.Cancelled", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async (_: string, options: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const s = options.signal;
        if (!s) throw new Error("expected signal");
        if (s.aborted) reject(s.reason);
        else s.addEventListener("abort", () => reject(s.reason), { once: true });
      });
    }) as unknown as typeof fetch;

    const abortController = new AbortController();
    abortController.abort();

    await expect(
      client._doRequest("http://test.com", null, { model: "gpt-4" }, abortController.signal, mc(), "/v1/chat/completions"),
    ).rejects.toMatchObject({ type: "cancelled" });
  });

  it("translates per-attempt timeout into LlmError.Timeout", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async (_: string, options: RequestInit) => {
      return await new Promise<Response>((_resolve, reject) => {
        const s = options.signal;
        if (!s) throw new Error("expected signal");
        if (s.aborted) reject(s.reason);
        else s.addEventListener("abort", () => reject(s.reason), { once: true });
      });
    }) as unknown as typeof fetch;

    // No user signal: only the per-attempt timeout can fire.
    await expect(
      client._doRequest("http://test.com", null, { model: "gpt-4" }, null, mc(), "/v1/chat/completions", undefined, 30),
    ).rejects.toMatchObject({ type: "timeout" });
  });
});
