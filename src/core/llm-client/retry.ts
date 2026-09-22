import { LlmError } from "../error.ts";

/**
 * Fallback: parses the status out of LlmError messages formatted
 * "HTTP <status> (body: ...)" for errors constructed without the
 * structured `status` field (extensions, older callers).
 */
export function extractHttpStatus(message: string): number | null {
  const match = message.match(/^HTTP (\d+)/);
  return match ? parseInt(match[1] ?? "", 10) : null;
}

/**
 * Retry on 5xx (server errors) and 429 (rate limiting).
 * Do NOT retry on 4xx (client errors) except 429, or on 3xx (redirects):
 * a redirect of the same request will repeat identically on every attempt,
 * so retrying only wastes attempts and hides a misconfigured endpoint.
 */
export function isRetryableHttpStatus(status: number): boolean {
  if (status >= 500 && status < 600) return true;
  if (status === 429) return true;
  return false;
}

/**
 * Bounded set of documented code/type fragments meaning "quota exhausted". Matched case-insensitively against
 * code/type fields of an error body ONLY -- never arbitrary response text -- so an ambiguous 429/403 is not falsely labeled.
 */
const QUOTA_SIGNALS = [
  "insufficient_quota",
  "insufficient-quota",
  "quota_exceeded",
  "quota-exceeded",
  "quota_exhausted",
  "quota-exhausted",
  "resource_exhausted",
  "resource-exhausted",
  "billing_quota_exceeded",
  "quota_limit_reached",
  "quota_limit_exceeded",
];

/**
 * True when a 403/429 JSON error body carries a documented quota signal in its code/type (or error.code/error.type) field.
 * A bare 429 (throttling) or a bare 403 (auth) does NOT qualify.
 */
export function hasQuotaSignal(status: number, bodyText: string): boolean {
  if (status !== 429 && status !== 403) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return false;
  }
  const obj = parsed as Record<string, unknown> | null;
  if (!obj || typeof obj !== "object") return false;
  const errObj = obj.error as Record<string, unknown> | undefined;
  const fields = [obj.code, obj.type, errObj?.code, errObj?.type]
    .filter((f): f is string => typeof f === "string")
    .map((f) => f.toLowerCase());
  return fields.some((f) => QUOTA_SIGNALS.some((s) => f.includes(s)));
}

/**
 * Message patterns for provider errors that mean "the prompt exceeds the
 * context window". Focused on the OpenAI-compatible local backends hotdog
 * targets (llama.cpp server, Ollama, LM Studio, vLLM) plus the common
 * OpenAI/proxy wordings; deliberately narrower than a full provider table --
 * a missed exotic backend just surfaces as a plain error, the status quo.
 */
const CONTEXT_OVERFLOW_PATTERNS: readonly RegExp[] = [
  /prompt (?:is )?too long/i, // Anthropic-style, Ollama ("prompt too long; exceeded max context length...")
  /exceeds the context window/i, // OpenAI
  /maximum context length/i, // vLLM, OpenRouter, LiteLLM and other OpenAI-compatible proxies
  /is longer than the model'?s context length/i, // Together, newer vLLM wording
  /exceeds the available context size/i, // llama.cpp server
  /greater than the context length/i, // LM Studio
  /context_length_exceeded/i, // OpenAI-style structured code carried in the body
];

/**
 * True when an api-type LlmError is a backend rejecting the request for
 * context overflow (as opposed to a transient failure). Detection drives both
 * "never retry" in the retry layer and the compaction extension's one-shot
 * compact-and-retry on provider:error. Non-LlmError values are never
 * classified (callers classify raw errors first, like shouldRetryLlmError).
 */
export function isContextOverflowError(e: unknown): boolean {
  if (!(e instanceof LlmError)) return false;
  if (e.type !== "api") return false;
  return CONTEXT_OVERFLOW_PATTERNS.some((p) => p.test(e.message));
}

/**
 * Decide whether a failed attempt should be retried. `attempt` is the
 * 1-based index of the attempt that just failed; maxRetries counts retries
 * AFTER the initial attempt, so the final attempt (1 + maxRetries) is never
 * retried. Cancellation is never retried. Non-LlmError failures are never
 * retried here -- callers are expected to classify raw errors into LlmError
 * first (LlmClient does this for fetch and stream-body failures).
 */
export function shouldRetryLlmError(e: unknown, attempt: number, maxRetries: number): boolean {
  if (LlmError.isCancelled(e)) return false;
  // Context overflow never heals on its own; re-issuing the same oversized
  // request just burns attempts. The provider:error pipeline (compaction
  // rescue) is the way out.
  if (isContextOverflowError(e)) return false;
  if (attempt >= 1 + Math.max(0, maxRetries)) return false;

  if (e instanceof LlmError) {
    // Exhausted quota can carry a 429 but is NOT transient; check before the status-based retry to avoid burning retries.
    if (e.quotaExhausted) return false;
    if (e.type === "http" || e.type === "timeout") {
      // Network errors and timeouts are always transient
      return true;
    }
    if (e.type === "api") {
      // Prefer the structured status; fall back to the message for
      // errors constructed without it.
      const status = e.status ?? extractHttpStatus(e.message);
      if (status !== null && isRetryableHttpStatus(status)) {
        return true;
      }
    }
  }
  // Other API errors (e.g., "Bad input") are non-transient — don't retry
  return false;
}

/**
 * Ceiling on a server-provided Retry-After delay. A broken or hostile
 * endpoint could ask for hours; the agent loop must not hang on it.
 */
export const MAX_RETRY_AFTER_MS = 60_000;

/**
 * Parse a Retry-After header value into milliseconds (RFC 9110 allows both
 * delta-seconds and HTTP-date forms). Returns null when the value is absent
 * or unparseable; clamps to [0, MAX_RETRY_AFTER_MS].
 */
export function parseRetryAfterMs(value: string | null | undefined): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d+$/.test(trimmed)) {
    return Math.min(parseInt(trimmed, 10) * 1000, MAX_RETRY_AFTER_MS);
  }
  // JS Date.parse accepts junk numeric forms ("12.5", "-5") as obscure
  // legacy dates; anything that looks like a (possibly malformed) number is
  // not a valid delta-seconds or HTTP-date value -- reject it outright.
  if (/^[+-]?[\d.]+$/.test(trimmed)) return null;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.min(Math.max(0, date - Date.now()), MAX_RETRY_AFTER_MS);
}

/**
 * Delay before the next retry: the server's Retry-After hint when the error
 * carries one, otherwise the caller's exponential backoff value.
 */
export function resolveRetryDelayMs(e: unknown, fallbackMs: number): number {
  if (e instanceof LlmError && e.retryAfterMs != null) return e.retryAfterMs;
  return fallbackMs;
}

/**
 * Wait `delayMs` before the next retry, resolving early if the signal
 * aborts so a user cancellation during the wait is noticed immediately
 * (the caller re-checks the signal). The listener is removed whichever way
 * the wait ends, so repeated retries don't accumulate listeners on the
 * long-lived shared signal. A signal already aborted at call time resolves
 * immediately -- a past "abort" never re-fires the listener.
 */
export function retryDelay(delayMs: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, delayMs);
    signal?.addEventListener("abort", done);
  });
}
