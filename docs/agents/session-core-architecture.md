# Session Core Architecture — Restructuring Plan

> **Status**: Design Phase
> **Created**: 2025-05-19
> **Target**: oa-js v0.2.0

---

## Table of Contents

1. [Current State Analysis](#1-current-state-analysis)
2. [Target Architecture](#2-target-architecture)
3. [Event Protocol](#3-event-protocol)
4. [Session Core Design](#4-session-core-design)
5. [Agent Changes](#5-agent-changes)
6. [ClientApp Interface](#6-clientapp-interface)
7. [Duplex Queue Design](#7-duplex-queue-design)
8. [Migration Plan](#8-migration-plan)
9. [File Layout](#9-file-layout)
10. [Risk Assessment](#10-risk-assessment)

---

## 1. Current State Analysis

### 1.1 What Works Well

| Component | Strength |
|-----------|----------|
| **Agent** (`agent.js`) | Clean, self-contained LLM loop. Tool execution, context management, compaction, token tracking — all cohesive. |
| **OutputSink abstraction** | Agent depends on an interface, not a concrete UI. This already enables different sinks. |
| **SessionManager** | Decouples UI from agent type. Enables profile switching via `swapAgent()`. |
| **SessionBuilder** | Encapsulates the full initialization pipeline. No scattered construction logic. |
| **MessageQueue** | Simple, correct FIFO queue. No over-engineering. |
| **TaskManager / TaskWorker** | Background task delegation works. `TaskHandle` provides status/follow-up/interrupt. |

### 1.2 What's Duplicated

**The core problem: TaskWorker is a mini-Agent.**

`TaskWorker._runInner()` and `Agent.run()` perform the same algorithm:

```
while (iterations < max):
    build messages
    call LLM
    process streaming response
    if tool calls → execute tools → loop
    else → return result
```

This duplication means:
- Bug fixes in the LLM loop must be applied in two places
- New features (e.g., new event types) must be added to both
- Testing is harder — two code paths to cover
- TaskWorker has its own tool registry construction, its own MessageLog, its own stream processing

### 1.3 What's Tightly Coupled

#### main.js — The Monolith

`main.js` mixes:
- CLI subcommand dispatch (`info`, `show-prompt`, `review`)
- Config resolution (`buildConfig`)
- Session builder creation
- Output sink construction
- Session manager creation
- MessageBus wiring
- Task wake-up callback setup
- One-shot mode logic
- Interactive mode readline setup
- SIGINT handling (via `runInteractiveSession`)
- Shutdown logic

No single responsibility. Every change to any layer risks breaking something else.

#### MessageBus — The Swiss Army Knife

`MessageBus` does too much:
1. Owns the agent run loop (`_dispatchLoop`)
2. Queues messages (`MessageQueue`)
3. Cancels agents (`cancel()`)
4. Routes task wake-ups (`wireTaskWakeUp`)
5. Mangler integration (marker mangling of task results)
6. UI prompt coordination (`onMessageProcessed` → `promptFn()`)
7. Error handling and formatting

The `wakeUpCallback` pattern is particularly fragile:
- A callback marshals data, pushes to an agent's private `_pendingTaskMessages` array, emits an event, AND the MessageBus re-enqueues the marshalled string. Three separate mechanisms for one piece of data.

#### TaskWorker's Direct Context Manipulation

`TaskWorker.run()` directly manipulates `this.managerContext.addSystemMessage()` — it knows the exact shape of the manager's context. This is a coupling between the task worker and the agent's internal implementation.

### 1.4 Architectural Invariants That Must Be Preserved

1. **Agent.run()** — The core LLM loop must remain unchanged
2. **Tool execution** — Tool registry, tool context, tool execution must work the same
3. **Context management** — MessageLog, session logging, compaction must work the same
4. **Session persistence** — Session log reading/writing must work the same
5. **MCP connections** — Must continue to work as they do now
6. **LSP tools** — Must continue to work as they do now
7. **Skill system** — Must continue to work as it does now
8. **All existing tests must pass**

---

## 2. Target Architecture

### 2.1 High-Level Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ClientApp Layer                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐                  │
│  │    CLI       │  │    Web       │  │    RPC       │                  │
│  │  (readline)  │  │(WebSocket)   │  │  (HTTP)      │                  │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘                  │
│         │                  │                  │                          │
│         └──────────────────┼──────────────────┘                          │
│                            │                                             │
│                     [Input Events]                                       │
│                     [Output Events]                                       │
│                     [Commands]                                            │
└────────────────────────────┼─────────────────────────────────────────────┘
                             │
                     ▼ Duplex Queue ▼
              ┌──────────────────────────┐
              │  EventChannel (typed,    │
              │  ordered)               │
              └────────────┬─────────────┘
                           │
┌──────────────────────────┼──────────────────────────────────────────────┐
│                          ▼                                              │
│                     Session Core                                         │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │  SessionCore                                                 │        │
│  │                                                            │        │
│  │  ┌──────────────────┐  ┌──────────────────┐               │        │
│  │  │ SessionManager   │  │ EventRouter      │               │        │
│  │  │ (lifecycle,      │  │ (input→agent,    │               │        │
│  │  │  swaps, multi-   │  │  output→client)  │               │        │
│  │  │  session)        │  │                  │               │        │
│  │  └──────────────────┘  └──────────────────┘               │        │
│  │                                                            │        │
│  │  ┌──────────────────┐  ┌──────────────────┐               │        │
│  │  │ TaskOrchestrator │  │ SharedResources  │               │        │
│  │  │ (spawn, route,   │  │ (builder,        │               │        │
│  │  │  drain)          │  │  config, etc.)   │               │        │
│  │  └──────────────────┘  └──────────────────┘               │        │
│  └────────────────────────────────────────────────────────────┘        │
│                          │                                              │
│                     ▼ Agent ▼                                          │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │  Agent (LLM loop, tools, context)                          │        │
│  │  - run(input)                                              │        │
│  │  - tool execution                                          │        │
│  │  - context management                                      │        │
│  │  - delegate_task() → TaskHandle                            │        │
│  └────────────────────────────────────────────────────────────┘        │
│                          │                                              │
│                     ▼ Agent ▼ (task agent)                              │
│  ┌────────────────────────────────────────────────────────────┐        │
│  │  Task Agent (same Agent class, different sink)             │        │
│  │  - output → Session Core internal sink                     │        │
│  │  - Session Core routes result back to parent               │        │
│  └────────────────────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Component Descriptions

#### 2.2.1 ClientApp Layer

**Responsibility**: Translate between user interaction and the Session Core's event protocol.

**CLI ClientApp**:
- Creates readline interface
- Reads lines → emits `InputEvent`
- Receives `OutputEvent` → renders to terminal
- Handles slash commands (UI-level: help, quit, tools toggle, thinking toggle, shell)
- Delegates agent-level commands to Session Core via commands

**Web ClientApp** (future):
- WebSocket server (Bun-native)
- Parses JSON messages → emits `InputEvent`
- Receives `OutputEvent` → sends JSON over WebSocket
- Same event protocol as CLI

**RPC ClientApp** (future):
- HTTP server with streaming response
- Request body → `InputEvent`
- Server-sent events (SSE) for `OutputEvent`
- Same event protocol

**Key principle**: ClientApps know nothing about sessions, agents, or tasks. They only know: "I receive input, I emit input events. I receive output events, I display them."

#### 2.2.2 Duplex Event Queue

**Responsibility**: Typed, ordered event channel between ClientApp and Session Core.

**Design**: Async iterator + async generator pattern. See [Section 7](#7-duplex-queue-design) for details.

**Properties**:
- **Input direction**: ClientApp → Session Core (user text, commands)
- **Output direction**: Session Core → ClientApp (streaming chunks, tool calls, task events)
- **Typed events**: Every event has a `type` discriminator and structured data.
- **Ordered delivery**: Events are delivered in the order they were produced.

#### 2.2.3 Session Core

**Responsibility**: Orchestrates sessions, agents, and tasks. The brain of the system.

**Components**:

1. **SessionManager** (existing, moved)
   - Owns `SessionBuilder` + current agent
   - Enables agent swaps (profile switching)
   - Multi-session support via `SessionStore`
   - No changes needed — just relocated

2. **EventRouter** (new)
   - Receives input events from ClientApp
   - Routes them to the current agent
   - Receives output events from agent (via its sink)
   - Routes them to ClientApp (via the duplex queue's output side)
   - Handles task completion events: routes task result back to parent agent's context

3. **TaskOrchestrator** (new)
   - Manages task lifecycle: spawn, monitor, complete, cancel
   - When agent calls `delegate_task()`, TaskOrchestrator creates a new Agent instance
   - The task agent's sink points to the Session Core's internal event sink
   - On task completion, TaskOrchestrator:
     1. Receives the completion event from the task agent's sink
     2. Formats the result as a system message
     3. Injects it into the parent agent's context
     4. Emits a `TASK_COMPLETE` event to the ClientApp
   - This completely replaces TaskWorker

4. **SharedResources** (existing, moved)
   - `SessionBuilder` instance
   - `MarkerMangler` instance
   - Configuration
   - Available to all agents in the session

#### 2.2.4 Agent (unchanged core)

**Responsibility**: The AI agent loop — LLM calls, tool execution, context management.

**Changes from current**:
- Minimal. The Agent class stays essentially the same.
- `delegate_task()` method (new) — instead of calling `taskManager.spawnTask()`, it calls `sessionCore.spawnTask()` and returns a `TaskHandle`.
- The agent's `sink` is its output target. For task agents, this is the Session Core's internal sink.
- The agent's `taskManager` field is removed — tasks are managed by the Session Core, not by the agent.

### 2.3 Data Flow: Normal Message

```
ClientApp (CLI reads line)
    │
    │ InputEvent { type: 'input', text: 'fix the bug' }
    ▼
Duplex Queue (input side)
    ▼
Session Core → EventRouter
    │
    │ Routes to current agent
    ▼
Agent.run('fix the bug')
    │
    │ Agent calls LLM, executes tools, etc.
    │ Emits events to its sink
    ▼
Session Core → Internal Sink (for this agent)
    │
    │ Routes events to duplex queue (output side)
    ▼
Duplex Queue (output side)
    ▼
ClientApp (renders to terminal)
```

### 2.4 Data Flow: Task Delegation

```
Parent Agent.run() calls delegate_task('task-1', 'implement feature X')
    │
    ▼
Session Core → TaskOrchestrator.spawnTask()
    │
    │ Creates new Agent instance with:
    │   - sink = InternalTaskSink (part of Session Core)
    │   - system prompt = task profile
    │   - allowed tools = task profile's whitelist
    │   - parentSessionId = parent's session ID
    │   - parentAgent = reference to parent agent
    ▼
Task Agent.run() starts
    │
    │ Task agent calls LLM, executes tools, etc.
    │ Emits events to InternalTaskSink
    ▼
InternalTaskSink (in Session Core)
    │
    │ Collects output, emits TASK_PROGRESS events
    │ On completion, receives final result
    ▼
TaskOrchestrator.onTaskComplete()
    │
    │ 1. Formats result as system message
    │ 2. Injects into parent agent's context
    │ 3. Emits TASK_COMPLETE event to ClientApp
    │ 4. Wakes up parent agent's run loop
    ▼
Parent Agent.run() continues (drains pending messages)
```

### 2.5 Data Flow: Session Switch

```
ClientApp (user types /clear:profile-name)
    │
    │ CommandEvent { type: 'switch_session', profile: 'profile-name' }
    ▼
Duplex Queue
    ▼
Session Core → EventRouter
    │
    │ Routes command to SessionManager
    ▼
SessionManager.swapAgent()
    │
    │ Builds new agent with new profile
    │ Replaces current agent in SessionStore
    ▼
New Agent (with new sink pointing to Session Core)
    │
    │ Session Core routes subsequent events to new agent
    ▼
ClientApp (renders profile switch confirmation)
```

---

## 3. Event Protocol

### 3.1 Event Types

All events are plain objects with a required `type` discriminator.

#### 3.1.1 Input Events (ClientApp → Session Core)

**User sends text input**:
- `type: 'input'`
- `text: string`
- `sessionId?: string` — for multi-session support

**User sends a command**:
- `type: 'command'`
- `name: string` — e.g., `'cancel'`, `'switch_session'`, `'compact'`
- `args?: Record<string, unknown>` — command arguments

**Session-level commands**:
- `switch_session`: `{ type: 'switch_session', sessionId: string }`
- `new_session`: `{ type: 'new_session', profile?: string }`

#### 3.1.2 Output Events (Session Core → ClientApp)

**Streaming content from the agent**:
- `streaming_chunk`: `{ type: 'streaming_chunk', content: string, sessionId?: string }`
- `streaming_reasoning_chunk`: `{ type: 'streaming_reasoning_chunk', content: string, sessionId?: string }`

**Tool interaction**:
- `tool_call`: `{ type: 'tool_call', toolName, input, toolCallId, sessionId?: string }`
- `tool_result`: `{ type: 'tool_result', toolName, input, result, sessionId?: string }`

**Task events**:
- `task_progress`: `{ type: 'task_progress', taskId, status, activeTasks?, totalTasks?, sessionId?: string }`
- `task_complete`: `{ type: 'task_complete', taskId, result, sessionId?: string }`

**System events**:
- `compacting`: `{ type: 'compacting', messageCount, keepRecent, sessionId?: string }`
- `compaction_result`: `{ type: 'compaction_result', summary, messagesCompacted, strategy, sessionId?: string }`
- `token_usage`: `{ type: 'token_usage', promptTokens, cachedTokens, completionTokens, totalTokens, sessionId?: string }`
- `command_result`: `{ type: 'command_result', content, sessionId?: string }`
- `user_message`: `{ type: 'user_message', content, sessionId?: string }`
- `assistant_message`: `{ type: 'assistant_message', content, sessionId?: string }`
- `thinking`: `{ type: 'thinking', content, sessionId?: string }`
- `question`: `{ type: 'question', questions: [...], sessionId?: string }`

#### 3.1.3 Internal Events (Session Core Internal)

These are used within the Session Core and are NOT emitted to the ClientApp:

- `__task_output__`: `{ type: '__task_output__', taskId, data: { type, content?, toolName?, result? } }` — task agent output
- `__task_completion__`: `{ type: '__task_completion__', taskId, result, parentAgentId }` — task completion routed to parent
- `__task_progress__`: `{ type: '__task_progress__', taskId, status }` — task progress shown to user

### 3.2 Event Type Constants

Define constants for all event types in a central `events.js` module. Separate `INPUT_EVENT` and `OUTPUT_EVENT` namespaces.

### 3.3 Event Creation Helpers

Factory functions for each event type to ensure consistent structure. E.g., `createInputEvent(text, sessionId)`, `createCommandEvent(name, args)`, etc.

---

## 4. Session Core Design

### 4.1 SessionCore Class

**Responsibility**: Central orchestrator. Wires together SessionManager, EventRouter, TaskOrchestrator, and the duplex queue.

**Key methods**:
- `start()` / `stop()` — lifecycle management
- `getAgent()` / `sessionId()` — access current agent
- `spawnTask(taskId, description, options)` — called by Agent.delegate_task()
- `interruptTask(taskId)` / `sendTaskFollowUp(taskId, message)` — task control
- `activeTasks()` — list running tasks
- `routeInput(inputEvent)` — forward input to EventRouter
- `routeOutput(outputEvent)` — forward output to ClientApp
- `cancel()` — cancel current run

### 4.2 EventRouter

**Responsibility**: The dispatch loop. Receives events from the duplex queue and routes them appropriately.

**Key responsibilities**:
- Runs an input loop that consumes events from the duplex queue
- Routes `input` events to the current agent via `agent.run()`
- Routes `command` events to command handlers (cancel, compact, clear, model, etc.)
- Routes `switch_session` and `new_session` events to SessionManager
- Creates new `AgentSink` instances for new agents

### 4.3 AgentSink (bridges Agent → Session Core)

**Responsibility**: Output sink assigned to every agent. Routes agent output events to the Session Core for further processing.

**Two modes**:
1. **Normal agent**: `_isTaskAgent = false` — all events are forwarded to the ClientApp via `routeOutput()`.
2. **Task agent**: `_isTaskAgent = true` — filters streaming/tool events (task agents are silent to the UI), captures `TASK_PROGRESS` events, and on completion calls `onTaskComplete()` to route the result back to the parent.

**Key methods**:
- `emit(event)` — routes based on agent type
- `setTaskAgentId(taskId)` — sets the task ID for task agents
- `onTaskComplete(result)` — called when task agent finishes

### 4.4 TaskOrchestrator

**Responsibility**: Manages task lifecycle: spawn, monitor, complete, cancel.

**Key methods**:
- `spawn(taskId, description, options)` — creates a new Agent instance with a task-specific sink, system prompt, and tool whitelist. Returns a `TaskHandle`.
- `onTaskComplete(taskId, result)` — formats result as a system message, injects into parent agent's context, emits `TASK_COMPLETE` event, updates task status.
- `interrupt(taskId)` — aborts the task's AbortController.
- `followUp(taskId, message)` — adds follow-up to the task agent's context.
- `activeTasks()` / `taskCounts()` — task status queries.

**Task agent configuration**:
- Sink: `AgentSink` with `_isTaskAgent = true`
- System prompt: task profile from config
- Tools: restricted by task profile's whitelist
- Runs in the background via `agent.run(description)`

### 4.5 TaskHandle

**Responsibility**: Return value from `delegate_task()`. Provides control over a running task.

**Key methods**:
- `interrupt()` — cancel the task
- `sendFollowUp(message)` — add a follow-up message
- `status` getter — check current task status

### 4.6 How Task Agents Route Output to Parent

The distinction is made by the **sink type**:

1. **Normal agent**: Gets an `AgentSink` with `_isTaskAgent = false`. All events route directly to the ClientApp.
2. **Task agent**: Gets an `AgentSink` with `_isTaskAgent = true`. Filters streaming/tool events, captures progress, and on completion routes the result back via `onTaskComplete()`.

The Session Core creates the correct sink when spawning the task agent.

### 4.7 How Session Switches Work

1. User types a session switch command in CLI
2. CLI emits a `CommandEvent` or `SwitchSessionEvent`
3. Session Core's `EventRouter` processes the command
4. Calls `SessionManager.swapAgent()` which builds a new agent with the new profile and replaces the current agent
5. The new agent gets a new `AgentSink` routing to the Session Core
6. Subsequent input events are routed to the new agent

For multi-session support, each session has its own agent in `SessionStore`, and the `EventRouter` checks the `sessionId` field on input events.

### 4.8 How Cancellation Propagates

```
SIGINT (or Ctrl-C)
    │
    ▼
CLI ClientApp
    │
    │ Emits CommandEvent { type: 'command', name: 'cancel' }
    ▼
Duplex Queue
    ▼
Session Core → EventRouter
    │
    │ Calls SessionCore.cancel()
    ▼
SessionCore.cancel()
    │
    │ Sets this._cancelled = true
    │ Calls agent.cancel()
    ▼
Agent.cancel()
    │
    │ Sets agent.cancelled = true
    │ Throws LlmError.Cancelled on next LLM call
    ▼
Agent.run() exits with LlmError.Cancelled
    │
    ▼
EventRouter catches the error
    │
    │ Emits CommandResultEvent with cancel message
    │ Restarts the input loop
```

For task agents: `TaskOrchestrator` checks the cancel flag and aborts the task's `AbortController`.

### 4.9 How Multiple Sessions Are Handled

Each session has:
1. Its own `Agent` instance (stored in `SessionStore`)
2. Its own `AgentSink` (for routing output)
3. Its own `SessionId`

The `SessionManager` tracks the `_currentSessionId`. When the user switches sessions, the `_currentSessionId` is updated and subsequent events are routed to the new agent.

For multi-session modes (like ACP), each session gets its own `EventRouter` instance that checks the `sessionId` field on input events to route to the correct agent.

### 4.10 What Happens to the MessageBus

The `MessageBus` is **absorbed into the Session Core**:

| MessageBus responsibility | New location |
|---------------------------|---------------|
| `_dispatchLoop` | `EventRouter._inputLoop()` |
| `MessageQueue` | `EventChannel._inputBuffer` (internal to duplex queue) |
| `cancel()` | `SessionCore.cancel()` |
| `enqueue()` | `EventChannel.emitInput()` |
| `wireTaskWakeUp()` | `TaskOrchestrator.onTaskComplete()` |
| `onMessageProcessed` | `EventRouter._inputLoop()` (implicit — loop continues after each agent.run()) |
| `executePromptAndEnqueue` | `EventRouter._handleCommand()` (prompt command) |

The `MessageBus` class is **removed entirely**. Its functionality is distributed across EventRouter, EventChannel, SessionCore, and TaskOrchestrator.

---

## 5. Agent Changes

### 5.1 Summary of Changes

The Agent class changes are **minimal**:

| Change | Description |
|--------|-------------|
| `delegate_task()` method | New method that calls `sessionCore.spawnTask()` instead of `taskManager.spawnTask()` |
| `taskManager` field | Removed — tasks are managed by Session Core |
| `setSessionCore()` method | New method to inject the Session Core reference |
| `_pendingTaskMessages` | Retained — Session Core injects task results here |
| `drainPendingTaskMessages()` | Retained — unchanged |
| `waitForTasksAndDrain()` | Retained — but simplified (no direct task manager interaction) |

### 5.2 New delegate_task() Method

Add a `delegate_task(taskId, description, options)` method that calls `this._sessionCore.spawnTask(taskId, description, options)` and returns a `TaskHandle`.

Add a `setSessionCore(sessionCore)` method to inject the reference.

### 5.3 Constructor Changes

Add `this._sessionCore = config.sessionCore || null` to the constructor. Keep `this._taskManager` temporarily for backward compatibility during the transition.

### 5.4 waitForTasksAndDrain() Simplification

Replace polling `this.taskManager.activeTasks()` with `this._sessionCore.activeTasks()`. Simplify the logic since the Session Core now owns task lifecycle.

### 5.5 Tool Registry Changes

The `buildToolRegistry()` method currently creates subagent tools when `managerToolsEnabled` is true. Modify it to pass the `SessionCore` reference to subagent tools (`DelegateTaskTool`, `TaskStatusTool`, etc.) so they delegate to the Session Core instead of `TaskManager`.

---

## 6. ClientApp Interface

### 6.1 CLI ClientApp

**Responsibility**: Read from readline, emit events to Session Core, render output events to terminal.

**Key responsibilities**:
- Create readline interface with prompt
- Handle SIGINT → emit cancel command
- Handle input lines → emit `input` events (or `command` events for `/` lines)
- Handle slash commands: UI-level commands (help, quit, tools toggle, thinking toggle, shell) are handled locally; agent-level commands are delegated to Session Core
- Listen for output events from the duplex queue and render them
- Prompt after each event batch

**Event rendering**:
- `streaming_chunk` → write to stdout
- `streaming_reasoning_chunk` → write to stderr
- `tool_call` / `tool_result` → print with formatting (respect hide-tools setting)
- `task_progress` / `task_complete` → print status messages
- `command_result` → print content
- `user_message` → echo user input
- `token_usage` → print token stats

### 6.2 Web ClientApp (Bun-native WebSocket)

**Responsibility**: WebSocket server for web-based interaction.

**Key design points**:
- Uses Bun's built-in `Bun.serve()` with the `websocket` handler — no external dependency
- Per-client `WebSocketClient` wrapper manages per-client output routing and backpressure
- Bun's `ServerWebSocket.send()` returns -1 for backpressure (enqueued), 0 for dropped, 1+ for bytes sent
- On backpressure, buffer events and retry on drain
- Configurable: idle timeout, max payload, compression, backpressure limit

**WebSocket handlers**:
- `open`: Create WebSocketClient, start sending output events to this client
- `message`: Parse JSON → emit input event to Session Core
- `drain`: Retry buffered events
- `close`: Clean up per-client state, drain remaining events
- `error`: Log error

### 6.3 RPC ClientApp (Future)

**Responsibility**: HTTP server with SSE for streaming output.

**Endpoints**:
- `POST /input`: Read body, parse as event, emit to Session Core
- `GET /output`: Stream events via Server-Sent Events (SSE)

---

## 7. Duplex Queue Design

### 7.1 EventChannel Class

**Responsibility**: A typed, ordered event channel providing two independent directions.

**Design**: Async iterator + async generator pattern with producer/consumer coordination via promises.

**Two directions**:
- **Input**: ClientApp → SessionCore (`emitInput`, iterate `inputEvents`)
- **Output**: SessionCore → ClientApp (`emitOutput`, iterate `outputEvents`)

**Mechanism**:
- Each direction has its own buffer (array) and waiting-queue (array of resolve functions)
- `emitXxx(event)`: If there are waiting consumers, resolve immediately. Otherwise, buffer.
- `xxxEvents()`: Async generator that yields from the buffer. If buffer is empty and no waiting producers, wait on a new promise.
- `close()`: Resolve all waiting producers with null to signal closure.

**Configuration options**:
- `inputMax` / `outputMax`: Maximum buffer sizes per direction

### 7.2 Event Ordering

Events are delivered in FIFO order within each direction:
- Input events are processed in the order they arrive from the ClientApp.
- Output events are delivered in the order they are produced by the Session Core.

This is guaranteed by the buffer implementation (array + shift/push).

---

## 8. Migration Plan

### Phase 0: Preparation (No breaking changes)

**Goal**: Add the new infrastructure alongside the existing code.

**Steps**:
1. Create `src/session/` directory with `event_channel.js` (the duplex queue)
2. Create `src/session/events.js` (event type constants and helpers)
3. Add `src/session/event_channel.test.js` (tests for EventChannel)
4. Verify existing tests still pass

**Files created**: `src/session/event_channel.js`, `src/session/events.js`, `src/session/event_channel.test.js`

**Risk**: Very low — pure additions.

### Phase 1: Session Core Foundation (No breaking changes)

**Goal**: Create the Session Core skeleton with EventRouter, AgentSink, and TaskOrchestrator stubs.

**Steps**:
1. Create `src/session/core.js` (SessionCore class)
2. Create `src/session/event_router.js` (EventRouter class)
3. Create `src/session/agent_sink.js` (AgentSink class)
4. Create `src/session/task_orchestrator.js` (TaskOrchestrator class)
5. Create `src/session/task_handle.js` (TaskHandle class)
6. Move `SessionManager` from `src/agent/session_manager.js` to `src/session/session_manager.js`
7. Move `SessionStore` from `src/agent/session_store.js` to `src/session/session_store.js`
8. Move `MessageQueue` from `src/agent/message_queue.js` to `src/session/message_queue.js`
9. Update all imports
10. Verify existing tests still pass

**Files created**: `src/session/core.js`, `src/session/event_router.js`, `src/session/agent_sink.js`, `src/session/task_orchestrator.js`, `src/session/task_handle.js`

**Files moved**: `session_manager.js`, `session_store.js`, `message_queue.js` → `src/session/`

**Files modified**: `src/agent/index.js` (re-exports), `src/main.js` (imports), all files importing from the moved modules.

**Risk**: Low — mostly file moves and import updates. No behavioral changes.

### Phase 2: Agent Integration (No breaking changes)

**Goal**: Add `setSessionCore()` and `delegate_task()` to Agent without removing TaskManager.

**Steps**:
1. Add `setSessionCore(sessionCore)` method to Agent
2. Add `delegate_task(taskId, description, options)` method to Agent
3. Modify subagent tools to accept `SessionCore` reference
4. When `sessionCore` is set, `delegate_task()` uses it; otherwise falls back to `taskManager`
5. Add `AgentSink` to `SessionBuilder.buildAgent()` — every agent gets an `AgentSink`
6. The `AgentSink` routes events through the Session Core (which currently forwards to the original sink)
7. Verify existing tests still pass

**Files modified**: `src/agent/agent.js`, `src/agent/session_builder.js`, `src/tools/subagents.js`

**Risk**: Low — additive changes with backward compatibility.

### Phase 3: Eliminate TaskWorker (Breaking — but incremental)

**Goal**: Replace TaskWorker with Agent instances managed by TaskOrchestrator.

**Steps**:
1. Modify `TaskOrchestrator` to use `Agent` class instead of `TaskWorker`
2. Task agents are now `Agent` instances with: a special `AgentSink` (non-streaming, captures output), a task-specific system prompt, restricted tool set
3. On task completion, `TaskOrchestrator.onTaskComplete()` injects the result into the parent agent's context
4. Remove `TaskWorker` class from `worker.js`
5. Remove `TaskManager` class from `worker.js`
6. Update `SessionBuilder._buildTaskManager()` to return `null`
7. Update `main.js` to remove task wake-up wiring
8. Update `agent.js` to remove `taskManager` field usage
9. Add tests for task agent lifecycle
10. Verify all tests pass

**Files modified**: `src/session/task_orchestrator.js`, `src/session/agent_sink.js`, `src/agent/worker.js`, `src/agent/session_builder.js`, `src/agent/agent.js`, `src/main.js`, `src/tools/subagents.js`

**Files removed**: `src/agent/worker.js` (replaced by TaskOrchestrator + Agent)

**Risk**: Medium — this is the biggest behavioral change. Thorough testing required.

### Phase 4: Thin CLI into ClientApp (Breaking — but incremental)

**Goal**: Extract CLI logic into a pure ClientApp.

**Steps**:
1. Create `src/clientapps/cli.js` (CliClientApp)
2. Create a new `src/main.js` (thin orchestrator)
3. The new `main.js`:
   - Parses CLI args
   - Builds config
   - Creates SessionBuilder
   - Creates EventChannel (duplex queue)
   - Creates SessionCore (with SessionManager, EventRouter, TaskOrchestrator)
   - Creates CliClientApp
   - Wires them together
   - Starts everything
4. Remove all CLI logic from `main.js` into `CliClientApp`
5. Remove `runInteractiveSession` from `ui/session.js` (or keep as legacy)
6. Verify all tests pass

**Files created**: `src/clientapps/cli.js`

**Files modified**: `src/main.js` (complete rewrite — thin orchestrator)

**Files removed**: `src/ui/session.js` (logic moved to CliClientApp)

**Risk**: Medium — main.js is the entry point. Thorough testing required.

### Phase 5: Web/RPC ClientApps (No breaking changes)

**Goal**: Add Web and RPC ClientApp implementations.

**Steps**:
1. Create `src/clientapps/web.js` (WebClientApp)
2. Create `src/clientapps/rpc.js` (RpcClientApp)
3. Update `main.js` to support `--web` and `--rpc` flags
4. Add tests for Web and RPC clients
5. Verify all tests pass

**Files created**: `src/clientapps/web.js`, `src/clientapps/rpc.js`

**Files modified**: `src/main.js` (add --web, --rpc flags)

**Risk**: Low — new features, no changes to existing behavior.

### Phase 6: Cleanup (No breaking changes)

**Goal**: Remove legacy code, consolidate.

**Steps**:
1. Remove `src/agent/message_bus.js` (absorbed into Session Core)
2. Remove `src/ui/session.js` (if not already removed)
3. Remove `src/agent/worker.js` (if not already removed)
4. Clean up unused imports
5. Consolidate event type constants (merge OUTPUT_EVENT from output.js with events.js)
6. Update documentation
7. Verify all tests pass

**Files removed**: `src/agent/message_bus.js`, `src/ui/session.js` (if present), `src/agent/worker.js` (if present)

**Files modified**: `src/context/output.js` (consolidate event types), `src/agent/index.js` (clean up re-exports)

**Risk**: Low — cleanup only.

---

## 9. File Layout

### Proposed Directory Structure

```
oa-js/
├── src/
│   ├── main.js                          # Thin orchestrator (entry point)
│   ├── cli.js                           # CLI argument parsing
│   ├── config.js                        # Configuration loading
│   ├── lib.js                           # Utility functions
│   ├── marker_mangler.js                # Marker mangling for injection prevention
│   ├── session_log.js                   # Session log reading/writing
│   ├── compaction.js                    # Compaction logic
│   ├── compaction/
│   │   ├── strategies.js                # Compaction strategy registry
│   │   └── strategies/
│   │       ├── drop.js
│   │       ├── summarize.js
│   │       ├── summarize-short.js
│   │       └── token-aware.js
│   │
│   ├── session/                         # Session Core (NEW)
│   │   ├── core.js                      # SessionCore class
│   │   ├── event_channel.js             # EventChannel (duplex queue)
│   │   ├── event_router.js              # EventRouter
│   │   ├── agent_sink.js                # AgentSink
│   │   ├── task_orchestrator.js         # TaskOrchestrator
│   │   ├── task_handle.js               # TaskHandle
│   │   ├── session_manager.js           # SessionManager (moved from agent/)
│   │   ├── session_store.js             # SessionStore (moved from agent/)
│   │   ├── message_queue.js             # MessageQueue (moved from agent/)
│   │   ├── events.js                    # Event type constants & helpers
│   │   └── event_channel.test.js        # EventChannel tests
│   │
│   ├── agent/                           # Agent (simplified)
│   │   ├── agent.js                     # Agent class (minimal changes)
│   │   ├── commands.js                  # Command parsing
│   │   └── index.js                     # Re-exports
│   │
│   ├── clientapps/                      # ClientApp implementations (NEW)
│   │   ├── cli.js                       # CliClientApp
│   │   ├── web.js                       # WebClientApp (future)
│   │   └── rpc.js                       # RpcClientApp (future)
│   │
│   ├── context/                         # Context management
│   │   ├── index.js                     # Re-exports
│   │   ├── message.js                   # Message, MessageLog
│   │   ├── output.js                    # OutputSink, OUTPUT_EVENT
│   │   ├── input.js                     # Input handling
│   │   ├── render.js                    # Template rendering
│   │   ├── system_prompt.js             # System prompt building
│   │   └── error.js                     # Error formatting
│   │
│   ├── llm_client/                      # LLM client
│   │   ├── client.js                    # LlmClient
│   │   └── retry.js                     # Retry logic
│   │
│   ├── mcp/                             # MCP connections
│   │   ├── index.js                     # Re-exports
│   │   ├── client.js                    # MCP client
│   │   ├── connection.js                # McpConnection
│   │   ├── tools.js                     # McpTool
│   │   └── types.js                     # MCP types
│   │
│   ├── prompts/                         # Prompt templates
│   │   └── loader.js                    # PromptsLoader
│   │
│   ├── skills/                          # Skills system
│   │   └── loader.js                    # SkillsLoader
│   │
│   ├── tools/                           # Tool implementations
│   │   ├── index.js                     # Re-exports, createToolFactory
│   │   ├── registry.js                  # ToolRegistry, ToolContext
│   │   ├── bash.js
│   │   ├── edit.js
│   │   ├── explore.js
│   │   ├── fetch.js
│   │   ├── find.js
│   │   ├── grep.js
│   │   ├── load_skill.js
│   │   ├── lsp-tools.js
│   │   ├── model.js
│   │   ├── pager.js
│   │   ├── project_info.js
│   │   ├── question.js
│   │   ├── read.js
│   │   ├── review.js
│   │   ├── subagents.js                 # Subagent tools (modified)
│   │   └── write.js
│   │
│   ├── ui/                              # UI utilities (simplified)
│   │   ├── index.js                     # Re-exports
│   │   ├── cli.js                       # CliOutputSink
│   │   ├── colors.js                    # Color palette
│   │   ├── info.js                      # Info subcommand
│   │   ├── review.js                    # Review subcommand
│   │   └── show_prompt.js               # Show-prompt subcommand
│   │
│   └── init/                            # Config resolution
│       └── resolution.js                # buildConfig
│
├── ext/                                 # Extensions (unchanged)
│   └── lsp/                             # LSP extension
│
├── docs/
│   └── agents/
│       └── session-core-architecture.md # This document
│
├── package.json
└── ... (other project files)
```

### Key Changes from Current Layout

| Current | New | Notes |
|---------|-----|-------|
| `src/agent/message_bus.js` | `src/session/event_router.js` + `src/session/event_channel.js` | MessageBus absorbed |
| `src/agent/worker.js` | `src/session/task_orchestrator.js` | TaskWorker eliminated |
| `src/agent/session_manager.js` | `src/session/session_manager.js` | Moved |
| `src/agent/session_store.js` | `src/session/session_store.js` | Moved |
| `src/agent/message_queue.js` | `src/session/message_queue.js` | Moved |
| `src/ui/session.js` | `src/clientapps/cli.js` | CLI logic extracted |
| (none) | `src/clientapps/web.js` | New — future |
| (none) | `src/clientapps/rpc.js` | New — future |
| (none) | `src/session/events.js` | New — event types |
| (none) | `src/session/core.js` | New — SessionCore |
| (none) | `src/session/agent_sink.js` | New — AgentSink |
| (none) | `src/session/task_handle.js` | New — TaskHandle |

---

## 10. Risk Assessment

### 10.1 High-Risk Items

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Task agent lifecycle bugs** | Medium | High | Extensive integration tests. Start with Phase 3 in a feature branch. |
| **Task result injection races** | Medium | Medium | Ensure task results are always injected via `_pendingTaskMessages` (same as current). |
| **Session switch mid-run** | Low | Medium | Ensure `EventRouter` handles session switches gracefully. |

### 10.2 Medium-Risk Items

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **Breaking existing tests** | Medium | Medium | Incremental migration. Each phase must pass all tests. |
| **CLI behavior changes** | Low | Medium | Keep CLI behavior identical. Test all slash commands. |
| **MCP tool integration** | Low | Low | MCP tools are independent of the session architecture. |
| **LSP tool integration** | Low | Low | LSP tools are independent of the session architecture. |

### 10.3 Low-Risk Items

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| **File moves breaking imports** | High | Low | Use a codemod or automated import rewriter. |
| **Documentation drift** | Medium | Low | Update docs as code changes. |
| **Config compatibility** | Low | Low | Config loading is independent of session architecture. |

### 10.4 Mitigation Strategies

1. **Feature flags**: Each phase can be behind a feature flag, allowing gradual rollout.

2. **Parallel implementation**: Implement the new architecture in a feature branch alongside the existing code. The old code remains the default until the new code is proven.

3. **Comprehensive testing**: Each phase must pass all existing tests before proceeding. Add new tests for each new component.

4. **Performance monitoring**: Track LLM call latency, memory usage, and event throughput during migration to ensure no regressions.

5. **Rollback plan**: Each phase is independently revertable. If a phase introduces bugs, revert to the previous state.

### 10.5 Success Criteria

- [ ] All existing tests pass after each phase
- [ ] Task agents use `Agent` class (no `TaskWorker`)
- [ ] `MessageBus` is removed
- [ ] CLI is a thin `ClientApp` with no session logic
- [ ] Web and RPC `ClientApp` implementations work
- [ ] No behavioral changes to the Agent's LLM loop
- [ ] Task delegation, status, follow-up, and interrupt all work
- [ ] Session switching works
- [ ] Cancellation propagates correctly
- [ ] No memory leaks or deadlocks under load

---

## Appendix A: Answering Key Questions

### Q1: How does the Session Core know when a task agent should output to its parent vs. to the UI?

**Answer**: Through the `AgentSink` constructor parameter `isTaskAgent`. When `true`, the sink filters events — only `TASK_PROGRESS` is shown to the UI. All other output is captured. On completion, `onTaskComplete()` is called, which routes the result back to the parent agent's context via `TaskOrchestrator.onTaskComplete()`.

### Q2: How does the duplex queue handle event ordering?

**Answer**: The `EventChannel` buffers events in arrays (`_inputBuffer`, `_outputBuffer`). Events are consumed via async generators that yield from these buffers in FIFO order. If the consumer is slow, events accumulate in the buffer. If the producer is slow, the consumer waits on the async generator.

### Q3: How do session switches work with the new architecture?

**Answer**: The `EventRouter` handles `switch_session` commands by calling `SessionManager.switchSession()`. This updates the `_currentSessionId` and returns the new agent. Subsequent input events are routed to the new agent. Each agent has its own `AgentSink` that routes through the Session Core.

### Q4: How does cancellation propagate?

**Answer**: `SIGINT` → CLI emits `cancel` command → `EventRouter` calls `SessionCore.cancel()` → `agent.cancel()` → `agent.cancelled = true` → next LLM call throws `LlmError.Cancelled` → `agent.run()` exits → `EventRouter` catches error → restarts input loop. For task agents, `TaskOrchestrator` aborts the task's `AbortController`.

### Q5: How does the Session Core handle multiple concurrent sessions?

**Answer**: Each session has its own `Agent` in `SessionStore`. The `SessionManager` tracks `_currentSessionId`. For multi-session modes, each session gets its own `EventRouter` that checks the `sessionId` field on input events. The `AgentSink` includes `sessionId` in all output events.

### Q6: What happens to the MessageBus?

**Answer**: The `MessageBus` is absorbed into the Session Core:
- `_dispatchLoop` → `EventRouter._inputLoop()`
- `MessageQueue` → `EventChannel._inputBuffer`
- `cancel()` → `SessionCore.cancel()`
- `enqueue()` → `EventChannel.emitInput()`
- `wireTaskWakeUp()` → `TaskOrchestrator.onTaskComplete()`
- `onMessageProcessed` → `EventRouter._inputLoop()` (implicit)
- `executePromptAndEnqueue` → `EventRouter._handleCommand()`

The `MessageBus` class is removed entirely.

---

## Appendix B: Glossary

| Term | Definition |
|------|------------|
| **Agent** | The AI agent that runs the LLM loop, executes tools, manages context |
| **ClientApp** | A thin layer that translates between user interaction and the Session Core's event protocol |
| **Session Core** | The brain of the system — orchestrates sessions, agents, tasks, and event routing |
| **Duplex Queue** | A typed, ordered event channel between ClientApp and Session Core |
| **Task Agent** | An Agent instance with a different output target (Session Core internal sink) |
| **TaskOrchestrator** | Manages task lifecycle: spawn, monitor, complete, cancel |
| **EventRouter** | Routes input events to agents and output events to ClientApp |
| **AgentSink** | Bridges an Agent's output to the Session Core |
| **SessionManager** | Manages session lifecycle, agent swaps, multi-session support |
| **SessionBuilder** | Encapsulates the full agent initialization pipeline |

---

*Document end.*
