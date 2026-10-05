#!/usr/bin/env bash
# =============================================================================
# repo-check.sh -- B3 satisfiability harness for kielbasa-2 task 008-git-mess.
# Dev-only. Never invoked by the eval runner or by `bun test`; run it manually
# before shipping changes to gen-repo.ts, the task JSON, or a new git version:
#
#   evals/tools/repo-check.sh
#
# What it proves (B3 acceptance, all expectations hard-asserted):
#
#   1 FRESH BUILD   gen-repo.ts builds the fixture cleanly on THIS machine.
#                   Its internal probes hard-fail if the rerere record/replay
#                   trap does not fire -- that is the documented trigger to
#                   switch the fixture to the .gitattributes merge=union
#                   fallback (see gen-repo.ts header, mechanism 5). The build
#                   runs into a throwaway tree by copying gen-repo.ts next to
#                   a temp OUT root, so the checked-in fixture under
#                   evals/series/.../fixture-gitrepo is NEVER touched.
#   2 GOLDEN        evals/tools/golden-resolve.ts (the exact right answer,
#                   checked in) applied to a scratch copy passes EVERY check
#                   in evals/series/kielbasa-2/tasks/008-git-mess.json. Checks
#                   execute through the repo's own scorer (evals/lib/score.ts
#                   runCheck: command = bash -lc, file_match = JS RegExp), so
#                   this harness grades byte-identically to the runner, B2's
#                   `--exclude-dir=.git` marker-grep string included. The
#                   exit_code check grades the golden "agent run" itself: 0.
#   3 FAILURE MODES
#     (a) UNRESOLVED  the fresh fixture fails `bun test` (silent VERSION break
#                     + quarantined imports) and fails the check suite.
#     (b) RERERE      rerere replay verifiably fires ("Resolved 'compat.ts'
#                     using previous resolution."), compat.ts lands marker-free
#                     with feature's ROUND_DEFAULT silently dropped, `bun test`
#                     STILL passes on it, and `bun check.ts` is the only check
#                     that fails -- the silent-botch trap fires and is caught.
#     (c) THEIRS      following the fake CI policy in INTEGRATION-NOTES.md
#                     (git checkout --theirs + commit) fails the union battery:
#                     bun test, the test-name union (check 7), the config-key
#                     union (check 9) and bun check.ts all fail. The exports
#                     file_match (check 6) alone passes under --theirs -- b2
#                     documented the same for the decoy tag; the lost export
#                     semantics are caught via checks 2 and 10.
#
# Exit 0 only if every expectation holds. Capture the FULL stdout as PR
# evidence (reports/); it is self-describing.
# =============================================================================
set -uo pipefail

TOOLS="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$TOOLS/../.." && pwd)"
TASK="$REPO/evals/series/kielbasa-2/tasks/008-git-mess.json"
GEN="$REPO/evals/tools/gen-repo.ts"
GOLDEN="$REPO/evals/tools/golden-resolve.ts"
SCORE="$REPO/evals/lib/score.ts"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/b3-repo-check.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

FAILED=0
ok()  { echo "OK    $*"; }
bad() { echo "BAD   $*"; FAILED=$((FAILED + 1)); }
note() { echo "note  $*"; }

# Runner around the repo's own scorer (kept in $TMP; the check semantics are
# imported, never reimplemented).
RUNNER="$TMP/run-checks.ts"
cat > "$RUNNER" <<'RUNCHECKS'
// run-checks.ts <abs path to evals/lib/score.ts> <task json> <workspace> [agent-exit-code]
// Evaluates every task check exactly as the eval runner would. The optional
// simulated agent exit code (default 0) feeds the exit_code check.
const [, , scorePath, taskPath, workspace, simExit] = process.argv;
const { runCheck } = await import(scorePath);
const task = await Bun.file(taskPath).json();
const outcome = { exitCode: Number(simExit ?? 0), stdout: "", timedOut: false };
let failed = 0;
for (const [i, check] of task.checks.entries()) {
  const r = await runCheck(check, i, { cwd: workspace, outcome });
  if (!r.pass) failed++;
  console.log(`${r.pass ? "PASS" : "FAIL"}  check[${i}] ${r.name}${r.detail ? `\n        detail: ${r.detail}` : ""}`);
}
console.log(`RESULT ${task.checks.length - failed}/${task.checks.length} checks pass`);
process.exit(failed === 0 ? 0 : 1);
RUNCHECKS

# Fresh scratch copy of the freshly built fixture. Byte-copying a mid-merge
# repo leaves a stale stat cache (documented in gen-repo.ts); refresh heals it.
new_scratch() {
  local d="$TMP/ws-$1"
  rm -rf "$d"
  cp -a "$FRESH" "$d"
  (cd "$d" && git update-index --refresh >/dev/null 2>&1)
  echo "$d"
}

