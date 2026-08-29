// Extended tests for LlmClient streaming and cancellation (public API only).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import type { ModelConfig } from "../../src/core/config/providers.ts";
import { createLlmProtocolRegistry, type LlmProtocol, type ProtocolContext } from "../../src/core/llm-client/protocol.ts";
import { LlmError } from "../../src/core/error.ts";
import { Message } from "../../src/core/context/message.ts";

function mc(overrides: Partial<ModelConfig> = {}): ModelConfig {
  return { name: "test-model", temperature: null, contextLimit: 128000, tags: [], ...overrides };
}

describe("LlmClient.ping", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns undefined on successful health check", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async () => ({ ok: true })) as unknown as typeof fetch;

    const result = await client.ping();
    expect(result).toBeUndefined();
  });

  it("throws LlmError.Api on non-OK health check", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async () => ({ ok: false, status: 503 })) as unknown as typeof fetch;

    await expect(client.ping()).rejects.toThrow(/HTTP 503/);
  });

  it("throws LlmError.Http on network error", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(client.ping()).rejects.toThrow(/ECONNREFUSED/);
  });

  it("re-throws LlmError without wrapping", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });

    globalThis.fetch = (async () => {
      throw LlmError.Api("already typed");
    }) as unknown as typeof fetch;

    await expect(client.ping()).rejects.toThrow(/already typed/);
  });

  it("resolves the provider URL when a model name is given (provider-only setup)", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 30,
      maxRetries: 3,
      markerMangler: null,
      providers: [{ name: "myprov", url: "http://prov.example", apiKey: "k", models: [] }],
    });

    let seen = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen = String(input);
      return { ok: true };
    }) as unknown as typeof fetch;

    await client.ping("myprov/model-x");
    expect(seen).toBe("http://prov.example/health");
  });

  it("defaults healthCheckTimeoutSecs to 5", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });
    expect(client.healthCheckTimeoutSecs).toBe(5);
  });

  it("aborts the health check after healthCheckTimeoutSecs and reports it as a timeout", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 30,
      maxRetries: 3,
      baseUrl: "http://test.com",
      healthCheckTimeoutSecs: 0.05,
      markerMangler: null,
    });

    // Simulate a hung /health endpoint: reject when the fetch signal aborts,
    // the way Bun rejects a fetch aborted by AbortSignal.timeout().
    globalThis.fetch = ((async (_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        });
      });
    }) as unknown as typeof fetch);

    const start = Date.now();
    const err = await client.ping().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmError);
    expect(String((err as Error).message)).toMatch(/health check timed out after 0\.05s/);
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("throws a config LlmError when the resolved provider has no URL", async () => {
    const client = new LlmClient({
      chatTimeoutSecs: 30,
      maxRetries: 3,
      markerMangler: null,
      providers: [{ name: "myprov", models: [] }],
    });

    await expect(client.ping("myprov/model-x")).rejects.toThrow(/No AI URL configured/);
  });
});

