# Architecture

## Overview

`oa-agent` is an AI agent harness with tool calling support. It connects to an LLM API, sends conversation messages, handles tool calls from the LLM, and executes tools. The architecture is built around a **minimal core** with **extension-based features** — all features (tools, compaction, MCP, skills, prompts, LSP, subcommands) live as extensions that plug into the core via hooks.

## Architecture Philosophy

The core provides:
1. **Session lifecycle** — create, swap, serialize, switch sessions
2. **Agent run loop** — dequeue → LLM call → tool exec → repeat
3. **Hook/event system** — where extensions plug in
4. **Extension loader** — discovery, loading, hot-reload
5. **Config resolution** — core defaults + extension config keys

Everything else is an extension. This keeps the core minimal, testable, and fully decoupled from feature implementations.

## Core Modules (`src/`)

### Entry Point (`src/main.js`)
Thin orchestrator: parse args → dispatch subcommand → build config → create core infrastructure → load extensions → create session manager → run one-shot or interactive session. All initialization logic is in config.js and core modules.

### CLI (`src/cli.js`)
Argument parsing with support for dynamic CLI flags registered by extensions via `ConfigRegistry`. Exports `parseArgs()` and `HELP_TEXT`. Supports core flags plus extension-provided flags.

### Config (`src/config.js`)
All defaults, provider config loading, profiles, and model registry. Key exports:
- `DEFAULT_*` constants — all defaults live here
- `loadConfig(configPath, extParams)` — loads config from file with extension param merging
- `buildConfig(cli)` — single entry point for config resolution, returns `{ resolved, modelRegistry, providers }`
- `loadProfileFile(config, profileName)` — loads `.profile.md` files
- `getProfile(config, profileName)` — resolves profile from config and profile files
- `buildModelRegistry(config)` — builds model lookup map from provider configs
- `initSystemPromptTemplate(templatePath)` — loads/reuses system prompt template
- `mergeExtensionConfigDefaults(defaultConfig, extParams)` — merges extension defaults into base config

### Config Registry (`src/config-registry.js`)
Allows extensions to register their own CLI flags and config parameters dynamically. Used during CLI parsing and config resolution. Extensions register via `CONFIG_CLI_FLAGS_REGISTER` and `CONFIG_PARAMS_REGISTER` hooks.

### Hook System (`src/hooks.js`)
The foundation for the extension architecture. `HookSystem` class with `on()`, `emit()`, `emitAsync()`, `emitAsyncSeq()`, `off()`, `clear()` methods. Standard hook names defined in `HOOKS` constant:
- Session: `SESSION_CREATE`, `SESSION_SWAP`, `SESSION_SERIALIZE`, `SESSION_DESERIALIZE`, `SESSION_RESTORE_ACTIVE`
- Tools: `TOOLS_REGISTER`, `TOOL_BEFORE_EXECUTE`, `TOOL_AFTER_EXECUTE`, `AGENT_TOOL_CONTEXT`
- Messages: `CONTEXT`, `MESSAGES_AFTER_LLM`, `CONTEXT_MESSAGE`, `CONTEXT_FULL`
- System prompt: `SYSTEM_PROMPT_BUILD`
- Commands: `COMMAND_DISPATCH`, `SLASH_COMMANDS_REGISTER`
- Output: `OUTPUT_EVENT`
- Shutdown: `SHUTDOWN_CLEANUP`
- CLI: `CLI_SUBCOMMANDS_REGISTER`
- Config: `CONFIG_CLI_FLAGS_REGISTER`, `CONFIG_PARAMS_REGISTER`
- Compaction: `COMPACT_STRATEGY_LIST`, `COMPACT_STRATEGY_SET`
- Model: `MODEL_CHANGE`

### Extension Loader (`src/core/extensions.js`)
Discovers, loads, and manages extensions. Key exports:
- `HookSystem`, `HOOKS`, `EXTENSION_PROVIDES` — re-exported from hooks.js
- `ExtensionLoader` class — manages extension lifecycle (load, unload, reload, get, all, has, size)
- `createExtensionLoader(core)` — factory function
- `discoverExtensions(extensionPaths)` — discovers extensions from configured paths
- `getExtensionsToLoad(extensionPaths, extensionAutoload, extensions)` — filters extensions based on config
- `resolveExtensionPath(spec)` — resolves "builtins" or path specs to absolute directories
- `LOAD_ORDER` — constants for extension load ordering (REFRESH: 0, CORE_TOOLS: 1, CLI: 2, DEFAULT: 10)
- `emitConfigRegistration(extension, configRegistry)` — emits config registration hooks

