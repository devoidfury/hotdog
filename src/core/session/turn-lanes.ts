/**
 * Provider-lane gating for top-level session turns
 *
 * An active top-level session turn (interactive or one-shot) occupies exactly
 * ONE slot on the lane of its resolved model, in the same machine-wide slot
 * ledger task agents use (LaneLedger): the same `taskLanesPerProvider` /
 * per-provider `taskLanes` caps and the same `taskLanesDir` apply; there are
 * no extra knobs. Idle time at the prompt holds nothing, so each queued
 * message acquires when its turn starts and releases when `agent.run()`
 * settles (mirrors the parked-task idle-release semantics). A mid-turn wait
 * (the question tool awaiting a user answer) DOES hold the slot: the turn is
 * still live, and releasing would let another model swap in and thrash the
 * cache the user is about to return to.
 *
 * The lane is resolved from the agent's current model at ACQUIRE time, so a
 * `/model` or profile swap between turns naturally retargets the lane; if the
 * model changes mid-turn, the turn keeps holding the original slot until its
 * release.
 *
 * A full lane is not an error. acquireTurn parks, calls `onWaiting(lane)`
 * once (the bus renders a visible status event), and retries every
 * `lanesRetryMs`. Cancelling aborts the wait cleanly: a slot that lands
 * between the cancel and the acquire completing is released immediately
 * (mirrors TaskManager's #tryStart cancel handling).
 *
 * Ledger filesystem errors FAIL OPEN (the turn proceeds uncoordinated), like
 * TaskManager#acquireSlotSafe: an unusable state dir must never deadlock a
 * session.
 */

import { logger } from "@utils/logger.ts";
import { formatError } from "../error.ts";
import { LaneLedger, type LaneLease } from "./lane-ledger.ts";
import { laneKeyOf, makeLaneCaps } from "./model-resolver.ts";

/** Default interval between full-lane retry attempts (shared with TaskManager). */
export const DEFAULT_LANES_RETRY_MS = 2000;

export interface TurnLanesOptions {
  /** Cross-process ledger dir (resolved taskLanesDir); null/unset disables coordination. */
  lanesDir?: string | null;
  /** Fleet-wide cap (resolved taskLanesPerProvider); unset or < 1 = unlimited, which skips the ledger entirely. */
  lanesPerProvider?: number;
  /** Provider defs: a numeric `taskLanes` overrides the cap for that provider's lane. */
  providerDefs?: readonly { name: string; taskLanes?: unknown }[];
  /** Full-lane retry interval. */
  lanesRetryMs?: number;
}

export interface LaneWait {
  /** Aborting cancels the wait; acquireTurn then resolves null (and releases any slot that just landed). */
  signal: AbortSignal;
  /** Fired once per wait, with the lane name, when the lane turns out to be full. */
  onWaiting?: (lane: string) => void;
}

export interface TurnLanes {
  /**
   * Take one turn slot on `model`'s lane. Resolves with the release callback
   * once held (a no-op when coordination is off), or null when `wait.signal`
   * aborted before the slot was handed over.
   */
  acquireTurn(model: string, wait: LaneWait): Promise<(() => Promise<void>) | null>;
}

/**
 * Sleep that wakes early on abort. Deliberately NOT unref'd: a one-shot run
 * blocked on a lane must keep the process alive until its turn can run.
 */
function sleepOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

export function createTurnLanes(options: TurnLanesOptions): TurnLanes {
  const caps = makeLaneCaps(options.lanesPerProvider, options.providerDefs ?? []);
  const ledger = options.lanesDir ? new LaneLedger({ dir: options.lanesDir }) : null;
  const retryMs =
    typeof options.lanesRetryMs === "number" && options.lanesRetryMs >= 1
      ? options.lanesRetryMs
      : DEFAULT_LANES_RETRY_MS;
  const noopRelease = async (): Promise<void> => {};

  const releaseSafe = async (lease: LaneLease): Promise<void> => {
    try {
      await ledger!.release(lease);
    } catch (e: unknown) {
      logger.debug(`[lanes] session slot release failed: ${formatError(e)}`);
    }
  };

  return {
    async acquireTurn(model: string, wait: LaneWait): Promise<(() => Promise<void>) | null> {
      const lane = laneKeyOf(model);
      const cap = caps.capOf(lane);
      if (!ledger || !Number.isFinite(cap)) {
        logger.debug(
          `[lanes] turn on '${model}' uncoordinated (lane '${lane || "_"}' cap ${cap === Number.POSITIVE_INFINITY ? "unlimited" : cap}, ledger ${ledger ? "on" : "off"})`,
        );
        return noopRelease; // unlimited or no ledger: never touch the fs
      }
      logger.debug(`[lanes] turn acquiring lane '${lane || "_"}' (cap ${cap}) for '${model}'`);
      let announced = false;
      for (;;) {
        if (wait.signal.aborted) return null;
        let lease: LaneLease | null;
        try {
          lease = await ledger.acquire(lane, cap);
        } catch (e: unknown) {
          // Fail open: an unusable ledger must not deadlock the session.
          logger.debug(
            `[lanes] session slot acquire failed for '${lane}' (proceeding uncoordinated): ${formatError(e)}`,
          );
          return noopRelease;
        }
        if (lease) {
          if (wait.signal.aborted) {
            // Cancel landed while the acquire was in flight: hand the slot straight back.
            await releaseSafe(lease);
            return null;
          }
          logger.debug(`[lanes] turn holds lane '${lane || "_"}' slot=${lease.path}`);
          return async () => {
            logger.debug(`[lanes] turn releases lane '${lane || "_"}' slot=${lease.path}`);
            await releaseSafe(lease);
          };
        }
        if (!announced) {
          announced = true;
          logger.debug(`[lanes] turn parked: lane '${lane || "_"}' full (cap ${cap})`);
          wait.onWaiting?.(lane);
        }
        await sleepOrAbort(retryMs, wait.signal);
      }
    },
  };
}
