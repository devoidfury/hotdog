// House-rule lint: Centralized Defaults (AGENTS.md).
//
// Quoted rule (AGENTS.md, "Centralized Defaults"):
//   "The source of truth for all configurable values in core is
//    `src/core/core.config.json`. Defaults are exported from
//    `src/core/config/defaults.ts` for use by the config resolution layer
//    (`getDefaultConfig()`). ... Components (`Agent`, `LlmClient`,
//    `TaskManager`, etc.) receive resolved values from callers -- do not
//    import `DEFAULT_*` constants in components. Static path constants
//    (`DEFAULT_PROFILES_SUBPATH`, `DEFAULT_CONFIG_FILENAME`,
//    `DEFAULT_SYSTEM_PROMPT_FILENAME`) and runtime fallbacks
//    (`DEFAULT_SYSTEM_PROMPT_TEMPLATE`) are exempt from this rule."
//   Extensions own their config via `src/extensions/*/extension.json`
//   configSchema; docs/agents/extensions.md calls the backup-default pattern
//   WRONG ("backup default masks config errors ... components receive
//   resolved values").
//
// What is flagged (scanner: ./scanners/centralized-defaults.ts):
//   D1  `DEFAULT_*` identifier imported by any src/ file outside the config
//       resolution layer (src/core/config/), minus the four AGENTS.md-exempt
//       names. One violation per import statement.
//   D2  `configLike.key ?? <fallback>` or `configLike.key === "x" ? ... :
//       <fallback>` (same line) where `key` is SCHEMA-OWNED (present in
//       src/core/core.config.json or an extension.json configSchema, at any
//       nesting) and the fallback is a numeric/string literal or a
//       DEFAULT_* constant. "configLike" = receiver identifier containing
//       config|cfg|resolved -- receiver-gating keeps precision.
//   D3  A file that calls `getExtensionConfig` yet defines its own
//       `const DEFAULT_X = <numeric literal>`: a component-resident backup
//       default (the audit's mcp-client DEFAULT_TIMEOUT_SECS flavor).
//
// Deliberate pattern narrowing (known ceilings):
//   - D1 matches the written rule literally; exemptions are exactly the four
//     named constants, so DEFAULT_MAX_IMAGE_SIZE-style imports are frozen
//     even where the constant is documented "not configurable via
//     configSchema". The fix is plumbing resolved values (or amending
//     AGENTS.md), not silencing the lint.
//   - D2 requires the config-ish receiver on the fallback expression itself;
//     a fallback behind a helper parameter (`resolveTimeoutSecs(value)`) is
//     caught at its definition by D3 instead.
//   - String-valued DEFAULT_ constants (e.g. CLI arg defaults) are out of
//     scope for D3; they are not config-schema fallbacks per se.
//   - src/core/config/ is exempt entirely (it IS the defaults layer).
//
// Baseline: tests/lints/baselines/centralized-defaults.json (shrink-only).

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadBaseline, compareViolations } from "./harness.ts";
import { scanCentralizedDefaults } from "./scanners/centralized-defaults.ts";

export { scanCentralizedDefaults, collectSchemaKeys } from "./scanners/centralized-defaults.ts";

const REPO = join(import.meta.dir, "../..");
const BASELINE_REL = "tests/lints/baselines/centralized-defaults.json";

describe("lint: centralized defaults (AGENTS.md Centralized Defaults)", () => {
  const FIX = join(import.meta.dir, "fixtures", "centralized-defaults");

  it("self-test: detection fires on planted violations (import, ?? literal, backup const)", () => {
    const found = scanCentralizedDefaults(join(FIX, "bad"));
    const json = JSON.stringify(found);
    expect(found.length).toBeGreaterThanOrEqual(4);
    expect(json).toContain("DEFAULT_TICK_MS"); // D1 import into component
    expect(json).toContain("repeatLimit ?? 9"); // D2 literal fallback for schema key
    expect(json).toContain("pingLimit ?? DEFAULT_PING"); // D2 DEFAULT_ fallback for schema key
    expect(json).toContain("const DEFAULT_PING = 9;"); // D3 backup const in config consumer
  });

  it("self-test: clean code passes", () => {
    expect(scanCentralizedDefaults(join(FIX, "clean"))).toEqual([]);
  });

  it("self-test: AGENTS.md exemptions pass (named constants, config layer, non-schema keys)", () => {
    expect(scanCentralizedDefaults(join(FIX, "exempt"))).toEqual([]);
  });

  it("repo scan matches the committed baseline (shrink-only)", () => {
    const violations = scanCentralizedDefaults(REPO);
    const failure = compareViolations(violations, loadBaseline(join(REPO, BASELINE_REL)), BASELINE_REL);
    expect(failure).toBeNull();
  });
});
