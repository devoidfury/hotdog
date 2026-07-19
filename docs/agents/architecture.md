# Architecture

## Overview

`hotdog` is an AI agent harness with tool calling support. It connects to an LLM API, sends conversation messages, handles tool calls from the LLM, and executes tools. The architecture is built around a **minimal core** with **extension-based features** -- all features (tools, compaction, MCP, skills, prompts, subcommands) live as extensions that plug into the core via hooks.

## Architecture Philosophy

The core (`src/core/`) provides:
1. **Agent run loop** — dequeue → LLM call → tool exec → repeat
2. **Hook/event system** — where extensions plug in
3. **Extension loader** — discovery, loading, hot-reload
4. **Config resolution** — core defaults + extension config keys
5. **Session management** — create, swap, serialize, switch sessions
6. **Tool registry** — tool storage, lookup, serialization
7. **MessageBus** — owns the agent run loop, drains messages sequentially

Everything else is an extension. This keeps the core minimal, testable, and fully decoupled from feature implementations.

## Core Modules (`src/core/`)

### Entry Point (`src/core/main.ts`)
Thin orchestrator: create config registry -> discover extension metadata -> parse CLI args -> build config -> create core infrastructure -> load extensions -> dispatch subcommand. All initialization logic is in config modules and core modules.

### CLI (`src/core/cli.ts`)
Argument parsing with support for dynamic CLI flags registered by extensions via `ConfigRegistry`. Exports `parseArgs()` and `HELP_TEXT`. Supports core flags plus extension-provided flags.

### Config (`src/core/config/`)
Split into sub-modules. The single source of truth is `src/core/core.config.json`. Key exports:
- `src/core/config/index.ts` — re-exports all from sub-modules; plus `resolveConfigDir()`, `mergeExtensionConfigDefaults()`, `normalizeConfigKeys()`, `getDefaultConfig()`, `loadConfig()`, `validateConfig()`, `failOnInvalidConfig()`, `buildConfig()`, `buildAgentConfig()`
- `src/core/config/defaults.ts` — exports constants for the config resolution layer (`getDefaultConfig()`) and static path defaults; components receive resolved values from callers instead of importing these directly
- `src/core/config/schema-loader.ts` — reads `core.config.json`, builds `CONFIG_SCHEMA`, cast functions, CLI flags, and resolvers (`resolveKey()`, `resolveAll()`, `resolveModel()`, `resolveModelWithProvider()`, `resolveExtensionConfig()`, `cliFlagsFromSchema()`)
- `src/core/config/profiles.ts` — `loadProfileFile()`, `loadProfileFiles()`, `resolveProfile()`, `mergeProfile()`
- `src/core/config/providers.ts` — `buildModelRegistry()`, `resolveProvider()`, `initSystemPromptTemplate()`, `resetSystemPromptCache()`

### Config Registry (`src/core/extensions/config-registry.ts`)
Manages extension-registered CLI flags and config parameters. Config params and CLI flags are defined in `extension.json` (configSchema and cli:flags), with defaults automatically extracted and registered by the extension loader.

### Hook System (`src/core/hooks.ts`)
The foundation for the extension architecture. `HookSystem` class with `on()`, `off()`, `notifyHooks()`, `runHookPipeline()`, `clear()` methods. Standard hook names defined in `HOOKS` constant.

**Hook trace:** Set `_trace = true` on the HookSystem instance (via `--hook-trace` CLI flag, `HOTDOG_HOOK_TRACE=1` env, or `hook_trace: true` config) to log each handler invocation with execution order, source extension, timing, and return value. Output uses `logger.debug()` so it requires `HOTDOG_LOG_LEVEL=debug`. See `docs/agents/debugging-hotdog-tools-visibility-flags.md` for details.

**Session:** `SESSION_CREATE`, `SESSION_SWAP`, `SESSION_SERIALIZE`, `SESSION_DESERIALIZE`, `SESSION_RESTORE_ACTIVE`

**Tools:** `TOOLS_REGISTER`, `TOOL_BEFORE_EXECUTE`, `TOOL_AFTER_EXECUTE`, `AGENT_TOOL_CONTEXT`, `TOOL_CALL`, `TOOL_RESULT`

**Services:** `SERVICES_REGISTER` — fired synchronously during extension load; handler receives the ServiceRegistry

**Messages:** `CONTEXT`, `CONTEXT_MESSAGE`, `CONTEXT_REPLACED`, `MESSAGES_AFTER_LLM`

**System prompt:** `SYSTEM_PROMPT_BUILD`