describe("LlmClient.chatStreamCancellable", () => {
  function makeMsg(role: string, content: string) {
    return new Message({ role, content });
  }

  function setupClient() {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });
    // Override _doRequest to return a mock SSE response instead of making real HTTP calls
    client._doRequest = async (_url: string, _apiKey: string | null, _request: Record<string, unknown>, signal: AbortSignal | null): Promise<Response> => {
      // If signal is already aborted, simulate a cancelled request
      if (signal?.aborted) {
        throw new Error("request was cancelled");
      }
      return {
        headers: new Map([["content-type", "text/event-stream"]]),
        get: () => "text/event-stream",
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
          // Real Response bodies are ReadableStreams with cancel(); the
          // client releases the connection in a finally when the consumer
          // abandons the stream.
          cancel: async () => {},
        },
      } as unknown as Response;
    };
    return client;
  }

  it("returns an async generator", () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });
    const gen = client.chatStreamCancellable(
      [makeMsg("user", "Hi")],
      mc(),
    );
    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });

  it("handles AbortSignal as cancelToken", async () => {
    const client = setupClient();
    const abortController = new AbortController();

    const gen = client.chatStreamCancellable(
      [makeMsg("user", "Hi")],
      mc(),
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
      mc(),
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
      mc(),
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

  it("passes provider-resolved url/apiKey/sessionId to parseStream ctx", async () => {
    let captured: ProtocolContext | null = null;
    const registry = createLlmProtocolRegistry();
    registry.register({
      id: "capture",
      buildRequest: () => ({ path: "/v1/chat/completions", body: {} }),
      buildHeaders: () => ({}),
      parseStream: async function* (_response: Response, ctx: ProtocolContext) {
        captured = ctx;
        yield { type: "content", content: "Hello" };
      },
    } as LlmProtocol);

    const client = new LlmClient({
      chatTimeoutSecs: 30,
      maxRetries: 3,
      // Raw client-level fallbacks: must NOT be what the protocol sees.
      baseUrl: "http://fallback.com",
      apiKey: "fallback-key",
      sessionId: "client-session",
      markerMangler: null,
      providers: [{ name: "myprov", url: "http://prov.example", apiKey: "prov-key", models: [] }],
      llmProtocolRegistry: registry,
    });
    // The capture protocol ignores the response body.
    client._doRequest = async (): Promise<Response> =>
      ({ headers: new Map(), get: () => "", body: null }) as unknown as Response;

    const gen = client.chatStreamCancellable(
      [makeMsg("user", "Hi")],
      mc({ name: "myprov/model-x", protocol: "capture" }),
      [],
      null,
    );

    const events = [];
    for await (const event of gen) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect(captured).not.toBeNull();
    expect(captured!.baseUrl).toBe("http://prov.example");
    expect(captured!.apiKey).toBe("prov-key");
    expect(captured!.sessionId).toBe("client-session");
  });
});

describe("LlmClient.chatStreamCancellable — network errors, timeouts, cancellation", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeMsg(role: string, content: string) {
    return new Message({ role, content });
  }

  function sseResponse(content: string, onCancel?: () => void): Response {
    return {
      ok: true,
      headers: new Map([["content-type", "text/event-stream"]]),
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
                  `data: {"choices":[{"delta":{"content":"${content}"}}]}\n\n`,
                ),
              };
            },
            releaseLock: () => {},
          } as any;
        },
        // Real Response bodies are ReadableStreams with cancel(); the
        // client releases the connection in a finally when the consumer
        // abandons the stream.
        cancel: async () => {
          onCancel?.();
        },
      },
    } as unknown as Response;
  }

  /** Fetch mock that hangs until the signal aborts, then rejects with the signal's reason (like real fetch). */
  function hangingFetch(signalLog: Array<{ signal: AbortSignal | null | undefined; abortedAtEntry: boolean }>) {
    return (async (_: string, options: RequestInit) => {
      const s = options.signal;
      signalLog.push({ signal: s, abortedAtEntry: s?.aborted ?? false });
      return await new Promise<Response>((_resolve, reject) => {
        if (!s) return; // hang forever
        if (s.aborted) reject(s.reason);
        else s.addEventListener("abort", () => reject(s.reason), { once: true });
      });
    }) as unknown as typeof fetch;
  }

  async function collect(gen: AsyncGenerator<any>) {
    const events: any[] = [];
    let error: unknown;
    try {
      for await (const event of gen) events.push(event);
    } catch (e) {
      error = e;
    }
    return { events, error };
  }

  it("retries raw network errors and resolves once the connection succeeds", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null, retryBaseDelayMs: 1 });
    let calls = 0;

    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError("fetch failed");
      return sseResponse("recovered");
    }) as unknown as typeof fetch;

    const { events, error } = await collect(
      client.chatStreamCancellable([makeMsg("user", "Hi")], mc()),
    );

    expect(error).toBeUndefined();
    expect(calls).toBe(2);
    expect(events.some((e) => e.type === "content" && e.content === "recovered")).toBe(true);
  });

  it("cancels the response body when the consumer abandons the stream mid-way", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 0, baseUrl: "http://test.com", markerMangler: null });
    let bodyCancelled = false;

    globalThis.fetch = (async () => sseResponse("partial", () => {
      bodyCancelled = true;
    })) as unknown as typeof fetch;

    const gen = client.chatStreamCancellable([makeMsg("user", "Hi")], mc());
    // Consume one event, then abandon the stream (the cancellation path).
    const first = await gen.next();
    expect(first.done).toBe(false);
    await gen.return(undefined);
    // The finally block runs asynchronously after return() settles.
    await new Promise((r) => setTimeout(r, 0));

    expect(bodyCancelled).toBe(true);
  });

  it("cancels the response body after a fully drained stream", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 0, baseUrl: "http://test.com", markerMangler: null });
    let bodyCancelled = false;

    globalThis.fetch = (async () => sseResponse("full", () => {
      bodyCancelled = true;
    })) as unknown as typeof fetch;

    const { events, error } = await collect(
      client.chatStreamCancellable([makeMsg("user", "Hi")], mc()),
    );

    expect(error).toBeUndefined();
    expect(events).toHaveLength(1);
    expect(bodyCancelled).toBe(true);
  });

  it("exhausts retries on persistent network error and surfaces LlmError.Http", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 2, baseUrl: "http://test.com", markerMangler: null, retryBaseDelayMs: 1 });
    let calls = 0;

    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    const { error } = await collect(
      client.chatStreamCancellable([makeMsg("user", "Hi")], mc()),
    );

    // maxRetries: 2 = one initial attempt plus two retries
    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).type).toBe("http");
    expect((error as Error).message).toContain("fetch failed");
  });

  it("does not retry 4xx HTTP errors", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });
    let calls = 0;

    globalThis.fetch = (async () => {
      calls++;
      return { ok: false, status: 400, text: async () => "Bad Request" } as unknown as Response;
    }) as unknown as typeof fetch;

    const { error } = await collect(
      client.chatStreamCancellable([makeMsg("user", "Hi")], mc()),
    );

    expect(calls).toBe(1);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).type).toBe("api");
    expect((error as Error).message).toMatch(/^HTTP 400/);
  });

  it("retries on chat timeout and surfaces a visible timeout error with a fresh signal per attempt", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 0.02, maxRetries: 2, baseUrl: "http://test.com", markerMangler: null, retryBaseDelayMs: 1 });
    const signalLog: Array<{ signal: AbortSignal | null | undefined; abortedAtEntry: boolean }> = [];

    globalThis.fetch = hangingFetch(signalLog);

    const { error } = await collect(
      client.chatStreamCancellable([makeMsg("user", "Hi")], mc()),
    );

    // All three attempts timed out (maxRetries: 2 = one initial + two retries)
    expect(signalLog).toHaveLength(3);
    // Regression: every attempt must start with a signal that is NOT already
    // aborted (previously the shared abortController was poisoned by the
    // first timeout, aborting every subsequent attempt instantly).
    for (const entry of signalLog) {
      expect(entry.abortedAtEntry).toBe(false);
    }
    // Each attempt gets its own timeout signal
    expect(signalLog[0]!.signal).not.toBe(signalLog[1]!.signal);
    expect(signalLog[1]!.signal).not.toBe(signalLog[2]!.signal);

    // The surfaced error is a LlmError timeout, not a raw AbortError,
    // so MessageBus will emit it instead of suppressing it as a cancel.
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).type).toBe("timeout");
    expect((error as Error).name).not.toBe("AbortError");
    expect(LlmError.isCancelled(error)).toBe(false);
    expect((error as Error).message).toMatch(/timed out/);
  });

  it("surfaces user cancellation as LlmError.Cancelled without retrying", async () => {
    const client = new LlmClient({ chatTimeoutSecs: 30, maxRetries: 3, baseUrl: "http://test.com", markerMangler: null });
    const signalLog: Array<{ signal: AbortSignal | null | undefined; abortedAtEntry: boolean }> = [];

    globalThis.fetch = hangingFetch(signalLog);

    const cancelController = new AbortController();
    setTimeout(() => cancelController.abort(), 30);

    const { error } = await collect(
      client.chatStreamCancellable(
        [makeMsg("user", "Hi")],
        mc(),
        [],
        cancelController.signal,
      ),
    );

    // No retries after cancellation
    expect(signalLog).toHaveLength(1);
    expect(error).toBeInstanceOf(LlmError);
    expect(LlmError.isCancelled(error)).toBe(true);
  });
});
