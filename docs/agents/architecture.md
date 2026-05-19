# Architecture

## Overview

`oa-agent` is an AI agent harness with tool calling support. It connects to an LLM API, sends conversation messages, handles tool calls from the LLM, and executes tools (bash, file writing, model switching, skill loading).

## Key Components

### Context (`src/context/`)
- **`MessageLog`** — stores message history (`Message { role, content, reasoning_content, tool_calls, tool_call_id }`). Methods: `append()`, `addMessage()`, `addSystemMessage()`, `addUserMessage()`, `addAssistantMessage()`, `addToolMessage()`, `insertAt()`, `reset()`, `messages()`, `messageCount()`, `replaceMessages()`
- **`OUTPUT_EVENT`** — event type constants: `USER_MESSAGE`, `ASSISTANT_MESSAGE`, `THINKING`, `TOOL_CALL`, `TOOL_RESULT`, `COMPACTING`, `COMMAND_RESULT`, `QUESTION`, `STREAMING_CHUNK`, `STREAMING_REASONING_CHUNK`, `TASK_PROGRESS`, `TOKEN_USAGE`
- **`EVENT_HANDLERS`** — maps event types to handler method names on `OutputSink`
- **`OutputSink`** — base class with `emit()` plus convenience methods (`emitThinking`, `emitToolCall`, `emitToolResult`, `emitAssistantMessage`, `emitUserMessage`, `emitCompacting`, `emitQuestion`, `emitStreamingChunk`, `emitTaskProgress`)
- **`NoopSink`** — no-op implementation for testing and show-prompt
- **`parseInput()`** — parses raw text into `{ type: 'text' | 'command', value }` events
- **`NoopInput`** — no-op input implementation that returns defaults

### Agent (`src/agent/`)
- **`Agent`** — run loop, tool dispatch, model switching, context management. Constructor takes a config object with fields: `client`, `context`, `model`, `modelRegistry`, `sink`, `hideTools`, `hideThinking`, `skills`, `allSkills`, `skillDirectories`, `activeSkills`, `maxToolOutputLines`, `sessionId`, `cwdBoundary`, `role`, `profileBody`, `stream`, `compaction`, `compactDebug`, `showTokenUse`, `profileName`, `taskManager`, `promptsLoader`, `skillsLoader`, `sessionLog`, `mcpConnections`
- **`Agent.run()`** — main iteration loop
- **`Agent.switchModel(modelName)`** — switch to a specific model by name
- **`Agent.cancel()`** — cancel the running agent loop
- **`Agent.currentModel()`** — returns the current model name
- **`Agent.modelNames()`** — returns all registered model names
- **`Agent.profileNames()`** — returns all available profile names
- **`Agent.switchProfile(profileName)`** — switch to a named profile
- **`Agent.sessionId()`** — returns the session ID
- **`Agent.tokenUsage()`** — returns current model and all usage stats
- **`Agent.recordTokenUsage(usage)`** — record token usage from API response
- **`Agent.compact(overrideKeep, debug)`** — compact context
- **`Agent.executeCommand(cmd)`** — execute slash commands
- **`AgentLoop`** — manages iteration counting (default max: 1000) and cancellation via `CancellationToken`
- **`TaskManager`** — async task delegation for meta profile
- **`AgentConfig`** — plain object bundling all configuration for agent construction

### Commands (`src/agent/commands.js`)
- **`Command`** — enum: `Help`, `Quit`, `Clear`, `ClearProfile`, `Tools`, `Thinking`, `Models`, `Model`, `Tokens`, `Compact`, `Prompt`, `Regenerate`, `Skill`, `Unknown`
- **`parseCommand(cmd)`** — parses raw command string into typed command object
- **`executeCommand(agent, command)`** — executes parsed command on agent
- **`isUiCommand(type)`** — checks if command is handled by UI layer (not delegated to agent)

