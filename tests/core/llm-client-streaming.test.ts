// Extended tests for LlmClient streaming and cancellation (public API only).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import type { ModelConfig } from "../../src/core/config/providers.ts";
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

  function sseResponse(content: string): Response {
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

    expect(calls).toBe(2);
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

    // Both attempts timed out
    expect(signalLog).toHaveLength(2);
    // Regression: attempt 2 must start with a signal that is NOT already
    // aborted (previously the shared abortController was poisoned by the
    // first timeout, aborting every subsequent attempt instantly).
    expect(signalLog[0]!.abortedAtEntry).toBe(false);
    expect(signalLog[1]!.abortedAtEntry).toBe(false);
    // Each attempt gets its own timeout signal
    expect(signalLog[0]!.signal).not.toBe(signalLog[1]!.signal);

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
