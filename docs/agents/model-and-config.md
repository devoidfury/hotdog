# Model and Config

## Model System (`src/core/config/`)

### Core Types
- **ModelRegistry** — stores models by name from provider configs. Built by `buildModelRegistry(config)`.
- **ModelEntry** — `{ name, temperature, maxTokens }` per model in registry
- Model names use `provider/model` format (e.g., `ai365/qwen3.5-4b`) when a provider is active

### Model Switching
- **By name**: `agent.model = "provider/model-name"` (setter emits `MODEL_CHANGE` hook)
- **Via ModelTool**: The LLM can call the `model` tool mid-conversation: `{"name": "model", "arguments": {"name": "provider/model-name"}}`

## Config System (`src/core/config/`)

### Core Defaults
All defaults live in `src/core/config/defaults.js` (sourced from `src/core/core.config.json`):
- `DEFAULT_MODEL`, `DEFAULT_AI_URL`, `DEFAULT_THINKER`, `DEFAULT_TOOL_FMT`, `DEFAULT_TOOL_OUTPUT_FMT`
- `DEFAULT_SKILLS_PATH`, `DEFAULT_PROFILES_SUBPATH`, `DEFAULT_CONFIG_FILENAME`, `DEFAULT_SYSTEM_PROMPT_FILENAME`, `DEFAULT_PROFILES_PATH`, `DEFAULT_PROMPTS_PATH`
- `DEFAULT_CHAT_TIMEOUT_SECS`, `DEFAULT_EMBEDDINGS_TIMEOUT_SECS`, `DEFAULT_MAX_TOKENS`

Extension-specific defaults (e.g., `DEFAULT_READ_TOOL_LIMIT`, `DEFAULT_FIND_MAX_RESULTS`, compaction settings) are defined in each extension's `extension.json` configSchema.

### Config Resolution
- **`loadConfig(configPath, cliConfigDir, extParams)`** — loads config from file, falls back to resolved config dir (CLI `--config-dir` > `./config` > env > `/etc/hotdog` > XDG). Merges extension defaults.
- **`buildConfig(cli)`** — single entry point for config resolution. Returns `{ resolved, modelRegistry, providers }`. Handles CLI args -> config file -> env var -> default priority chain.
- **`mergeExtensionConfigDefaults(defaultConfig, extParams)`** — merges extension-registered config defaults into base config
- **`normalizeConfigKeys(obj)`** — converts snake_case to camelCase
- **`validateConfig(config, extensionSchemas)`** — validates config against core schema and extension schemas

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
1. CLI model → Profile model → provider's first model → config `defaultModel` → `DEFAULT_MODEL`
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

**Resolution chain for role**: CLI `--role` > config `role` > profile file `role` > core config schema default (no `DEFAULT_ROLE` constant exists)

**Config file settings take precedence** over profile file settings for tool restrictions.

### Config Registry (`src/core/extensions/config-registry.js`)

Manages extension-registered CLI flags and config parameters. Config params and CLI flags are defined declaratively in `extension.json` (configSchema and cli:flags) and automatically registered by the extension loader.

**Key methods**: `registerCliFlags(flags)`, `registerConfigParams(params)`, `getCliFlags()`, `getConfigParams()`, `getCliHelpText()`, `buildDefaults()`, `registerConfigSchema(key, schema)`, `validateConfig(config, schema)`.
