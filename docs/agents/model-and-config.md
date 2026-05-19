# Model and Config

## Model System (`src/config.js`)

### Core Types
- **`ModelConfig`** — plain object with `name`, `temperature`, `maxTokens`, `capabilities`, `tags`
- **`ModelRegistry`** — stores models by name, `findBest(requestedTags)` for tag-based selection, `findBestName()` returns name string, `names()` returns all registered model names, `primary()` returns primary model, `setPrimary()` changes primary
- **`ModelUsageStats`** — per-model: totalRequests, successfulRequests, failedRequests, totalDuration
- **`ModelUsageTracker`** — tracks current model, records success/failure, provides `getStats()` / `allStats()`

### Model Name Format

All model names use `provider/model` format (e.g., `ai365/qwen3.5-4b`) when a provider is active. Bare model names are only used in the legacy path when no providers are configured.

### Model Switching
- **By name**: `agent.switchModel("provider/model-name")`
- **By tags**: Not directly supported — use `agent.switchModel()` with the model name. Tag-based selection is used during initialization via `ModelRegistry.findBest()`.
- **Via ModelTool**: The LLM can call the `model` tool mid-conversation: `{"name": "model", "arguments": {"name": "provider/model-name"}}`

## Config System (`src/config.js`)

### AgentConfig (Construction)
The `AgentConfig` object bundles all configuration for constructing an `Agent`. It has 23 fields covering model registry, output sink, tool registry, skills, session metadata, streaming control, compaction, and profile switching.

```javascript
const config = {
    client: LlmClient,
    context: MessageLog,
    model: string,
    modelRegistry: ModelRegistry,
    sink: OutputSink,
    hideTools: boolean,
    hideThinking: boolean,
    skills: Skill[],
    allSkills: Skill[],
    skillDirectories: string[],
    activeSkills: Set,
    maxToolOutputLines: number,
    sessionId: string,
    cwdBoundary: string | null,
    role: string,
    profileBody: string,
    stream: boolean,
    compaction: CompactionSettings,
    compactDebug: boolean,
    showTokenUse: boolean,
    profileName: string,
    taskManager: TaskManager | null,
    mcpConnections: [],
};
```

Construction is done by passing the config object directly to the `Agent` constructor:
```javascript
const agent = new Agent(config);
```

### Config File
A JSON config file can be loaded with `--config path/to/config.json` to set defaults. CLI args and env vars override config file values. Skills are loaded from `/skills` directory by default (configurable via `skills_path` in config or `--skills-path` CLI flag).

### Providers

Models are declared inside providers. The top-level `models` field is no longer used. Each provider has a `name`, `url`, optional `api_key`, and a list of `models`. The active provider is selected via `--provider` CLI flag or `default_provider` config key.

### Example Config
```json
{
  "providers": [
    {
      "name": "ai365",
      "url": "http://ai365.home:9292",
      "api_key": "sk-...",
      "models": [
        {
          "name": "qwen3.5-4b",
          "tags": ["fast", "general"],
          "temperature": 0.3,
          "max_tokens": 32000
        },
        {
          "name": "qwen3.6-35b",
          "tags": ["powerful", "think"],
          "max_tokens": 64000
        }
      ]
    }
  ],
  "default_provider": "ai365",
  "thinker": "[Thinking: {}]",
  "toolfmt": "Tool [{}] {}",
  "tool_output_fmt": "  → {}",
  "role": "You are an AI coding assistant.",
  "hide_tools": false
}
```

### Defaults and Serialization

Missing fields in the config use defaults from `DEFAULT_*` constants. The config loader creates a default instance and merges the file values on top.

### Resolution Priority

The `resolve_str` helper generates config resolution methods (URL, model, skills path, profile) that follow a consistent priority chain: CLI argument → config file → environment variable → constant default.

### Model Resolution

Model names flow through `buildAgentConfig()` (in `init/resolution.js`):
1. CLI model → profile model → config `defaultModel` → provider's first model → `DEFAULT_MODEL`
2. If the name contains `/`, it's used as-is (already qualified)
3. If a provider is active and the name matches a provider model, it's prefixed with the provider name
4. Otherwise, the bare name is passed through (will error at validation if not in registry)

### Profiles
Tool profiles control which tools are available to the agent. Profiles are defined in the config file under `profiles` and selected via `--profile` CLI flag or the `profile` config key.

- **`whitelist_tools`**: If specified, only these tools are available. All other tools are excluded.
- **`blacklist_tools`**: These tools are excluded from the available set. All other tools remain available.
- **`skills`**: List of skill names to make available to this profile.
- **`model`**: Override the default model for this profile (resolved through provider if bare name).
- **`preload_skills`**: Skills to preload into the initial context.
- **`cwd_boundary`**: Directory boundary for file operations (write, read, find).
- **`manager`**: When true, enables manager-specific tools (orchestrator tools) before whitelist/blacklist filtering applies.
- **`aspects`**: List of aspect names to include (loaded from `config/aspects/<name>.aspect.md`).

Both whitelist and blacklist fields are optional. If neither is specified, all tools are available (default behavior).

