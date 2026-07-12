// Agent - the core AI agent with tool calling support.

import crypto from "node:crypto";
import { Message } from "./context/message.ts";
import { MessageLog } from "./context/message-log.ts";
import { OUTPUT_EVENT, OutputEvent } from "./context/output.ts";
import { formatError, AgentError, LlmError } from "./error.ts";
import { HOOKS, HookSystem } from "./hooks.ts";
import { ACTIONS, ParsedCommand, Command } from "./commands.ts";
import { logger } from "./logger.ts";
import { ToolContext } from "./extensions/tool-context.ts";
import { formatToolResult } from "./extensions/tool-utils.ts";
import { createCommandRegistry, AgentCommandRegistry } from "./extensions/registries.ts";
import { CORE_COMMAND_HANDLERS, CommandHandlerDef } from "./command-handlers.ts";
import { resolveModelConfig } from "./config/providers.ts";

import {
  collectSystemPromptChunks,
  buildSystemPrompt,
} from "./context/system-prompt.ts";

import type { LlmClient, StreamEvent } from "./llm-client/client.ts";
import type { ToolRegistry } from "./extensions/tool-registry.ts";

export type { StreamEvent } from "./llm-client/client.ts";

export interface ModelRegistry {
  [key: string]: {
    maxTokens?: number;
    reasoningEffort?: string;
    [key: string]: unknown;
  };
}

export interface TokenUsage {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  totalTokens: number;
  turns: number;
  lastPromptTokens: number;
  lastCachedTokens: number;
  lastCompletionTokens: number;
  lastTotalTokens: number;
}

export interface OutputSink {
  emit(event: OutputEvent): void;
  onTaskComplete?: (result: string) => void;
}

export interface ImageAttachment {
  type: string;
  mimeType: string;
  data: string;
}

export interface AgentOptions {
  hooks: HookSystem;
  toolRegistry: ToolRegistry;
  llmClient: LlmClient;
  model: string;
  maxIterations: number;
  maxTokens: number;
  hideTools?: boolean;
  hideThinking?: boolean;
  showTokenUse?: boolean;
  sink?: OutputSink | null;
  modelRegistry?: ModelRegistry;
  profileName?: string;
  config?: Record<string, unknown>;
  sessionId?: string;
  role?: string;
  profileBody?: string;
  stream?: boolean;
  abortSignal?: AbortSignal | null;
  toolWhitelist?: string[] | null;
  commandRegistry?: AgentCommandRegistry;
}

/**
 * Minimal Agent that runs the LLM loop and delegates behavior to hooks.
 */
export class Agent {
  #hooks: HookSystem;
  #toolRegistry: ToolRegistry;
  #llmClient: LlmClient;
  #log: MessageLog;
  #model: string;
  #maxIterations: number;
  #maxTokens: number;
  #hideTools: boolean;
  #hideThinking: boolean;
  #sink: OutputSink | null;
  #modelRegistry: ModelRegistry;
  #profileName: string | undefined;
  #config: Record<string, unknown> | null;
  #sessionId: string;
  #role: string | undefined;
  #profileBody: string | undefined;
  #stream: boolean;
  #cancelled: boolean;
  #iterationCount: number;
  #systemPrompt: string | null;
  #reasoningEffort: string | undefined;
  #isRestoring: boolean;
  #abortSignal: AbortSignal | null;
  #toolWhitelist: string[] | null;
  #followQueue: string[];
  #runAbortController: AbortController | null;
  #commandRegistry: AgentCommandRegistry;
  #tokenUsage: TokenUsage;

