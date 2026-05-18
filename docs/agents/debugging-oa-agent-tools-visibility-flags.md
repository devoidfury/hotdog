# Debugging

## One-Shot Mode (`-c`)

Run the agent with a single prompt and exit:
```bash
bun src/main.js -c "hello"
# or
bun src/main.js --prompt "hello"
```

## Debug Flags

- **`--loud`** — verbose stderr logging for LLM requests/responses
- **`--no-stream`** — batch mode: text appears after full generation (no streaming)
- **`--compact-debug`** — show compaction details in output
- **`--no-log`** — disable JSONL session logging
- **`--tokens`** — show token usage at the end of the session

## Common Debugging Patterns

### List Recent Sessions
```bash
bun src/main.js review
```
- Shows last 10 sessions with timestamps and entry counts
- `--json` for raw JSONL output
- `--tool-index` for a compact tool call index
- `--session-id <ID>` to view a specific session

### Examine Specific Tool Call Results
```bash
# Extract a range of lines around the suspect tool calls
bun src/main.js review --session-id <ID> | \
  sed -n '700,720p'  # Adjust line numbers based on grep results
```
