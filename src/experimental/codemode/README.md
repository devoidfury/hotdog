# codemode (experimental)

One model-facing tool, `codemode`: the model writes a JavaScript **program**,
the harness runs it in a fenced subprocess, and the program's
`tools.<name>({...})` calls round-trip to the host and ride the **ordinary
tool pipeline** (gate, approvals, durability, caps, logs). One `codemode`
call replaces a sequence of model↔tool round trips. While loaded, codemode
**shadows** the other tools -- they leave the model's declaration list but
stay fully callable from inside scripts. Opt-in: nothing loads until the user
adds `@experimental` to `extensionPaths` (which **replaces** the default
`@extensions` list, so keep both).

```json
{ "extensionPaths": ["@extensions", "@experimental"] }
```

Loading is the outer opt-in; **enablement** is a chain: a profile's
`codeMode` bool (front matter / in-config profile) beats the global
`codeMode.enabled` config default (**true**), per agent. `enabled: false`
with no opting-in profile means the `codemode`/`head`/`tail` defs leave the
wire, no prompt chunk renders, and the shadow never fires -- per-request, so
a profile switch lands on the next turn. Non-boolean profile values are
ignored (a typo'd `codeMode: "yes"` never reads as false). Unloaded means
byte-identical tool defs.

```json
{ "codeMode": { "enabled": false } }
```
```markdown
---
codeMode: true
---
```

Three tools register: `codemode` (the runner) and `head` / `tail` (below). A
`SYSTEM_PROMPT_BUILD` chunk carries the usage guidance and the shadow
inventory; nothing renders for a disabled agent or when the extension is not
loaded.

## The envelope

`{ code, timeout_ms?, max_output_chars? }` -- `additionalProperties: false`,
an invented key is a schema error, not silently carried.

- `code`: plain JavaScript (not TS), run as the **body of an async
  function** -- top-level `await` and `return` work.
- `timeout_ms`: wall-clock deadline. Default 60 000; host ceiling 300 000.
  Non-integer / zero / negative values are refused pre-execution with a
  schema error; values above the ceiling are **clamped down, never honored**.
- `max_output_chars`: output characters kept (head + tail). Default 40 000,
  and the default **is** the ceiling -- it can only be lowered.

Envelope params can tighten the host defaults, never loosen them. The
approval memo keys the **whole canonical envelope** (see Approvals): the same
script with a different `timeout_ms` is a fresh ask.

## Globals in the script

| Global | One-liner |
|---|---|
| `await tools.<name>({...})` | Calls the host tool; resolves to a string (a `hint` folds after it), rejects on failure -- including a user denial, which the script can `catch` and branch on. A parameter-validation rejection also carries the expected parameter names with requiredness plus a `describeTool(name)` pointer (512-char budget: on wide defs the list is a prefix plus `...`; the pointer survives truncation) -- the direct schema is shadowed out of the model's context, so the rejection itself says what fits. |
| `searchTools(query, limit?)` | Discovery: exact domain first, else case-insensitive substring over name + description + tags; resolves to `{name, description}` rows, default limit 8. |
| `describeTool(name)` | The declaration sample: def description + each parameter's type, description, requiredness. Unknown or policy-outside name → `null` with a `searchTools("<fragment>")` pointer. |
| `text(v)` | Coerce and emit into the output stream. |
| `console.log(...)` | Streams to the host's output blocks. |
| `return <value>` | The script's final value, rendered into the output tail. |
| `exit()` | End the run early (success). |
| `store(key, value)` / `load(key)` | JSON values in the run store; writes **commit only on script success**. Quotas below. |
| `callsRemaining()` | Tool calls left against the 255-per-script cap: full when unused, charges at call time (in-flight counts, meta/store/load never charge), floors at 0. Plan batches up front instead of discovering the cap mid-run. |

No `image()`, no `models.*`: inner-call **images are dropped** with the
visible note `[image from read omitted: not supported inside codemode]` --
a text bridge in v1.

## Caps (constants, not config)

| Cap | Value | Notes |
|---|---|---|
| Wall time | 60 s default / 300 s ceiling | `timeout_ms` may lower, ceiling clamps down. |
| Inner tool calls | 255 per script | Not parameter-tunable; exceeding **errors the call**, not silently (the error names applied-vs-limit; applied calls are not undone). `callsRemaining()` reports the budget from inside the script. |
| Script output | 40 000 chars kept / 16 MiB streamed / 100 000 items | Kept = head + tail around one elision marker naming the run journal that holds the full bytes; streamed past the hard caps the **child is killed** (the host keeps all output until the script ends, so the child enforces). |
| NDJSON frame | 1 MiB both directions | A quarter of the exec-wire bound `MAX_FRAME_BYTES` (4 000 000); an oversize frame kills the child with a protocol error. |
| Live children | 2 per process | The third waits FIFO 60 s, then errors "all runners busy". |
| Inner concurrency | 4 in-flight dispatches per script | Overlap (`Promise.all`) is allowed; a 255-way fan-out at the gate is not. |
| `store` | 256 KiB/value, 1 MiB total, 1 KiB key, 4096 entries | JSON only; commit-on-success semantics. |
| `searchTools` limit | default 8 | Explicit limits below 1 or non-finite fall back to 8. |
| head/tail window | 64 KiB chunks, 8 MiB total scan | See the head/tail section. |
| Digest | ≤ 256 rows, 8 KiB args/call, 32 KiB args total, 500-char errors, `(...and N more)` tail | Capped separately from the script-output budget. |

## What comes back to the model

One tool result. Success: a header `Script completed -- wall 3.2s -- fence:
bwrap`, the script's output blocks (each under an explicit `==> text N/M <==`
boundary), then a host-minted `Tool calls (host-recorded):` digest -- one
line per inner call and per meta-op (`searchTools(...)` queries are
host-recorded too). Failure: partial output, the error, and the tail
"Tool calls made before the failure (they are not undone): read(ok)
bash(error: exit 1) …" (meta ops excluded -- nothing to un-undo).
A script printing a fake digest is bytes inside its own output block;
the host defangs its marker tokens at the section boundary, so script text can
never pose as digest structure. The result rides the ordinary cap stack
(`maxToolResultChars`).

