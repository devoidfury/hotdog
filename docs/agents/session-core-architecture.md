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

`TaskWorker._runInner()` (worker.js, lines ~120-200) and `Agent.run()` (agent.js, lines ~870-940) perform the same algorithm:

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
```javascript
// main.js — the callback marshals data
wakeUpCallback: (taskId, result) => {
  const escaped = builder.markerMangler().escapeMarkers(result);
  const agent = sessionManager.getAgent();
  if (agent) {
    agent._pendingTaskMessages.push(
      `<m_59gt7zdgkjzdeshe subagent="${taskId}">${escaped}</m_59gt7zdgkjzdeshe>`,
    );
  }
  sink.emit({ type: OUTPUT_EVENT.TASK_COMPLETE, taskId, status: "completed" });
}

// message_bus.js — wires it up
wireTaskWakeUp() {
  bus.wakeUpCallback = (taskId, result) => {
    bus.enqueue(`<m_... subagent="${taskId}">${result}</m_...>`);
  };
}
```

This is a callback that pushes to an agent's private `_pendingTaskMessages` array, AND emits an event, AND the MessageBus re-enqueues the marshalled string. Three separate mechanisms for one piece of data.

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
              │  backpressured, ordered) │
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
│  │  │  swaps, multi-  │  │  output→client)  │               │        │
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
- WebSocket server
- Parses JSON messages → emits `InputEvent`
- Receives `OutputEvent` → sends JSON over WebSocket
- Same event protocol as CLI

**RPC ClientApp** (Example):
- HTTP server with streaming response
- Request body → `InputEvent`
- Server-sent events (SSE) for `OutputEvent`
- Same event protocol

**Key principle**: ClientApps know nothing about sessions, agents, or tasks. They only know: "I receive input, I emit input events. I receive output events, I display them."

#### 2.2.2 Duplex Event Queue

**Responsibility**: Typed, ordered, backpressured event channel between ClientApp and Session Core.

