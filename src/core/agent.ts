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
import { ToolExecutor, createToolExecutor, type ToolResult } from "./tool-executor.ts";
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
 * Tool-result body for calls that arrive on a length-stopped response.
 * Streaming accumulates arguments verbatim; a call cut off mid-JSON is unparseable or silently short, executing it is worse than failing.
 */
const TRUNCATED_STOP_TOOL_TEXT =
  "This response hit the output token limit (finish_reason=length), so its tool " +
  "calls were NOT executed -- their arguments may be truncated mid-stream. " +
  "Re-issue the intended tool call now with complete arguments.";

/**
 * Nudge for the empty-response-after-tools stall: the model returned neither
 * text nor tool calls after tool results (a common local-model failure). The
 * notice lands after the empty assistant message, so the context tail is no
 * longer a tool result. Empty turns are budgeted by maxEmptyRetries; once the
 * budget is spent the run stops with the empty_response reason instead of
 * completing empty.
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
 * Branch this session into a new one (the /fork command). Set by the owning SessionManager after construction.
 * left null by sessionless harnesses, where /fork errors.
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
  stream?: boolean;
  abortSignal?: AbortSignal | null;
  toolWhitelist?: string[] | null;
  /** True when the active profile is a manager (controls managerOnly tools). */
  managerProfile?: boolean;
  commandRegistry?: AgentCommandRegistry;
  // Set by the owning MessageBus after construction; lets the agent (and extensions via hooks) queue messages.
  enqueueCallback?: (content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource }) => void;
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
  stream: boolean;
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
  /** Steering messages (see steer()): injected between LLM calls by _prepareIteration. */
  steeringQueue: Array<string | Array<Record<string, unknown>>>;
  runAbortController: AbortController | null;
  commandRegistry: AgentCommandRegistry;
  #toolExecutor: ToolExecutor;
  #streamProcessor: StreamProcessor;
  enqueueCallback: ((content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource }) => void) | null;
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
      // No model anywhere in the resolution chain (CLI --model, profile,
      // env, config default_model, provider models). Failing here -- at
      // agent construction -- keeps model-free subcommands (profiles,
      // sessions) usable with an incomplete config.
      throw new ConfigError(
        "No model configured. Set default_model in your config file, pass --model, or set the HOTDOG_MODEL env var.",
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
    // Seed the window from the registry entry -- per-model context_limit from
    // fetchModels (e.g. llama-swap autoload) only ever lands in the registry;
    // options.contextLimit is the global resolved fallback. Registry entries
    // are built with the same fallback, so this no-ops when the backend
    // provided nothing. Must run after both #model and modelRegistry are set.
    const initialEntry = this.#resolveModelEntry();
    if (initialEntry?.contextLimit != null) {
      this.contextLimit = initialEntry.contextLimit;
    }
    this.profileName = options.profileName;
    this.config = options.config || null;
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.profileBody = options.profileBody;
    this.stream = options.stream !== false;
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
    });
    this.enqueueCallback = options.enqueueCallback || null;
    this.forkSession = null;
  }

  // ── Properties ────────────────────────────────────────────────────────────

  get model(): string {
    return this.#model;
  }
  set model(v: string) {
    const oldModel = this.#model;
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

  enqueue(content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource }): void {
    this.enqueueCallback?.(content, opts);
  }

  /**
   * Queue a steering message: immediate notice for a running (or about-to-run) agent.
   * Drained before every LLM call in _prepareIteration, so it reaches the model mid-turn without landing
   * between an assistant(tool_calls) message and its tool results. This is the in-core append seam (the sibling
   * of the tool-result/system-notice appends); user submission goes through MessageBus.enqueue(..., { steering: true }),
   * which runs the INPUT pipeline first. Task follow-ups use this seam directly (task agents have no bus).
   */
  steer(content: string | Array<Record<string, unknown>>): void {
    this.steeringQueue.push(content);
  }

  // ── Run Loop ──────────────────────────────────────────────────────────────

  /**
   * Run the agent loop with the given user input; returns undefined if input
   * was empty. `userInput` is plain text or content parts (harness callers
   * may embed `untrusted` parts, mangled only at the wire). `opts.source`
   * sets the message's provenance; harness-injected runs become role
   * "harness", all other input is tagged source "user".
   */
  async run(
    userInput: string | Array<Record<string, unknown>>,
    images?: ImageAttachment[],
    opts?: { source?: MessageSource },
  ): Promise<AgentRunResult | undefined> {
    if (!contentToText(userInput).trim() && (!images || images.length === 0)) {
      return;
    }

    // Re-entrancy guard: the loop keeps per-run state on the instance
    // (iterationCount, runAbortController, stream replay buffers). Two
    // overlapping runs -- e.g. an extension calling run() while the bus
    // loop is mid-turn -- would corrupt each other's assembly silently.
    // An "agent" error type means formatError() prints the stack: an
    // overlapping run is a bug, not a runtime condition to recover from.
    if (this.#running) {
      throw AgentError.AlreadyRunning(this.sessionId);
    }
    this.#running = true;

    let turnEnded = false;
    try {
      await this.ensureSystemPrompt();

      // Provenance drives the internal role: harness-injected runs ride
      // role "harness"; everything else is user input.
      const userMsg = new Message({
        role: opts?.source === "harness" ? "harness" : "user",
        content: userInput,
        images,
        source: opts?.source ?? "user",
      });
      this.addMessage(userMsg);
      this.emitOutput("user_message", { content: contentToText(userInput) });

      let iteration = 0;
      // Consecutive empty completions (no text, no tool calls) this run.
      // Any text or tool work resets it, so the budget bounds one stall
      // episode, not the whole run.
      let emptyStreak = 0;
      while (iteration < this.maxIterations) {
        iteration++;
        this.iterationCount = iteration;
        turnEnded = false;

        const params = await this._prepareIteration(iteration);
        let response: StreamResult;
        try {
          response = await this._performLlmCall(params);
        } catch (err) {
          // PROVIDER_ERROR pipeline: a handler (e.g. tool-call-repair dropping a corrupt stored tool call the backend will never accept) can repair the
          // history/params and set retry. Exactly one retry; a second failure propagates.
          const errPayload = { error: err, params, agent: this, retry: false };
          await this.hooks.runHookPipeline<{ retry?: boolean }, "provider:error">(
            HOOKS.PROVIDER_ERROR,
            errPayload,
          );
          if (!errPayload.retry) throw err;
          response = await this._performLlmCall(params);
        }
        // Snapshot the context tail before the assistant message lands: the
        // empty-turn nudge fires only when this request ended on tool results.
        const afterToolResults = this.context.getMessages().at(-1)?.role === "tool";
        const result = await this._handleLlmResponse(response, params);

        if (typeof result === "string") {
          if (!this.cancelled && !result.trim()) {
            emptyStreak++;
            if (emptyStreak <= this.maxEmptyRetries) {
              if (afterToolResults) {
                // Harness notice: persisted via addMessage so the session log records the retry.
                // Only the after-tools variant needs a message: it also breaks the
                // tool-result context tail that some strict chat templates reject.
                this.addMessage(new Message({
                  role: "harness",
                  source: "harness",
                  content: [{ type: "system-notice", text: EMPTY_TURN_NUDGE_TEXT }],
                }));
              }
              await this._emitTurnEnd(iteration, response.fullText, [], false, false, "continue");
              turnEnded = true;
              continue;
            }
            // Re-invoke budget spent: stop honestly instead of completing empty.
            await this._emitTurnEnd(iteration, response.fullText, [], true, false, "empty_response");
            turnEnded = true;
            return { type: "empty_response" };
          }
          emptyStreak = 0;
          await this._emitTurnEnd(iteration, response.fullText, [], true, this.cancelled, "completion");
          turnEnded = true;
          return { type: 'completion', content: result };
        }

        emptyStreak = 0;
        const { outcome, toolResults } = result;
        if (outcome !== "continue") {
          await this._emitTurnEnd(iteration, response.fullText, toolResults, true, this.cancelled, "tool_return");
          turnEnded = true;
          return { type: 'tool_return', outcome };
        }

        await this._emitTurnEnd(iteration, response.fullText, toolResults, false, this.cancelled, "continue");
        turnEnded = true;
      }

      // Graceful capped finish: one tools-off wrap-up call so the model
      // summarizes the partial work instead of the run dying mid-thought
      // (zeroclaw finish_after_max_iterations / opencode max-steps prompt).
      // Costs +1 LLM call, but only on capped runs.
      let capSummary: string | null = null;
      if (!this.cancelled && !this.abortSignal?.aborted && this.iterationCount > 0) {
        capSummary = await this._wrapUpAfterCap();
      }

      // Emit turn-end so listeners unblock before the return/throw.
      await this._emitTurnEnd(this.iterationCount, capSummary ?? "", [], true, this.cancelled, "max_iterations");
      turnEnded = true;
      if (capSummary !== null) {
        return { type: "completion", content: capSummary };
      }
      throw AgentError.MaxIterations(this.maxIterations);
    } finally {
      this.#running = false;
      if (!turnEnded) {
        const reason: TurnEndReason = this.cancelled ? "cancelled" : "error";
        await this._emitTurnEnd(this.iterationCount, "", [], true, this.cancelled, reason);
      }
    }
  }

  /**
   * One tools-off wrap-up call after the iteration cap (see the capped-finish
   * block in run()). Appends a harness notice so the model knows why, builds
   * params through the usual pipelines (compaction and steering still apply),
   * then strips the tool defs so the summary call cannot smuggle in more work.
   * Returns null on any failure -- the caller keeps the MaxIterations error,
   * so a broken wrap-up never masks the cap. No PROVIDER_ERROR retry here:
   * the best-effort call gets exactly one attempt.
   */
  private async _wrapUpAfterCap(): Promise<string | null> {
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
      const params = await this._prepareIteration(this.iterationCount + 1);
      params.toolDefs = [];
      const response = await this._performLlmCall(params);
      if (!response.fullText.trim()) return null;

      // Deliberately not _handleLlmResponse: tool-call-repair could forge
      // calls into the summary, and an assistant tool_calls message without
      // results would poison the wire for strict backends.
      this.addMessage(new Message({
        role: "assistant",
        content: response.fullText,
        reasoningContent: response.fullReasoning,
        source: "model",
      }));
      this._emitTokenUsage(response);
      return response.fullText;
    } catch (e: unknown) {
      // Honest cancellation: a user abort during the wrap-up call cancels
      // the run; it must not be reported as a plain MaxIterations blowout.
      if (LlmError.isCancelled(e)) throw e;
      logger.warn(`[agent] max-iteration wrap-up call failed: ${formatError(e)}`);
      return null;
    }
  }

  private async _prepareIteration(iteration: number): Promise<LlmRequestParams> {
    await this.hooks.notifyHooks(HOOKS.TURN_START, {
      turnIndex: iteration,
      timestamp: Date.now(),
      agent: this,
    });

    if (this.cancelled) throw LlmError.Cancelled("Agent cancelled");
    if (this.abortSignal?.aborted) throw LlmError.Cancelled("Agent aborted");

    while (this.steeringQueue.length > 0) {
      const steering = this.steeringQueue.shift()!;
      this.addMessage(new Message({ role: "user", content: steering, source: "user" }));
      this.emitOutput("user_message", { content: contentToText(steering) });
    }

    let messages = this.buildMessages();
    const contextResult = await this.hooks.runHookPipeline<ContextHookResult | undefined, "context">(
      HOOKS.CONTEXT,
      { messages, agent: this },
    );
    messages = contextResult.data.messages;

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

  private async _performLlmCall(params: LlmRequestParams): Promise<StreamResult> {
    const { messages, modelConfig, toolDefs } = params;
    const runController = new AbortController();
    this.runAbortController = runController;

    // Forward an external abort to this run's controller. The listener is per-run:
    // it closes over runController(not this.runAbortController, which is nulled between runs)
    // and is removed in finally, so it can't accumulate across runs or fire on a cleared controller while idle.
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
      return await this._processStream(stream);
    } finally {
      removeAbortForwarder?.();
      this.runAbortController = null;
    }
  }

  private async _handleLlmResponse(
    response: StreamResult,
    params: LlmRequestParams,
  ): Promise<string | { outcome: string; toolResults: ToolResult[] }> {
    const { modelConfig } = params;
    // handlers may repair/replace the response before it becomes an assistant message and its tool calls execute 
    // (e.g. tool-call-repair recovering markup the backend failed to parse into real tool calls).
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
    this._emitTokenUsage(response);

    if (response.finalToolCalls) {
      let toolCallsToExecute = response.finalToolCalls;
      let skippedToolResults: ToolResult[] = [];

      if (isLengthStop(response.finishReason)) {
        // Streamed arguments may be silently truncated; nothing from this response is safe to run.
        // Fail every call with a re-issue instruction so the wire stays valid (paired tool call & result).
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
      const { outcome, toolResults } = await this._executeTools(
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

      const finalResults = [...toolResults, ...skippedToolResults];

      return { outcome, toolResults: finalResults };
    } else {
      return response.fullText;
    }
  }

  private async _emitTurnEnd(
    iteration: number,
    message: string,
    toolResults: Array<ToolResult>,
    stopped: boolean,
    cancelled = false,
    reason: TurnEndReason,
  ): Promise<void> {
    // One continuation owner per turn end. Handlers that enqueue the next
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

  _emitTokenUsage(response: { usage?: RawUsage | null }): void {
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

  private _processStream(stream: AsyncIterable<StreamEvent>): Promise<StreamResult> {
    // The session mangler unescapes the assembled result once (stream events
    // carry raw wire content; per-chunk unescaping would fossilize aliases
    // split across deltas). onChunk/onReasoning below get per-chunk
    // unescaping for display only.
    return this.#streamProcessor.process(stream, {
      onChunk: (content) => {
        if (this.stream) {
          this.emitOutput("streaming_chunk", { content });
        }
      },
      onReasoning: (content) => {
        if (this.stream) {
          this.emitOutput("streaming_reasoning_chunk", { content });
        }
      },
      shouldCancel: () => this.cancelled,
    }, this.llmClient.markerMangler);
  }

  private _executeTools(toolCalls: ToolCall[], availableToolNames?: string[]) {
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
   * Awaitable: settling means the checkpoint writes are done, so the next message can never race its append past the rewound-context re-appends.
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
   * Applies the profile's body and tool whitelist, resets the tool
   * blacklist to the profile's (an empty profile blacklist clears whatever
   * a top-level config carried), updates the manager-profile flag (which
   * gates managerOnly tools like the subagent tools), and switches the
   * model via the model setter when the profile specifies one (so per-model
   * limits, reasoning effort, and MODEL_CHANGE all update). Invalidates the
   * cached system prompt and tool defs so the next turn rebuilds them from
   * the new profile.
   *
   * Does NOT clear the message log -- callers that want a wipe (e.g. the
   * webui, which asks the user first) call clearContext() separately.
   */
  applyProfile(name: string, profile: SwitchProfile): void {
    this.profileName = name;
    this.profileBody = profile.body || undefined;
    this.toolWhitelist = profile.whitelistTools;
    this.managerProfile = profile.manager === true;
    this.config = this.config || {};
    this.config.blacklistTools = profile.blacklistTools;
    if (profile.model && profile.model !== this.#model) {
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

  cancel(): void {
    this.cancelled = true;
    if (this.runAbortController && !this.runAbortController.signal.aborted) {
      this.runAbortController.abort();
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