## The fence

The script runs in a **fenced `bun` child**: the same OS jail the exec plane
ships (`planFor` -- bwrap on Linux, seatbelt on macOS; tmpfs root, ro system,
rw only session roots + scratch, no `$HOME`, no config chain, private pidns,
`--die-with-parent`). Probe-and-degrade: if no backend is available the run
still happens plain, **reported** -- every result header names the backend
(`fence: bwrap|seatbelt|absent`), never silently. Jailed env is `PATH`/`LANG`
via `setEnv`; the degrade path uses `copyScrubbedEnv` (provider keys are in
no env var the child can read either way). Timeout and cancel kill the
process group; a killed child releases its admission slot on actual exit.
Per-run scratch and the append-only `run.jsonl` journal (fsync-before-dispatch)
live under `<data-dir>/codemode/<runId>/`.

The posture: **the script is a bash command with better syntax -- same fence,
same blast radius, same approval triage of the program text.**

What the fence does **not** protect:

- **The fenced filesystem and the shared network are reachable by the script
  directly** (bypassing inner calls): rw session roots, shared net. Inner-call
  gating covers *tool* effects only; `fetch(...)` inside the script is
  bash-with-JSON. Mitigations: the whole-script approval gate, fence-state
  honesty in every header, the same operator rule language that guards bash.
  (`--unshare-net` is reserved for a future `no-net` fence class; not here.)
- **The JS realm inside the child is not a boundary** -- `import("node:fs")`
  works there; the boundary is the OS jail.
- **Tools executing in the host on the program's behalf** are as privileged
  as the model's own calls -- that is the design: the child holds *no*
  authority; every frame passes the host gate anew (validation, approval,
  durability, cap, log).

## Shadow posture

While the extension is loaded, a `PROVIDER_REQUEST` handler subtracts shadowed
defs from the wire declaration. Zero core: nothing in `src/core/` learns a
shadow exists (pinned by `tests/lints/no-codemode-in-core.test.ts`).

