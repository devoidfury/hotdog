import { ParsedCommand } from "./commands.ts";
import { CORE_COMMAND_HANDLERS } from "./command-handlers.ts";
import { findModelEntry, resolveModelConfig, type ModelConfig } from "./config/providers.ts";
import type { SwitchProfile } from "./config/profiles.ts";
import { Message, contentToText, type ImageAttachment, type ToolCall, type MessageSource } from "./context/message.ts";
import { OUTPUT_EVENT, OutputEvent, EVENT_NAME_MAP, type EventName } from "./context/output.ts";
import { createContextManager, type ContextManager } from "./context/context-manager.ts";
import { AgentError, ConfigError, formatError, LlmError } from "./error.ts";
import type { LlmClient, StreamEvent } from "./llm-client/client.ts";
import { createStreamProcessor, StreamProcessor, type StreamResult } from "./llm-client/stream-processor.ts";
import { createCommandRegistry, AgentCommandRegistry, type CommandResult } from "./extensions/registries.ts";
import type { ToolRegistry, ToolDef } from "./extensions/tool-registry.ts";
import { HOOKS, HookSystem, type ContextHookResult, type ProviderRequestHookResult } from "./hooks.ts";
import { type RawUsage } from "./token-tracker.ts";
import { logger } from "@utils/logger.ts";
import { splitFileIncludes } from "@utils/tool-content.ts";
import { ToolExecutor, createToolExecutor, type ToolResult } from "./tool-executor.ts";
import type { ToolExecLink, WireToolConfig } from "./tool-exec-protocol.ts";
import type { AgentLike } from "./session/index.ts";

export interface ModelRegistry {
  [key: string]: ModelConfig;
}

/**
 * Reason a turn ended. Emitted on the TURN_END hook payload so consumers
 * can distinguish real completions from abnormal terminations.
 */
export type TurnEndReason =
  | "completion"      // model returned final text
  | "tool_return"     // a tool signaled stopLoop
  | "continue"        // tool calls ran (or an empty turn was re-invoked); the loop advances
  | "cancelled"       // run was cancelled
  | "error"           // an unexpected exception aborted the turn
  | "max_iterations"  // iteration cap reached
  | "empty_response"; // every re-invoke after an empty completion came back empty again

export type AgentRunResult =
  | { type: 'completion'; content: string }
  | { type: 'tool_return'; outcome: string }
  /** Empty-completion budget spent; the run did not complete normally. */
  | { type: 'empty_response' };

/** True when finish_reason says the response was cut off by the token limit. */
function isLengthStop(reason: string | null): boolean {
  return reason === "length" || reason === "max_tokens";
}

/**
 * Tool-result body for calls on a length-stopped response.
 * Streaming accumulates arguments verbatim; a call cut off mid-JSON is unparseable or silently short, so executing it is worse than failing.
 */
const TRUNCATED_STOP_TOOL_TEXT =
  "This response hit the output token limit (finish_reason=length), so its tool " +
  "calls were NOT executed -- their arguments may be truncated mid-stream. " +
  "Re-issue the intended tool call now with complete arguments.";

/**
 * Harness notice after a length-stop response's skipped tool results (and the backstop in #prepareIteration).
 * Why a trailing user-shaped message is required: strict llama.cpp-style gateways collapse an assistant+tool pair
 * into ONE assistant turn, so two consecutive length stops leave the wire tail [assistant, tool, assistant, tool] == [assistant, assistant]
 * and the next request 400s with "Cannot have 2+ assistant messages at the end". A trailing user-role message breaks the collapse.
 * The tool result above already carries the re-issue instruction; this text stays short -- its job is the conversation shape, not the instruction.
 */
const TRUNCATED_STOP_NUDGE_TEXT =
  "The previous response was truncated by the output token limit, so its tool " +
  "call was not executed. Re-issue that tool call now with complete arguments.";

/**
 * Nudge for the empty-response-after-tools stall: the model returned neither text nor tool calls after
 * tool results (a common local-model failure). The notice lands after the empty assistant message,
 * so the context tail is no longer a tool result. Empty turns are budgeted by maxEmptyRetries;
 * once spent, the run stops with empty_response instead of completing empty.
 */
const EMPTY_TURN_NUDGE_TEXT =
  "Your last response was empty: no text and no tool calls after the tool results. " +
  "Continue the task now -- make the next tool call or respond to the user.";

interface LlmRequestParams {
  messages: Message[];
  modelConfig: ModelConfig;
  toolDefs: ToolDef[];
}

export interface OutputSink {
  emit(event: OutputEvent): void;
  onTaskComplete?: (result: string) => void;
}

/**
 * Branch this session into a new one (the /fork command).
 * Set by the owning SessionManager after construction; left null by sessionless harnesses, where /fork errors.
 */
export interface ForkSessionResult {
  sessionId: string;
  /** Turns actually dropped (clamped to the source's turn count), for honest reporting. */
  droppedTurns: number;
}

export type ForkSessionFn = (opts: { turnsBack: number }) => Promise<ForkSessionResult>;

// Subset of config keys read by Agent; extensions read the rest via core.config.
export interface AgentConfig {
  workspaceRoots?: string[] | null;
  workspaceDeny?: readonly string[] | null;
  maxToolCallsPerIteration?: number;
  maxRetries?: number;
  toolRetryDelay?: number;
  /** Re-invokes allowed after a completion with neither text nor tool calls. */
  maxEmptyRetries?: number;
  maxToolDifficulty?: number | null;
  defaultMaxToolDifficulty?: number | null;
  sandboxMode?: boolean;
  blacklistTools?: string[];
  [key: string]: unknown;
}

