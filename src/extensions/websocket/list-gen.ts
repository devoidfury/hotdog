// LIST gen: the LOGS_LISTED membership watermark. `<bootToken>-<counter>`:
// the boot token makes a server restart a mismatch no matter what the
// counter reads; the counter advances once per membership transition the
// server observes (row add/remove -- NOT pins, which ride their own logPins
// frame, and NOT the worker exclusion: a build-time filter, never a bump --
// a worker log is never client-held, so its reclaim moves nothing). Every
// LOGS_LISTED frame (full and delta) and every targeted membership push
// (logRowAdded/logRowRemoved, and the pre-existing logDeleted) stamps the
// watermark; a client applies the frames that continue its held gen at +0 (a
// plain reply) or +1 (the frame IS the transition) and re-attests with a full
// frame on anything else.
// Bumps with no frame are deliberate, not oversights: change points whose
// row payload has no cheap build site (idle-sweep demotions, destructive
// Delete's possible demote, a promote whose attach failed) advance the
// watermark silently so every tab's next LOGS_LISTED mismatch re-attests
// full -- correctness insurance without inventing push hooks.

const BOOT_TOKEN = Math.random().toString(36).slice(2, 10);

let membership = 0;

/** The current watermark (a frame that announces no transition: a reply). */
export function listGen(): string {
  return `${BOOT_TOKEN}-${membership}`;
}

/** Advance the watermark by one membership transition and return the new
 *  stamp -- the caller puts it on the frame announcing that transition, so
 *  the client can check the frame continues its held gen at exactly +1. */
export function bumpListMembership(): string {
  membership += 1;
  return `${BOOT_TOKEN}-${membership}`;
}
