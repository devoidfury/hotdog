# TODO: Align JS (`oa-js`) with Rust (`oa-agent`)

## 🔴 Completely Missing (no JS equivalent)

### Tools
- [ ] **explore tool** — Rust has `tools/explore/mod.rs` (~262 lines) for file/directory exploration with outline generation. Args: `path`, `outline`.

### Security
- [ ] **marker_mangler** — Rust has `marker_mangler.rs` (~377 lines) for injection prevention. Randomly aliases protected XML markers (`<tool-call>`, `<system-notice>`, `<skill>`, etc.) before sending to model, reverses on output. Prevents model from generating injection attacks via marker syntax.

### Core Utilities
- [ ] **formatter** — Rust has `formatter.rs` (~136 lines) for `{}` placeholder replacement. Pre-compiled templates with left-to-right argument substitution. (deprecated in js)
- [ ] **resolver** — Rust has `resolver.rs` (~135 lines) for priority-chain resolution: CLI > file > env > default. Lazy env var evaluation (only called when higher-priority values absent). (deprecated in js)
- [ ] **truncated_output** — Rust has `tools/truncated_output.rs` (~247 lines) with `OutputPage` and `TruncatedOutput` structs for page-based output truncation. (this is buggy in rust and we should rethink this)

### Session Management
- [ ] **session_manager** — Rust has `agent/session_manager.rs` (~110 lines) for session lifecycle, agent swaps for profile switching. Decouples UI from Agent type.
- [ ] **session_store** — Rust has `agent/session_store.rs` (~80 lines) for multi-session agent storage (ACP mode). Map of agents keyed by session ID.

### External Integrations
- [ ] **MCP client** — Rust has `mcp/` (~1k lines) for Model Context Protocol. stdio + HTTP transport, tool discovery, exposes MCP server tools as native agent tools.

### UI
- [ ] **TUI** — Rust has `ui/tui/` (~3.5k lines) with ratatui/crossterm. App state machine, key events, layout, widgets, theme, session display.

## 🟡 Partially Ported (functionality exists but missing features)

### Tools Common Utilities (`tools/common.rs` → `tools/registry.js`)
**Already in JS:** `parseToolArgs`, `toolResult`, `truncateOutput`, `generateDiff`, `validateCwdBoundary`

**Added:**
- [x] `toolDef` — now supports `schema`, `enum`, `minimum`, `maximum` via `param()` extra args
- [x] `param` — now accepts third `extra` arg for JSON Schema fields (enum, min/max, etc.)
- [x] `fileSize(path)` — Get file size in bytes
- [x] `writeFileWithParents(path, content)` — Write file, creating parent dirs
- [x] `resolvePath(requested)` — Resolve path with safety checks (cwd boundary)
- [x] **`ToolResult` struct** — Structured result with `output`, `error`, `metadata`, `success`, `output_tag`, `toDisplay()`, `toApiContent()`

**Missing:**
- [ ] `simpleUnifiedDiff(old, new)` — Simple unified diff (buggy, skip)
- [ ] `scopedDiff(old, new, path, start, end, ctx)` — Line-scoped diff (buggy, skip)
- [ ] `killProcessTree(pid)` — Kill process and children

### Tool Context (`tools/context.rs` → `tools/registry.js`)
**JS has simpler `ToolContext`. Missing fields:**
- [x] `workspace_root` — Project root path
- [x] `current_file` — Currently editing file
- [x] `model_names` — Available model names
- [x] `active_provider` — Active provider name
- [x] `cwd_boundary` — Directory boundary for file ops
- [ ] `output_cache` — Tool output cache (for pager pagination)

