# CLI Reference

User-facing reference for subcommands, CLI flags, and interactive slash commands. For how extensions register subcommands, see [cli-subcommands.md](cli-subcommands.md).

## Subcommands

```
hotdog                           # Interactive CLI (default)
hotdog prompt "your prompt"      # One-shot mode
hotdog -p "your prompt"          # One-shot mode (shorthand)
hotdog info                      # System diagnostics
hotdog show-prompt               # Render system prompt to stdout
hotdog profiles                  # List all available profiles
hotdog sessions show             # Show session logs
hotdog sessions delete <id>      # Delete a session (+ its baton mirror)
hotdog sessions cleanup          # Remove old sessions; also reclaims leaked
                                 # <id>.baton.json mirrors (paired mirrors go
                                 # with their session; orphaned mirrors whose log
                                 # is gone go once past the same --older-than cutoff)
hotdog rescue                    # Diagnose config files (paths, syntax, unknown keys, out-of-set enum values)
hotdog rescue fix                # ...and repair: strip comments/trailing commas, reset out-of-set enums to their schema default (.bak kept)
hotdog rescue --json             # ...as a JSON envelope (stdout pure JSON; findings, files, totals)
hotdog webui                     # Start the web UI server
hotdog workflow validate <f> [--param key=value]...
                                 # Validate a .workflow.yaml graph (errors + warnings, exit code).
                                 # --param values resolve {{params.x}} refs
                                 # (validate/render lenient, run is strict: required params without a value fail)
hotdog workflow render <f> [--param key=value]...
                                 # Deterministic topological rendering of a workflow
hotdog workflow run <f> [--id <run-id>] [--param key=value]...
                                 # Execute a workflow graph (foreground; Ctrl-C cancels gracefully).
                                 # --id re-runs a previous run dir, reusing filesystem-verified nodes
                                 # (refused while another live process owns that run dir)
hotdog workflow list             # List runs under <workflows.path>/runs
                                 # Runs whose owner died (no terminal event, stale/absent .owner)
                                 # are named "interrupted (resumable: run --id <run-id>)"
hotdog workflow status <run-id>  # Node states from a run's run.jsonl (works cross-process)
hotdog workflow reconcile <run-id>
                                 # Check completed claims against the filesystem (resume planning)
hotdog workflow cancel <run-id>  # Finished runs: idempotent report; live runs owned by another
                                 # process must be stopped there (Ctrl-C / '/workflow cancel')
                                 # The manager's workflow_control tool (action cancel) shares this
                                 # in-process ceiling: it only stops runs the calling session's
                                 # process dispatched, and refuses foreign owners with this pointer
```

## Exit Codes

```
0    success. Also what `webui` exits with after a graceful SIGINT/SIGTERM
     drain: its handler intercepts the signal, so a completed shutdown is
     reported as success
1    runtime failure (includes subcommands reporting problems, e.g. rescue findings)
2    usage error in the parse phase (unknown flag, unknown subcommand,
       missing or non-numeric flag value) -- getopt convention, so scripts
       can tell "invoked wrong" from "run failed"
130  killed by SIGINT during a one-shot run (Bun default signal death: no
       SIGINT handler is registered there). Interactive Ctrl-C cancels the
       turn instead of exiting
143  killed by SIGTERM (same default semantics, outside webui's drain)
```

Rejected argv tokens are echoed spoof-safe: terminal escapes and bidi marks
render as `[U+XXXX]` tokens, raw bytes never reach the terminal.

## CLI Options

```
-f, --config <path>          Config file path
-d, --config-dir <path>      Config directory
-m, --model <name>           Model name
    --ai-url <url>           AI backend URL
-k, --api-key <key>          API key
    --profile <name>         Profile name
    --provider <name>        AI provider name
-p, --prompt <text>          One-shot prompt
    --sandbox                Sandbox mode: only allow tools without side effects
    --tool-exec <mode>       Tool execution plane: worker (tagged tools run in pooled out-of-process executors) or inline (everything in-process)
    --exec-fence <policy>    Fence for pooled executors: probe (jail when the platform supports it) or off (plain spawn)
    --disable-env-scrubbing  Pass the full environment to subprocesses (bash tool, MCP stdio) without secret scrubbing.
    --shell-mode             Execute lines starting with a recognized system command directly in interactive mode
                               Tip: append | @ to send command output to the agent (e.g., "ls -la | @", "ls -la | @ show me the permissions")
    --no-markdown            Disable markdown highlighting of assistant prose on the split renderer (config uiInteractiveCli.markdown; on by default)
-l, --loud                   Print full JSON API responses
--json                       Output as JSON for the subcommands that support it (info, profiles,
                               sessions, rescue); stdout carries only the JSON, diagnostics go to stderr
    --json-schema <json|path>  One-shot structured output: a JSON Schema (inline or file path); the run ends when the model returns a valid payload, printed as bare JSON
--show-tools                 Show tool calls in output (default; overrides hideTools)
--show-thinking              Show reasoning/thinking output
--no-colors                  Disable colors (also honors NO_COLOR / TERM=dumb env)
--hook-trace                 Trace hook execution (requires debug level: HOTDOG_LOG_LEVEL or config logLevel)
-v, --version                Show version
-h, --help                   Show help
```

