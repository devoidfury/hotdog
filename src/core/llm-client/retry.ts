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
 * Decide whether a failed attempt should be retried. `attempt` is the
 * 1-based index of the attempt that just failed; maxRetries counts retries
 * AFTER the initial attempt, so the final attempt (1 + maxRetries) is never
 * retried. Cancellation is never retried. Non-LlmError failures are never
 * retried here -- callers are expected to classify raw errors into LlmError
 * first (LlmClient does this for fetch and stream-body failures).
 */
export function shouldRetryLlmError(e: unknown, attempt: number, maxRetries: number): boolean {
  if (LlmError.isCancelled(e)) return false;
  if (attempt >= 1 + Math.max(0, maxRetries)) return false;

  if (e instanceof LlmError) {
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
