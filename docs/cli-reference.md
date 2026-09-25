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
hotdog sessions delete <id>      # Delete a session
hotdog sessions cleanup          # Remove old sessions
hotdog rescue                    # Diagnose config files (paths, syntax, unknown keys)
hotdog rescue fix                # ...and repair comments/trailing commas (.bak kept)
hotdog webui                     # Start the web UI server
hotdog workflow validate <f>     # Validate a .workflow.yaml graph (errors + warnings, exit code)
hotdog workflow render <f>       # Deterministic topological rendering of a workflow
hotdog workflow run <f> [--id <run-id>]
                                 # Execute a workflow graph (foreground; Ctrl-C cancels gracefully).
                                 # --id re-runs a previous run dir, reusing filesystem-verified nodes
                                 # (refused while another live process owns that run dir)
hotdog workflow list             # List runs under <workflows.path>/runs
hotdog workflow status <run-id>  # Node states from a run's run.jsonl (works cross-process)
hotdog workflow reconcile <run-id>
                                 # Check completed claims against the filesystem (resume planning)
hotdog workflow cancel <run-id>  # Finished runs: idempotent report; live runs owned by another
                                 # process must be stopped there (Ctrl-C / '/workflow cancel')
```

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
    --shell-mode             Execute lines starting with a recognized system command directly in interactive mode
                               Tip: append | @ to send command output to the agent (e.g., "ls -la | @", "ls -la | @ show me the permissions")
-l, --loud                   Print full JSON API responses
--json                       Output as JSON
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
/tokens            Show token usage stats
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
