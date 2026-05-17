# TODO: Align JS (`oa-js`) with Rust (`oa-agent`)

## 🔴 Completely Missing (no JS equivalent)

### Tools
- [ ] **explore tool** — Rust has `tools/explore/mod.rs` (~262 lines) for file/directory exploration with outline generation. Args: `path`, `outline`.

### Session Management
- [x] **session_manager** — `src/agent/session_manager.js` for session lifecycle, agent swaps for profile switching. Decouples UI from Agent type.
- [x] **session_store** — `src/agent/session_store.js` for multi-session agent storage (ACP mode). Map of agents keyed by session ID.
- [x] **session_builder** — `src/agent/session_builder.js` encapsulates the full init pipeline (CLI + config → resolved config → shared resources). Cloneable for agent swaps.

### UI
- [ ] **FormattedSink** — Rust has `ui/cli/formatted_sink.rs` (~351 lines) with event switching (tracks `current_event`, `current_len`), running byte length tracking, `TypedRenderer` trait, separate format strings for thinking/tool/tool-output.
- [ ] **UI common** — Rust has `ui/common.rs` (~483 lines) — `formatQuestion()`, `formatFinalResponse()`, `isEventVisible()`, `renderEvent()` with `TypedRenderer`, `Command` enum, `parseCommand()`, `dispatchCommand()`.
- [ ] **CLI session** — Rust has `ui/cli/session.rs` (~325 lines) — rustyline editor (history, autocomplete), command history, persistent history file, prompt management, signal handling.
- [ ] **colors** — Missing `loadPaletteFromFile(path)`, `pushColorOpening(colorName, useColors)`.

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

**Missing (skip — buggy in Rust):**
- [ ] `simpleUnifiedDiff(old, new)` — Simple unified diff
- [ ] `scopedDiff(old, new, path, start, end, ctx)` — Line-scoped diff
- [ ] `killProcessTree(pid)` — Kill process and children

### Agent Module (`agent/` → `agent/agent.js`)
**JS has consolidated many Rust agent files into `agent/agent.js`. Missing:**
- [x] **`agent/commands.js`** (~61 lines) — Slash command dispatch with `Command` enum, `parseCommand()`, `executeCommand()`. Extracted from inline in `main.js`.
- [x] **`agent/prompts.rs`** (~70 lines) — Named prompt execution with session logging, `disableModelInvocation` filtering. Fixed: preserves context (was clearing), lists available prompts on error, uses template engine for rendering.
- [ ] **`agent/lifecycle.rs`** (~296 lines) — Agent construction from builder, MCP setup, session restoration from log. JS has simplified constructor.
- [x] **`agent/skills.rs`** (~154 lines) — Skill deduplication, tool filtering by active skills, structured skill content wrapping (`<skill_content>`). Added: `isToolAllowed()`, `filteredToolDefs()`, `allowedToolNames()`, `combinedToolPatterns()`, structured skill wrapping with `<skill_resources>`, session logging.
- [x] **`agent/tools.rs`** (~174 lines) — Tool execution with truncation, output caching by `tool_call_id`, duration tracking. Added: tool allowance enforcement, duration tracking, first-use help display, output caching.
- [x] **`agent/context.rs`** (~313 lines) — Session log helpers, message context management, compaction integration. Added: `clearContext()`, `replaceMessages()`, `insertAt()`, `messages()` getter. Fixed: compaction uses `find_first_kept_index()`, `<previous-context-summary>` wrapper, `regenerateSystemPrompt()` prunes old `<skill_content>` blocks.

### LLM Client (`llm_client/` → `llm_client/client.js`)
**JS has consolidated HTTP, streaming, parsing into `client.js`. Missing:**
- [ ] **`llm_client/types.rs`** (~750 lines) — Dedicated types module: `ChatMessage`, `ToolCall`, `StreamChunk`, `Usage`, `Timings`, `ToolCallInfo`, `AgentResponse`, `Error` enum.
- [ ] **`llm_client/streaming.rs`** (~389 lines) — `StreamEvent` enum (Content, Reasoning, ToolName, ToolArgument, FinalContent, FinalReasoning, FinalToolCalls, Usage, Timings), `ParserState` accumulator, final events after `[DONE]`, `Timings` support.
- [ ] **`llm_client/parsing.rs`** (~408 lines) — `StreamChunk` parsing with `StreamChoice`, `StreamDelta`, `StreamToolCall`, `StreamFunction`. `ToolCallInfo` assembly from accumulated deltas.

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

### Security
- ✅ **marker_mangler** — `src/marker_mangler.js` (139 lines). Randomly aliases protected XML markers before sending to model, reverses on output. Integrated into `llm_client/client.js`.

### External Integrations
- ✅ **MCP client** — `src/mcp/` — full stdio + HTTP transport, tool discovery, exposes MCP server tools as native agent tools. Files: `client.js`, `connection.js`, `tools.js`, `types.js`, `index.js`.

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

### Utilities
- ✅ **ModelRegistry** — `src/config.js:buildModelRegistry()`, used throughout agent for model lookup and per-model config.
- ✅ **output_cache** — `src/agent/agent.js` — `this.outputCache = new Map()` with set/get for pager pagination.

## ⏭️ Deprecated / Skip

| Item | Reason |
|------|--------|
| `formatter` | Rust `formatter.rs` — deprecated in JS |
| `resolver` | Rust `resolver.rs` — deprecated in JS |
| `TUI` | ratatui/crossterm — not applicable to JS |
| `truncated_output` | Buggy in Rust, needs rethink |
| `simpleUnifiedDiff` | Buggy in Rust, skip |
| `scopedDiff` | Buggy in Rust, skip |
| `killProcessTree` | Buggy in Rust, skip |

## Notes

- The Rust uses atomic variables (`AtomicU8`, `AtomicUsize`) for thread-safe state tracking. JS is single-threaded so this isn't needed.
- Rust's `push_color_opening()` emits ANSI sequences inline for streaming output. JS's `apply_color()` wraps the full string — adequate for non-streaming, but streaming chunks would need ANSI prefix handling for correct color transitions.
- **Prompt caching fix** — `Message.toJSON()` now omits `content` field when null/empty (matching Rust's `skip_serializing_if = "Option::is_none"`). Previously sent `content: ""` which broke API cache keys for assistant messages with tool calls.
- **Tool arg handling** — All tools now use dedicated `parseArgs()` functions with proper defaults, required field validation, and type normalization (matching Rust's `from_json()` pattern).
- **Tool definitions** — All tools now use `toolDef()` with `schema`, `enum`, `minimum`, `maximum` constraints (matching Rust's `ToolParam` fields).
- **callDisplay** — All tools now use richer formatting matching Rust (e.g., `pattern in path (type, max)`, `path: 'old' → 'new'`, `[METHOD] url`).
- **Template engine** — All rendering (system prompt, profile body, prompts) now uses the shared `render()` from `context/render.js`, matching Rust's `render_template()` from `context/render.rs`. Supports `{{ vars }}`, `{% if %}`, `{% for %}`, filters (`|trim`, `|length`, `|exec`), and block tags.
