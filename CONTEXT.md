# hotdog — Domain Glossary

Domain concepts for the hotdog AI agent harness. Implementation details are documented separately in `docs/agents/`.

Status markers: entries tagged **(planned)** are design intent -- nothing in the current code implements them. Entries tagged **(experimental)** exist in code but are not validated. Untagged entries describe shipped behavior.

## Core Entities

- **Application** — One `hotdog` process. Manages zero or more agents.
- **Agent** — The core runtime unit: receives messages, calls LLM, executes tools, manages context. An application manages agent instances (potentially switching between them).
- **Task Agent** — A sub-agent spawned from a parent agent for delegation. Runs in a background task with its own MessageLog and LLM loop. Controlled via TaskManager.
- **Session** — One uninterrupted chat from start to finish (no reset/clearing). Complete capture of everything: messages, config, token usage, everything from user and model server. Resumable. Session fork: go back N turns and branch with new input (`/fork [N] [prompt]`) — the fork is a new session seeded with the copied context; the source is untouched.
- **Rewind** — Dropping whole turns from the tail of a session (`/undo` = one turn, `/rewind [N]`). A turn is a user message plus everything after it until the next user message, so tool-call chains never split. Rewinds are persisted: the session log gets a reset marker followed by the surviving messages (append-only -- the undone history stays above the marker for audit), and replay reads from the last reset.

## Context Layer

- **Context** — Everything the LLM sees. The high-level concept. Managed via MessageLog (implementation).
- **MessageLog** — Class in `src/core/context/message-log.ts` that wraps the agent's message array. Provides `push()`, `replace()`, `getAll()`, `clear()`, `toJSON()`, and `buildMessages()`. The agent's `log` property returns this instance. Messages are `Message` objects with `role`, `content`, `reasoningContent`, `toolCalls`, `toolCallId`.
- **Cache Invalidation** — Triggers: compaction, reset, model switch. These are the known break points. Critical performance concern (can mean difference between 20s and 5m response).
- **Selective Pruning** (planned) — Tail-popping messages to reuse older cache layers. Not implemented.

## Context Enrichment

- **Profile** — Defines a type of agent: system prompt + tools + configuration. The "what am I" of the system. Configured via profile name (CLI flag, config file, or default). Contains: body, tool whitelist/blacklist, model, aspects. Profile selection priority: CLI > config file > default.
- **Aspect** — "Always on" system prompt snippet. Composable, flexible behavioral overlay. Configured in profile via `aspects` list. General behavioral rules. May contain workflows. Piecemeal building block.
- **Skill** — Load-on-demand guide/workflow. Discoverable by name + description. Can reference external files and scripts. Transient, task-specific. Three states: **Unknown** (invisible to agent), **Available** (known, can be loaded), **Loaded** (body text inlined into context + additional files listed).
- **Common goal** — Aspects and skills both end up in the same place (LLM context). The distinction is about ordering and composition: aspects for persistent signal, skills for on-demand signal. Reduce noise, adapt to task requirements.
- **AGENTS.md** — Project-specific agent instructions. Community convention among coding agents (like CLAUDE.md). Standardized format that other agent tools can consume. Loaded into system prompt via `{agents_md}` placeholder.

## Tools

- **Tool** — Single concept: either exposed to context or not. No distinction between "core", "manager", or "MCP" at the domain level.
- **Tool Group** (planned) — A set of tools managed together (like manager tools). No grouping primitive exists today; when it lands it must stay extensible, not hardcoded.
- **MCP Tool** — A third-party tool loaded via the Model Context Protocol spec. Same domain concept as any other tool.
- **Workspace Roots** — The set of directories bounding file tools, configured via `workspace.paths` (default `["."]`, i.e. the process CWD; legacy `cwdBoundary`/`workspaceRoot` keys still honored as a single root). Relative paths resolve against the primary root (`paths[0]`); absolute paths must fall inside some root. All file paths go through `Workspace.resolveSafe()` which rejects escapes (including symlink escapes).
- **Tool Guideline** (planned) — Per-tool context snippet. Not implemented; the only shipped per-tool data is `ToolMetadata` (`sideEffects`, `difficulty`).

