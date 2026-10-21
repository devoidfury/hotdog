import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectProvenance } from "../../evals/lib/provenance.ts";

function git(cwd: string, ...args: string[]): string {
  const res = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (res.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${res.stderr.toString()}`);
  return res.stdout.toString().trim();
}

describe("collectProvenance", () => {
  it("reports null for a non-repo directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-prov-"));
    try {
      expect(collectProvenance(dir)).toEqual({ rev: null, dirty: null });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("tracks rev and dirtiness: clean commit, edit, untracked file", () => {
    const dir = mkdtempSync(join(tmpdir(), "eval-prov-"));
    try {
      git(dir, "init", "-q", "-b", "main");
      // Repo without a first commit: rev-parse HEAD fails, honestly unknown.
      expect(collectProvenance(dir)).toEqual({ rev: null, dirty: null });

      writeFileSync(join(dir, "a.txt"), "one\n");
      git(dir, "add", "a.txt");
      git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "initial");
      const rev = git(dir, "rev-parse", "HEAD");
      expect(collectProvenance(dir)).toEqual({ rev, dirty: false });

      writeFileSync(join(dir, "a.txt"), "dirty edit\n");
      expect(collectProvenance(dir)).toEqual({ rev, dirty: true });

      writeFileSync(join(dir, "a.txt"), "one\n");
      expect(collectProvenance(dir).dirty).toBe(false);
      mkdirSync(join(dir, "sub"));
      writeFileSync(join(dir, "sub", "untracked.ts"), "export const x = 1;\n");
      expect(collectProvenance(dir).dirty).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
