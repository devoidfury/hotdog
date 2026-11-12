/**
 * Hook-status honesty (design §4.5 item 3): every registered apply hook must
 * appear in at least one liveness probe, so a registry entry that "succeeds"
 * while its consumer moved on fails CI.
 *
 * The snapshot is a TEST-ONLY boot (bootLive: the same live host the B4
 * liveness suite drives) -- the hook table is process-global and registration
 * is per create(), so the registered set after boot is exactly the §3.3 table
 * this host ships, and the rows' `hooks` field (default [keyPath]) is the
 * coverage claim under audit. Alias honesty lives on the rows: the file
 * spelling `aiUrl` names the RESOLVED root `baseUrl` the hook registered
 * under, not the writable member.
 *
 * One direction on purpose: registered -> covered. Per-use keys (maxRetries,
 * modelRoleMapping, the whole FAMILY_PROBES half) are probes WITHOUT a hook --
 * that is their live class, not a gap.
 *
 * Mutation proof: unregister/drop any hook row and this file goes red.
 */
import { describe, it, expect, afterAll } from "bun:test";
import { registeredHooks } from "@core/config/apply-hooks.ts";
import { PROBES, bootLive, type LiveEnv } from "./probes.ts";

const env: LiveEnv = await bootLive();
afterAll(() => env.cleanup());

describe("config-live hook-status honesty (§4.5-3)", () => {
  it("every registered apply hook is covered by a liveness probe row", () => {
    const covered = new Set<string>();
    for (const row of PROBES) {
      for (const h of row.hooks ?? [row.keyPath]) covered.add(h);
    }
    const hooks = registeredHooks();
    // The boot must actually have registered the §3.3 table -- an empty
    // snapshot would make the walk vacuously green.
    expect(hooks.length).toBeGreaterThan(0);
    const uncovered: string[] = [];
    for (const h of hooks) {
      // "" = the every-publish hook: covered only by a row that says so.
      if (!covered.has(h.keyPath)) uncovered.push(`${h.keyPath || "<all>"} (${h.phase})`);
    }
    expect(uncovered).toEqual([]);
  });
});
