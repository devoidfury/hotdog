# hotdog

An AI agent harness with tool calling support. Connects to any OpenAI-compatible LLM API, manages conversation context, and executes tools -- all through an extensible hook-driven architecture.

Zero dependencies, just bring the bun.

## SAFETY DISCLAIMER

This hotdog comes with minimal guardrails. A dedicated host or a vm or at least a container is recommended. See [examples/](examples/)

There is optionally the `--sandbox` mode which disables all potentially risky/destructive tools, and severely limits the agent's blast radius for mistakes.

## Supply Chain

hotdog ships as a source tree. There is no build step, no published artifact, and no install step that runs third-party code. You clone the repo and run it directly:

```sh
git clone https://github.com/devoidfury/hotdog.git
cd hotdog
bun bin/hotdog
```

Three properties follow, and each removes a step that supply-chain attacks need:

- **Nothing is installed.** No `npm install`, no `node_modules`. There's no `postinstall`/`prepare` hook and no `optionalDependencies`. The whole class of payload that ships *inside* a package and detonates during install has nowhere to sit.
- **Zero runtime dependencies.** `dependencies` is empty — no runtime dependencies, no transitive tree, so a compromised upstream package has no path in. The entire runtime is the TypeScript in `src/`, all in the repo, all readable. The repo does carry a `bun.lock`, but it pins only the single dev-time dependency (`@types/bun`) and its type-only peers — nothing it references is shipped or executed.
- **Nothing is built by someone else's CI.** You're not running an artifact a third-party build runner produced. The failure mode where a poisoned build cache or a compromised release pipeline emits a "legitimate-looking" tarball (right version, right author, right signature) requires a build-and-publish step. hotdog has none in your install path; the source you run is the source in the repo, and it's small enough to read.

Put together, the common vectors (install-time lifecycle execution, malicious transitive dependencies, and compromised build/CI pipelines producing poisoned published artifacts) have no foothold in how hotdog is distributed. An attacker would have to compromise the git repo you clone or the Bun runtime itself; both are things you can see, pin, and audit.

**Boundaries to be aware of**

- **The Bun runtime is a trust boundary.** Zero dependencies doesn't cover the runtime. Install Bun from an official source and pin the version. That binary is the one third-party build artifact in your path, and it isn't hotdog's to guarantee.
- **Opt-in extensions are explicit trust boundaries.** The MCP client and skill scripts can load third-party code *you* choose to add. That's the customizability, and it's the one place hotdog runs code it didn't ship. It's off by default and deliberately opt-in.

This is a different axis from the [Safety Disclaimer](#safety-disclaimer) above. That one is about what the *agent* can do to you; this one is about what could be *in the code* before it ever runs. hotdog keeps both surfaces as small as it can.

## Requirements

- **Bun** >= 1.2

## Installation

```sh
git clone https://github.com/devoidfury/hotdog.git
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
# put in .profile/.bashrc/.zshrc or similar place to make it available in future sessions
export PATH="$PATH:/path/to/hotdog/bin"

hotdog -m "my-provider/hopus-popus" -p "See if you can improve the test coverage."
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
- **One-shot CLI** -- Single prompt non-interactive session (`hotdog -p "your prompt"`). _(stable, ready for use)_
- **Interactive CLI** -- Readline-based interactive session (`hotdog` or `hotdog cli`). _(stable, ready for use)_
- **Web UI** -- Web interface with WebSocket support (`hotdog webui`). _(beta - ready for use)_

## Features
- **Tool calling** -- File operations, bash, HTTP requests, web search, and more
- **Extension architecture** -- All features are extensions; add your own via `extension.json` + `index.ts`
- **Hook system** -- Three hook patterns: notification, sequential pipeline, and gate/mutate
- **Profiles** -- Composable agent configurations with roles, tools, and behavioral aspects
- **Skills** -- Load-on-demand guides and workflows
- **Compaction** -- Automatic context management when token budget is exceeded
- **MCP client** -- Connect to Model Context Protocol servers (HTTP + stdio)
- **Subagent tasks** -- Delegate work to background task agents
- **Handoff tool** -- Clear context and restart with a prepared plan for multi-phase tasks
- **File attachments** -- Reference files inline with @filepath syntax in user input
- **Session logging** -- JSONL session logs for debugging and auditing
- **Streaming** -- Real-time streaming of LLM responses
- **Retry with backoff** -- Automatic retry for transient LLM errors
- **Prompt injection protection** -- Marker mangling to prevent crafted input from triggering internal behavior

## Usage

### Subcommands

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
hotdog webui                     # Start the web UI server
```

### CLI Options

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
    --shell-mode             Execute shell commands directly in interactive mode
                               Tip: append | @ to send command output to the agent (e.g., "ls -la | @", "ls -la | @ show me the permissions")
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
/quit, /exit       Exit
/clear             Clear conversation history
/loop <prompt>     Repeatedly run a prompt until cancelled
/model <name>      Switch model
/models            List available models
/tokens            Show token usage stats
/tools             Toggle tool call display
/compact [n]       Compact context
/compact <strategy>  Switch compaction strategy (also: /compact:<strategy>)
/cancel            Cancel current run
/prompt:name       Execute saved prompt from prompts directory
/skill             List available skills
/skill:<name>      Activate a skill
/thinking          Toggle thinking display
/theme <name>      Set theme (dark, light, monochrome)
/regenerate        Regenerate system prompt
/reasoning <level> Set reasoning effort (none/minimal/low/high/xhigh/max/unset)
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

[MIT](LICENSE) — Copyright (c) 2026 devoidfury / Thomas Hunkapiller