### LLM Client (`src/llm_client/`)
- **`LlmClient`** — reads `AI_URL` env var (default: `http://ai365.home:9292`), `AI_API_KEY` env var
- **`chat(messages, model)`** — sends messages, returns content string
- **`chatCancellable(messages, model, cancel)`** — chat with cancellation support
- **`chatWithModelConfig(messages, config, tools)`** — sends messages with tool defs, returns `{ content }` or `{ toolCalls, usage, reasoning, content }`
- **`chatStream(messages, config, tools)`** — streaming chat variant
- **`chatStreamCancellable(messages, config, tools, cancel)`** — streaming with cancellation
- **Fluent setters**: `withLoud()`, `withBaseUrl()`, `withApiKey()`, `withChatTimeout()`, `withSessionId()`, `withStream()`, `withCancellationToken()`, `withProviders()`
- **Endpoint**: `POST {baseUrl}/v1/chat/completions`
- **`ping()`** — check connectivity to AI URL
- **`providers`** field — stores configured providers for model name resolution
- **`retry.js`** — retry logic with exponential backoff

### Config System (`src/config.js`)
- **`DEFAULT_*`** constants — all defaults live here: `DEFAULT_MODEL`, `DEFAULT_AI_URL`, `DEFAULT_THINKER`, `DEFAULT_TOOL_FMT`, `DEFAULT_TOOL_OUTPUT_FMT`, `DEFAULT_SKILLS_PATH`, `DEFAULT_PROFILES_PATH`, `DEFAULT_PROMPTS_PATH`, `DEFAULT_CHAT_TIMEOUT_SECS`, `DEFAULT_MAX_TOKENS`, `DEFAULT_MAX_ITERATIONS`, `DEFAULT_ROLE`, `DEFAULT_MAX_TOOL_OUTPUT_LINES`, `DEFAULT_COMPACTION_ENABLED`, `DEFAULT_COMPACTION_RESERVE_TOKENS`, `DEFAULT_COMPACTION_KEEP_RECENT_MESSAGES`
- **`loadConfig(configPath)`** — loads config from file, falls back to `./config/defaults.json` then `~/.config/oa-agent/default.json`, then defaults
- **`buildModelRegistry({ providers })`** — builds model lookup map from provider configs
- **`Provider`** — `name`, `url`, `apiKey`, `models`
- **`Profile`** — `whitelistTools`, `blacklistTools`, `skills`, `model`, `preloadSkills`, `cwdBoundary`, `manager`, `aspects`
- **`ModelEntry`** — `name`, `tags`, `temperature`, `maxTokens`, `contextLimit`
- **`McpServerConfig`** — `name`, `command`, `args`, `env`, `url`, `type_`, `headers`, `whitelistTools`, `blacklistTools`, `enabled`
- **`CompactionSettings`** — `enabled`, `reserveTokens`, `keepRecentMessages`
- Resolution priority: CLI arg → config file → env var → default constant

### System Prompt (`src/context/system_prompt.js`)
- **`initSystemPromptTemplate(templatePath)`** — pre-compiles template from file path (called from `init/resolution.js`)
- **`buildSystemPrompt(model, role, body, availableTools, aspects, agentsMd, profileName)`** — constructs system prompt from template with placeholders for `{model}`, `{cwd}`, `{platform}`, `{date}`, `{time}`, `{session_start}`, `{role}`, `{body}`, `{aspects}`, `{tool_guidelines}`, `{agents_md}`, `{profile_name}`
- **`buildSystemPromptWithSkills()`** — wraps `buildSystemPrompt` and appends skills preamble
- **`renderSkillsPreamble(skills, skillDirectories)`** — renders skills_preamble template, filters disabled/invisible skills
- **`loadAspects(aspectNames)`** — loads `.aspect.md` files from `config/aspects/`
- **`loadAgentsMd()`** — loads `AGENTS.md` from CWD
- Uses `config/templates/system_prompt.md` as the base template
- Tool guidelines are auto-loaded from `src/tools/<name>/guidelines.md` for each available tool

### Template Engine (`src/context/render.js`)
- **`render(template, context)`** — Tera-like template engine supporting `{{ vars }}`, `{% if %}`, `{% for %}`, filters (`|trim`, `|length`, `|exec`), and block tags
- **`compile(template)`** — compiles template string into render function
- **`renderTemplate`** — alias for `render`

