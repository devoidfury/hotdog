import { describe, it, expect, afterAll, spyOn } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExclusive } from "@utils/fs-atomic.ts";
import { logger } from "@utils/logger.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "fsatomic-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

describe("createExclusive", () => {
  it("creates the file with full contents and leaves no temp litter", async () => {
    const dir = freshDir();
    const path = join(dir, "claim");
    expect(await createExclusive(path, "payload")).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("payload");
    // The hidden `.name.new-*` sibling is always cleaned up.
    expect(readdirSync(dir)).toEqual(["claim"]);
  });

  it("returns false when the path already exists, never touching contents", async () => {
    const dir = freshDir();
    const path = join(dir, "claim");
    writeFileSync(path, "original");
    expect(await createExclusive(path, "hijack")).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("original");
    expect(readdirSync(dir)).toEqual(["claim"]);
  });

  it("concurrent creators elect exactly one winner (existence + contents are atomic)", async () => {
    for (let round = 0; round < 25; round++) {
      const dir = freshDir();
      const path = join(dir, "claim");
      const results = await Promise.all(
        [1, 2, 3, 4, 5].map((n) => createExclusive(path, `writer-${n}`)),
      );
      expect(results.filter((r) => r === true)).toHaveLength(1);
      // The loser never saw a half-written file: contents always belong to
      // exactly one writer, whole.
      expect(readFileSync(path, "utf8")).toMatch(/^writer-[1-5]$/);
      expect(readdirSync(dir)).toEqual(["claim"]);
    }
  });

  it("propagates non-EEXIST fs failures and creates nothing", async () => {
    const missing = join(freshDir(), "no-such-dir", "claim");
    await expect(createExclusive(missing, "x")).rejects.toThrow();
    expect(existsSync(join(missing, "..", "claim"))).toBe(false);
  });
});

/**
 * Regression for the 2026-09-27 live incident: something outside the
 * protocol deleted the `.new-*` temp sibling (litter sweep) or the parent
 * directory (operator error / remount) between the temp write and the
 * link(2), so link failed ENOENT and the caller lost a lane slot to the
 * fail-open path. createExclusive must classify what vanished, repair it,
 * and retry once -- without weakening link(2) exclusivity.
 */