## Slash Commands (Interactive Mode)

```
/help              Show available commands
/quit, /exit       Exit
/redraw            Purge scrollback and reprint the transcript (split renderer; ctrl-l also works)
/clear             Clear conversation history
/undo              Undo the last turn (turn-based: user message + everything after it)
/rewind [N]        Cut to absolute visible message #N (keep #N, drop everything
                   after); bare /rewind cuts exactly one back, same as /rewind -1
/rewind -N         Cut N visible MESSAGES back (the status row's #N numbering)
/fork [-N | N] [prompt]
                   Branch a new session: N branches after visible
                   message #N, -N messages back, omitted = fork the head;
                   optionally send a prompt there
                     Fork auto-switches to the new session; the original stays
                     attached (interactive/switch-capable UIs)
/loop <prompt>     Repeatedly run a prompt until cancelled
/model <name>      Switch model
/models            List available models
/profile           List profiles (current marked)
/profile <name>    Switch profile (also: /profile:<name>)
/tokens            Show token usage stats + context-window fill gauge
/tools             Toggle tool call display
/tools list        List registered tools with their domain tags
/compact [n]       Compact context
/compact <strategy>  Switch compaction strategy (also: /compact:<strategy>)
/prompt:name       Execute saved prompt from prompts directory
/skill             List available skills
/skill:<name>      Activate a skill
/thinking          Toggle thinking display
/theme <name>      Set theme (dark, light, monochrome)
/regenerate        Regenerate system prompt
/reasoning <level> Set reasoning effort (none/minimal/low/high/xhigh/max/unset)
/fence on|off|status  Runtime exec-fence toggle for THIS session (worker plane)
```

The visible-message index (the status row's `#N`)
-------------------------------------------------

`#N` numbers every message you see as conversation: USER_INPUT (your prompts,
including steering) and ASSISTANT_RESPONSE (assistant messages with text).
Tool results, the system prompt, harness notices, and tool-call-only assistant
messages are never numbered. The numbering is assigned as messages enter the
context and never reused: after a rewind the dropped numbers stay spent (the
next message continues above them), and compaction swallows the oldest numbers
entirely. So a stale number -- one cut away by a rewind, swallowed by
compaction, or past the newest message -- always errors with the valid range
named, and never silently cuts at a nearby message.

A cut keeps through the addressed message and drops everything strictly
after it -- whatever role that trailing content has. Its answered tool
results ride along with it (a cut never splits a tool call from a result);
everything past the end of that block goes: tool traffic, harness notices,
system reminders, compaction remnants. No stray entry of any role ever
dangles past the kept boundary, on `/rewind` and `/fork` and on `/undo`'s
turn trim alike. Example transcript:

```
#1  you:      fix the flaky test
              [call: read_file] [result]        <- tool traffic, unnumbered
#2  assistant: reading it now, one call left    (narration + tool call)
              [call: edit_file] [result]
#3  assistant: fixed -- the assertion was inverted
#4  you:      thanks, run the suite            <- status row reads #4
```

`/rewind 2` (or `/fork 2 [prompt]`) keeps through #2 (and its tool
results), dropping #3 and #4; `/rewind -1` (or `/fork -1`) drops the last
visible message and everything trailing it; bare `/rewind` cuts exactly
one message back -- the same cut and the same report as `/rewind -1`;
`/fork` alone branches the head. The absolute form also accepts a leading
hash, so `/fork #5` means `/fork 5` (sugar for the status row's `#N`).
Bare `N` addresses a visible index,
`-N` goes back N messages, and both commands resolve the number through
the same resolver, so one number means one boundary everywhere. The
deliberate split: `/undo` is the TURN-based undo (the last user message
plus everything after it, always exactly one turn); `/rewind` cuts by the
visible-message index. The old turn-count reading of bare `N` and the
`index N` keyword are retired -- `/rewind index 2` is an invalid argument,
not an alias for `/rewind 2`.

A `/fork` prompt whose FIRST token is a digit parses as the index spec:
`/fork 404 handling` branches at message #404 with the prompt "handling",
not a session forked from the head with the prompt "404 handling". Text
that must reach the fork verbatim cannot begin with a bare number.

`/fence` is runtime-only and never written to config, and it is session-scoped:
it changes the exec-fence policy of the CALLING session only. `on` maps to
`probe` (jail when the platform supports it), `off` to plain spawn, `status`
prints this session's live posture plus its override state and what the boot
config said. Every on/off change is a logged transcript notice on the toggled
session's log (it stays the audit trail; switching `off` states plainly that
tool code runs UNFENCED from the next spawn). Sessions that never toggle --
including future subagent sessions -- follow the boot config; a restart returns
every session to it. `hotdog info` reports the boot posture and, when runtime
overrides exist in its process, one extra line enumerating them (session id +
policy). On an inline plane the toggle refuses -- there is no pool to fence.

