/**
 * tests/core/config-live/family-probes.test.ts -- walk the family liveness
 * table (design §4.5 item 1) for every key the merge train migrated: B3's six
 * sites, B6a's core-tools + bash families, B6b's five families, and B7's
 * skills / prompts / agents-md / workflows sites.
 *
 * One test per row, one live host per test: boot through the shared store
 * harness, read the consumer's observable (it must answer the BOOT value --
 * the "prior use answers old" control), publish the next generation through
 * the store's real swap, read again (it must answer the published value).
 * A row that shows no movement is a stale copy, by construction; that is the
 * whole point of the table, and the reason it exists in CI rather than in a
 * batch note.
 *
 * The teardown runs even when an assertion fails: rows own temp dirs, a cwd
 * change and two env vars, and a leaking cwd would poison the rest of the
 * suite.
 */
import { describe, it, expect } from "bun:test";
import { FAMILY_PROBES, publishKey } from "./probes.ts";

describe("config-live family liveness (every migrated key, one probe each)", () => {
  for (const row of FAMILY_PROBES) {
    it(`${row.keyPath}: the next use answers the published value`, async () => {
      const ctx = await row.boot();
      try {
        // Control: before the publish the consumer still answers the boot
        // generation (a row whose control already moved proves nothing).
        expect(await row.observe(ctx)).toEqual(row.before);

        const pub = row.compute ? row.compute(ctx) : {};
        if (!row.compute) {
          if (row.value !== undefined) pub.value = row.value;
          if (row.resolvedPatch) pub.resolvedPatch = row.resolvedPatch;
        }
        publishKey(ctx.store, row.keyPath, pub);

        expect(await row.observe(ctx)).toEqual(row.expect);
      } finally {
        await row.teardown?.(ctx);
      }
    });
  }
});
