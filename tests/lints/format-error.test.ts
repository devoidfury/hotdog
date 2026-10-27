// House-rule lint: Error Handling (AGENTS.md).
//
// Quoted rule (AGENTS.md, "Error Handling"):
//   "All error catches must use `formatError()` from `src/core/error.ts`:
//    ...
//    Never use `console.error(e.message)` directly -- always use `formatError(e)`"
//
// What is flagged (scanner: ./scanners/format-error.ts):
//   F1  `.message` read inside a LOGGING call (logger.*, console.*, sink.log,
//       process.stderr.write) sitting inside an error-handler region: a
//       `catch` block, a `.catch(cb)` callback with a parameter, or an
//       `.on("error", cb)` listener. Exactly the shape that drops the stack
//       the rule exists to preserve (audit 2026-10-26 findings-core M5).
//   F2  `console.error(...)` anywhere in src/ whose arguments read `.message`
//       (the literal banned call form, in or out of a catch).
//   F3  Discarded rejections: `promise.then(ok, () => { ... })` where the
//       rejection handler takes no parameter and its block body neither
//       calls formatError nor throws/returns -- the reason vanishes silently
//       (audit 2026-10-26 findings-extensions M2 flavor, ui-interactive-cli
//       index.ts:1219-1223).
//
// Deliberate pattern narrowing (known ceilings):
//   - Returning `e.message` as a result/tool-error string (ToolResult.err,
//     resolve({ error: ... })) is NOT flagged: the message-only path is
//     sanctioned for expected errors and the text still reaches the caller;
//     only the log/discard path silently loses the stack. (executeShellCommand
//     falls in this class, so it is intentionally absent from the baseline.)
//   - Expression-bodied `.then(a, () => expr)` is not flagged (the outcome
//     propagates through the chained promise).
//   - `.catch(() => {})`-style empty swallows are not flagged (intentional
//     documented no-ops, e.g. cancelling a stream body).
//   - Comments and string contents are masked before scanning, so rule prose
//     never self-matches. `formatError(e)` carries no `.message` and so is
//     never flagged. `src/core/error.ts` (formatError's implementation) is
//     excluded.
//
// Baseline: tests/lints/baselines/format-error.json (shrink-only, see harness).

import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { loadBaseline, compareViolations, maskCode } from "./harness.ts";
import { scanFormatErrors } from "./scanners/format-error.ts";

export { scanFormatErrors } from "./scanners/format-error.ts";

const REPO = join(import.meta.dir, "../..");
const BASELINE_REL = "tests/lints/baselines/format-error.json";

describe("lint: formatError routing (AGENTS.md Error Handling)", () => {
  const FIX = join(import.meta.dir, "fixtures", "format-error");

  it("self-test: detection fires on planted violations", () => {
    const found = scanFormatErrors(join(FIX, "bad"));
    const planted = found.filter((v) => v.file === "src/catch-message.ts");
    expect(planted).toHaveLength(2); // F1 console.error(e.message) + F3 discarded rejection
    expect(JSON.stringify(found)).toContain(".message");
  });

  it("self-test: clean code passes (formatError used, typed handler, empty swallow)", () => {
    expect(scanFormatErrors(join(FIX, "good"))).toEqual([]);
  });

  it("self-test: exempt shapes pass (result strings, comment prose, expression handler)", () => {
    expect(scanFormatErrors(join(FIX, "exempt"))).toEqual([]);
  });

  it("self-test: masker blanks comments/strings, keeps template interpolations", () => {
    const probe = `a("// e.message here");\n/* console.error(x.message) */\nb = x / 2; // trailing\nc \`\${d.message}\``;
    const m = maskCode(probe);
    expect(m).not.toContain("e.message"); // string contents blanked
    expect(m).not.toContain("x.message"); // block comment blanked
    expect(m).not.toContain("trailing"); // line comment blanked
    expect(m).toContain("d.message"); // template interpolation is code
    expect(m.length).toBe(probe.length); // same length, same newline positions
  });

  it("repo scan matches the committed baseline (shrink-only)", () => {
    const violations = scanFormatErrors(REPO);
    const failure = compareViolations(violations, loadBaseline(join(REPO, BASELINE_REL)), BASELINE_REL);
    expect(failure).toBeNull();
  });
});