**Design**: Async iterator + async generator pattern. See [Section 7](#7-duplex-queue-design) for details.

**Properties**:
- **Input direction**: ClientApp → Session Core (user text, commands)
- **Output direction**: Session Core → ClientApp (streaming chunks, tool calls, task events)
- **Backpressure**: If ClientApp is slow, Session Core's output is buffered. If Session Core is slow, ClientApp's input is buffered.
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

```typescript
// User sends text input
interface InputEvent {
  type: 'input';
  text: string;
  sessionId?: string;  // For multi-session support
}

// User sends a command
interface CommandEvent {
  type: 'command';
  name: string;         // e.g., 'cancel', 'switch_session', 'compact'
  args?: Record<string, unknown>;  // Command arguments
}

// Session-level commands
interface SwitchSessionEvent {
  type: 'switch_session';
  sessionId: string;
}

interface NewSessionEvent {
  type: 'new_session';
  profile?: string;
}
```

#### 3.1.2 Output Events (Session Core → ClientApp)

```typescript
// Streaming content from the agent
interface StreamingChunkEvent {
  type: 'streaming_chunk';
  content: string;
  sessionId?: string;
}

interface StreamingReasoningChunkEvent {
  type: 'streaming_reasoning_chunk';
  content: string;
  sessionId?: string;
}

// Tool interaction
interface ToolCallEvent {
  type: 'tool_call';
  toolName: string;
  input: string;
  toolCallId: string;
  sessionId?: string;
}

interface ToolResultEvent {
  type: 'tool_result';
  toolName: string;
  input: string;
  result: string;
  sessionId?: string;
}

// Task events
interface TaskProgressEvent {
  type: 'task_progress';
  taskId: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  activeTasks?: number;
  totalTasks?: number;
  sessionId?: string;
}

interface TaskCompleteEvent {
  type: 'task_complete';
  taskId: string;
  result: string;
  sessionId?: string;
}

// System events
interface CompactingEvent {
  type: 'compacting';
  messageCount: number;
  keepRecent: number;
  sessionId?: string;
}

interface CompactionResultEvent {
  type: 'compaction_result';
  summary: string | null;
  messagesCompacted: number;
  strategy: string;
  sessionId?: string;
}

interface TokenUsageEvent {
  type: 'token_usage';
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  sessionId?: string;
}

interface CommandResultEvent {
  type: 'command_result';
  content: string;
  sessionId?: string;
}

interface UserMessageEvent {
  type: 'user_message';
  content: string;
  sessionId?: string;
}

interface AssistantMessageEvent {
  type: 'assistant_message';
  content: string;
  sessionId?: string;
}

interface ThinkingEvent {
  type: 'thinking';
  content: string;
  sessionId?: string;
}

interface QuestionEvent {
  type: 'question';
  questions: Array<{
    prompt: string;
    options?: string[];
    allowOther?: boolean;
    default?: unknown;
  }>;
  sessionId?: string;
}
```

#### 3.1.3 Internal Events (Session Core Internal)

These are used within the Session Core and are NOT emitted to the ClientApp:

```typescript
// Internal: task agent output (not shown to user)
interface InternalTaskOutputEvent {
  type: '__task_output__';
  taskId: string;
  data: {
    type: 'streaming_chunk' | 'tool_call' | 'tool_result' | ...;
    content?: string;
    toolName?: string;
    result?: string;
  };
}

// Internal: task completion (routed to parent)
interface InternalTaskCompletionEvent {
  type: '__task_completion__';
  taskId: string;
  result: string;
  parentAgentId: string;
}

// Internal: task progress (shown to user)
interface InternalTaskProgressEvent {
  type: '__task_progress__';
  taskId: string;
  status: string;
}
```

### 3.2 Event Type Constants

```javascript
export const INPUT_EVENT = {
  INPUT: 'input',
  COMMAND: 'command',
  SWITCH_SESSION: 'switch_session',
  NEW_SESSION: 'new_session',
};

export const OUTPUT_EVENT = {
  STREAMING_CHUNK: 'streaming_chunk',
  STREAMING_REASONING_CHUNK: 'streaming_reasoning_chunk',
  TOOL_CALL: 'tool_call',
  TOOL_RESULT: 'tool_result',
  TASK_PROGRESS: 'task_progress',
  TASK_COMPLETE: 'task_complete',
  COMPACTING: 'compacting',
  COMPACTION_RESULT: 'compaction_result',
  TOKEN_USAGE: 'token_usage',
  COMMAND_RESULT: 'command_result',
  USER_MESSAGE: 'user_message',
  ASSISTANT_MESSAGE: 'assistant_message',
  THINKING: 'thinking',
  QUESTION: 'question',
};
```

### 3.3 Event Creation Helpers

```javascript
export function createInputEvent(text, sessionId) {
  return { type: INPUT_EVENT.INPUT, text, sessionId };
}

export function createCommandEvent(name, args) {
  return { type: INPUT_EVENT.COMMAND, name, args };
}

export function createStreamingChunkEvent(content, sessionId) {
  return { type: OUTPUT_EVENT.STREAMING_CHUNK, content, sessionId };
}

export function createToolCallEvent(toolName, input, toolCallId, sessionId) {
  return { type: OUTPUT_EVENT.TOOL_CALL, toolName, input, toolCallId, sessionId };
}

// ... etc.
```

---

## 4. Session Core Design

### 4.1 SessionCore Class

```javascript
// src/session/core.js

export class SessionCore {
  constructor(options) {
    this._sessionManager = options.sessionManager;  // SessionManager instance
    this._builder = options.builder;                 // SessionBuilder instance
    this._duplexQueue = options.duplexQueue;         // EventChannel instance
    this._taskOrchestrator = new TaskOrchestrator(this);
    this._internalSink = new InternalSink(this);     // For task agents
    this._eventRouter = new EventRouter(this);
    this._running = false;
    this._cancelled = false;
  }

  /**
   * Start the session core. Begins listening for input events.
   */
  async start() {
    this._running = true;
    await this._eventRouter.start();
  }

  /**
   * Stop the session core. Drains remaining events.
   */
  async stop() {
    this._running = false;
    this._cancelled = true;
    await this._eventRouter.stop();
  }

  /**
   * Get the current agent.
   */
  getAgent() {
    return this._sessionManager.getAgent();
  }

  /**
   * Get the current session ID.
   */
  sessionId() {
    return this._sessionManager.sessionId();
  }

  /**
   * Spawn a task agent. Called by Agent.delegate_task().
   * Returns a TaskHandle for controlling the task.
   */
  async spawnTask(taskId, taskDescription, options = {}) {
    return this._taskOrchestrator.spawn(taskId, taskDescription, options);
  }

  /**
   * Interrupt a running task.
   */
  interruptTask(taskId) {
    return this._taskOrchestrator.interrupt(taskId);
  }

  /**
   * Send a follow-up to a running task.
   */
  sendTaskFollowUp(taskId, message) {
    return this._taskOrchestrator.followUp(taskId, message);
  }

  /**
   * Get active task IDs.
   */
  activeTasks() {
    return this._taskOrchestrator.activeTasks();
  }

  /**
   * Route an input event to the current agent.
   */
  async routeInput(inputEvent) {
    await this._eventRouter.routeInput(inputEvent);
  }

  /**
   * Route an output event to the ClientApp.
   */
  async routeOutput(outputEvent) {
    await this._duplexQueue.emitOutput(outputEvent);
  }

  /**
   * Cancel the current run.
   */
  cancel() {
    this._cancelled = true;
    const agent = this.getAgent();
    if (agent) agent.cancel();
  }
}
```

### 4.2 EventRouter

```javascript
// src/session/event_router.js

export class EventRouter {
  constructor(sessionCore) {
    this._core = sessionCore;
    this._duplexQueue = sessionCore._duplexQueue;
    this._sessionManager = sessionCore._sessionManager;
  }

  /**
   * Start the event router. Begins processing input events.
   */
  async start() {
    // Listen for input events from the duplex queue
    this._inputLoop();
  }

  /**
   * Stop the event router.
   */
  async stop() {
    this._cancelled = true;
  }

  /**
   * Process input events from the duplex queue.
   */
  async _inputLoop() {
    for await (const event of this._duplexQueue.inputEvents()) {
      if (this._cancelled) break;

      switch (event.type) {
        case INPUT_EVENT.INPUT:
          await this._handleInput(event);
          break;
        case INPUT_EVENT.COMMAND:
          await this._handleCommand(event);
          break;
        case INPUT_EVENT.SWITCH_SESSION:
          await this._handleSwitchSession(event);
          break;
        case INPUT_EVENT.NEW_SESSION:
          await this._handleNewSession(event);
          break;
      }
    }
  }

  /**
   * Handle a text input event.
   */
  async _handleInput(event) {
    const agent = this._sessionManager.getAgent();
    if (!agent) return;

    // Emit user message event to ClientApp
    await this._core.routeOutput({
      type: OUTPUT_EVENT.USER_MESSAGE,
      content: event.text,
      sessionId: event.sessionId,
    });

    // Run the agent with the input
    await agent.run(event.text);
  }

  /**
   * Handle a command event.
   */
  async _handleCommand(event) {
    const agent = this._sessionManager.getAgent();
    if (!agent) return;

    switch (event.name) {
      case 'cancel':
        this._core.cancel();
        break;
      case 'compact':
        await this._handleCompact(event.args);
        break;
      case 'clear':
        agent.context.clear();
        agent.context.systemMessages = [];
        agent.sessionLog.writeReset();
        await this._core.routeOutput({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: 'Context cleared.',
        });
        break;
      case 'model':
        if (event.args?.name) {
          agent.model = event.args.name;
          agent.context.clear();
          agent.context.systemMessages = [];
          await this._core.routeOutput({
            type: OUTPUT_EVENT.COMMAND_RESULT,
            content: `Switched to model: ${event.args.name}`,
          });
        }
        break;
      // ... other commands
      default:
        await this._core.routeOutput({
          type: OUTPUT_EVENT.COMMAND_RESULT,
          content: `Unknown command: ${event.name}`,
        });
    }
  }

  /**
   * Handle a session switch event.
   */
  async _handleSwitchSession(event) {
    const agent = this._sessionManager.switchSession(event.sessionId);
    if (agent) {
      await this._core.routeOutput({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: `Switched to session: ${event.sessionId}`,
      });
    }
  }

  /**
   * Handle a new session event.
   */
  async _handleNewSession(event) {
    const sink = this._createAgentSink();
    const sessionId = await this._sessionManager.newSession(sink);
    await this._core.routeOutput({
      type: OUTPUT_EVENT.COMMAND_RESULT,
      content: `New session created: ${sessionId}`,
    });
  }

  /**
   * Create an output sink for a new agent.
   * This sink routes events to the Session Core for further processing.
   */
  _createAgentSink() {
    return new AgentSink(this._core);
  }
}
```

### 4.3 AgentSink (bridges Agent → Session Core)

```javascript
// src/session/agent_sink.js

/**
 * Output sink that routes agent events to the Session Core.
 * This is the sink assigned to every agent (normal and task agents).
 * For normal agents, events are forwarded to the ClientApp.
 * For task agents, events are captured for result collection.
 */
export class AgentSink extends OutputSink {
  constructor(sessionCore, isTaskAgent = false) {
    super();
    this._core = sessionCore;
    this._isTaskAgent = isTaskAgent;
    this._taskAgentId = null;
    this._taskResult = null;
  }

  /**
   * Set the task agent ID (for task agents).
   */
  setTaskAgentId(taskId) {
    this._taskAgentId = taskId;
  }

  /**
   * Emit an event — routes based on agent type.
   */
  emit(event) {
    if (this._isTaskAgent) {
      this._emitTaskAgentEvent(event);
    } else {
      this._emitNormalAgentEvent(event);
    }
  }

  /**
   * Route events from a normal agent to the ClientApp.
   */
  _emitNormalAgentEvent(event) {
    this._core.routeOutput(event);
  }

  /**
   * Route events from a task agent internally.
   * Progress events are shown to the user.
   * Completion events are captured for result routing.
   */
  _emitTaskAgentEvent(event) {
    switch (event.type) {
      case OUTPUT_EVENT.TASK_PROGRESS:
        // Show task progress to the user
        this._core.routeOutput({
          type: OUTPUT_EVENT.TASK_PROGRESS,
          taskId: this._taskAgentId,
          status: 'running',
        });
        break;
      case OUTPUT_EVENT.STREAMING_CHUNK:
        // Task agents don't stream to the user
        break;
      case OUTPUT_EVENT.TOOL_CALL:
        // Task agents don't show tool calls to the user
        break;
      case OUTPUT_EVENT.TOOL_RESULT:
        // Task agents don't show tool results to the user
        break;
      // ... other task agent events are captured, not emitted
    }
  }

  /**
   * Called when the task agent completes.
   * The Session Core's TaskOrchestrator calls this to deliver the result.
   */
  onTaskComplete(result) {
    this._taskResult = result;
    this._core._taskOrchestrator.onTaskComplete(
      this._taskAgentId,
      result,
    );
  }
}
```

### 4.4 TaskOrchestrator

```javascript
// src/session/task_orchestrator.js

export class TaskOrchestrator {
  constructor(sessionCore) {
    this._core = sessionCore;
    this._tasks = new Map();  // taskId → TaskInfo
    this._builder = sessionCore._builder;
    this._sessionManager = sessionCore._sessionManager;
  }

  /**
   * Spawn a new task agent.
   * Called by Agent.delegate_task().
   */
  async spawn(taskId, taskDescription, options = {}) {
    // Create a task agent sink (internal, non-streaming)
    const taskSink = new AgentSink(this._core, true);
    taskSink.setTaskAgentId(taskId);

    // Build the task agent with the SessionBuilder
    const taskAgent = await this._builder.buildAgent(taskSink);

    // Configure task-specific settings
    const profileName = options.profile || 'task-default';
    const profile = getProfile(this._builder.config(), profileName);
    taskAgent.role = profile.role || 'A focused worker agent';
    taskAgent.profileBody = profile.body || '';
    taskAgent.profileName = profileName;
    taskAgent.systemPrompt = profile.systemPrompt || null;

    // Store task info
    const taskInfo = {
      taskId,
      taskDescription,
      agent: taskAgent,
      sink: taskSink,
      status: 'running',
      abortController: new AbortController(),
    };
    this._tasks.set(taskId, taskInfo);

    // Start the task agent in the background
    this._runTask(taskId, taskDescription, taskInfo);

    // Return a TaskHandle
    return new TaskHandle(taskId, this);
  }

  /**
   * Run a task agent in the background.
   */
  async _runTask(taskId, description, taskInfo) {
    try {
      // Run the task agent
      const result = await taskInfo.agent.run(description);
      taskInfo.status = 'completed';
      this.onTaskComplete(taskId, result);
    } catch (err) {
      if (err instanceof LlmError.Cancelled || taskInfo.abortController.signal.aborted) {
        taskInfo.status = 'cancelled';
        this.onTaskComplete(taskId, `Task ${taskId} cancelled`);
      } else {
        taskInfo.status = 'failed';
        this.onTaskComplete(taskId, `Task ${taskId} failed: ${err.message}`);
      }
    }
  }

  /**
   * Called when a task agent completes.
   * Routes the result back to the parent agent.
   */
  onTaskComplete(taskId, result) {
    const taskInfo = this._tasks.get(taskId);
    if (!taskInfo) return;

    // Get the parent agent
    const parentAgent = this._sessionManager.getAgent();
    if (!parentAgent) return;

    // Get the marker mangler
    const mangler = this._builder.markerMangler();
    const escaped = mangler.escapeMarkers(result);

    // Format as a system message (same as current behavior)
    const systemMessage = `<m_59gt7zdgkjzdeshe subagent="${taskId}">${escaped}</m_59gt7zdgkjzdeshe>`;

    // Inject into parent agent's context
    parentAgent.context.addSystemMessage(systemMessage);
    parentAgent.sessionLog.writeSystemPrompt(systemMessage);

    // Add to parent's pending task messages (for drainPendingTaskMessages)
    parentAgent._pendingTaskMessages.push(systemMessage);

    // Emit task complete event to ClientApp
    this._core.routeOutput({
      type: OUTPUT_EVENT.TASK_COMPLETE,
      taskId,
      result,
    });

    // Emit task progress event
    this._core.routeOutput({
      type: OUTPUT_EVENT.TASK_PROGRESS,
      taskId,
      status: 'completed',
      activeTasks: this.activeTasks().length,
    });

    // Update task info
    taskInfo.status = 'completed';
  }

  /**
   * Interrupt a running task.
   */
  interrupt(taskId) {
    const taskInfo = this._tasks.get(taskId);
    if (!taskInfo || taskInfo.status !== 'running') return false;
    taskInfo.abortController.abort();
    return true;
  }

  /**
   * Send a follow-up to a running task.
   * Note: With the new architecture, follow-ups are handled by
   * adding the message to the task agent's context directly.
   */
  followUp(taskId, message) {
    const taskInfo = this._tasks.get(taskId);
    if (!taskInfo || taskInfo.status !== 'running') return false;

    // Add the follow-up to the task agent's context
    // The task agent will pick it up on its next iteration
    taskInfo.agent.context.addUserMessage(message);

    // Wake up the task agent if it's waiting
    // (In the current design, task agents don't have a separate wake mechanism
    //  — they run in a loop. Follow-ups would need to be queued and drained
    //  before each LLM call, similar to TaskWorker._followQueue)
    // For now, we add it to the context and the agent will process it
    // on its next LLM call iteration.
    return true;
  }

  /**
   * Get active (running) task IDs.
   */
  activeTasks() {
    const active = [];
    for (const [id, info] of this._tasks) {
      if (info.status === 'running') active.push(id);
    }
    return active;
  }

  /**
   * Get task count.
   */
  taskCounts() {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return [active, this._tasks.size];
  }
}
```

### 4.5 TaskHandle

```javascript
// src/session/task_handle.js

export class TaskHandle {
  constructor(taskId, orchestrator) {
    this.taskId = taskId;
    this._orchestrator = orchestrator;
  }

  /**
   * Interrupt (cancel) the task.
   */
  interrupt() {
    return this._orchestrator.interrupt(this.taskId);
  }

  /**
   * Send a follow-up message.
   */
  sendFollowUp(message) {
    return this._orchestrator.followUp(this.taskId, message);
  }

  /**
   * Check task status.
   */
  get status() {
    const taskInfo = this._orchestrator._tasks.get(this.taskId);
    return taskInfo ? taskInfo.status : null;
  }
}
```

### 4.6 How Task Agents Route Output to Parent

**Answer to Question 1**: How does the Session Core know when a task agent should output to its parent vs. to the UI?

The distinction is made by the **sink type**:

1. **Normal agent**: Gets an `AgentSink` with `_isTaskAgent = false`. This sink's `emit()` method routes all events directly to the ClientApp via `routeOutput()`.

2. **Task agent**: Gets an `AgentSink` with `_isTaskAgent = true` and `setTaskAgentId(taskId)`. This sink's `emit()` method:
   - Filters out streaming chunks, tool calls, tool results (task agents are silent to the UI)
   - Captures `TASK_PROGRESS` events to show to the UI
   - On task completion, calls `onTaskComplete()` which routes the result back to the parent

The Session Core creates the sink when spawning the task agent:
```javascript
const taskSink = new AgentSink(this._core, true);  // isTaskAgent = true
taskSink.setTaskAgentId(taskId);
const taskAgent = await this._builder.buildAgent(taskSink);
```

### 4.7 How Session Switches Work

**Answer to Question 3**: How do session switches work with the new architecture?

1. User types `/clear:profile-name` in CLI
2. CLI emits `CommandEvent { name: 'clear', args: { profile: 'profile-name' } }`
3. Session Core's `EventRouter._handleCommand()` processes it
4. It calls `SessionManager.swapAgent()` which:
   - Builds a new agent with the new profile
   - Replaces the current agent in the `SessionStore`
   - Returns the new agent
5. The new agent has a new `AgentSink` that routes to the Session Core
6. Subsequent input events are routed to the new agent

For multi-session support:
1. User types `/session:new` → `NewSessionEvent`
2. Session Core creates a new agent with a new `AgentSink`
3. The new agent is stored in `SessionStore` under a new session ID
4. User types `/session:switch <id>` → `SwitchSessionEvent`
5. Session Core switches `SessionManager._currentSessionId`
6. Subsequent events go to the switched agent

### 4.8 How Cancellation Propagates

**Answer to Question 4**: How does cancellation propagate?

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

For task agents:
- `SessionCore.cancel()` sets `this._cancelled = true`
- `TaskOrchestrator` checks this flag in `_runTask()`
- If cancelled, aborts the task's `AbortController`
- Task agent's LLM call throws `LlmError.Cancelled`
- Task status is set to 'cancelled'
- Result is routed back to parent

### 4.9 How Multiple Sessions Are Handled

**Answer to Question 5**: How does the Session Core handle multiple concurrent sessions?

Each session has:
1. Its own `Agent` instance (stored in `SessionStore`)
2. Its own `AgentSink` (for routing output)
3. Its own `SessionId`

The `SessionManager` tracks the `_currentSessionId`. When the user switches sessions, the `_currentSessionId` is updated and subsequent events are routed to the new agent.

For multi-session modes (like ACP), each session gets its own `EventRouter` instance that listens on the duplex queue's input side. The `EventRouter` checks the `sessionId` field on input events to route to the correct agent.

### 4.10 What Happens to the MessageBus

**Answer to Question 6**: What happens to the MessageBus?

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

The `MessageBus` class is **removed entirely**. Its functionality is distributed across:
- `EventRouter` — the dispatch loop
- `EventChannel` — the message queue
- `SessionCore` — cancellation, command handling
- `TaskOrchestrator` — task wake-up routing

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

```javascript
// In agent.js, add:

/**
 * Delegate a task to the Session Core's task orchestrator.
 * Returns a TaskHandle for controlling the task.
 */
delegate_task(taskId, description, options = {}) {
  if (!this._sessionCore) {
    throw new Error('SessionCore not configured — cannot delegate tasks');
  }
  return this._sessionCore.spawnTask(taskId, description, options);
}

/**
 * Set the SessionCore reference for task delegation.
 */
setSessionCore(sessionCore) {
  this._sessionCore = sessionCore;
}
```

### 5.3 Constructor Changes

```javascript
// In Agent constructor, add:
this._sessionCore = config.sessionCore || null;
this._taskManager = config.taskManager || null;  // deprecated, for backward compat
```

### 5.4 waitForTasksAndDrain() Simplification

The current `waitForTasksAndDrain()` polls `this.taskManager.activeTasks()`. In the new architecture, it should call the Session Core:

```javascript
async waitForTasksAndDrain() {
  if (this._sessionCore) {
    let drained = false;
    if (this.drainPendingTaskMessages()) drained = true;

    const activeTasks = this._sessionCore.activeTasks();
    if (activeTasks.length === 0) return drained;

    let iterations = 0;
    const maxWaitIterations = 120;

    while (activeTasks.length > 0 && iterations < maxWaitIterations) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const remaining = this._sessionCore.activeTasks();
      if (this.drainPendingTaskMessages()) drained = true;
      if (remaining.length === 0) break;
      iterations++;
    }

    if (this.drainPendingTaskMessages()) drained = true;
    return drained;
  }

  // Fallback for backward compatibility
  if (!this.taskManager) return this.drainPendingTaskMessages();
  // ... existing logic ...
}
```

### 5.5 Tool Registry Changes

The `buildToolRegistry()` method currently creates subagent tools when `managerToolsEnabled` is true. In the new architecture:

```javascript
async buildToolRegistry(whitelist = null, blacklist = null, managerToolsEnabled = false) {
  // ... existing core tool creation ...

  // Subagent tools (manager-only)
  if (managerToolsEnabled && this._sessionCore) {
    // Create subagent tools that delegate to SessionCore
    const subagentNames = SUBAGENT_TOOL_NAMES.filter(/* ... */);
    for (const name of subagentNames) {
      const tool = await factory.createTool(
        name,
        ctx,
        whitelist,
        managerToolsEnabled,
        this._sessionCore,  // Pass SessionCore reference
      );
      if (tool) registry.register(name, tool);
    }
  }

  // ... existing MCP and LSP tool creation ...
}
```

The subagent tools (`DelegateTaskTool`, `TaskStatusTool`, etc.) will receive the `SessionCore` reference and delegate to it instead of `TaskManager`.

---

## 6. ClientApp Interface

### 6.1 CLI ClientApp

```javascript
// src/clientapps/cli.js

import { createInterface } from 'node:readline';
import { EventChannel } from '../session/event_channel.js';
import { SessionCore } from '../session/core.js';
import { parseCommand, isUiCommand, Command } from '../agent/commands.js';

/**
 * CLI ClientApp — reads from readline, emits events to Session Core.
 */
export class CliClientApp {
  constructor(options) {
    this._sessionCore = options.sessionCore;
    this._eventChannel = options.eventChannel;
    this._rl = null;
    this._promptFn = null;
  }

  /**
   * Start the CLI client. Creates readline interface and begins listening.
   */
  async start() {
    this._rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '(agent)> ',
    });

    this._rl.prompt();

    // Handle SIGINT
    process.on('SIGINT', () => {
      console.log('\nInterrupted. Cancelling...');
      this._eventChannel.emitInput({
        type: 'command',
        name: 'cancel',
      });
      console.log('Cancelled.');
      this._rl.prompt();
    });

    // Handle input lines
    this._rl.on('line', (line) => {
      const trimmed = line.trim();

      if (trimmed.startsWith('/')) {
        this._handleSlashCommand(trimmed.slice(1).trim().toLowerCase());
        return;
      }

      if (!trimmed) {
        this._rl.prompt();
        return;
      }

      // Emit input event
      this._eventChannel.emitInput({
        type: 'input',
        text: trimmed,
      });
    });

    // Handle close
    this._rl.on('close', () => {
      console.log('\nGoodbye!');
      process.exit(0);
    });

    // Start listening for output events
    this._listenForOutput();
  }

  /**
   * Listen for output events from the Session Core and render them.
   */
  async _listenForOutput() {
    for await (const event of this._eventChannel.outputEvents()) {
      this._renderEvent(event);
      // Prompt after each event batch
      this._rl.prompt();
    }
  }

  /**
   * Render an output event to the terminal.
   */
  _renderEvent(event) {
    switch (event.type) {
      case 'streaming_chunk':
        process.stdout.write(event.content);
        break;
      case 'streaming_reasoning_chunk':
        process.stderr.write(event.content);
        break;
      case 'tool_call':
        console.log(`\n[Tool: ${event.toolName}]\n`);
        break;
      case 'tool_result':
        if (!this._hideTools) {
          console.log(`\n${event.result}\n\n`);
        }
        break;
      case 'task_progress':
        console.log(`\n[${event.activeTasks || 0} task(s) running]\n`);
        break;
      case 'task_complete':
        console.log(`\n[Task ${event.taskId} completed]\n`);
        break;
      case 'command_result':
        console.log(`\n${event.content}\n`);
        break;
      case 'user_message':
        console.log(`\n${event.content}\n\n`);
        break;
      case 'token_usage':
        console.log(`\n(tokens cached:${event.cachedTokens} prompt:${event.promptTokens} completion:${event.completionTokens} total:${event.totalTokens})\n`);
        break;
      // ... other event types
    }
  }

  /**
   * Handle slash commands.
   */
  _handleSlashCommand(cmd) {
    const parsed = parseCommand(cmd);

    if (isUiCommand(parsed.type)) {
      this._handleUiCommand(parsed);
      return;
    }

    // Delegate agent commands to Session Core
    this._eventChannel.emitInput({
      type: 'command',
      name: parsed.type,
      args: parsed.value,
    });
  }

  /**
   * Handle UI-level commands (not delegated to agent).
   */
  _handleUiCommand(cmd) {
    switch (cmd.type) {
      case Command.Help:
        console.log(HELP_TEXT);
        break;
      case Command.Quit:
        this._rl.close();
        process.exit(0);
        break;
      case Command.Tools:
        this._hideTools = !this._hideTools;
        console.log(`Tool display: ${this._hideTools ? 'hidden' : 'shown'}\n`);
        break;
      case Command.Thinking:
        this._hideThinking = !this._hideThinking;
        console.log(`Thinking display: ${this._hideThinking ? 'hidden' : 'shown'}\n`);
        break;
      case Command.Shell:
        this._handleShell(cmd.value);
        break;
    }
    this._rl.prompt();
  }

  /**
   * Handle shell command.
   */
  _handleShell(command) {
    if (!command) {
      console.log('Usage: /sh <command>\n');
      return;
    }
    console.log(`\n$ ${command}\n`);
    // ... spawn child process, display output, prompt
  }

  /**
   * Stop the CLI client.
   */
  async stop() {
    if (this._rl) {
      this._rl.close();
    }
  }
}
```

### 6.2 Web ClientApp (Bun-native WebSocket)

Uses Bun's built-in `Bun.serve()` with the `websocket` handler — **no external dependency**.

Bun's WebSocket server uses a handler-object pattern (handlers declared once per server, not per socket) for performance. It supports per-socket contextual data via `ws.data`, pub/sub topics, per-message compression, idle timeouts, and backpressure reporting.

```javascript
// src/clientapps/web.js

import { EventChannel } from '../session/event_channel.js';

/**
 * WebSocket client session — tracks per-client output routing.
 */
class WebSocketClient {
  constructor(ws) {
    this.ws = ws;
    this._outputQueue = [];        // buffered output events
    this._drainTimer = null;
  }

  /**
   * Send an event to this client, respecting backpressure.
   * Bun's ServerWebSocket.send() returns:
   *   -1  → backpressure (enqueued, socket is full)
   *    0  → dropped (connection issue)
   *  1+  → bytes sent
   */
  send(event) {
    const data = JSON.stringify(event);
    const result = this.ws.send(data);
    if (result === -1) {
      // Backpressure: buffer the event and retry when drain fires
      this._outputQueue.push(event);
      this._scheduleDrain();
    }
    return result;
  }

  /**
   * Schedule a drain of buffered events when the socket is ready.
   */
  _scheduleDrain() {
    if (this._drainTimer) return;
    this._drainTimer = setTimeout(() => {
      this._drainTimer = null;
      this._drainQueue();
    }, 0);
  }

  /**
   * Drain buffered events to the socket.
   */
  _drainQueue() {
    while (this._outputQueue.length > 0) {
      const event = this._outputQueue.shift();
      const result = this.ws.send(JSON.stringify(event));
      if (result === -1) {
        // Still backpressure — put it back and wait for drain event
        this._outputQueue.unshift(event);
        break;
      }
    }
  }

  /**
   * Called when the socket's drain() handler fires — try draining again.
   */
  onDrain() {
    this._drainQueue();
  }

  /**
   * Send all remaining buffered events (on close).
   */
  drainAll() {
    while (this._outputQueue.length > 0) {
      const event = this._outputQueue.shift();
      try {
        this.ws.send(JSON.stringify(event));
      } catch {
        break; // socket is gone
      }
    }
  }
}

/**
 * Web ClientApp — Bun-native WebSocket server for web-based interaction.
 *
 * Uses Bun.serve() with the websocket handler. No external WebSocket
 * dependency (ws, uWebSockets.js, etc.).
 *
 * Configuration:
 *   - idleTimeout: 120s default (configurable)
 *   - maxPayloadLength: 16 MB default (configurable)
 *   - perMessageDeflate: optional compression
 *   - backpressureLimit: 1 MB default (configurable)
 */
export class WebClientApp {
  constructor(options) {
    this._sessionCore = options.sessionCore;
    this._eventChannel = options.eventChannel;
    this._port = options.port || 8080;
    this._idleTimeout = options.idleTimeout ?? 120;
    this._maxPayloadLength = options.maxPayloadLength ?? 16 * 1024 * 1024;
    this._backpressureLimit = options.backpressureLimit ?? 1024 * 1024;
    this._perMessageDeflate = options.perMessageDeflate ?? false;
    this._server = null;
    this._clients = new Map();  // ws → WebSocketClient
  }

  /**
   * Start the WebSocket server. Uses Bun.serve() which handles
   * HTTP requests and WebSocket upgrades in a single process.
   */
  async start() {
    const self = this;

    this._server = Bun.serve({
      port: this._port,

      /**
       * HTTP handler — upgrades WebSocket connections.
       * Any request that is NOT a WebSocket upgrade gets a regular Response.
       */
      fetch(req, server) {
        if (server.upgrade(req)) {
          return; // upgrade succeeded — do not return a Response
        }
        // Non-WebSocket request: return a simple HTTP response
        // (e.g., a health check, static file, or API endpoint)
        return new Response('oa-js WebSocket server', {
          headers: { 'Content-Type': 'text/plain' },
        });
      },

      websocket: {
        // Type annotation for ws.data (used for per-client tracking)
        data: {} as { clientId: string },

        /**
         * Called when a new WebSocket connection is established.
         * We attach a WebSocketClient wrapper for per-client output routing.
         */
        open(ws) {
          const clientId = `client-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
          ws.data = { clientId };
          self._clients.set(ws, new WebSocketClient(ws));
          console.log(`[ws] ${clientId} connected`);

          // Start sending output events to this client
          self._sendOutputToClient(ws);
        },

        /**
         * Called when a message is received from the client.
         * Parses JSON → emits an input event to the Session Core.
         */
        message(ws, message) {
          const client = self._clients.get(ws);
          if (!client) return;

          try {
            const event = JSON.parse(String(message));
            self._eventChannel.emitInput(event);
          } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
          }
        },

        /**
         * Called when the socket is ready to receive more data after
         * backpressure was applied. Drain any buffered events.
         */
        drain(ws) {
          const client = self._clients.get(ws);
          if (client) client.onDrain();
        },

        /**
         * Called when the connection closes (graceful or error).
         * Cleans up the per-client state.
         */
        close(ws, code, reason) {
          const client = self._clients.get(ws);
          if (client) {
            const clientId = ws.data?.clientId ?? 'unknown';
            client.drainAll(); // flush remaining buffered events
            self._clients.delete(ws);
            console.log(`[ws] ${clientId} closed (code=${code})`);
          }
        },

        /**
         * Called when an error occurs on the socket.
         */
        error(ws, error) {
          const clientId = ws.data?.clientId ?? 'unknown';
          console.error(`[ws] ${clientId} error: ${error.message}`);
        },
      },
    });

    console.log(`Web client listening on ws://${this._server.hostname}:${this._server.port}`);
  }

  /**
   * Send output events from the Session Core to a specific WebSocket client.
   * Runs as a background loop per connected client.
   */
  _sendOutputToClient(ws) {
    const client = this._clients.get(ws);
    if (!client) return;

    (async () => {
      for await (const event of this._eventChannel.outputEvents()) {
        client.send(event);
      }
    })();
  }

  /**
   * Stop the WebSocket server. Closes all connections.
   */
  async stop() {
    if (this._server) {
      // Close all active WebSocket connections
      for (const [ws, client] of this._clients) {
        client.drainAll();
        try { ws.close(); } catch {}
      }
      this._clients.clear();
      this._server.stop();
      this._server = null;
    }
  }
}
```

### 6.3 RPC ClientApp (Future)

```javascript
// src/clientapps/rpc.js

