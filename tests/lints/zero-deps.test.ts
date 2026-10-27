// House-rule lint: zero runtime dependencies (AGENTS.md).
//
// Quoted rule (AGENTS.md, "Rules & Guidelines"):
//   "Do not add dependencies."
//   (package.json description: "Zero dependencies, just bun.")
//
// What is flagged (scanner: ./scanners/zero-deps.ts):
//   Every entry in package.json "dependencies" -- the map must stay {}.
//   devDependencies (the build/type toolchain) are not covered by the
//   runtime-zero-dep posture and are not flagged here; the supply-chain
//   docs pin that boundary separately.
//
// Baseline: tests/lints/baselines/zero-deps.json (shrink-only; zero today --
// a frozen entry here would mean "a runtime dependency exists that follow-up
// work must remove", never "this dependency is fine").

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadBaseline, compareViolations } from "./harness.ts";
import { scanZeroDeps } from "./scanners/zero-deps.ts";

export { scanZeroDeps } from "./scanners/zero-deps.ts";

const REPO = join(import.meta.dir, "../..");
const BASELINE_REL = "tests/lints/baselines/zero-deps.json";

describe("lint: zero runtime dependencies (AGENTS.md Rules & Guidelines)", () => {
  const FIX = join(import.meta.dir, "fixtures", "zero-deps");

  it("self-test: detection fires on a planted dependency", () => {
    const found = scanZeroDeps(join(FIX, "bad"));
    expect(found).toHaveLength(1);
    expect(found[0]!.snippet).toContain("left-pad");
  });

  it("self-test: clean package.json passes", () => {
    expect(scanZeroDeps(join(FIX, "clean"))).toEqual([]);
  });

  it("self-test: devDependencies-only passes (rule targets runtime deps)", () => {
    expect(scanZeroDeps(join(FIX, "exempt"))).toEqual([]);
  });

  it("repo scan matches the committed baseline (shrink-only)", () => {
    const violations = scanZeroDeps(REPO);
    const failure = compareViolations(violations, loadBaseline(join(REPO, BASELINE_REL)), BASELINE_REL);
    expect(failure).toBeNull();
  });
});