## Messages

- **Message** — A single turn with role, content, and optional metadata (reasoning_content, tool_calls, tool_call_id, images).
- **Wrapper Parts** — Semantic content parts (`file-include`, `system-notice`) that wrap a payload in a real harness marker. Extensions emit the part (never the XML); the wire serializer renders and mangles it, with trust fixed per type (file-include: wrapper verbatim, file data mangled; system-notice: verbatim). Origin is enforced at the queue boundary: parts arrays without harness provenance are flattened to mangled text. `src/core/context/wrappers.ts`.
- **Role** — `system`, `user`, `assistant`, `tool`. One combined system message (all pieces composited).
- **Reasoning Content** — LLM's chain-of-thought/thinking output. Separate from main response. Model and config dependent.
- **Tool Call** — Standard OpenAI tool-calling pattern: LLM returns tool_calls → agent executes → result comes back with tool_call_id.
- **Self-talk** — Agent doesn't send user messages to itself directly. Task agents communicate bidirectionally. External events may inject messages.

## Context Management

- **Compaction** — Triggered when token budget exceeded. Current strategy: "full summary + keep recent" — LLM summarizes older messages into a structured checkpoint (Goal, Progress, Key Decisions, Next Steps, Critical Context), injected as system message replacing compacted messages. Recent messages kept verbatim.
- **Compaction Strategies** — Current default: pass-the-baton (prefix-cache-friendly: keeps the largest oldest prefix byte-identical, pops the newest messages, appends a handoff system-notice; no LLM call). Handoff detected at turn end either via the handoff tool or a narrated final summary (treated the same; a handoff call that did not actually clear the context does not arm the replay, and task/subagent workers without a continuation seam drop the baton instead of self-clearing); the popped tail is replayed verbatim after the plan message on the first context hook of the fresh session (also mirrored to `<session-id>.baton.json` in the sessions dir, one file per session so concurrent pops cannot collide, consumed on replay and unlinked when the baton is dropped; the mirror skips session ids that fail the session-log traversal guard). The registry also ships summarize, summarize-short, drop, token-aware, trim. Overflow rescue order: pass-the-baton, trim, drop.
- **Max Iterations** — Configurable safety mechanism. Reset on final response (non-tool-call content).
- **Final Response** — LLM returns plain content (no tool calls). End of turn or continuation depending on app settings.
- **Context Pruning** (planned) — Selective tail-popping to reuse older cache layers. Not implemented.

## Agent Lifecycle

- **Model Switch** — Continues with same MessageLog (append-only). Not a reset. Rarely used, usually user-initiated.
- **Profile Switch** — System prompt changes, MessageLog stays (unless reset). Intentional: LLM sees new instructions with same context.
- **System Prompt Rebuild** — The cached prompt is invalidated and rebuilt on model change, resume, or explicit request (`/regenerate`). Model change always triggers a rebuild: the prompt advertises the active model, so a stale prompt is wrong, not just suboptimal.
- **Error Recovery** — Errors returned to LLM as tool results so it can self-correct.
- **Retry** — Retry with exponential backoff for transient LLM errors. Important fault tolerance mechanism.
- **LLM Unreachable** — Retries N times with backoff, then times out and returns error to user. Configurable.
- **Cancellation** — CancellationToken mechanism. Available for agent and task agents.

## Output and Events

