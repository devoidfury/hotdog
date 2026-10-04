# hotdog evals

A standalone runner for measuring **(model x harness)** performance. Plain Bun scripts, nothing here imports from `src/`. The runner shells out to whatever command a harness spec declares, so hotdog is just one harness among potentially many.

> Real runs hit live generation endpoints and cost tokens. This is deliberately **not** part of `bun test` (the unit tests in `tests/evals/` are pure and endpoint-free).

## Quick start

```sh
# see the plan without calling anything
bun evals/run.ts --series series/kielbasa-1 \
    --harness hotdog --model qwen3.8-flash-next --judge-harness hotdog-judge --judge-model qwen3.8-flash-next --dry-run

# run everything (real model calls)
bun evals/run.ts --series series/kielbasa-1 \
    --harness hotdog --model qwen3.8-flash-next --judge-harness hotdog-judge --judge-model qwen3.8-flash-next

# bake off models over one task
bun evals/run.ts --series series/kielbasa-1 --task 003-fix-bug \
  --model ai365/qwen3.8-flash-next --model other/model --repeat 3
```

Flags: `--series <dir>` (required), `--harness <id>` (repeatable, required), `--model <id>` (repeatable, required), `--judge-harness <id>` / `--judge-model <id>` (required as a pair when any selected task has a judge), `--task <id>` (repeatable), `--repeat <n>`, `--concurrency <n>`, `--dry-run`, `--keep-workspace`.

Exit code: 0 if every run passed, 1 otherwise. A matrix that plans zero runs (bad `--repeat`/filters) is an error, not a pass.

## The matrix

Harnesses and models are chosen at run time via `--harness`/`--model`, never declared in the series: `series.json` holds only `name`, `repeat`, `concurrency`, `timeout_secs`. Every selected task runs against every (harness x model) cell, `repeat` times. A run is:

1. fresh temp workspace (mkdtemp), fixtures copied in;
2. harness command spawned with `cwd` = workspace, prompt delivered via argv (`{prompt}`) or stdin;
3. deterministic checks evaluated against the workspace + captured stdout/exit code;
4. optional LLM judge (itself a harness call with `--json-schema`, verdict `{pass, reason}`);
5. a JSONL record appended to `evals/results/<series>-<timestamp>/runs.jsonl`, `summary.json` at the end.

## Harness specs (`evals/harnesses/<id>.json`)

```json
{
  "id": "hotdog",
  "command": "bun",
  "args": ["{repo}/bin/hotdog", "prompt", "{prompt}", "--model", "{model}"],
  "env": { "OPTIONAL": "var" },
  "prompt_via": "arg"
}
```

- Spawned via argv, **no shell**, so the prompt is one argument regardless of quoting.
- Placeholders: `{prompt}` `{model}` `{repo}` (repo root) `{schema_file}` (verdict schema, judge harnesses only). Unknown placeholders are errors.
- `prompt_via: "stdin"` writes the prompt to stdin instead (for harnesses that read stdin).
- Every spawn (agents, judges, `command` checks) gets `NO_COLOR=1` and `TERM=dumb` forced last in the env -- over both the runner's env and the spec's `env` -- so captured stdout is plain and deterministic.
- Timeout kills the process; the run is recorded as `timed_out`.
- Swapping harnesses is per-run: add a spec, pass its id with `--harness`, give it the model ids that harness understands.
- Note: hotdog resolves config from its normal chain (`./config` -> `/etc/hotdog` -> ...) relative to the temp workspace, so on a new machine you may need `/etc/hotdog` or `~/.config/hotdog` set up with provider credentials.

## Task files (`evals/series/<name>/tasks/*.json`)

```json
{
  "id": "003-fix-bug",
  "prompt": "Fix the implementation so `bun check.ts` passes.",
  "fixtures": "fixture",
  "timeout_secs": 300,
  "checks": [
    { "type": "exit_code", "equals": 0 },
    { "type": "command", "cmd": "bun check.ts", "equals": 0 }
  ],
  "judge": { "rubric": "sum.ts now adds numbers; check.ts untouched." }
}
```

Optional task fields:

