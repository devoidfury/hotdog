# Hook Lifecycle

The hook system is the primary extension mechanism in hotdog. It decouples the core from all features — tools, compaction, MCP, skills, prompts, logging, and CLI subcommands — via a simple pub-sub pipeline. Extensions register handlers; the core emits events at every stage of the agent lifecycle.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                    Core                      │
│  ┌───────────┐    ┌──────────────┐          │
│  │  Agent     │───▶│  HookSystem  │          │
│  │  (run      │    │              │          │
│   │   loop)    │    │  .notifyHooks()       │
│   │           │    │  .runHookPipeline()     │
│  └───────────┘    └──────┬───────┘          │
│                           │                  │
│                    Handlers (Extensions)     │
│  ┌────────────┐ ┌──────────┐ ┌────────────┐ │
│  │  Compaction│ │ Skills   │ │  MCP Client │ │
│  │  Extension │ │ Extension│ │  Extension  │ │
│  └────────────┘ └──────────┘ └────────────┘ │
└─────────────────────────────────────────────┘
```

### HookSystem Methods

| Method | Pattern | Use Case |
|--------|---------|----------|
| `notifyHooks(name, data)` | Awaitable notify — handlers start immediately in registration order (async ones run in parallel); returns a promise that settles once every handler has settled | Notifications, logging, tracing, side effects |
| `runHookPipeline(name, data, opts)` | Sequential, adopts returns into the payload | Modifications that chain (e.g., context, tool call gate) |

**Key distinction:**
- **Notify (awaitable)** — handlers start immediately and their return values are discarded. The returned promise settles once every handler has completed, so core call sites `await` it whenever later code depends on the handlers' effects (e.g. the tool executor awaits `AGENT_TOOL_CONTEXT` so context mounts are complete before the `TOOL_CALL` gate). Unawaited call sites keep plain fire-and-forget behavior.
- **Pipeline** — handlers run one at a time. Whatever a handler returns is a patch: its fields are written onto the payload (see §Pipeline — Transformation), so each later handler sees the accumulated state and core reads the final payload back. `shouldStop` may end the chain early.

### Pipeline Options

```js
{
  shouldStop: (result) => result?.action === "handled" // early termination predicate
}
```

When `shouldStop` returns true, the pipeline stops and no more handlers run. The `stopped` field in the result indicates whether early termination occurred.

---

## Lifecycle Phases

The agent lifecycle has four broad phases, each with multiple hook points:

### 1. Bootstrap & Configuration

```
CLI Start
    │
    ▼
Create Hooks ──────────────► Logger initializes via "log" hook
    │
    ▼
Load Config ───────────────► ConfigRegistry.registerCliFlags() (extension CLI flags)
                              ConfigRegistry.registerConfigParams() (extension config params)
    │
    ▼
Discover Extensions ───────► Reads extension.json metadata (no code loaded yet)
    │
    ▼
Parse CLI Args ────────────► "cli:argsParsed" (after args parsed, before dispatch)
    │
    ▼
Create Core ───────────────► Hooks, ToolRegistry, ExtensionLoader created
    │
    ▼
Load Extensions ───────────► "cli:subcommandsRegister" (subcommand handlers)
                              "tools:register" (tool registration)
                              "commands:register" (slash commands)
    │
    ▼
Dispatch Subcommand ───────► Or start interactive session
```

**Hooks fired during bootstrap:**

| Hook | When | Mechanism | Payload |
|------|------|-----------|---------|
| `cli:argsParsed` | After CLI args parsed | awaited notify | `{ cli }` |
| `cli:subcommandsRegister` | After extensions loaded | awaited notify | `cliSubcommandRegistry` |

### 2. Session Lifecycle

```
Session Create ────────────► "session:create"
    │
    ▼
Agent Run Loop ────────────► See Phase 3
    │
    ▼
