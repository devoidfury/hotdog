// Retry with backoff utility.

import { ConfigError, LlmError } from "../error.ts";

/**
 * Extract the HTTP status code from an LlmError message.
 * The message format is "HTTP <status> (body: ...)".
 *
 * @param message - The error message.
 * @returns The status code, or null if not parseable.
 */
export function extractHttpStatus(message: string): number | null {
  const match = message.match(/^HTTP (\d+)/);
  return match ? parseInt(match[1] ?? "", 10) : null;
}

/**
 * Determine whether an HTTP status code is retryable.
 * Retry on 5xx (server errors) and 429 (rate limiting).
 * Do NOT retry on 4xx (client errors) except 429, or on 3xx (redirects):
 * a redirect of the same request will repeat identically on every attempt,
 * so retrying only wastes attempts and hides a misconfigured endpoint.
 *
 * @param status - HTTP status code.
 * @returns Whether the status code is retryable.
 */
export function isRetryableHttpStatus(status: number): boolean {
  // 5xx are server errors — retry
  if (status >= 500 && status < 600) return true;
  // 429 is rate limiting — retry (client error but transient)
  if (status === 429) return true;
  // 3xx redirects and 4xx client errors — do NOT retry
  return false;
}

export interface RetryOptions {
  signal?: AbortSignal | null;
  /** Base delay in ms before first retry (default: 1000). Useful for fast tests. */
  baseDelayMs?: number;
}

/**
 * Retry an async operation with exponential backoff and cancellation support.
 *
 * @param fn - Async function to retry.
 * @param maxRetries - Maximum number of retry attempts.
 * @param options - Optional configuration.
 * @returns The result of the async function.
 */
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
    // Check cancellation before each attempt
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

      // Only retry on transient errors
      let shouldRetry = false;

      if (e instanceof LlmError) {
        if (e.type === "http" || e.type === "timeout") {
          // Network errors and timeouts are always transient
          shouldRetry = true;
        } else if (e.type === "api" && e.message.startsWith("HTTP ")) {
          // HTTP response errors — check the status code
          const status = extractHttpStatus(e.message);
          if (status !== null && isRetryableHttpStatus(status)) {
            shouldRetry = true;
          }
          // Non-retryable status codes (3xx redirects, 4xx, etc.) fall
          // through to throw
        }
        // Other Api errors (e.g., "Bad input") are non-transient — don't retry
      }

      if (shouldRetry && attempt < maxRetries) {
        // Check cancellation during delay
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
