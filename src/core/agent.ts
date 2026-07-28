// Agent - the core AI agent with tool calling support.

import { Message, type ImageAttachment } from "./context/message.ts";
import { MessageLog } from "./context/message-log.ts";
import {
  OUTPUT_EVENT,
  OutputEvent,
  OutputEventType,
  UserMessageEvent,
  AssistantMessageEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
  CompactingEvent,
  CommandResultEvent,
  QuestionEvent,
  StreamingChunkEvent,
  StreamingReasoningChunkEvent,
  TaskProgressEvent,
  TokenUsageEvent,
  CompactionResultEvent,
  SessionStateEvent,
} from "./context/output.ts";
/**
 * Map event type strings to OUTPUT_EVENT constants.
 */
const EVENT_TYPE_MAP: Record<string, OutputEventType> = {
  user_message: OUTPUT_EVENT.USER_MESSAGE,
  assistant_message: OUTPUT_EVENT.ASSISTANT_MESSAGE,
  thinking: OUTPUT_EVENT.THINKING,
  tool_call: OUTPUT_EVENT.TOOL_CALL,
  tool_result: OUTPUT_EVENT.TOOL_RESULT,
  compacting: OUTPUT_EVENT.COMPACTING,
  command_result: OUTPUT_EVENT.COMMAND_RESULT,
  question: OUTPUT_EVENT.QUESTION,
  streaming_chunk: OUTPUT_EVENT.STREAMING_CHUNK,
  streaming_reasoning_chunk: OUTPUT_EVENT.STREAMING_REASONING_CHUNK,
  task_progress: OUTPUT_EVENT.TASK_PROGRESS,
  token_usage: OUTPUT_EVENT.TOKEN_USAGE,
  compaction_result: OUTPUT_EVENT.COMPACTION_RESULT,
  session_state: OUTPUT_EVENT.SESSION_STATE,
};

type EventTypeName = keyof typeof EVENT_TYPE_MAP;

/**
 * Typed data for each event type string.
 * Maps event names to their data shape for type-safe emitOutput calls.
 */
interface OutputEventData {
  user_message: { content: string };
  assistant_message: { content: string };
  thinking: { content: string };
  tool_call: { toolName: string; input: string; toolCallId: string };
  tool_result: { toolName: string; input: string; result: string; toolCallId: string; error?: string };
  compacting: { message?: string };
  command_result: { content: string };
  question: {
    questions: Array<{
      key: string;
      prompt: string;
      options?: string[];
      required?: boolean;
      default?: string;
      allow_other?: boolean;
    }>;
  };
  streaming_chunk: { content: string };
  streaming_reasoning_chunk: { content: string };
  task_progress: { taskId: string; status: string; message?: string };
  token_usage: TokenUsage;
  compaction_result: { messagesCompacted: number; tokensBefore: number; tokensAfter: number; strategy: string; summary?: string };
  session_state: { key: string; value: unknown; sessionId?: string };
}

import { AgentError, ConfigError, LlmError } from "./error.ts";
import { HOOKS, HookSystem, type ContextHookResult, type ProviderRequestHookResult } from "./hooks.ts";
import { isPromise } from "../utils/promise.ts";
import { ACTIONS, ParsedCommand, Command } from "./commands.ts";
import { createCommandRegistry, AgentCommandRegistry, type CommandResult } from "./extensions/registries.ts";
import { CORE_COMMAND_HANDLERS } from "./command-handlers.ts";
import { resolveModelConfig, type ModelConfig } from "./config/providers.ts";
export type { ModelConfig } from "./config/providers.ts";
import { type CoreConfig } from "./config/schema-loader.ts";

import { createSystemPromptBuilder } from "./context/system-prompt.ts";
import { TokenTracker, createTokenTracker, type TokenUsage, type RawUsage } from "./token-tracker.ts";
import { ToolExecutor, createToolExecutor, type ToolResult as ToolExecutorResult } from "./tool-executor.ts";

import type { LlmClient, StreamEvent } from "./llm-client/client.ts";
import {
  createStreamProcessor,
  StreamProcessor,
  type StreamResult,
} from "./llm-client/stream-processor.ts";
import type { ToolRegistry, ToolDef } from "./extensions/tool-registry.ts";
import type { SystemPromptBuilder } from "./context/system-prompt.ts";
import type { ToolCall } from "./context/message.ts";

export type { StreamEvent } from "./llm-client/client.ts";

export interface ModelRegistry {
  [key: string]: ModelConfig;
}

/**
 * Result of an agent run loop execution.
 */
export type AgentRunResult =
  | { type: 'completion'; content: string }
  | { type: 'tool_return'; outcome: string };

/**
 * Parameters for an LLM request.
 */
