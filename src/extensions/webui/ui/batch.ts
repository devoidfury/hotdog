// Batching for high-frequency invalidations (streaming chunks, activity
// deltas): however many arrive between frames, at most one flush runs.

export type Scheduler = (fn: () => void) => void;

/** Collapse repeated calls into one flush per scheduled animation frame. */
export function createCoalescer(
  flush: () => void,
  // typeof-guard: browsers always have rAF; non-browser hosts (bun tests,
  // stray leaked effects) degrade to a ~frame timer instead of a
  // ReferenceError. Explicit-scheduler callers always win over this default.
  schedule: Scheduler = (fn) =>
    typeof requestAnimationFrame === "function" ? requestAnimationFrame(fn) : setTimeout(fn, 16),
): () => void {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    schedule(() => {
      queued = false;
      flush();
    });
  };
}
