# `show-prompt` Subcommand Reference

## Purpose

`oa-agent show-prompt` renders and prints the system prompt (and skills preamble if preloaded) to stdout, then exits — without connecting to any LLM or running the agent loop.

## Usage

```bash
# Basic usage — renders with current config/model
bun src/main.js show-prompt

# With profile
bun src/main.js show-prompt --profile fixer

# With specific model
bun src/main.js show-prompt --model smollm

# With preloaded skills
bun src/main.js show-prompt --preload-skills tdd,git
```

## Output Format

```
## System Prompt
───

[rendered system prompt with {model}, {cwd}, {platform}, {date}, {role} placeholders filled]

## Skills Preamble
───

[rendered skills preamble if --preload-skills was used]
```

## Implementation Details

- **No API calls**: The prompt is rendered entirely locally using templates and the available tool definitions. No LLM connection is needed.
- **MCP connections**: The agent still connects to MCP servers during construction. This is necessary to get the full tool list that appears in the prompt. If MCP servers are unavailable, warnings are printed but the agent still builds.
- **Skills**: If `--preload-skills` is used, the skills preamble is injected and included in the output.
- **NoopSink**: A minimal `Output` implementation that discards all events — we only need the agent to render the prompt, not display anything.
- **Session ID**: Not printed (no session is actually started).
