/** Duck-type check for thenable / promise-like values. */
export function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