import http from 'node:http';
import { EventChannel } from '../session/event_channel.js';

/**
 * RPC ClientApp — HTTP server with SSE for streaming output.
 */
export class RpcClientApp {
  constructor(options) {
    this._sessionCore = options.sessionCore;
    this._eventChannel = options.eventChannel;
    this._server = null;
    this._port = options.port || 3000;
  }

  async start() {
    this._server = http.createServer(async (req, res) => {
      if (req.method === 'POST' && req.url === '/input') {
        // Handle input: read body, emit event
        let body = '';
        for await (const chunk of req) body += chunk;
        const event = JSON.parse(body);
        this._eventChannel.emitInput(event);
        res.writeHead(200);
        res.end('OK');
      } else if (req.method === 'GET' && req.url === '/output') {
        // Handle output: stream events via SSE
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        // Send events to this SSE client
        for await (const event of this._eventChannel.outputEvents()) {
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        }
      } else {
        res.writeHead(404);
        res.end('Not Found');
      }
    });

    this._server.listen(this._port, () => {
      console.log(`RPC client listening on port ${this._port}`);
    });
  }

  async stop() {
    if (this._server) {
      this._server.close();
    }
  }
}
```

---

## 7. Duplex Queue Design

### 7.1 EventChannel Class

```javascript
// src/session/event_channel.js

