// B3 unit tests for the 008-git-mess fixture (kielbasa-2): the pure parts of
// evals/tools/repo-check.sh. They prove gen-repo.ts builds a fixture on this
// machine with a stable STRUCTURAL signature (git hashes embed timestamps, so
// bytes cannot be stable), assert the fresh build's shape, and assert the
// shipped fixture still carries the mid-merge + rerere-trap + quarantine
// essentials. The full golden-resolution/check-suite end to end lives in
// evals/tools/repo-check.sh (dev tool, output recorded in the PR).
//
// No network, no model. Skips entirely when git is unavailable.
import { afterAll, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const HAVE_GIT = Bun.which("git") !== null;
const suite = HAVE_GIT ? describe : describe.skip;

const REPO = join(import.meta.dir, "..", "..");
const GEN = join(REPO, "evals", "tools", "gen-repo.ts");
const SHIPPED = join(REPO, "evals", "series", "kielbasa-2", "tasks", "fixture-gitrepo");

// Structural signature printed by gen-repo.ts; must match both fresh temp-tree
// builds below (same value b1-repo recorded as its cross-run evidence).
const EXPECTED_SIGNATURE = [
  "?? INTEGRATION-NOTES.md",
  "?? lib/parse.ts.fixture",
  "?? math.test.ts.fixture",
  "?? math.ts.fixture",
  "AA config.json",
  "UU compat.ts",
  "UU lib/parse.ts",
  "UU math.test.ts",
  "UU math.ts",
  "rr-cache: 5 ids, 1 postimages",
].join("\n");

const tmpRoots: string[] = [];
afterAll(() => {
  for (const root of tmpRoots) rmSync(root, { recursive: true, force: true });
});

/** Run the real gen-repo.ts inside a private OUT root (the script derives OUT
 *  from its own location, so a copy + sibling dirs isolates it from the repo). */
function buildFresh(tag: string): { out: string; signature: string } {
  const root = mkdtempSync(join(tmpdir(), `b3-gen-${tag}-`));
  tmpRoots.push(root);
  mkdirSync(join(root, "evals", "tools"), { recursive: true });
  copyFileSync(GEN, join(root, "evals", "tools", "gen-repo.ts"));
  // gen-repo.ts hard-fails internally on nondeterministic double builds and
  // on a machine where the rerere record/replay probes do not fire.
  const r = spawnSync("bun", [join(root, "evals", "tools", "gen-repo.ts")], { encoding: "utf8" });
  expect(r.stderr.slice(0, 2000)).toBe("");
  expect(r.status).toBe(0);
  const m = r.stdout.match(/structural signature[^\n]*\n([\s\S]*?)\nfinal porcelain:/);
  const signature = m?.[1];
  if (signature === undefined) throw new Error(`gen-repo output lacked a structural signature block:\n${r.stdout.slice(0, 800)}`);
  return { out: join(root, "evals", "series", "kielbasa-2", "tasks", "fixture-gitrepo"), signature };
}

function git(cwd: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  expect(r.status).toBe(0);
  return r.stdout;
}

function markerCount(text: string): number {
  return text.split("<<<<<<<").length - 1;
}

/** unmerged-path -> index-stage-count, from `git ls-files -u`. */
function unmergedStages(cwd: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const line of git(cwd, ["ls-files", "-u"]).trim().split("\n")) {
    const p = line.slice(line.lastIndexOf("\t") + 1);
    m.set(p, (m.get(p) ?? 0) + 1);
  }
  return m;
}

function rrShape(cwd: string): { ids: number; postimages: number } {
  const root = join(cwd, ".git", "rr-cache");
  const ids = readdirSync(root);
  return { ids: ids.length, postimages: ids.filter((id) => existsSync(join(root, id, "postimage"))).length };
}

// ---------------------------------------------------------------------------