export interface AgentOptions {
  hooks: HookSystem;
  toolRegistry: ToolRegistry;
  llmClient: LlmClient;
  model: string;
  maxIterations: number;
  contextLimit: number;
  hideTools?: boolean;
  hideThinking?: boolean;
  showTokenUse?: boolean;
  sink?: OutputSink | null;
  modelRegistry?: ModelRegistry;
  profileName?: string;
  config?: AgentConfig;
  sessionId?: string;
  profileBody?: string;
  /**
   * Resolved system prompt template TEXT (buildConfig's
   * resolved.systemPromptTemplate). Omitted only by standalone callers;
   * the prompt builder then falls back to config-dir resolution.
   */
  systemPromptTemplate?: string;
  abortSignal?: AbortSignal | null;
  toolWhitelist?: string[] | null;
  /** True when the active profile is a manager (controls managerOnly tools). */
  managerProfile?: boolean;
  commandRegistry?: AgentCommandRegistry;
  /** Tool execution plane (see ToolExecutorDeps.toolExec): unset keeps everything inline. */
  toolExec?: "worker" | "inline";
  toolExecLink?: ToolExecLink | null;
  toolExecConfig?: WireToolConfig;
  // Set by the owning MessageBus after construction; lets the agent (and extensions via hooks) queue messages.
  // `piped: true` marks content that already ran the bus INPUT pipeline (steering handoffs),
  // so the run loop must not run it a second time.
  enqueueCallback?: (content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource; piped?: boolean }) => void;
}

