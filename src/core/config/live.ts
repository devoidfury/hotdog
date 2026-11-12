/**
 * live.ts -- the notify seam above the store atom (design §1.3-§1.6, batch B2).
 *
 * The store owns ONE reactiveState atom over ConfigGenerations and fires it
 * blind on every commit: no keyPath granularity, no old/new values. This
 * file does NOT extend reactive-state.ts (it stays byte-identical; the
 * first-throw-stop relied on below is pinned in
 * tests/utils/reactive-state.test.ts) and does NOT build a second emitter.
 * keyPath granularity rides above the atom as a subscriber helper, and the
 * missing old/new values are reconstructed there honestly.
 *
 * Why one store atom + helper, not per-top-level-block atoms (§1.3):
 * per-block atoms would split ownership across N atoms with no single
 * "current process config" value to read, require inventing atoms
 * dynamically when extension blocks appear, force multi-dep effect
 * bookkeeping per subscriber to observe cross-block changes, and buy
 * nothing at our scale (subscriber count is in the tens, every pass runs
 * inside the edit lock on a user write). The honest cost of the chosen
 * shape -- every publish wakes every subscriber, most exit on the filter --
 * is trivial and documented here; it keeps the store, the atom, and the
 * batch in one place.
 */
import { getNested } from "@utils/objects.ts";
import { logger } from "@utils/logger.ts";
import { formatError } from "@core/error.ts";
import type { ConfigGeneration, ConfigStore } from "./store.ts";

export interface ConfigChange {
  keyPath: string;
  /** Current value at keyPath (post-swap read). */
  value: unknown;
  /** The value THIS subscriber last observed. Because every publish flows
   *  through the serialized transaction (§2.4) and every wake passes the
   *  filter test, "last observed" IS the previous generation's value -- the
   *  old value is reconstructed per subscriber, not handed by the atom. */
  previous: unknown;
  /** Generation batchId (monotonic publish stamp). */
  batchId: number;
}

/**
 * Value at keyPath in a generation: getNested against the config bag first
 * (the primary consumer surface, §1.2), falling back to the resolved bag --
 * `changed` spans both bags in one prefix namespace (store.ts diffChanged),
 * so a subscription must be able to answer resolved-only keys ("baseUrl"
 * style) through the same seam. A bare keyPath reads the top-level block.
 */
function valueAt(gen: ConfigGeneration, keyPath: string): unknown {
  const v = getNested(gen.config, keyPath);
  return v === undefined ? getNested(gen.resolved, keyPath) : v;
}

/** Canonical JSON for the real-change test. Technique CHOSEN: the identical
 *  key-sorted canon store.swap's changed-diff uses (copied here because
 *  store.ts keeps it private; keeping the two seams in lockstep matters
 *  more than deduping ten lines). The other house precedent,
 *  utils/json-schema.ts:30's stringify equality, is insertion-order
 *  dependent -- a re-resolve rebuild that merely reorders keys would fire
 *  subscribers the swap diff had correctly excluded. */
function canon(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? "\u0000"; // stringify(undefined) -> undefined (unset vs unset reads equal)
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = sortKeys(src[key]);
    return out;
  }
  return value;
}

/** The real-change test: reference compare first; when both sides are
 *  non-null objects with differing refs (a re-resolve rebuild), canonical
 *  JSON decides. An unparsable pair (cyclic) counts as CHANGED -- over-
 *  firing a subscriber is honest, silently dropping its notification is
 *  not. */
function reallyChanged(previous: unknown, value: unknown): boolean {
  if (previous === value) return false;
  if (
    previous === null ||
    value === null ||
    typeof previous !== "object" ||
    typeof value !== "object"
  ) {
    return true;
  }
  try {
    return canon(previous) !== canon(value);
  } catch {
    return true;
  }
}

/**
 * keyPath-filtered subscription over the store atom AS IT IS.
 * keyPath examples: "websocket.sessionTimeoutMin", "compaction", "providers".
 *
 * - Wakes on every publish (atoms fire blind); exits fast when keyPath's
 *   top-level root (the first segment before any dot) is not in
 *   generation.changed.
 * - Runs fn only when the value AT keyPath actually changed: reference
 *   compare, then canonical JSON compare when both sides are objects and
 *   the refs differ (re-resolve rebuilds every subtree, so ref-inequality
 *   alone would fire everyone on every write).
 * - `previous` is this subscription's own last observation (§1.4), seeded
 *   at subscribe time with the CURRENT value at keyPath: a subscription
 *   created mid-life never claims a value it never observed. A delivered
 *   value becomes the observation even when fn throws -- delivery happened;
 *   rewinding would make the next wake's chain lie.
 * - ERROR ISOLATION: reactiveState stops notifying at the first throwing
 *   effect (pinned: reactive-state.test.ts "stops at first throwing
 *   effect"). A config subscriber must never starve its peers, so fn is
 *   wrapped: catch -> logger.error(formatError(...)) -> continue.
 * - A subscriber must not AWAIT a write inside the notify pass: the edit
 *   mutex is non-reentrant and held across the whole transaction, so an
 *   awaited `applyConfigKeyEdit`/publish deadlocks. An un-awaited
 *   (fire-and-forget) call simply queues on the FIFO tail and runs after
 *   the transaction -- that IS the honest deferral; build no extra queue
 *   machinery for it.
 * - Set-iteration consequences (§1.6), stated rather than fought: a
 *   subscriber ADDED during a notify pass runs in the same pass -- safe by
 *   construction because subscribers read state at callback time, so it
 *   just observes the new value twice and the change test no-ops the extra
 *   wake (idempotent); a subscriber REMOVED during the pass gets no further
 *   calls in that pass.
 * - The returned unsubscribe wraps the atom's stop and is idempotent.
 */
export function onConfigChange(
  store: ConfigStore,
  keyPath: string, // "websocket.sessionTimeoutMin", "compaction", "providers"
  fn: (change: ConfigChange) => void,
): () => void {
  // Throws honestly on a pre-adopt store: subscribing before the boot
  // pipeline adopted the config bag is a boot-order bug, and current()'s
  // error names it.
  let last: unknown = valueAt(store.current(), keyPath);
  const root = keyPath.split(".")[0]!;

  const wrapped = (): void => {
    const gen = store.current();
    if (!gen.changed.includes(root)) return; // fast exit: root untouched this publish
    const value = valueAt(gen, keyPath);
    if (!reallyChanged(last, value)) return; // rebuild, not a change
    const previous = last;
    try {
      fn({ keyPath, value, previous, batchId: gen.batchId });
    } catch (e) {
      logger.error(
        `[config-live] onConfigChange("${keyPath}") subscriber threw: ${formatError(e)}`,
      );
    }
    last = value; // delivered = observed, even through a throw (§1.4)
  };

  const stop = store.generation.effect(wrapped);
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    stop();
  };
}
