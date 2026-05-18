# oa-agent — Domain Glossary

Domain concepts for the oa-agent AI agent harness. Implementation details are documented separately in `docs/agents/`.

## Core Entities

- **Application** — One `oa-agent` process. Manages zero or more agents.
- **Agent** — The core runtime unit: receives messages, calls LLM, executes tools, manages context. An application manages agent instances (potentially switching between them).
- **Task Agent** — A sub-agent spawned from a parent agent for delegation. Runs in a background task with its own MessageLog and LLM loop. Controlled via TaskManager.
- **Session** — One uninterrupted chat from start to finish (no reset/clearing). Complete capture of everything: messages, config, token usage, everything from user and model server. Resumable. Session fork (planned): go back N turns and branch with new input.

## Context Layer

- **Context** — Everything the LLM sees. The high-level concept. Managed via MessageLog (implementation).
- **MessageLog** — Append-only message buffer, the internal implementation of context tracking. Immutability is a caching optimization, not a fundamental constraint. Operations: `append()`, `insert_at()`, `reset()`, `replace_messages()`. No individual message deletion.
- **Cache Invalidation** — Triggers: compaction, reset, model switch. These are the known break points. Critical performance concern (can mean difference between 20s and 5m response).
- **Selective Pruning** (experimental) — Tail-popping messages to reuse older cache layers. Not yet validated.

## Context Enrichment

- **Profile** — Defines a type of agent: system prompt + tools + configuration. The "what am I" of the system. Configured via profile name (CLI flag, config file, or default). Contains: role, body, tool whitelist/blacklist, model, aspects, preload skills. Profile selection priority: CLI > config file > default.
- **Aspect** — "Always on" system prompt snippet. Composable, flexible behavioral overlay. Configured in profile via `aspects` list. General behavioral rules. May contain workflows. Piecemeal building block.
- **Skill** — Load-on-demand guide/workflow. Discoverable by name + description. Can reference external files and scripts. Transient, task-specific. Three states: **Unknown** (invisible to agent), **Available** (known, can be loaded), **Loaded** (body text inlined into context + additional files listed).
- **Common goal** — Aspects and skills both end up in the same place (LLM context). The distinction is about ordering and composition: aspects for persistent signal, skills for on-demand signal. Reduce noise, adapt to task requirements.
- **AGENTS.md** — Project-specific agent instructions. Community convention among coding agents (like CLAUDE.md). Standardized format that other agent tools can consume. Loaded into system prompt via `{agents_md}` placeholder.

## Tools

- **Tool** — Single concept: either exposed to context or not. No distinction between "core", "manager", or "MCP" at the domain level.
- **Tool Group** — A set of tools managed together (like manager tools). Should be extensible, not hardcoded.
- **MCP Tool** — A third-party tool loaded via the Model Context Protocol spec. Same domain concept as any other tool.
- **CWD Boundary** — Configuration guardrail to keep the agent focused. Not a security measure.
- **Tool Guideline** — Per-tool context snippet (implementation detail, under consideration for change).

## Messages

- **Message** — A single turn with role, content, and optional metadata (reasoning_content, tool_calls, tool_call_id).
- **Role** — `system`, `user`, `assistant`, `tool`. One combined system message (all pieces composited).
- **Reasoning Content** — LLM's chain-of-thought/thinking output. Separate from main response. Model and config dependent.
- **Tool Call** — Standard OpenAI tool-calling pattern: LLM returns tool_calls → agent executes → result comes back with tool_call_id.
- **Self-talk** — Agent doesn't send user messages to itself directly. Task agents communicate bidirectionally. External events may inject messages.

## Context Management

- **Compaction** — Triggered when token budget exceeded. Current strategy: "full summary + keep recent" — LLM summarizes older messages into a structured checkpoint (Goal, Progress, Key Decisions, Next Steps, Critical Context), injected as system message replacing compacted messages. Recent messages kept verbatim.
- **Compaction Strategies** — Current: summary + keep recent. Planned experimental: tail optimization with prominent summary prompt + keep recent mix.
- **Max Iterations** — Configurable safety mechanism. Reset on final response (non-tool-call content).
- **Final Response** — LLM returns plain content (no tool calls). End of turn or continuation depending on app settings.
- **Context Pruning** (experimental) — Selective tail-popping to reuse older cache layers. Not yet validated.

## Agent Lifecycle

