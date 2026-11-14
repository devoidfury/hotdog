// Shared fence-SEAM pin (extracted verbatim from the per-session `/fence`
// toggle suite so the webui-toggle loop-close fixture reuses the SAME
// observation machinery rather than a copy): a memoizing planner with a UNIQUE
// env value per planner instance and a per-tuple plan id -- the entry's spawn
// either carries this generation's FENCE_GEN or nothing, and every
// (session, class, roots) tuple gets its own id (`gen<n>#<k>`) -- so a memo
// entry that was supposed to survive is provable byte-wise (a blown memo
// replans under a new id, which the pool entry then visibly replaces) and a
// resurrected old prefix is observable. `dropSession` mirrors the built-in
// planner's per-session memo invalidation.

import type { FencePlanner } from "../../src/core/tool-exec-broker.ts";
import type { WireFence } from "../../src/core/tool-exec-protocol.ts";
// The seam fence wraps whatever the layout names as RUNNER_ENTRY, so it
// tracks the plane's real entry without hardcoding a file.
import { RUNNER_ENTRY } from "../../src/core/tool-exec-layout.ts";

export function recordingPlanner(gen: number): { plan: FencePlanner; calls: () => number } {
  const memo = new Map<string, WireFence>();
  let calls = 0;
  let planned = 0;
  const plan: FencePlanner = (session, cls, roots) => {
    calls++;
    const key = `${session}\u0000${cls}\u0000${roots.join("\u0000")}`;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    const fence: WireFence = {
      id: `gen${gen}#${++planned}`,
      prefix: ["env", `FAKE_FENCE_GEN=${gen}`, process.execPath, RUNNER_ENTRY],
    };
    memo.set(key, fence);
    return fence;
  };
  plan.dropSession = (session: string) => {
    const prefix = `${session}\u0000`;
    for (const key of memo.keys()) {
      if (key.startsWith(prefix)) memo.delete(key);
    }
  };
  return { plan, calls: () => calls };
}
