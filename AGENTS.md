# Agent Harness

JS project `oa-js` — an AI agent harness with tool calling support. This is a port from the rust version /workspace/oa-agent/

## Quick Reference

- **Run:** `bun src/main.js` / **One-shot:** `bun src/main.js -c "hello"` / **Interactive:** default mode (readline)
- **With profile:** `--profile minimal` / **With model:** `--model qwen3.5-0.8b`
- **Test:** `bun test --only-failures`
- **Coverage:** `bun test --coverage`

## Rules & Guidelines

- Do not add heavy dependencies for minor convenience.
- Do not add speculative config/feature flags "just in case".
- Always use `qwen3.5-0.8b` when testing with real LLM endpoints.

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

### Module Layout (mirrors Rust `oa-agent/src/`)

```
src/
├── main.js          — Entry point: parse args → dispatch subcommand → build agent → run
├── cli.js           — CLI argument parsing + HELP_TEXT constant
├── config.js        — All defaults, provider config loading
├── agent/
│   ├── agent.js       — Agent core (LLM loop, tool execution)
│   ├── commands.js    — Slash command parsing + execution
│   ├── message_bus.js — Message bus (run loop, enqueue/dequeue)
│   ├── worker.js      — Task manager / subagent support
│   ├── session_builder.js — Init pipeline encapsulation (CLI+config→shared resources)
│   ├── session_manager.js — Session lifecycle (owns builder + current agent, agent swaps)
│   └── session_store.js   — Multi-session storage (map of agents keyed by session ID)
├── ui/
│   ├── cli.js         — CliOutputSink (formatting + color emission)
│   ├── colors.js      — Color palettes, ANSI helpers, theme resolution
│   ├── session.js     — Interactive CLI session (readline loop, command dispatch)
│   ├── info.js        — Info subcommand (print system diagnostics)
│   ├── show_prompt.js — Show-prompt subcommand
│   └── review.js      — Review subcommand (session log inspection)
├── context/
│   ├── output.js    — OutputSink base class + OUTPUT_EVENT types
│   ├── input.js     — parseInput() for question/answer collection
│   └── message.js   — Message types
├── init/resolution.js — buildAgentConfig() (resolves CLI+config→resolved)
├── llm_client/client.js — LLM HTTP client
├── mcp/             — MCP server connections (HTTP + stdio)
├── skills/loader.js — Skills discovery and loading
├── prompts/loader.js — Prompt template loading
├── tools/           — Individual tool implementations
└── session_log.js   — Session logging
```

When adding new subcommands, add them to `src/ui/` as a separate file and dispatch from `main.js`.

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

For the Rust reference, see `/workspace/oa-agent/docs/agents/`.