  /**
   * @param options
   * @param options.hooks — HookSystem instance
   * @param options.toolRegistry — ToolRegistry instance
   * @param options.llmClient — LlmClient instance
   * @param options.model — Model name
   * @param options.maxIterations — Max loop iterations (from resolved config)
   * @param options.maxTokens — Token threshold for context:full (from resolved config)
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
    if (options.maxTokens == null) {
      throw new Error("missing required maxTokens");
    }
    this.#hooks = options.hooks;
    this.#toolRegistry = options.toolRegistry;
    this.#llmClient = options.llmClient;
    this.#log = new MessageLog();
    this.#model = options.model;
    this.#maxIterations = options.maxIterations;
    this.#maxTokens = options.maxTokens;
    this.#hideTools = options.hideTools !== false;
    this.#hideThinking = options.hideThinking === true;
    this.#sink = options.sink || null;
    this.#modelRegistry = options.modelRegistry || {};
    this.#profileName = options.profileName;
    this.#config = options.config || null;
    this.#sessionId = options.sessionId || crypto.randomUUID();
    this.#role = options.role;
    this.#profileBody = options.profileBody;
    this.#stream = options.stream !== false;
    this.#cancelled = false;
    this.#iterationCount = 0;
    this.#systemPrompt = null;
    this.#reasoningEffort = undefined;
    this.#isRestoring = false;
    // Task agent support
    this.#abortSignal = options.abortSignal || null;
    this.#toolWhitelist = options.toolWhitelist || null;
    this.#followQueue = [];
    // AbortController for the current LLM request — created per iteration,
    // aborted on cancel() so the HTTP client properly terminates fetch().
    this.#runAbortController = null;
    // Command registry — extensions register commands here
    this.#commandRegistry = options.commandRegistry || createCommandRegistry();
    // Register core built-in commands with their handlers
    for (const [type, def] of Object.entries(CORE_COMMAND_HANDLERS)) {
      this.#commandRegistry.register(type, def as CommandHandlerDef);
    }
    // Token usage tracking — accumulates session totals and saves last-reported values.
    this.#tokenUsage = {
      // Accumulated session totals (real prompt = prompt - cached).
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      turns: 0,
      // Last-reported values from the provider.
      lastPromptTokens: 0,
      lastCachedTokens: 0,
      lastCompletionTokens: 0,
      lastTotalTokens: 0,
    };
  }

  // ── Properties ────────────────────────────────────────────────────────────

  get model(): string {
    return this.#model;
  }
  set model(v: string) {
    const oldModel = this.#model;
    this.#model = v;
    // Pull in the new model's config from the registry
    const entry = this.#modelRegistry[v];
    if (entry) {
      this.#maxTokens = (entry.maxTokens as number) ?? this.#maxTokens;
      // Reset reasoning effort to the new model's default —
      // the user can re-override via /reasoning if needed.
      this.#reasoningEffort = entry.reasoningEffort as string | undefined;
    }
    // Clear tool def cache — different models may have different tool
    // requirements or capabilities, so stale definitions would be incorrect.
    this.#toolRegistry.clearToolDefs();
    this.#hooks.notifyHooks(HOOKS.MODEL_CHANGE, {
      agent: this,
      oldModel,
      newModel: v,
    });
    // Emit through the output sink so connected WS clients get notified
    if (this.#sink) {
      this.#sink.emit({
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
      this.#hooks.notifyHooks(HOOKS.SESSION_RESTORE_ACTIVE, {
        agent: this,
        isRestoring: v,
      });
    }
  }

  /**
   * The MessageLog instance — the canonical way to read or mutate messages.
   */
  get log(): MessageLog {
    return this.#log;
  }
  get iterationCount(): number {
    return this.#iterationCount;
  }
  /**
   * Get token usage for this session — both accumulated totals and the
   * last-reported values from the provider.
   */
  getTokenUsage(): TokenUsage {
    return { ...this.#tokenUsage };
  }
  get sessionId(): string {
    return this.#sessionId;
  }
  get cancelled(): boolean {
    return this.#cancelled;
  }
  get hideTools(): boolean {
    return this.#hideTools;
  }
  set hideTools(v: boolean) {
    this.#hideTools = v;
  }

  get hideThinking(): boolean {
    return this.#hideThinking;
  }
  set hideThinking(v: boolean) {
    this.#hideThinking = v;
  }

  get systemPrompt(): string | null {
    return this.#systemPrompt;
  }
  set systemPrompt(v: string | null) {
    this.#systemPrompt = v;
  }

  /**
   * Access to the hook system for extensions that need to run hook pipelines.
   */
  get hooks(): HookSystem {
    return this.#hooks;
  }

  /**
   * Get/set the reasoning effort level.
   */
  get reasoningEffort(): string | undefined {
    return this.#reasoningEffort;
  }
  set reasoningEffort(v: string | undefined) {
    this.#reasoningEffort = v;
  }

  /**
   * Get/set the abort signal for this agent (used by task agents).
   */
  get abortSignal(): AbortSignal | null {
    return this.#abortSignal;
  }
  set abortSignal(signal: AbortSignal | null) {
    this.#abortSignal = signal;
  }

  /**
   * Get the model registry (exposed for extensions).
   */
  get modelRegistry(): ModelRegistry {
    return this.#modelRegistry;
  }

  /**
   * Get/set the follow-up message queue (used by task agents).
   */
  get followQueue(): string[] {
    return this.#followQueue;
  }
  set followQueue(v: string[]) {
    this.#followQueue = v;
  }

  /**
   * Get/set the AbortController for the current LLM request.
   * Exposed for testing cancellation behavior.
   */
  get runAbortController(): AbortController | null {
    return this.#runAbortController;
  }
  set runAbortController(v: AbortController | null) {
    this.#runAbortController = v;
  }

  /**
   * The LLM client used for API calls.
   */
  get llmClient(): LlmClient {
    return this.#llmClient;
  }

  /**
   * Get the current output sink.
   */
  get sink(): OutputSink | null {
    return this.#sink;
  }

  /**
   * Replace the output sink at runtime.
   * Allows the agent's event emissions to be re-routed (e.g., from a CLI sink
   * to a fanout sink for WebSocket sessions) without reaching into private state.
   *
   * @param sink — The new output sink, or null to detach.
   */
  setSink(sink: OutputSink | null): void {
    this.#sink = sink;
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
    // Ensure system prompt is built (e.g. after /clear or /regenerate)
    await this.ensureSystemPrompt();

    // Add user input to context
    const userMsg = new Message({ role: "user", content: userInput, images });
    this.addMessage(userMsg);

    // Emit user message to output sinks so connected clients see it
    this._emitOutput("user_message", { content: userInput });

    let iteration = 0;
    while (iteration < this.#maxIterations) {
      iteration++;
      this.#iterationCount = iteration;

      // Turn start — emitted at the beginning of each agent loop iteration.
      await this.#hooks.notifyHooksAsync(HOOKS.TURN_START, {
        turnIndex: iteration,
        timestamp: Date.now(),
        agent: this,
      });

      // Check cancellation flags
      if (this.#cancelled) {
        throw LlmError.Cancelled("Agent cancelled");
      }
      if (this.#abortSignal?.aborted) {
        throw LlmError.Cancelled("Agent aborted");
      }

      // Drain follow-up queue (for task agents)
      while (this.#followQueue.length > 0) {
        const followUp = this.#followQueue.shift()!;
        const followUpMsg = new Message({ role: "user", content: followUp });
        this.addMessage(followUpMsg);
      }

      // Build messages (extensions can modify via hook)
      let messages = this.buildMessages();
      // Context hook — sequential, modifiable. Each handler sees prior
      // transformations and can return { messages } to replace the array.
      const contextResult = await this.#hooks.runHookPipeline(HOOKS.CONTEXT, {
        messages,
        agent: this,
      });
      if ((contextResult.lastResult as { messages?: unknown })?.messages) {
        messages = (contextResult.lastResult as { messages: Message[] }).messages;
      }

      let toolDefs = await this.#toolRegistry.getToolDefs();
      let modelConfig = resolveModelConfig(
        this.#model,
        this.#modelRegistry,
        this.#maxTokens,
        this.#reasoningEffort,
      );

      // Before provider request — sequential, modifiable. Extensions can
      // log the request, modify messages, change model config, or alter tools.
      const reqResult = await this.#hooks.runHookPipeline(
        HOOKS.PROVIDER_REQUEST,
        {
          messages,
          modelConfig,
          toolDefs,
          agent: this,
        },
      );
      if ((reqResult.lastResult as { messages?: unknown })?.messages)
        messages = (reqResult.lastResult as { messages: Message[] }).messages;
      if ((reqResult.lastResult as { modelConfig?: unknown })?.modelConfig)
        modelConfig = (reqResult.lastResult as { modelConfig: typeof modelConfig }).modelConfig;
      if ((reqResult.lastResult as { toolDefs?: unknown })?.toolDefs)
        toolDefs = (reqResult.lastResult as { toolDefs: typeof toolDefs }).toolDefs;

      // Create an AbortController for this LLM request.
      // Pass its signal so the HTTP client can properly abort fetch()
      // when cancel() is called (e.g., Ctrl+C).
      this.#runAbortController = new AbortController();
      const cancelSignal = this.#runAbortController.signal;

      // Also honor the external abortSignal (for task agents)
      if (this.#abortSignal?.aborted) {
        this.#runAbortController.abort();
      } else if (this.#abortSignal) {
        this.#abortSignal.addEventListener(
          "abort",
          () => this.#runAbortController!.abort(),
          { once: true },
        );
      }

      try {
        const stream = this.#llmClient.chatStreamCancellable(
          messages,
          modelConfig,
          toolDefs,
          cancelSignal,
        );

        const response = await this._processStream(stream);

        // After provider response — notification with full response data.
        // Enables: response logging, metrics, cost tracking, telemetry.
        await this.#hooks.notifyHooksAsync(HOOKS.PROVIDER_RESPONSE, {
          response,
          modelConfig,
          agent: this,
        });

        await this.#hooks.notifyHooksAsync(HOOKS.MESSAGES_AFTER_LLM, {
          response,
          messages: this.#log.getAll(),
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
            await this.#hooks.notifyHooksAsync(HOOKS.TURN_END, {
              turnIndex: iteration,
              message: response.fullText,
              toolResults,
              stopped: true,
              agent: this,
            });
            return outcome;
          }
          // Turn end (tool execution continues to next iteration).
          await this.#hooks.notifyHooksAsync(HOOKS.TURN_END, {
            turnIndex: iteration,
            message: response.fullText,
            toolResults,
            stopped: false,
            agent: this,
          });
        } else {
          this._emitTokenUsage(response);
          await this.#hooks.notifyHooksAsync(HOOKS.CONTEXT_MESSAGE, {
            message: assistantMsg,
            agent: this,
          });
          // Turn end (final response, no tools).
          await this.#hooks.notifyHooksAsync(HOOKS.TURN_END, {
            turnIndex: iteration,
            message: response.fullText,
            toolResults: [],
            stopped: true,
            agent: this,
          });
          return response.fullText;
        }
      } finally {
        // Always clean up the AbortController so it doesn't leak
        // and cancel() doesn't affect the next iteration.
        this.#runAbortController = null;
      }
    }

    throw AgentError.MaxIterations(this.#maxIterations);
  }

  /** Emit token usage — always accumulates session totals and saves last-reported values. */
  _emitTokenUsage(response: { usage?: Record<string, unknown> | null }): void {
    if (response.usage && !(response.usage as Record<string, unknown>).__didEmitTokenUsage) {
      (response.usage as Record<string, unknown>).__didEmitTokenUsage = true;
      const u = response.usage as Record<string, unknown>;

      // Per-call values from the provider.
      const promptTokens = (u.prompt_tokens as number) || 0;
      const cachedTokens = ((u.prompt_tokens_details as Record<string, unknown>)?.cached_tokens as number) || 0;
      const completionTokens = (u.completion_tokens as number) || 0;
      const totalTokens = (u.total_tokens as number) || 0;

      // Accumulate session totals. Real prompt = prompt - cached (cached tokens are free).
      this.#tokenUsage.promptTokens += promptTokens - cachedTokens;
      this.#tokenUsage.cachedTokens += cachedTokens;
      this.#tokenUsage.completionTokens += completionTokens;
      this.#tokenUsage.totalTokens += totalTokens;
      this.#tokenUsage.turns += 1;

      // Save last-reported values for reference.
      this.#tokenUsage.lastPromptTokens = promptTokens - cachedTokens;
      this.#tokenUsage.lastCachedTokens = cachedTokens;
      this.#tokenUsage.lastCompletionTokens = completionTokens;
      this.#tokenUsage.lastTotalTokens = totalTokens;

      this._emitOutput("token_usage", {
        promptTokens: this.#tokenUsage.promptTokens,
        cachedTokens: this.#tokenUsage.cachedTokens,
        completionTokens: this.#tokenUsage.completionTokens,
        totalTokens: this.#tokenUsage.totalTokens,
        turns: this.#tokenUsage.turns,
        lastPromptTokens: this.#tokenUsage.lastPromptTokens,
        lastCachedTokens: this.#tokenUsage.lastCachedTokens,
        lastCompletionTokens: this.#tokenUsage.lastCompletionTokens,
        lastTotalTokens: this.#tokenUsage.lastTotalTokens,
      });
    }
  }

  /**
   * Called when the agent completes (for task agents).
   * @param result - The final result text
   */
  _notifyCompletion(result: string): void {
    if (this.#sink && typeof (this.#sink as OutputSink & { onTaskComplete?: (result: string) => void }).onTaskComplete === "function") {
      (this.#sink as OutputSink & { onTaskComplete: (result: string) => void }).onTaskComplete!(result);
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
    return this.#log.buildMessages(this.#systemPrompt);
  }

  /**
   * Ensure system prompt is built and cached.
   * Extensions contribute chunks via the SYSTEM_PROMPT_BUILD hook.
   * Chunks are sorted by priority and rendered via the template.
   */
  async ensureSystemPrompt(): Promise<void> {
    if (this.#systemPrompt) return;

    const { results } = await this.#hooks.runHookPipeline(
      HOOKS.SYSTEM_PROMPT_BUILD,
      {
        agent: this,
      },
    );
    const chunks = collectSystemPromptChunks(results, this);

    // Build the system prompt
    this.#systemPrompt = await buildSystemPrompt({
      role: this.#role || "",
      body: this.#profileBody || "",
      model: this.#model || "",
      profileName: this.#profileName || "default",
      chunks,
    });
  }

  // ── Stream Processing ─────────────────────────────────────────────────────

  /**
   * Process a streaming LLM response.
   * Normalizes tool calls to OpenAI format: { id, type, function: { name, arguments } }.
   *
   * @param stream
   * @returns { fullText, fullReasoning, finalToolCalls, usage, finishReason }
   */
  async _processStream(
    stream: AsyncIterable<StreamEvent>,
  ): Promise<{
    fullText: string;
    fullReasoning: string | null;
    finalToolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> | null;
    usage: Record<string, unknown> | null;
    finishReason: string | null;
  }> {
    const textParts: string[] = [];
    const reasoningParts: string[] = [];
    const toolCallsBuffer = new Map<number, { name: string; args: string[]; id: string }>();
    let usage: Record<string, unknown> | null = null;
    let finishReason: string | null = null;

    for await (const event of stream) {
      if (this.#cancelled) throw LlmError.Cancelled("Agent cancelled");

      switch (event.type) {
        case "content":
          textParts.push(event.content as string);
          if (this.#stream) {
            this._emitOutput("streaming_chunk", { content: event.content });
          }
          break;
        case "reasoning":
          reasoningParts.push(event.content as string);
          if (this.#stream) {
            this._emitOutput("streaming_reasoning_chunk", {
              content: event.content,
            });
          }
          break;
        case "toolName":
          toolCallsBuffer.set(event.index as number, {
            name: event.name as string,
            args: [],
            id: event.toolCallId || "",
          });
          break;
        case "toolArgument": {
          const existing = toolCallsBuffer.get(event.index as number) || {
            name: "",
            args: [],
            id: "",
          };
          existing.args.push(event.arguments as string);
          toolCallsBuffer.set(event.index as number, existing);
          break;
        }
        case "usage":
          usage = event.data as Record<string, unknown>;
          break;
        case "finish":
          finishReason = event.reason as string;
          // Emit truncation warning if the model hit its token limit
          if (event.reason === "length") {
            logger.warn(
              `[agent] response truncated — hit max token limit (reason: ${event.reason})`,
            );
          }
          break;
      }
    }

    // Build final tool calls from buffer
    let finalToolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }> | null = null;
    if (toolCallsBuffer.size > 0) {
      finalToolCalls = Array.from(toolCallsBuffer.values()).map(
        (tc) => ({
          id: tc.id || crypto.randomUUID(),
          type: "function",
          function: { name: tc.name, arguments: tc.args.join("") },
        }),
      );
    }

    return {
      fullText: textParts.join(""),
      fullReasoning: reasoningParts.length > 0 ? reasoningParts.join("") : null,
      finalToolCalls,
      usage,
      finishReason,
    };
  }

  // ── Tool Execution ────────────────────────────────────────────────────────

  /**
   * Execute tool calls from an LLM response.
   *
   * @param toolCalls
   * @returns { outcome: 'continue' | 'return', toolResults }
   */
  async _executeTools(
    toolCalls: Array<{ id: string; type: string; function: { name: string; arguments: string } }>,
  ): Promise<{ outcome: string; toolResults: Array<{ toolName: string; input: string; result: string }> }> {
    const toolResults: Array<{ toolName: string; input: string; result: string }> = [];

    for (const tc of toolCalls) {
      let result: { toolName: string; input: string; result: string };
      try {
        result = await this._executeSingleToolCall(tc);
      } catch (e: unknown) {
        // Log the error and produce a fallback result so the LLM sees a
        // structured failure rather than losing the tool call entirely.
        const toolName = tc.function?.name || "(unknown)";
        const toolCallId = tc.id || "";
        const errorMsg = `Tool execution failed: ${(e as Error).message}`;
        logger.error(`[tool:error] ${toolName}: ${formatError(e)}`);

        result = await this._writeToolResult(
          toolName,
          tc.function?.arguments || "{}",
          errorMsg,
          toolCallId,
        );
      }
      toolResults.push(result);

      // Check for wait tool — model is yielding control
      if (result.toolName === "wait") {
        return { outcome: "return", toolResults };
      }
    }

    return { outcome: "continue", toolResults };
  }

  /**
   * Execute a single tool call through the full pipeline:
   *   whitelist → gate hook → context build → resolve → validate → execute
   *   → after-execute hook → result hook → format → write to context.
   *
   * @param tc — Tool call from the LLM response (normalized format).
   * @returns { toolName, input, result }
   */
  async _executeSingleToolCall(
    tc: { id: string; type: string; function: { name: string; arguments: string } },
  ): Promise<{ toolName: string; input: string; result: string }> {
    const toolName = tc.function?.name;
    const toolCallId = tc.id;
    let input = tc.function?.arguments || "{}";
    const t0 = Date.now();

    // Guard: reject empty or missing tool names before any further processing.
    if (
      !toolName ||
      typeof toolName !== "string" ||
      toolName.trim().length === 0
    ) {
      const result = `Tool call missing a valid name (got: ${JSON.stringify(toolName)})`;
      this._emitOutput("tool_result", {
        toolName: "(invalid)",
        input,
        result,
        toolCallId,
      });
      const msg = new Message({
        role: "tool",
        content: result,
        toolCallId,
      });
      this.addMessage(msg);
      return { toolName: "(invalid)", input, result };
    }

    if (this.#toolWhitelist && !this.#toolWhitelist.includes(toolName)) {
      const msg = `Tool '${toolName}' is not available for this agent`;
      return this._writeToolResult(toolName, input, msg, toolCallId);
    }

    this._emitOutput("tool_call", { toolName, input, toolCallId });
    await this.#hooks.notifyHooksAsync(HOOKS.TOOL_BEFORE_EXECUTE, {
      toolCallId,
      toolName,
      input,
      agent: this,
    });

    // Tool call gate — sequential, modifiable. Handlers can block, modify input args, or allow execution to proceed.
    //    Actions: { action: "continue" } | { action: "modify", input } | { action: "block", result }
    const callResult = await this.#hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId,
      toolName,
      input,
      agent: this,
    });
    if (callResult.lastResult && (callResult.lastResult as { action?: string }).action === "block") {
      // Extension blocked this tool call — use provided result
      const blockedResult = formatToolResult(
        (callResult.lastResult as { result?: unknown }).result,
        toolName,
        false,
      );
      return this._writeToolResult(toolName, input, blockedResult, toolCallId);
    }
    if (
      callResult.lastResult &&
      (callResult.lastResult as { action?: string }).action === "modify" &&
      (callResult.lastResult as { input?: unknown }).input !== undefined
    ) {
      // Extension modified the input args
      input = (callResult.lastResult as { input: string }).input;
    }

    // Build and enrich tool context via hook
    const toolCtx = this._buildToolContext(toolName);
    await this.#hooks.notifyHooksAsync(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx,
      toolName,
      agent: this,
    });

    // Resolve tool from registry
    const tool = this.#toolRegistry.get(toolName);
    if (!tool) {
      return this._writeToolResult(
        toolName,
        input,
        `Unknown tool: ${toolName}`,
        toolCallId,
      );
    }

    // Validate arguments against tool's JSON Schema
    const validationError = await this.#toolRegistry.validateToolArgs(
      toolName,
      input,
    );
    if (validationError) {
      return this._writeToolResult(
        toolName,
        input,
        `Parameter validation error:\n${validationError}`,
        toolCallId,
      );
    }

    // Execute the tool
    let result: unknown;
    let success: boolean;
    try {
      result = await (tool as { execute: (input: string, ctx: ToolContext) => Promise<unknown> }).execute(input, toolCtx);
      success = true;
    } catch (e: unknown) {
      result = `Error executing tool ${toolName}: ${(e as Error).message}`;
      success = false;
    }

    // After-execute hook + result modification hook
    await this.#hooks.notifyHooksAsync(HOOKS.TOOL_AFTER_EXECUTE, {
      toolCallId,
      toolName,
      result,
      input,
      agent: this,
      success,
    });

    // Tool result — sequential, modifiable. Handlers can transform the
    // result before it reaches the LLM context.
    // Returns { result } to replace the result (any value: string, ToolResult, object)
    const resultHook = await this.#hooks.runHookPipeline(HOOKS.TOOL_RESULT, {
      toolCallId,
      toolName,
      result,
      success,
      input,
      agent: this,
    });
    if (resultHook.lastResult && (resultHook.lastResult as { result?: unknown }).result !== undefined) {
      result = (resultHook.lastResult as { result: unknown }).result;
    }
    const images = (result as { images?: unknown })?.images ?? null;

    // Format and write result to context
    const resultStr = formatToolResult(result, toolName, success);

    // Fire metrics notification (fire-and-forget — non-blocking).
    // Enables telemetry, profiling, and anomaly detection without
    // adding latency to the tool execution path.
    const durationMs = Date.now() - t0;
    const resultSize = typeof resultStr === "string" ? resultStr.length : 0;
    this.#hooks.notifyHooks(HOOKS.TOOL_METRICS, {
      toolName,
      toolCallId,
      durationMs,
      success,
      resultSize,
      input,
      agent: this,
    });

    return this._writeToolResult(
      toolName,
      input,
      resultStr,
      toolCallId,
      images as ImageAttachment[] | null,
    );
  }

  /**
   * Build a ToolContext with standard infrastructure fields.
   * Extensions can further enrich it via the AGENT_TOOL_CONTEXT hook.
   *
   * @param toolName
   * @returns ToolContext
   */
  _buildToolContext(toolName: string): ToolContext {
    const toolCtx = new ToolContext();
    toolCtx.set("agent", this);
    toolCtx.set("isSessionRestoring", this.#isRestoring);
    if (this.#config) {
      toolCtx.set("cwdBoundary", this.#config.cwdBoundary || null);
      toolCtx.set("workspaceRoot", this.#config.workspaceRoot || null);
    }
    return toolCtx;
  }

  /**
   * Write a tool result to output, context, and emit the context message hook.
   * Shared helper used by both error paths and the happy path in _executeSingleToolCall.
   *
   * @param toolName
   * @param input
   * @param result
   * @param toolCallId
   * @param images — Optional images
   * @returns { toolName, input, result }
   */
  async _writeToolResult(
    toolName: string,
    input: string,
    result: string,
    toolCallId: string,
    images?: ImageAttachment[] | null,
  ): Promise<{ toolName: string; input: string; result: string }> {
    this._emitOutput("tool_result", { toolName, input, result });
    const msg = new Message({
      role: "tool",
      content: result,
      toolCallId,
      images,
    });
    this.addMessage(msg);
    return { toolName, input, result };
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
    this.#log.push(msg);
    this.#hooks.notifyHooksAsync(HOOKS.CONTEXT_MESSAGE, {
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
    const oldContext = this.#log.getAll();
    this.#log.replace(newContext);
    this.#hooks.notifyHooksAsync(HOOKS.CONTEXT_REPLACED, {
      agent: this,
      oldContext,
      newContext,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _emitOutput(type: string, data: Record<string, unknown>): void {
    if (this.#sink) {
      const key = type.toUpperCase() as keyof typeof OUTPUT_EVENT;
      if (key in OUTPUT_EVENT) {
        this.#sink.emit({ type: OUTPUT_EVENT[key], ...data });
      }
    }
    this.#hooks.notifyHooks(HOOKS.OUTPUT_EVENT, { type, data, agent: this });
  }

  // ── Session Management ────────────────────────────────────────────────────

  /**
   * Clear the context and start fresh.
   */
  async clearContext(): Promise<void> {
    this.#log.clear();
    this.#systemPrompt = null;
    this.#iterationCount = 0;
    this.#tokenUsage = {
      promptTokens: 0,
      cachedTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      turns: 0,
      lastPromptTokens: 0,
      lastCachedTokens: 0,
      lastCompletionTokens: 0,
      lastTotalTokens: 0,
    };
    await this.ensureSystemPrompt();
  }

  /**
   * Cancel the current run.
   */
  cancel(): void {
    this.#cancelled = true;
    // Abort the active LLM request so the HTTP client terminates fetch().
    if (this.#runAbortController && !this.#runAbortController.signal.aborted) {
      this.#runAbortController.abort();
    }
  }

  /**
   * Reset the cancelled flag so the agent can process new input.
   */
  resetCancel(): void {
    this.#cancelled = false;
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
    const pipelineResult = await this.#hooks.runHookPipeline(
      HOOKS.COMMAND_DISPATCH,
      { command: cmd, agent: this },
    );
    const lastResult = pipelineResult.lastResult;
    if (lastResult && typeof ((lastResult as Promise<unknown>).then as Function) === "function") {
      const awaited = await lastResult;
      if (awaited) return awaited as Record<string, unknown>;
    } else if (lastResult) {
      return lastResult as Record<string, unknown>;
    }

    // Look up handler from command registry by command type.
    // Built-in commands are registered during construction;
    // extensions also register commands via COMMANDS_REGISTER hook.
    const registered = this.#commandRegistry.get(cmd.type);
    if (registered && registered.handler) {
      return await registered.handler(this, cmd.value, cmd);
    }

    return { action: ACTIONS.ERROR, error: `Unknown command: ${cmd.type}` };
  }

  /**
   * Get the command registry.
   * @returns AgentCommandRegistry
   */
  getCommandRegistry(): AgentCommandRegistry {
    return this.#commandRegistry;
  }

  /**
   * Serialize the agent state for persistence.
   * @returns Serialized state object.
   */
  serialize(): Record<string, unknown> {
    return {
      sessionId: this.#sessionId,
      context: this.#log.toJSON(),
      model: this.model,
      iterationCount: this.#iterationCount,
      reasoningEffort: this.#reasoningEffort,
    };
  }

  /**
   * Deserialize agent state from persisted data.
   * @param data
   */
  deserialize(data: Record<string, unknown>): void {
    this.#sessionId = data.sessionId as string;
    this.#log.replace(
      (data.context as Array<Record<string, unknown>>).map(
        (m: Record<string, unknown>) => new Message(m),
      ),
    );
    this.model = data.model as string;
    this.#iterationCount = (data.iterationCount as number) || 0;
    this.#reasoningEffort = data.reasoningEffort as string | undefined;
  }
}