### Agent Module (`agent/` → `agent/agent.js`)
**JS has consolidated many Rust agent files into `agent/agent.js`. Missing:**
- [x] **`agent/commands.js`** (~61 lines) — Slash command dispatch with `Command` enum, `parseCommand()`, `executeCommand()`. Extracted from inline in `main.js`.
- [x] **`agent/prompts.rs`** (~70 lines) — Named prompt execution with session logging, `disableModelInvocation` filtering. Fixed: preserves context (was clearing), lists available prompts on error, uses template engine for rendering.
- [ ] **`agent/lifecycle.rs`** (~296 lines) — Agent construction from builder, MCP setup, session restoration from log. JS has simplified constructor.
- [x] **`agent/skills.rs`** (~154 lines) — Skill deduplication, tool filtering by active skills, structured skill content wrapping (`<skill_content>`). Added: `isToolAllowed()`, `filteredToolDefs()`, `allowedToolNames()`, `combinedToolPatterns()`, structured skill wrapping with `<skill_resources>`, session logging.
- [x] **`agent/tools.rs`** (~174 lines) — Tool execution with truncation, output caching by `tool_call_id`, duration tracking. Added: tool allowance enforcement, duration tracking, first-use help display, output caching.
- [x] **`agent/context.rs`** (~313 lines) — Session log helpers, message context management, compaction integration. Added: `clearContext()`, `replaceMessages()`, `insertAt()`, `messages()` getter. Fixed: compaction uses `find_first_kept_index()`, `<previous-context-summary>` wrapper, `regenerateSystemPrompt()` prunes old `<skill_content>` blocks.

### Model Registry (`model.rs` → inline in `agent.js`)
**JS has inline model config. Missing dedicated module:**
- [ ] `ModelRegistry` — Model lookup by name
- [ ] `ModelConfig` — Per-model settings (temperature, maxTokens, tags)
- [ ] `ModelUsageStats` — Per-model usage statistics
- [ ] `ModelUsageTracker` — Tracks requests, success/failure, token counts

### LLM Client (`llm_client/` → `llm_client/client.js`)
**JS has consolidated HTTP, streaming, parsing into `client.js`. Missing:**
- [ ] **`llm_client/types.rs`** (~750 lines) — Dedicated types module: `ChatMessage`, `ToolCall`, `StreamChunk`, `Usage`, `Timings`, `ToolCallInfo`, `AgentResponse`, `Error` enum.
- [ ] **`llm_client/streaming.rs`** (~389 lines) — `StreamEvent` enum (Content, Reasoning, ToolName, ToolArgument, FinalContent, FinalReasoning, FinalToolCalls, Usage, Timings), `ParserState` accumulator, final events after `[DONE]`, `Timings` support.
- [ ] **`llm_client/parsing.rs`** (~408 lines) — `StreamChunk` parsing with `StreamChoice`, `StreamDelta`, `StreamToolCall`, `StreamFunction`. `ToolCallInfo` assembly from accumulated deltas.

### UI (`ui/` → `ui/cli.js`)
**JS has `CliOutputSink` in `ui/cli.js` with formatting and colors. Missing:**
- [ ] **`ui/common.rs`** (~483 lines) — `formatQuestion()`, `formatFinalResponse()`, `isEventVisible()`, `renderEvent()` with `TypedRenderer`, `Command` enum, `parseCommand()`, `dispatchCommand()`.
- [ ] **`ui/cli/formatted_sink.rs`** (~351 lines) — `FormattedSink` with event switching (tracks `current_event`, `current_len`), running byte length tracking, `TypedRenderer` trait, separate format strings for thinking/tool/tool-output.
- [ ] **`ui/cli/session.rs`** (~325 lines) — `CliSession` with rustyline editor (history, autocomplete), command history, persistent history file, prompt management, signal handling.
- [ ] **`ui/colors.rs`** — Missing `loadPaletteFromFile(path)`, `pushColorOpening(colorName, useColors)`.

### Skills Loader (`context/skills/loader.rs` → `skills/loader.js`)
**JS has most features. Verify parity:**
- [ ] **`context/skills/types.rs`** (~326 lines) — `Skill`, `SkillConfig`, `SkillPreamble` types, `pattern_matches()`. JS has types inline.
- [ ] **`context/profiles/types.rs`** (~213 lines) — Profile types, aspect loading, profile merging. JS has types inline.
- [ ] **`context/prompts/types.rs`** (~223 lines) — Prompt types, rendering, template execution. JS has types inline.

