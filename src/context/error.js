// Centralized error handling utilities.
//
// Distinguishes expected errors (cancellations, API failures) from
// unexpected errors (bugs, iteration errors, null derefs) so that
// the latter always include a stack trace and context.

/**
 * Expected error types that should NOT include a stack trace.
 * These are user-facing or operational errors where the message is sufficient.
 */
export const EXPECTED_ERROR_TYPES = new Set([
  "cancelled",
  "http",
  "api",
  "timeout",
  "invalid_response",
]);

/**
 * Check if an error is expected (operational) vs unexpected (bug).
 */
export function isExpectedError(err) {
  if (!(err instanceof Error)) return false;
  const type = err.type || "";
  if (EXPECTED_ERROR_TYPES.has(type)) return true;

  // LlmError.Cancelled instances
  if (err.message?.includes("cancelled")) return true;

  return false;
}

/**
 * Format an error for user display.
 * Expected errors: message only.
 * Unexpected errors: message + stack for debugging.
 */
export function formatError(err) {
  if (err == null) {
    return String(err);
  }
  if (!(err instanceof Error)) {
    return String(err);
  }
  if (!isExpectedError(err)) {
    return `${err.message}\n${err.stack || "(no stack)"}`;
  }
  return err.message || String(err);
}

/**
 * Wrap an operation with context and centralized error handling.
 * Logs unexpected errors with full stack; expected errors get message only.
 *
 * Usage:
 *   await withContext("building agent", async () => {
 *     return await builder.buildAgent(sink);
 *   });
 */
export async function withContext(label, fn) {
  try {
    return await fn();
  } catch (err) {
    if (isExpectedError(err)) {
      throw err; // Let callers handle expected errors
    }
    const wrapped = new Error(`[${label}] ${err.message}`);
    wrapped.stack = `${wrapped.message}\n${err.stack || "(no stack)"}`;
    throw wrapped;
  }
}
