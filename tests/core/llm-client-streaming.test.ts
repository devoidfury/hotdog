// Extended tests for LlmClient streaming and cancellation (public API only).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import { LlmError } from "../../src/core/error.ts";

describe("LlmClient.ping", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns undefined on successful health check", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;

    const result = await client.ping();
    expect(result).toBeUndefined();
  });

  it("throws LlmError.Api on non-OK health check", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;

    await expect(client.ping()).rejects.toThrow(/HTTP 503/);
  });

  it("throws LlmError.Http on network error", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(client.ping()).rejects.toThrow(/ECONNREFUSED/);
  });

  it("re-throws LlmError without wrapping", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });

    globalThis.fetch = (async () => {
      throw LlmError.Api("already typed");
    }) as unknown as typeof fetch;

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
    expect((events[0]! as any).content).toBe("Hello");
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

    const tools = [{ type: "function", function: { name: "bash", description: "Run bash", parameters: { type: "object", properties: {}, required: [] } } }];
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

    expect(capturedTools!).toBe(tools);
  });
});

describe("LlmClient.chatStreamCancellable", () => {
  function makeMsg(role: string, content: string) {
    return { role, content, toJSON: () => ({ role, content }) };
  }

  function setupClient() {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    // Override _doRequest to return a mock SSE response instead of making real HTTP calls
    client._doRequest = async (url: string, apiKey: string | null, request: Record<string, unknown>, signal: AbortSignal | null): Promise<Response> => {
      // If signal is already aborted, simulate a cancelled request
      if (signal?.aborted) {
        throw new Error("request was cancelled");
      }
      return {
        headers: new Map([["content-type", "text/event-stream"]]),
        get: (name: string) => "text/event-stream",
        body: {
          getReader: () => {
            let done = false;
            return {
              read: async () => {
                if (done) return { done: true, value: undefined as any };
                done = true;
                return {
                  done: false,
                  value: new TextEncoder().encode(
                    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
                  ),
                };
              },
              releaseLock: () => {},
            } as any;
          },
        },
      } as unknown as Response;
    };
    return client;
  }

  it("returns an async generator", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com" });
    const gen = client.chatStreamCancellable(
      [{ role: "user", content: "Hi" }],
      { name: "test-model", temperature: null },
    );
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });

  it("handles AbortSignal as cancelToken", async () => {
    const client = setupClient();
    const abortController = new AbortController();

    const gen = client.chatStreamCancellable(
      [makeMsg("user", "Hi")],
      { name: "test-model", temperature: null },
      [],
      abortController.signal,
    );

    const events = [];
    for await (const event of gen) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect((events[0]! as any).content).toBe("Hello");
  });

  it("throws when cancelToken is already aborted", async () => {
    const client = setupClient();
    const abortController = new AbortController();
    abortController.abort();

    const gen = client.chatStreamCancellable(
      [makeMsg("user", "Hi")],
      { name: "test-model", temperature: null },
      [],
      abortController.signal,
    );

    let threw = false;
    try {
      for await (const _ of gen) {
      }
    } catch (e: any) {
      threw = true;
      expect(e.message).toMatch(/cancelled/i);
    }
    expect(threw).toBe(true);
  });

  it("handles null cancelToken", async () => {
    const client = setupClient();

    const gen = client.chatStreamCancellable(
      [makeMsg("user", "Hi")],
      { name: "test-model", temperature: null },
      [],
      null,
    );

    const events = [];
    for await (const event of gen) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect((events[0]! as any).content).toBe("Hello");
  });
});
