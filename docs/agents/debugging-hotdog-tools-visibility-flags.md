# Debugging

## One-Shot Mode (`-c` / `--prompt`)

Run the agent with a single prompt and exit:
```bash
bun bin/hotdog -c "hello"
# or
bun bin/hotdog --prompt "hello"
# or
bun bin/hotdog prompt "hello"
```

## Debug Flags

- **`--loud`** (`-l`) — verbose stderr logging for LLM requests/responses
- **`--no-stream`** — batch mode: text appears after full generation (no streaming)
- **`--compact-debug`** — write compaction details to `compaction.out.json`
- **`--hook-trace`** — trace hook execution (see below)
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
bun bin/hotdog review
```
- Shows last 10 sessions with timestamps and entry counts
- `--json` for raw JSONL output
- `--tool-index` for a compact tool call index
- `--session-id <ID>` to view a specific session

### Show System Info
```bash
bun bin/hotdog info
# or
bun bin/hotdog info --json
```
- Shows configuration, models, providers, skills, MCP servers, connectivity

### Examine Specific Tool Call Results
```bash
# Extract a range of lines around the suspect tool calls
bun bin/hotdog review --session-id <ID> | \
  sed -n '700,720p'  # Adjust line numbers based on grep results
```

### Hook Trace

When multiple extensions hook into the same data-modifying hook (e.g., `context`, `tool:call`, `tool:result`), it can be hard to tell which extension modified what. Hook trace logs each handler invocation with execution order, source extension, timing, and return value.

```bash
HOTDOG_LOG_LEVEL=debug bun bin/hotdog --hook-trace -c "hello"
```

Or via env var or config:
```bash
# Env var
HOTDOG_HOOK_TRACE=1 HOTDOG_LOG_LEVEL=debug bun bin/hotdog -c "hello"

# Config file (config/defaults.json)
{ "hook_trace": true }
```

**Output format:**
```
[DEBUG] [hook:trace] context — 1/3 (compaction) — 2ms returned { messages }
[DEBUG] [hook:trace] context — 2/3 (mcp-client) — 1ms returned { messages }
[DEBUG] [hook:trace] context — 3/3 (session-log) — 0ms no return
[DEBUG] [hook:trace] tool:call — 1/2 (bash-tool) — 1ms returned { action: "modify", input }
```

Each line shows: `hookName — N/M (source) — duration — return summary`
- **N/M** -- handler position in the chain (e.g., 1 of 3)
- **source** -- extension name that registered the handler
- **return summary** -- what the handler returned, or "no return" if it didn't modify data
- For `emitAsyncSeqUntil` hooks (e.g., `input`), an additional "stopped at handler N/M" line appears when the chain terminates early

**Hooks traced:** All hooks except the internal `log` hook. Trace output uses `logger.debug()` so it requires `HOTDOG_LOG_LEVEL=debug` (or `HOTDOG_LOG_LEVEL=info` with `--loud`).
