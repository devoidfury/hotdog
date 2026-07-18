# hotdog — Domain Glossary

Domain concepts for the hotdog AI agent harness. Implementation details are documented separately in `docs/agents/`.

## Core Entities

- **Application** — One `hotdog` process. Manages zero or more agents.
- **Agent** — The core runtime unit: receives messages, calls LLM, executes tools, manages context. An application manages agent instances (potentially switching between them).
- **Task Agent** — A sub-agent spawned from a parent agent for delegation. Runs in a background task with its own MessageLog and LLM loop. Controlled via TaskManager.
- **Session** — One uninterrupted chat from start to finish (no reset/clearing). Complete capture of everything: messages, config, token usage, everything from user and model server. Resumable. Session fork (planned): go back N turns and branch with new input.

## Context Layer

- **Context** — Everything the LLM sees. The high-level concept. Managed via MessageLog (implementation).
- **MessageLog** — Class in `src/core/context/message-log.ts` that wraps the agent's message array. Provides `push()`, `replace()`, `getAll()`, `clear()`, `toJSON()`, and `buildMessages()`. The agent's `log` property returns this instance. Messages are `Message` objects with `role`, `content`, `reasoningContent`, `toolCalls`, `toolCallId`.
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

- **Message** — A single turn with role, content, and optional metadata (reasoning_content, tool_calls, tool_call_id, images).
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
- **Sink** — UI implementation of OutputSink. `CliOutputSink` extends `OutputSink` with formatting and color support. One sink per agent. Task agents use `AgentSink` which filters output.
- **OutputEvent** — Domain concept: events representing changes in the agent's state. Emitted to the sink for display. 14 types: `USER_MESSAGE`, `ASSISTANT_MESSAGE`, `THINKING`, `TOOL_CALL`, `TOOL_RESULT`, `COMPACTING`, `COMMAND_RESULT`, `QUESTION`, `STREAMING_CHUNK`, `STREAMING_REASONING_CHUNK`, `TASK_PROGRESS`, `TOKEN_USAGE`, `COMPACTION_RESULT`, `SESSION_STATE`.
- **Pager / TruncatedOutput** — Context manipulation (pagination of tool output into context), not UI formatting.

## Persistence

- **Session** — In-memory (MessageLog for LLM context) + persisted (JSONL for audit/resume). The separation is an implementation detail. Purpose: debugging, development, audit trails for the agent harness itself.
- **Session Log** — Written by the agent itself, not by the sink. JSONL format. Resumable: load from serialized JSONL back into active session.

## Task System

- **Task Lifecycle** — Spawned as background task → LLM loop with tool support → text response → result appended to manager's MessageLog → wake-up callback fires.
- **Task Communication** — Result appended as system message. Wake-up callback notifies MessageBus. Follow-up via queue (`_followQueue`) drained on each iteration.
- **Task Cancellation** — CancellationToken on TaskHandle. Parent calls interrupt_task().
- **Task Concurrency** — Multiple simultaneous task agents via TaskManager HashMap.
- **TaskStatus** — Running, Completed, Failed, Cancelled.

## External Events

- **MessageQueue** — Thread-safe FIFO buffer. Intended mechanism for external event injection.
- **External Events** — File changes, HTTP callbacks, cron schedules, other agents, user interactions from different UIs.
- **Event Injection** — External events become user messages (possibly wrapped).
- **MessageBus** — Message queue + dispatcher pattern. Single-threaded dispatch owning the run loop (implementation detail, not a domain constraint).

## Security

- **Marker Mangler** — Escapes input that triggers special behavior (tool call actions, internal markers). Protects against prompt injection via crafted input (files, URLs, etc.). Agent sees mangled names. Bypass requires hex/byte-level tricks.
- **Security Rationale** — All text to an LLM is potentially an instruction. Malicious input (crafted files, fetched URLs) could trigger internal behavior. Mangler prevents RCE via prompt injection.

## Commands

- **Commands** — User-triggered operations. Never LLM-triggered. Commands are the abstract concept; how they are invoked is a UI implementation detail.
- **Slash Commands** — The interactive CLI implements commands using `/` prefix syntax (e.g., `/quit`, `/compact`). This is one UI implementation for invoking commands.
- **Core commands** (`Command` enum): `help`, `quit`, `clear`, `tools`, `thinking`, `tokens`, `regenerate`, `reasoning`, `unknown`.
- **Custom commands** — Extensions register commands via `CommandRegistry` using the `COMMANDS_REGISTER` hook (e.g., `compact`, `model`, `skill`).
- **UI commands** — `help`, `quit` handled directly by UI layer; all others dispatched through agent.

## Configuration

- `config/defaults.json` — User-editable global defaults. Config dir resolution: CLI `--config-dir` > `HOTDOG_CONFIG_DIR` env > `./config` (CWD) > `/etc/hotdog` > `~/.config/hotdog` (XDG).
- `config/profiles/*.profile.md` — Named profile overlays (role, body, tools, aspects).
- `config/system_prompt.md` — System prompt template.
- `config/prompts/*.prompt.md` — Named prompt templates.
- `config/aspects/*.aspect.md` — Aspect snippets loaded by profiles.
- Resolution priority — CLI argument → config file → extension defaults → built-in defaults.

## Architecture

- **Single-threaded event loop** — The JS runtime runs on a single thread with async/await. No separate backend/frontend threads.
- **Core** (`src/core/`) — Minimal foundation: Agent, hooks, session management, tool registry, config, CLI parsing. No extension dependencies.
- **Extensions** (`src/extensions/`) — All features (tools, compaction, MCP, skills, prompts, subcommands) live as extensions that plug into the core via hooks.
- **Hook System** — The primary extension mechanism. `HookSystem` with `on()`, `off()`, `notifyHooks()`, `runHookPipeline()`, `clear()`. Extensions register handlers; core emits events.
- **MessageBus** — Owns the agent run loop. Drains queued messages sequentially through `agent.run()`. Provides input preprocessing via `INPUT` hook.
- **OutputSink** — Decouples agent from UI. Agent emits events via `sink.emit()`; `CliOutputSink` formats and displays with color support.

## Analytics

- **Model Usage Analytics** — KPIs: cache hit/miss patterns, token sizes, context sizes, per-model request counts, success/failure rates. First-class concern for performance monitoring.
