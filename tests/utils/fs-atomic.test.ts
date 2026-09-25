import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createExclusive } from "@utils/fs-atomic.ts";

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
