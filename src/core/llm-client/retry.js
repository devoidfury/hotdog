// Retry with backoff utility.

import { LlmError } from "../error.js";

/**
 * Extract the HTTP status code from an LlmError message.
 * The message format is "HTTP <status> (body: ...)".
 *
 * @param {string} message - The error message.
 * @returns {number|null} The status code, or null if not parseable.
 */
export function extractHttpStatus(message) {
  const match = message.match(/^HTTP (\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Determine whether an HTTP status code is retryable.
 * Retry on 5xx (server errors), 429 (rate limiting), and 3xx (redirects).
 * Do NOT retry on 4xx (client errors) except 429.
 *
 * @param {number} status - HTTP status code.
 * @returns {boolean}
 */
export function isRetryableHttpStatus(status) {
  // 5xx are server errors — retry
  if (status >= 500 && status < 600) return true;
  // 429 is rate limiting — retry (client error but transient)
  if (status === 429) return true;
  // 3xx are redirects — retry if we get them (unlikely but safe)
  if (status >= 300 && status < 400) return true;
  // 4xx (other than 429) are client errors — do NOT retry
  return false;
}

/**
 * Retry an async operation with linear backoff and cancellation support.
 *
 * @param {number} maxRetries - Maximum number of retry attempts.
 * @param {Function} fn - Async function to retry.
 * @param {object} [options] - Optional configuration.
 * @param {AbortSignal} [options.signal] - AbortSignal for cancellation.
 * @returns {Promise<T>} The result of the async function.
 */
export async function retryWithBackoff(fn, maxRetries = 12, options = {}) {
  const { signal } = options;

  if (signal?.aborted) {
    throw LlmError.Cancelled("request was cancelled");
  }

  let delaySecs = 1;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // Check cancellation before each attempt
    if (signal?.aborted) {
      throw LlmError.Cancelled("request was cancelled");
    }

    try {
      const result = await fn();
      return result;
    } catch (e) {
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
          // Non-retryable status codes (4xx, etc.) fall through to throw
        }
        // Other Api errors (e.g., "Bad input") are non-transient — don't retry
      }

      if (shouldRetry && attempt < maxRetries) {
        // Check cancellation during delay
        if (signal?.aborted) {
          throw LlmError.Cancelled("request was cancelled");
        }

        await new Promise((resolve) => {
          const timeout = setTimeout(resolve, delaySecs * 1000);
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

        delaySecs += 1;
        continue;
      }

      throw e;
    }
  }

  throw LlmError.Timeout(`Exhausted ${maxRetries} retries`);
}
