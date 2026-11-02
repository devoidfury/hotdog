/**
 * Wait `ms`, resolving early if `signal` aborts so a cancellation during the
 * wait is noticed immediately (the caller re-checks the signal). The listener
 * is removed whichever way the wait ends, so repeated retries don't
 * accumulate listeners on a long-lived shared signal. A signal already
 * aborted at call time resolves immediately -- a past "abort" never
 * re-fires the listener. Deliberately NOT unref'd: a run blocked on a wait
 * must keep the process alive.
 */
export function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
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
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done);
  });
}

/** Duck-type check for thenable / promise-like values. */
export function isPromise(value: unknown): value is Promise<unknown> {
  return (
    value !== null &&
    value !== undefined &&
    typeof (value as { then?: unknown }).then === "function"
  );
}
