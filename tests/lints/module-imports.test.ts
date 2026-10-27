// House-rule lint: Module Imports (AGENTS.md).
//
// Quoted rule (AGENTS.md, "Module Imports"):
//   "tsconfig path aliases defined: `@core/*`, `@extensions/*`,
//    `@experimental/*`, `@utils/*`, `@package.json`. ... Within same alias
//    scope, relative imports okay (e.g. `../error.ts` from
//    `src/core/session/`). Across alias scopes, use alias instead of
//    `../../core` or `../../utils` climbing paths (e.g. `@utils/logger.ts`
//    from `src/core/`, `@core/hooks.ts` from `src/extensions/`)."
//
// What is flagged:
//   A static import/export-from or dynamic import("...") whose relative
//   specifier (starts with `./` or `../`) resolves into a DIFFERENT alias
//   scope directory than the importing file's own scope, where both scopes
//   are one of the four (@core src/core, @extensions src/extensions,
//   @experimental src/experimental, @utils src/utils). Files outside the
//   four scopes (bin/, src/workers/, tests/) are not bound by the rule;
//   files inside a scope may not climb INTO another scope.
//
// Deliberate narrowing: only static `from "..."` and `import("...")` forms;
// comments are masked. Cross-extension relative imports within
// src/extensions/* stay legal by the letter of the rule ("within same alias
// scope, relative imports okay") even when they cross extension dirs --
// the extension-boundary seam is a separate (docs-debated) concern, not this
// written rule.
//
// Baseline: tests/lints/baselines/module-imports.json (shrink-only; audit
// 2026-10-26 found zero cross-scope climbs, so this should stay empty).

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadBaseline, compareViolations } from "./harness.ts";
import { scanModuleImports } from "./scanners/module-imports.ts";

export { scanModuleImports } from "./scanners/module-imports.ts";

const REPO = join(import.meta.dir, "../..");
const BASELINE_REL = "tests/lints/baselines/module-imports.json";

describe("lint: alias-scope module imports (AGENTS.md Module Imports)", () => {
  const FIX = join(import.meta.dir, "fixtures", "module-imports");

  it("self-test: detection fires on planted scope-climbing imports", () => {
    const found = scanModuleImports(join(FIX, "bad"));
    const json = JSON.stringify(found);
    expect(found).toHaveLength(2);
    expect(json).toContain("src/extensions/ext-a/consumer.ts"); // ../../core/...
    expect(json).toContain("src/utils/tool.ts"); // ../core/...
  });

  it("self-test: clean code passes (aliases and in-scope relative)", () => {
    expect(scanModuleImports(join(FIX, "clean"))).toEqual([]);
  });

  it("self-test: exemptions pass (same-scope relative incl. cross-extension)", () => {
    expect(scanModuleImports(join(FIX, "exempt"))).toEqual([]);
  });

  it("repo scan matches the committed baseline (shrink-only)", () => {
    const violations = scanModuleImports(REPO);
    const failure = compareViolations(violations, loadBaseline(join(REPO, BASELINE_REL)), BASELINE_REL);
    expect(failure).toBeNull();
  });
});
