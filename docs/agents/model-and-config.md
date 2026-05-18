# Model and Config

## Model System (`src/model.js`)

### Core Types
- **`ModelConfig`** — `name`, `temperature`, `max_tokens`, `capabilities`, `tags`
- **`ModelRegistry`** — stores models by name, `find_best(requested_tags)` for tag-based selection, `find_best_name()` returns name string, `names()` returns all registered model names, `primary()` returns primary model, `set_primary()` changes primary
- **`ModelUsageStats`** — per-model: total_requests, successful_requests, failed_requests, total_duration
- **`ModelUsageTracker`** — tracks current model, records success/failure, provides `get_stats()` / `all_stats()`

### Model Name Format

All model names use `provider/model` format (e.g., `ai365/qwen3.5-4b`) when a provider is active. Bare model names are only used in the legacy path when no providers are configured.

### Model Switching
- **By name**: `agent.switch_model("provider/model-name")`
- **By tags**: Not directly supported — use `agent.switch_model()` with the model name. Tag-based selection is used during initialization via `ModelRegistry::find_best()`.
- **Via ModelTool**: The LLM can call the `model` tool mid-conversation: `{"name": "model", "arguments": {"name": "provider/model-name"}}`

## Config System (`src/config.js`)

### AgentConfig (Construction)
The `AgentConfig` object bundles all configuration for constructing an `Agent`. It has 22 fields covering model registry, output sink, tool registry, skills, session metadata, streaming control, compaction, and profile switching. Format strings live in `AgentFormatting` (part of `BuildOutput`).

```javascript
const config = {
    model_registry: ModelRegistry,
    sink: OutputSink,
    registry: ToolRegistry,
    hide_tools: boolean,
    skills: Skill[],
    all_skills: Skill[],
    skill_directories: string[],
    role: string,
    profile_body: string,
    aspect_body: string,
    max_tool_output_lines: number,
    session_id: string | null,
    no_log: boolean,
    cwd_boundary: string | null,
    prompts_loader: PromptsLoader,
    stream: boolean,
    profiles: Map<String, SwitchProfile>,
    compaction: CompactionSettings,
    compact_debug: boolean,
    task_manager: TaskManager | null,
    profile_name: string,
};
```

Construction is done via `AgentConfig::from_build_output()` which extracts relevant fields from `BuildOutput`:
```javascript
const config = AgentConfig.from_build_output(build_output, tool_registry, sink);
const agent = await Agent.from_builder(builder, sink, loud);
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

Model names flow through `AgentBuilder::model_name()` (in `init/resolution.js`):
1. CLI model → profile model → config `default_model` → provider's first model → `DEFAULT_MODEL`
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