Session Swap ──────────────► "session:swap"
Session Restore ────────────► "session:restoreActive"
```

| Hook | When | Mechanism | Payload |
|------|------|-----------|---------|
| `session:create` | New agent created | awaited notify | `{ session, config }` |
| `session:swap` | Agent swapped | awaited notify (sync `switchSession()` fires unawaited) | `{ oldAgent, newAgent }` |
| `session:restoreActive` | Restore flag changes | notify (fire-and-forget) | `{ agent, isRestoring }` |

### 3. Agent Run Loop — Per-Iteration Lifecycle

This is the heart of the system — one iteration of the LLM-tools loop.

```
┌─────────────────────────────────────────────────────────┐
│                  AGENT RUN LOOP (one iteration)         │
│                                                          │
│  1. TURN_START ───────────────► awaited notify           │
│      (per-turn metrics, analytics)                       │
│                                                          │
│  2. INPUT ────────────────────► sequential pipeline      │
│      (preprocess user input, can short-circuit)          │
│      Actions: { action: "continue" }                     │
│               { action: "transform", content }           │
│               { action: "handled" }                      │
│      Stops on "handled"                                  │
│                                                          │
│  3. BUILD SYSTEM PROMPT ─────► "systemPrompt:build"      │
│      Extensions return chunks: { name, priority, content }│
│      Chunks sorted by priority and rendered into template │
│                                                          │
│  4. BUILD MESSAGES ──────────► System prompt + context   │
│                                                          │
│  5. CONTEXT ─────────────────► sequential pipeline       │
│      Handlers receive { messages, agent }                │
│      Return { messages } to replace the array            │
│      Each handler sees prior transformations             │
│      (compaction checks token budget here)               │
│                                                          │
│  6. PROVIDER_REQUEST ────────► sequential pipeline       │
│      Handlers receive { messages, modelConfig, toolDefs } │
│      Can modify messages, modelConfig, or toolDefs       │
│      (request logging, last-minute injection)            │
│                                                          │
│  7. LLM CALL ───────────────► HTTP request to provider   │
│      (streaming, tool calls)                              │
│                                                          │
│  8. PROVIDER_RESPONSE ───────► pipeline                  │
│      (response logging, metrics, cost tracking, repair)  │
│                                                          │
│  9. MESSAGES_AFTER_LLM ─────► awaited notify            │
│      (post-LLM analysis)                                 │
│                                                          │
│ 10. TOOL EXECUTION ──────────► See tool pipeline below   │
│                                                          │
│ 11. TURN_END ───────────────► awaited notify             │
│      (per-turn analysis, audit, UI prompt control)       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

#### Tool Execution Pipeline

Each tool call goes through a dedicated sub-pipeline:

```
  LLM returns tool_calls
       │
       ▼
  TOOL_BEFORE_EXECUTE ───────► awaited notify
       │
       ▼
  AGENT_TOOL_CONTEXT ─────────► awaited notify (build toolCtx, enrich it)
       │                       Awaited: mounts (even from async handlers)
       │                       are complete BEFORE the gate, so a gate
       │                       handler can reach the human through
       │                       toolCtx.get("input")
       ▼
  TOOL_CALL (gate) ──────────► sequential pipeline (payload carries toolCtx)
       │                       Actions:
       │                         { action: "continue" }
       │                         { action: "modify", input }
       │                         { action: "block", result }
       │                       Stops on "block" or "continue" with no modify
       │
       ▼
  Validate args ─────────────► JSON Schema validation
       │
       ▼
  Execute tool ──────────────► tool.execute(input, toolCtx)
       │
       ▼
  TOOL_AFTER_EXECUTE ────────► awaited notify
       │
       ▼
  TOOL_RESULT ───────────────► sequential pipeline
       │                       Handlers return { result } to replace
       │                       (redaction, truncation, reformatting)
       │
       ▼
  Format & write ────────────► XML-wrapped result → context
       │
       ▼
  CONTEXT_MESSAGE ───────────► notify (fire-and-forget; session log, etc.)
```

### 4. Shutdown

```
  SHUTDOWN_CLEANUP ──────────► awaited notify
       │                       (close MCP connections, flush logs, etc. —
       │                        cleanup() resolves once they all settle)
```

---

## Complete Hook Reference

