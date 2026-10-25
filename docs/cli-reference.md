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
hotdog rescue                    # Diagnose config files (paths, syntax, unknown keys)
hotdog rescue fix                # ...and repair comments/trailing commas (.bak kept)
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
-l, --loud                   Print full JSON API responses
--json                       Output as JSON for the subcommands that support it (info, profiles,
                               sessions, rescue); stdout carries only the JSON, diagnostics go to stderr
    --json-schema <json|path>  One-shot structured output: a JSON Schema (inline or file path); the run ends when the model returns a valid payload, printed as bare JSON
--show-tools                 Show tool calls in output
--show-thinking              Show reasoning/thinking output
--no-colors                  Disable colors (also honors NO_COLOR / TERM=dumb env)
--hook-trace                 Trace hook execution (requires HOTDOG_LOG_LEVEL=debug)
-v, --version                Show version
-h, --help                   Show help
```

## Slash Commands (Interactive Mode)

```
/help              Show available commands
/quit, /exit       Exit
/redraw            Purge scrollback and reprint the transcript (split renderer; ctrl-l also works)
/clear             Clear conversation history
/undo              Undo the last turn (user message + everything after it)
/rewind [N]        Rewind the last N turns (default 1)
/fork [N] [prompt] Branch a new session from N turns back; optionally send a prompt there
                     Fork auto-switches to the new session; the original stays
                     attached (interactive/switch-capable UIs)
/loop <prompt>     Repeatedly run a prompt until cancelled
/model <name>      Switch model
/models            List available models
/profile           List profiles (current marked)
/profile <name>    Switch profile (also: /profile:<name>)
/tokens            Show token usage stats + context-window fill gauge
/tools             Toggle tool call display
/compact [n]       Compact context
/compact <strategy>  Switch compaction strategy (also: /compact:<strategy>)
/prompt:name       Execute saved prompt from prompts directory
/skill             List available skills
/skill:<name>      Activate a skill
/thinking          Toggle thinking display
/theme <name>      Set theme (dark, light, monochrome)
/regenerate        Regenerate system prompt
/reasoning <level> Set reasoning effort (none/minimal/low/high/xhigh/max/unset)
```

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
- **Status line** (top frame row) shows the turn count with state: `#2`
  idle, `#3 · working` during a turn, `#3 · waiting for lane` while the
  provider lane is full. A cost suffix (`· $0.0021`) appears only when the
  `modelPricing` config key exists for the session model. Before the first
  turn the row is hidden.
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