The webui carries the same toggle in its header strip: when the attached
session's posture shows a worker-plane fence, `tools: worker (fence: …)` is
click-to-toggle for the attached session only. Flipping `off` -> `probe`
applies directly; `probe` -> `off` requires an explicit confirm naming the
UNFENCED consequence (the webui's confirm idiom). The click sends a session-
scoped websocket message that the server authorizes like every other session-
scoped control -- authenticated socket, and the frame must name a live session
of this server -- and it lands through the same `/fence` helper, so the
toggled session's transcript gets the same audit notice. Like `/fence` it is
runtime-only: nothing is persisted, other sessions follow the boot config, and
a restart returns everything to it. Inline/degraded postures and log view keep
the strip inert; typing `/fence` as a chat command in the webui still prints
the honest fallback pointing at the interactive CLI (the toggle's wire path is
the header click, not the chat command).

## Interactive Input Behavior (split renderer)

With the split renderer mounted (`uiInteractiveCli.renderer: "split"`, a TTY
stdin+stdout, TERM not `dumb`):

- **Enter steers mid-run.** A submitted line while the agent is running is
  injected as steering -- delivered before the model's next LLM call
  instead of waiting for the turn to end. At idle it simply starts the next
  turn, and lines carrying images always queue normally. While a steering
  submission is still undelivered the frame shows a chip row:
  `↑ queued: <first 40 characters>`.
- **Esc / Ctrl-C interrupt**, never steer: the turn is cancelled, pending
  steering is untouched, the question/approval prompt (if any) releases the
  input. Ctrl-D on an empty buffer quits.
- **Status line** (top frame row) mirrors the webui footer, with every
  segment gated on what the session has actually attested (no number is
  ever invented). It leads with the visible-message index (`#N`, the newest
  message's number in the USER_INPUT + ASSISTANT_RESPONSE counting described
  above -- owner ruling: the row's number counts those messages, and it is
  the number `/rewind N` / `/rewind -N` / `/fork N` / `/fork -N`
  address). During a turn it reads `#4 · working · 00:12` -- the elapsed
  timer ticks once per second -- or `#4 · waiting for lane · 00:03` while
  the provider lane is full; mid-call usage frames add the context gauge and
  the producing call's wall time (`#4 · working · 00:12 · 45k/200k · 4.2s`).
  At idle it mirrors the footer: the last response's local clock (24-hour),
  the ctx gauge, the last call's time, and the turn's worked total, e.g.
  `#4 · 21:47 · 45k/200k · 4.2s · worked 1m 03s`. On stop/interrupt the
  closing row shows the honest worked time to stop. The cost suffix
  (`· $0.0021`) appears only when the `modelPricing` config key exists for
  the session model. With no attestation yet (before the first message) the
  row is hidden. The old TURN counter stays dropped (owner ruling); this
  `#N` counts messages, not turns.
- **Streaming text shows above the input.** Output lines commit into the
  native scrollback as each line completes, exactly as before -- committed
  rows stay there and scroll naturally. The one in-progress (unterminated)
  line additionally paints live as the top row of the frame, above the
  status line, so tokens are visible as they arrive instead of appearing
  all at once at the line terminator. The partial carries the sink's own
  coloring (no restyle), and vanishes from the frame the moment its line
  commits; tool output and previously committed rows are unaffected.

On the legacy renderer (`renderer: "legacy"`, the kill-switch) mid-run
submissions queue and no status/chip rows appear; the key bindings are the
same.
