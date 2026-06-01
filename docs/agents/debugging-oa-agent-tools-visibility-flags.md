# Debugging

## One-Shot Mode (`-c` / `--prompt`)

Run the agent with a single prompt and exit:
```bash
bun bin/oa-agent -c "hello"
# or
bun bin/oa-agent --prompt "hello"
# or
bun bin/oa-agent prompt "hello"
```

## Debug Flags

- **`--loud`** (`-l`) — verbose stderr logging for LLM requests/responses
- **`--no-stream`** — batch mode: text appears after full generation (no streaming)
- **`--compact-debug`** — write compaction details to `compaction.out.json`
- **`--no-log`** — disable JSONL session logging
- **`--tokens`** — show token usage at the end of the session
- **`--show-tools`** — show tool calls (overrides `hideTools`)
- **`--hide-tools`** — hide tool calls (default: hidden)
- **`--show-thinking`** — show thinking output (default: shown)
- **`--hide-thinking`** — hide thinking output
- **`--thinker <fmt>`** — custom thinking format string
- **`--toolfmt <fmt>`** — custom tool call format string
- **`--tool-output-fmt <fmt>`** — custom tool result format string
- **`--session-id <id>`** — resumable session ID (restores from disk)
- **`--json`** — output in JSON format (for subcommands)
- **`--theme <name>`** — theme (dark, light, monochrome, or file path)
- **`--colors`** / **`--no-colors`** — enable/disable colors

## Common Debugging Patterns

### List Recent Sessions
```bash
bun bin/oa-agent review
```
- Shows last 10 sessions with timestamps and entry counts
- `--json` for raw JSONL output
- `--tool-index` for a compact tool call index
- `--session-id <ID>` to view a specific session

### Show System Info
```bash
bun bin/oa-agent info
# or
bun bin/oa-agent info --json
```
- Shows configuration, models, providers, skills, MCP servers, connectivity

### Examine Specific Tool Call Results
```bash
# Extract a range of lines around the suspect tool calls
bun bin/oa-agent review --session-id <ID> | \
  sed -n '700,720p'  # Adjust line numbers based on grep results
```
