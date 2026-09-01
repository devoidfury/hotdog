import { describe, it, expect } from "bun:test";
import {
  shouldRetryLlmError,
  retryDelay,
  extractHttpStatus,
  isRetryableHttpStatus,
} from "../../src/core/llm-client/retry.ts";
import { LlmError } from "../../src/core/error.ts";

describe("shouldRetryLlmError", () => {
  it("retries transient http errors", () => {
    expect(shouldRetryLlmError(LlmError.Http("Service unavailable"), 1, 3)).toBe(true);
    expect(shouldRetryLlmError(LlmError.Http("Service unavailable"), 3, 3)).toBe(true);
  });

  it("retries timeout errors", () => {
    expect(shouldRetryLlmError(LlmError.Timeout("timed out"), 1, 3)).toBe(true);
  });

  it("does not retry cancelled errors", () => {
    expect(shouldRetryLlmError(LlmError.Cancelled("cancelled"), 1, 3)).toBe(false);
  });

  it("does not retry non-transient api errors", () => {
    expect(shouldRetryLlmError(LlmError.Api("Bad input"), 1, 3)).toBe(false);
  });

  it("does not retry on the final attempt, even for transient errors", () => {
    // maxRetries: 3 -> attempts 1..4; attempt 4 is final.
    expect(shouldRetryLlmError(LlmError.Http("fail"), 4, 3)).toBe(false);
  });

  it("negative maxRetries clamps to a single attempt", () => {
    expect(shouldRetryLlmError(LlmError.Http("fail"), 1, -1)).toBe(false);
    // And a hypothetical second attempt would also be rejected.
    expect(shouldRetryLlmError(LlmError.Http("fail"), 2, -1)).toBe(false);
  });

  it("never retries non-LlmError failures (callers classify first)", () => {
    expect(shouldRetryLlmError(new Error("socket hang up"), 1, 3)).toBe(false);
    expect(shouldRetryLlmError("boom", 1, 3)).toBe(false);
  });
});

describe("shouldRetryLlmError — api status retry", () => {
  it("retries on retryable HTTP status codes in the message", () => {
    expect(shouldRetryLlmError(LlmError.Api("HTTP 500 (body: Internal Server Error)"), 1, 3)).toBe(true);
    expect(shouldRetryLlmError(LlmError.Api("HTTP 429 (body: Too Many Requests)"), 1, 3)).toBe(true);
  });

  it("does not retry on non-retryable HTTP status codes", () => {
    expect(shouldRetryLlmError(LlmError.Api("HTTP 301 (body: Moved Permanently)"), 1, 3)).toBe(false);
    expect(shouldRetryLlmError(LlmError.Api("HTTP 400 (body: Bad Request)"), 1, 3)).toBe(false);
  });

  it("retries on retryable status from the field, independent of the message", () => {
    expect(shouldRetryLlmError(LlmError.Api("upstream error", 503), 1, 3)).toBe(true);
    expect(shouldRetryLlmError(LlmError.Api("rate limited", 429), 1, 3)).toBe(true);
  });

  it("does not retry on non-retryable status from the field", () => {
    expect(shouldRetryLlmError(LlmError.Api("bad input", 400), 1, 3)).toBe(false);
  });

  it("field takes precedence over a contradictory message", () => {
    // Message parses as retryable (500), field says 400: field wins.
    expect(shouldRetryLlmError(LlmError.Api("HTTP 500 (body: Internal Server Error)", 400), 1, 3)).toBe(false);
  });

  it("falls back to the message when the field is absent", () => {
    expect(shouldRetryLlmError(LlmError.Api("HTTP 500 (body: Internal Server Error)"), 1, 3)).toBe(true);
  });
});