### Template Engine Alignment (`render.js`)
**JS has `render.js` — a Tera-like template engine supporting `{{ vars }}`, `{% if %}`, `{% for %}`, filters (`|trim`, `|length`, `|exec`), and block tags.**
- [x] **System prompt template** — Uses `render()` from `context/render.js` via `buildSystemPrompt()`.
- [x] **Profile body** — `renderProfileBody()` in `init/resolution.js` now uses `render()` instead of manual `{{ ARGS }}` replace.
- [x] **Prompt templates** — `executePrompt()` in `agent.js` now uses `render()` instead of manual `{{ ARGS }}` replace.
- [x] All three rendering paths (system prompt, profile body, prompts) now use the same shared template engine, matching Rust's `render_template()` from `context/render.rs`.

## 🟢 Already Ported (complete or near-complete)

### Tools (updated to match Rust argument handling)
- ✅ **bash** — unchanged
- ✅ **write** — 7 modes, mode validation, in-memory edits, structured result, parseArgs, rich callDisplay
- ✅ **read** — directory handling, type param (lines/bytes), parseArgs, rich callDisplay, schema
- ✅ **edit** — line-trimmed fallback, input size validation, parseArgs, rich callDisplay, schema
- ✅ **grep** — parseArgs, rich callDisplay (`'pattern' in path`), regex validation, schema
- ✅ **find** — fd with find fallback, parseArgs, buildFdArgs, rich callDisplay, schema
- ✅ **fetch** — method validation, parseArgs, rich callDisplay (`[METHOD] url`), structured metadata, schema
- ✅ **question** — unchanged
- ✅ **pager** — unchanged
- ✅ **model** — name param, enum of available models, validation, parseArgs, rich callDisplay (`-> name`), schema
- ✅ **load_skill** — unchanged
- ✅ **project_info** — unchanged
- ✅ **review** — unchanged

### Subagent tools
- ✅ delegate_task, task_status, task_followup, task_interrupt, plan_status, complete_task

### Core
- ✅ LLM client: HTTP transport, SSE streaming, retry logic, cancellation
- ✅ Compaction: LLM-based message summarization
- ✅ CLI output sink: CliOutputSink with colors, formatting
- ✅ Review UI: session review, tool index
- ✅ Context: message log, output events, input parsing, system prompt
- ✅ Skills loader: pattern matching, auto-activation
- ✅ Prompts loader
- ✅ Profiles: loading, resolution, template rendering
- ✅ Session log: JSONL logging
- ✅ Init/resolution: config resolution, model resolution, profile resolution
- ✅ Agent: run loop, tool execution, compaction, skill activation, prompt execution
- ✅ Message bus: decoupled CLI/agent communication
- ✅ Message queue: FIFO buffer
- ✅ Worker: TaskManager, TaskWorker, async task delegation
- ✅ Tests: 10 test files (input, prompts, config, session_log, message, retry, output, template, registry, compaction)

## Notes

- The Rust uses atomic variables (`AtomicU8`, `AtomicUsize`) for thread-safe state tracking. JS is single-threaded so this isn't needed.
- Rust's `push_color_opening()` emits ANSI sequences inline for streaming output. JS's `apply_color()` wraps the full string — adequate for non-streaming, but streaming chunks would need ANSI prefix handling for correct color transitions.
- **Prompt caching fix** — `Message.toJSON()` now omits `content` field when null/empty (matching Rust's `skip_serializing_if = "Option::is_none"`). Previously sent `content: ""` which broke API cache keys for assistant messages with tool calls.
- **Tool arg handling** — All tools now use dedicated `parseArgs()` functions with proper defaults, required field validation, and type normalization (matching Rust's `from_json()` pattern).
- **Tool definitions** — All tools now use `toolDef()` with `schema`, `enum`, `minimum`, `maximum` constraints (matching Rust's `ToolParam` fields).
- **callDisplay** — All tools now use richer formatting matching Rust (e.g., `pattern in path (type, max)`, `path: 'old' → 'new'`, `[METHOD] url`).
- **Template engine** — All rendering (system prompt, profile body, prompts) now uses the shared `render()` from `context/render.js`, matching Rust's `render_template()` from `context/render.rs`. Supports `{{ vars }}`, `{% if %}`, `{% for %}`, filters (`|trim`, `|length`, `|exec`), and block tags.
