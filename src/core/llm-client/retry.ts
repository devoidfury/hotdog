import { ConfigError, LlmError } from "../error.ts";

/** Parses the status out of LlmError messages formatted "HTTP <status> (body: ...)". */
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
  const { signal, baseDelayMs = 1000 } = options;

  if (maxRetries == null) {
    throw ConfigError.MissingConfig("maxRetries");
  }

  if (signal?.aborted) {
    throw LlmError.Cancelled("request was cancelled");
  }

  let delayMs = baseDelayMs;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
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
        } else if (e.type === "api" && e.message.startsWith("HTTP ")) {
          const status = extractHttpStatus(e.message);
          if (status !== null && isRetryableHttpStatus(status)) {
            shouldRetry = true;
          }
        }
        // Other API errors (e.g., "Bad input") are non-transient — don't retry
      }

      if (shouldRetry && attempt < maxRetries) {
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
        continue;
      }

      throw e;
    }
  }

  throw LlmError.Timeout(`Exhausted ${maxRetries} retries`);
}