### Session Lifecycle

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `SESSION_CREATE` | `session:create` | awaited notify | New agent created via SessionManager |
| `SESSION_SWAP` | `session:swap` | awaited notify | Agent swapped (`swap()` awaits it; the sync `switchSession()` path fires it unawaited) |
| `SESSION_RESTORE_ACTIVE` | `session:restoreActive` | notify (fire-and-forget) | Restore flag changes on agent (sync setter) |

### Message Flow

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `CONTEXT_MESSAGE` | `context:message` | notify (fire-and-forget) | A message added to agent context (sync call site) |
| `CONTEXT_REPLACED` | `context:replaced` | notify (fire-and-forget) | Entire context replaced (compaction, reset) |
| `MESSAGES_AFTER_LLM` | `messages:afterLLM` | awaited notify | After LLM response received |
| `LOOP_DETECTED` | `loop:detected` | — | **Unimplemented** — defined in source but not yet emitted |

### Context / Prompt Building

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `SYSTEM_PROMPT_BUILD` | `systemPrompt:build` | pipeline | Building system prompt — handlers return chunks |
| `CONTEXT` | `context` | pipeline | Before each LLM call — return `{ messages }` to replace messages (see §Pipeline) |
| `INPUT` | `input` | pipeline | Preprocess user input — transform or short-circuit |

### Tool Execution

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `TOOLS_REGISTER` | `tools:register` | invoked by the loader | Register tools with the registry (the extension loader awaits it directly during `load()`) |
| `TOOL_METADATA` | `tool:metadata` | awaited notify | After tools register — extensions can modify tool metadata |
| `TOOL_BEFORE_EXECUTE` | `tool:beforeExecute` | awaited notify | Before a tool executes |
| `TOOL_AFTER_EXECUTE` | `tool:afterExecute` | awaited notify | After a tool executes (settled before the `TOOL_RESULT` pipeline) |
| `TOOL_CALL` | `tool:call` | pipeline | Gate — block, modify, or allow tool calls. Payload: `toolCallId`, `toolName`, `input`, `agent`, `toolCtx` (built and settled before this pipeline, so a handler can prompt through `toolCtx.get("input")`) |
| `TOOL_RESULT` | `tool:result` | pipeline | Modify tool result before LLM sees it |
| `AGENT_TOOL_CONTEXT` | `agent:toolContext` | awaited notify | Enrich shared tool context — awaited before the `TOOL_CALL` gate, so handler mounts (even from async handlers) are complete for the gate and `tool.execute()`; the same `toolCtx` instance reaches both |
| `TOOL_METRICS` | `tool:metrics` | awaited notify | After each individual tool execution — telemetry, profiling |

### Services

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `SERVICES_REGISTER` | `services:register` | invoked by the loader | Register abstract service implementations (the extension loader invokes it synchronously during `load()`, so services are available to downstream extensions) |

### Provider Interaction

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `PROVIDER_REQUEST` | `provider:request` | pipeline | Before LLM HTTP request — modify messages/model/tools |
| `PROVIDER_RESPONSE` | `provider:response` | pipeline | After LLM response fully received — handler may return `{ response }` to replace it (e.g. tool-call-repair reconstructing tool calls a local backend leaked as text) |

The `LlmProtocol` (selected by the `protocol` field on the model or provider entry, default `"openai"`) owns the wire format itself: request building, stream parsing, auth headers. The hooks above are the override hatch -- a hook can still replace the fully-built request or the parsed response without writing a new protocol. In short: **protocol = format, hooks = override**.

### Turn Lifecycle

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `TURN_START` | `turn:start` | awaited notify | Beginning of each agent loop iteration |
| `TURN_END` | `turn:end` | awaited notify | End of each agent loop iteration (settled before the loop returns, advances, or throws) |

### Model / Config

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `MODEL_CHANGE` | `model:change` | notify (fire-and-forget) | Agent model changed (sync setter) |