- **Output** — Decoupling agent from UI layer. Agent emits raw data; UI layer formats display. Deliberate domain boundary.
- **Sink** — UI implementation of OutputSink. `CliOutputSink` extends `OutputSink` with formatting and color support. One sink per agent. Task agents get a silent sink that emits nothing to the UI (only the task-complete callback matters).
- **OutputEvent** — Domain concept: events representing changes in the agent's state. Emitted to the sink for display. 15 types: `USER_MESSAGE`, `ASSISTANT_MESSAGE`, `THINKING`, `TOOL_CALL`, `TOOL_RESULT`, `COMPACTING`, `COMMAND_RESULT`, `QUESTION`, `STREAMING_CHUNK`, `STREAMING_REASONING_CHUNK`, `TASK_PROGRESS`, `TOKEN_USAGE`, `COMPACTION_RESULT`, `SESSION_STATE`, `SYSTEM_MESSAGE`.
- **TruncatedOutput** — Tool output head-truncated at a max-lines cap with a `[truncated, N more lines]` tail note (`truncateOutput()` in tool-utils); context manipulation, not UI formatting.

## Persistence

- **Session** — In-memory (MessageLog for LLM context) + persisted (JSONL for audit/resume). The separation is an implementation detail. Purpose: debugging, development, audit trails for the agent harness itself.
- **Session Log** — Written by the agent itself, not by the sink. JSONL format. Resumable: load from serialized JSONL back into active session. One self-contained fact per line, append-only: a crash between lines means the earlier facts count, nothing to roll back.
- **Resume Protocol** — The rules that make a killed session safe to continue. Two durability records in the session log: `tool_started` (fsynced on the executor's pre-flight hook, before side effects; the session-log extension fails closed per call and refuses any call whose own record could not be written, so an absent record means the call truly never dispatched) and `question_asked` (fsynced when the question reaches the UI; fire-and-forget like all output events, so a crash in that window degrades to the started-record classification). Replay classifies every unanswered call: started = outcome-unknown ("verify before retrying" -- a killed job never reports success and is never blind-retried), never-started = safe to retry (logs predating the records keep the generic interrupted wording). A held question (asked, no result) replays as a pending question the UI re-presents; its answer lands as the real tool result and a continuation turn finishes the interrupted run.
- **Turn Lifecycle / Open Turn** — Protocol v2 durability records (every v2 entry carries a `v: 2` stamp): `turn_started` (fsynced on a turn's first iteration, before its first LLM call, carrying the turn's kind `input`/`continuation`) and `turn_end` (fsynced when the turn stops: `completed`/`cancelled`/`error`). A `turn_started` with no `turn_end` after it is an **open turn**: it was still running when the log ended, so auto-resume continues it with a continuation turn (no user message) over the repaired context, where interrupted calls ride along as outcome-unknown results. Held questions win -- the turn must not start on a dangling question call, and the answer enqueues the continuation instead. Only a deliberate rewind (/undo, /rewind, /clear, handoff) checkpoints the log: it appends a RESET, re-appends the kept context, and re-emits the open-turn marker below the marker so the epoch stays honest. Compaction is in-memory-only: it fires `CONTEXT_REPLACED`, which the writer does not handle, so no RESET is written and resume rebuilds the pre-compaction history (the summary lives only in the live agent). v1 logs carry no turn records: their tails are never auto-resumed, and an open v2 turn also derives the `interrupted` index state even when no call dangles.
- **Resume Attempt Record** — A `resume_attempt` durability record, fsynced by `restoreSessionIntoAgent` before the replay begins, so the counter is honest even if the process dies mid-replay. Content carries the origin: `auto` (non-user resume: webui reconnect, gateway dial-back) or `manual` (Continue, CLI `-s`; pre-cap logs carry no origin and derive as manual). A refusal writes no record -- a refusal is not an attempt.
- **Livelock Cap / Parked** — `MAX_CONSECUTIVE_AUTO_RESUMES` consecutive auto-resume records with no progress entry (user input, LLM response, or tool result -- harness-origin messages are machine noise and never count as progress, or a crash loop that nudges once per cycle could recharge the counter forever) between them park the session: further auto-resumes are refused and only a manual resume can bring it back (the escape hatch). The consecutive counter is derived from the FULL log alone (`collectDurabilityFacts` over lifetime entries, not the epoch), so a mid-turn checkpoint cannot recharge it and the cap survives index deletion; `parked` is a derived index state that outranks the others because it is the gate on the next auto-resume, and boot reconcile re-derives it from the log.
- **Replay Cursor / Epoch** — The replay cursor is a position in the FULL log (its length, an append-only coordinate: a RESET appends, it never moves an earlier entry, so a valid cursor stays valid across compactions). A client that remembers its session id (sessionStorage, per-tab: localStorage would let one tab's attach retarget another tab's reconnect) and cursor rides both on the ws upgrade (`?session=...&cursor=...`); the server replays only the exact tail past the cursor and reports the new full length back (`sessionState key=cursor`). A cursor is valid only while the client's transcript is untouched since the attach (any conversation event invalidates it); a stale cursor (the log shrank under it -- truncation, since a RESET only appends) or a slice crossing a RESET (a rewind re-appends its kept messages below the marker, so the tail would replay copies the client already holds) clamps to a full replay, which sends the EPOCH (entries since the last RESET: the context's view) rather than the full history. Cold sessions are adopted under their own id before the attach, so the id -- and the cursor's coordinate space -- survive restarts.

