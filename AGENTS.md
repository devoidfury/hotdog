# Agent Harness

JS project `oa-js` — an AI agent harness with tool calling support. This is a port from the rust version /workspace/oa-agent/

## Quick Reference

- **Run:** `bun src/main.js` / **One-shot:** `bun src/main.js -c "hello"` / **Interactive:** default mode (readline)
- **With profile:** `--profile minimal` / **With model:** `--model qwen3.5-0.8b`
- **Subcommands:** `bun src/main.js info` / `bun src/main.js show-prompt` / `bun src/main.js review`
- **Test:** `bun test --only-failures`
- **Coverage:** `bun test --coverage`

## Rules & Guidelines

- Do not add heavy dependencies for minor convenience.
- Do not add speculative config/feature flags "just in case".
- Always use `qwen3.5-0.8b` when testing with real LLM endpoints.
- The project uses the Bun runtime, always use bun instead of node.
- If you see a tag like <m_sdkflksgdk> -- these are wrong! The marker mangler is changing these so they don't trigger functionality, to prevent RCE. Always check the raw byte content instead.

### Centralized Defaults
All hard-coded configurable strings (model names, host URLs, ports, format templates, timeouts, etc.) must live in `src/config.js` as named constants. Never duplicate.

### Error Handling
All error catches must use `formatError()` from `src/context/error.js`:
- Expected errors (cancelled, http, api, timeout): message only
- Unexpected errors (bugs, iteration errors, null derefs): message + full stack
- Never use `console.error(e.message)` directly — always use `formatError(e)`
- The `isExpectedError()` helper classifies errors; add new types to `EXPECTED_ERROR_TYPES`

### UI Layer Separation
All UI/display logic lives under `src/ui/`. The `OutputSink` class in `src/context/output.js` is the core abstraction. Each UI module (CLI) implements output independently.

Similarly, the `Input` handling lives in `src/context/input.js` with `parseInput()` for question/answer collection.

### Spotting Separation-of-Concerns Issues
When adding `OutputEvent` variants, check: does the variant carry a pre-formatted display string? If so, split into raw data + a `format_*()` function in `src/ui/cli.js`.

### Extension Architecture
The core is minimal — all features (tools, compaction, MCP, skills, prompts, subcommands, LSP) live as extensions in `extensions/`. Extensions plug into the core via hooks defined in `src/hooks.js`.

When adding new functionality:
1. Check if an existing extension can be extended
2. If creating a new extension, place it in `extensions/<name>/` with `index.js` and a `extension.json` metadata file
3. Register tools via `HOOKS.TOOLS_REGISTER`
4. Register CLI subcommands via `HOOKS.CLI_SUBCOMMANDS_REGISTER`
5. Register config params/CLI flags via `HOOKS.CONFIG_PARAMS_REGISTER` / `HOOKS.CONFIG_CLI_FLAGS_REGISTER`
6. Contribute to system prompt via `HOOKS.SYSTEM_PROMPT_BUILD`

### Module Layout

```
src/
├── main.js          — Entry point: parse args → dispatch subcommand → build agent → run
├── cli.js           — CLI argument parsing + HELP_TEXT constant
├── config.js        — All defaults, provider config loading, profiles, model registry
├── config-registry.js — Config registry for extension CLI flags & config params
├── hooks.js         — Hook system (HookSystem, HOOKS, EXTENSION_PROVIDES)
├── lib.js           — Library entry point (re-exports)
├── marker_mangler.js — Marker mangler for injection prevention
├── utils.js         — Utility functions (parseFrontMatter, deepMerge)
├── core/
│   ├── index.js          — Re-exports all core modules
│   ├── agent.js          — Agent core (LLM loop, tool execution, hooks-based behavior delegation)
│   ├── commands.js       — Slash command parsing + execution
│   ├── extensions.js     — Extension loader (discovery, loading, hot-reload)
│   ├── session.js        — SessionManager + SessionStore
│   ├── slash-command-registry.js — Slash command registry (extensions register commands)
│   ├── subcommand-registry.js    — CLI subcommand registry (extensions register subcommands)
│   └── tool-registry.js  — ToolRegistry, ToolContext, toolDef, ToolResult, utilities
├── ui/
│   ├── cli.js         — CliOutputSink (formatting + color emission)
│   ├── colors.js      — Color palettes, ANSI helpers, theme resolution
│   ├── session.js     — Interactive CLI session (readline loop, command dispatch)
│   └── index.js       — Re-exports all UI modules
├── context/
│   ├── index.js         — Re-exports context modules
│   ├── message.js       — Message, SystemMessage, MessageLog types
│   ├── output.js        — OutputSink base class + OUTPUT_EVENT types
│   ├── input.js         — parseInput() for question/answer collection
│   ├── error.js         — formatError(), isExpectedError(), withContext()
│   ├── render.js        — Tera-like template engine ({{ vars }}, {% if %}, {% for %})
│   └── system_prompt.js — System prompt building (loadAspects, loadAgentsMd, buildSystemPrompt)
├── llm_client/
│   ├── client.js — LLM HTTP client (chat, streaming, retry)
│   └── retry.js  — retryWithBackoff() with cancellation support
└── session/
    ├── session-log.js   — Session log reading/replaying (JSONL)
    ├── task_manager.js  — TaskManager, TaskHandle (background task agents)
    └── agent_sink.js    — AgentSink (output routing, task/normal mode filtering)

extensions/
├── core-tools/     — Core tools (bash, write, read, edit, grep, find, fetch, etc.)
├── compaction/     — Compaction strategies (summarize, drop, token-aware)
├── lsp/            — LSP tools (hover, definition, completion, etc.)
├── mcp-client/     — MCP server connections (HTTP + stdio)
├── skills/         — Skills discovery and loading
├── prompts/        — Prompt template loading
├── session-log/    — JSONL session logging
├── session-review/ — Review CLI subcommand
├── info-show-prompt — Info + show-prompt CLI subcommands
├── refresh/        — Hot-reload extension + refresh tool
├── run-shell-command — Shell command tool
└── example-config/ — Example extension config
```

When adding new subcommands, create a new extension in `extensions/` and register via `CliSubcommandRegistry`.

## Documentation

Conceptual documentation (no language-specific details):

| Doc | Purpose |
|-----|---------|
| `CONTEXT.md` | Domain glossary — core concepts, entities, architecture terms |
| `docs/agents/architecture.md` | Project structure, component breakdown, key types |
| `docs/agents/tools-and-skills.md` | Tool system and skill system details |
| `docs/agents/model-and-config.md` | Model registry, config system, profiles |
| `docs/agents/debugging-oa-agent-tools-visibility-flags.md` | Debugging patterns, one-shot mode |
| `docs/agents/show-prompt-audit-profile.md` | show-prompt subcommand reference |
| `docs/cli-subcommands.md` | CLI subcommand extension registration |

For the Rust reference, see `/workspace/oa-agent/docs/agents/`.