/**
 * A typed, backpressured, ordered event channel.
 *
 * Provides two directions:
 * - Input: ClientApp → SessionCore (emitInput, iterate inputEvents)
 * - Output: SessionCore → ClientApp (emitOutput, iterate outputEvents)
 *
 * Both directions are independent async iterators with backpressure.
 */
export class EventChannel {
  constructor(options = {}) {
    this._inputBuffer = [];
    this._outputBuffer = [];
    this._inputMax = options.inputMax || 100;
    this._outputMax = options.outputMax || 1000;
    this._inputWaiting = [];
    this._outputWaiting = [];
    this._closed = false;
  }

  /**
   * Emit an input event. Blocks if the buffer is full (backpressure).
   */
  async emitInput(event) {
    if (this._closed) return;

    // If there are waiting consumers, deliver immediately
    if (this._inputWaiting.length > 0) {
      const resolve = this._inputWaiting.shift();
      resolve(event);
      return;
    }

    // Otherwise, buffer it
    if (this._inputBuffer.length >= this._inputMax) {
      // Backpressure: wait for a consumer to drain
      await new Promise((resolve) => {
        this._inputWaiting.push(resolve);
      });
    }

    this._inputBuffer.push(event);
  }

  /**
   * Iterate over input events. Returns an async generator.
   */
  async *inputEvents() {
    while (!this._closed) {
      if (this._inputBuffer.length > 0) {
        yield this._inputBuffer.shift();
      } else if (this._inputWaiting.length > 0) {
        // A producer is waiting — resolve it first
        const resolve = this._inputWaiting.shift();
        // Create a promise that resolves when an event arrives
        const event = await new Promise((r) => {
          this._inputWaiting.push(r);
        });
        yield event;
      } else {
        // No events and no waiting producers — wait
        const event = await new Promise((resolve) => {
          this._inputWaiting.push(resolve);
        });
        yield event;
      }
    }
  }