## Task System

- **Task Lifecycle** — Spawned as background task → LLM loop with tool support → text response → result enqueued on the delegating session's MessageBus → the bus run loop appends it to the manager's context (see Task Communication).
- **Task Communication** — On completion, the task result is enqueued on the MessageBus of the session that owns the delegating agent as its next message; the bus run loop appends it to the manager's context via `agent.run()`. The delegating agent is captured at spawn time, so in multi-session setups the result is not delivered to whatever session happened to be created last. It is enqueued, not also added directly, so the result is injected exactly once. If no delegating session was captured (or the session manager exposes no `getBus` — sessionless harnesses), the result falls back to a direct append to the manager's context. If a delegating session was captured but has no bus when the task completes (session deleted, or delegator owns no session entry), the result is dropped with a warning rather than misdelivered to a different session. Follow-up (`sendFollowUp`) steers the task agent: the message goes on its steering queue, drained before each LLM call. There is no direct-append fallback — an agent that cannot be steered cannot be followed up.
- **Task Cancellation** — CancellationToken on TaskHandle. Parent calls interrupt_task().
- **Task Concurrency** — Multiple simultaneous task agents via TaskManager HashMap.
- **TaskStatus** — Running, Completed, Failed, Cancelled.

## External Events

- **MessageQueue** — The MessageBus FIFO queue (`enqueue()` resolves a deferred wake). The mechanism for external event injection. The *normal queue*: processed when the run loop reaches it, never mid-turn.
- **Steering** — Immediate-notice injection into the active message log. Tool results and system notices already do this in-core, mid-run-loop; user input marked `steering` reaches the same log via `Agent.steer()` -- pushed onto the steering queue and drained as a user message before every LLM call, so it can never land between an assistant(tool_calls) message and its tool results. Submission is a flag on a normal bus message, not a separate channel: `MessageBus.enqueue(content, { steering: true })` (websocket `send` with `steering: true`) runs the same INPUT pipeline as ordinary input, then hands off to the steering seam if a run is active, or falls through to the normal queue otherwise. The INPUT pipeline applies to user input and task-agent results (outside-system input) -- internal steering items (tool results, notices) never traverse it. Same mechanism as the task-agent follow-up path.
- **External Events** — File changes, HTTP callbacks, cron schedules, other agents, user interactions from different UIs.
- **Event Injection** — External events become user messages (possibly wrapped).
- **MessageBus** — Message queue + dispatcher pattern. Single-threaded dispatch owning the run loop (implementation detail, not a domain constraint).

## Security

