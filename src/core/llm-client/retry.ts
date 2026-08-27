import { ConfigError, LlmError } from "../error.ts";

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

export interface RetryOptions {
  signal?: AbortSignal | null;
  /** Base delay in ms before first retry (default: 1000). Useful for fast tests. */
  baseDelayMs?: number;
}

export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number,
  options: RetryOptions = {},
): Promise<T> {
  const { signal, baseDelayMs } = options;

  if (maxRetries == null) {
    throw ConfigError.MissingConfig("maxRetries");
  }

  // maxRetries counts retries AFTER the initial attempt: total attempts =
  // 1 + maxRetries. 0 (or negative) clamps to a single attempt, no retries.
  const totalAttempts = 1 + Math.max(0, maxRetries);

  if (signal?.aborted) {
    throw LlmError.Cancelled("request was cancelled");
  }

  let delayMs = baseDelayMs ?? 1000;

  // Unbounded loop: every exit path is an explicit return/throw (a retry
  // falls through to the next iteration), so there is no code after it.
  for (let attempt = 1; ; attempt++) {
    if (signal?.aborted) {
      throw LlmError.Cancelled("request was cancelled");
    }

    try {
      const result = await fn();
      return result;
    } catch (e: unknown) {
      // If cancelled, don't retry - propagate immediately
      if (LlmError.isCancelled(e)) {
        throw e;
      }

      let shouldRetry = false;

      if (e instanceof LlmError) {
        if (e.type === "http" || e.type === "timeout") {
          // Network errors and timeouts are always transient
          shouldRetry = true;
        } else if (e.type === "api") {
          // Prefer the structured status; fall back to the message for
          // errors constructed without it.
          const status = e.status ?? extractHttpStatus(e.message);
          if (status !== null && isRetryableHttpStatus(status)) {
            shouldRetry = true;
          }
        }
        // Other API errors (e.g., "Bad input") are non-transient — don't retry
      }

      // Non-transient, or the final attempt was just used: propagate.
      if (!shouldRetry || attempt === totalAttempts) {
        throw e;
      }

      if (signal?.aborted) {
        throw LlmError.Cancelled("request was cancelled");
      }

      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, delayMs);
        if (signal) {
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timeout);
              resolve();
            },
            { once: true },
          );
        }
      });

      delayMs *= 2;
    }
  }
}