### Agent (`src/core/agent.js`)
Minimal Agent class that runs the LLM loop and delegates behavior to hooks. Key features:
- Constructor takes: `hooks`, `toolRegistry`, `llmClient`, `model`, `maxIterations`, `maxTokens`, `hideTools`, `hideThinking`, `showTokenUse`, `sink`, `modelRegistry`, `profileName`, `role`, `profileBody`, `stream`, `config`, `sessionId`, `abortSignal`, `toolWhitelist`
- `run(userInput)` — main iteration loop: add user message → build messages → LLM call → process stream → execute tools → repeat
- `ensureSystemPrompt()` — builds system prompt via hooks (extensions contribute)
- `_processStream(stream)` — processes streaming LLM response (content, reasoning, tool calls, usage)
- `_executeTools(toolCalls)` — executes tool calls with hook-based enrichment
- `executeCommand(cmd)` — executes slash commands
- `cancel()` — cancels the running agent loop
- Properties: `model`, `context`, `iterationCount`, `sessionId`, `cancelled`, `hideTools`, `hideThinking`, `systemPrompt`
- Task agent support: `_abortSignal`, `_toolWhitelist`, `_followQueue`, `_notifyCompletion()`

### Commands (`src/core/commands.js`)
Slash command parsing and dispatch. Key exports:
- `Command` enum: `Help`, `Quit`, `Clear`, `ClearProfile`, `Tools`, `Thinking`, `Models`, `Model`, `Tokens`, `Regenerate`, `Unknown`
- `parseCommand(cmd, registry)` — parses raw command string into typed command object
- `isUiCommand(type)` — checks if command is handled by UI layer

### Session Management (`src/core/session.js`)
- `SessionStore` — holds agents keyed by session ID (addAgent, getAgent, removeAgent, agents, size)
- `SessionManager` — manages session lifecycle (create, swap, getAgent, switchSession, serialize, deserialize)
- `SessionManager.create(options)` — static factory that builds initial agent

### Slash Command Registry (`src/core/slash-command-registry.js`)
Allows extensions to register slash commands without being explicitly wired up. `SlashCommandRegistry` class with `register()`, `has()`, `names()`, `get()`, `all()`, `match()`, `generateHelpText()`.

### Subcommand Registry (`src/core/subcommand-registry.js`)
Allows extensions to register CLI subcommands. `CliSubcommandRegistry` class with `register()`, `has()`, `names()`, `get()`, `all()`, `generateHelpText()`. Subcommand definitions include: `handler`, `description`, `requiresConfig`, `requiresCore`.

### Tool Registry (`src/core/tool-registry.js`)
Tool registry and common utilities. Key exports:
- `ToolResult` — structured result with `output`, `error`, `metadata`, `success`, `outputTag`, `toDisplay()`, `toApiContent()`
- `toolDef(name, description, parameters)` — creates OpenAI function-calling schema
- `param(typeName, description, extra)` — creates parameter definition with JSON Schema fields
- `parseToolArgs(input)` — parses JSON tool arguments
- `toolResult(result, toolName)` — resolves tool result to string (XML for API, plain text for display)
- `truncateOutput(text, maxLines)` — truncates output
- `generateDiff(oldText, newText, maxLines)` — simple unified diff
- `writeFileWithParents(filePath, content)` — writes file with parent dirs
- `validateCwdBoundary(filePath, cwdBoundary)` — path safety check
- `resolvePath(filePath, cwdBoundary, workspaceRoot)` — path resolution with safety
- `parseToolInput(input)` — safer argument parsing returning null on failure
- `defaultCallDisplay(input, templateFn, options)` — default display formatter for tools
- `ToolContext` — context object for tool execution (set/get for agent, isSessionRestoring, cwdBoundary, workspaceRoot)

