// Probe self-test -- shape only, deliberately NOT leg values. On a macOS
// host with the Apple-SQLite WAL break (oven-sh/bun#45171 family) false IS
// the correct answer; pinning both-legs-true here would redden exactly the
// host the probe exists to let skip loudly. The legs' true-on-Linux
// behavior is pinned end-to-end by the suites this gates:
// session-durability and session-index-quarantine must show zero skips
// (and zero new skips vs today) wherever the probe runs.

import { describe, it, expect } from "bun:test";
import { walLifecycleProbe } from "../helpers.ts";

// All probe calls at module load: the legs spawn children (seconds), and
// bun's default 5s per-test budget has no business racing a cold sqlite
// spawn. The identity read must sit between the first call and the force,
// because force replaces the cached object (seatbelt precedent).
const probed = walLifecycleProbe();
const cachedAgain = walLifecycleProbe(); // cache path: zero new spawns
const forced = walLifecycleProbe(true); // re-run path

describe("walLifecycleProbe", () => {
  it("returns both legs as booleans and never throws", () => {
    expect(typeof probed.recovery).toBe("boolean");
    expect(typeof probed.cleanClose).toBe("boolean");
  });

  it("caches per process; force re-runs and agrees", () => {
    expect(cachedAgain).toBe(probed); // same cached object
    expect(forced.recovery).toBe(probed.recovery); // legs are deterministic per host
    expect(forced.cleanClose).toBe(probed.cleanClose);
    expect(walLifecycleProbe()).toBe(forced); // the force re-seeded the cache
  });
});
