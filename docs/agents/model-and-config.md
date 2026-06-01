# Model and Config

## Model System (`src/config.js`)

### Core Types
- **ModelRegistry** — stores models by name from provider configs. Built by `buildModelRegistry(config)`.
- **ModelEntry** — `{ name, temperature, maxTokens }` per model in registry
- Model names use `provider/model` format (e.g., `ai365/qwen3.5-4b`) when a provider is active

### Model Switching
- **By name**: `agent.model = "provider/model-name"` (setter emits `MODEL_CHANGE` hook)
- **Via ModelTool**: The LLM can call the `model` tool mid-conversation: `{"name": "model", "arguments": {"name": "provider/model-name"}}`

## Config System (`src/config.js`)

### Core Defaults
All defaults live in `src/config.js` as named constants:
- `DEFAULT_MODEL`, `DEFAULT_AI_URL`, `DEFAULT_THINKER`, `DEFAULT_TOOL_FMT`, `DEFAULT_TOOL_OUTPUT_FMT`, `DEFAULT_TOOL_RESULT_FMT`
- `DEFAULT_SKILLS_PATH`, `DEFAULT_PROFILES_PATH`, `DEFAULT_PROMPTS_PATH`, `DEFAULT_CONFIG_PATH`, `DEFAULT_SYSTEM_PROMPT_PATH`
- `DEFAULT_CHAT_TIMEOUT_SECS`, `DEFAULT_EMBEDDINGS_TIMEOUT_SECS`, `DEFAULT_BASH_TIMEOUT_MS`, `DEFAULT_MAX_TOKENS`, `DEFAULT_MAX_ITERATIONS`, `DEFAULT_MAX_RETRIES`
- `DEFAULT_PROMPT`, `DEFAULT_EXIT_COMMANDS`, `DEFAULT_ROLE`, `DEFAULT_MAX_TOOL_OUTPUT_LINES`, `DEFAULT_TASK_PROFILE`
- `DEFAULT_READ_TOOL_LIMIT`, `DEFAULT_FIND_MAX_RESULTS`, `DEFAULT_GREP_MAX_RESULTS`
- `DEFAULT_MAX_DIFF_SIZE`, `DEFAULT_MAX_EDIT_INPUT_SIZE`
- `DEFAULT_COMPACTION_ENABLED`, `DEFAULT_COMPACTION_RESERVE_TOKENS`, `DEFAULT_COMPACTION_KEEP_RECENT_MESSAGES`, `DEFAULT_COMPACTION_STRATEGY`
- `defaultCompactionSettings` — `{ enabled, reserveTokens, keepRecentMessages, strategy }`
- LSP defaults: `DEFAULT_LSP_ENABLED`, `DEFAULT_LSP_MAX_HOVER_LINES`, `DEFAULT_LSP_MAX_COMPLETION_ITEMS`, `DEFAULT_LSP_MAX_SYMBOL_RESULTS`, `DEFAULT_LSP_REQUEST_TIMEOUT_MS`, `DEFAULT_LSP_SERVER_TIMEOUT_MS`, `DEFAULT_LSP_SERVERS`

### Config Resolution
- **`loadConfig(configPath, extParams)`** — loads config from file, falls back to `./config/defaults.json` then `~/.config/oa-agent/default.json`, then defaults. Merges extension defaults.
- **`buildConfig(cli)`** — single entry point for config resolution. Returns `{ resolved, modelRegistry, providers }`. Handles CLI args → config file → env var → default priority chain.
- **`mergeExtensionConfigDefaults(defaultConfig, extParams)`** — merges extension-registered config defaults into base config
- **`normalizeConfigKeys(obj)`** — converts snake_case to camelCase

### Providers
Models are declared inside providers. Each provider has `name`, `url`, optional `api_key`, and a list of `models`. The active provider is selected via `--provider` CLI flag or `default_provider` config key.

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