### Template Engine (`src/context/render.js`)
Tera-like template engine supporting `{{ vars }}`, `{% if %}`, `{% for %}`, filters (`|trim`, `|length`, `|exec`, `|default`), and block tags. Key exports:
- `render(template, context, cache)` — renders template string with context
- `renderTemplate` — alias for render
- `compile(template)` — compiles template into render function

### System Prompt (`src/context/system_prompt.js`)
System prompt building. Key exports:
- `loadAspects(aspectNames)` — loads `.aspect.md` files from `config/aspects/`
- `loadAgentsMd()` — loads `AGENTS.md` from CWD
- `loadSystemPromptTemplate(templatePath)` — loads/reuses system prompt template
- `buildSystemPrompt(options)` — builds full system prompt with role, body, model, aspects, agentsMd, skillsContent

### Error Handling (`src/context/error.js`)
Centralized error formatting. Key exports:
- `EXPECTED_ERROR_TYPES` — Set of expected error types (cancelled, http, api, timeout, invalid_response)
- `isExpectedError(err)` — checks if error is expected vs unexpected
- `formatError(err)` — formats error (expected: message only; unexpected: message + stack)
- `withContext(label, fn)` — wraps operation with context and centralized error handling

### Output Events (`src/context/output.js`)
Output event types and OutputSink base class. Key exports:
- `OUTPUT_EVENT` — enum with 14 event types (USER_MESSAGE, ASSISTANT_MESSAGE, THINKING, TOOL_CALL, TOOL_RESULT, COMPACTING, COMMAND_RESULT, QUESTION, STREAMING_CHUNK, STREAMING_REASONING_CHUNK, TASK_PROGRESS, TOKEN_USAGE, COMPACTION_RESULT, SESSION_STATE)
- `EVENT_HANDLERS` — maps event types to handler method names on OutputSink
- `OutputSink` — base class with `emit()` plus convenience methods
- `NoopSink` — no-op implementation for testing and show-prompt

### Messages (`src/context/message.js`)
Message types and message log. Key exports:
- `Message` — conversation message with `role`, `content`, `reasoningContent`, `toolCalls`, `toolCallId`
- `SystemMessage` — special message with role="system"
- `MessageLog` — message buffer with `addMessage()`, `addUserMessage()`, `addAssistantMessage()`, `addSystemMessage()`, `insertAt()`, `replaceMessages()`, `messages()`, `getMessages()`, `getMessagesAsJSON()`, `size()`, `clear()`

### Input (`src/context/input.js`)
Input parsing. Key exports:
- `INPUT_EVENT` — enum with `TEXT` and `COMMAND` types
- `parseInput(input)` — parses raw text into typed input event
- `NoopInput` — no-op input implementation

### LLM Client (`src/llm_client/`)
- `client.js` — LLM HTTP client with streaming, cancellation, retry support
- `retry.js` — `retryWithBackoff(fn, maxRetries, options)` with cancellation support

### Session (`src/session/`)
- `session-log.js` — Session log reading/replaying (JSONL format). Key exports: `readSessionEntries()`, `readAllSessions()`, `sessionExists()`, `replayEntriesIntoContext()`, `LOG_SOURCE` constants
- `task_manager.js` — `TaskManager` manages background task agents. Key exports: `TASK_STATUS` (RUNNING, COMPLETED, FAILED, CANCELLED), `TaskHandle` (status, interrupt), `TaskManager` (spawnTask, taskStatus, sendFollowUp, interruptTask, activeTasks, taskCounts, progressMessage)
- `agent_sink.js` — `AgentSink` bridges Agent output to Session Core. Two modes: normal (all events forwarded) and task (filtered, only TASK_PROGRESS passes through). Key exports: `AgentSink` (emit, setTaskAgentId, onTaskComplete, isTaskAgent)

### Marker Mangler (`src/marker_mangler.js`)
Escapes input that triggers special behavior (tool call actions, internal markers). Protects against prompt injection via crafted input. Key exports: `MarkerMangler` class with `escape()`, `unescape()`, `escapeInput()`, `escapeToolOutput()`, `unescapeOutput()`, `unescapeToolInput()`, `createMarkerMangler()`.

### Utilities (`src/utils.js`)
- `parseFrontMatter(content)` — parses YAML front matter from markdown
- `deepMerge(...sources)` — recursive object merge
- `validateNameable(name, label, dirName)` — validates name constraints

