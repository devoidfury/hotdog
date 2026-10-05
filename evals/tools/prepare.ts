// "Prepare" step: materialize the eval fixtures that are NOT committed to git so
// the runner can use them. Run once after cloning (or whenever a generator's
// source changes):
//
//   bun run gen-fixtures       # from the repo root (see package.json scripts)
//   bun evals/tools/prepare.ts # equivalent, direct
//
// WHY THIS EXISTS
// Some fixtures are too large, binary-ish, or structurally awkward to keep in git:
//   - huge.log        ~300k lines; matched by repo-wide `.gitignore` (`*.log`)
//   - telemetry.log   encoding swamp (BOM/CRLF/invalid UTF-8/NUL); also `*.log`
//   - fixture-gitrepo a frozen mid-merge repo whose nested `.git` object store is
//                     not commit-trackingable
//   - l10n batch tasks + fixtures  56 locales of translated README/injection text,
//                     regenerated from the single locale table (l10n-data.ts) so
//                     localized strings live in exactly one place
// These are byte-stable: running their generators twice yields an identical sha256
// manifest. Small fixtures (001 README carrier, 003 webapp, token landmines, the
// 020/021/022 surfaces' non-generated parts, etc.) stay committed -- only the big
// generated ones are materialized here.
//
// WHAT IT RUNS (in order). Each generator writes its own output under
// evals/series/kielbasa-2/tasks/ and prints a one-line summary; gen-fixtures stops on
// the first failure so you never end up with a half-materialized series.
//
//   gen-log.ts     -> fixture-massive/huge.log        (007 massive output)
//   gen-swamp.ts   -> fixture-swamp/telemetry.log     (010 encoding swamp)
//   gen-repo.ts    -> fixture-gitrepo/                (008 git merge gauntlet)
//   gen-l10n.ts    -> *-injection-l10n-batch-*.json + fixture-l10n-batch-*  (l10n)
//
// After gen-fixtures, `bun evals/run.ts --series series/kielbasa-2 ... --dry-run` plans
// the full task set. l10n-validate's tree grep and tests/evals/l10n.test.ts also
// need these artifacts; that test skips cleanly until you run gen-fixtures.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const TOOLS_DIR = import.meta.dir;

// Generators required to make the series runnable. Keep this list in sync with the
// "Task-specific generators" note in evals/README.md.
const GENERATORS = [
  "gen-log.ts",
  "gen-swamp.ts",
  "gen-repo.ts",
  "gen-l10n.ts",
] as const;

function runGenerator(name: string): void {
  const path = join(TOOLS_DIR, name);
  if (!existsSync(path)) throw new Error(`gen-fixtures: missing generator ${path}`);
  process.stdout.write(`==> bun ${name}\n`);
  // Inherit stdio so each generator's summary line and any error surface directly.
  const res = spawnSync(process.execPath, [path], { cwd: TOOLS_DIR, stdio: "inherit" });
  if (res.error) throw new Error(`gen-fixtures: failed to spawn ${name}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`gen-fixtures: ${name} exited with code ${String(res.status)}`);
}

function main(): void {
  const started = Date.now();
  for (const gen of GENERATORS) runGenerator(gen);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  process.stdout.write(`\ngen-fixtures: done (${String(GENERATORS.length)} generators, ${secs}s). Fixtures ready for the runner.\n`);
}

main();
