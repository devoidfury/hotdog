# `show-prompt` Subcommand Reference

## Purpose

`oa-agent show-prompt` renders and prints the system prompt to stdout, then exits — without connecting to any LLM or running the agent loop.

## Usage

```bash
# Basic usage — renders with current config/model
bun bin/oa-agent show-prompt

# With profile
bun bin/oa-agent show-prompt --profile fixer

# With specific model
bun bin/oa-agent show-prompt --model qwen3.5-0.8b
```

## Output Format

```
[rendered system prompt with {model}, {cwd}, {platform}, {date}, {role} placeholders filled]
```

## Implementation Details

- **No API calls**: The prompt is rendered entirely locally using templates and the available tool definitions. No LLM connection is needed.
- **Hook-based**: The agent uses the real hook mechanism to build the system prompt, so extensions (skills, compaction, etc.) contribute to the prompt as they would in normal operation.
- **No session**: No session is actually started.

## Related Subcommands

- `info` — Shows system diagnostics, providers, models, connectivity
- `review` — Reviews session logs from disk

All subcommands are provided by extensions registered via `CliSubcommandRegistry`.