- **Model Switch** — Continues with same MessageLog (append-only). Not a reset. Rarely used, usually user-initiated.
- **Profile Switch** — System prompt changes, MessageLog stays (unless reset). Intentional: LLM sees new instructions with same context.
- **System Prompt Rebuild** — Only on model change, resume, or when absolutely necessary. Stale/wrong is preferred over regenerating (cache preservation).
- **Error Recovery** — Errors returned to LLM as tool results so it can self-correct.
- **Retry** — Retry with exponential backoff for transient LLM errors. Important fault tolerance mechanism.
- **LLM Unreachable** — Retries N times with backoff, then times out and returns error to user. Configurable.
- **Cancellation** — CancellationToken mechanism. Available for agent and task agents.

## Output and Events

- **Output** — Decoupling agent from UI layer. Agent emits raw data; UI layer formats display. Deliberate domain boundary.
- **Sink** — UI implementation of Output. One sink per agent (not currently multiple simultaneous sinks).
- **OutputEvent** — Domain concept: events representing changes in the agent's state. Emitted to the sink for display. Variants: UserMessage, AssistantMessage, Thinking, ToolCall, ToolResult, Compacting, CommandResult, Question, StreamingChunk, TaskProgress, TokenUsage.
- **Pager / TruncatedOutput** — Context manipulation (pagination of tool output into context), not UI formatting.

## Persistence

- **Session** — In-memory (MessageLog for LLM context) + persisted (JSONL for audit/resume). The separation is an implementation detail. Purpose: debugging, development, audit trails for the agent harness itself.
- **Session Log** — Written by the agent itself, not by the sink. JSONL format. Resumable: load from serialized JSONL back into active session.

## Task System

- **Task Lifecycle** — Spawned as background task → LLM loop with tool support → text response → result appended to manager's MessageLog → wake-up callback fires.
- **Task Communication** — Result appended as system message. Wake-up callback notifies MessageBus. Follow-up via channel (45s timeout).
- **Task Cancellation** — CancellationToken on TaskHandle. Parent calls interrupt_task().
- **Task Concurrency** — Multiple simultaneous task agents via TaskManager HashMap.
- **TaskStatus** — Running, Completed, Failed(String), Cancelled.

## External Events

- **MessageQueue** — Thread-safe FIFO buffer. Intended mechanism for external event injection.
- **External Events** — File changes, HTTP callbacks, cron schedules, other agents, user interactions from different UIs.
- **Event Injection** — External events become user messages (possibly wrapped).
- **MessageBus** — Message queue + dispatcher pattern. Single-threaded dispatch owning the run loop (implementation detail, not a domain constraint).

## Security

- **Marker Mangler** — Escapes input that triggers special behavior (tool call actions, internal markers). Protects against prompt injection via crafted input (files, URLs, etc.). Agent sees mangled names. Bypass requires hex/byte-level tricks.
- **Security Rationale** — All text to an LLM is potentially an instruction. Malicious input (crafted files, fetched URLs) could trigger internal behavior. Mangler prevents RCE via prompt injection.

## Commands

- **Commands** — User-triggered slash commands. Never LLM-triggered.
- **Domain commands** — clear, profile switch, model switch, compact, regenerate, skill load, prompt execute.
- **UI commands** — help, quit, tools listing, thinking toggle, models listing, tokens.

## Configuration

- defaults.json — User-editable global defaults for the entire application.
- profiles/*.profile.md — Named profile overlays (role, body, tools).
- templates/ — Prompt templates (system_prompt.md, skills_preamble.md).
- prompts/ — Named prompt templates.
- Resolution priority — CLI argument → config file → environment variable → default constant.

## Architecture

- **Backend** — The agent runtime: owns MessageBus, Agent, LlmClient, TaskManager. Runs on a dedicated thread. Receives `Inbound` messages, emits `Outbound` events. No UI dependencies.
- **Frontend (UI Thread)** — The user-facing thread. Handles input (readline, TUI) and output (rendering). Communicates with Backend via channels. No agent dependencies.
- **Message Bus Protocol** — Channel-based communication between UI and Backend. Replaces shared-state synchronization. Two unidirectional channels: `Inbound` (UI→Backend) and `Outbound` (Backend→UI).
- **Inbound** — Messages from UI to Backend: `Message(String)`, `Cancel`, `QuestionAnswer(answer[])`, `SwitchProfile(String)`, `Command(Command)`, `Quit`.
- **Outbound** — Events from Backend to UI: `Event(OutputEvent)`, `Idle`, `Done`, `FatalError(String)`, `SessionStarted { session_id }`, `TokenUsage { ... }`.
- **ChannelSink** — Backend-side `Output` implementation. Wraps the outbound channel sender. Agent calls `sink.emit()` → sink sends `OutputEvent` over channel to UI.

## Analytics

- **Model Usage Analytics** — KPIs: cache hit/miss patterns, token sizes, context sizes, per-model request counts, success/failure rates. First-class concern for performance monitoring.
