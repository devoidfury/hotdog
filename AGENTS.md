# Agent Harness

JS project `oa-js` — an AI agent harness with tool calling support. This is a port from the rust version /workspace/oa-agent/

## Quick Reference

- **Run:** `bun src/main.js` / **One-shot:** `bun src/main.js "hello"` / **TUI:** interactive
- **With profile:** `--profile minimal` / **With model:** `--model qwen3.5-0.8b`
- **Test:** `bun test --only-failures`

## Rules & Guidelines

- Do not add heavy dependencies for minor convenience.
- Do not add speculative config/feature flags "just in case".
- Always use `qwen3.5-0.8b` when testing with real LLM endpoints.

### Centralized Defaults
All hard-coded configurable strings (model names, host URLs, ports, format templates, timeouts, etc.) must live in `src/config.js` as named constants. Never duplicate.

### UI Layer Separation
All UI/display logic lives under `src/ui/`. The `OutputSink` class in `src/context/output.js` is the core abstraction. Each UI module (CLI) implements output independently.

Similarly, the `Input` handling lives in `src/context/input.js` with `parseInput()` for question/answer collection.

### Spotting Separation-of-Concerns Issues
When adding `OutputEvent` variants, check: does the variant carry a pre-formatted display string? If so, split into raw data + a `format_*()` function in `src/ui/cli.js`.
