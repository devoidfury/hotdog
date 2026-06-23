# Hook Lifecycle

The hook system is the primary extension mechanism in oa-agent. It decouples the core from all features — tools, compaction, MCP, skills, prompts, logging, and CLI subcommands — via a simple pub-sub pipeline. Extensions register handlers; the core emits events at every stage of the agent lifecycle.

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                    Core                      │
│  ┌───────────┐    ┌──────────────┐          │
│  │  Agent     │───▶│  HookSystem  │          │
│  │  (run      │    │              │          │
│   │   loop)    │    │  .notifyHooks()       │
│   │           │    │  .notifyHooksAsync()    │
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
| `notifyHooks(name, data)` | Sync fire-and-forget | Notifications, logging, tracing |
| `notifyHooksAsync(name, data)` | Async fire-and-forget | Concurrent notifications (e.g., turn start/end) |
| `runHookPipeline(name, data, opts)` | Sequential, returns results | Modifications that chain (e.g., context, tool call gate) |

**Key distinction:**
- **Fire-and-forget** — handlers run and their return values are discarded. Used for side-effect notifications.
- **Pipeline** — handlers run one at a time, each sees the accumulated state, and can return a result to stop or transform processing. Used for gates and transformations.

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
Load Config ───────────────► "config:cliFlagsRegister" (extension CLI flags)
                              "config:paramsRegister" (extension config params)
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
| `config:cliFlagsRegister` | Before CLI arg parsing | sync notify | `configRegistry` |
| `config:paramsRegister` | Before CLI arg parsing | sync notify | `configRegistry` |
| `cli:argsParsed` | After CLI args parsed | sync notify | `{ cli }` |
| `cli:subcommandsRegister` | After extensions loaded | sync notify | `cliSubcommandRegistry` |

### 2. Session Lifecycle

```
Session Create ────────────► "session:create"
    │
    ▼
Agent Run Loop ────────────► See Phase 3
    │
    ▼
Session Serialize ──────────► "session:serialize"
Session Deserialize ────────► "session:deserialize"
Session Swap ──────────────► "session:swap"
Session Restore ────────────► "session:restoreActive"
```

| Hook | When | Mechanism | Payload |
|------|------|-----------|---------|
| `session:create` | New agent created | async notify | `{ session, config }` |
| `session:swap` | Agent swapped | async notify | `{ oldAgent, newAgent }` |
| `session:serialize` | Agent state serialized | sync notify | depends on serializer |
| `session:deserialize` | Agent state deserialized | async notify | `{ data }` |
| `session:restoreActive` | Restore flag changes | sync notify | `{ agent, isRestoring }` |

### 3. Agent Run Loop — Per-Iteration Lifecycle

This is the heart of the system — one iteration of the LLM-tools loop.

```
┌─────────────────────────────────────────────────────────┐
│                  AGENT RUN LOOP (one iteration)         │
│                                                          │
│  1. TURN_START ───────────────► async notify             │
│      (per-turn metrics, analytics)                       │
│                                                          │
│  2. INPUT ────────────────────► sequential pipeline      │
│      (preprocess user input, can short-circuit)          │
│      Actions: { action: "continue" }                     │
│               { action: "transform", text }              │
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
│  8. PROVIDER_RESPONSE ───────► async notify              │
│      (response logging, metrics, cost tracking)          │
│                                                          │
│  9. MESSAGES_AFTER_LLM ─────► async notify              │
│      (post-LLM analysis)                                 │
│                                                          │
│ 10. TOOL EXECUTION ──────────► See tool pipeline below   │
│                                                          │
│ 11. TURN_END ───────────────► async notify               │
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
  TOOL_BEFORE_EXECUTE ───────► async notify
       │
       ▼
  TOOL_CALL (gate) ──────────► sequential pipeline
       │                       Actions:
       │                         { action: "continue" }
       │                         { action: "modify", input }
       │                         { action: "block", result }
       │                       Stops on "block" or "continue" with no modify
       │
       ▼
  AGENT_TOOL_CONTEXT ─────────► async notify (enrich shared context)
       │
       ▼
  Validate args ─────────────► JSON Schema validation
       │
       ▼
  Execute tool ──────────────► tool.execute(input, toolCtx)
       │
       ▼
  TOOL_AFTER_EXECUTE ────────► async notify
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
  CONTEXT_MESSAGE ───────────► async notify (session log, etc.)
```

### 4. Shutdown

```
  SHUTDOWN_CLEANUP ──────────► async notify
       │                       (close MCP connections, flush logs, etc.)
```

---

## Complete Hook Reference