export class Agent implements AgentLike {
  hooks: HookSystem;
  #toolRegistry: ToolRegistry;
  llmClient: LlmClient;
  context: ContextManager;
  #model: string;
  maxIterations: number;
  contextLimit: number;
  hideTools: boolean;
  hideThinking: boolean;
  sink: OutputSink | null;
  modelRegistry: ModelRegistry;
  profileName: string | undefined;
  config: AgentConfig | null;
  sessionId: string;
  profileBody: string | undefined;
  cancelled: boolean;
  iterationCount: number;
  maxToolCallsPerIteration: number;
  maxEmptyRetries: number;
  reasoningEffort: string | undefined;
  #isRestoring: boolean;
  #running: boolean;
  abortSignal: AbortSignal | null;
  toolWhitelist: string[] | null;
  /** True when the active profile is a manager (controls managerOnly tools). */
  managerProfile: boolean;
  /**
   * Steering items queued for this agent, drained by #prepareIteration before
   * every LLM call. Items still parked when the run ends are handed back to the
   * owning bus (see takeUndeliveredSteering) instead of waiting for a future run.
   */
  steeringQueue: Array<{
    content: string | Array<Record<string, unknown>>;
    /** Fired when the item is appended to context (see steer()). */
    onDelivered?: () => void;
    /** Provenance of the queued item; defaults to "user". "harness" appends a trusted harness message. */
    source?: MessageSource;
  }>;
  runAbortController: AbortController | null;
  /**
   * Run-lifetime cancellation signal: live for the whole of run(),
   * including tool execution, where the per-iteration `runAbortController`
   * is already null. Aborted by cancel() and by the host's abortSignal.
   */
  #runAbort: AbortController | null = null;
  /** Plane link, kept for the run-start warm (null when inline/unset). */
  #execWarmLink: ToolExecLink | null;
  commandRegistry: AgentCommandRegistry;
  #toolExecutor: ToolExecutor;
  #streamProcessor: StreamProcessor;
  /** This run's kind for the TURN_START payload (session-log turn records). */
  #turnKind: "input" | "continuation" | null = null;
  enqueueCallback: ((content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource; piped?: boolean }) => void) | null;
  /** See ForkSessionFn. Injected by SessionManager; null when no session hosts this agent. */
  forkSession: ForkSessionFn | null;

  constructor(options: AgentOptions) {
    if (options.maxIterations == null) {
      throw ConfigError.MissingConfig("maxIterations");
    }
    if (options.contextLimit == null) {
      throw ConfigError.MissingConfig("contextLimit");
    }
    if (typeof options.model !== "string" || options.model.trim() === "") {
      // No model anywhere in the resolution chain (CLI --model, profile, env, config default_model, provider models).
      // Failing here, at agent construction, keeps model-free subcommands (profiles, sessions) usable with an incomplete config.
      throw new ConfigError(
        "No model configured. Set one via:\n" +
          "  --model <provider>/<name>     (CLI flag)\n" +
          "  HOTDOG_MODEL=<provider>/<name> (env var)\n" +
          "  default_model in ./config/defaults.json\n" +
          "  or a model in your active provider's models array.",
      );
    }
    this.hooks = options.hooks;
    this.#toolRegistry = options.toolRegistry;
    this.llmClient = options.llmClient;
    this.context = createContextManager(options.systemPromptTemplate);
    this.#model = options.model;
    this.maxIterations = options.maxIterations;
    this.contextLimit = options.contextLimit;
    this.hideTools = options.hideTools !== false;
    this.hideThinking = options.hideThinking === true;
    this.sink = options.sink || null;
    this.modelRegistry = options.modelRegistry || {};
    // Seed the window from the registry entry -- per-model context_limit from fetchModels (e.g. llama-swap autoload)
    // only lands in the registry; options.contextLimit is the global fallback. Registry entries use the same fallback,
    // so this no-ops when the backend provided nothing. Must run after both #model and modelRegistry are set.
    const initialEntry = this.#resolveModelEntry();
    if (initialEntry?.contextLimit != null) {
      this.contextLimit = initialEntry.contextLimit;
    }
    this.profileName = options.profileName;
    this.config = options.config || null;
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.profileBody = options.profileBody;
    this.cancelled = false;
    this.iterationCount = 0;
    if (options.config?.maxToolCallsPerIteration == null) {
      throw ConfigError.MissingConfig("maxToolCallsPerIteration");
    }
    this.maxToolCallsPerIteration = options.config.maxToolCallsPerIteration;
    this.reasoningEffort = undefined;
    this.#isRestoring = false;
    this.#running = false;
    this.abortSignal = options.abortSignal || null;
    this.toolWhitelist = options.toolWhitelist || null;
    this.managerProfile = options.managerProfile === true;
    this.steeringQueue = [];
    // Per-iteration AbortController, aborted on cancel() so the HTTP client terminates fetch().
    this.runAbortController = null;
    this.#streamProcessor = createStreamProcessor();
    this.commandRegistry = options.commandRegistry || createCommandRegistry();
    for (const [type, def] of Object.entries(CORE_COMMAND_HANDLERS)) {
      this.commandRegistry.register(type, def);
    }
    if (options.config?.maxRetries == null) {
      throw ConfigError.MissingConfig("maxRetries");
    }
    if (options.config?.toolRetryDelay == null) {
      throw ConfigError.MissingConfig("toolRetryDelay");
    }
    if (options.config?.maxEmptyRetries == null) {
      throw ConfigError.MissingConfig("maxEmptyRetries");
    }
    this.maxEmptyRetries = options.config.maxEmptyRetries;
    this.#toolExecutor = createToolExecutor({
      toolRegistry: options.toolRegistry,
      hooks: options.hooks,
      emitOutput: (type, data) => this.emitOutput(type, data),
      workspaceRoots: options.config?.workspaceRoots || null,
      workspaceDeny: options.config?.workspaceDeny ?? null,
      maxRetries: options.config.maxRetries,
      toolRetryDelay: options.config.toolRetryDelay,
      isRestoring: () => this.#isRestoring,
      agent: this,
      runSignal: () => this.#runAbort?.signal ?? null,
      toolExec: options.toolExec,
      toolExecLink: options.toolExecLink ?? null,
      toolExecConfig: options.toolExecConfig,
    });
    // Warm needs the link too, but only when the plane is actually on.
    this.#execWarmLink =
      options.toolExec === "worker" ? (options.toolExecLink ?? null) : null;
    this.enqueueCallback = options.enqueueCallback || null;
    this.forkSession = null;
  }

  // ── Properties ────────────────────────────────────────────────────────────

  get model(): string {
    return this.#model;
  }
  set model(v: string) {
    const oldModel = this.#model;
    // Same-model set is a silent no-op (mirrors applyProfile's guard): resume
    // re-attests the model the session already runs, and writing it again would
    // log a MODEL_CHANGE record for a change that never happened, plus rebuild
    // caches that are already correct.
    if (v === oldModel) return;
    this.#model = v;
    // Suffix-tolerant lookup (bare name -> "provider/name") matches
    // resolveModelConfig's resolution, so the window tracks the same entry.
    const entry = this.#resolveModelEntry();
    if (entry) {
      this.contextLimit = (entry.contextLimit as number) ?? this.contextLimit;
      // Reset to the new model's default; user can re-override via /reasoning.
      this.reasoningEffort = entry.reasoningEffort as string | undefined;
    }
    // Stale tool defs would be wrong for a different model.
    this.#toolRegistry.clearToolDefs();
    // Prompt advertises the active model, so it must be rebuilt on the next turn.
    this.context.clearSystemPrompt();
    this.hooks.notifyHooks(HOOKS.MODEL_CHANGE, { agent: this, oldModel, newModel: v });
    if (this.sink) {
      this.sink.emit({ type: OUTPUT_EVENT.SESSION_STATE, key: "model", value: v });
    }
  }

  get isRestoring(): boolean {
    return this.#isRestoring;
  }
  set isRestoring(v: boolean) {
    const oldVal = this.#isRestoring;
    this.#isRestoring = v;
    if (oldVal !== v) {
      this.hooks.notifyHooks(HOOKS.SESSION_RESTORE_ACTIVE, { agent: this, isRestoring: v });
    }
  }

  get toolRegistry(): ToolRegistry {
    return this.#toolRegistry;
  }

  /** Partial content of the in-flight stream; lets reconnecting clients replay what was already streamed. */
  get currentStreamingContent(): string {
    return this.#streamProcessor.streamingContent;
  }

  get currentStreamingReasoning(): string {
    return this.#streamProcessor.streamingReasoning;
  }

  getMessages(): Message[] {
    return this.context.getMessages();
  }

  enqueue(content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource; piped?: boolean }): void {
    this.enqueueCallback?.(content, opts);
  }

  /**
   * Queue a steering message for the running (or about-to-run) agent.
   * Drained before every LLM call in #prepareIteration, so it reaches the model mid-turn
   * without landing between an assistant(tool_calls) message and its tool results.
   * This is the in-core append seam (sibling of the tool-result/system-notice appends);
   * user submission runs the INPUT pipeline first via MessageBus.enqueue(..., { steering: true });
   * task follow-ups use this seam directly (task agents have no bus).
   * `onDelivered` (optional) settles when the item leaves the steering seam:
   * #prepareIteration fires it when the append reaches context -- "accepted"
   * is a queue push; "delivered" is the model seeing it. When the agent is
   * idle the item never enters the queue at all (see the idle branch below):
   * it is handed straight to the host, and the callback settles at that
   * handoff. The bus uses these settles to clear the queue chip honestly.
   * `opts.source` sets the appended message's provenance: "harness" (trusted,
   * no transcript echo) for harness-initiated injections -- e.g. a mid-run
   * `/skill` body, which must not wedge between tool calls and results by
   * appending directly. Default "user" mirrors a live steering submission.
   */
  steer(
    content: string | Array<Record<string, unknown>>,
    onDelivered?: () => void,
    opts?: { source?: MessageSource },
  ): void {
    // Idle handoff: with no run in flight there is no #prepareIteration to
    // drain this item, and a parked item would only surface when some future
    // submission happened to start a run -- the steer-during-final-streaming
    // drop. Hand it to the owning bus as a normal queued turn instead
    // (piped: the bus INPUT pipeline already ran at submission, steering or
    // not; a second pass would double-transform). Agents without a bus
    // (task workers) keep the parked behavior: their next run drains it.
    if (!this.#running && this.enqueueCallback) {
      this.enqueueCallback(content, { source: opts?.source, piped: true });
      onDelivered?.();
      return;
    }
    this.steeringQueue.push({ content, onDelivered, source: opts?.source });
  }

  /**
   * Take (and clear) steering items that no #prepareIteration drained --
   * pushed while the loop was running, after its final drain (a submission
   * arriving during the final response's streaming has no LLM call left to
   * inject it before). The owning MessageBus calls this after every run and
   * re-queues the items as normal turns, so a steer can never park in the
   * agent waiting for someone to send another message.
   */
  takeUndeliveredSteering(): Array<{
    content: string | Array<Record<string, unknown>>;
    onDelivered?: () => void;
    source?: MessageSource;
  }> {
    return this.steeringQueue.splice(0);
  }

  /** True while the run loop is active; harness seams (e.g. /skill) pick steer vs. direct append on this. */
  get isRunning(): boolean {
    return this.#running;
  }

  // ── Run Loop ──────────────────────────────────────────────────────────────

  /**
   * Run the agent loop with the given user input; returns undefined if input was empty.
   * `userInput` is plain text or content parts (harness callers may embed `untrusted` parts, mangled only at the wire).
   * `opts.source` sets the message's provenance; harness-injected runs become role "harness", all other input is tagged source "user".
   */
  async run(
    userInput: string | Array<Record<string, unknown>>,
    images?: ImageAttachment[],
    opts?: { source?: MessageSource; continuation?: boolean },
  ): Promise<AgentRunResult | undefined> {
    const emptyInput =
      !contentToText(userInput).trim() && (!images || images.length === 0);
    // A continuation (continueRun) has no user message: the context tail IS
    // the input. Otherwise empty input is a no-op.
    if (emptyInput && !opts?.continuation) return;

    // Re-entrancy guard: the loop keeps per-run state on the instance (iterationCount, runAbortController, stream replay buffers).
    // Two overlapping runs -- e.g. an extension calling run() mid-turn -- would/ corrupt each other's assembly.
    // An "agent" error type prints the stack, so an overlapping run surfaces as a bug, not a recovered condition.
    if (this.#running) {
      throw AgentError.AlreadyRunning(this.sessionId);
    }
    this.#running = true;
    this.#turnKind = opts?.continuation ? "continuation" : "input";

    // Run-lifetime cancellation: cancel() aborts this, and unlike the
    // per-iteration LLM controller it is still live while tools execute, so
    // the exec plane can send a cancel frame and inline bash can kill its
    // group. The host's abortSignal (harness hosts, message bus)
    // forwards into it for exactly the duration of this run, the same way
    // #performLlmCall forwards it per request.
    const runAbort = new AbortController();
    this.#runAbort = runAbort;
    const hostSignal = this.abortSignal;
    // Only the abort is forwarded: `cancelled` stays the cancel()-owned flag
    // it has always been, so a host abort still reports "Agent aborted".
    const onHostAbort = () => runAbort.abort();
    if (hostSignal?.aborted) onHostAbort();
    else hostSignal?.addEventListener("abort", onHostAbort, { once: true });

    // Warm the pool entry for this session: fire-and-forget, so the
    // spawn cost hides behind first-token latency and a session that never
    // calls a tool pays only the entry the idle reaper takes back. Skipped
    // when nothing enabled is tagged for the plane (sandboxMode, tight
    // whitelists): no entry to warm. The workspace rides along so the warmed
    // entry gets the same fence the first invoke would plan (increment 3).
    if (this.#execWarmLink && this.#hasWorkerTools()) {
      this.#execWarmLink.warm?.(this.sessionId, "rw", this.#toolExecutor.planeWorkspace());
    }

    let turnEnded = false;
    try {
      await this.ensureSystemPrompt();

      if (!emptyInput) {
        // Provenance drives the internal role: harness-injected runs ride
        // role "harness"; everything else is user input.
        const userMsg = new Message({
          role: opts?.source === "harness" ? "harness" : "user",
          content: userInput,
          images,
          source: opts?.source ?? "user",
        });
        this.addMessage(userMsg);
        const display = splitFileIncludes(userInput);
        this.emitOutput("user_message", {
          content: display.text,
          ...(display.files.length > 0 ? { files: display.files } : {}),
          ...(images && images.length > 0 ? { images } : {}),
        });
      }

      let iteration = 0;
      // Consecutive empty completions (no text/tool calls); any text or tool work resets it, so the budget bounds one stall episode.
      let emptyStreak = 0;
      while (iteration < this.maxIterations) {
        iteration++;
        this.iterationCount = iteration;
        turnEnded = false;

        const params = await this.#prepareIteration(iteration);
        let response: StreamResult;
        try {
          response = await this.#performLlmCall(params);
        } catch (err) {
          // PROVIDER_ERROR pipeline: a handler (e.g. tool-call-repair dropping a corrupt stored tool call the backend will never accept)
        // can repair the history/params and set retry. Exactly one retry; a second failure propagates.
          const errPayload = { error: err, params, agent: this, retry: false };
          await this.hooks.runHookPipeline<{ retry?: boolean }, "provider:error">(
            HOOKS.PROVIDER_ERROR,
            errPayload,
          );
          if (!errPayload.retry) throw err;
          response = await this.#performLlmCall(params);
        }
        // Snapshot the context tail before the assistant message lands: the
        // empty-turn nudge fires only when this request ended on tool results.
        const afterToolResults = this.context.getMessages().at(-1)?.role === "tool";
        const result = await this.#handleLlmResponse(response, params);

        if (typeof result === "string") {
          if (!this.cancelled && !result.trim()) {
            emptyStreak++;
            if (emptyStreak <= this.maxEmptyRetries) {
              if (afterToolResults) {
                // Harness notice, persisted so the session log records the retry.
                // The after-tools variant also breaks the tool-result context tail
                // that some strict chat templates reject.
                this.addMessage(new Message({
                  role: "harness",
                  source: "harness",
                  content: [{ type: "system-notice", text: EMPTY_TURN_NUDGE_TEXT }],
                }));
              }
              await this.#emitTurnEnd(iteration, response.fullText, [], false, false, "continue");
              turnEnded = true;
              continue;
            }
            // Re-invoke budget spent: stop honestly instead of completing empty.
            await this.#emitTurnEnd(iteration, response.fullText, [], true, false, "empty_response");
            turnEnded = true;
            return { type: "empty_response" };
          }
          emptyStreak = 0;
          await this.#emitTurnEnd(iteration, response.fullText, [], true, this.cancelled, "completion");
          turnEnded = true;
          return { type: 'completion', content: result };
        }

        emptyStreak = 0;
        const { outcome, toolResults } = result;
        if (outcome !== "continue") {
          await this.#emitTurnEnd(iteration, response.fullText, toolResults, true, this.cancelled, "tool_return");
          turnEnded = true;
          return { type: 'tool_return', outcome };
        }

        await this.#emitTurnEnd(iteration, response.fullText, toolResults, false, this.cancelled, "continue");
        turnEnded = true;
      }

      // Graceful capped finish: one tools-off wrap-up call so the model
      // summarizes the partial work instead of the run dying mid-thought
      // (zeroclaw finish_after_max_iterations / opencode max-steps prompt).
      // Costs +1 LLM call, but only on capped runs.
      let capSummary: string | null = null;
      if (!this.cancelled && !this.abortSignal?.aborted && this.iterationCount > 0) {
        capSummary = await this.#wrapUpAfterCap();
      }

      // Emit turn-end so listeners unblock before the return/throw.
      await this.#emitTurnEnd(this.iterationCount, capSummary ?? "", [], true, this.cancelled, "max_iterations");
      turnEnded = true;
      if (capSummary !== null) {
        return { type: "completion", content: capSummary };
      }
      throw AgentError.MaxIterations(this.maxIterations);
    } finally {
      this.#running = false;
      if (this.#runAbort === runAbort) this.#runAbort = null;
      hostSignal?.removeEventListener("abort", onHostAbort);
      if (!turnEnded) {
        const reason: TurnEndReason = this.cancelled ? "cancelled" : "error";
        await this.#emitTurnEnd(this.iterationCount, "", [], true, this.cancelled, reason);
      }
    }
  }

  /**
   * Continue an interrupted turn with no new user message: the context tail
   * (e.g. a resumed pending question's answer, just written as its real tool
   * result) goes straight to the model. Requires a non-empty conversation.
   */
  async continueRun(): Promise<AgentRunResult | undefined> {
    return this.run("", undefined, { continuation: true });
  }

  /**
   * One tools-off wrap-up call after the iteration cap (see the capped-finish
   * block in run()). Appends a harness notice, builds params through the usual
   * pipelines (compaction and steering still apply), then strips the tool
   * defs so the summary call cannot smuggle in more work. Returns null on any
   * failure -- the caller keeps the MaxIterations error, so a broken wrap-up
   * never masks the cap. No PROVIDER_ERROR retry: exactly one attempt.
   */
  async #wrapUpAfterCap(): Promise<string | null> {
    this.addMessage(new Message({
      role: "harness",
      source: "harness",
      content: [{
        type: "system-notice",
        text:
          `Iteration limit (${this.maxIterations}) reached; this is the final turn and tools are disabled. ` +
          "Write a concise wrap-up for the user: what you completed, the current state, and what remains.",
      }],
    }));
    this.sink?.emit({
      type: OUTPUT_EVENT.SYSTEM_MESSAGE,
      content: `Iteration cap (${this.maxIterations}) reached; making one tools-off wrap-up call for a final summary.`,
    });

    try {
      const params = await this.#prepareIteration(this.iterationCount + 1);
      params.toolDefs = [];
      const response = await this.#performLlmCall(params);
      if (!response.fullText.trim()) return null;

      // Deliberately not #handleLlmResponse: tool-call-repair could forge
      // calls into the summary, and an assistant tool_calls message without
      // results would poison the wire for strict backends.
      this.addMessage(new Message({
        role: "assistant",
        content: response.fullText,
        reasoningContent: response.fullReasoning,
        source: "model",
      }));
      this.#emitTokenUsage(response);
      return response.fullText;
    } catch (e: unknown) {
      // Honest cancellation: a user abort during the wrap-up call cancels
      // the run; it must not be reported as a plain MaxIterations blowout.
      if (LlmError.isCancelled(e)) throw e;
      logger.warn(`[agent] max-iteration wrap-up call failed: ${formatError(e)}`);
      return null;
    }
  }

  async #prepareIteration(iteration: number): Promise<LlmRequestParams> {
    // Self-heal the system prompt every iteration (cached no-op when unchanged).
    // run() builds it once per turn, but a mid-run model switch clears it
    // (model setter -> clearSystemPrompt) and the bus allows /model while a
    // run is in flight -- without this backstop the rest of the turn would
    // ship requests with no system message at all.
    await this.ensureSystemPrompt();
    await this.hooks.notifyHooks(HOOKS.TURN_START, {
      turnIndex: iteration,
      timestamp: Date.now(),
      agent: this,
      kind: this.#turnKind ?? "input",
    });

    if (this.cancelled) throw LlmError.Cancelled("Agent cancelled");
    if (this.abortSignal?.aborted) throw LlmError.Cancelled("Agent aborted");

    while (this.steeringQueue.length > 0) {
      const { content: steering, onDelivered, source } = this.steeringQueue.shift()!;
      const harness = source === "harness";
      this.addMessage(
        new Message({
          role: harness ? "harness" : "user",
          content: steering,
          source: harness ? "harness" : "user",
        }),
      );
      if (!harness) {
        // Harness-sourced items (mid-run /skill bodies) are context fuel, not
        // user turns: no transcript echo, no file-include split -- the
        // command's own confirmation row already told the user.
        const display = splitFileIncludes(steering);
        this.emitOutput("user_message", {
          content: display.text,
          ...(display.files.length > 0 ? { files: display.files } : {}),
        });
      }
      // The model has now seen this steering message: settle whoever parked
      // a callback on it (the bus's queue chip). After the context append so
      // "delivered" never leads the truth.
      onDelivered?.();
    }

    let messages = this.buildMessages();
    const contextResult = await this.hooks.runHookPipeline<ContextHookResult | undefined, "context">(
      HOOKS.CONTEXT,
      { messages, agent: this },
    );
    messages = contextResult.data.messages;

    // Backstop: never issue a request whose last two non-system messages are
    // both internal role "assistant" (the only internal role that serializes
    // to wire "assistant" -- harness maps to user/developer). A strict
    // llama.cpp-style gateway collapses each assistant+tool pair into one
    // assistant turn, so [assistant, tool, assistant, tool] arrives as two
    // consecutive assistant messages and 400s. The length-stop branch
    // appends its own notice; this catches any other assistant tail (e.g.
    // consecutive empty completions when maxEmptyRetries >= 2). addMessage
    // persists it; the local `messages` must carry it for this request too.
    const nonSystemTail = messages.filter((m) => m.role !== "system");
    if (
      nonSystemTail.length >= 2 &&
      nonSystemTail[nonSystemTail.length - 1]!.role === "assistant" &&
      nonSystemTail[nonSystemTail.length - 2]!.role === "assistant"
    ) {
      const nudge = new Message({
        role: "harness",
        source: "harness",
        content: [{ type: "system-notice", text: TRUNCATED_STOP_NUDGE_TEXT }],
      });
      this.addMessage(nudge);
      messages = [...messages, nudge];
    }

    let toolDefs = await this.getToolDefs();
    let modelConfig = resolveModelConfig(
      this.#model,
      this.modelRegistry,
      this.contextLimit,
      this.reasoningEffort,
    );

    const reqPayload = { messages, modelConfig, toolDefs, agent: this };
    await this.hooks.runHookPipeline<ProviderRequestHookResult | undefined, "provider:request">(
      HOOKS.PROVIDER_REQUEST,
      reqPayload,
    );
    return {
      messages: reqPayload.messages,
      modelConfig: reqPayload.modelConfig,
      toolDefs: reqPayload.toolDefs,
    };
  }

  async #performLlmCall(params: LlmRequestParams): Promise<StreamResult> {
    const { messages, modelConfig, toolDefs } = params;
    const runController = new AbortController();
    this.runAbortController = runController;

    // Forward an external abort to this run's controller. The listener is per-run:
    // it closes over runController (nulled between runs) and is removed in finally,
    // so it can't accumulate across runs or fire on a cleared controller while idle.
    const signal = this.abortSignal;
    let removeAbortForwarder: (() => void) | null = null;
    if (signal?.aborted) {
      this.cancelled = true;
      runController.abort();
    } else if (signal) {
      const onAbort = () => {
        this.cancelled = true;
        runController.abort();
      };
      signal.addEventListener("abort", onAbort, { once: true });
      removeAbortForwarder = () => signal.removeEventListener("abort", onAbort);
    }

    try {
      const stream = this.llmClient.chatStreamCancellable(
        messages,
        modelConfig,
        toolDefs,
        runController.signal,
        this.sessionId,
      );
      return await this.#processStream(stream);
    } finally {
      removeAbortForwarder?.();
      this.runAbortController = null;
    }
  }

  async #handleLlmResponse(
    response: StreamResult,
    params: LlmRequestParams,
  ): Promise<string | { outcome: string; toolResults: ToolResult[] }> {
    const { modelConfig } = params;
    // handlers may repair/replace the response before it becomes an assistant message and its tool calls execute
    // (e.g.tool - call - repair recovering markup the backend failed to parse into real tool calls).
    const resPayload = { response, modelConfig, agent: this };
    await this.hooks.runHookPipeline<{ response?: StreamResult }, "provider:response">(
      HOOKS.PROVIDER_RESPONSE,
      resPayload,
    );
    response = resPayload.response;
    await this.hooks.notifyHooks(HOOKS.MESSAGES_AFTER_LLM, { response, messages: this.context.getMessages(), agent: this });

    const assistantMsg = new Message({
      role: "assistant",
      content: response.fullText,
      reasoningContent: response.fullReasoning,
      toolCalls: response.finalToolCalls,
      // Model-generated content: untrusted on the wire (always mangled),
      // but the tag survives persistence so provenance is explicit after replay.
      source: "model",
    });
    this.addMessage(assistantMsg);
    this.#emitTokenUsage(response);

    if (response.finalToolCalls) {
      let toolCallsToExecute = response.finalToolCalls;
      let skippedToolResults: ToolResult[] = [];
      let lengthStopped = false;

      if (isLengthStop(response.finishReason)) {
        // Streamed args may be silently truncated; nothing from this response is safe to run.
        // Fail every call with a re-issue instruction so the wire stays valid (paired tool call & result).
        lengthStopped = true;
        toolCallsToExecute = [];
        skippedToolResults = response.finalToolCalls.map((tc) => ({
          toolName: tc.function?.name || "(unknown)",
          input: tc.function?.arguments || "{}",
          content: TRUNCATED_STOP_TOOL_TEXT,
          toolCallId: tc.id,
        }));
      } else if (toolCallsToExecute.length > this.maxToolCallsPerIteration) {
        const truncated = toolCallsToExecute.slice(0, this.maxToolCallsPerIteration);
        const skipped = toolCallsToExecute.slice(this.maxToolCallsPerIteration);

        toolCallsToExecute = truncated;
        skippedToolResults = skipped.map((tc) => ({
          toolName: tc.function?.name || "(unknown)",
          input: tc.function?.arguments || "{}",
          content: `Skipped due to maxToolCallsPerIteration limit (${this.maxToolCallsPerIteration})`,
          toolCallId: tc.id,
        }));
      }

      // No WireFormat here: the executor stores tool-result PARTS and the
      // LlmClient shapes them per model when the request is built.
      const { outcome, toolResults } = await this.#executeTools(
        toolCallsToExecute,
        params.toolDefs.map((d) => d.function.name),
      );

      for (const sr of skippedToolResults) {
        this.addMessage(new Message({
          role: "tool",
          content: sr.content,
          toolCallId: sr.toolCallId,
          source: "tool",
        }));
        this.emitOutput("tool_result", {
          toolName: sr.toolName,
          input: sr.input,
          content: sr.content,
          toolCallId: sr.toolCallId,
        });
      }

      if (lengthStopped) {
        // Trailing user-shaped notice: without it the context tail is [assistant, tool],
        // which strict gateways collapse to one assistant turn; a second consecutive
        // length stop ends the wire with two assistant messages and 400s (see TRUNCATED_STOP_NUDGE_TEXT).
        // Persisted so it rides every later request.
        this.addMessage(new Message({
          role: "harness",
          source: "harness",
          content: [{ type: "system-notice", text: TRUNCATED_STOP_NUDGE_TEXT }],
        }));
      }

      const finalResults = [...toolResults, ...skippedToolResults];

      return { outcome, toolResults: finalResults };
    } else {
      return response.fullText;
    }
  }

  async #emitTurnEnd(
    iteration: number,
    message: string,
    toolResults: Array<ToolResult>,
    stopped: boolean,
    cancelled = false,
    reason: TurnEndReason,
  ): Promise<void> {
    // One continuation owner per turn end: handlers that enqueue the next
    // input (loop re-fires, handoff plans) claim first; a failed claim means
    // another handler owns this turn and enqueuing would double up.
    let claimed = false;
    const claimTurn = (): boolean => {
      if (claimed) return false;
      claimed = true;
      return true;
    };
    await this.hooks.notifyHooks(HOOKS.TURN_END, {
      turnIndex: iteration,
      message,
      toolResults,
      stopped,
      cancelled,
      reason,
      agent: this,
      claimTurn,
    });
  }

  #emitTokenUsage(response: { usage?: RawUsage | null }): void {
    this.context.recordUsage(response.usage, (usage) => {
      this.emitOutput("token_usage", { ...usage, contextWindow: this.contextLimit });
    });
  }

  notifyCompletion(result: string): void {
    this.sink?.onTaskComplete?.(result);
  }

  /** Public so extensions can rebuild messages after modifying context. */
  buildMessages(): Message[] {
    return this.context.buildForLlmCall();
  }

  async ensureSystemPrompt(): Promise<void> {
    await this.context.ensureSystemPrompt(this.hooks, this, {
      profileBody: this.profileBody,
      model: this.#model,
      profileName: this.profileName,
    });
  }

  #processStream(stream: AsyncIterable<StreamEvent>): Promise<StreamResult> {
    // The session mangler unescapes the assembled result once (stream events
    // carry raw wire content; per-chunk unescaping would fossilize aliases
    // split across deltas). onChunk/onReasoning below get per-chunk
    // unescaping for display only.
    return this.#streamProcessor.process(stream, {
      onChunk: (content) => this.emitOutput("streaming_chunk", { content }),
      onReasoning: (content) => this.emitOutput("streaming_reasoning_chunk", { content }),
      onToolCallDelta: (tc) => this.emitOutput("tool_call_delta", { ...tc }),
      shouldCancel: () => this.cancelled,
    }, this.llmClient.markerMangler);
  }

  #executeTools(toolCalls: ToolCall[], availableToolNames?: string[]) {
    // availableToolNames is the model-visible set from this iteration's request
    // (post PROVIDER_REQUEST), so availability never re-filters the registry.
    return this.#toolExecutor.execute(toolCalls, availableToolNames);
  }

  /** Use instead of pushing to the message log directly; fires CONTEXT_MESSAGE for extensions. */
  addMessage(msg: Message): void {
    this.context.addMessage(msg);
    this.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, { message: msg, agent: this });
  }

  /** Replace the entire context; fires CONTEXT_REPLACED so extensions can react. */
  replaceContext(newContext: Message[]): void {
    const oldContext = this.context.getMessages();
    this.context.replaceMessages(newContext);
    this.hooks.notifyHooks(HOOKS.CONTEXT_REPLACED, { agent: this, oldContext, newContext });
  }

  /**
   * rewind (undo/rewind/clear): replaces the context and also fires CONTEXT_REWOUND so session persistence checkpoints the log.
   * Awaitable: settling means checkpoint writes are done, so the next message can't race its append past the rewound-context re-appends.
   */
  rewindContext(newContext: Message[]): Promise<void> {
    this.replaceContext(newContext);
    return this.hooks.notifyHooks(HOOKS.CONTEXT_REWOUND, { agent: this, newContext });
  }

  emitOutput(type: EventName, data: Record<string, unknown>): void {
    const eventType = EVENT_NAME_MAP[type];
    if (this.sink && eventType) {
      this.sink.emit({ type: eventType, ...data } as OutputEvent);
    }
    this.hooks.notifyHooks(HOOKS.OUTPUT_EVENT, { type, data, agent: this });
  }

  /**
   * Switch this agent to a different profile at runtime.
   *
   * Applies the profile's body and tool whitelist,
   * resets the tool blacklist to the profile's (an empty blacklist clears whatever a top-level config carried),
   * updates the manager-profile flag (which gates managerOnly tools like the subagent tools),
   * and switches the model via the model setter when the profile specifies one (so per-model limits, reasoning effort, and MODEL_CHANGE all update).
   * A profile declaring a model `group` instead leaves the session model alone (with a warning) -- groups place task workers, not session turns.
   * Invalidates the cached system prompt and tool defs so the next turn rebuilds them from the new profile.
   *
   * Does NOT clear the message log -- callers that want a wipe (e.g. the webui, which asks the user first) call clearContext() separately.
   */
  applyProfile(name: string, profile: SwitchProfile): void {
    this.profileName = name;
    this.profileBody = profile.body || undefined;
    this.toolWhitelist = profile.whitelistTools;
    this.managerProfile = profile.manager === true;
    this.config = this.config || {};
    this.config.blacklistTools = profile.blacklistTools;
    if (profile.group) {
      // Model groups are placed at task spawn (provider-lane admission); a
      // session turn has no placement machinery, so keep the current model.
      logger.warn(
        `[profile ${name}] declares model group '${profile.group}'; groups place task workers only -- keeping session model ${this.#model}`,
      );
    } else if (profile.model && profile.model !== this.#model) {
      this.model = profile.model;
    }
    // The model setter already invalidates both caches when it ran; repeat
    // unconditionally so a same-model switch still rebuilds with the new
    // body (both operations are idempotent).
    this.#toolRegistry.clearToolDefs();
    this.context.clearSystemPrompt();
  }

  /** Clear the entire context; fires CONTEXT_REPLACED and CONTEXT_REWOUND */
  async clearContext(): Promise<void> {
    const oldContext = this.context.getMessages();
    this.context.clear();
    this.iterationCount = 0;
    this.#toolRegistry.clearToolDefs();
    await this.hooks.notifyHooks(HOOKS.CONTEXT_REPLACED, { agent: this, oldContext, newContext: [] });
    await this.hooks.notifyHooks(HOOKS.CONTEXT_REWOUND, { agent: this, newContext: [] });
  }

  /** Cheap per-run check for warm: is any registered tool tagged for the exec plane? */
  #hasWorkerTools(): boolean {
    for (const { metadata } of this.#toolRegistry.getAllWithMetadata()) {
      if (metadata.execution === "worker") return true;
    }
    return false;
  }

  cancel(): void {
    this.cancelled = true;
    if (this.runAbortController && !this.runAbortController.signal.aborted) {
      this.runAbortController.abort();
    }
    // Also interrupt work that outlives the LLM request -- the per-iteration
    // controller is null while tools run (see #runAbort).
    if (this.#runAbort && !this.#runAbort.signal.aborted) {
      this.#runAbort.abort();
    }
  }

  resetCancel(): void {
    this.cancelled = false;
  }

  /** Tool defs filtered by sandboxMode, maxToolDifficulty, and whitelist/blacklist. */
  async getToolDefs(): Promise<ToolDef[]> {
    const config = this.config;

    // maxToolDifficulty priority: CLI override > model registry > config default.
    const modelEntry = this.#resolveModelEntry();
    const effectiveMaxDifficulty =
      config?.maxToolDifficulty ??
      modelEntry?.maxToolDifficulty ??
      config?.defaultMaxToolDifficulty ??
      undefined;

    let registry = this.#toolRegistry;
    if (config?.sandboxMode || effectiveMaxDifficulty != null || !this.managerProfile) {
      registry = registry.filterByMetadata({
        maxDifficulty: effectiveMaxDifficulty,
        allowSideEffects: !config?.sandboxMode,
        managerToolsEnabled: this.managerProfile,
      });
    }

    if (this.toolWhitelist && this.toolWhitelist.length > 0) {
      registry = registry.filter(this.toolWhitelist, null);
    }
    const blacklistTools = config?.blacklistTools as string[] | undefined;
    if (blacklistTools && blacklistTools.length > 0) {
      registry = registry.filter(null, blacklistTools);
    }

    return registry.getToolDefs();
  }

  #resolveModelEntry(): ModelConfig | undefined {
    return findModelEntry(this.#model, this.modelRegistry);
  }

  getToolNames(): string[] {
    return Array.from(this.#toolRegistry.getAll().map(([name]) => name));
  }

  /** Dispatches via: custom handler → extension hooks → command registry. */
  async executeCommand(cmd: ParsedCommand): Promise<CommandResult | null> {
    return this.commandRegistry.dispatch(cmd, this, this.hooks);
  }

  serialize(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      context: this.context.log.toJSON(),
      model: this.model,
      iterationCount: this.iterationCount,
      reasoningEffort: this.reasoningEffort,
    };
  }

  deserialize(data: Record<string, unknown>): void {
    this.sessionId = data.sessionId as string;
    this.context.replaceMessages(
      (data.context as Array<Record<string, unknown>>).map((m) => Message.fromJSON(m)),
    );
    this.model = data.model as string;
    this.iterationCount = (data.iterationCount as number) || 0;
    this.reasoningEffort = data.reasoningEffort as string | undefined;
  }
}
