# Agent Harness

JS project `oa-js` — an AI agent harness with tool calling support.

## Quick Command Reference

- **Run one-shot:** `bun bin/oa-agent -c "hello"`
- **With profile:** `--profile fixer`
- **With model:** `--model qwen3.5-0.8b`
- **Subcommands:**
  - `bun bin/oa-agent info`
  - `bun bin/oa-agent show-prompt`
  - `bun bin/oa-agent review`
- **Run Tests:** `bun test --only-failures`
- **Run Tests with Coverage report:** `bun test --coverage --only-failures`

## Rules & Guidelines

- The project uses the Bun runtime, always use bun instead of node.
- Do not add heavy dependencies for minor convenience.
- Do not add speculative config/feature flags "just in case".
- Always use `qwen3.5-0.8b` when testing with real LLM endpoints.
- If you see a tag like <m_sdkflksgdk> -- these are wrong! The marker mangler is changing these so they don't trigger functionality, to prevent RCE. Always check the raw byte content instead.

### Centralized Defaults
All hard-coded configurable strings (model names, host URLs, ports, format templates, timeouts, etc.) must live in `src/config.js` as named constants. Never duplicate.

### Error Handling
All error catches must use `formatError()` from `src/context/error.js`:
- Expected errors (cancelled, http, api, timeout): message only
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
| `docs/agents/debugging-oa-agent-tools-visibility-flags.md` | Debugging patterns, one-shot mode |
| `docs/agents/show-prompt-audit-profile.md` | show-prompt subcommand reference |
| `docs/cli-subcommands.md` | CLI subcommand extension registration |