**Commands:** `COMMAND_DISPATCH`, `COMMANDS_REGISTER`

**Output:** `OUTPUT_EVENT`

**Shutdown:** `SHUTDOWN_CLEANUP`

**CLI:** `CLI_SUBCOMMANDS_REGISTER`, `CLI_ARGS_PARSED`

**Model:** `MODEL_CHANGE`

**Input:** `INPUT`

**Provider:** `PROVIDER_REQUEST`, `PROVIDER_RESPONSE`

**Turn:** `TURN_START`, `TURN_END`

**Loop:** `LOOP_DETECTED`

**Tool metrics:** `TOOL_METRICS`

**Logging:** `LOG`

### Extension Loader (`src/core/extensions/extensions.ts`)
Discovers, loads, and manages extensions. Key exports:
- `HookSystem`, `HOOKS`, `EXTENSION_PROVIDES` — re-exported from hooks.ts
- `ExtensionLoader` class — manages extension lifecycle (load, unload, reload, get, all, has, size)
- `createExtensionLoader(core)` — factory function
- `discoverExtensions(extensionPaths)` — discovers extensions from configured paths
- `getExtensionsToLoad(extensionPaths, extensionAutoload, extensions)` — filters extensions based on config
- `resolveExtensionPath(spec)` — resolves "builtins" or path specs to absolute directories
- `LOAD_ORDER` — constants for extension load ordering (REFRESH: 0, CORE_TOOLS: 1, CLI: 2, DEFAULT: 10)
- `registerExtensionMetadata(config, configRegistry, cliSubcommandRegistry)` — reads extension.json metadata, auto-registers configSchema defaults
- `extractSchemaDefaults(schema)` — extracts defaults from JSON Schema as config params

### Agent (`src/core/agent.ts`)
Minimal Agent class that runs the LLM loop and delegates behavior to hooks. Key features:
- Constructor takes `options` object: `hooks`, `toolRegistry`, `llmClient`, `model`, `maxIterations`, `contextLimit`, `hideTools`, `hideThinking`, `showTokenUse`, `sink`, `modelRegistry`, `profileName`, `role`, `profileBody`, `stream`, `config`, `sessionId`, `abortSignal`, `toolWhitelist`, `commandRegistry`
- `run(userInput)` — main iteration loop: add user message → build messages → LLM call → process stream → execute tools → repeat
- `ensureSystemPrompt()` — builds system prompt via hooks (extensions contribute)
- `_processStream(stream)` — processes streaming LLM response (content, reasoning, tool calls, usage)
- `_executeTools(toolCalls)` — executes tool calls with hook-based enrichment
- `executeCommand(cmd)` — executes commands
- `cancel()` — cancels the running agent loop
- Properties: `model`, `log`, `isRestoring`, `iterationCount`, `sessionId`, `cancelled`, `hideTools`, `hideThinking`, `systemPrompt`, `llmClient`
- Task agent support: `_abortSignal`, `_toolWhitelist`, `_followQueue`, `_notifyCompletion()`

### Commands (`src/core/commands.ts`)
Command parsing — commands are the abstract concept, slash commands (/cmd) are one UI implementation. Key exports:
- `Command` enum: `Command.Help`, `Command.Quit`, `Command.Clear`, `Command.Tools`, `Command.Thinking`, `Command.Tokens`, `Command.Regenerate`, `Command.Reasoning`, `Command.Unknown`
- `parseCommand(cmd, registry)` — parses raw command string into typed command object

### Session Management (`src/core/session/index.ts`)
- `SessionStore` — holds agents keyed by session ID (addAgent, getAgent, removeAgent, agents, size)
- `SessionManager` — manages session lifecycle (create, swap, getAgent, switchSession, serialize, deserialize)
- `SessionManager.create(options)` — static factory that builds initial agent

### Registries (`src/core/extensions/registries.ts`)
Separate registries for agent commands and CLI subcommands. Key exports:
- `AgentCommandRegistry` — agent-level commands (e.g., /compact, /model). Supports `match()` for custom pattern matching and `isUiCommand` flag.
- `CliSubcommandRegistry` — CLI subcommands (e.g., `hotdog info`, `hotdog review`). Supports metadata merging (extension.json placeholder → handler attachment).
- `createCommandRegistry()` — factory for agent command registry
- `createSubcommandRegistry()` — factory for CLI subcommand registry
- Common methods: `register()`, `has()`, `names()`, `get()`, `all()`, `generateHelpText()`
- Agent-only: `match(cmd)` — pattern matching for custom commands