### Profiles
File-based profile definitions in `config/profiles/*.profile.md` use YAML frontmatter + markdown body pattern.
- **`ProfileFile`** — parsed from `.profile.md` files: `name`, `description`, `role`, `blacklistTools`, `body`, `whitelistTools`, `preloadSkills`
- **`parseFrontMatter(content)`** — extracts YAML frontmatter and markdown body
- **`loadProfileFiles(profilesPath)`** — scans directory for `*.profile.md` files, returns map of profiles
- Profile file `role` fills the `{role}` template placeholder
- Profile file `body` fills the `{body}` template placeholder
- Config file settings take precedence over profile file settings for tool restrictions

### Initialization (`src/init/resolution.js`)

The entire agent initialization pipeline lives here — encapsulated to make it testable and reusable.

- **`buildConfig(cliArgv)`** — single entry point for config resolution. Returns `{ resolved, modelRegistry, providers }`
- **`buildAgentConfig({ cli, config, providers, defaultModel, defaultRole, profilesPath })`** — resolves all values through priority chain
- **`SwitchProfile`** — merged profile data for runtime switching: `role`, `body`, `model`, `aspectBody`
- Model resolution flows through `buildAgentConfig`: CLI model → profile model → config `defaultModel` → provider's first model → `DEFAULT_MODEL`
- Provider resolution: `--provider` CLI flag or `defaultProvider` config key selects the active provider; model names are prefixed with provider name when active

### UI Layer (`src/ui/`)
- **`cli.js`** — `CliOutputSink` class: formatting + color emission, implements `OutputSink`
- **`colors.js`** — Color palettes, ANSI helpers, theme resolution
- **`session.js`** — `runInteractiveSession()`: readline loop, slash command dispatch, SIGINT handling
- **`info.js`** — `runInfo()`: prints system diagnostics
- **`show_prompt.js`** — `runShowPrompt()`: renders system prompt without LLM connection
- **`review.js`** — `runReview()`: session log inspection with JSON output and tool index

### Session Management (`src/agent/`)
- **`SessionBuilder`** — init pipeline encapsulation: CLI + config → resolved config → shared resources. Cloneable for agent swaps.
- **`SessionManager`** — session lifecycle: owns builder + current agent, handles agent swaps for profile switching
- **`SessionStore`** — multi-session storage: map of agents keyed by session ID

### Message Bus (`src/agent/message_bus.js`)
- Decoupled CLI/agent communication via channels
- Single-threaded dispatch owning the run loop
- Methods: `enqueue()`, `run()`, `runUntilCancelled()`, `cancel()`

### Message Queue (`src/agent/message_queue.js`)
- Thread-safe FIFO buffer for external event injection

### Worker (`src/agent/worker.js`)
- `TaskManager`, `TaskWorker`, async task delegation
- Task lifecycle: spawn → LLM loop with tool support → text response → result appended to manager's MessageLog

### Tools (`src/tools/`)
- **`registry.js`** — `ToolRegistry`, `ToolContext`, `toolDef()`, `toolResult()`, `parseToolArgs()`, `truncateOutput()`, `generateDiff()`, `validateCwdBoundary()`
- **`TOOL_DESCRIPTORS`** — static array of tool descriptors with `name` and `disabled` flags
- **`CORE_TOOL_NAMES`** — 15 core tool names: `bash`, `write`, `model`, `load_skill`, `read`, `question`, `pager`, `explore`, `find`, `grep`, `fetch`, `project_info`, `review`, `edit`
- **`SUBAGENT_TOOL_NAMES`** — 6 subagent tool names: `delegate_task`, `task_status`, `task_followup`, `task_interrupt`, `plan_status`, `complete_task`
- Individual tools: `bash.js`, `write.js`, `read.js`, `edit.js`, `grep.js`, `find.js`, `fetch.js`, `question.js`, `pager.js`, `model.js`, `load_skill.js`, `project_info.js`, `review.js`, `explore.js`, `subagents.js`
- **`createToolFactory(taskManager)`** — creates tool instances from config, supports `ToolContext`

### LSP Integration (`src/lsp/`)

