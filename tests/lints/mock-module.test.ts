// House-rule lint: mock.module ban (AGENTS.md).
//
// Quoted rule (AGENTS.md, "Rules & Guidelines"):
//   "Never use mock.module in tests; footgun."
//
// What is flagged (scanner: ./scanners/mock-module.ts):
//   The literal call form `mock.module(` in any src/ or tests/ file.
//   Comments and string contents are masked, so prose about the ban (and
//   this file's own header) never matches.
//
// Scan exclusion: tests/lints/fixtures/ is skipped in the repo-wide scan --
// it intentionally contains planted violations to self-test this scanner
// (the same rationale as bunfig.toml pathIgnorePatterns for eval bait repos).
//
// Baseline: tests/lints/baselines/mock-module.json (shrink-only; zero today).

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadBaseline, compareViolations } from "./harness.ts";
import { scanMockModule } from "./scanners/mock-module.ts";

export { scanMockModule } from "./scanners/mock-module.ts";

const REPO = join(import.meta.dir, "../..");
const BASELINE_REL = "tests/lints/baselines/mock-module.json";

describe("lint: mock.module ban (AGENTS.md Rules & Guidelines)", () => {
  const FIX = join(import.meta.dir, "fixtures", "mock-module");

  it("self-test: detection fires on planted mock.module calls", () => {
    const found = scanMockModule(join(FIX, "bad"));
    expect(found).toHaveLength(2);
    expect(JSON.stringify(found)).toContain("mock.module(");
  });

  it("self-test: clean code passes", () => {
    expect(scanMockModule(join(FIX, "clean"))).toEqual([]);
  });

  it("self-test: exemption passes (ban mentioned in comment/string prose only)", () => {
    expect(scanMockModule(join(FIX, "exempt"))).toEqual([]);
  });

  it("repo scan matches the committed baseline (shrink-only)", () => {
    const violations = scanMockModule(REPO);
    const failure = compareViolations(violations, loadBaseline(join(REPO, BASELINE_REL)), BASELINE_REL);
    expect(failure).toBeNull();
  });
});