  /**
   * Emit an output event. Blocks if the buffer is full (backpressure).
   */
  async emitOutput(event) {
    if (this._closed) return;

    if (this._outputWaiting.length > 0) {
      const resolve = this._outputWaiting.shift();
      resolve(event);
      return;
    }

    if (this._outputBuffer.length >= this._outputMax) {
      await new Promise((resolve) => {
        this._outputWaiting.push(resolve);
      });
    }

    this._outputBuffer.push(event);
  }

  /**
   * Iterate over output events. Returns an async generator.
   */
  async *outputEvents() {
    while (!this._closed) {
      if (this._outputBuffer.length > 0) {
        yield this._outputBuffer.shift();
      } else if (this._outputWaiting.length > 0) {
        const resolve = this._outputWaiting.shift();
        const event = await new Promise((r) => {
          this._outputWaiting.push(r);
        });
        yield event;
      } else {
        const event = await new Promise((resolve) => {
          this._outputWaiting.push(resolve);
        });
        yield event;
      }
    }
  }

  /**
   * Close the channel. Drains remaining events.
   */
  close() {
    this._closed = true;
    // Resolve all waiting producers with null to signal closure
    for (const resolve of this._inputWaiting) resolve(null);
    for (const resolve of this._outputWaiting) resolve(null);
    this._inputWaiting.length = 0;
    this._outputWaiting.length = 0;
  }