### Tool Registry (`src/core/extensions/tool-registry.ts`)
Tool registry and common utilities. Key exports:
- `ToolRegistry` — stores tools by name, provides lookup, serialization, and `getToolDefs()` accessor
- `createToolRegistry()` — factory function
- Methods: `register()`, `get()`, `has()`, `getAll()`, `getToolDefs()`, `getToolDef(name)`, `clearToolDefs()`, `remove(name)`, `removeAll(names)`, `clear()`, `filter()`, `validateToolArgs()`

### Tool Context (`src/core/extensions/tool-context.ts`)
Shared context container for tool execution. Backed by a Map. Extensions mount objects via `AGENT_TOOL_CONTEXT` hook so tools can access them during execution. Key exports:
- `ToolContext` class — `set(key, value)`, `get(key)`, `has(key)`, `delete(key)`, `keys()`, `mount(data)`, `toJSON()`

### Service Registry (`src/core/extensions/service-registry.ts`)
Maps abstract interface names to implementations. Extensions declare services via `extension.json` `services`/`requires` fields. Key exports:
- `ServiceRegistry` class — `register(name, implementation)`, `get(name)`, `has(name)`, `names()`, `checkContract(name, expectedMethods)`
- `createServiceRegistry()` — factory function
- Extensions register services via the `SERVICES_REGISTER` hook, which fires synchronously during `ExtensionLoader.load()` so services are available to downstream extensions.

### Tool Utilities (`src/core/extensions/tool-utils.ts`)
Tool definition helpers and utilities. Key exports:
- `ToolResult` — structured result with `output`, `error`, `metadata`, `success`, `outputTag`, `toDisplay()`, `toApiContent()`
- `toolDef(name, description, parameters)` — creates OpenAI function-calling schema
- `param(typeName, description, extra)` — creates parameter definition with JSON Schema fields
- `parseToolArgs(input)` — parses JSON tool arguments
- `toolResult(result, toolName)` — resolves tool result to string
- `truncateOutput(text, maxLines)` — truncates output
- `generateDiff(oldText, newText, maxLines)` — simple unified diff
- `parseToolInput(input)` — safer argument parsing returning null on failure
- `defaultCallDisplay(input, templateFn, options)` — default display formatter for tools
- `ToolContext` — context object for tool execution (defined in `src/core/extensions/tool-context.ts`)

### File Utilities (`src/utils/file-utils.ts`)
File I/O and path resolution helpers. Key exports:
- `writeFileWithParents(filePath, content)` — writes file with parent dirs
- `validateCwdBoundary(filePath, cwdBoundary)` — path safety check
- `resolvePath(filePath, cwdBoundary, workspaceRoot)` — path resolution with safety
- `resolvePathAndValidate(requested, cwdBoundary)` — resolves and validates a path
- `parseFrontMatter(content)` — extracts YAML front matter from markdown
- `loadAspects(aspectNames, aspectsDir)` — loads aspect files from a directory
- `validateNameable(name, label, dirName)` — validates nameable entity names

### Logger (`src/core/logger.ts`)
Centralized, swappable logging via the hook system. Singleton pattern with pre-init buffering. Key exports:
- `logger` — singleton with `debug()`, `info()`, `warn()`, `error()` methods
- `initializeLogger({ hooks, minLevel, target })` — bootstrap initialization
- `resolveLogLevel(configLevel)` — resolves level from `HOTDOG_LOG_LEVEL` env or config
- `resolveLogTarget(configTarget)` — resolves target from `HOTDOG_LOG_TARGET` env or config (`stderr`, `stdout`, `none`)
- `LOG_LEVELS` — `{ debug: 0, info: 1, warn: 2, error: 3 }`

### Template Engine (`src/utils/render.ts`)
Tera-like template engine supporting `{{ vars }}`, `{% if %}`, `{% for %}`, filters (`|trim`, `|length`, `|default`), and block tags. Key exports:
- `render(template, context, cache)` — renders template string with context
- `compile(template)` — compiles template into render function

### System Prompt (`src/core/context/system-prompt.ts`)
System prompt building. Key exports:
- `buildSystemPrompt(role, body, model, profileName, chunks, templatePath?)` — builds full system prompt from chunks contributed by extensions via `SYSTEM_PROMPT_BUILD` hook
- `loadSystemPromptTemplate(templatePath)` — loads the system prompt template from disk
- `collectSystemPromptChunks(results)` — collects and sorts system prompt chunks from hook results
- `SystemPromptBuilder` class — manages system prompt lifecycle with caching (`build()`, `ensureBuilt()`, `getPrompt()`, `clear()`)
- `createSystemPromptBuilder(templatePath?)` — factory for SystemPromptBuilder

