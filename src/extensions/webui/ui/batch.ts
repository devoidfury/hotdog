// Batching for high-frequency invalidations (streaming chunks, activity
// deltas): however many arrive between frames, at most one flush runs.

export type Scheduler = (fn: () => void) => void;

/** Collapse repeated calls into one flush per scheduled animation frame. */
export function createCoalescer(
  flush: () => void,
  schedule: Scheduler = (fn) => requestAnimationFrame(fn),
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
