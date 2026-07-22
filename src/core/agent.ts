// Agent - the core AI agent with tool calling support.

import { Message, type ImageAttachment as MessageImageAttachment } from "./context/message.ts";
import { MessageLog } from "./context/message-log.ts";
import { OUTPUT_EVENT, OutputEvent } from "./context/output.ts";
import { AgentError, LlmError } from "./error.ts";
import { HOOKS, HookSystem, type ContextHookResult, type ProviderRequestHookResult } from "./hooks.ts";
import { isPromise } from "../utils/promise.ts";
import { ACTIONS, ParsedCommand, Command } from "./commands.ts";
import { createCommandRegistry, AgentCommandRegistry } from "./extensions/registries.ts";
import { CORE_COMMAND_HANDLERS } from "./command-handlers.ts";
import { resolveModelConfig, type ModelConfig } from "./config/providers.ts";
import { type CoreConfig } from "./config/schema-loader.ts";

import { createSystemPromptBuilder } from "./context/system-prompt.ts";
import { TokenTracker, createTokenTracker, type TokenUsage } from "./token-tracker.ts";
import { ToolExecutor, createToolExecutor } from "./tool-executor.ts";

import type { LlmClient, StreamEvent } from "./llm-client/client.ts";
import {
  createStreamProcessor,
  StreamProcessor,
  type StreamResult,
} from "./llm-client/stream-processor.ts";
import type { ToolRegistry } from "./extensions/tool-registry.ts";
import type { SystemPromptBuilder } from "./context/system-prompt.ts";

export type { StreamEvent } from "./llm-client/client.ts";

export interface ModelRegistry {
  [key: string]: {
    contextLimit?: number;
    reasoningEffort?: string;
    [key: string]: unknown;
  };
}

/**
 * Typed model registry — maps model name to ModelConfig.
 */
export type TypedModelRegistry = Record<string, ModelConfig>;

export interface OutputSink {
  emit(event: OutputEvent): void;
  onTaskComplete?: (result: string) => void;
}

export interface ImageAttachment {
  type: string;
  mimeType: string;
  data: string;
}

/**
 * The subset of config keys that the Agent class actually reads.
 * Extensions may read additional keys via core.config.
 */
export interface AgentConfig extends CoreConfig {
  cwdBoundary?: string | null;
  workspaceRoot?: string | null;
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
  systemPromptBuilder?: SystemPromptBuilder;
  /**
   * Optional callback to enqueue a message on the owning MessageBus.
   * Set by the MessageBus after agent construction so the agent (and
   * extensions via hooks) can queue messages for later processing.
   */
  enqueueCallback?: (text: string) => void;
}

