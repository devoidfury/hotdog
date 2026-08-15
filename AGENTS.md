# Agent Harness

JS project `hotdog` — an AI agent harness.

## Quick CLI Reference

- Run one-shot: `bun bin/hotdog -p "hello"` or `bun bin/hotdog prompt "hello"`
- Interactive: `bun bin/hotdog` (starts readline session)
- Subcommands:
  - `bun bin/hotdog --help` — view additional subcommands and available arguments
  - `bun bin/hotdog info` — system info and diagnostics
  - `bun bin/hotdog show-prompt` — render system prompt to stdout
  - `bun bin/hotdog profiles` — list all available profiles
  - `bun bin/hotdog prompt "text"` — one-shot mode
- Run Tests: `bun run test`
  - with Coverage report: `bun run coverage`
  - NOTE: uses `--only-failures`, which runs all tests, prints failures, and supresses green test output.

## Rules & Guidelines

- The project uses Bun runtime. Instead of node, always use bun.
- Do not add dependencies.
- Do not add speculative config/feature flags "just in case".
- IMPORTANT: If you see a tag like `<m_ar7e78o7kuqn36jg>` or similar -- this is not the actual content in the source file! The marker mangler is changing these so they don't trigger functionality, to prevent RCE. When relevant, double check the raw byte content using a command like `xxd`.

### Centralized Defaults
The source of truth for all configurable values in core is `src/core/core.config.json`.
Defaults are exported from `src/core/config/defaults.ts` for use by the config resolution
layer (`getDefaultConfig()`). Components (`Agent`, `LlmClient`, `TaskManager`, etc.) receive
resolved values from callers — do not import `DEFAULT_*` constants in components.
Static path constants (`DEFAULT_PROFILES_SUBPATH`, `DEFAULT_CONFIG_FILENAME`,
`DEFAULT_SYSTEM_PROMPT_FILENAME`, `DEFAULT_PROFILES_PATH`, `DEFAULT_PROMPTS_PATH`)
and runtime fallbacks (`DEFAULT_SYSTEM_PROMPT_TEMPLATE`) are exempt from this rule.

Extensions may also define configSchema in the same way via `src/extensions/*/extension.json` file.

### Error Handling
All error catches must use `formatError()` from `src/core/error.ts`:
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
| `docs/config-reference.md` | Complete `defaults.json` config reference — all settings, extensions, providers |
| `docs/hook-lifecycle.md` | Hook system lifecycle and extension registration patterns |
