# tests/lints — house-rule lints

AGENTS.md rules, enforced as plain `bun test` files instead of prose review.
Precedent: `tests/lints/doc-path-citations.test.ts` (repo-scanning test with
fixture extractor tests). No new dependencies; `bun:test` only; no
`mock.module` (that would be rich, in the file that bans it).

## Layout

- `harness.ts` — shared plumbing: the `Violation` type, baseline
  load/save/compare, file walking, and a comment/string masker.
- `scanners/<rule>.ts` — one pure scanner function per rule:
  `(rootDir) => Violation[]`. Pure over a root so tests can point them at
  fixture mini-trees instead of only the real repo.
- `<rule>.test.ts` — the rule statement (with the AGENTS.md text quoted
  verbatim), fixture self-tests (planted violation fires / clean passes /
  exemptions pass), and the repo-wide scan compared against the baseline.
- `fixtures/<rule>/{bad,clean,exempt}/` — mini trees, never the repo.
  The `mock.module` repo scan skips `tests/lints/fixtures/` deliberately:
  it is planted bait, like the eval bait repos in `bunfig.toml`
  `pathIgnorePatterns`.
- `baselines/<rule>.json` — the frozen violations.
- `regenerate.ts` — re-runs every scanner and rewrites its baseline
  (`bun tests/lints/regenerate.ts` from the repo root).

## Baseline semantics: shrink-only, both directions fail

Every scanner runs against the whole repo. Its output is compared against
the committed baseline per rule:

- **A violation NOT in the baseline** → `NEW VIOLATION(S), FIX YOUR CODE`.
  The right move is fixing the code, never re-running regenerate to widen
  the baseline.
- **A baseline entry no longer found in the tree** → `violation fixed,
  prune the entry`. Keeping dead entries is also a failure: the baseline
  may only shrink.

Entries match on **file path + whitespace-normalized code snippet**, never
line numbers. Lines drift with every unrelated edit above them; the snippet
only changes when the violating code itself changes, which is exactly the
event the baseline should react to (fixed → prune; still present → match,
whoever edits around it).

## Adding a rule

1. Create `scanners/<rule>.ts` exporting `scan<Rule>(root: string): Violation[]`.
   Scan masked source (`maskCode` blanks comments/string/template text but
   keeps `${...}` interpolations as code; `maskCommentsOnly` keeps strings
   for spec-matching). Snippets are normalized with `normalizeSnippet`;
   capture the *meaningful* line (the one a reviewer would cite).
2. Create `<rule>.test.ts`. **Header must quote the AGENTS.md rule verbatim**
   — a lint nobody can trace to a written rule is a lint nobody fixes.
   State the sub-patterns and, honestly, the narrowing decisions and known
   ceilings (what similar-looking code is deliberately NOT flagged, and why).
3. Add `fixtures/<rule>/{bad,clean,exempt}/` mini trees and three
   self-tests: detection fires on the planted violation, clean code passes,
   exemptions pass. Fixtures must typecheck (`bun run check` sees them).
4. `bun tests/lints/regenerate.ts`, then **review every frozen entry**: it
   must be a real violation of the quoted rule. A false-positive candidate
   means the scanner is wrong — narrow the pattern, don't freeze noise.
5. Keep the scan fast; the full suite budget is 10s. Current cost of all
   five repo scans together is well under 1s.

## The rules

| Test file | AGENTS.md rule | Baseline entries |
|---|---|---|
| `format-error.test.ts` | Error Handling: catches route through `formatError()` | 0 |
| `centralized-defaults.test.ts` | Centralized Defaults: no `DEFAULT_*` imports in components; no `?? <literal>` fallbacks for schema-owned keys | 13 |
| `module-imports.test.ts` | Module Imports: no relative climbs across alias scopes | 0 |
| `mock-module.test.ts` | Never use `mock.module` | 0 |
| `zero-deps.test.ts` | Do not add dependencies (`"dependencies": {}`) | 0 |

## Rules index

Every test file in this directory, one line each:

- `format-error.test.ts` — catches route through `formatError()` (baseline rule).
- `centralized-defaults.test.ts` — no `DEFAULT_*` imports in components; no `?? <literal>`
  fallbacks for schema-owned keys (baseline rule).
- `module-imports.test.ts` — no relative climbs across alias scopes (baseline rule).
- `mock-module.test.ts` — the literal `mock.module(` ban (baseline rule).
- `zero-deps.test.ts` — `"dependencies": {}` stays empty (baseline rule).
- `architecture-core-no-extensions.test.ts` — dependency law: `src/core` never
  imports `src/extensions` or `src/experimental`. Moved from `tests/core/`.
- `doc-path-citations.test.ts` — every repo-relative path cited in the
  agent-facing docs must exist. Moved from `tests/docs/` (now folded into this
  directory).
- `ui-renderer-architecture.test.ts` — the renderer is a dependency leaf, only
  the stage-2b wiring imports it, mode bytes live in one home, and the 3a input
  stack stays pure. Moved from the renderer test directory (`tests/utils/cli/renderer/`).

The three moved tests are self-baselining zero-violation scans (they assert the
violation list is empty), so they have no `baselines/` entries and are not
listed in `regenerate.ts`.

The frozen entries came from the 2026-10-26 audit (`tmp/review-2026-10-26/`);
fixing them is follow-up work — each fixed site must be pruned from its
baseline in the same change that fixes it.
