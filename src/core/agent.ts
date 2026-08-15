// Agent - the core AI agent with tool calling support.

import { ParsedCommand } from "./commands.ts";
import { CORE_COMMAND_HANDLERS } from "./command-handlers.ts";
import { resolveModelConfig, type ModelConfig } from "./config/providers.ts";
import { Message, type ImageAttachment, type ToolCall } from "./context/message.ts";
import { OUTPUT_EVENT, OutputEvent, EVENT_NAME_MAP, type EventName } from "./context/output.ts";
import { createContextManager, type ContextManager } from "./context/context-manager.ts";
import { AgentError, ConfigError, LlmError } from "./error.ts";
import type { LlmClient, StreamEvent } from "./llm-client/client.ts";
import { createStreamProcessor, StreamProcessor, type StreamResult } from "./llm-client/stream-processor.ts";
import { createCommandRegistry, AgentCommandRegistry, type CommandResult } from "./extensions/registries.ts";
import type { ToolRegistry, ToolDef } from "./extensions/tool-registry.ts";
import { HOOKS, HookSystem, type ContextHookResult, type ProviderRequestHookResult } from "./hooks.ts";
import { type RawUsage } from "./token-tracker.ts";
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
  | "continue"        // tool calls ran; the loop advances to the next iteration
  | "cancelled"       // run was cancelled
  | "error"           // an unexpected exception aborted the turn
  | "max_iterations"; // iteration cap reached

/** Result of an agent run loop execution. */
export type AgentRunResult =
  | { type: 'completion'; content: string }
  | { type: 'tool_return'; outcome: string };

/**  Parameters for an LLM request. */
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
 * The subset of config keys that the Agent class actually reads.
 * Extensions may read additional keys via core.config.
 */
export interface AgentConfig {
  cwdBoundary?: string | null;
  workspaceRoot?: string | null;
  maxToolCallsPerIteration?: number;
  maxRetries?: number;
  toolRetryDelay?: number;
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
  role?: string;
  profileBody?: string;
  stream?: boolean;
  abortSignal?: AbortSignal | null;
  toolWhitelist?: string[] | null;
  commandRegistry?: AgentCommandRegistry;
  /**
   * Optional callback to enqueue a message on the owning MessageBus.
   * Set by the MessageBus after agent construction so the agent (and
   * extensions via hooks) can queue messages for later processing.
   */
  enqueueCallback?: (text: string) => void;
}

