# Architecture

## Overview

`oa-agent` is an AI agent harness with tool calling support. It connects to an LLM API, sends conversation messages, handles tool calls from the LLM, and executes tools (bash, file writing, model switching, skill loading).

## Key Components

### Context (`src/context/`)
- `MessageLog` — stores message history (`Message { role, content, reasoning_content, tool_calls, tool_call_id }`). Methods: `append()`, `add_message()`, `add_system_message()`, `add_user_message()`, `add_assistant_message()`, `add_tool_message()`, `insert_at()`, `reset()`, `messages()`, `message_count()`, `replace_messages()`
- `OUTPUT_EVENT` types: `UserMessage`, `AssistantMessage`, `Thinking`, `ToolCall`, `ToolResult`, `Compacting`, `CommandResult`, `Question`, `StreamingChunk`, `StreamingReasoningChunk`, `TaskProgress`, `TokenUsage`
- `InputEvent` enum: `Text(String)`, `Command(String)` — parsed by `parse_input()` in `context/input.js`
- `OutputSink` base class — `emit()` plus convenience methods (`emit_thinking`, `emit_tool_call`, `emit_tool_result`, `emit_assistant_message`, `emit_user_message`, `emit_compacting`, `emit_question`, `emit_streaming_chunk`, `emit_streaming_reasoning_chunk`, `emit_task_progress`)
- `Input` handling — question/answer collection abstraction (CLI implements independently)
- `QuestionDef` — question definition with key, prompt, options, required, default, allow_other
- `NoopSink` — no-op implementation for testing and show-prompt

### Agent (`src/agent/`)
- `AgentConfig` — bundled configuration struct covering model registry, output sink, tool registry, skills, session metadata, streaming control, compaction, and profile switching
- `Agent` — run loop, tool dispatch, model switching, context management. Fields: client, context, model, model_registry, usage_tracker, cancellation_token, executor, sink, hide_tools, skills, all_skills, skill_directories, active_skills, loop_state, output_cache, max_tool_output_lines, session_id, session_log, cwd_boundary, role, profile_body, aspect_body, prompts_loader, stream, profiles, compaction, compact_debug, task_manager, mangler, used_tools, profile_name
- `Agent::from_builder(builder, sink, loud)` — async factory method constructing agent from `BuildOutput`
- `Agent::run(user_input)` — main iteration loop
- `Agent::switch_model(model_name)` — switch to a specific model by name
- `Agent::cancel()` — cancel the running agent loop
- `Agent::reset_cancel()` — reset cancellation token
- `Agent::set_cancellation_token()` — set cancellation token
- `Agent::current_model()` — returns the current model name
- `Agent::model_names()` — returns all registered model names
- `Agent::profile_names()` — returns all available profile names
- `Agent::switch_profile(profile_name)` — switch to a named profile
- `Agent::session_id()` — returns the session ID
- `Agent::get_rendered_prompt()` — returns the rendered system prompt and skills preamble
- `Agent::token_usage()` — returns current model and all usage stats
- `Agent::record_token_usage(usage)` — record token usage from API response
- `Agent::show_task_progress()` — emit task progress update if active
- `Agent::set_sink()` — replace output sink (for ACP session routing)
- `Agent::compact(override_keep, debug)` — compact context
- `Agent::ensure_system_prompt()` — build and inject system prompt
- `Agent::execute_command(cmd)` — execute slash commands
- `AgentLoop` — manages iteration counting (default max: 1000) and cancellation via `CancellationToken`
- `TaskManager` — async task delegation for meta profile

### LLM Client (`src/llm_client/`)
- `LlmClient::new()` — reads `AI_URL` env var (default: `http://ai365.home:9292`), `AI_API_KEY` env var
- `chat(messages, model)` — sends messages, returns content string
- `chat_cancellable(messages, model, cancel)` — chat with cancellation support
- `chat_with_model_config(messages, config, tools)` — sends messages with tool defs, returns `AgentResponse::Content` or `AgentResponse::ToolCalls(calls, usage, reasoning, content)`
- `chat_stream(messages, config, tools)` — streaming chat variant
- `chat_stream_cancellable(messages, config, tools, cancel)` — streaming with cancellation
- Fluent setters: `with_loud()`, `with_base_url()`, `with_api_key()`, `with_chat_timeout()`, `with_session_id()`, `with_stream()`, `with_cancellation_token()`, `with_providers()`
- Endpoint: `POST {base_url}/v1/chat/completions`
- `ping()` — check connectivity to AI URL
- `providers` field — stores configured providers for model name resolution

### Config System (`src/config.js`)
- `Config` object — configuration with defaults. Fields: `providers`, `default_provider`, `ai_url`, `default_model`, `temperature`, `thinker`, `toolfmt`, `tool_output_fmt`, `role`, `hide_tools`, `skills_path`, `profiles_path`, `prompts_path`, `system_prompt_template`, `chat_timeout_secs`, `embeddings_timeout_secs`, `profile`, `profiles`, `theme`, `colors`, `api_key`, `max_tool_output_lines`, `no_log`, `mcp_servers`, `compaction`
- `Provider` object — `name`, `url`, `api_key`, `models`
- `Profile` object — `whitelist_tools`, `blacklist_tools`, `skills`, `model`, `preload_skills`, `cwd_boundary`, `manager`, `aspects`
- `ModelEntry` object — `name`, `tags`, `temperature`, `max_tokens`, `context_limit`
- `McpServerConfig` object — `name`, `command`, `args`, `env`, `url`, `type_`, `headers`, `whitelist_tools`, `blacklist_tools`, `enabled`
- `CompactionSettings` object — `enabled`, `reserve_tokens`, `keep_recent_messages`
- Missing fields use defaults (from `DEFAULT_*` constants)
- Resolution priority: CLI arg → config file → env var → default
- `resolve_str` helper — generates config resolution methods with priority chain: CLI argument → config file → environment variable → constant default
- Methods: `resolve_url()`, `resolve_model()`, `resolve_skills_path()`, `resolve_profiles_path()`, `resolve_prompts_path()`, `resolve_system_prompt_path()`, `resolve_profile()`, `resolve_role()`, `get_profile()`, `resolve_api_key()`, `resolve_model_config()`, `load_with_fallback()`, `load_file()`