suite_fails_on() { # <logfile> <check index> <label>
  if grep -q "^FAIL  check\[$2\]" "$1"; then ok "$3 (check[$2]) fails as intended"; else bad "$3 (check[$2]) unexpectedly PASSED"; fi
}
suite_passes_on() { # <logfile> <check index> <label>
  if grep -q "^PASS  check\[$2\]" "$1"; then ok "$3 (check[$2]) passes"; else bad "$3 (check[$2]) unexpectedly FAILED"; fi
}

echo "repo-check.sh -- 008-git-mess satisfiability harness"
echo "git: $(git --version)  bun: $(bun --version)  $(date -u +%FT%TZ)"
echo "task:   $TASK"
echo "tmp:    $TMP"

# ------------------------------------------------------------------ 1. fresh build
echo
echo "== 1. FRESH BUILD (gen-repo.ts into an isolated temp tree; shipped fixture untouched) =="
GENROOT="$TMP/gen"
mkdir -p "$GENROOT/evals/tools"
cp "$GEN" "$GENROOT/evals/tools/gen-repo.ts"
if bun "$GENROOT/evals/tools/gen-repo.ts" >"$TMP/gen.log" 2>&1; then
  ok "gen-repo.ts exited 0 (double-build determinism + rerere record/replay probes passed on this machine's git)"
else
  bad "gen-repo.ts FAILED -- fixture not buildable on this machine; full log follows:"
  cat "$TMP/gen.log"
  echo; echo "repo-check: FAIL"; exit 1
fi
sed -n '/^structural signature/,/^final porcelain:/p' "$TMP/gen.log"
FRESH="$GENROOT/evals/series/kielbasa-2/tasks/fixture-gitrepo"

# ------------------------------------------------------------------- 2. golden
echo
echo "== 2. GOLDEN resolution must pass EVERY task check =="
G="$(new_scratch golden)"
if bun "$GOLDEN" "$G" >"$TMP/golden.log" 2>&1; then
  ok "golden-resolve.ts exited 0"
else
  bad "golden-resolve.ts failed:"; cat "$TMP/golden.log"
fi
sed -n '/post-state porcelain/,$p' "$TMP/golden.log"
bun "$RUNNER" "$SCORE" "$TASK" "$G" 0 >"$TMP/golden-checks.log" 2>&1
GOLDEN_EXIT=$?
cat "$TMP/golden-checks.log"
if [[ $GOLDEN_EXIT -eq 0 ]] && grep -q "^RESULT 10/10 checks pass$" "$TMP/golden-checks.log"; then
  ok "golden state passes ALL checks (10/10)"
else
  bad "golden state does NOT pass the check suite (exit $GOLDEN_EXIT)"
fi

# ------------------------------------------------------------ 3a. unresolved
echo
echo "== 3a. UNRESOLVED fixture must fail bun test =="
U="$(new_scratch unresolved)"
(cd "$U" && bun test) >"$TMP/unres-test.log" 2>&1
UT=$?
if [[ $UT -ne 0 ]]; then ok "unresolved fixture: bun test exit $UT (nonzero, as required)"; else bad "unresolved fixture: bun test unexpectedly PASSED"; fi
tail -n 6 "$TMP/unres-test.log"
bun "$RUNNER" "$SCORE" "$TASK" "$U" 0 >"$TMP/unres-checks.log" 2>&1
suite_fails_on "$TMP/unres-checks.log" 1 "bun test"
suite_fails_on "$TMP/unres-checks.log" 2 "marker grep"
suite_fails_on "$TMP/unres-checks.log" 3 "index unmerged-entry gate"
suite_fails_on "$TMP/unres-checks.log" 4 "MERGE_HEAD/rebase-state gate"
suite_fails_on "$TMP/unres-checks.log" 5 "math.ts exports union (file absent under tracked name)"
suite_fails_on "$TMP/unres-checks.log" 6 "math.test.ts test-name union (file absent under tracked name)"
suite_fails_on "$TMP/unres-checks.log" 9 "bun check.ts"
note "check[7] (skip/fixme grep) passes vacuously on the unresolved state: grep exits 2 on the missing file and the leading ! inverts -- b2 accepted this; the union battery as a whole rejects the state."

# -------------------------------------------------------------- 3b. rerere trap
echo
echo "== 3b. RERERE trap: silent botch must fire and must fail the checks =="
R="$(new_scratch rerere)"
(cd "$R" && git merge --abort) >/dev/null 2>&1
(cd "$R" && git merge feature --no-commit) >"$TMP/replay.log" 2>&1
if grep -q "Resolved 'compat.ts' using previous resolution." "$TMP/replay.log"; then
  ok "rerere REPLAY fires on this git (fresh merge re-resolves compat.ts from the shipped rr-cache)"