**Note**: `loadAspects()` lives in `src/utils/file-utils.ts` and `loadAgentsMd()` lives in `src/extensions/agents-md/index.ts` — neither is in this file.

### Command Handlers (`src/core/command-handlers.ts`)
Built-in command handler implementations for core commands. Extracted from `agent.ts` so the agent only does generic dispatch. Key exports:
- `CORE_COMMAND_HANDLERS` — Map of Command enum values to handler functions: `handleClear`, `handleQuit`, `handleHelp`, `handleTokens`, `handleTools`, `handleThinking`, `handleRegenerate`, `handleReasoning`
- Each handler is `(agent, value, cmd) => { content?, error? }`

### Error Handling (`src/core/error.ts`)
Centralized error formatting. Key exports:
- `EXPECTED_ERROR_TYPES` — Set of expected error types (cancelled, http, api, timeout, invalid_response, cli, tool, config)
- `isExpectedError(err)` — checks if error is expected vs unexpected
- `formatError(err)` — formats error (expected: message only; unexpected: message + stack)
- `withContext(label, fn)` — wraps operation with context and centralized error handling

### Output Events (`src/core/context/output.ts`)
Output event types and OutputSink base class. Key exports:
- `OUTPUT_EVENT` — enum with 14 event types (USER_MESSAGE, ASSISTANT_MESSAGE, THINKING, TOOL_CALL, TOOL_RESULT, COMPACTING, COMMAND_RESULT, QUESTION, STREAMING_CHUNK, STREAMING_REASONING_CHUNK, TASK_PROGRESS, TOKEN_USAGE, COMPACTION_RESULT, SESSION_STATE)
- `EVENT_HANDLERS` — maps event types to handler method names on OutputSink
- `OutputSink` — base class with `emit()` plus convenience methods
- `NoopSink` — no-op implementation for testing

### Messages (`src/core/context/message.ts`)
Message types and message log. Key exports:
- `Message` — conversation message with `role`, `content`, `reasoningContent`, `toolCalls`, `toolCallId`, `images` (optional array of `{ type, mimeType, data }`)
- Accepts both camelCase (API/JS) and snake_case (JSON/log files) field names

### Input (`src/core/context/input.ts`)
Input parsing. Key exports:
- `INPUT_EVENT` — enum with `TEXT` and `COMMAND` types
- `parseInput(input)` — parses raw text into typed input event
- `NoopInput` — no-op input implementation

### LLM Client (`src/core/llm-client/`)
- `client.ts` — `LlmClient` with streaming, cancellation, retry support
- `retry.ts` — `retryWithBackoff(fn, maxRetries, options)` with cancellation support
- `LlmError` class (with `Http`, `Api`, `Timeout`, `Cancelled`, `InvalidResponse` static constructors) is defined in `src/core/error.ts`

### Session (`src/core/session/`)
- `session-log.ts` — Session log reading/replaying (JSONL format). Key exports: `readSessionEntries()`, `readAllSessions()`, `sessionExists()`, `replayEntriesIntoContext()`, `LOG_SOURCE` constants
- `task-manager.ts` — `TaskManager` manages background task agents. Key exports: `TASK_STATUS` (RUNNING, COMPLETED, FAILED, CANCELLED), `TaskHandle` (status, interrupt), `TaskManager` (spawnTask, taskStatus, sendFollowUp, interruptTask, activeTasks, taskCounts, progressMessage)
- `agent-sink.ts` — `AgentSink` bridges Agent output to Session Core. Two modes: normal (all events forwarded) and task (filtered — only TASK_PROGRESS and TOKEN_USAGE pass through)
- `message-bus.ts` — `MessageBus` owns the agent run loop. Drains messages sequentially through `agent.run()`. Provides input preprocessing via `INPUT` hook. Key exports: `MessageBus` (enqueue, cancel, isIdle, run, runUntilCancelled, executeCommand)

### Marker Mangler (`src/core/marker-mangler.ts`)
Escapes input that triggers special behavior (tool call actions, internal markers). Protects against prompt injection via crafted input. Key exports: `MarkerMangler` class with `escape()`, `unescape()`, `escapeInput()`, `escapeToolOutput()`, `unescapeOutput()`, `unescapeToolInput()`, `createMarkerMangler()`.

### Utilities (`src/utils/`)
- `file-utils.ts` — `parseFrontMatter(content)`, `validateNameable(name, label, dirName)`
- `objects.ts` — `deepMerge(...sources)`
- `render.ts` — Template engine with `{{ vars }}`, `{% if %}`, `{% for %}`, filters
- `json-schema.js` — `validate()`, `validateParams()`, `formatValidationErrors()`

