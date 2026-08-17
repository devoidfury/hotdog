// Agent - the core AI agent with tool calling support.

import { ParsedCommand } from "./commands.ts";
import { CORE_COMMAND_HANDLERS } from "./command-handlers.ts";
import { findModelEntry, resolveModelConfig, type ModelConfig } from "./config/providers.ts";
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

export type AgentRunResult =
  | { type: 'completion'; content: string }
  | { type: 'tool_return'; outcome: string };

interface LlmRequestParams {
  messages: Message[];
  modelConfig: ModelConfig;
  toolDefs: ToolDef[];
}

export interface OutputSink {
  emit(event: OutputEvent): void;
  onTaskComplete?: (result: string) => void;
}

// Subset of config keys read by Agent; extensions read the rest via core.config.
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
  // Set by the owning MessageBus after construction; lets the agent (and extensions via hooks) queue messages.
  enqueueCallback?: (text: string) => void;
}

/** Runs the LLM loop and delegates behavior to hooks. */
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
    if (options.config?.maxToolCallsPerIteration == null) {
      throw ConfigError.MissingConfig("maxToolCallsPerIteration");
    }
    this.maxToolCallsPerIteration = options.config.maxToolCallsPerIteration;
    this.reasoningEffort = undefined;
    this.#isRestoring = false;
    this.abortSignal = options.abortSignal || null;
    this.toolWhitelist = options.toolWhitelist || null;
    this.followQueue = [];
    // Per-iteration AbortController, aborted on cancel() so the HTTP client terminates fetch().
    this.runAbortController = null;
    this.#streamProcessor = createStreamProcessor({ stream: this.stream });
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
    this.#toolExecutor = createToolExecutor({
      toolRegistry: options.toolRegistry,
      hooks: options.hooks,
      emitOutput: (type, data) => this.emitOutput(type, data),
      cwdBoundary: options.config?.cwdBoundary || null,
      workspaceRoot: options.config?.workspaceRoot || null,
      maxRetries: options.config.maxRetries,
      toolRetryDelay: options.config.toolRetryDelay,
      isRestoring: () => this.#isRestoring,
      agent: this,
    });
    this.enqueueCallback = options.enqueueCallback || null;
  }

  // ── Properties ────────────────────────────────────────────────────────────

  get model(): string {
    return this.#model;
  }
  set model(v: string) {
    const oldModel = this.#model;
    this.#model = v;
    const entry = this.modelRegistry[v];
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

  /** @deprecated Prefer context.getMessages(). */
  get log() {
    return this.context.log;
  }

  enqueue(text: string): void {
    this.enqueueCallback?.(text);
  }

  // ── Run Loop ──────────────────────────────────────────────────────────────

  /** Run the agent loop with the given user input; returns undefined if input was empty. */
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
          this._emitTurnEnd(iteration, response.fullText, [], true, this.cancelled, "completion");
          turnEnded = true;
          return { type: 'completion', content: result };
        }

        const { outcome, toolResults } = result;
        if (outcome !== "continue") {
          this._emitTurnEnd(iteration, response.fullText, toolResults, true, this.cancelled, "tool_return");
          turnEnded = true;
          return { type: 'tool_return', outcome };
        }

        this._emitTurnEnd(iteration, response.fullText, toolResults, false, this.cancelled, "continue");
        turnEnded = true;
      }

      // Emit turn-end so listeners unblock before the throw.
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

  _emitTokenUsage(response: { usage?: RawUsage | null }): void {
    this.context.recordUsage(response.usage, (usage) => { this.emitOutput("token_usage", usage) });
  }

  notifyCompletion(result: string): void {
    this.sink?.onTaskComplete?.(result);
  }

  /** Public so extensions can rebuild messages after modifying context. */
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

  private _processStream(stream: AsyncIterable<StreamEvent>): Promise<StreamResult> {
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

  private _executeTools(toolCalls: ToolCall[]) {
    return this.#toolExecutor.execute(toolCalls);
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

  emitOutput(type: EventName, data: Record<string, unknown>): void {
    const eventType = EVENT_NAME_MAP[type];
    if (this.sink && eventType) {
      this.sink.emit({ type: eventType, ...data } as OutputEvent);
    }
    this.hooks.notifyHooks(HOOKS.OUTPUT_EVENT, { type, data, agent: this });
  }

  async clearContext(): Promise<void> {
    this.context.clear();
    this.iterationCount = 0;
    this.#toolRegistry.clearToolDefs();
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
    if (config?.sandboxMode || effectiveMaxDifficulty != null) {
      registry = registry.filterByMetadata({
        maxDifficulty: effectiveMaxDifficulty,
        allowSideEffects: !config?.sandboxMode,
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