### Model Resolution
Model names flow through `buildConfig()`:
1. CLI model → profile model → config `defaultModel` → provider's first model → `DEFAULT_MODEL`
2. If the name contains `/`, it's used as-is (already qualified)
3. If a provider is active and the name matches a provider model, it's prefixed with the provider name
4. Otherwise, the bare name is passed through (will error at validation if not in registry)

### Profiles
Tool profiles control which tools are available to the agent. Profiles are defined in the config file under `profiles` and selected via `--profile` CLI flag or the `profile` config key.

- **`whitelist_tools`**: If specified, only these tools are available.
- **`blacklist_tools`**: These tools are excluded. All other tools remain available.
- **`model`**: Override the default model for this profile.
- **`cwd_boundary`**: Directory boundary for file operations.
- **`manager`**: When true, enables manager-specific tools before whitelist/blacklist filtering.
- **`aspects`**: List of aspect names to include (loaded from `config/aspects/<name>.aspect.md`).

**Profile Selection Priority**: `--profile` CLI flag > config `profile` > `"default"`

#### File-Based Profiles

Profiles can also be defined as `.profile.md` files in a `profiles/` directory (configurable via `profiles_path` in config). Each file uses YAML frontmatter followed by markdown body.

**Frontmatter fields**:
- **`name`**: Profile identifier (falls back to filename)
- **`description`**: Human-readable description
- **`role`**: Role string that fills the `{role}` placeholder in the system prompt template
- **`blacklist-tools`**: Tools to exclude
- **`whitelist-tools`**: Tools to include
- **`model`**: Override model
- **`aspects`**: List of aspect names
- **`manager`**: Enable manager tools
- **`visible-worker`**: Mark as visible worker profile

**Markdown body**: Content that fills the `{body}` placeholder in the system prompt template.

**Resolution chain for role**: CLI `--role` > config `role` > profile file `role` > `DEFAULT_ROLE`

**Config file settings take precedence** over profile file settings for tool restrictions.

### Config Registry (`src/config-registry.js`)

Allows extensions to register their own CLI flags and config parameters dynamically.

**Usage in an extension**:
```javascript
export function create(core) {
  core.configRegistry.registerCliFlags([
    {
      short: '-x',
      long: '--my-flag',
      description: 'My extension flag',
      type: 'string',
      default: null,
    },
  ]);

  core.configRegistry.registerConfigParams([
    {
      key: 'myExtension',
      description: 'My extension config section',
      defaults: { enabled: true, timeout: 30 },
    },
  ]);

  return { /* ... */ };
}
```

**Key methods**: `registerCliFlags(flags)`, `registerConfigParams(params)`, `getCliFlags()`, `getConfigParams()`, `getCliHelpText()`, `buildDefaults()`.

## LSP Configuration (`src/extensions/lsp/config.js`)

LSP integration is controlled via the `lsp` config object. It is **disabled by default** (`DEFAULT_LSP_ENABLED = false`).

### Config Fields

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | boolean | `false` | Master switch for LSP tools |
| `servers` | object | (empty) | Custom server overrides keyed by name |
| `maxHoverLines` | number | `200` | Max lines in hover results |
| `maxCompletionItems` | number | `50` | Max completion items returned |
| `maxSymbolResults` | number | `100` | Max symbol search results |
| `requestTimeoutMs` | number | `30000` | Per-request timeout |
| `serverStartupTimeoutMs` | number | `60000` | Server startup timeout |

### Default Language Servers

| Language | Command | Args | Filetypes |
|----------|---------|------|--------|
| TypeScript | `typescript-language-server` | `--stdio` | `.ts`, `.tsx`, `.js`, `.jsx` |
| Python | `pyright-langserver` | `--stdio` | `.py` |
| Go | `gopls` | `serve` | `.go` |
| Rust | `rust-analyzer` | (none) | `.rs` |

### Resolution Chain

Profile-level `lsp.*` settings override global `lsp.*` settings, which override defaults.

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
