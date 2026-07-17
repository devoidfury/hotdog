// Promise utilities — helpers for working with thenable / promise-like values.

/**
 * Duck-type check for thenable / promise-like values.
 *
 * Used to detect whether a value needs to be awaited before further use.
 * Replaces the scattered `typeof x.then === "function"` Yoda checks.
 */
export function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
