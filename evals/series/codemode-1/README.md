# codemode-1 -- the graduation eval series

Multi-tool orchestration tasks run A/B across two harness arms. This is the
evidence gate for graduating codemode out of `src/experimental/`: the
batch/round-trip win on real tasks, and the shadow habit mismatch. Real
generation endpoints -- **owner-gated**, never part of `bun test`, nothing
here runs without you invoking the runner.

## The arms

| Harness spec | What it loads |
|---|---|
| `hotdog` | the shipped default set (no codemode; every tool declared) |
| `hotdog-codemode` | the same set **plus** `@experimental` via `HOTDOG_CONFIG_DIR={repo}/evals/configs/codemode` -- codemode on: shadow active, `codemode`/`head`/`tail` registered |

The arms differ ONLY in `extensionPaths`. Provider/model/profile resolution
must be identical, so seed the codemode arm's config from YOUR config before
running (the checked-in starter carries `extensionPaths` alone and NO
secrets -- keep it that way, and never commit the seeded copy):

```sh
jq '.extensionPaths = ["@extensions", "@experimental"]' \
   ~/.config/hotdog/defaults.json > evals/configs/codemode/defaults.json
```

Posture check without spending tokens (no endpoint touched):

```sh
# Baseline = an ISOLATED config dir (your own ambient config may already opt
# into @experimental; an isolated dir is the honest control):
mkdir -p /tmp/codemode-ab/base /tmp/codemode-ab/cm
echo '{ "extensionPaths": ["@extensions"] }' > /tmp/codemode-ab/base/defaults.json
echo '{ "extensionPaths": ["@extensions", "@experimental"] }' > /tmp/codemode-ab/cm/defaults.json
HOTDOG_CONFIG_DIR=/tmp/codemode-ab/base HOTDOG_MODEL=<m> bun bin/hotdog show-prompt
HOTDOG_CONFIG_DIR=/tmp/codemode-ab/cm    HOTDOG_MODEL=<m> bun bin/hotdog show-prompt
# expect: base -> no codemode chunk, no codemode/head/tail defs;
# cm -> the "## codemode" chunk incl. the shadow inventory, and tool defs
# for codemode + head + tail in the list. NOTE: show-prompt renders
# agent.getToolDefs() (the policy-filtered set, PRE-shadow) -- shadow is a
# PROVIDER_REQUEST payload-layer narrowing, so the direct defs still show
# here by design; the wire subtraction itself is pinned by
# tests/extensions/codemode-shadow.test.ts, not by this CLI view.
```

## Run it

```sh
# plan first (zero calls)
bun evals/run.ts --series series/codemode-1 --harness hotdog --harness hotdog-codemode \
    --model <m> --repeat 3 --dry-run

# the sweep (real endpoints, real spend)
bun evals/run.ts --series series/codemode-1 --harness hotdog --harness hotdog-codemode \
    --model <m> --repeat 3
```

`--repeat 3` minimum: the metric is a distribution, not a point. Keep the
working tree clean for comparable cells (`harness_rev`/`harness_dirty` are
stamped on every record; mixed revs are called out by the summary).

## The tasks

| Task | Shape | What it stresses |
|---|---|---|
| `001-line-tally` | 3 log files + a decoy; per-file counts + total | dependent reads + arithmetic collapsed into one script |
| `002-log-triage` | recursive ERROR aggregation across 3 dirs, exact-marker semantics | fan-out search + filter + sort + write |
| `003-migrate-bulk` | uppercase 5 files + sorted manifest, originals intact | long read/transform/write chains |
| `004-shadow-habit` | trivial sum, but the PROMPT names the `bash` tool | under the codemode arm `bash` is shadowed; the model must recover through the system-prompt correction (script it, or use the remaining surface) |

## Reading the result

Pass/fail per cell comes from the runner (deterministic checks; exit code of
the sweep = all green). The DELTAS are read from each run's session log,
which the runner keeps at `evals/results/<dir>/sessions/<run_id>/*.jsonl`
(`run_id` is on every `runs.jsonl` record):

```sh
LOG=$(ls evals/results/<dir>/sessions/<run_id>/*.jsonl | head -1)

# model round trips -- one token_usage record per model response:
jq -s '[.[] | select(.source=="token_usage")] | length' "$LOG"

# billed session tokens (last cumulative snapshot; cached split included):
jq -s '[.[] | select(.source=="token_usage")] | last
       | {in: .sessionPromptTokens, cached: .sessionCachedTokens, out: .sessionCompletionTokens}' "$LOG"

# tool effects: top-level dispatches vs script-dispatched inner calls:
jq -s '[.[] | select(.source=="tool_started")] | length' "$LOG"
jq -s '[.[] | select(.source=="nested_tool_result")] | length' "$LOG"

# shadow bounces (004 under the codemode arm): how often a direct call for a
# shadowed tool hit the not-available error before the model scripted it:
grep -c "is not available" "$LOG" || true
```

Wall time is already per-record in `runs.jsonl` (`duration_ms`).

**Pass bar -- graduation item (batch/round-trip win):** on tasks 001-003,
the `hotdog-codemode` arm passes everything the baseline passes, with FEWER
model round trips per task (the headline number), fewer billed input tokens
per task (`sessionPromptTokens`), and equal-or-better wall time. Inner-call
counts should light up under the codemode arm (`nested_tool_result` > 0): a
pass with zero inner calls means the model ignored the feature and the delta
is noise.

**Pass bar -- graduation item (shadow habit mismatch):** `004-shadow-habit`
passes under the codemode arm with at most one bounce-to-recovery per run --
the prompt named a shadowed tool and the chunk correction still landed.
Repeated bounce-loops or failures here are the habit mismatch graduation
waits on; also dogfood real profiles that name shadowed tools alongside this
task.

Honest caveats: provider prompt caching discounts an unchanged declaration
prefix, so the steady-state token win of shadowing is context attention and
routing clarity more than billed tokens -- compare the `cached` split, not
just totals; and a fresh short task under-rewards round-trip collapse, so
weight reading toward 002/003 (multi-step chains).