### CLI Utilities (`src/utils/cli/`)
- `cli.ts` — `CliOutputSink` class: formatting + color emission, extends `OutputSink`. Key exports: `formatCompacting()`, `formatToolCall()`, `formatToolResult()`, `formatTokenUsage()`, `formatThinking()`, `formatTaskProgress()`, `CliOutputSink`
- `colors.ts` — Color palettes, ANSI helpers, theme resolution. Key exports: `ColorPalette`, `resolvePalette()`, `applyThinking()`, `applyToolCall()`, `applyToolResult()`, `applyFinalResponse()`, `applyCompacting()`, `applyProgress()`

### Core Index (`src/core/index.ts`)
Re-exports core modules for programmatic use: hooks, logger, extension utilities (ExtensionLoader, createExtensionLoader, extractSchemaDefaults, registerExtensionMetadata), tool-registry, tool-utils, registries, config-registry, service-registry, agent, session, agent-sink, task-manager, message-bus.

## Extensions (`src/extensions/`)

All features live as extensions that plug into the core via hooks. Extensions are auto-discovered from configured paths.

### Extension Anatomy
Each extension has:
- `index.ts` — entry point with `create(core, options)` function
- `extension.json` — metadata file with `provides` array (e.g., `["cli:subcommands"]`)

### Extension Loading
1. **Static metadata discovery** — `registerExtensionMetadata()` reads `extension.json` files without loading any extension code. This enables `--help`, subcommand discovery, and config defaults to work immediately.
2. **CLI arg parsing** — `parseArgs()` uses the registered CLI flags and subcommand names.
3. **Config resolution** — `buildConfig()` resolves all config values.
4. **Extension loading** — `loadExtensions()` loads all extensions in dependency order. Extensions register tools via `HOOKS.TOOLS_REGISTER`, CLI subcommands via `HOOKS.CLI_SUBCOMMANDS_REGISTER`, and contribute to the system prompt via `HOOKS.SYSTEM_PROMPT_BUILD`.

### Built-in Extensions

| Extension | Purpose |
|-----------|---------|
| `core-tools` | Core tools: write, read, edit, grep, find, pager, explore (disabled), project_info |
| `bash-tool` | Bash tool -- execute shell commands |
| `fetch-tool` | Fetch tool -- make HTTP requests |
| `question-tool` | Question tool -- ask interactive questions |
| `model-switch` | Model switching tool + `/model` slash commands |
| `compaction` | Compaction strategies: summarize, summarize-short, drop, token-aware, trim |
| `mcp-client` | MCP server connections (HTTP + stdio) |
| `skills` | Skills discovery and loading |
| `prompts` | Prompt template loading |
| `session-log` | JSONL session logging |
| `ui-session-review-cli` | Review CLI subcommand + review tool |
| `ui-info-cli` | Info, show-prompt, and profiles CLI subcommands |
| `ui-one-shot` | One-shot prompt mode (`-p`/`--prompt` flag, `prompt` subcommand) |
| `ui-interactive-cli` | Interactive CLI session with readline loop |
| `subagents` | Subagent tools for task delegation (manager-only) |
| `agents-md` | Loads AGENTS.md and contributes Project Context section |
| `aspects` | Loads aspect files and contributes Guidelines section |
| `environment` | Contributes Environment section to system prompt |
| `web-search` | Web search tool — search the web for information |
| `websocket` | WebSocket server for agent session management — core backend utility for UI extensions |
| `webui` | Web UI for agent interaction — login, chat, session management |

### Extension Load Order
Extensions are loaded in order: REFRESH (0) → CORE_TOOLS (1) → CLI (2) → DEFAULT (10). CLI extensions are loaded early so their subcommand handlers are registered before dispatch. Core tools load before other extensions that depend on them.

## Data Flow

### Normal Agent Run
```
User input → MessageBus.enqueue() → Agent.run()
  → build messages (hooks: CONTEXT)
  → LLM call (streaming)
  → process stream (content, reasoning, tool calls, usage)
  → emit events to sink
  → execute tool calls (hooks: TOOL_BEFORE_EXECUTE, TOOL_AFTER_EXECUTE, TOOL_CALL, TOOL_RESULT)
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
User runs: bun bin/hotdog info
  → parseArgs() detects subcommand
  → CliSubcommandRegistry.get("info") → handler
  → Load config
  → Load all extensions (full hook chain)
  → Execute handler(cli, core)
```