### UI Layer (`src/ui/`)
- `cli.js` — `CliOutputSink` class: formatting + color emission, implements `OutputSink`. Key exports: `formatCompacting()`, `formatToolCall()`, `formatToolResult()`, `formatTokenUsage()`, `formatThinking()`, `formatTaskProgress()`, `CliOutputSink`
- `colors.js` — Color palettes, ANSI helpers, theme resolution. Key exports: `ColorPalette`, `resolvePalette()`, `applyThinking()`, `applyToolCall()`, `applyToolResult()`, `applyFinalResponse()`, `applyCompacting()`, `applyProgress()`
- `session.js` — `runInteractiveSession()`: thin readline loop, slash command dispatch, SIGINT handling, shell commands
- `index.js` — Re-exports all UI modules

### Library Entry (`src/lib.js`)
Re-exports core modules for programmatic use: config, context, llm_client, core/agent, ui/cli, utils.

## Extensions (`src/extensions/`)

All features live as extensions that plug into the core via hooks. Extensions are auto-discovered from configured paths.

### Extension Anatomy
Each extension has:
- `index.js` — entry point with `create(core, options)` function
- `extension.json` — metadata file with `provides` array (e.g., `["cli:subcommands"]`)

### Extension Loading
1. Extensions are discovered via `discoverExtensions()` which walks configured paths
2. CLI extensions (provides: `["cli:subcommands"]`) are loaded early for subcommand registration
3. All other extensions are loaded after config resolution
4. Extensions register tools via `HOOKS.TOOLS_REGISTER`
5. Extensions register CLI subcommands via `HOOKS.CLI_SUBCOMMANDS_REGISTER`
6. Extensions register config params/flags via `HOOKS.CONFIG_PARAMS_REGISTER` / `HOOKS.CONFIG_CLI_FLAGS_REGISTER`
7. Extensions contribute to system prompt via `HOOKS.SYSTEM_PROMPT_BUILD`

### Built-in Extensions

| Extension | Purpose |
|-----------|---------|
| `core-tools` | Core tools: bash, write, read, edit, grep, find, fetch, question, pager, model, project_info, review, explore |
| `compaction` | Compaction strategies: summarize, summarize-short, drop, token-aware |
| `lsp` | LSP tools: hover, definition, completion, signature, document-symbol, references, code-action, formatting, rename, diagnostics, workspace-symbol, apply-edit |
| `mcp-client` | MCP server connections (HTTP + stdio) |
| `skills` | Skills discovery and loading |
| `prompts` | Prompt template loading |
| `session-log` | JSONL session logging |
| `session-review` | Review CLI subcommand |
| `info-show-prompt` | Info + show-prompt CLI subcommands |
| `refresh` | Hot-reload extension + refresh tool |
| `run-shell-command` | Shell command tool |

### Extension Load Order
Extensions are loaded in order: REFRESH (0) → CORE_TOOLS (1) → CLI (2) → DEFAULT (10). This ensures CLI extensions register subcommands before config is loaded, and core tools are available before other extensions that depend on them.

## Data Flow

### Normal Agent Run
```
User input → MessageBus.enqueue() → Agent.run()
  → build messages (hooks: CONTEXT)
  → LLM call (streaming)
  → process stream (content, reasoning, tool calls, usage)
  → emit events to sink
  → execute tool calls (hooks: TOOL_BEFORE_EXECUTE, TOOL_AFTER_EXECUTE)
  → repeat or return result
```

### Task Delegation
```
Parent agent calls delegate_task()
  → TaskManager.spawnTask(taskId, description, options)
  → Load task profile
  → Create Agent instance with:
    - sink = AgentSink (isTaskAgent: true, filters streaming/tool events)
    - toolWhitelist from profile
    - hideTools/hideThinking: true
  → Run agent.run(description) in background
  → On completion: append result to manager's context + wake up via bus
```

### Subcommand Dispatch
```
User runs: bun src/main.js info
  → parseArgs() detects subcommand
  → CliSubcommandRegistry.get("info") → handler
  → Load config (if requiresConfig: true)
  → Load all non-CLI extensions (for full hook chain)
  → Execute handler(cli, core)
```