/**
 * Minimal Agent that runs the LLM loop and delegates behavior to hooks.
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
  #systemPrompt: string | null;
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

  /**
   * @param options
   * @param options.hooks — HookSystem instance
   * @param options.toolRegistry — ToolRegistry instance
   * @param options.llmClient — LlmClient instance
   * @param options.model — Model name
   * @param options.maxIterations — Max loop iterations (from resolved config)
   * @param options.contextLimit — Context window limit for compaction (from model config)
   * @param options.hideTools — Hide tool display
   * @param options.hideThinking — Hide thinking display
   * @param options.showTokenUse — Show token usage
   * @param options.sink — Output sink
   * @param options.modelRegistry — Model name → config map
   * @param options.profileName — Current profile name
   * @param options.config — Config reference
   * @param options.sessionId — Session ID
   * @param options.role — Role description
   * @param options.profileBody — Profile body content
   * @param options.stream — Enable streaming
   * @param options.abortSignal — Abort signal for cancellation
   * @param options.toolWhitelist — Allowed tool names (restricts available tools)
   */
  constructor(options: AgentOptions) {
    if (options.maxIterations == null) {
      throw new Error("missing required maxIterations");
    }
    if (options.contextLimit == null) {
      throw new Error("missing required contextLimit");
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
    this.#systemPrompt = null;
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

  /**
   * Get the current system prompt (from the builder's cache).
   */
  get systemPrompt(): string | null {
    return this.#systemPromptBuilder.getPrompt();
  }

  /**
   * Get token usage for this session — both accumulated totals and the
   * last-reported values from the provider.
   */
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
   * @returns Final text response, or undefined if tool calls
   */
  async run(userInput: string, images: ImageAttachment[] | null = null): Promise<string | undefined> {
    // Track whether TURN_END(stopped: true) was already emitted during
    // normal processing. If not, the finally block emits it so extensions
    // (e.g., loop) always get a completion signal even on cancellation.
    let stoppedEmitted = false;

    try {
      // Ensure system prompt is built (e.g. after /clear or /regenerate)
      await this.ensureSystemPrompt();

      // Add user input to context
      const userMsg = new Message({ role: "user", content: userInput, images: images as MessageImageAttachment[] | null });
      this.addMessage(userMsg);

      // Emit user message to output sinks so connected clients see it
      this.emitOutput("user_message", { content: userInput });

      let iteration = 0;
    while (iteration < this.maxIterations) {
      iteration++;
      this.iterationCount = iteration;

      // Turn start — emitted at the beginning of each agent loop iteration.
      this.hooks.notifyHooks(HOOKS.TURN_START, {
        turnIndex: iteration,
        timestamp: Date.now(),
        agent: this,
      });

      // Check cancellation flags
      if (this.cancelled) {
        throw LlmError.Cancelled("Agent cancelled");
      }
      if (this.abortSignal?.aborted) {
        throw LlmError.Cancelled("Agent aborted");
      }

      // Drain follow-up queue (for task agents)
      while (this.followQueue.length > 0) {
        const followUp = this.followQueue.shift()!;
        const followUpMsg = new Message({ role: "user", content: followUp });
        this.addMessage(followUpMsg);
      }

      // Build messages (extensions can modify via hook)
      let messages = this.buildMessages();
      // Context hook — sequential, modifiable. Each handler sees prior
      // transformations and can return { messages } to replace the array.
      const contextResult = await this.hooks.runHookPipeline<ContextHookResult>(HOOKS.CONTEXT, {
        messages,
        agent: this,
      });
      if (contextResult.lastResult?.messages) {
        messages = contextResult.lastResult.messages as Message[];
      }

      let toolDefs = await this.#toolRegistry.getToolDefs();
      let modelConfig = resolveModelConfig(
        this.#model,
        this.modelRegistry,
        this.contextLimit,
        this.reasoningEffort,
      );

      // Before provider request — sequential, modifiable. Extensions can
      // log the request, modify messages, change model config, or alter tools.
      const reqResult = await this.hooks.runHookPipeline<ProviderRequestHookResult>(
        HOOKS.PROVIDER_REQUEST,
        {
          messages,
          modelConfig,
          toolDefs,
          agent: this,
        },
      );
      if (reqResult.lastResult?.messages)
        messages = reqResult.lastResult.messages as Message[];
      if (reqResult.lastResult?.modelConfig)
        modelConfig = reqResult.lastResult.modelConfig as typeof modelConfig;
      if (reqResult.lastResult?.toolDefs)
        toolDefs = reqResult.lastResult.toolDefs as typeof toolDefs;

      // Create an AbortController for this LLM request.
      // Pass its signal so the HTTP client can properly abort fetch()
      // when cancel() is called (e.g., Ctrl+C).
      this.runAbortController = new AbortController();
      const cancelSignal = this.runAbortController.signal;

      // Also honor the external abortSignal (for task agents)
      if (this.abortSignal?.aborted) {
        this.runAbortController.abort();
      } else if (this.abortSignal) {
        this.abortSignal.addEventListener(
          "abort",
          () => this.runAbortController!.abort(),
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

        const response = await this._processStream(stream);

        // After provider response — notification with full response data.
        // Enables: response logging, metrics, cost tracking, telemetry.
        this.hooks.notifyHooks(HOOKS.PROVIDER_RESPONSE, {
          response,
          modelConfig,
          agent: this,
        });

        this.hooks.notifyHooks(HOOKS.MESSAGES_AFTER_LLM, {
          response,
          messages: this.log.getAll(),
          agent: this,
        });

        const assistantMsg = new Message({
          role: "assistant",
          content: response.fullText,
          reasoningContent: response.fullReasoning,
          toolCalls: response.finalToolCalls,
        });
        this.addMessage(assistantMsg);

        // Tool execution
        if (response.finalToolCalls) {
          const { outcome, toolResults } = await this._executeTools(
            response.finalToolCalls,
          );
          this._emitTokenUsage(response);
          if (outcome !== "continue") {
            // Turn end — agent has stopped (e.g., wait tool yielded control).
            stoppedEmitted = true;
            this.hooks.notifyHooks(HOOKS.TURN_END, {
              turnIndex: iteration,
              message: response.fullText,
              toolResults,
              stopped: true,
              cancelled: false,
              agent: this,
            });
            return outcome;
          }
          // Turn end (tool execution continues to next iteration).
          this.hooks.notifyHooks(HOOKS.TURN_END, {
            turnIndex: iteration,
            message: response.fullText,
            toolResults,
            stopped: false,
            cancelled: false,
            agent: this,
          });
        } else {
          this._emitTokenUsage(response);
          this.hooks.notifyHooks(HOOKS.CONTEXT_MESSAGE, {
            message: assistantMsg,
            agent: this,
          });
          // Turn end (final response, no tools).
          stoppedEmitted = true;
          this.hooks.notifyHooks(HOOKS.TURN_END, {
            turnIndex: iteration,
            message: response.fullText,
            toolResults: [],
            stopped: true,
            cancelled: false,
            agent: this,
          });
          return response.fullText;
        }
      } finally {
        // Always clean up the AbortController so it doesn't leak
        // and cancel() doesn't affect the next iteration.
        this.runAbortController = null;
      }
    }

    throw AgentError.MaxIterations(this.maxIterations);
  } finally {
    // Ensure TURN_END(stopped: true) always fires so extensions
    // (e.g., loop) get a completion signal even on cancellation or error.
    if (!stoppedEmitted) {
      this.hooks.notifyHooks(HOOKS.TURN_END, {
        turnIndex: this.iterationCount,
        message: "",
        toolResults: [],
        stopped: true,
        cancelled: this.cancelled,
        agent: this,
      });
    }
  }
  }

  /** Emit token usage — delegates to TokenTracker for accumulation and emits the event. */
  _emitTokenUsage(response: { usage?: Record<string, unknown> | null }): void {
    this.#tokenTracker.record(response.usage, (usage) => {
      this.emitOutput("token_usage", { ...(usage as Record<string, unknown>) });
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

  // ── Message Building ──────────────────────────────────────────────────────

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
    toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
  ): Promise<{ outcome: string; toolResults: Array<{ toolName: string; input: string; result: string }> }> {
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

  emitOutput(type: string, data: Record<string, unknown>): void {
    if (this.sink) {
      const key = type.toUpperCase() as keyof typeof OUTPUT_EVENT;
      if (key in OUTPUT_EVENT) {
        this.sink.emit({ type: OUTPUT_EVENT[key], ...data });
      }
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
    await this.ensureSystemPrompt();
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

  /**
   * Reset the cancelled flag so the agent can process new input.
   */
  resetCancel(): void {
    this.cancelled = false;
  }

  /**
   * Get tool definitions for the API.
   */
  async getToolDefs(): Promise<unknown[]> {
    return await this.#toolRegistry.getToolDefs();
  }

  /**
   * Get all registered tool names.
   */
  getToolNames(): string[] {
    return Array.from(this.#toolRegistry.getAll().map(([name]) => name));
  }

  /**
   * Execute a command. Returns { action, content } or { action, error }.
   * Dispatches via: custom handler → extension hooks → command registry.
   * @param cmd - Command object { type, value }
   * @returns Command result
   */
  async executeCommand(cmd: ParsedCommand): Promise<Record<string, unknown>> {
    // Custom command with inline handler (from parseCommand registry match)
    if (cmd._customCommand && cmd._handler) {
      const result = await cmd._handler(this, cmd.value, cmd);
      if (result) return result as Record<string, unknown>;
    }

    // COMMAND_DISPATCH hook — extensions can handle specific commands.
    const pipelineResult = await this.hooks.runHookPipeline(
      HOOKS.COMMAND_DISPATCH,
      { command: cmd, agent: this },
    );
    const lastResult = pipelineResult.lastResult;
    if (isPromise(lastResult)) {
      const awaited = await lastResult;
      if (awaited) return awaited as Record<string, unknown>;
    } else if (lastResult) {
      return lastResult as Record<string, unknown>;
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