/**
 * Agent that runs the LLM loop and delegates behavior to hooks.
 */
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
  role: string | undefined;
  profileBody: string | undefined;
  stream: boolean;
  cancelled: boolean;
  iterationCount: number;
  maxToolCallsPerIteration: number;
  reasoningEffort: string | undefined;
  #isRestoring: boolean;
  abortSignal: AbortSignal | null;
  toolWhitelist: string[] | null;
  followQueue: string[];
  runAbortController: AbortController | null;
  commandRegistry: AgentCommandRegistry;
  #toolExecutor: ToolExecutor;
  #streamProcessor: StreamProcessor;
  enqueueCallback: ((text: string) => void) | null;

  constructor(options: AgentOptions) {
    if (options.maxIterations == null) {
      throw ConfigError.MissingConfig("maxIterations");
    }
    if (options.contextLimit == null) {
      throw ConfigError.MissingConfig("contextLimit");
    }
    this.hooks = options.hooks;
    this.#toolRegistry = options.toolRegistry;
    this.llmClient = options.llmClient;
    // Context manager — owns message storage, token tracking, and system prompt.
    this.context = createContextManager();
    this.#model = options.model;
    this.maxIterations = options.maxIterations;
    this.contextLimit = options.contextLimit;
    this.hideTools = options.hideTools !== false;
    this.hideThinking = options.hideThinking === true;
    this.sink = options.sink || null;
    this.modelRegistry = options.modelRegistry || {};
    this.profileName = options.profileName;
    this.config = options.config || null;
    this.sessionId = options.sessionId || crypto.randomUUID();
    this.role = options.role;
    this.profileBody = options.profileBody;
    this.stream = options.stream !== false;
    this.cancelled = false;
    this.iterationCount = 0;
    this.maxToolCallsPerIteration = options.config?.maxToolCallsPerIteration ?? 10;
    this.reasoningEffort = undefined;
    this.#isRestoring = false;
    // Task agent support
    this.abortSignal = options.abortSignal || null;
    this.toolWhitelist = options.toolWhitelist || null;
    this.followQueue = [];
    // AbortController for the current LLM request — created per iteration,
    // aborted on cancel() so the HTTP client properly terminates fetch().
    this.runAbortController = null;
    // Stream processor — handles streaming LLM responses
    this.#streamProcessor = createStreamProcessor({ stream: this.stream });
    // Command registry — extensions register commands here
    this.commandRegistry = options.commandRegistry || createCommandRegistry();
    // Register core built-in commands with their handlers
    for (const [type, def] of Object.entries(CORE_COMMAND_HANDLERS)) {
      this.commandRegistry.register(type, def);
    }
    // Tool executor — runs the full tool call pipeline
    this.#toolExecutor = createToolExecutor({
      context: this.context,
      toolRegistry: options.toolRegistry,
      hooks: options.hooks,
      emitOutput: (type, data) => this.emitOutput(type, data),
      toolWhitelist: options.toolWhitelist || null,
      cwdBoundary: options.config?.cwdBoundary || null,
      workspaceRoot: options.config?.workspaceRoot || null,
      maxRetries: options.config?.maxRetries ?? 3,
      toolRetryDelay: options.config?.toolRetryDelay ?? 1,
      isRestoring: () => this.#isRestoring,
      agent: this,
    });
    // Enqueue callback — set by the owning MessageBus so the agent
    // (and extensions via hooks) can queue messages for processing.
    this.enqueueCallback = options.enqueueCallback || null;
  }

  // ── Properties ────────────────────────────────────────────────────────────

  get model(): string {
    return this.#model;
  }
  set model(v: string) {
    const oldModel = this.#model;
    this.#model = v;
    // Pull in the new model's config from the registry
    const entry = this.modelRegistry[v];
    if (entry) {
      this.contextLimit = (entry.contextLimit as number) ?? this.contextLimit;
      // Reset reasoning effort to the new model's default —
      // the user can re-override via /reasoning if needed.
      this.reasoningEffort = entry.reasoningEffort as string | undefined;
    }
    // Clear tool def cache — different models may have different tool
    // requirements or capabilities, so stale definitions would be incorrect.
    this.#toolRegistry.clearToolDefs();
    this.hooks.notifyHooks(HOOKS.MODEL_CHANGE, { agent: this, oldModel, newModel: v });
    // Emit through the output sink so connected WS clients get notified
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

  /** Get the tool registry. Used by hooks for tool metadata access. */
  get toolRegistry(): ToolRegistry {
    return this.#toolRegistry;
  }

  /**
   * Get the accumulated partial content of the currently streaming response.
   * Empty string if not currently streaming. Used by reconnecting clients
   * to replay content that was streamed before they connected.
   */
  get currentStreamingContent(): string {
    return this.#streamProcessor.streamingContent;
  }

  /**
   * Get the accumulated partial reasoning content of the currently streaming response.
   * Empty string if not currently streaming.
   */
  get currentStreamingReasoning(): string {
    return this.#streamProcessor.streamingReasoning;
  }

  /** Get the message log (backwards compatibility — prefer context.getMessages()). */
  get log() {
    return this.context.log;
  }

  /**
   * Enqueue a message on the owning MessageBus for later processing.
   * No-op if no enqueue callback is configured (e.g., standalone agent).
   * Used by extensions (via hooks) to queue follow-up messages.
   */
  enqueue(text: string): void {
    this.enqueueCallback?.(text);
  }

  // ── Run Loop ──────────────────────────────────────────────────────────────

  /**
   * Run the agent loop with the given user input.
   * @param userInput — Text content of the user message
   * @param images — Optional images, Array<{ type: "image_url", mimeType: "image/png", data: "<base64>" }>
   * @returns Final run result, or undefined if input was empty.
   */
  async run(userInput: string, images?: ImageAttachment[]): Promise<AgentRunResult | undefined> {
    if (!userInput?.trim() && (!images || images.length === 0)) {
      return;
    }

    let turnEnded = false;
    try {
      await this.ensureSystemPrompt();

      const userMsg = new Message({ role: "user", content: userInput, images });
      this.addMessage(userMsg);
      this.emitOutput("user_message", { content: userInput });

      let iteration = 0;
      while (iteration < this.maxIterations) {
        iteration++;
        this.iterationCount = iteration;
        turnEnded = false;

        const params = await this._prepareIteration(iteration);
        const response = await this._performLlmCall(params);
        const result = await this._handleLlmResponse(iteration, response, params.modelConfig);

        if (typeof result === "string") {
          // Normal completion — the model returned final text.
          this._emitTurnEnd(iteration, response.fullText, [], true, this.cancelled, "completion");
          turnEnded = true;
          return { type: 'completion', content: result };
        }

        const { outcome, toolResults } = result;
        if (outcome !== "continue") {
          // Tool-return — a tool signaled stopLoop.
          this._emitTurnEnd(iteration, response.fullText, toolResults, true, this.cancelled, "tool_return");
          turnEnded = true;
          return { type: 'tool_return', outcome };
        }

        // Continue — tool calls ran; the loop advances to the next iteration.
        this._emitTurnEnd(iteration, response.fullText, toolResults, false, this.cancelled, "continue");
        turnEnded = true;
      }

      // Hit the iteration cap — emit turn-end so listeners unblock, then throw.
      this._emitTurnEnd(this.iterationCount, "", [], true, this.cancelled, "max_iterations");
      turnEnded = true;
      throw AgentError.MaxIterations(this.maxIterations);
    } finally {
      if (!turnEnded) {
        const reason: TurnEndReason = this.cancelled ? "cancelled" : "error";
        this._emitTurnEnd(this.iterationCount, "", [], true, this.cancelled, reason);
      }
    }
  }

  private async _prepareIteration(iteration: number): Promise<LlmRequestParams> {
    this.hooks.notifyHooks(HOOKS.TURN_START, {
      turnIndex: iteration,
      timestamp: Date.now(),
      agent: this,
    });

    if (this.cancelled) throw LlmError.Cancelled("Agent cancelled");
    if (this.abortSignal?.aborted) throw LlmError.Cancelled("Agent aborted");

    while (this.followQueue.length > 0) {
      const followUp = this.followQueue.shift()!;
      this.addMessage(new Message({ role: "user", content: followUp }));
      this.emitOutput("user_message", { content: followUp });
    }

    let messages = this.buildMessages();
    const contextResult = await this.hooks.runHookPipeline<ContextHookResult>(HOOKS.CONTEXT, {
      messages,
      agent: this,
    });
    if (contextResult.lastResult?.messages) {
      messages = contextResult.lastResult.messages;
    }

    let toolDefs = await this.getToolDefs();
    let modelConfig = resolveModelConfig(
      this.#model,
      this.modelRegistry,
      this.contextLimit,
      this.reasoningEffort,
    );

    const reqResult = await this.hooks.runHookPipeline<ProviderRequestHookResult>(
      HOOKS.PROVIDER_REQUEST,
      { messages, modelConfig, toolDefs, agent: this },
    );
    if (reqResult.lastResult?.messages) messages = reqResult.lastResult.messages;
    if (reqResult.lastResult?.modelConfig) modelConfig = reqResult.lastResult.modelConfig;
    if (reqResult.lastResult?.toolDefs) toolDefs = reqResult.lastResult.toolDefs;

    return { messages, modelConfig, toolDefs };
  }

  private async _performLlmCall(params: LlmRequestParams): Promise<StreamResult> {
    const { messages, modelConfig, toolDefs } = params;
    this.runAbortController = new AbortController();
    const cancelSignal = this.runAbortController.signal;

    if (this.abortSignal?.aborted) {
      this.cancelled = true;
      this.runAbortController.abort();
    } else if (this.abortSignal) {
      this.abortSignal.addEventListener(
        "abort",
        () => {
          this.cancelled = true;
          this.runAbortController!.abort();
        },
        { once: true },
      );
    }

    try {
      const stream = this.llmClient.chatStreamCancellable(
        messages.map((m) => m.toJSON()),
        modelConfig,
        toolDefs,
        cancelSignal,
        this.sessionId,
      );
      return await this._processStream(stream);
    } finally {
      this.runAbortController = null;
    }
  }

  private async _handleLlmResponse(
    iteration: number,
    response: StreamResult,
    modelConfig: ModelConfig,
  ): Promise<string | { outcome: string; toolResults: ToolResult[] }> {
    this.hooks.notifyHooks(HOOKS.PROVIDER_RESPONSE, { response, modelConfig, agent: this });
    this.hooks.notifyHooks(HOOKS.MESSAGES_AFTER_LLM, { response, messages: this.context.getMessages(), agent: this });

    const assistantMsg = new Message({
      role: "assistant",
      content: response.fullText,
      reasoningContent: response.fullReasoning,
      toolCalls: response.finalToolCalls,
    });
    this.addMessage(assistantMsg);
    this._emitTokenUsage(response);

    if (response.finalToolCalls) {
      let toolCallsToExecute = response.finalToolCalls;
      let skippedToolResults: ToolResult[] = [];

      if (toolCallsToExecute.length > this.maxToolCallsPerIteration) {
        const truncated = toolCallsToExecute.slice(0, this.maxToolCallsPerIteration);
        const skipped = toolCallsToExecute.slice(this.maxToolCallsPerIteration);

        toolCallsToExecute = truncated;
        skippedToolResults = skipped.map((tc) => ({
          toolName: tc.function?.name || "(unknown)",
          input: tc.function?.arguments || "{}",
          result: `Skipped due to maxToolCallsPerIteration limit (${this.maxToolCallsPerIteration})`,
          toolCallId: tc.id,
        }));
      }

      const { outcome, toolResults } = await this._executeTools(toolCallsToExecute);

      // Add skipped tool results to the conversation log and emit them
      for (const sr of skippedToolResults) {
        this.addMessage(new Message({
          role: "tool",
          content: sr.result,
          toolCallId: sr.toolCallId,
        }));
        this.emitOutput("tool_result", {
          toolName: sr.toolName,
          input: sr.input,
          result: sr.result,
          toolCallId: sr.toolCallId,
        });
      }

      const finalResults = [...toolResults, ...skippedToolResults];

      return { outcome, toolResults: finalResults };
    } else {
      this.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, { message: assistantMsg, agent: this });
      return response.fullText;
    }
  }

  private _emitTurnEnd(
    iteration: number,
    message: string,
    toolResults: Array<ToolResult>,
    stopped: boolean,
    cancelled = false,
    reason: TurnEndReason,
  ) {
    this.hooks.notifyHooks(HOOKS.TURN_END, {
      turnIndex: iteration,
      message,
      toolResults,
      stopped,
      cancelled,
      reason,
      agent: this,
    });
  }

  /** Emit token usage — delegates to ContextManager for accumulation and emits the event. */
  _emitTokenUsage(response: { usage?: RawUsage | null }): void {
    this.context.recordUsage(response.usage, (usage) => { this.emitOutput("token_usage", usage) });
  }

  /**
   * Called when the agent completes (for task agents).
   * @param result - The final result text
   */
  notifyCompletion(result: string): void {
    this.sink?.onTaskComplete?.(result);
  }

  /**
   * Build messages array: system prompt + context.
   * System prompt is built via hooks (extensions add to it).
   * Public so extensions can rebuild messages after modifying context.
   */
  buildMessages(): Message[] {
    return this.context.buildForLlmCall();
  }

  /** Ensure system prompt is built and cached. */
  async ensureSystemPrompt(): Promise<void> {
    await this.context.ensureSystemPrompt(this.hooks, this, {
      role: this.role,
      profileBody: this.profileBody,
      model: this.#model,
      profileName: this.profileName,
    });
  }

  /**
   * Process a streaming LLM response, delegates to StreamProcessor.
   *
   * @param stream - The stream of events from the LLM client.
   * @returns The complete stream result.
   */
  async _processStream(stream: AsyncIterable<StreamEvent>): Promise<StreamResult> {
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
    });
  }

  /** Execute tool calls from an LLM response. */
  async _executeTools(toolCalls: ToolCall[]) {
    return this.#toolExecutor.execute(toolCalls);
  }

  /**
   * Add a single message to the agent's context. Use this instead of directly pushing to the message log.
   * Fires the CONTEXT_MESSAGE hook so extensions (session-log, etc.) are notified.
   */
  addMessage(msg: Message): void {
    this.context.addMessage(msg);
    this.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, { message: msg, agent: this });
  }

  /**
   * Replace the entire context array.
   * Fires the CONTEXT_REPLACED hook so extensions can react to the replacement.
   * Used by compaction and other context-modifying operations.
   *
   * @param newContext - The new context array (array of Message instances).
   */
  replaceContext(newContext: Message[]): void {
    const oldContext = this.context.getMessages();
    this.context.replaceMessages(newContext);
    this.hooks.notifyHooks(HOOKS.CONTEXT_REPLACED, { agent: this, oldContext, newContext });
  }

  /**
   * Emit a typed output event.
   * 
   * @param type - Event type name (e.g., "user_message", "tool_call").
   * @param data - Typed data matching the event type.
   */
  emitOutput(type: EventName, data: Record<string, unknown>): void {
    const eventType = EVENT_NAME_MAP[type];
    if (this.sink && eventType) {
      this.sink.emit({ type: eventType, ...data } as OutputEvent);
    }
    this.hooks.notifyHooks(HOOKS.OUTPUT_EVENT, { type, data, agent: this });
  }

  /** Clear the context and start fresh. */
  async clearContext(): Promise<void> {
    this.context.clear();
    this.iterationCount = 0;
    // Clear tool def cache -- different profiles/models may have different tools
    this.#toolRegistry.clearToolDefs();
  }

  /** Cancel the current run. */
  cancel(): void {
    this.cancelled = true;
    if (this.runAbortController && !this.runAbortController.signal.aborted) {
      this.runAbortController.abort(); // Abort the active LLM request so the HTTP client terminates fetch().
    }
  }

  /** Reset the cancelled flag so the agent can process new input. */
  resetCancel(): void {
    this.cancelled = false;
  }

  /**
   * Get tool definitions filtered by the agent's current config.
   * Applies sandboxMode, maxToolDifficulty, and whitelist/blacklist filtering.
   * Priority for maxToolDifficulty: CLI > model config > config default.
   */
  async getToolDefs(): Promise<ToolDef[]> {
    const config = this.config;

    // Resolve effective maxToolDifficulty with priority:
    // 1. CLI override (maxToolDifficulty)
    // 2. Model-specific config from modelRegistry
    // 3. Config-file default (defaultMaxToolDifficulty)
    const modelEntry = this.#resolveModelEntry();
    const effectiveMaxDifficulty =
      config?.maxToolDifficulty ??
      modelEntry?.maxToolDifficulty ??
      config?.defaultMaxToolDifficulty ??
      undefined;

    // Start with metadata-based filtering (sandbox, difficulty)
    let registry = this.#toolRegistry;
    if (config?.sandboxMode || effectiveMaxDifficulty != null) {
      registry = registry.filterByMetadata({
        maxDifficulty: effectiveMaxDifficulty,
        allowSideEffects: !config?.sandboxMode,
      });
    }

    // Apply whitelist/blacklist filtering at the tool level (before def generation)
    if (this.toolWhitelist && this.toolWhitelist.length > 0) {
      registry = registry.filter(this.toolWhitelist, null);
    }
    const blacklistTools = config?.blacklistTools as string[] | undefined;
    if (blacklistTools && blacklistTools.length > 0) {
      registry = registry.filter(null, blacklistTools);
    }

    return registry.getToolDefs();
  }

  /** Resolve model entry from the registry, handling both "provider/model" and "model" names. */
  #resolveModelEntry(): ModelConfig | undefined {
    let entry = this.modelRegistry[this.#model];
    if (!entry && !this.#model.includes("/")) {
      for (const key of Object.keys(this.modelRegistry)) {
        if (key.endsWith(`/${this.#model}`)) {
          entry = this.modelRegistry[key];
          break;
        }
      }
    }
    return entry;
  }

  /** Get all registered tool names. */
  getToolNames(): string[] {
    return Array.from(this.#toolRegistry.getAll().map(([name]) => name));
  }

  /**
   * Execute a command. Returns { action, content } or { action, error }.
   * Dispatches via: custom handler → extension hooks → command registry.
   * @param cmd - Command object { type, value }
   * @returns Command result
   */
  async executeCommand(cmd: ParsedCommand): Promise<CommandResult | null> {
    return this.commandRegistry.dispatch(cmd, this, this.hooks);
  }

  /**
   * Serialize the agent state for persistence.
   * @returns Serialized state object.
   */
  serialize(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      context: this.context.log.toJSON(),
      model: this.model,
      iterationCount: this.iterationCount,
      reasoningEffort: this.reasoningEffort,
    };
  }

  /** Deserialize agent state from persisted data. */
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