- **Trigger:** the filter fires on a request iff its own def array already
  carries `codemode`. An agent whose profile filtered codemode out is
  untouched -- the model never loses a tool in a request that does not offer
  the alternative.
- **Pure subtraction:** `out = defs.filter(...)`, so the hook can never
  re-add what sandboxMode / maxToolDifficulty / whitelist / blacklist
  removed. Policy ⊇ shadow, both directions tested: a policy-filtered
  name is unreachable from **both** surfaces -- the model bounce *and*
  in-script dispatch.
- **Both surfaces, one set:** a shadowed model call bounces as "not
  available" (candidates drawn only from the offered set -- never pointing
  at another shadowed tool), while script-initiated dispatch re-derives the
  **pre-shadow** policy-filtered view: a shadowed tool stays fully callable
  inside a script.

**Keep-direct list** (everything else is shadowed, other extensions' and MCP
servers' tools wholesale):

| Tool / class | Kept because |
|---|---|
| `question` | The human channel; the ask-the-user contract. |
| `wait` | Manager-turn stop-loop contract; the turn's terminal signal cannot ride a script. |
| `handoff` | Harness exit path (`TURN_END` detection keys on it). |
| manager class: `delegate_task`, `task_status`, `task_followup`, `task_interrupt`, `plan_status`, `workflow_validate/dispatch/status/followup/control`, `review` | Lifecycle/orchestration turn contracts, not data ops. |
| `load_skill` | The skills preamble chunk gates on the def set and is blind to a payload shadow. |
| `model` | Session config surface; nothing to script. |
| file-mutation ops: `edit`, `overwrite`, `append` | Argument-size writes: the content crosses context as the argument on either surface, so a script buys zero filtering and charges escaping hazards plus whole-file replay after a mid-script failure. Reads stay shadowed -- their output is the expensive, filterable side. |
| anything `pinned` | Run-contract tools (structural rule via registry metadata; the exemption covers the hook leg only). |
| `codemode` | The entry point (also self-excluded from the callable table). |

**Recovery when the model calls a shadowed tool anyway:** the generic
not-available bounce plus the system-prompt chunk -- which names the exact
shadowed inventory and the substitution rule ("script it as
`tools.<name>({...})`") -- recovers the turn in one retry. No core error text
changes. **Wire stability:** the shadow changes the wire set only at
load/unload or registry/policy changes, never iteration-to-iteration (the
keep-direct list is a code constant); pinned by test.

## Discovery

The tool description carries a **constant-size domain index** (buckets +
counts + an `untagged` bucket -- MCP tools are deliberately untagged and get
no synthesized bucket; the substring half of `searchTools` is their discovery
path). `searchTools` / `describeTool` are **host-side meta ops** (frames, not
registry invocations): they read the same policy-filtered set as script
dispatch (discovery ⊆ policy in both directions), are read-only, pay no gate,
and land host-recorded in the digest and run journal. Detail surfaces inside
script output, billed against `max_output_chars` -- not in every request.

## head / tail

`head(path, { lines = 200 })` / `tail(path, { lines = 200 })`, `lines`
integer 1..10 000. Real read-only tools (`sideEffects: false`, difficulty 1,
tags `files`+`utility`), registered by the extension and shadowed like
everything else while the shadow is on -- invisible to the model, fully
callable from scripts. Posture mirrors `read`: plain line output, meta
entries `path` + `showing`; head reports `"1-N (of T total)"` at EOF or
`"1-N (more exists)"`, tail reports `"last N lines (window starts at byte
B)"` and deliberately no total line count (getting it would mean the
whole-file pass the tool exists to avoid). Implementation is seek-from-EOF
(backwards) / forward chunked reads, 64 KiB growing ×4, total scan capped at
8 MiB with an honest "window capped at B bytes" degrade; large logs narrow
the window, they never refuse outright. Paths go through the same
`resolveToolPath` → `Workspace.resolveSafe` boundary (roots
+ denylist, lexical and realpath) that read/grep/bash use; binary content is
refused with a pointer to `read` (which handles images).

## Approvals

Two gates, both pre-existing mechanisms:

1. **The whole script, at approve time.** The approvals table
   (`src/utils/approvals/index.ts`) treats `codemode` like
   `agent_browser.evaluate`: the **script text is the target**,
   `bailOnToolAllow` -- a blanket tool-level `allow: ["codemode"]` never
   admits an unseen script, and `userGate.default: "allow"` cannot let it
   through; only a `codemode.script=<glob>` param rule or a human at the
   prompt does. The session memo keys the **canonical JSON of the whole
   argument envelope as requested** (`code` + the requested options,
   pre-clamp), so "allow for session" covers that exact envelope; a changed
   deadline or output cap re-prompts once, and two envelopes that would clamp
   to the same run are still two asks. This is the only mediation point for
   the fence's residual hole (direct fs/net from the script).
2. **Every inner call, individually.** Inner calls run the real `TOOL_CALL`
   gate: a mutating inner call prompts exactly as a model-issued one, with
   parent attribution in the prompt header -- `inner call from codemode
   <tool-call-id>`, where `<tool-call-id>` is the dispatching
   codemode tool call's own id, not the bridge run id (a parent whose name
   the gate cannot read shows as `inner call from parent call
   <tool-call-id>`) -- while read-only calls pass under the default
   rules (a fan-out
   script is not 60 prompts). A denial is a rejected Promise the script can
   catch -- and the digest shows the denial either way. A held inner
   question rides the open parent row; parented `question_asked` records are
   **not** journaled (a parented pending question would replay as a live
   prompt with no call to answer), and the script's deadline or an abort
   releases the prompt fail-closed: the call is denied.

Durability: inner dispatch fsyncs its own `tool_started` barrier before any
side effect, and answers land as `nested_tool_result` audit records keyed by
the inner id with `parent_tool_call_id` -- never replayed into the
conversation, and the session-log index mirror closes on them like it does on
any `tool_result`. A cold log answers "what actually ran"; the run journal answers
"with what bytes". A crash mid-script classifies at the retry unit exactly
like a mid-bash crash (outcome-unknown parent; the model re-decides on
resume -- inner calls are never blind-re-run).

## Display

Inner calls emit the existing `tool_call`/`tool_result` events carrying
`parentToolCallId`; the interactive CLI renders them as indented
`↳ read ✓ 12ms` rows under the open codemode row (orphaned rows from old
logs are skipped-tolerant, never a render break). The `codemode` call itself
shows the script through the display DSL. The webui has no nesting model
yet: parented events render as ordinary top-level frames there, or browse
skips them -- no break either way (pinned).

## Graduation

To `src/extensions/codemode/` (directory move + autoload flip) when, and
only when: (i) both generic core seams (the nested-call dispatcher, the
`nested_tool_result` log source) have shipped and been consumed unchanged
across real sessions; (ii) the eval series
(`evals/series/codemode-1/README.md` -- how to run it) shows the
batch/round-trip win on multi-tool tasks; (iii) display + approvals are done
for the terminal sink *and* one remote sink; (iv) the owner accepts
default-off-but-shipped; (v) the shadow posture has been eval'd for the
habit mismatch (profiles and prompts that name shadowed tools).
Until (v) passes, this stays experimental-tier-only.

## Tests

`tests/extensions/codemode*.test.ts` (envelope/index/chunk, fenced host with
probe-gated live runs, bridge/caps/digest/journal, gates + approvals,
shadow precedence law, discovery, head/tail),
`tests/core/nested-tool-call.test.ts` (the dispatcher seam),
`tests/extensions/ui-interactive-cli-nested.test.ts` (the nested rows), and
`tests/lints/no-codemode-in-core.test.ts` (the leak guard: the string
"codemode" appears nowhere under `src/core/` -- comments included -- and the
negative probe proves the guard bites). Live-fence tests skip-and-report
when bwrap/sandbox-exec is absent; the degrade path pins the `absent`
honesty either way.