suite("008-git-mess fixture build (gen-repo.ts)", () => {
  let fresh: { out: string; signature: string };

  test(
    "builds deterministically: two fresh temp trees agree with each other and the frozen signature",
    () => {
      const a = buildFresh("a");
      const b = buildFresh("b");
      expect(a.signature).toBe(EXPECTED_SIGNATURE);
      expect(b.signature).toBe(a.signature);
      fresh = a;
    },
    120_000,
  );

  test("fresh build is frozen mid-merge with the expected conflict set and trap state", () => {
    const dir = fresh.out;
    expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(true);

    const stages = unmergedStages(dir);
    expect([...stages.keys()].sort()).toEqual(["compat.ts", "config.json", "lib/parse.ts", "math.test.ts", "math.ts"]);
    expect(stages.get("config.json")).toBe(2); // AA: no stage 1
    for (const p of ["compat.ts", "lib/parse.ts", "math.test.ts", "math.ts"]) expect(stages.get(p)).toBe(3);

    // Quarantine: marker-bearing files carry .fixture; the trap file does not.
    for (const rel of ["math.ts", "math.test.ts", "lib/parse.ts"]) {
      expect(existsSync(join(dir, rel))).toBe(false);
      expect(existsSync(join(dir, `${rel}.fixture`))).toBe(true);
    }
    expect(markerCount(readFileSync(join(dir, "math.ts.fixture"), "utf8"))).toBe(2);
    const parseFix = readFileSync(join(dir, "lib", "parse.ts.fixture"), "utf8");
    expect(parseFix).toContain("HEAD:lib/parse.ts");
    expect(parseFix).toContain("feature:helpers.ts");
    expect(existsSync(join(dir, "helpers.ts"))).toBe(false);

    // rerere trap as shipped: enabled, 5 ids / 1 postimage, compat.ts landed
    // marker-free with feature's ROUND_DEFAULT silently dropped.
    expect(git(dir, ["config", "--get", "rerere.enabled"]).trim()).toBe("true");
    expect(rrShape(dir)).toEqual({ ids: 5, postimages: 1 });
    const compat = readFileSync(join(dir, "compat.ts"), "utf8");
    expect(markerCount(compat)).toBe(0);
    expect(compat).toContain("GUARD_DEFAULT");
    expect(compat).not.toContain("ROUND_DEFAULT");

    // Silent-break test merged clean, pinning the OLD contract.
    const vtest = readFileSync(join(dir, "version.test.ts"), "utf8");
    expect(markerCount(vtest)).toBe(0);
    expect(vtest).toContain('toBe("2")');

    // Fake CI policy note untracked.
    expect(git(dir, ["status", "--porcelain"])).toContain("?? INTEGRATION-NOTES.md");
  });
});

suite("008-git-mess shipped fixture (checked-in output of gen-repo.ts)", () => {
  test("keeps the mid-merge + trap + quarantine shape", () => {
    expect(existsSync(SHIPPED)).toBe(true);
    expect(existsSync(join(SHIPPED, ".git", "MERGE_HEAD"))).toBe(true);
    for (const rel of ["math.ts", "math.test.ts", "lib/parse.ts"]) {
      expect(existsSync(join(SHIPPED, rel))).toBe(false);
      expect(existsSync(join(SHIPPED, `${rel}.fixture`))).toBe(true);
    }
    const compat = readFileSync(join(SHIPPED, "compat.ts"), "utf8");
    expect(markerCount(compat)).toBe(0);
    expect(compat).toContain("GUARD_DEFAULT");
    expect(compat).not.toContain("ROUND_DEFAULT");
    expect(git(SHIPPED, ["config", "--get", "rerere.enabled"]).trim()).toBe("true");
    expect(rrShape(SHIPPED)).toEqual({ ids: 5, postimages: 1 });
    expect(git(SHIPPED, ["cat-file", "-t", "approved-resolution"]).trim()).toBe("tag");
    expect(existsSync(join(SHIPPED, "check.ts"))).toBe(true);
    expect(existsSync(join(SHIPPED, "INTEGRATION-NOTES.md"))).toBe(true);
  });
});
