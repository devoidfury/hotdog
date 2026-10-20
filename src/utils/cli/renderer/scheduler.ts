// FrameScheduler (design note §3, pi's shape): a renderRequested flag, next-
// tick coalescing, MIN_RENDER_INTERVAL_MS between paints, and input that
// bypasses the throttle -- a keystroke paints immediately and cancels the
// pending timer first, so typing never waits behind a streaming frame.
// Stream chunks only mutate frame text and set the flag; per-chunk painting
// is how token floods freeze UIs (pitfall 4).

import type { Clock } from "./seams.ts";

export const MIN_RENDER_INTERVAL_MS = 16;

export class FrameScheduler {
  private renderRequested = false;
  private immediateHandle: unknown = null;
  private timerHandle: unknown = null;
  private lastPaintAt = Number.NEGATIVE_INFINITY;
  private stopped = false;

  constructor(
    private readonly clock: Clock,
    private readonly paint: () => void,
  ) {}

  /** Coalesced paint request: many calls, one repaint per burst (§3/steal 7). */
  requestRender(): void {
    if (this.stopped) return;
    this.renderRequested = true;
    if (this.immediateHandle !== null || this.timerHandle !== null) return;
    this.immediateHandle = this.clock.setImmediate(() => {
      this.immediateHandle = null;
      this.tick();
    });
  }

  /**
   * Immediate paint bypassing the throttle (input path and resize). The
   * pending timer is cancelled FIRST (pi :1009-1010): a stale deferred paint
   * after an instant one would double-paint the same state.
   */
  paintNow(): void {
    this.cancelPending();
    if (this.stopped) return;
    this.renderRequested = false;
    this.lastPaintAt = this.clock.now();
    this.paint();
  }

  /** §10 step 1: no frame timers survive teardown; further requests are dead. */
  stop(): void {
    this.stopped = true;
    this.cancelPending();
    this.renderRequested = false;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  get pending(): boolean {
    return this.renderRequested || this.immediateHandle !== null || this.timerHandle !== null;
  }

  private tick(): void {
    if (this.stopped) return;
    const since = this.clock.now() - this.lastPaintAt;
    if (since < MIN_RENDER_INTERVAL_MS) {
      this.timerHandle = this.clock.setTimeout(() => {
        this.timerHandle = null;
        this.paintNow();
      }, MIN_RENDER_INTERVAL_MS - since);
      return;
    }
    this.paintNow();
  }

  private cancelPending(): void {
    if (this.immediateHandle !== null) {
      this.clock.clearImmediate(this.immediateHandle);
      this.immediateHandle = null;
    }
    if (this.timerHandle !== null) {
      this.clock.clearTimeout(this.timerHandle);
      this.timerHandle = null;
    }
  }
}
