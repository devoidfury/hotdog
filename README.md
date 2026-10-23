# hotdog

**agent harness built for local, open-weight models.** Point it at llama.cpp, llama-swap, vllm, or any OpenAI-compatible endpoint and run your entire agent stack on your own hardware. No cloud, no API bills, no telemetry or data harvesting.

**Zero dependencies** - bring your own [Bun](https://bun.sh) and hotdog will run from source code. No `npm install`, no `node_modules`, no build step, no postinstall hooks. The whole runtime is the TypeScript in this repo. Prefer a package manager? The same source tree is published as [`@read-receipt/hotdog`](https://www.npmjs.com/package/@read-receipt/hotdog) -- still zero dependencies, see [Install from npm](#install-from-npm-optional).  
*More info @ [supply chain rationale](docs/supply-chain.md).*

![hotdog interactive CLI demo](docs/demo.gif)

## Quick Start

First, get your bun ready - you can snag one here if you don't have one already: [Bun](https://bun.sh)  
(make sure it's version >= 1.4.2)

```sh
git clone https://github.com/devoidfury/hotdog.git && cd hotdog
# initialize your own config directory by copying minimal config.
# copy to ~/.config/hotdog or /etc/hotdog instead if you want it to work from anywhere.
cp -r examples/minimal-config/config config
# alternatively configure "providers" in the config
export HOTDOG_AI_URL="http://localhost:8080"   # your llama.cpp / llama-swap / vllm server
export HOTDOG_API_KEY="api-key-here"

bun bin/hotdog
```

One-shot mode, with pinning a specific model (`-m`, or env `HOTDOG_MODEL`):

```sh
bun bin/hotdog -m "qwen3.8-flash-next" -p "What files are in this project?"
```

Want just `hotdog` on your PATH instead of `bun bin/hotdog`?

```sh
# try it in a shell interactively, or put it in .profile/.bashrc/.zshrc to persist (update the path; try `pwd`)
export PATH="$PATH:/path/to/hotdog/bin"

hotdog -m "qwen3.8-flash-next" -p "See if you can improve the test coverage. @package.json"
```

### Install from npm (optional)

The same source tree is published as `@read-receipt/hotdog`. From v0.13.0 every npm version is published from a tagged GitHub release with npm provenance.

```sh
# global: links `hotdog` into ~/.bun/bin (already on your PATH if bun's installer set it up)
bun add -g @read-receipt/hotdog

# or project-local, then run via bun
bun add @read-receipt/hotdog
bun node_modules/.bin/hotdog info
```

The tarball is this repo's source and nothing else (`bin/`, `src/`, `examples/`, `tsconfig.json`) -- zero dependencies to resolve, no install scripts, and Bun verifies the tarball integrity on install. First-time config, straight from the installed package:

```sh
cp -r ~/.bun/install/global/node_modules/@read-receipt/hotdog/examples/minimal-config/config ~/.config/hotdog
```

Then point it at your inference server (`HOTDOG_AI_URL`/`HOTDOG_API_KEY` or `providers` in `defaults.json`) and go: `hotdog info` to confirm, `hotdog -p "hello"` for a first prompt. Git clone stays the recommended path for hacking on hotdog itself -- extensions aside, though, this is the identical code the repo runs.

> [!CAUTION]
> No API key means your inference server is vulnerable to misuse by anything on the network. Always configure local inference servers to require an API key. llama.cpp, llama-swap, vllm, and others support API key configuration.

## Why? _You gonna eat that?_

- **Local first.** Built and tested daily against local backends (llama-swap, llama.cpp, vllm, ds4).
- **Short supply chain.** `dependencies` is empty. Just Bun. No packages to install means nothing to compromise. Pin a git tag and you know exactly what you're running; from the npm package, release provenance names the exact commit and workflow that built it.
- **Wire-format integrity.** Markers, chat-template control tokens, and tool-call delimiters inside untrusted output get rewritten to per-session aliases, so nothing a tool reads can forge a fake turn or system message.
- **Small harness footprint.** Minimal context and system prompt injected by the harness itself. Instead, you write and compose your own system prompts with tool-sets as profiles.
- **Tiny core, extensions to build out the agent you want.** Disable any feature you don't like, drop in your own extensions to add new functionality.

### UI Modes
- **One-shot CLI** -- non-interactive single prompt (`hotdog -p "your prompt"`). _(stable)_
- **Interactive CLI** -- readline-based interactive session (`hotdog` or `hotdog cli`). _(stable)_
- **Web UI** -- webserver mode (`hotdog webui`). _(beta)_

### Features
- **Tool calling** -- File operations, bash, HTTP requests, web search, and more
- **Extension architecture** -- All features are extensions; add your own via `extension.json` + `index.ts`
- **Profiles** -- Composable agent configurations, tools and behavioral aspects
- **Skills** -- Load-on-demand context and resources
- **Compaction** -- Automatic context management when token budget is exceeded
- **MCP client** -- Connect to Model Context Protocol servers (HTTP + stdio)
- **Subagents and Workflow graphs** -- Delegate work to background task agents, workflows for long-horizon tasks with reviewed steps. Automatic fan out to all configured providers.
- **Handoff tool** -- Clear context and restart with a prepared plan for multi-phase tasks
- **Tool-call approvals** -- Opt-in `userGate`: allow / deny / ask before a tool call runs
- **File attachments** -- Reference files inline with @filepath syntax in user input
- **Session logging** -- JSONL session logs for debugging and auditing

## Configuration

Copy [the minimal config example](./examples/minimal-config/config) directory to `~/.config/hotdog` (user-wide) or `/etc/hotdog` (system-wide). For project-local config, copy it to `./config` and run hotdog from that directory. Edit `<config-dir>/defaults.json` with your AI provider settings:

```json
{
  "defaultModel": "my-provider/qwen3.8-flash-next",
  "providers": [
    {
      "name": "my-provider",
      "url": "http://provider.hostname:8080",
      "apiKey": "your-api-key",
      "fetchModels": true
    }
  ]
}
```

Config values are resolved through a priority chain defined **per key**: most keys resolve **CLI flag > config file > built-in default**, while some insert provider, profile, or environment layers at deliberate positions. The exact chain for every key is listed in the [config reference](docs/config-reference.md).

> [!TIP]
> There are [example configurations](examples/) including the [developer's daily driver](examples/devoidfury/).

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

## Usage

```
hotdog                           # Interactive CLI (default)
hotdog -p "your prompt"          # One-shot mode
hotdog info                      # System diagnostics
hotdog webui                     # Start the web UI server
```

Full list of subcommands, CLI flags, and interactive slash commands: [CLI reference](docs/cli-reference.md).

## Safety

This hotdog comes with minimal guardrails by default. A dedicated host, a vm, or at least a container is recommended. See [examples/](examples/).

What ships on by default: the tool execution plane (`toolExec: "worker"`) runs the tagged tools (`bash`, `read`, `grep`) in pooled out-of-process executors, so a tool crash cannot take down your session, and provider keys never enter the process that executes agent-authored commands (unless you turn scrubbing off with `envScrubbing: false`, which opts the whole plane into your full environment). On Linux with bubblewrap installed, each session's executor additionally runs in a jail: no `$HOME`, no config files, read-write only inside your workspace roots (`execFence: "probe"`). Run `hotdog info` to see the posture (`Tools Exec: worker (fence: bwrap | off | none -- probe failed)`); an unavailable fence is always reported, never assumed. See [SECURITY.md](SECURITY.md) for the boundary and its honest limits.

When you want the agent reined in further:

- `--sandbox` restricts the agent to tools with no side effects: no file writes, no network, no external commands.
- `userGate` prompts you before risky tool calls: allow / deny / ask.
- Disable the `bash` tool. Inside a working fence it can already only reach your workspace roots; unfenced (inline mode, no bwrap, macOS/Windows) it still runs with your own permissions and can do anything the user you run it as can do. Be careful what you give agents with `bash` access to.

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

## Support Status

| Setup | Status |
|-------|--------|
| Linux | daily-driven, supported |
| llama.cpp / llama-swap | daily-driven, supported |
| vllm / ds4 / other OpenAI-compatible endpoints | supported |
| Cloud providers | any chat-completions compatible endpoint; openrouter supported, others not personally exercised yet |
| macOS / Windows | untested; PRs to fix or confirm issues very welcome |

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

## License

[MIT](LICENSE) -- Copyright (c) 2026 devoidfury / Thomas Hunkapiller
