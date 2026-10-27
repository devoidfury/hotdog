// Regenerate all house-rule lint baselines from the current tree.
//
// Run from the repo root:  bun tests/lints/regenerate.ts
// Then REVIEW the diff: every remaining entry must be a real violation of
// the AGENTS.md rule quoted in the corresponding test file. The baseline is
// shrink-only: this script is for (re)seeding and for pruning entries after
// fixing violations -- re-broadening it to accept new violations is the
// misuse this suite exists to prevent.

import { join } from "node:path";
import { saveBaseline } from "./harness.ts";
import { scanFormatErrors } from "./scanners/format-error.ts";
import { scanCentralizedDefaults } from "./scanners/centralized-defaults.ts";
import { scanModuleImports } from "./scanners/module-imports.ts";
import { scanMockModule } from "./scanners/mock-module.ts";
import { scanZeroDeps } from "./scanners/zero-deps.ts";

const REPO = join(import.meta.dir, "../..");

const rules: Array<[string, (root: string) => ReturnType<typeof scanZeroDeps>]> = [
  ["format-error", scanFormatErrors],
  ["centralized-defaults", scanCentralizedDefaults],
  ["module-imports", scanModuleImports],
  ["mock-module", scanMockModule],
  ["zero-deps", scanZeroDeps],
];

for (const [name, scan] of rules) {
  const violations = scan(REPO);
  saveBaseline(join(REPO, "tests", "lints", "baselines", `${name}.json`), violations);
  console.log(`${name}: ${violations.length} baseline entries`);
}
