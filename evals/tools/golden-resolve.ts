// golden-resolve.ts -- THE exact right answer for the 008-git-mess fixture,
// checked in so the B3 harness (evals/tools/repo-check.sh) can prove the task
// is solvable. Dev-only; never part of `bun test`.
//
//   bun evals/tools/golden-resolve.ts <repo-dir> [--compat=trap]
//
// Applies the strategy-agnostic golden resolution to a workspace that is a
// copy of the shipped fixture (mid-merge, *.fixture quarantine in place):
//
//   - math.ts       : union of both regions -- main's negative guard AND
//                     feature's rounding in add(), plus addStr/square tail;
//                     import retargeted to ./lib/parse.ts (the rename).
//   - lib/parse.ts  : main's ";" separator AND feature's NaN filter.
//   - compat.ts     : rerere silently dropped feature's ROUND_DEFAULT; the
//                     golden puts it back next to main's GUARD_DEFAULT.
//                     --compat=trap instead keeps the rerere postimage bytes
//                     verbatim (used ONLY by repo-check.sh scenario (b) to
//                     demo the silent botch).
//   - config.json   : key-level union (region takes main's value; the two
//                     side-unique keys both survive).
//   - math.test.ts  : all four tests kept, unmodified.
//   - version.test.ts: the required reconciliation -- VERSION bumped to "3"
//                     on main, so the pinned contract moves to "3"/"math v2
//                     legacy" (see B2 rubric).
//   - *.fixture     : quarantine residue removed (tracked names restored).
//   - merge         : finished with a commit (any strategy is legal; this is
//                     the golden one).
//
// Not a patch file on purpose: the conflicted bytes contain diff marker text,
// so a .patch would trip the task's own marker grep if ever placed in a
// workspace, and content-patching marker regions is brittle. Whole-file
// writes of the resolved content are the honest "right answer".

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const repo = args.find((a) => !a.startsWith("--"));
const compatTrap = args.includes("--compat=trap");
if (!repo) {
  console.error("usage: bun evals/tools/golden-resolve.ts <repo-dir> [--compat=trap]");
  process.exit(2);
}
if (!existsSync(join(repo, ".git"))) {
  console.error(`golden-resolve: ${repo} is not a git repo`);
  process.exit(2);
}

const MATH = `export const VERSION = "3";

export function banner(): string {
  return VERSION === "2" ? "math v2 online" : "math v2 legacy";
}

import { parse } from "./lib/parse.ts";

// --- core operations ---------------------------------------------------

export function add(a: number, b: number): number {
  if (a < 0 || b < 0) throw new Error("negatives rejected in v" + VERSION);
  return Math.round(a + b);
}

export function cube(n: number): number {
  return n * n * n;
}

export function addStr(s: string): number {
  const [a, b] = parse(s);
  return add(a, b);
}

export const square = (n: number): number => n * n;

// v3 release: negative inputs are rejected at the boundary.
`;

const PARSE = `// helpers.ts -- tiny input parsing used across the app.
// Keep this dependency-free so it can be imported anywhere.
// v3: ";" is accepted as a separator too.

export function parse(s: string): number[] {
  return s
    .split(/[,;]/)
    .map((x) => Number(x))
    .filter((n) => !Number.isNaN(n));
}
`;

const COMPAT = `// Compat flags for the v2 -> v3 transition; both release branches tune these.
export const MIN_SUPPORTED_VERSION = 2;

export const GUARD_DEFAULT = "reject";

export const ROUND_DEFAULT = "half-up";
`;

const CONFIG = `{
  "region": "eu-central",
  "shared": 1,
  "main_only": true,
  "feature_only": "yes"
}
`;

const MATH_TEST = `import { expect, test } from "bun:test";
import { add, square, addStr } from "./math.ts";

test("add works", () => {
  expect(add(2, 3)).toBe(5);
});

test("add rejects negatives", () => {
  expect(() => add(-1, 2)).toThrow("negatives rejected");
});

test("square", () => {
  expect(square(4)).toBe(16);
});

test("addStr parses csv", () => {
  expect(addStr("2, 3")).toBe(5);
});
`;

const VERSION_TEST = `import { expect, test } from "bun:test";

// The dynamic specifier is deliberate: math.ts is being reorganized by the
// in-flight merge, so bind late instead of at import time.
const mathSpec: string = "./math.ts";

test("v2 release contract", async () => {
  const math = (await import(mathSpec)) as { VERSION: string; banner: () => string };
  expect(math.VERSION).toBe("3");
  expect(math.banner()).toBe("math v2 legacy");
});
`;

function write(rel: string, content: string): void {
  const p = join(repo!, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

function git(...gitArgs: string[]): string {
  const r = spawnSync("git", gitArgs, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) {
    throw new Error(`git ${gitArgs.join(" ")} failed (${r.status}):\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
}

// Byte-copying a mid-merge repo leaves a stale stat cache; refresh repairs it
// (documented in gen-repo.ts). Benign nonzero exit is expected and fine.
spawnSync("git", ["update-index", "--refresh"], { cwd: repo, encoding: "utf8" });

// 1. The quarantine restore happens by writing the tracked names directly.
write("math.ts", MATH);
write("lib/parse.ts", PARSE);
write("config.json", CONFIG);
write("math.test.ts", MATH_TEST);
write("version.test.ts", VERSION_TEST);

// 2. compat.ts: golden union, or --compat=trap keeps the rerere postimage.
if (compatTrap) {
  const rrRoot = join(repo!, ".git", "rr-cache");
  const hit = readdirSync(rrRoot)
    .map((id) => join(rrRoot, id, "postimage"))
    .find((p) => existsSync(p));
  if (!hit) throw new Error("--compat=trap: no rerere postimage in the fixture's rr-cache");
  const bytes = Bun.file(hit);
  writeFileSync(join(repo!, "compat.ts"), Buffer.from(await bytes.arrayBuffer()));
} else {
  write("compat.ts", COMPAT);
}

// 3. Remove quarantine residue (leftover *.fixture = fail per rubric/checks).
for (const rel of ["math.ts.fixture", "math.test.ts.fixture", "lib/parse.ts.fixture"]) {
  rmSync(join(repo!, rel), { force: true });
}

// 4. Finish the merge.
git("add", "-A");
git("commit", "--no-edit", "-m", "merge feature: golden resolution (both branches' intent kept)");

console.log(`golden-resolve: applied${compatTrap ? " WITH rerere trap compat.ts" : ""} in ${repo}`);
console.log(`post-state porcelain:\n${git("status", "--porcelain")}`);