### CLI / Commands

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `CLI_SUBCOMMANDS_REGISTER` | `cli:subcommandsRegister` | awaited notify | Register CLI subcommand handlers |
| `CLI_ARGS_PARSED` | `cli:argsParsed` | awaited notify | After CLI args parsed. Notification only: it runs after the early exit for "no subcommand", so use `cli:flags[].isSubcommand` to select a subcommand |
| `COMPLETION_REQUEST` | `completion:request` | — | **Unfired** — defined in source but never notified; tab completions go through `CompletionService.register()` instead |
| `COMMAND_DISPATCH` | `command:dispatch` | pipeline | Dispatch a command — handlers can intercept |
| `COMMANDS_REGISTER` | `commands:register` | awaited notify | Register slash commands (agent factory awaits it before the agent is returned) |

### Output / Logging

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `OUTPUT_EVENT` | `output:event` | notify (fire-and-forget) | Any output event (tool call, result, streaming, etc.) |
| `LOG` | `log` | notify (fire-and-forget) | Logger emits a log entry |

### Shutdown

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `SHUTDOWN_CLEANUP` | `shutdown:cleanup` | awaited notify | Application shutdown — cleanup handlers (all must settle before cleanup returns) |

---

## Extension Hook Registration Patterns

Extensions register handlers via the `create()` function, which receives the `core` object and returns an object with a `hooks` property. Each key is a hook name, each value is a handler function.

### 1. Notification (side effects)

Used for logging, metrics, side effects. Return value is ignored. Async
handlers run in parallel; the core `await`s the `notifyHooks()` promise at
ordering-critical sites (tool pipeline, turn boundaries, session lifecycle,
shutdown), so by the time the awaited point passes, every handler has
settled. Sync core call sites (message add, model change, output events)
fire it unawaited — treat those as plain fire-and-forget.

```js
// session-log extension
[HOOKS.CONTEXT_MESSAGE]: async ({ message, agent }) => {
  const sessionId = agent?.sessionId || message.sessionId || 'unknown';
  const logPath = join(cacheDir, `${sessionId}.jsonl`);
  await appendFile(logPath, JSON.stringify(entry) + '\n');
}
```

### 2. Tool Registration

Extensions provide tools via the `tools:register` hook. The handler receives the `ToolRegistry` instance.

```js
// bash-tool extension
[HOOKS.TOOLS_REGISTER]: async (registry) => {
  const tool = new BashTool({ timeoutMs, maxOutputLines });
  registry.register("bash", tool);
}
```

### 3. Pipeline — Gate (block/modify)

The `tool:call` hook uses `runHookPipeline` with `shouldStop`. Handlers can block execution or modify input arguments.
The pipeline is `failOnError: true`: a handler that throws becomes the tool result and the tool never runs, so a handler
that itself wants to say "denied" should return `{ action: "block", result }` rather than throw. `user-gate` is the
built-in handler of this kind — tool-call approvals on top of `toolCtx.get("input")`
(`docs/config-reference.md` "userGate").

```js
[HOOKS.TOOL_CALL]: ({ toolName, input }) => {
  if (toolName === "dangerous-tool") {
    return { action: "block", result: "Blocked for safety" };
  }
  if (toolName === "bash") {
    const args = JSON.parse(input);
    args.command = `set -euo pipefail; ${args.command}`;
    return { action: "modify", input: JSON.stringify(args) };
  }
  return { action: "continue" };
}
```

### 4. Pipeline — Transformation

The `context`, `provider:request`, `provider:response`, `tool:call`, `tool:result`, `input`, and `command:dispatch` hooks transform data sequentially, all by the same rule: **a handler's return value is a partial patch of the payload.** Each defined field it returns is written onto the payload, so every later handler — and core, which reads the payload back — sees the transformation. Returning nothing, or leaving a field undefined, leaves that field alone.

```
{ messages }        on context            replaces the array
{ modelConfig }     on provider:request   replaces the model only
{ result }          on tool:result        replaces the tool's answer
{ action, input }   on tool:call          gates and rewrites the call
```

Two handlers patching *different* fields both take effect — `{ modelConfig }` followed by `{ messages }` keeps both. Two patching the *same* field: the last one wins. A bare array is not a patch and is ignored (only objects are adopted), so `[...messages]` silently does nothing.