### Session Lifecycle

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `SESSION_CREATE` | `session:create` | async notify | New agent created via SessionManager |
| `SESSION_SWAP` | `session:swap` | async notify | Agent swapped in SessionManager |
| `SESSION_SERIALIZE` | `session:serialize` | sync notify | Agent state being serialized |
| `SESSION_DESERIALIZE` | `session:deserialize` | async notify | Agent state being deserialized |
| `SESSION_RESTORE_ACTIVE` | `session:restoreActive` | sync notify | Restore flag changes on agent |

### Message Flow

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `CONTEXT_MESSAGE` | `context:message` | async notify | A message added to agent context |
| `CONTEXT_REPLACED` | `context:replaced` | async notify | Entire context replaced (compaction, reset) |
| `MESSAGES_AFTER_LLM` | `messages:afterLLM` | async notify | After LLM response received |
| `LOOP_DETECTED` | `loop:detected` | — | Tool loop detected (not yet emitted) |

### Context / Prompt Building

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `SYSTEM_PROMPT_BUILD` | `systemPrompt:build` | pipeline | Building system prompt — handlers return chunks |
| `CONTEXT` | `context` | pipeline | Before each LLM call — modify messages array |
| `INPUT` | `input` | pipeline | Preprocess user input — transform or short-circuit |

### Tool Execution

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `TOOLS_REGISTER` | `tools:register` | sync notify | Register tools with the registry |
| `TOOL_BEFORE_EXECUTE` | `tool:beforeExecute` | async notify | Before a tool executes |
| `TOOL_AFTER_EXECUTE` | `tool:afterExecute` | async notify | After a tool executes |
| `TOOL_CALL` | `tool:call` | pipeline | Gate — block, modify, or allow tool calls |
| `TOOL_RESULT` | `tool:result` | pipeline | Modify tool result before LLM sees it |
| `AGENT_TOOL_CONTEXT` | `agent:toolContext` | async notify | Enrich shared tool context |

### Provider Interaction

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `PROVIDER_REQUEST` | `provider:request` | pipeline | Before LLM HTTP request — modify messages/model/tools |
| `PROVIDER_RESPONSE` | `provider:response` | async notify | After LLM response fully received |

### Turn Lifecycle

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `TURN_START` | `turn:start` | async notify | Beginning of each agent loop iteration |
| `TURN_END` | `turn:end` | async notify | End of each agent loop iteration |

### Model / Config

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `MODEL_CHANGE` | `model:change` | sync notify | Agent model changed |
| `CONFIG_CLI_FLAGS_REGISTER` | `config:cliFlagsRegister` | sync notify | Register CLI flags for extension |
| `CONFIG_PARAMS_REGISTER` | `config:paramsRegister` | sync notify | Register config params for extension |

### CLI / Commands

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `CLI_SUBCOMMANDS_REGISTER` | `cli:subcommandsRegister` | sync notify | Register CLI subcommand handlers |
| `CLI_ARGS_PARSED` | `cli:argsParsed` | sync notify | After CLI args parsed |
| `COMMAND_DISPATCH` | `command:dispatch` | pipeline | Dispatch a command — handlers can intercept |
| `COMMANDS_REGISTER` | `commands:register` | sync notify | Register slash commands |

### Output / Logging

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `OUTPUT_EVENT` | `output:event` | sync notify | Any output event (tool call, result, streaming, etc.) |
| `LOG` | `log` | sync notify | Logger emits a log entry |

### Shutdown

| Hook Constant | Name | Pattern | When |
|---------------|------|---------|------|
| `SHUTDOWN_CLEANUP` | `shutdown:cleanup` | async notify | Application shutdown — cleanup handlers |

---

## Extension Hook Registration Patterns

Extensions register handlers via the `create()` function, which receives the `core` object and returns an object with a `hooks` property. Each key is a hook name, each value is a handler function.

### 1. Fire-and-Forget Notification

Used for logging, metrics, side effects. Return value is ignored.

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

The `context`, `provider:request`, and `tool:result` hooks transform data sequentially. Each handler sees the output of the previous handler.

```js
// compaction extension — checks token budget, compacts if needed
[HOOKS.CONTEXT]: async ({ messages, agent }) => {
  if (!settings.enabled) return;
  // ... check token budget, perform compaction
  const newMessages = agent.buildMessages();
  return { messages: newMessages };
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
    description: 'Compact context',
    matches: (cmd) => cmd.startsWith('compact'),
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
    ▼ ─── PROVIDER_RESPONSE ───► logging, metrics
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
};
```

These are used for dependency resolution and load ordering.