  /**
   * Check if the channel is closed.
   */
  get isClosed() {
    return this._closed;
  }
}
```

### 7.2 Backpressure Strategy

**Answer to Question 2**: How does the duplex queue handle backpressure when the UI is slow?

The `EventChannel` implements backpressure through **buffer limits + waiting resolution**:

1. **Output direction** (Session Core → ClientApp):
   - If the ClientApp (UI) is slow to consume output events, the `_outputBuffer` fills up.
   - When `_outputBuffer.length >= _outputMax`, `emitOutput()` blocks.
   - The Session Core's event emission is paused until the UI catches up.
   - This prevents memory exhaustion from unbounded buffering.

2. **Input direction** (ClientApp → Session Core):
   - If the Session Core is slow to process input events, the `_inputBuffer` fills up.
   - When `_inputBuffer.length >= _inputMax`, `emitInput()` blocks.
   - The CLI's readline handler is paused until the Session Core catches up.
   - This prevents the terminal from queuing up hundreds of user inputs.

**Buffer sizes**:
- `_inputMax`: 100 (reasonable for user input — if user types 100 lines without processing, something is wrong)
- `_outputMax`: 1000 (generous for output — allows some buffering for smooth rendering)

### 7.3 Event Ordering

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

**Files created**:
- `src/session/event_channel.js`
- `src/session/events.js`
- `src/session/event_channel.test.js`

**Files modified**: None

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

**Files created**:
- `src/session/core.js`
- `src/session/event_router.js`
- `src/session/agent_sink.js`
- `src/session/task_orchestrator.js`
- `src/session/task_handle.js`

**Files moved**:
- `src/agent/session_manager.js` → `src/session/session_manager.js`
- `src/agent/session_store.js` → `src/session/session_store.js`
- `src/agent/message_queue.js` → `src/session/message_queue.js`

**Files modified**:
- `src/agent/index.js` (update re-exports)
- `src/main.js` (update imports)
- All files that import from `src/agent/session_manager.js`, etc.

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

**Files modified**:
- `src/agent/agent.js` (add methods)
- `src/agent/session_builder.js` (inject AgentSink)
- `src/tools/subagents.js` (accept SessionCore reference)

**Risk**: Low — additive changes with backward compatibility.

### Phase 3: Eliminate TaskWorker (Breaking — but incremental)

**Goal**: Replace TaskWorker with Agent instances managed by TaskOrchestrator.

**Steps**:
1. Modify `TaskOrchestrator` to use `Agent` class instead of `TaskWorker`
2. Task agents are now `Agent` instances with:
   - A special `AgentSink` (non-streaming, captures output)
   - A task-specific system prompt
   - Restricted tool set
3. On task completion, `TaskOrchestrator.onTaskComplete()` injects the result into the parent agent's context
4. Remove `TaskWorker` class from `worker.js`
5. Remove `TaskManager` class from `worker.js`
6. Update `SessionBuilder._buildTaskManager()` to return `null` (tasks are now managed by Session Core)
7. Update `main.js` to remove task wake-up wiring
8. Update `agent.js` to remove `taskManager` field usage
9. Add tests for task agent lifecycle
10. Verify all tests pass

**Files modified**:
- `src/session/task_orchestrator.js` (implement with Agent)
- `src/session/agent_sink.js` (handle task agent output)
- `src/agent/worker.js` (remove TaskWorker, TaskManager)
- `src/agent/session_builder.js` (remove _buildTaskManager)
- `src/agent/agent.js` (remove taskManager field)
- `src/main.js` (remove task wiring)
- `src/tools/subagents.js` (delegate to SessionCore)

**Files removed**:
- `src/agent/worker.js` (replaced by TaskOrchestrator + Agent)

**Risk**: Medium — this is the biggest behavioral change. Thorough testing required.

### Phase 4: Thin CLI into ClientApp (Breaking — but incremental)

**Goal**: Extract CLI logic into a pure ClientApp.

**Steps**:
1. Create `src/clientapps/cli.js` (CliClientApp)
2. Create `src/main.js` (new, thin orchestrator)
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

**Files created**:
- `src/clientapps/cli.js`

**Files modified**:
- `src/main.js` (complete rewrite — thin orchestrator)

**Files removed**:
- `src/ui/session.js` (logic moved to CliClientApp)

**Risk**: Medium — main.js is the entry point. Thorough testing required.

### Phase 5: Web/RPC ClientApps (No breaking changes)

**Goal**: Add Web and RPC ClientApp implementations.

**Steps**:
1. Create `src/clientapps/web.js` (WebClientApp)
2. Create `src/clientapps/rpc.js` (RpcClientApp)
3. Update `main.js` to support `--web` and `--rpc` flags
4. Add tests for Web and RPC clients
5. Verify all tests pass

**Files created**:
- `src/clientapps/web.js`
- `src/clientapps/rpc.js`

**Files modified**:
- `src/main.js` (add --web, --rpc flags)

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

**Files removed**:
- `src/agent/message_bus.js`
- `src/ui/session.js` (if still present)
- `src/agent/worker.js` (if still present)

**Files modified**:
- `src/context/output.js` (consolidate event types)
- `src/agent/index.js` (clean up re-exports)

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
| **Backpressure deadlocks** | Low | High | Thorough testing of EventChannel under load. Add timeouts. |
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

### Q2: How does the duplex queue handle backpressure when the UI is slow?

**Answer**: The `EventChannel` has a max buffer size (`_outputMax = 1000`). When the buffer is full, `emitOutput()` blocks until a consumer drains the buffer. This pauses the Session Core's event emission. For input, `_inputMax = 100` — if the Session Core is slow, the CLI's input is buffered up to 100 events, then blocked.

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
| **Duplex Queue** | A typed, backpressured, ordered event channel between ClientApp and Session Core |
| **Task Agent** | An Agent instance with a different output target (Session Core internal sink) |
| **TaskOrchestrator** | Manages task lifecycle: spawn, monitor, complete, cancel |
| **EventRouter** | Routes input events to agents and output events to ClientApp |
| **AgentSink** | Bridges an Agent's output to the Session Core |
| **SessionManager** | Manages session lifecycle, agent swaps, multi-session support |
| **SessionBuilder** | Encapsulates the full agent initialization pipeline |

---

## Appendix C: Migration Checklist — Phase 1

This checklist allows a developer to start implementing Phase 1 immediately:

- [ ] Create `src/session/` directory
- [ ] Create `src/session/event_channel.js` with `EventChannel` class
- [ ] Create `src/session/events.js` with event type constants
- [ ] Create `src/session/event_channel.test.js` with tests
- [ ] Move `src/agent/session_manager.js` → `src/session/session_manager.js`
- [ ] Move `src/agent/session_store.js` → `src/session/session_store.js`
- [ ] Move `src/agent/message_queue.js` → `src/session/message_queue.js`
- [ ] Update all imports across the codebase
- [ ] Update `src/agent/index.js` re-exports
- [ ] Update `src/main.js` imports
- [ ] Run `bun test` — verify all tests pass

---

*Document end.*