```js
// compaction extension — checks token budget, compacts if needed
[HOOKS.CONTEXT]: async ({ messages, agent }) => {
  if (!settings.enabled) return;
  // ... check token budget, perform compaction
  return { messages: agent.buildMessages() };
}
```

```js
// tool:result — redact sensitive data
[HOOKS.TOOL_RESULT]: ({ result }) => {
  if (typeof result === "string" && result.includes("sk-")) {
    return { result: result.replace(/sk-[a-zA-Z0-9]+/g, "[REDACTED]") };
  }
  return { result };
}
```

### 5. System Prompt Chunk Contribution

Extensions contribute chunks to the system prompt. Chunks are sorted by `priority` (lower = earlier in the prompt) and rendered into the template.

```js
// skills extension
[HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent }) => {
  const preamble = await loader.buildSkillsPreamble();
  if (preamble) {
    return { name: "preamble", priority: 400, content: preamble };
  }
}
```

### 6. Command Registration

Extensions can register slash commands and CLI subcommands.

```js
// compaction extension
[HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
  registry.register('compact', {
    description: 'Compact context ([n]) or switch strategy (<strategy>, compact:<strategy>)',
    matches: (cmd) => cmd === 'compact' || cmd.startsWith('compact ') || cmd.startsWith('compact:'),
    handler: async (agent, cmdValue) => { /* ... */ },
  });
}
```

### 7. Shared Context Enrichment

Extensions mount objects on the `ToolContext` so tools can access them during execution.

```js
// skills extension — mount skills loader
[HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx }) => {
  toolCtx.set("skillsLoader", loader);
}

// subagents extension — mount task manager
[HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx }) => {
  toolCtx.set("taskManager", taskManager);
  toolCtx.set("sessionCore", sessionCore || null);
}
```

---

## Hook Registration API

```js
// Register a handler
const remove = hooks.on("hook:name", handler, "extension-name");

// Remove by returned function
remove();

// Remove by handler reference
hooks.off("hook:name", handler);

// Remove all handlers for a hook (or all hooks)
hooks.clear("hook:name");
hooks.clear(); // clears all

// Query
hooks.handlerCount("hook:name");
hooks.hookNames(); // returns all registered hook names
```

The optional `source` parameter (third argument to `on()`) is used for tracing and identification. Extensions typically pass their name.

---

## Trace System

The hook system has a built-in trace facility for debugging:

```js
hooks._trace = true; // enable trace logging
```

When enabled, every handler invocation is logged with:
- Hook name
- Handler index / total count
- Source identifier (extension name)
- Duration in milliseconds
- Return value summary (for pipeline hooks)

Trace output is suppressed for the `log` hook to avoid infinite loops.

---

## Data Flow Summary

```
User Input
    │
    ▼ ─── INPUT pipeline ────► transform / short-circuit
    │
    ▼ ─── SYSTEM_PROMPT_BUILD ──► chunks collected, sorted, rendered
    │
    ▼ ─── buildMessages() ────► system prompt + context
    │
    ▼ ─── CONTEXT pipeline ────► modify messages (compaction, injection)
    │
    ▼ ─── PROVIDER_REQUEST ────► modify messages/model/tools
    │
    ▼ ─── LLM call ───────────► streaming response
    │
    ▼ ─── PROVIDER_RESPONSE ───► logging, metrics, repair
    │
    ▼ ─── Tool calls? ────────► Yes → TOOL_CALL gate → execute → TOOL_RESULT
    │                           No  → final response, return
    │
    ▼ ─── TURN_END ───────────► per-turn analysis
    │
    └── next iteration or return
```

---

## Extension Capabilities

Extensions declare what they provide via the `provides` field in `extension.json`:

```js
export const EXTENSION_PROVIDES = {
  CLI_SUBCOMMANDS: "cli:subcommands",
  TOOLS: "tools",
  LLM_PROTOCOLS: "llm:protocols",
  WIRE_FORMATS: "wire:formats",
  ROLE_MAPPINGS: "role:mappings",
};
```

These are used for dependency resolution and load ordering.