- **Marker Mangler** — Escapes input that triggers special behavior (tool call actions, internal markers). Protects against prompt injection via crafted input (files, URLs, etc.). Agent sees mangled names. Bypass requires hex/byte-level tricks.
- **Security Rationale** — All text to an LLM is potentially an instruction. Malicious input (crafted files, fetched URLs) could trigger internal behavior. Mangler prevents RCE via prompt injection.
- **Spoof Neutralizer** (`src/utils/spoof.ts`) — The mangler protects the MODEL's eyes; this protects the HUMAN's. At every render boundary (tool-call display, approval/question prompts, webui) spoofing code points — bidi controls/isolates, zero-widths, BOM, terminal control introducers — become visible `[U+XXXX]` tokens and are counted; the human seeing THAT something was there is the alert. INVARIANT: neutralize at RENDER, never at storage — the session log keeps original bytes (audit). Two arms, one for the model's eyes, one for yours.

## Commands

- **Commands** — User-triggered operations. Never LLM-triggered. Commands are the abstract concept; how they are invoked is a UI implementation detail.
- **Slash Commands** — The interactive CLI implements commands using `/` prefix syntax (e.g., `/quit`, `/compact`). This is one UI implementation for invoking commands.
- **Core commands** (`Command` enum): `help`, `quit`, `clear`, `tools`, `thinking`, `tokens`, `regenerate`, `reasoning`, `sessions`, `attach`, `detach`, `switch`, `undo`, `rewind`, `fork`, `unknown`.
- **Custom commands** — Extensions register commands via `CommandRegistry` using the `COMMANDS_REGISTER` hook (e.g., `compact`, `model`, `skill`).
- **Channel-level commands** — `quit`, `help`, `sessions`, `attach`, `detach`, `switch` are handled locally by the `Channel` (UI connection abstraction) and never reach the agent. All other commands are routed to the current session's agent.

## Configuration

- `config/defaults.json` — User-editable global defaults. Config dir resolution: CLI `--config-dir` > `HOTDOG_CONFIG_DIR` env > `/etc/hotdog` > `~/.config/hotdog` (XDG) > bundled `examples/minimal-config/config` (last resort when nothing else exists, warned). CWD `./config` auto-discovery removed: resolution never reads the current directory (an existing `./config` warns once when skipped; opt in explicitly with `--config-dir`/env).
- `config/profiles/*.profile.md` — Named profile overlays (body, tools, aspects).
- `config/system_prompt.md` — System prompt template.
- `config/prompts/*.prompt.md` — Named prompt templates.
- `config/aspects/*.aspect.md` — Aspect snippets loaded by profiles.
- Resolution priority — per-key layer chains defined in `core.config.json` / extension `configSchema` (commonly CLI → config → default; some keys deliberately place provider, profile, or env layers at specific positions). Per-key chains: `docs/config-reference.md`.

## Architecture

- **Single-threaded event loop** — The JS runtime runs on a single thread with async/await. No separate backend/frontend threads.
- **Core** (`src/core/`) — Minimal foundation: Agent, hooks, session management, tool registry, config, CLI parsing. No extension dependencies.
- **Extensions** (`src/extensions/`) — All features (tools, compaction, MCP, skills, prompts, subcommands) live as extensions that plug into the core via hooks.
- **Hook System** — The primary extension mechanism. `HookSystem` with `on()`, `off()`, `notifyHooks()`, `runHookPipeline()`, `clear()`. Extensions register handlers; core emits events.
- **MessageBus** — Owns the agent run loop. Drains queued messages sequentially through `agent.run()`. Provides input preprocessing via `INPUT` hook.
- **Channel** (`src/core/channel.ts`) — Abstract UI connection. Attaches to one or more sessions, routes text input and `/`-prefixed commands, and handles channel-level commands locally.
- **OutputSink** — Decouples agent from UI. Agent emits events via `sink.emit()`; `CliOutputSink` formats and displays with color support.

## Analytics

- **Model Usage Analytics** (planned) — KPIs: cache hit/miss patterns, token sizes, context sizes, per-model request counts, success/failure rates. First-class concern for performance monitoring; not implemented (TokenTracker session/request totals only).
