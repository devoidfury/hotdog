# hotdog

An AI agent harness with tool calling support. Connects to any OpenAI-compatible LLM API, manages conversation context, and executes tools -- all through an extensible hook-driven architecture.

Zero dependencies, just bring the bun.

## SAFETY DISCLAIMER

This hotdog comes with minimal guardrails. A dedicated host or a vm or at least a container is recommended. See [examples/](examples/)

## Requirements

- **Bun** >= 1.0

## Installation

```sh
git clone https://github.com/devoidfury/hotdog.git
cd hotdog
```

That's it. No `bun install` needed -- there are no dependencies. No build step, it runs right from the source.

## Quick Start

I haven't tried it with any cloud service providers yet, just local (llama-swap, llama.cpp, vllm, ds4, ...), but it should work the same way with any openai / chat completions compatible endpoint given the right URL, an API key, and the right model config.

_Note - I wrote this using linux and haven't really tried it on macos or windows. Happy to accept PRs adding support or fixing issues there, if you find any._

### 1. Configure Your LLM Backend

Copy [the minimal config example](./examples/minimal-config/config) directory to `./config`, then edit `config/defaults.json` with your AI provider settings:

```json
{
  "default_model": "my-provider/hopus-popus",
  "providers": [
    {
      "name": "my-provider",
      "url": "http://provider.hostname:8080",
      "api_key": "your-api-key",
      "models": [
        {
          "name": "hopus-popus",
          "context-limit": 262144
        }
      ]
    }
  ]
}
```

Or use environment variables instead of a config file:

```sh
export AI_URL="http://localhost:8080"
export AI_API_KEY="your-api-key"
```

### 2. Run

```sh
# Interactive mode
bun bin/hotdog

# One-shot prompt
bun bin/hotdog -c "What files are in this project?"

# With a specific model
bun bin/hotdog -m "my-provider/hopus-popus" -c "Summarize this codebase"
```

If you want to add the bin/ directory to your path, you can shorten it to just `hotdog`, for example:

```sh
# update the path to point to the install location. try `pwd`
# can run directly in shell to try it out, or alternatively
# put in .profile/.bashrc/.zshrc or similar place to make it available in future sessions
export PATH="$PATH:/path/to/hotdog/bin"

hotdog -m "my-provider/hopus-popus" -c "See if you can improve the test coverage."
```

## Configuration

Config is resolved in priority order: **CLI flags** > **config file** > **environment variables** > **built-in defaults**.

See the [config reference](docs/config-reference.md) which covers all the configuration options and how it works in detail.

There are [example configurations](examples/) including the [developer's daily driver](examples/devoidfury/).

### Profiles

Profiles define agent behavior: role, tools, aspects, and model. Create profile files in `<config-dir>/profiles/`.

See also the Profiles section in [config reference](docs/config-reference.md#profiles-in-config)

Example `coder.profile.md`, used with `--profile coder`:

```yaml
---
name: coder
description: A coding-focused agent
role: You are an AI coding assistant.
aspects: ['proactive', 'coding', 'concise']
preload-skills: []
---
Profile body content goes here.
```

## UI Modes
- **One-shot CLI** -- Single prompt non-interactive session. _(stable, ready for use)_
- **Interactive CLI** -- Readline-based interactive session. _(stable, ready for use)_
- **Web UI** -- Optional web interface with WebSocket support (`hotdog webui`). (beta - missing old session replay)

## Features
- **Tool calling** -- File operations, bash, HTTP requests, web search, and more
- **Extension architecture** -- All features are extensions; add your own via `extension.json` + `index.js`
- **Hook system** -- Three hook patterns: notification, sequential pipeline, and gate/mutate
- **Profiles** -- Composable agent configurations with roles, tools, and behavioral aspects
- **Skills** -- Load-on-demand guides and workflows
- **Compaction** -- Automatic context management when token budget is exceeded
- **MCP client** -- Connect to Model Context Protocol servers (HTTP + stdio)
- **Subagent tasks** -- Delegate work to background task agents
- **Session logging** -- JSONL session logs for debugging and auditing
- **Streaming** -- Real-time streaming of LLM responses
- **Retry with backoff** -- Automatic retry for transient LLM errors
- **Prompt injection protection** -- Marker mangling to prevent crafted input from triggering internal behavior

## Usage

### Subcommands

```
hotdog                           # Interactive CLI (default)
hotdog prompt "your prompt"      # One-shot mode
hotdog -c "your prompt"          # One-shot mode (shorthand)
hotdog info                      # System diagnostics
hotdog show-prompt               # Render system prompt to stdout
hotdog profiles                  # List all available profiles
hotdog review                    # Review session logs
hotdog webui                     # Start the web UI server (alpha)
```

### CLI Options

```
-f, --config <path>          Config file path
-d, --config-dir <path>      Config directory
-m, --model <name>           Model name
    --ai-url <url>           AI backend URL
-k, --api-key <key>          API key
-p, --profile <name>         Profile name
    --provider <name>        AI provider name
-l, --loud                   Print full JSON API responses
--json                       Output as JSON
--show-tools                 Show tool calls in output
--show-thinking              Show reasoning/thinking output
--no-colors                  Disable colors
--hook-trace                 Trace hook execution (requires HOTDOG_LOG_LEVEL=debug)
-v, --version                Show version
-h, --help                   Show help
```

### Slash Commands (Interactive Mode)

```
/help              Show available commands
/quit              Exit
/clear             Clear conversation history
/tools             List available tools
/thinking          Toggle thinking display
/tokens            Toggle token usage display
/regenerate        Regenerate last response
/reasoning         Toggle reasoning effort
```

## Extension Anatomy

```
my-extension/
├── extension.json    # Metadata: name, provides, configSchema, services
└── index.ts          # Entry point: export function create(core, options)
```

Extensions register tools, CLI subcommands, and system prompt chunks via hooks. See `docs/agents/extensions.md` for the full guide.

> Extensions? For a hotdog? How long do you need the damn thing?
>
> — Some old guy

## Development

[Github Repo](https://github.com/devoidfury/hotdog)

```sh
# Run tests, shows failures and coverage
bun run test
```

*Note*: test command can return non-zero when all tests pass if any files are under coverage threshold in bunfig.toml

## AI Usage Disclosure

*Was any AI used in the process of writing this code?* You betcha, yes, for sure. I also put my own hands on it, it's not just a slopdog. Go on, audit it.

## License

[MIT](LICENSE) — Copyright (c) 2026 devoidfury / Thomas Hunkapiller