### System Prompt (`src/context/system_prompt.js`)
- `init_system_prompt_template(template_path)` — pre-compiles template from file path, called at startup
- `build_system_prompt(model, role, body, available_tools, aspects, agents_md, profile_name)` — constructs system prompt from template with placeholders for `{model}`, `{cwd}`, `{platform}`, `{date}`, `{time}`, `{session_start}`, `{role}`, `{body}`, `{aspects}`, `{tool_guidelines}`, `{agents_md}`, `{profile_name}`
- `build_system_prompt_with_skills()` — wraps `build_system_prompt` and appends skills preamble
- `render_skills_preamble(skills, skill_directories)` — renders skills_preamble template, filters disabled/invisible skills, shows loaded content vs descriptions
- Uses `config/templates/system_prompt.md` as the base template
- Tool guidelines are auto-loaded from `src/tools/<name>/guidelines.md` for each available tool

### Profiles (`src/context/profiles/`)

File-based profile definitions follow the same YAML frontmatter + markdown body pattern as skills.

- `ProfileFile` object — parsed from `.profile.md` files: `name`, `description`, `role`, `blacklist_tools`, `body`, `whitelist_tools`, `preload_skills`
- `parse(content, file_name)` — extracts YAML frontmatter and markdown body from a profile file
- `load_profiles_from_dir(path)` — scans directory for `*.profile.md` files, returns map of profiles
- Profile file `role` fills the `{role}` template placeholder
- Profile file `body` fills the `{body}` template placeholder
- Config file settings take precedence over profile file settings for tool restrictions

### Config Resolution (`src/resolver.js`)
- `Resolver<T>` — generic priority-chain resolver for any type: CLI → file → env → default
- `StringResolver` — string-specific resolver with lazy env var evaluation via `with_env_fn()`
- Builder methods: `new()`, `with_cli()`, `with_file()`, `with_env_fn()`, `resolve()`

### Initialization (`src/init/resolution.js`)

The entire agent initialization pipeline lives here — encapsulated to make it testable and reusable.

- `Cli` object — CLI argument definitions (all data fields, no binary logic). Fields: `subcommand`, `config`, `ai_url`, `api_key`, `model`, `role`, `skills_path`, `prompts_path`, `chat_timeout`, `embeddings_timeout`, `profile`, `provider`, `colors`, `no_colors`, `theme`, `prompt`, `thinker`, `toolfmt`, `tool_output_fmt`, `loud`, `hide_tools`, `show_tools`, `preload_skills`, `tui_debug`, `session_id`, `no_log`, `tokens`, `no_stream`, `compact_debug`
- `Subcommand` enum — `Info`, `Cli`, `Tui`, `Review { session_id, json, tool_index }`, `ShowPrompt` subcommands
- `SwitchProfile` object — merged profile data for runtime switching: `role`, `body`, `model`, `aspect_body`
- `AgentBuilder` — encapsulates the full initialization pipeline:
  - `new(cli)` — merges CLI args with config file
  - `model_registry()` — builds `ModelRegistry` from CLI `--models` and config `models`
  - `llm_client(loud)` — builds `LlmClient` with resolved URL and timeouts
  - `colors()` — resolves `ColorPalette` from CLI, config, and theme file
  - `profile()` — resolves profile name and `Profile` object
  - `tool_registry(models, profile)` — builds `ToolRegistry` from config and profile
  - `build_components()` — returns `BuildOutput` with all resolved pieces
- `BuildOutput` — grouped into focused sub-objects:
  - `runtime: AgentRuntime` — registry, client, skills, all_skills, skill_directories, role, profile_body, aspect_body, prompts_loader
  - `session: AgentSession` — profile, preload_skills, session_id, no_log
  - `formatting: AgentFormatting` — thinker_format, tool_format, tool_output_fmt, hide_tools
  - Plus flat fields: `config`, `stream`, `base_url`, `model`, `skills_path`, `profile_name`, `theme_file`, `chat_timeout`, `embeddings_timeout`, `active_provider`, `profiles`, `compact_debug`
- `ConfigResolver` interface — config resolution interface (`base_url`, `api_key`, `thinker_format`, `tool_format`, `tool_output_fmt`, `hide_tools`)
- `AgentBuilder` implements `ConfigResolver`
- `AgentBuilder::formatted_sink()` — constructs a fully-configured output sink in one call
- Model resolution flows through `model_name()`: CLI model → profile model → config default_model → provider model → DEFAULT_MODEL
- Provider resolution: `--provider` CLI flag or `default_provider` config key selects the active provider; model names are prefixed with provider name when active

`main.js` is thin — only contains the entry point with subcommand dispatch and binary-specific UI setup. All initialization logic is in `src/init/`, which can be tested independently.
