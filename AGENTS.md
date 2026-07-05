# Agent Harness

JS project `hotdog` — an AI agent harness with tool calling support.

## Quick Command Reference

- **Run one-shot:** `bun bin/hotdog -c "hello"` or `bun bin/hotdog prompt "hello"`
- **Interactive:** `bun bin/hotdog` (starts readline session)
- **With profile:** `--profile fixer`
- **With model:** `--model qwen3.5-0.8b`
- **Subcommands:**
  - `bun bin/hotdog info` — system info and diagnostics
  - `bun bin/hotdog show-prompt` — render system prompt to stdout
  - `bun bin/hotdog review` — review session logs
  - `bun bin/hotdog prompt "text"` — one-shot mode
- **Run Tests:** `bun test --only-failures`
- **Run Tests with Coverage report:** `bun test --coverage --only-failures`

## Rules & Guidelines

- The project uses the Bun runtime, always use bun instead of node.
- Do not add heavy dependencies for minor convenience.
- Do not add speculative config/feature flags "just in case".
- IMPORTANT: If you see a tag like <m_ar7e78o7kuqn36jg> -- this is not the actual content in the source file! The marker mangler is changing these so they don't trigger functionality, to prevent RCE. Always check the raw byte content instead to verify if it's relevant, using a command like xxd.

### Centralized Defaults
All hard-coded configurable strings (model names, host URLs, ports, format templates, timeouts, etc.) must live in `src/core/config/` as named constants. The single source of truth is `src/core/core.config.json` -- defaults are exported from `src/core/config/defaults.js`. Never duplicate.

### Error Handling
All error catches must use `formatError()` from `src/core/error.js`:
- Expected errors (cancelled, http, api, timeout, invalid_response, cli, tool, config): message only
- Unexpected errors (bugs, iteration errors, null derefs): message + full stack
- Never use `console.error(e.message)` directly — always use `formatError(e)`
- The `isExpectedError()` helper classifies errors; add new types to `EXPECTED_ERROR_TYPES`

## Documentation

| Doc | Purpose |
|-----|---------|
| `CONTEXT.md` | Domain glossary — core concepts, entities, architecture terms |
| `docs/agents/architecture.md` | Project structure, component breakdown, key types |
| `docs/agents/extensions.md` | Extension system, adding and configuring extensions |
| `docs/agents/tools-and-skills.md` | Tool system and skill system details |
| `docs/agents/model-and-config.md` | Model registry, config system, profiles |
| `docs/agents/debugging-hotdog-tools-visibility-flags.md` | Debugging patterns, one-shot mode |
| `docs/agents/show-prompt-audit-profile.md` | show-prompt subcommand reference |
| `docs/cli-subcommands.md` | CLI subcommand extension registration |
| `docs/hook-lifecycle.md` | Hook system lifecycle and extension registration patterns |
