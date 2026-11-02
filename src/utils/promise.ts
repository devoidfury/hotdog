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

/** Sentinel `raceAbort` resolves with when a signal aborts before the work. */
export const ABORTED: unique symbol = Symbol("aborted");

/**
 * Await `work`, but resolve with ABORTED the moment any signal aborts -- for
 * prompts and waits that must not dangle on a cancelled run. Contract:
 * - an already-aborted signal resolves ABORTED immediately (a past "abort"
 *   never re-fires the listener, so the race would hang without the check);
 * - `work` runs in a microtask, so a synchronous throw and a rejection take
 *   the same path;
 * - work keeps running after an abort (collect-style inputs clean up on
 *   their own); a late rejection once ABORTED has won is swallowed, never an
 *   unhandled rejection;
 * - abort listeners are removed whichever way the race ends.
 */
export function raceAbort<T>(
  work: () => Promise<T> | T,
  signals: Array<AbortSignal | null | undefined>,
): Promise<Awaited<T> | typeof ABORTED> {
  const workPromise = Promise.resolve().then(work);
  let detach: () => void = () => {};
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    if (signals.some((s) => s?.aborted)) {
      resolve(ABORTED);
      return;
    }
    const cleanups: Array<() => void> = [];
    detach = () => {
      for (const c of cleanups) c();
    };
    for (const s of signals) {
      if (!s) continue;
      const onAbort = () => resolve(ABORTED);
      s.addEventListener("abort", onAbort, { once: true });
      cleanups.push(() => s.removeEventListener("abort", onAbort));
    }
  });
  return Promise.race([workPromise, aborted]).finally(detach);
}
