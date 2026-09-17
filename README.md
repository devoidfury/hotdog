# hotdog

An AI agent harness with tool calling support. Connects to any OpenAI-compatible LLM API.

## Why? _You gonna eat that?_

- Tiny core, extensions to build out the agent you want. Disable any feature you don't like, drop in your own extensions to add new functionality.
- Minimize the context and system prompt the harness provides. Instead, you write and compose your own system prompts with tool-sets as profiles.
- First-class support for local models and backends like llama-swap, llama.cpp, vllm, ds4.
- Wire-format integrity: markers, chat-template control tokens, and tool-call delimiters inside untrusted output get rewritten to per-session aliases, so nothing a tool reads can forge a a fake tool call or a harness system message.
- Zero dependencies (just bring your own bun, see [Supply Chain](docs/supply-chain.md))

## Requirements

- **Bun** >= 1.3.1

## UI Modes
- **One-shot CLI** -- Single prompt non-interactive session (`hotdog -p "your prompt"`). _(stable, ready for use)_
- **Interactive CLI** -- Readline-based interactive session (`hotdog` or `hotdog cli`). _(stable, ready for use)_
- **Web UI** -- Web interface with WebSocket support (`hotdog webui`). _(beta - ready for use)_

## Features
- **Tool calling** -- File operations, bash, HTTP requests, web search, and more
- **Extension architecture** -- All features are extensions; add your own via `extension.json` + `index.ts`
- **Profiles** -- Composable agent configurations with tools and behavioral aspects
- **Skills** -- Load-on-demand guides and workflows
- **Compaction** -- Automatic context management when token budget is exceeded
- **MCP client** -- Connect to Model Context Protocol servers (HTTP + stdio)
- **Subagent tasks** -- Delegate work to background task agents
- **Handoff tool** -- Clear context and restart with a prepared plan for multi-phase tasks
- **Tool-call approvals** -- Opt-in `userGate`: allow / deny / ask before a tool call runs
- **File attachments** -- Reference files inline with @filepath syntax in user input
- **Session logging** -- JSONL session logs for debugging and auditing

## Installation

```sh
git clone https://github.com/devoidfury/hotdog.git
```

That's it. No separate build or install step, it runs right from the source.

## Quick Start

_Notes: I haven't tried it with any cloud service providers, only local llms, but it should work the same way with any openai / chat completions compatible endpoint. This was written using linux and I haven't tried it on macos or windows. Happy to accept PRs adding support or fixing issues there, if you find any._

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
      "fetchModels": true,
    }
  ]
}
```

Or use environment variables instead of a config file:

```sh
export HOTDOG_AI_URL="http://localhost:8080"
export HOTDOG_API_KEY="your-api-key"
```

### 2. Run

```sh
# Interactive mode
bun bin/hotdog

# One-shot prompt
bun bin/hotdog -p "What files are in this project?"

# With a specific model
bun bin/hotdog -m "my-provider/hopus-popus" -p "Summarize this codebase"
```

If you want to add the bin/ directory to your path, you can shorten it to just `hotdog`, for example:

```sh
# update the path to point to the install location. try `pwd`
# can run directly in shell to try it out, or alternatively
# put in .profile/.bashrc/.zshrc or similar place to make available in future sessions
export PATH="$PATH:/path/to/hotdog/bin"

hotdog -m "my-provider/hopus-popus" -p "See if you can improve the test coverage."
```

## Usage

```
hotdog                           # Interactive CLI (default)
hotdog -p "your prompt"          # One-shot mode
hotdog info                      # System diagnostics
hotdog webui                     # Start the web UI server
```

Full list of subcommands, CLI flags, and interactive slash commands: [CLI reference](docs/cli-reference.md).

## Configuration

Config values are resolved through a priority chain defined **per key**: most keys resolve **CLI flag > config file > built-in default**, while some insert provider, profile, or environment layers at deliberate positions (e.g. `default_model` resolves env `HOTDOG_MODEL` *above* the config file, `apiKey` resolves it below). There is no single global order; the exact chain for every key is listed in the [config reference](docs/config-reference.md).

See the [config reference](docs/config-reference.md) which covers all the configuration options and how it works in detail.

There are [example configurations](examples/) including the [developer's daily driver](examples/devoidfury/).

### Profiles

Profiles define agent behavior: tools, aspects, and model. Create profile files in `<config-dir>/profiles/`.

See also the Profiles section in [config reference](docs/config-reference.md#profiles-in-config)

Example `coder.profile.md`, used with `--profile coder`:

```yaml
---
name: coder
description: A coding-focused agent
aspects: ['proactive', 'coding', 'concise']
---
Profile body content goes here.
```

## Safety

This hotdog comes with minimal guardrails by default. A dedicated host, a vm, or at least a container is recommended. See [examples/](examples/).

When you want the agent reined in:

- `--sandbox` restricts the agent to tools with no side effects: no file writes, no network, no external commands.
- `userGate` prompts you before risky tool calls: allow / deny / ask.
- Disable the `bash` tool - it runs with your own permissions and can do anything the user you run it as can do. Be careful what you give agents with `bash` access to.

## Extension Anatomy

```
my-extension/
├── extension.json    # Metadata: name, provides, configSchema, services
└── index.ts          # Entry point: export function create(core, options)
```

Extensions register tools, CLI subcommands, and system prompt chunks via hooks. See `docs/agents/extensions.md` for the full guide.

> Extensions? For a hotdog? How long do you need the damn thing?
>
> -- Some old guy

## Supply Chain

hotdog ships as a source tree: no build step, no published artifact, nothing installed that runs third-party code.

- **Nothing is installed.** No `npm install`, no `node_modules`, no `postinstall`/`prepare` hooks.
- **Zero runtime dependencies.** `dependencies` is empty; the whole runtime is the TypeScript in `src/`, readable in the repo.
- **Nothing is built by someone else's CI.** The source you run is the source in the repo, and it's small enough to read.

Boundaries that remain: the Bun runtime itself (install it from an official source and pin it), and the extensions you opt into (MCP servers, skill scripts). Full write-up: [docs/supply-chain.md](docs/supply-chain.md).

## Development

[Github Repo](https://github.com/devoidfury/hotdog)

```sh
# Run tests (prints failures only, suppressed green output)
bun run test

# Same, plus a coverage report
bun run coverage
```

*Note*: `bun run coverage` can return non-zero when all tests pass if any files are under the coverage threshold in bunfig.toml

## AI Usage Disclosure

*Was any AI used in the process of writing this code?* You betcha, yes, for sure. I also put my own hands on it, it's not just a slopdog. Go on, audit it.

_[Never seen nobody be able to do this... I'm just sayin'](https://www.youtube.com/watch?v=BYkwtaJgW5g)_

## License

[MIT](LICENSE) -- Copyright (c) 2026 devoidfury / Thomas Hunkapiller