JSON-RPC 2.0 over stdio client for language server communication. Provides 12 tools backed by external language servers.

- **`client.js`** — `LspClient` class: manages language server process lifecycle (spawn → initialize → shutdown), JSON-RPC 2.0 request/response with Content-Length header framing, notification handling, document sync (`didOpen`, `didChange`, `didClose`). Supports `requestTimeoutMs` (default 30s) and `serverStartupTimeoutMs` (default 60s).
- **`document-store.js`** — `DocumentStore` class: in-memory document state per URI (`content`, `languageId`, `version`). Auto-incrementing version counter. Methods: `put()`, `get()`, `delete()`, `has()`, `updateContent()`, `updateLanguageId()`, `clear()`.
- **`utils.js`** — URI/path conversion (`pathToUri`, `uriToPath`), file extension → language ID mapping (30+ extensions for ts/js/py/go/rs/etc.), UTF-16 ↔ UTF-8 offset conversion (LSP spec), token estimation, text truncation.
- **`config.js`** — Server configuration resolution. Default servers: TypeScript (`typescript-language-server --stdio`), Python (`pyright-langserver --stdio`), Go (`gopls serve`), Rust (`rust-analyzer`). Resolution: explicit `servers` config → default servers → `null`. Profile-level overrides via `profile.lsp.*`.
- **`tools/base.js`** — `LspBaseTool` base class with shared helpers: path resolution, client lifecycle (`_getClient()`), document open tracking (`_ensureDocumentOpen()`), result formatters (`_formatHover`, `_formatLocation`, `_formatCompletions`, `_formatSymbol`, `_formatDiagnostics`). Contains LSP constant enums: `CompletionKind`, `SymbolKind`, `DiagnosticSeverity`.
- **`tools/index.js`** — Re-exports all 12 LSP tool classes.

**12 LSP Tools** (registered via `src/tools/lsp-tools.js` and `src/tools/index.js`):
| Tool | LSP Method | Purpose |
|------|-----------|--------|
| `lsp-hover` | `textDocument/hover` | Type info, docs at position |
| `lsp-definition` | `textDocument/definition` | Find symbol definition location |
| `lsp-completion` | `textDocument/completion` | Auto-completion suggestions |
| `lsp-signature` | `textDocument/signatureHelp` | Function parameter hints |
| `lsp-document-symbol` | `textDocument/documentSymbol` | All symbols in a document |
| `lsp-references` | `textDocument/references` | All usages of a symbol |
| `lsp-code-action` | `textDocument/codeAction` | Quick fixes, refactoring options |
| `lsp-formatting` | `textDocument/formatting` | Format entire document |
| `lsp-rename` | `textDocument/rename` | Rename symbol across project |
| `lsp-diagnostics` | `publishDiagnostics` (push) | Errors, warnings, hints |
| `lsp-workspace-symbol` | `workspace/symbol` | Search symbols across workspace |
| `lsp-apply-edit` | `workspace/applyEdit` | Apply multi-file edits atomically |

**Client lifecycle**: Tools call `_getClient()` (base.js) or `getOrCreateClient()` (lsp-tools.js) to get a cached client per language ID.

### External Integrations
- **MCP** (`src/mcp/`) — stdio + HTTP transport, tool discovery, exposes MCP server tools as native agent tools. Files: `client.js`, `connection.js`, `tools.js`, `types.js`, `index.js`
- **Skills** (`src/skills/loader.js`) — loads `SKILL.md` files from directories following Agent Skills spec
- **Prompts** (`src/prompts/loader.js`) — named prompt template loading
- **Compaction** (`src/compaction.js`) — LLM-based message summarization with `estimateMessageTokens()`, `shouldCompact()`, `compactMessages()`, `findFirstKeptIndex()`
- **Session Log** (`src/session_log.js`) — JSONL format logging
- **Marker Mangler** (`src/marker_mangler.js`) — escapes input that triggers special behavior, protects against prompt injection

### `main.js` — Entry Point
Thin entry point: parse args → dispatch subcommand → build config → create session builder → create output sink → create session manager → create message bus → run one-shot or interactive session. All initialization logic is in `src/init/resolution.js`.