interface LlmRequestParams {
  messages: Message[];
  modelConfig: ModelConfig;
  toolDefs: ToolDef[];
}

/**
 * Typed model registry — maps model name to ModelConfig.
 */
export type TypedModelRegistry = Record<string, ModelConfig>;

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
  systemPromptBuilder?: SystemPromptBuilder;
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
export class Agent {
  hooks: HookSystem;
  #toolRegistry: ToolRegistry;
  llmClient: LlmClient;
  log: MessageLog;
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
  #tokenTracker: TokenTracker;
  #systemPromptBuilder: SystemPromptBuilder;
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
    this.log = new MessageLog();
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
    // (initialized after this.emitOutput / this.addMessage are available as bound methods)
    this.#toolExecutor = createToolExecutor({
      toolRegistry: options.toolRegistry,
      hooks: options.hooks,
      addMessage: (msg) => this.addMessage(msg),
      emitOutput: (type, data) => this.emitOutput(type, data),
      toolWhitelist: options.toolWhitelist || null,
      cwdBoundary: options.config?.cwdBoundary || null,
      workspaceRoot: options.config?.workspaceRoot || null,
      maxRetries: options.config?.maxRetries ?? 3,
      toolRetryDelay: options.config?.toolRetryDelay ?? 1,
      isRestoring: () => this.#isRestoring,
      agent: this,
    });
    // Token usage tracking — accumulates session totals and saves last-reported values.
    this.#tokenTracker = createTokenTracker();
    // System prompt builder — manages system prompt lifecycle
    this.#systemPromptBuilder =
      options.systemPromptBuilder || createSystemPromptBuilder();
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
    this.hooks.notifyHooks(HOOKS.MODEL_CHANGE, {
      agent: this,
      oldModel,
      newModel: v,
    });
    // Emit through the output sink so connected WS clients get notified
    if (this.sink) {
      this.sink.emit({
        type: OUTPUT_EVENT.SESSION_STATE,
        key: "model",
        value: v,
      });
    }
  }

  get isRestoring(): boolean {
    return this.#isRestoring;
  }

  /** Get the tool registry. Used by hooks for tool metadata access. */
  get toolRegistry(): ToolRegistry {
    return this.#toolRegistry;
  }
  set isRestoring(v: boolean) {
    const oldVal = this.#isRestoring;
    this.#isRestoring = v;
    if (oldVal !== v) {
      this.hooks.notifyHooks(HOOKS.SESSION_RESTORE_ACTIVE, {
        agent: this,
        isRestoring: v,
      });
    }
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

  /** Get the current system prompt (from the builder's cache). */
  get systemPrompt(): string | null {
    return this.#systemPromptBuilder.getPrompt();
  }

  /** Get token usage for this session — both accumulated totals and the last-reported values from the provider. */
  getTokenUsage(): TokenUsage {
    return this.#tokenTracker.getUsage();
  }

  /**
   * Enqueue a message on the owning MessageBus for later processing.
   * No-op if no enqueue callback is configured (e.g., standalone agent).
   * Used by extensions (via hooks) to queue follow-up messages.
   *
   * @param text — Message text to enqueue
   */
  enqueue(text: string): void {
    if (this.enqueueCallback) {
      this.enqueueCallback(text);
    }
  }

  // ── Run Loop ──────────────────────────────────────────────────────────────

  /**
   * Run the agent loop with the given user input.
   * @param userInput — Text content of the user message
   * @param images — Optional images
   *   Each image: { type: "image_url", mimeType: "image/png", data: "<base64>" }
   * @returns Final run result, or undefined if input was empty.
   */
  async run(userInput: string, images?: ImageAttachment[]): Promise<AgentRunResult | undefined> {
    if (!userInput?.trim() && (!images || images.length === 0)) {
      return undefined;
    }

    let stoppedEmitted = false;

    try {
      await this.ensureSystemPrompt();

      const userMsg = new Message({ role: "user", content: userInput, images });
      this.addMessage(userMsg);
      this.emitOutput("user_message", { content: userInput });

      let iteration = 0;
      while (iteration < this.maxIterations) {
        iteration++;
        this.iterationCount = iteration;

        const params = await this._prepareIteration(iteration);
        const response = await this._performLlmCall(params);
        const result = await this._handleLlmResponse(iteration, response, params.modelConfig);

        if (typeof result === "string") {
          stoppedEmitted = true;
          return { type: 'completion', content: result };
        } else if (result && typeof result === "object" && "outcome" in result) {
          const { outcome } = result as { outcome: string };
          if (outcome !== "continue") {
            stoppedEmitted = true;
            return { type: 'tool_return', outcome };
          }
        }
      }
      throw AgentError.MaxIterations(this.maxIterations);
    } finally {
      if (!stoppedEmitted) {
        this._emitTurnEnd(this.iterationCount, "", [], true, this.cancelled);
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
      this.runAbortController.abort();
    } else if (this.abortSignal) {
      this.abortSignal.addEventListener("abort", () => this.runAbortController!.abort(), { once: true });
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
  ): Promise<string | { outcome: string; toolResults: ToolExecutorResult[] }> {
    this.hooks.notifyHooks(HOOKS.PROVIDER_RESPONSE, { response, modelConfig, agent: this });
    this.hooks.notifyHooks(HOOKS.MESSAGES_AFTER_LLM, { response, messages: this.log.getAll(), agent: this });

    const assistantMsg = new Message({
      role: "assistant",
      content: response.fullText,
      reasoningContent: response.fullReasoning,
      toolCalls: response.finalToolCalls,
    });
    this.addMessage(assistantMsg);

    if (response.finalToolCalls) {
      let toolCallsToExecute = response.finalToolCalls;
      let skippedToolResults: ToolExecutorResult[] = [];

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

      const finalResults: ToolExecutorResult[] = [...toolResults, ...skippedToolResults];

      this._emitTokenUsage(response);
      this._emitTurnEnd(iteration, response.fullText, finalResults, outcome === "return");
      return { outcome, toolResults: finalResults };
    } else {
      this._emitTokenUsage(response);
      this.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, { message: assistantMsg, agent: this });
      this._emitTurnEnd(iteration, response.fullText, [], true);
      return response.fullText;
    }
  }

  private _emitTurnEnd(iteration: number, message: string, toolResults: Array<{ toolName: string; input: string; result: string }>, stopped: boolean, cancelled = false) {
    this.hooks.notifyHooks(HOOKS.TURN_END, {
      turnIndex: iteration,
      message,
      toolResults,
      stopped,
      cancelled,
      agent: this,
    });
  }

  /** Emit token usage — delegates to TokenTracker for accumulation and emits the event. */
  _emitTokenUsage(response: { usage?: RawUsage | null }): void {
    this.#tokenTracker.record(response.usage, (usage) => {
      this.emitOutput("token_usage", usage);
    });
  }

  /**
   * Called when the agent completes (for task agents).
   * @param result - The final result text
   */
  notifyCompletion(result: string): void {
    if (this.sink && typeof (this.sink as OutputSink & { onTaskComplete?: (result: string) => void }).onTaskComplete === "function") {
      (this.sink as OutputSink & { onTaskComplete: (result: string) => void }).onTaskComplete!(result);
    }
  }

  /**
   * Build messages array: system prompt + context.
   * System prompt is built via hooks (extensions add to it).
   * Public so extensions can rebuild messages after modifying context
   * (e.g., compaction).
   * @returns Array of messages.
   */
  buildMessages(): Message[] {
    return this.log.buildMessages(this.#systemPromptBuilder.getPrompt());
  }

  /**
   * Ensure system prompt is built and cached.
   * Extensions contribute chunks via the SYSTEM_PROMPT_BUILD hook.
   * Chunks are sorted by priority and rendered via the template.
   */
  async ensureSystemPrompt(): Promise<void> {
    await this.#systemPromptBuilder.ensureBuilt(this.hooks, this, {
      role: this.role,
      profileBody: this.profileBody,
      model: this.#model,
      profileName: this.profileName,
    });
  }

  // ── Stream Processing ─────────────────────────────────────────────────────

  /**
   * Process a streaming LLM response.
   * Delegates to StreamProcessor.
   *
   * @param stream - The stream of events from the LLM client.
   * @returns The complete stream result.
   */
  async _processStream(
    stream: AsyncIterable<StreamEvent>,
  ): Promise<StreamResult> {
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

  // ── Tool Execution ────────────────────────────────────────────────────────
  // Delegated to ToolExecutor for independent testability.

  /**
   * Execute tool calls from an LLM response.
   * Delegates to ToolExecutor.
   *
   * @param toolCalls
   * @returns { outcome: 'continue' | 'return', toolResults }
   */
  async _executeTools(
    toolCalls: ToolCall[],
  ): Promise<{ outcome: "continue" | "return"; toolResults: ToolExecutorResult[] }> {
    return this.#toolExecutor.execute(toolCalls);
  }

  // ── Public Context API ────────────────────────────────────────────────────

  /**
   * Add a single message to the agent's context.
   * Fires the CONTEXT_MESSAGE hook so extensions (session-log, etc.) are notified.
   * Use this instead of directly pushing to _log.
   *
   * @param msg - The message to add.
   */
  addMessage(msg: Message): void {
    this.log.push(msg);
    this.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, {
      message: msg,
      agent: this,
    });
  }

  /**
   * Replace the entire context array.
   * Fires the CONTEXT_REPLACED hook so extensions can react to the replacement.
   * Used by compaction and other context-modifying operations.
   *
   * @param newContext - The new context array (array of Message instances).
   */
  replaceContext(newContext: Message[]): void {
    const oldContext = this.log.getAll();
    this.log.replace(newContext);
    this.hooks.notifyHooks(HOOKS.CONTEXT_REPLACED, {
      agent: this,
      oldContext,
      newContext,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Emit a typed output event.
   * @param type - Event type name (e.g., "user_message", "tool_call").
   * @param data - Typed data matching the event type.
   */
  emitOutput(type: EventTypeName, data: Record<string, unknown>): void {
    const eventType = EVENT_TYPE_MAP[type];
    if (this.sink && eventType) {
      this.sink.emit({ type: eventType, ...data } as OutputEvent);
    }
    this.hooks.notifyHooks(HOOKS.OUTPUT_EVENT, { type, data, agent: this });
  }

  // ── Session Management ────────────────────────────────────────────────────

  /**
   * Clear the context and start fresh.
   */
  async clearContext(): Promise<void> {
    this.log.clear();
    this.#systemPromptBuilder.clear();
    this.iterationCount = 0;
    this.#tokenTracker.clear();
  }

  /**
   * Cancel the current run.
   */
  cancel(): void {
    this.cancelled = true;
    // Abort the active LLM request so the HTTP client terminates fetch().
    if (this.runAbortController && !this.runAbortController.signal.aborted) {
      this.runAbortController.abort();
    }
  }

  /** Reset the cancelled flag so the agent can process new input. */
  resetCancel(): void {
    this.cancelled = false;
  }

  /**
   * Get tool definitions filtered by the agent's current config.
   * Applies sandboxMode and maxToolDifficulty filtering.
   * Priority for maxToolDifficulty: CLI > model config > config default.
   */
  async getToolDefs(): Promise<ToolDef[]> {
    const config = this.config;
    if (!config) {
      return await this.#toolRegistry.getToolDefs();
    }

    const sandboxMode = config.sandboxMode ?? false;

    // Resolve effective maxToolDifficulty with priority:
    // 1. CLI override (maxToolDifficulty)
    // 2. Model-specific config from modelRegistry
    // 3. Config-file default (defaultMaxToolDifficulty)
    const effectiveMaxDifficulty =
      config.maxToolDifficulty ??
      this.modelRegistry[this.#model]?.maxToolDifficulty ??
      config.defaultMaxToolDifficulty ??
      undefined;

    // If no filtering needed, return all tool defs
    if (!sandboxMode && effectiveMaxDifficulty == null) {
      return await this.#toolRegistry.getToolDefs();
    }

    const filteredRegistry = this.#toolRegistry.filterByMetadata({
      maxDifficulty: effectiveMaxDifficulty,
      allowSideEffects: !sandboxMode,
    });
    return await filteredRegistry.getToolDefs();
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
    // Custom command with inline handler (from parseCommand registry match)
    if (cmd._customCommand && cmd._handler) {
      const result = await cmd._handler(this, cmd.value, cmd);
      if (result) return result;
    }

    // COMMAND_DISPATCH hook — extensions can handle specific commands.
    const pipelineResult = await this.hooks.runHookPipeline<CommandResult>(
      HOOKS.COMMAND_DISPATCH,
      { command: cmd, agent: this },
    );
    const lastResult = pipelineResult.lastResult;
    if (isPromise(lastResult)) {
      const awaited = await lastResult;
      if (awaited) return awaited;
    } else if (lastResult) {
      return lastResult;
    }

    // Look up handler from command registry by command type.
    // Built-in commands are registered during construction;
    // extensions also register commands via COMMANDS_REGISTER hook.
    const registered = this.commandRegistry.get(cmd.type);
    if (registered && registered.handler) {
      return await registered.handler(this, cmd.value, cmd);
    }

    return { action: ACTIONS.ERROR, error: `Unknown command: ${cmd.type}` };
  }

  /**
   * Serialize the agent state for persistence.
   * @returns Serialized state object.
   */
  serialize(): Record<string, unknown> {
    return {
      sessionId: this.sessionId,
      context: this.log.toJSON(),
      model: this.model,
      iterationCount: this.iterationCount,
      reasoningEffort: this.reasoningEffort,
    };
  }

  /**
   * Deserialize agent state from persisted data.
   * @param data
   */
  deserialize(data: Record<string, unknown>): void {
    this.sessionId = data.sessionId as string;
    this.log.replace(
      (data.context as Array<Record<string, unknown>>).map(
        (m: Record<string, unknown>) => Message.fromJSON(m),
      ),
    );
    this.model = data.model as string;
    this.iterationCount = (data.iterationCount as number) || 0;
    this.reasoningEffort = data.reasoningEffort as string | undefined;
  }
}