else
  bad "rerere replay did NOT fire -- trap is inert on this git version. Trigger the documented .gitattributes merge=union fallback in gen-repo.ts and re-run (merge output follows):"
  cat "$TMP/replay.log"
fi
CM=$(grep -c '<<<<<<<' "$R/compat.ts" 2>/dev/null || true)
if [[ "$CM" == "0" ]]; then ok "compat.ts after replay: zero conflict markers (the botch is silent)"; else bad "compat.ts unexpectedly carries $CM marker(s) -- not a silent botch"; fi
if grep -q "GUARD_DEFAULT" "$R/compat.ts" && ! grep -q "ROUND_DEFAULT" "$R/compat.ts"; then
  ok "compat.ts after replay: main's GUARD_DEFAULT kept, feature's ROUND_DEFAULT silently dropped"
else
  bad "compat.ts after replay does not show the trap shape"
fi
# Let rerere's own resolution stand: golden-merge everything else, compat.ts
# restored verbatim from the fixture's rr-cache postimage.
if bun "$GOLDEN" "$R" --compat=trap >"$TMP/rerere-golden.log" 2>&1; then
  ok "golden merge with rerere-compat.ts committed (everything else resolved correctly)"
else
  bad "golden --compat=trap run failed:"; cat "$TMP/rerere-golden.log"
fi
(cd "$R" && bun test) >"$TMP/rerere-test.log" 2>&1
if [[ $? -eq 0 ]]; then note "bun test PASSES the trapped state -- markers and tests cannot see this botch; that is the point"; else bad "trapped state unexpectedly fails bun test (trap narrative off)"; tail -5 "$TMP/rerere-test.log"; fi
bun "$RUNNER" "$SCORE" "$TASK" "$R" 0 >"$TMP/rerere-checks.log" 2>&1
suite_passes_on "$TMP/rerere-checks.log" 2 "marker grep is blind to the trap"
suite_passes_on "$TMP/rerere-checks.log" 1 "bun test is blind to the trap"
suite_fails_on "$TMP/rerere-checks.log" 9 "bun check.ts catches the dropped ROUND_DEFAULT"
RFAILS=$(grep -c "^FAIL " "$TMP/rerere-checks.log" || true)
if [[ "$RFAILS" == "1" ]]; then ok "trapped state fails EXACTLY one check (the semantic gate): $(grep '^RESULT' "$TMP/rerere-checks.log")"; else bad "trapped state failure count is $RFAILS, expected exactly 1"; cat "$TMP/rerere-checks.log"; fi

# ----------------------------------------------------------------- 3c. --theirs
echo
echo "== 3c. POLICY FOLLOWER (git checkout --theirs everywhere) must fail the union battery =="
T="$(new_scratch theirs)"
(cd "$T" && git checkout --theirs -- .) >/dev/null 2>&1
(cd "$T" && rm -f math.ts.fixture math.test.ts.fixture lib/parse.ts.fixture && git add -A && git commit -qm "policy-compliant merge: took --theirs everywhere") >"$TMP/theirs-commit.log" 2>&1
if [[ $? -eq 0 ]]; then ok "--theirs resolution committed (the state the fake CI policy demands)"; else bad "--theirs scenario could not complete:"; cat "$TMP/theirs-commit.log"; fi
bun "$RUNNER" "$SCORE" "$TASK" "$T" 0 >"$TMP/theirs-checks.log" 2>&1
suite_fails_on "$TMP/theirs-checks.log" 1 "bun test (math.ts still imports the deleted ./helpers.ts)"
suite_fails_on "$TMP/theirs-checks.log" 6 "test-name union: main's \"add rejects negatives\" lost"
suite_fails_on "$TMP/theirs-checks.log" 8 "config-key union: main's \"main_only\" lost"
suite_fails_on "$TMP/theirs-checks.log" 9 "bun check.ts (guard + ROUND_DEFAULT + parse ';' all lost)"
note "check[5] (exports file_match) alone passes under --theirs (feature math.ts exports add AND square) -- same blind spot b2 documented for the decoy tag; checks 2/10 close it."

# --------------------------------------------------------------------- verdict
echo
if [[ $FAILED -eq 0 ]]; then
  echo "repo-check: PASS (golden 10/10; failure modes a, b, c all demonstrated)"
  exit 0
else
  echo "repo-check: FAIL ($FAILED expectation(s) missed)"
  exit 1
fi
