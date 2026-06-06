// Retry with backoff utility.

import { LlmError } from "./client.js";

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
      const shouldRetry =
        e instanceof LlmError &&
        (e.type === "http" ||
          e.type === "timeout" ||
          (e.type === "api" && e.message.startsWith("HTTP ")));

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