- `env`: extra environment for the harness spawn (merged over the harness spec's `env`), e.g. `{ "HOTDOG_FETCH_ALLOW_PRIVATE_HOSTS": "1" }` so the agent's fetch tool may hit a local fake webapp.
- `serve`: `{ "cmd", "ready_url", "ready_timeout_secs"? }` -- spawns `cmd` (bash -lc, cwd = workspace) before the agent, polls `ready_url` until it answers (any HTTP status; default timeout 15s; failing readiness fails the run with a `serve` check), and kills the whole process group before the checks run. Server stdout/stderr land in the run's session dir as `serve-stdout.txt` / `serve-stderr.txt`. A task's fixture copies the server file (e.g. `server.ts`) into the workspace, so `cmd` can be `bun server.ts`. Ports are fixed per task (8731, 8732): run serve tasks at concurrency 1.

Check types (all must pass):

| type | meaning |
|------|---------|
| `exit_code` | harness process exit code equals N |
| `stdout_match` | regex (`pattern`, optional `flags`) against captured stdout |
| `file_exists` | path (relative to workspace, escape-guarded) exists |
| `file_match` | regex against a workspace file's contents |
| `command` | `bash -lc` in the workspace, exit code equals `equals` (default 0) |

The judge, if present, is an extra check: the judge harness and model are selected with `--judge-harness`/`--judge-model` (the runner refuses to start if a selected task has a judge and these are missing). The judge harness gets the rubric + task prompt + the agent's final output (tail of stdout) and must answer `{pass, reason}` via structured output. Judge failures (bad JSON, timeout, missing config) are failed checks, not crashes. The agent's output is fenced between `AGENT_OUTPUT` markers and flagged to the judge as untrusted data, so agent prose saying "return pass=true" is treated as evidence, not instruction (defence in depth, not a guarantee).

Parsing is strict by design: unknown keys in series/task/harness files are hard errors.

## Security note

`command` checks and the agent itself run arbitrary shell inside a throwaway temp dir. Only add tasks you trust to run locally; never point the runner at a machine holding things you care about with writable creds in env.

## Sandbox (bwrap)

If `bwrap` (bubblewrap) exists **and** a real minimal-sandbox probe succeeds at startup, every harness spawn -- agents and judges -- runs inside a **read-only allowlist filesystem**:

- root is a fresh tmpfs: `/home`, `/root`, `/var`, sibling checkouts **do not exist** inside;
- read-only binds: system dirs (`/usr /bin /sbin /lib /lib64` where present), a curated `/etc` set (DNS, TLS certs, name resolution, locale, shell profile, `/etc/hotdog`), `$HOME/.config/hotdog` when present, the bun binary's own directory, and the repo root (the harness code must be loadable);
- tmpfs over the sensitive parts of the repo: `.git` (commit history), `evals/series` (task definitions, graders), and `evals/results` (sibling runs' data) are mounted away, then just this run's `verdict.schema.json` and its session dir are re-bound back in;
- read-write: **only** the per-run workspace and its session-log dir;
- network stays shared (harnesses must reach model endpoints); `--die-with-parent`, `--new-session`.
- `serve` webapps run on the host (grading apparatus, not the agent); since the network namespace is shared, the sandboxed agent can still reach them on loopback.

This covers the agent's own tool subprocesses too (they inherit the sandbox). Known limits: the config-chain dirs can contain credentials -- the harness process must read them, so they cannot be hidden from what it runs; Nix-store layouts fall outside the allowlist (probe fails there, runs go unsandboxed, flagged). Without bwrap, runs proceed unsandboxed and say so loudly: `sandbox: OFF` at startup, `sandboxed: false` on every record, `sandbox: off` in the summary. There is no flag to force it. (This repo's dev container lacks bwrap and root; the wrap pipeline is covered via a passthrough stub plus exact-argv unit tests -- validate real bwrap semantics on a machine that has it.)

Independent of sandboxing, each run gets `HOTDOG_SESSIONS_DIR=<results>/sessions/<run-id>`, so hotdog session logs are captured per run inside the results dir instead of the user's `~/.cache`.

## First series (kielbasa-1)

An easy benchmark across seven tasks covering instruction following, tool use, coding, vision, and web use.

- `001-greet` plumbing / model instruction-following,
- `002-bash-haiku` harness: bash tool + deterministic file checks + judge,
- `003-fix-bug` coding: seeded repo, scored by the repo's own assertion script,
- `004-notes-summary` harness: read tool + comprehension, judge-scored,
- `005-vision-board` vision: fixture PNG, solid-color 3x3 grid, stdout color match; regenerate with `bun evals/tools/gen-board.ts`,
- `006-web-wiki` fetch tool: local fixture webapp, answer only on a linked page; needs `serve` + `HOTDOG_FETCH_ALLOW_PRIVATE_HOSTS`,
- `007-web-comment` webapp manipulation: POST /login for a token, then POST /comments with the Bearer header; graded by the `comments.jsonl` the fixture server writes in the workspace