describe("createExclusive vs external deletion", () => {
  /** Foreign "litter sweep": unlinks the first `.new-*` sibling it sees, once. */
  const unlinkTempOnce = async (dir: string, maxPolls = 500): Promise<void> => {
    for (let i = 0; i < maxPolls; i++) {
      let litter: string[];
      try {
        litter = (await readdir(dir)).filter((f) => f.includes(".new-"));
      } catch {
        return; // dir vanished underneath the sweeper; nothing left to sweep
      }
      const [victim] = litter;
      if (victim !== undefined) {
        await rm(join(dir, victim), { force: true });
        return;
      }
      await Bun.sleep(0);
    }
  };

  /** Foreign "cleaner": recursively removes the dir once it sees content. */
  const removeDirOnce = async (dir: string, maxPolls = 500): Promise<void> => {
    for (let i = 0; i < maxPolls; i++) {
      try {
        if ((await readdir(dir)).length > 0) {
          await rm(dir, { recursive: true, force: true });
          return;
        }
      } catch {
        return;
      }
      await Bun.sleep(0);
    }
  };

  const rounds = 60;
  const creators = 4;

  // The poll-based strikes above only sometimes land between the temp write
  // and the link -- under `bun run coverage` the timing shifts can starve the
  // repair path completely (the rounds then pass vacuously). These two
  // deterministic-strike rounds hold writeFile long enough (multi-MB) that
  // the sweeper is guaranteed to see the temp sibling mid-create, so the
  // classify/repair/retry path and its warn always execute at least once per
  // suite -- for the coverage threshold AND as a sharp regression pin.
  it("deterministic strike: a mid-write unlink of the temp sibling repairs to a full create", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const payload = "p".repeat(4 * 1024 * 1024);
      let repaired = false;
      for (let attempt = 0; attempt < 10 && !repaired; attempt++) {
        warnSpy.mockClear();
        const dir = freshDir();
        const path = join(dir, "claim");
        const sweeper = unlinkTempOnce(dir);
        const result = await createExclusive(path, payload);
        await sweeper;
        repaired = warnSpy.mock.calls.some((c) => String(c[0]).includes("repair"));
        expect(result).toBe(true);
      }
      expect(repaired).toBe(true);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("temp sibling unlinked"))).toBe(true);
      expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("repaired, created"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("deterministic strike: a mid-write rmdir of the parent repairs via mkdir -p and rewrites", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const payload = "d".repeat(4 * 1024 * 1024);
      let repaired = false;
      for (let attempt = 0; attempt < 10 && !repaired; attempt++) {
        warnSpy.mockClear();
        const dir = freshDir();
        const path = join(dir, "claim");
        const sweeper = removeDirOnce(dir);
        const result = await createExclusive(path, payload).catch((e: unknown) => e);
        await sweeper;
        repaired = warnSpy.mock.calls.some((c) => String(c[0]).includes("repair"));
        // Same tolerance as the rounds below: rm -rf's rmdir can land after
        // the repair's mkdir and consume the single documented repair. Either
        // way the strike fired and classify/repair/retry executed.
        if (result === true) {
          if (existsSync(path)) expect(readFileSync(path, "utf8")).toBe(payload);
        } else {
          expectRepairConsumedBySecondStrike(result, warnSpy);
        }
      }
      expect(repaired).toBe(true);
      // The strike hit the dir path: rmdir usually takes temp and parent
      // together ("parent dir vanished"), but a link landing between rm's
      // unlink and its rmdir classifies as "temp sibling unlinked" while
      // still exercising the mkdir -p repair. Either is the honest verdict.
      expect(
        warnSpy.mock.calls.some(
          (c) => String(c[0]).includes("parent dir vanished") || String(c[0]).includes("temp sibling unlinked"),
        ),
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  /**
   * Tolerated residual race: one strike can consume the single documented
   * repair. `rm -rf` is readdir + unlink + rmdir on the PATH, so its rmdir can
   * land after the repair's mkdir re-created the dir (or one unlink lands on
   * the repair's rewritten temp); the retry link then fails ENOENT again and
   * createExclusive throws, by design -- retrying forever against a hostile
   * deleter is not the protocol. The repair path always logs "repair failed"
   * before throwing, so requiring that warn keeps the assertion sharp: a
   * regressed implementation that never repairs surfaces a silent ENOENT here.
   */
  const expectRepairConsumedBySecondStrike = (
    result: unknown,
    warnSpy: { mock: { calls: unknown[][] } },
  ): void => {
    expect((result as { code?: string }).code).toBe("ENOENT");
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes("repair failed"))).toBe(true);
  };

  it("survives a foreign unlink of the temp sibling mid-create", async () => {
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (let round = 0; round < rounds; round++) {
        warnSpy.mockClear();
        const dir = freshDir();
        const sweeper = unlinkTempOnce(dir);
        const results = await Promise.all([
          ...Array.from({ length: creators }, (_, n) =>
            createExclusive(join(dir, `claim-${n}`), `payload-${n}`).catch((e: unknown) => e),
          ),
          sweeper,
        ]);
        for (let n = 0; n < creators; n++) {
          // Pre-fix, a sweep landing between write and link surfaced ENOENT here.
          if (results[n] === true) {
            expect(readFileSync(join(dir, `claim-${n}`), "utf8")).toBe(`payload-${n}`);
          } else {
            expectRepairConsumedBySecondStrike(results[n], warnSpy);
          }
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("survives a foreign rmdir of the parent mid-create", async () => {
    // One creator per round: the sweeper only fires once the temp sibling is
    // visible, so the write itself has landed and the anomaly can only strike
    // at the link -- the exact production signature. A sweep that lands AFTER
    // a successful create merely removes the finished claim (external damage
    // no protocol can prevent), so existence is asserted only when it stands.
    const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      for (let round = 0; round < rounds * 2; round++) {
        warnSpy.mockClear();
        const dir = freshDir();
        const path = join(dir, "claim");
        const sweeper = removeDirOnce(dir);
        const result = await createExclusive(path, "payload").catch((e: unknown) => e);
        await sweeper;
        // Pre-fix, a sweep landing between write and link surfaced ENOENT here.
        if (result === true) {
          if (existsSync(path)) expect(readFileSync(path, "utf8")).toBe("payload");
        } else {
          expectRepairConsumedBySecondStrike(result, warnSpy);
        }
      }
    } finally {
      warnSpy.mockRestore();
    }
  });
});
