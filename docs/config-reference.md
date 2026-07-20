# `defaults.json` Configuration Reference

The `defaults.json` file is the main configuration file for hotdog. It lives in the [config directory](#config-directory-resolution) and controls providers, models, formatting, profiles, extensions, and more.

## Table of Contents

- [Config Directory Resolution](#config-directory-resolution)
- [File Format & Key Normalization](#file-format--key-normalization)
- [Resolution Layers](#resolution-layers)
- [Core Settings](#core-settings)
- [Providers & Models](#providers--models)
- [Profiles (in-config)](#profiles-in-config)
- [Extension Settings](#extension-settings)
- [Environment Variables](#environment-variables)
- [Example Configurations](#example-configurations)

---

## Config Directory Resolution

The config directory is resolved in the following priority order:

| Priority | Source | Example |
|----------|--------|---------|
| 1 | CLI flag `--config-dir` | `hotdog --config-dir /custom/config` |
| 2 | `HOTDOG_CONFIG_DIR` env var | `export HOTDOG_CONFIG_DIR=~/.hotdog` |
| 3 | `./config` (CWD-relative) | `<project>/config/defaults.json` |
| 4 | `/etc/hotdog` | `/etc/hotdog/defaults.json` |
| 5 | XDG: `~/.config/hotdog` | `~/.config/hotdog/defaults.json` |

The config file itself is always named `defaults.json`.

---

## File Format & Key Normalization

The config file is standard JSON. Keys may be written in either **snake_case** or **camelCase** — the loader normalizes all keys to camelCase internally:

```json
{
  "default_model": "provider/model-name",
  "hideTools": true,
  "chat_timeout_secs": 600
}
```

All three forms above are equivalent.

---

## Resolution Layers

Every config value is resolved through a priority chain. Values from higher-priority sources override lower ones:

```
CLI flags  >  defaults.json  >  environment variables  >  profile settings  >  extension defaults  >  schema defaults
```

**Exception:** `aiUrl` and `apiKey` resolve from the active **provider first** (provider > CLI > config > default), since the provider's URL and API key are the natural defaults.

### Layer Details

| Layer | Source | Description |
|-------|--------|-------------|
| **CLI** | `--flag` arguments | Highest priority for most keys. Set via the command line. |
| **Config** | `defaults.json` | Your config file values. |
| **Env** | Environment variables | Set via `export` or shell. |
| **Profile** | Active profile | Values from the selected profile (role, model, tool restrictions). |
| **Extension** | Extension defaults | Defaults registered by loaded extensions. |
| **Default** | Schema defaults | Hardcoded fallbacks from `core.config.json`. |

**Provider layer** (for `aiUrl`/`apiKey` only): The active provider's URL and API key are resolved before CLI/config, since the provider is the natural source for these values.

---

## Core Settings

These are the top-level configuration keys available in `defaults.json`. Keys not listed here either have no config-file layer (CLI-only or schema-only) or are nested within extension objects.

### `defaultModel`

- **Type:** `string`
- **CLI flag:** `--model`
- **Default:** `"qwen3.5-0.8b"`
- **Resolution:** CLI `--model` > profile > config > default

The default AI model used when no other model is specified. Format: `providerName/modelName`.

```json
{ "defaultModel": "ai365/dsv4" }
```

### `aiUrl`

- **Type:** `string`
- **CLI flag:** `--ai-url`
- **Default:** `null` (inherited from active provider)
- **Resolution:** provider > CLI `--ai-url` > config > env `AI_URL`/`HOTDOG_AI_URL` > default

The base URL for the AI API. If not set here, it is inherited from the active [provider](#providers--models).

```json
{ "aiUrl": "http://localhost:9292" }
```

### `apiKey`

- **Type:** `string`
- **CLI flag:** `-k, --api-key`
- **Default:** `null`
- **Resolution:** provider > CLI `--api-key` > config > env `AI_API_KEY` > default

API key for authentication. Can also be set via the `AI_API_KEY` environment variable.

```json
{ "apiKey": "sk-your-key-here" }
```

### `defaultProvider`

- **Type:** `string`
- **CLI flag:** `--provider`
- **Default:** `null`
- **Resolution:** CLI `--provider` > config > default

The name of the default provider to use (must match a `name` in the `providers` array).

```json
{ "defaultProvider": "ai365" }
```

### `temperature`

- **Type:** `number`
- **Default:** `null` (provider/model default)
- **Resolution:** config > default

Sampling temperature for the LLM. `null` uses the provider/model default.

```json
{ "temperature": 0.7 }
```

### `role`

- **Type:** `string`
- **CLI flag:** `--role`
- **Default:** `"You are an AI coding assistant. Use the instructions below and the tools available to you to assist the user."`
- **Resolution:** CLI > config > profile > default

The system prompt role. Note: profile file roles (`role` in `.profile.md` frontmatter) take precedence over config file roles.

```json
{ "role": "You are a senior software engineer." }
```

### `thinker`

- **Type:** `string`
- **CLI flag:** `--thinker` / `-t`
- **Default:** `"[Thinking: {}]"`
- **Resolution:** CLI > config > default

Format string for thinking/reasoning output. `{}` is replaced with the thinking content.

```json
{ "thinker": "🧠 ... {}" }
```

### `toolfmt`

- **Type:** `string`
- **CLI flag:** `--toolfmt`
- **Default:** `"  → {} {}"`
- **Resolution:** CLI > config > default

Format string for tool call display. First `{}` is the tool name, second `{}` is the arguments.

```json
{ "toolfmt": "🔧 {} {}" }
```

### `toolOutputFmt`

- **Type:** `string`
- **CLI flag:** `--tool-output-fmt`
- **Default:** `"----\n{}\n----"`
- **Resolution:** CLI > config > default

Format string for tool result display. `{}` is replaced with the tool output.

```json
{ "toolOutputFmt": "<<< {} >>>" }
```

### `hideTools`

- **Type:** `boolean`
- **CLI flag:** `--show-tools` / `--hide-tools`
- **Default:** `true`
- **Resolution:** CLI > config > default

When `true`, tool calls are hidden from output. Set to `false` to show them.

```json
{ "hideTools": false }
```

### `hideThinking`

- **Type:** `boolean`
- **CLI flag:** `--hide-thinking` / `--show-thinking`
- **Default:** `false`
- **Resolution:** CLI > config > default

When `true`, thinking/reasoning output is hidden.

```json
{ "hideThinking": true }
```

### `showTokenUse`

- **Type:** `boolean`
- **CLI flag:** `--tokens`
- **Default:** `true`
- **Resolution:** CLI > config > default

Display token usage statistics at the end of responses.

```json
{ "showTokenUse": true }
```

### `noLog`

- **Type:** `boolean`
- **CLI flag:** `--no-log`
- **Default:** `false`
- **Resolution:** CLI > env `HOTDOG_LOG` (inverted) > env `HOTDOG_NO_LOG` > config > default

Disable session logging. Can also be controlled via environment variables:
- `HOTDOG_LOG=false` enables no-log mode (inverted)
- `HOTDOG_NO_LOG=true` enables no-log mode

```json
{ "noLog": true }
```

### `compactDebug`

- **Type:** `boolean`
- **CLI flag:** `--compact-debug`
- **Default:** `false`
- **Resolution:** CLI > config > default

Write compaction output to `compaction.out.json` for debugging.

```json
{ "compactDebug": true }
```

### `hookTrace`

- **Type:** `boolean`
- **CLI flag:** `--hook-trace`
- **Default:** `false`
- **Resolution:** CLI > env `HOTDOG_HOOK_TRACE` > config > default

Trace hook execution. Requires `HOTDOG_LOG_LEVEL=debug`.

```json
{ "hookTrace": true }
```

### `theme`

- **Type:** `string`
- **CLI flag:** `--theme`
- **Default:** `"dark"`
- **Resolution:** CLI > config > default

UI theme. Built-in options: `dark`, `light`, `monochrome`. Also accepts a file path to a custom theme.

```json
{ "theme": "light" }
```

### `colors`

- **Type:** `boolean`
- **CLI flag:** `--colors` / `--no-colors`
- **Default:** `true`
- **Resolution:** CLI > config > default

Enable or disable colored output.

```json
{ "colors": true }
```

### `stream`

- **Type:** `boolean`
- **CLI flag:** `--no-stream`
- **Default:** `true`
- **Resolution:** CLI > default

Enable streaming output. `--no-stream` disables streaming (text appears after full generation).

```json
{ "stream": true }
```

### `sessionId`

- **Type:** `string`
- **CLI flag:** `--session-id`
- **Default:** `null`
- **Resolution:** CLI > default

Resumable session ID. Restores from disk if a session with this ID exists.

```json
{ "sessionId": "my-session-id" }
```

### `chatTimeoutSecs`

- **Type:** `number`
- **CLI flag:** `--chat-timeout`
- **Default:** `600`
- **Resolution:** CLI > config > default

Timeout in seconds for chat/API requests.

```json
{ "chatTimeoutSecs": 300 }
```

### `embeddingsTimeoutSecs`

- **Type:** `number`
- **CLI flag:** `--embeddings-timeout`
- **Default:** `120`
- **Resolution:** CLI > config > default

Timeout in seconds for embeddings requests.

```json
{ "embeddingsTimeoutSecs": 60 }
```

### `skillsPath`

- **Type:** `string`
- **CLI flag:** `--skills-path`
- **Default:** `<configDir>/skills` (computed)
- **Resolution:** CLI > config > computed (configDir + "skills")

Path to the skills directory. Falls back to `<configDir>/skills` if not set.

### `profilesPath`

- **Type:** `string`
- **CLI flag:** `--profiles-path`
- **Default:** `<configDir>/profiles`
- **Resolution:** CLI > config > computed (configDir + "profiles")

Path to the profiles directory (contains `.profile.md` files).

```json
{ "profilesPath": "./my-profiles" }
```

### `promptsPath`

- **Type:** `string`
- **CLI flag:** `--prompts-path`
- **Default:** `<configDir>/prompts`
- **Resolution:** CLI > config > computed (configDir + "prompts")

Path to the prompts directory.

```json
{ "promptsPath": "./my-prompts" }
```

### `systemPromptTemplate`

- **Type:** `string`
- **CLI flag:** `--system-prompt-template`
- **Default:** `null` (auto-detected: `<configDir>/system_prompt.md`)
- **Resolution:** CLI > config > default

Path to a custom system prompt template file. If not set, hotdog looks for `system_prompt.md` in the config directory.

```json
{ "systemPromptTemplate": "./config/my_template.md" }
```

### `profile`

- **Type:** `string`
- **CLI flag:** `--profile`
- **Default:** `"default"`
- **Resolution:** CLI > config > default

Name of the active profile. Can reference either a profile defined in the `profiles` section of this file or a `.profile.md` file in the profiles directory.

```json
{ "profile": "explorer" }
```

### `extensionPaths`

- **Type:** `array` of `string`
- **Default:** `["builtins"]`
- **Resolution:** config > default

Paths to extension directories. `"builtins"` loads built-in extensions. Add paths to load custom extensions.

```json
{ "extensionPaths": ["builtins", "./my-extensions"] }
```

### `extensionAutoload`

- **Type:** `boolean`
- **Default:** `false`
- **Resolution:** config > default

When `true`, extensions are automatically loaded from `extensionPaths` without explicit registration.

```json
{ "extensionAutoload": true }
```

### `extensions`

- **Type:** `array`
- **Default:** `[]`
- **Resolution:** config > default

Explicit list of extensions to load.

```json
{ "extensions": ["my-custom-ext"] }
```

### `defaultSubcommand`

- **Type:** `string`
- **Default:** `"cli"`
- **Resolution:** config > default

The default subcommand to run when no subcommand is specified.

```json
{ "defaultSubcommand": "cli" }
```

### `configDebug`

- **Type:** `boolean`
- **CLI flag:** `--config-debug`
- **Default:** `false`
- **Resolution:** CLI only (no config file layer)

Show config resolution details (sources and layers). Extension-provided flag from `ui-info-cli` (used with the `info` subcommand).

### `coreTools`

- **Type:** `object`
- **Default:** `{}`
- **Resolution:** config > default

Configuration for the [core-tools extension](#core-tools). See the extension section for available options.

```json
{
  "coreTools": {
    "readToolLimit": 1000,
    "findMaxResults": 500,
    "grepMaxResults": 200
  }
}
```

### `compaction`

- **Type:** `object`
- **Default:** `{}`
- **Resolution:** config > default

Configuration for the [compaction extension](#compaction). See the extension section for available options.

```json
{
  "compaction": {
    "strategy": "token-aware",
    "reserveTokens": 16000
  }
}
```

---

## Providers & Models

The `providers` array defines available AI providers and their models. Each provider entry configures a connection endpoint and the models available through it.

### Provider Object

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | yes | — | Unique provider identifier. Used in model references as `providerName/modelName`. |
| `url` | `string` | no | — | Base URL for the provider's API. Also resolves to the `baseUrl` config key. |
| `apiKey` | `string` | no | — | API key for this provider. Also resolves to the `apiKey` config key. |
| `defaultModel` | `string` | no | — | Default model name for this provider (used when no models array is present). |
| `temperature` | `number` | no | — | Default temperature for all models in this provider. |
| `contextLimit` | `number` | no | 128000 | Context window size limit for all models in this provider (triggers compaction when exceeded). |
| `models` | `array` | no | `[]` | Array of model definitions. |

### Model Object (inside `providers[].models[]`)

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | yes | — | Model identifier. Full reference: `providerName/modelName`. |
| `contextLimit` | `number` | no | 128000 | Context window size limit for this model (triggers compaction when exceeded). |
| `temperature` | `number` | no | — | Override temperature for this model. |
| `reasoning_effort` | `string` | no | — | Reasoning effort level (e.g. `"max"`, `"medium"`, `"low"`). Also accepts camelCase `reasoningEffort`. |
| `tags` | `array` | no | `[]` | Arbitrary tags for model discovery and filtering. |

### Example Providers Configuration

```json
{
  "providers": [
    {
      "name": "ai365",
      "url": "http://ai365.home:9292",
      "apiKey": "sk-your-key",
      "models": [
        {
          "name": "dsv4",
          "contextLimit": 350000,
          "tags": ["general", "huge", "coder"],
          "reasoning_effort": "max"
        },
        {
          "name": "qwen3.5-4b",
          "contextLimit": 262144,
          "tags": ["general", "fast", "instruct"]
        }
      ]
    },
    {
      "name": "openai",
      "url": "https://api.openai.com/v1",
      "apiKey": "sk-...",
      "defaultModel": "gpt-4o",
      "temperature": 0.7,
      "contextLimit": 128000
    }
  ]
}
```

When a provider has no `models` array but defines `defaultModel`, that model is automatically registered with the provider's `temperature` and `contextLimit`.

---

## Profiles (in-config)

The `profiles` key allows you to define profile configurations directly in `defaults.json`. These merge with `.profile.md` files in the profiles directory, with file profiles taking priority for `role`, `whitelistTools`, `blacklistTools`, and `manager`.

### Profile Object

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `role` | `string` | `""` | System prompt role for this profile. |
| `model` | `string` | `null` | Model override for this profile (e.g. `"provider/model-name"`). |
| `blacklistTools` | `array` | `[]` | Tool names to disable in this profile. |
| `whitelistTools` | `array` | `null` | If set, only these tools are available. `null` means no restriction. |
| `manager` | `boolean` | `false` | Whether this profile enables subagent management. |
| `aspects` | `array` | `[]` | Aspect names to activate. |

### Example Profiles Configuration

```json
{
  "profiles": {
    "default": {
      "blacklistTools": ["explore"]
    },
    "explorer": {
      "model": "ai365/lfm2.5-8b-a1b",
      "blacklistTools": ["write", "model", "explore"]
    },
    "fixer": {
      "model": "ai365/qwen3.6-27b"
    },
    "test": {
      "model": "ai365/qwen3.5-4b:coder"
    }
  }
}
```

### Profile Resolution

When both a config profile and a `.profile.md` file profile exist for the same name:

| Field | Winner |
|-------|--------|
| `role` | `.profile.md` file |
| `whitelistTools` | `.profile.md` file |
| `blacklistTools` | `.profile.md` file |
| `manager` | `.profile.md` file |
| `model` | Config file (`defaults.json`) |
| All other fields | Config file |

---

## Extension Settings

Extensions register their own configuration namespaces. Each extension's config is a top-level key in `defaults.json`.

### `agentsMd`

[Agents MD](../src/extensions/agents-md) — Loads `AGENTS.md` for project context.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `autoload` | `boolean` | `true` | Auto-load `AGENTS.md` from CWD. |

```json
{ "agentsMd": { "enabled": true, "autoload": false } }
```

### `environment`

[Environment](../src/extensions/environment) — Contributes Environment section to the system prompt.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |

```json
{ "environment": { "enabled": true } }
```

### `bashTool`

[Bash Tool](../src/extensions/bash-tool) — Execute shell commands.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `bashTimeoutMs` | `number` | `60000` | Timeout for bash commands (ms). |
| `maxToolOutputLines` | `number` | `600` | Max output lines for tool results. |

```json
{ "bashTool": { "bashTimeoutMs": 30000 } }
```

### `fetchTool`

[Fetch Tool](../src/extensions/fetch-tool) — Make HTTP requests.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |

```json
{ "fetchTool": { "enabled": true } }
```

### `compaction`

[Compaction](../src/extensions/compaction) — Context compaction strategies.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable compaction. |
| `strategy` | `string` | `"summarize"` | Strategy: `summarize`, `drop`, `summarize-short`, `token-aware`, `trim`. |
| `reserveTokens` | `number` | `8000` | Token budget to reserve for the response. |
| `keepRecentMessages` | `number` | `3` | Recent messages to keep after compaction. |

```json
{ "compaction": { "strategy": "token-aware", "reserveTokens": 16000 } }
```

### `coreTools`

[Core Tools](../src/extensions/core-tools) — Write, read, edit, grep, find, pager, explore.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `readToolLimit` | `number` | `500` | Max lines for the `read` tool. |
| `findMaxResults` | `number` | `200` | Max results for the `find` tool. |
| `grepMaxResults` | `number` | `100` | Max results for the `grep` tool. |
| `maxDiffSize` | `number` | `8000` | Max diff size in characters. |
| `maxEditInputSize` | `number` | `16000` | Max edit input size (oldString + newString) in characters. |
| `maxToolOutputLines` | `number` | `600` | Max output lines for tool results. |

```json
{
  "coreTools": {
    "readToolLimit": 1000,
    "maxEditInputSize": 32000
  }
}
```

### `mcpServers`

[MCP Client](../src/extensions/mcp-client) — Model Context Protocol servers.

An array of MCP server definitions. Each server can use either HTTP transport (`url`) or stdio transport (`command`).

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `name` | `string` | yes | — | Unique server name. |
| `url` | `string` | conditional | — | HTTP URL (use with HTTP transport; mutually exclusive with `command`). |
| `command` | `string` | conditional | — | Stdio command (use with stdio transport; mutually exclusive with `url`). |
| `args` | `array` | no | `[]` | Arguments for the stdio command. |
| `env` | `object` | no | `{}` | Environment variables for the stdio command. |
| `headers` | `object` | no | `{}` | HTTP headers for the server. |
| `enabled` | `boolean` | no | `true` | Enable/disable this server. |
| `blacklistTools` | `array` | no | `[]` | Tool names to exclude. |

```json
{
  "mcpServers": [
    {
      "name": "bun-docs",
      "url": "https://bun.com/docs/mcp"
    },
    {
      "name": "filesystem",
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      "enabled": true
    }
  ]
}
```

### `modelSwitch`

[Model Switch](../src/extensions/model-switch) — Runtime model switching.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `toolEnabled` | `boolean` | `true` | Register the model-switch tool. |
| `commandEnabled` | `boolean` | `true` | Register `/model` and `/models` slash commands. |

```json
{ "modelSwitch": { "toolEnabled": true } }
```

### `loop`

[Loop](../src/extensions/loop) — `/loop` slash command for repeatedly running a prompt until cancelled.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the `/loop` command. |
| `maxLoops` | `number` | `-1` | Maximum loop iterations (`-1` = unlimited). |

```json
{ "loop": { "maxLoops": 10 } }
```

### `metrics`

[Metrics](../src/extensions/metrics) — Export per-run LLM metrics to a CSV file.

Captures model, backend, prompt tokens, completion tokens, TTFT (time to first token), tok/s (throughput), memory usage, and workload label. Each completed run appends a row to the CSV.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `outputFile` | `string` | `~/.cache/hotdog/metrics.csv` | Path to the CSV output file. |

```json
{ "metrics": { "outputFile": "./my-metrics.csv" } }
```

### `questionTool`

[Question Tool](../src/extensions/question-tool) — Ask the user questions.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |

### `skills`

[Skills](../src/extensions/skills) — Skills loading, activation, and system prompt integration.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `preloadSkills` | `array` | `[]` | List of skill names to preload. |
| `path` | `string` | `<configDir>/skills` | Directory path where skills are stored. |

CLI flag: `--preload-skills` (comma-separated skill names).

```json
{ "skills": { "preloadSkills": ["my-skill", "another-skill"] } }
```

### `prompts`

[Prompts](../src/extensions/prompts) — Prompt template loading and execution.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `path` | `string` | `<configDir>/prompts` | Directory path for prompt templates. |
| `displayPrompt` | `boolean` | `true` | Show rendered prompt in chat before LLM processing. |

CLI flag: `--prompts-path`.

```json
{ "prompts": { "path": "./my-prompts", "displayPrompt": false } }
```

### `subagents`

[Subagents](../src/extensions/subagents) — Task delegation tools (manager-only).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |

### `uiInteractiveCli`

[Interactive CLI](../src/extensions/ui-interactive-cli) — Interactive session with readline.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `shellMode` | `boolean` | `false` | When enabled, lines starting with a recognized system command are executed directly instead of sent to the agent. |

CLI flag: `--shell-mode`.

### `webSearch`

[Web Search](../src/extensions/web-search) — Internet search via DuckDuckGo, Brave, Tavily, or SearXNG.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `provider` | `string` | `"duckduckgo"` | Search provider: `duckduckgo`, `brave`, `tavily`, `searxng`. |
| `maxResults` | `number` | `5` | Max search results (1–10). |
| `timeout` | `number` | `15` | Request timeout in seconds. |
| `braveApiKey` | `string` | `""` | Brave API key (required when `provider=brave`). Also from env `BRAVE_API_KEY`. |
| `tavilyApiKey` | `string` | `""` | Tavily API key (required when `provider=tavily`). Also from env `TAVILY_API_KEY`. |
| `searxngInstanceUrl` | `string` | `""` | SearXNG instance URL (required when `provider=searxng`). Also from env `SEARXNG_INSTANCE_URL`. |

```json
{
  "webSearch": {
    "provider": "brave",
    "braveApiKey": "your-brave-key",
    "maxResults": 10
  }
}
```

### `websocket`

[WebSocket](../src/extensions/websocket) — WebSocket server for agent session management.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `port` | `number` | `3000` | WebSocket server port. |
| `host` | `string` | `"0.0.0.0"` | WebSocket server host. |
| `sessionTimeoutMin` | `number` | `30` | Idle session cleanup timeout (minutes). |
| `questionTimeoutSecs` | `number` | `300` | Default question timeout (seconds). |
| `questionStrategy` | `string` | `"wait"` | Question strategy: `wait`, `default`, `cancel`. |

```json
{ "websocket": { "port": 8080, "sessionTimeoutMin": 60 } }
```

### `webui`

[WebUI](../src/extensions/webui) — Web UI for agent interaction (login, chat, session management).

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `boolean` | `true` | Enable/disable the extension. |
| `port` | `number` | `3000` | WebUI server port. |
| `host` | `string` | `"0.0.0.0"` | WebUI server host. |
| `apiKey` | `string` | `null` | API key for login authentication (also from env `HOTDOG_WEBUI_API_KEY`). |
| `sessionTokenTtlMin` | `number` | `1440` | Session token TTL in minutes (default: 24 hours). |
| `maxAgeSecs` | `number` | `3600` | Cache-Control max-age for static assets (seconds). |

```json
{ "webui": { "port": 8080, "apiKey": "your-key" } }
```

---

## Environment Variables

| Variable | Related Config | Description |
|----------|---------------|-------------|
| `AI_API_KEY` | `apiKey` | API key for the AI provider. |
| `AI_URL` | `aiUrl` | AI provider URL (also `HOTDOG_AI_URL`). |
| `HOTDOG_CONFIG_DIR` | Config directory | Override the config directory path. |
| `HOTDOG_LOG` | `noLog` | Set to `false` to disable logging (inverted). |
| `HOTDOG_NO_LOG` | `noLog` | Set to `true` to disable logging. |
| `HOTDOG_HOOK_TRACE` | `hookTrace` | Set to `true` to enable hook tracing. |
| `HOTDOG_LOG_LEVEL` | General | Set to `debug` for debug-level logging (required for `hookTrace`). |
| `BRAVE_API_KEY` | `webSearch.braveApiKey` | Brave Search API key. |
| `TAVILY_API_KEY` | `webSearch.tavilyApiKey` | Tavily API key. |
| `SEARXNG_INSTANCE_URL` | `webSearch.searxngInstanceUrl` | SearXNG instance URL. |
| `HOTDOG_WEBUI_API_KEY` | `webui.apiKey` | WebUI API key for login authentication. |

---

## Example Configurations

### Minimal Configuration

```json
{
  "default_model": "provider1/mystic-navel",
  "thinker": " 🧠 ... {}",
  "toolfmt": " 🔧 {} {}",
  "hide_tools": true,
  "show_token_use": true,
  "chat_timeout_secs": 1200,
  "extension_autoload": true,
  "providers": [
    {
      "name": "provider1",
      "url": "http://provider1.localnetwork:9292",
      "models": [
        { "name": "mystic-navel", "context-limit": 262144 },
        { "name": "hopus-popus", "context-limit": 262144 }
      ]
    }
  ]
}
```

### Full-Featured Configuration

```json
{
  "defaultModel": "ai365/dsv4",
  "defaultProvider": "ai365",
  "thinker": " 🧠 ... {}",
  "toolfmt": " 🔧 {} {}",
  "hideTools": true,
  "showTokenUse": true,
  "skillsPath": "/skills",
  "chatTimeoutSecs": 900,
  "temperature": 0.7,
  "profile": "default",
  "extensionPaths": ["builtins"],
  "extensionAutoload": true,
  "agentsMd": { "enabled": true, "autoload": false },
  "coreTools": {
    "readToolLimit": 500,
    "findMaxResults": 200,
    "grepMaxResults": 100
  },
  "compaction": {
    "strategy": "token-aware",
    "reserveTokens": 8000
  },
  "webSearch": {
    "provider": "duckduckgo",
    "maxResults": 5
  },
  "mcpServers": [
    {
      "enabled": true,
      "name": "bun-docs-mcp",
      "url": "https://bun.com/docs/mcp"
    }
  ],
  "profiles": {
    "default": {
      "blacklistTools": ["explore"]
    },
    "explorer": {
      "model": "ai365/lfm2.5-8b-a1b",
      "blacklistTools": ["write", "model", "explore"]
    },
    "fixer": {
      "model": "ai365/qwen3.6-27b"
    }
  },
  "providers": [
    {
      "name": "ai365",
      "url": "http://ai365.home:9292",
      "models": [
        {
          "name": "dsv4",
          "context-limit": 350000,
          "tags": ["general", "huge", "coder"],
          "reasoning_effort": "max"
        },
        {
          "name": "qwen3.5-4b",
          "context-limit": 262144,
          "tags": ["general", "fast", "instruct"]
        }
      ]
    }
  ]
}
```