**Profile Selection Priority**: `--profile` CLI flag > config `profile` > `"default"`

**Example Config with Profiles**:
```json
{
  "providers": [
    {
      "name": "ai365",
      "url": "http://ai365.home:9292",
      "models": [
        {"name": "qwen3.5-4b", "tags": ["fast"]},
        {"name": "qwen3.6-35b", "tags": ["powerful"]}
      ]
    }
  ],
  "default_provider": "ai365",
  "profile": "minimal",
  "profiles": {
    "minimal": {
      "blacklist_tools": ["write", "model"]
    },
    "coding": {
      "whitelist_tools": ["bash", "write"],
      "blacklist_tools": ["model"]
    },
    "default": {
      "blacklist_tools": ["model"]
    }
  }
}
```

**Usage**:
```bash
oa-agent --profile minimal --prompt "run ls"
oa-agent --profile coding --prompt "write a file"
oa-agent --provider ai365 --model qwen3.6-35b --prompt "hello"
```

**The `info` subcommand shows the active profile and providers**:
```bash
oa-agent info
# Shows: Profile: minimal, Blacklist Tools: write, model
# Shows: Providers: ai365 → http://ai365.home:9292  [qwen3.5-4b, qwen3.6-35b]
# Shows: Active Provider: ai365
```

#### File-Based Profiles

Profiles can also be defined as `.profile.md` files in a `profiles/` directory (configurable via `profiles_path` in config). Each file uses YAML frontmatter followed by markdown body, following the same pattern as skills.

**Frontmatter fields**:
- **`name`**: Profile identifier (falls back to filename without `.profile` extension)
- **`description`**: Human-readable description
- **`role`**: Role string that fills the `{role}` placeholder in the system prompt template
- **`blacklist-tools`**: Tools to exclude (same as config `blacklist_tools`)

**Markdown body**: Content that fills the `{body}` placeholder in the system prompt template, appended as an extension to the base system prompt.

**Example profile file** (`profiles/explorer.profile.md`):
```yaml
---
name: explorer
description: A codebase scout for gathering context
role: You are a codebase scout. You create concise project summaries.
blacklist-tools: ["patch", "write", "model"]
---

# Assignment
Summarize the project structure and key files.
Focus on architecture, dependencies, and entry points.
```

**Resolution chain for role**: CLI `--role` > config `role` > profile file `role` > `DEFAULT_ROLE`

**Config file settings take precedence** over profile file settings for tool restrictions. The profile file provides defaults that are overlaid with config values where they are non-empty.

## LSP Configuration (`src/lsp/config.js`)

LSP integration is controlled via the `lsp` config object. It is **disabled by default** (`DEFAULT_LSP_ENABLED = false`).

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for LSP tools |
| `servers` | object | (empty) | Custom server overrides keyed by name |
| `defaultServers` | object | (4 built-in) | TypeScript, Python, Go, Rust servers |
| `maxHoverLines` | number | `200` | Max lines in hover results |
| `maxCompletionItems` | number | `50` | Max completion items returned |
| `maxSymbolResults` | number | `100` | Max symbol search results |
| `maxDiagnostics` | number | `100` | Max diagnostics to display |
| `requestTimeoutMs` | number | `30000` | Per-request timeout |
| `serverStartupTimeoutMs` | number | `60000` | Server startup timeout |
| `documentSyncKind` | string | `'full'` | Document sync mode |

### Default Language Servers

| Language | Command | Args | Filetypes |
|----------|---------|------|--------|
| TypeScript | `typescript-language-server` | `--stdio` | `.ts`, `.tsx`, `.js`, `.jsx` |
| Python | `pyright-langserver` | `--stdio` | `.py` |
| Go | `gopls` | `serve` | `.go` |
| Rust | `rust-analyzer` | (none) | `.rs` |

### Resolution Chain

Profile-level `lsp.*` settings override global `lsp.*` settings, which override defaults.

```bash
# Enable LSP globally
oa-agent --prompt "hover on line 5" --config '{"lsp": {"enabled": true}}'

# Enable LSP per-profile (in config file or profile .profile.md)
{
  "profile": "coding",
  "profiles": {
    "coding": {
      "lsp": { "enabled": true },
      "whitelist_tools": ["lsp-hover", "lsp-definition", "lsp-completion"]
    }
  }
}
```

### Custom Server Configuration

Add custom servers in the config file under `lsp.servers`:

```json
{
  "lsp": {
    "enabled": true,
    "servers": {
      "java": {
        "name": "java",
        "command": "jdtls",
        "args": [],
        "filetypes": ["java"],
        "timeoutMs": 45000
      }
    }
  }
}
```

### Supported File Extensions

The LSP system maps extensions to language IDs: `ts`→typescript, `tsx`→typescriptreact, `js`→javascript, `jsx`→javascriptreact, `py`→python, `go`→go, `rs`→rust, `java`→java, `rb`→ruby, `php`→php, `c`→c, `cpp`→cpp, `cs`→csharp, `swift`→swift, `kt`→kotlin, plus markdown, json, yaml, html, css, scss, shellscript, toml, xml, sql. Unknown extensions map to `plaintext` (no server configured).