describe("retryDelay", () => {
  it("resolves after the delay", async () => {
    const start = Date.now();
    await retryDelay(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(25);
  });

  it("resolves early when the signal aborts", async () => {
    const controller = new AbortController();
    const start = Date.now();
    const p = retryDelay(60_000, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await p;
    expect(Date.now() - start).toBeLessThan(5000);
  });

  it("resolves immediately when the signal is already aborted", async () => {
    // A past "abort" never re-fires the listener, so without the up-front
    // check this would hang for the full backoff (60s) instead of
    // resolving now.
    const controller = new AbortController();
    controller.abort();
    const start = Date.now();
    await retryDelay(60_000, controller.signal);
    expect(Date.now() - start).toBeLessThan(500);
  });

  // Spy on the signal's add/removeEventListener to verify the listener is
  // detached whichever way the wait ends (leak check: the shared abort
  // controller outlives many retries).
  function trackSignal(signal: AbortSignal): {
    added: Array<() => void>;
    removed: Array<() => void>;
    restore: () => void;
  } {
    const proto = AbortSignal.prototype;
    const origAdd = proto.addEventListener;
    const origRemove = proto.removeEventListener;
    const added: Array<() => void> = [];
    const removed: Array<() => void> = [];
    proto.addEventListener = function (
      this: AbortSignal,
      type: string,
      listener: any,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (this === signal && type === "abort") added.push(listener as () => void);
      return origAdd.call(this, type, listener, options);
    };
    proto.removeEventListener = function (
      this: AbortSignal,
      type: string,
      listener: any,
      options?: boolean | EventListenerOptions,
    ) {
      if (this === signal && type === "abort") removed.push(listener as () => void);
      return origRemove.call(this, type, listener, options);
    };
    return {
      added,
      removed,
      restore: () => {
        proto.addEventListener = origAdd;
        proto.removeEventListener = origRemove;
      },
    };
  }

  it("removes its abort listener when the delay elapses", async () => {
    const controller = new AbortController();
    const spy = trackSignal(controller.signal);
    try {
      await retryDelay(20, controller.signal);
    } finally {
      spy.restore();
    }
    expect(spy.added).toHaveLength(1);
    expect(spy.removed).toEqual(spy.added);
  });

  it("removes its abort listener when the signal aborts", async () => {
    const controller = new AbortController();
    const spy = trackSignal(controller.signal);
    try {
      const p = retryDelay(60_000, controller.signal);
      setTimeout(() => controller.abort(), 10);
      await p;
    } finally {
      spy.restore();
    }
    expect(spy.added).toHaveLength(1);
    expect(spy.removed).toEqual(spy.added);
  });
});

describe("extractHttpStatus", () => {
  it("extracts status code from HTTP error message", () => {
    expect(extractHttpStatus("HTTP 500 (body: Internal Server Error)")).toBe(
      500,
    );
    expect(extractHttpStatus("HTTP 429 (body: Too Many Requests)")).toBe(429);
    expect(extractHttpStatus("HTTP 200")).toBe(200);
  });

  it("returns null for non-HTTP messages", () => {
    expect(extractHttpStatus("Bad input")).toBeNull();
    expect(extractHttpStatus("Timeout")).toBeNull();
    expect(extractHttpStatus("")).toBeNull();
  });
});

describe("isRetryableHttpStatus", () => {
  it("retries on 5xx server errors", () => {
    expect(isRetryableHttpStatus(500)).toBe(true);
    expect(isRetryableHttpStatus(502)).toBe(true);
    expect(isRetryableHttpStatus(503)).toBe(true);
    expect(isRetryableHttpStatus(599)).toBe(true);
  });

  it("retries on 429 rate limiting", () => {
    expect(isRetryableHttpStatus(429)).toBe(true);
  });

  it("does not retry on 3xx redirects", () => {
    expect(isRetryableHttpStatus(301)).toBe(false);
    expect(isRetryableHttpStatus(302)).toBe(false);
    expect(isRetryableHttpStatus(399)).toBe(false);
  });

  it("does not retry on 4xx client errors", () => {
    expect(isRetryableHttpStatus(400)).toBe(false);
    expect(isRetryableHttpStatus(401)).toBe(false);
    expect(isRetryableHttpStatus(403)).toBe(false);
    expect(isRetryableHttpStatus(404)).toBe(false);
  });

  it("does not retry on 2xx or 1xx", () => {
    expect(isRetryableHttpStatus(200)).toBe(false);
    expect(isRetryableHttpStatus(201)).toBe(false);
  });
});
