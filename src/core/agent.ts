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
  _hooks: HookSystem;
  _toolRegistry: ToolRegistry;
  _llmClient: LlmClient;
  _log: MessageLog;
  _model: string;
  _maxIterations: number;
  _maxTokens: number;
  _hideTools: boolean;
  _hideThinking: boolean;
  _sink: OutputSink | null;
  _modelRegistry: ModelRegistry;
  _profileName: string | undefined;
  _config: Record<string, unknown> | null;
  _sessionId: string;
  _role: string | undefined;
  _profileBody: string | undefined;
  _stream: boolean;
  _cancelled: boolean;
  _iterationCount: number;
  _systemPrompt: string | null;
  _reasoningEffort: string | undefined;
  _isRestoring: boolean;
  _abortSignal: AbortSignal | null;
  _toolWhitelist: string[] | null;
  _followQueue: string[];
  _runAbortController: AbortController | null;
  _commandRegistry: AgentCommandRegistry;
  _tokenUsage: TokenUsage;

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
    this._hooks = options.hooks;
    this._toolRegistry = options.toolRegistry;
    this._llmClient = options.llmClient;
    this._log = new MessageLog();
    this._model = options.model;
    this._maxIterations = options.maxIterations;
    this._maxTokens = options.maxTokens;
    this._hideTools = options.hideTools !== false;
    this._hideThinking = options.hideThinking === true;
    this._sink = options.sink || null;
    this._modelRegistry = options.modelRegistry || {};
    this._profileName = options.profileName;
    this._config = options.config || null;
    this._sessionId = options.sessionId || crypto.randomUUID();
    this._role = options.role;
    this._profileBody = options.profileBody;
    this._stream = options.stream !== false;
    this._cancelled = false;
    this._iterationCount = 0;
    this._systemPrompt = null;
    this._reasoningEffort = undefined;
    this._isRestoring = false;
    // Task agent support
    this._abortSignal = options.abortSignal || null;
    this._toolWhitelist = options.toolWhitelist || null;
    this._followQueue = [];
    // AbortController for the current LLM request — created per iteration,
    // aborted on cancel() so the HTTP client properly terminates fetch().
    this._runAbortController = null;
    // Command registry — extensions register commands here
    this._commandRegistry = options.commandRegistry || createCommandRegistry();
    // Register core built-in commands with their handlers
    for (const [type, def] of Object.entries(CORE_COMMAND_HANDLERS)) {
      this._commandRegistry.register(type, def as CommandHandlerDef);
    }
    // Token usage tracking — accumulates session totals and saves last-reported values.
    this._tokenUsage = {
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
    return this._model;
  }
  set model(v: string) {
    const oldModel = this._model;
    this._model = v;
    // Pull in the new model's config from the registry
    const entry = this._modelRegistry[v];
    if (entry) {
      this._maxTokens = (entry.maxTokens as number) ?? this._maxTokens;
      // Reset reasoning effort to the new model's default —
      // the user can re-override via /reasoning if needed.
      this._reasoningEffort = entry.reasoningEffort as string | undefined;
    }
    // Clear tool def cache — different models may have different tool
    // requirements or capabilities, so stale definitions would be incorrect.
    this._toolRegistry.clearToolDefs();
    this._hooks.notifyHooks(HOOKS.MODEL_CHANGE, {
      agent: this,
      oldModel,
      newModel: v,
    });
    // Emit through the output sink so connected WS clients get notified
    if (this._sink) {
      this._sink.emit({
        type: OUTPUT_EVENT.SESSION_STATE,
        key: "model",
        value: v,
      });
    }
  }

  get isRestoring(): boolean {
    return this._isRestoring;
  }
  set isRestoring(v: boolean) {
    const oldVal = this._isRestoring;
    this._isRestoring = v;
    if (oldVal !== v) {
      this._hooks.notifyHooks(HOOKS.SESSION_RESTORE_ACTIVE, {
        agent: this,
        isRestoring: v,
      });
    }
  }

  /**
   * The MessageLog instance — the canonical way to read or mutate messages.
   */
  get log(): MessageLog {
    return this._log;
  }
  get iterationCount(): number {
    return this._iterationCount;
  }
  /**
   * Get token usage for this session — both accumulated totals and the
   * last-reported values from the provider.
   */
  getTokenUsage(): TokenUsage {
    return { ...this._tokenUsage };
  }
  get sessionId(): string {
    return this._sessionId;
  }
  get cancelled(): boolean {
    return this._cancelled;
  }
  get hideTools(): boolean {
    return this._hideTools;
  }
  set hideTools(v: boolean) {
    this._hideTools = v;
  }

  get hideThinking(): boolean {
    return this._hideThinking;
  }
  set hideThinking(v: boolean) {
    this._hideThinking = v;
  }

  get systemPrompt(): string | null {
    return this._systemPrompt;
  }

  /**
   * The LLM client used for API calls.
   */
  get llmClient(): LlmClient {
    return this._llmClient;
  }

  /**
   * Replace the output sink at runtime.
   * Allows the agent's event emissions to be re-routed (e.g., from a CLI sink
   * to a fanout sink for WebSocket sessions) without reaching into private state.
   *
   * @param sink — The new output sink, or null to detach.
   */
  setSink(sink: OutputSink | null): void {
    this._sink = sink;
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
    while (iteration < this._maxIterations) {
      iteration++;
      this._iterationCount = iteration;

      // Turn start — emitted at the beginning of each agent loop iteration.
      await this._hooks.notifyHooksAsync(HOOKS.TURN_START, {
        turnIndex: iteration,
        timestamp: Date.now(),
        agent: this,
      });

      // Check cancellation flags
      if (this._cancelled) {
        throw LlmError.Cancelled("Agent cancelled");
      }
      if (this._abortSignal?.aborted) {
        throw LlmError.Cancelled("Agent aborted");
      }

      // Drain follow-up queue (for task agents)
      while (this._followQueue.length > 0) {
        const followUp = this._followQueue.shift()!;
        const followUpMsg = new Message({ role: "user", content: followUp });
        this.addMessage(followUpMsg);
      }

      // Build messages (extensions can modify via hook)
      let messages = this.buildMessages();
      // Context hook — sequential, modifiable. Each handler sees prior
      // transformations and can return { messages } to replace the array.
      const contextResult = await this._hooks.runHookPipeline(HOOKS.CONTEXT, {
        messages,
        agent: this,
      });
      if ((contextResult.lastResult as { messages?: unknown })?.messages) {
        messages = (contextResult.lastResult as { messages: Message[] }).messages;
      }

      let toolDefs = await this._toolRegistry.getToolDefs();
      let modelConfig = resolveModelConfig(
        this._model,
        this._modelRegistry,
        this._maxTokens,
        this._reasoningEffort,
      );

      // Before provider request — sequential, modifiable. Extensions can
      // log the request, modify messages, change model config, or alter tools.
      const reqResult = await this._hooks.runHookPipeline(
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
      this._runAbortController = new AbortController();
      const cancelSignal = this._runAbortController.signal;

      // Also honor the external abortSignal (for task agents)
      if (this._abortSignal?.aborted) {
        this._runAbortController.abort();
      } else if (this._abortSignal) {
        this._abortSignal.addEventListener(
          "abort",
          () => this._runAbortController!.abort(),
          { once: true },
        );
      }

      try {
        const stream = this._llmClient.chatStreamCancellable(
          messages,
          modelConfig,
          toolDefs,
          cancelSignal,
        );

        const response = await this._processStream(stream);

        // After provider response — notification with full response data.
        // Enables: response logging, metrics, cost tracking, telemetry.
        await this._hooks.notifyHooksAsync(HOOKS.PROVIDER_RESPONSE, {
          response,
          modelConfig,
          agent: this,
        });

        await this._hooks.notifyHooksAsync(HOOKS.MESSAGES_AFTER_LLM, {
          response,
          messages: this._log.getAll(),
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
            await this._hooks.notifyHooksAsync(HOOKS.TURN_END, {
              turnIndex: iteration,
              message: response.fullText,
              toolResults,
              stopped: true,
              agent: this,
            });
            return outcome;
          }
          // Turn end (tool execution continues to next iteration).
          await this._hooks.notifyHooksAsync(HOOKS.TURN_END, {
            turnIndex: iteration,
            message: response.fullText,
            toolResults,
            stopped: false,
            agent: this,
          });
        } else {
          this._emitTokenUsage(response);
          await this._hooks.notifyHooksAsync(HOOKS.CONTEXT_MESSAGE, {
            message: assistantMsg,
            agent: this,
          });
          // Turn end (final response, no tools).
          await this._hooks.notifyHooksAsync(HOOKS.TURN_END, {
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
        this._runAbortController = null;
      }
    }

    throw AgentError.MaxIterations(this._maxIterations);
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
      this._tokenUsage.promptTokens += promptTokens - cachedTokens;
      this._tokenUsage.cachedTokens += cachedTokens;
      this._tokenUsage.completionTokens += completionTokens;
      this._tokenUsage.totalTokens += totalTokens;
      this._tokenUsage.turns += 1;

      // Save last-reported values for reference.
      this._tokenUsage.lastPromptTokens = promptTokens - cachedTokens;
      this._tokenUsage.lastCachedTokens = cachedTokens;
      this._tokenUsage.lastCompletionTokens = completionTokens;
      this._tokenUsage.lastTotalTokens = totalTokens;

      this._emitOutput("token_usage", {
        promptTokens: this._tokenUsage.promptTokens,
        cachedTokens: this._tokenUsage.cachedTokens,
        completionTokens: this._tokenUsage.completionTokens,
        totalTokens: this._tokenUsage.totalTokens,
        turns: this._tokenUsage.turns,
        lastPromptTokens: this._tokenUsage.lastPromptTokens,
        lastCachedTokens: this._tokenUsage.lastCachedTokens,
        lastCompletionTokens: this._tokenUsage.lastCompletionTokens,
        lastTotalTokens: this._tokenUsage.lastTotalTokens,
      });
    }
  }

  /**
   * Called when the agent completes (for task agents).
   * @param result - The final result text
   */
  _notifyCompletion(result: string): void {
    if (this._sink && typeof (this._sink as OutputSink & { onTaskComplete?: (result: string) => void }).onTaskComplete === "function") {
      (this._sink as OutputSink & { onTaskComplete: (result: string) => void }).onTaskComplete!(result);
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
    return this._log.buildMessages(this._systemPrompt);
  }

  /**
   * Ensure system prompt is built and cached.
   * Extensions contribute chunks via the SYSTEM_PROMPT_BUILD hook.
   * Chunks are sorted by priority and rendered via the template.
   */
  async ensureSystemPrompt(): Promise<void> {
    if (this._systemPrompt) return;

    const { results } = await this._hooks.runHookPipeline(
      HOOKS.SYSTEM_PROMPT_BUILD,
      {
        agent: this,
      },
    );
    const chunks = collectSystemPromptChunks(results, this);

    // Build the system prompt
    this._systemPrompt = await buildSystemPrompt({
      role: this._role || "",
      body: this._profileBody || "",
      model: this._model || "",
      profileName: this._profileName || "default",
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
      if (this._cancelled) throw LlmError.Cancelled("Agent cancelled");

      switch (event.type) {
        case "content":
          textParts.push(event.content as string);
          if (this._stream) {
            this._emitOutput("streaming_chunk", { content: event.content });
          }
          break;
        case "reasoning":
          reasoningParts.push(event.content as string);
          if (this._stream) {
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

    if (this._toolWhitelist && !this._toolWhitelist.includes(toolName)) {
      const msg = `Tool '${toolName}' is not available for this agent`;
      return this._writeToolResult(toolName, input, msg, toolCallId);
    }

    this._emitOutput("tool_call", { toolName, input, toolCallId });
    await this._hooks.notifyHooksAsync(HOOKS.TOOL_BEFORE_EXECUTE, {
      toolCallId,
      toolName,
      input,
      agent: this,
    });

    // Tool call gate — sequential, modifiable. Handlers can block, modify input args, or allow execution to proceed.
    //    Actions: { action: "continue" } | { action: "modify", input } | { action: "block", result }
    const callResult = await this._hooks.runHookPipeline(HOOKS.TOOL_CALL, {
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
    await this._hooks.notifyHooksAsync(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx,
      toolName,
      agent: this,
    });

    // Resolve tool from registry
    const tool = this._toolRegistry.get(toolName);
    if (!tool) {
      return this._writeToolResult(
        toolName,
        input,
        `Unknown tool: ${toolName}`,
        toolCallId,
      );
    }

    // Validate arguments against tool's JSON Schema
    const validationError = await this._toolRegistry.validateToolArgs(
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
    await this._hooks.notifyHooksAsync(HOOKS.TOOL_AFTER_EXECUTE, {
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
    const resultHook = await this._hooks.runHookPipeline(HOOKS.TOOL_RESULT, {
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
    this._hooks.notifyHooks(HOOKS.TOOL_METRICS, {
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
    toolCtx.set("isSessionRestoring", this._isRestoring);
    if (this._config) {
      toolCtx.set("cwdBoundary", this._config.cwdBoundary || null);
      toolCtx.set("workspaceRoot", this._config.workspaceRoot || null);
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
    this._log.push(msg);
    this._hooks.notifyHooksAsync(HOOKS.CONTEXT_MESSAGE, {
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
    const oldContext = this._log.getAll();
    this._log.replace(newContext);
    this._hooks.notifyHooksAsync(HOOKS.CONTEXT_REPLACED, {
      agent: this,
      oldContext,
      newContext,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _emitOutput(type: string, data: Record<string, unknown>): void {
    if (this._sink) {
      const key = type.toUpperCase() as keyof typeof OUTPUT_EVENT;
      if (key in OUTPUT_EVENT) {
        this._sink.emit({ type: OUTPUT_EVENT[key], ...data });
      }
    }
    this._hooks.notifyHooks(HOOKS.OUTPUT_EVENT, { type, data, agent: this });
  }

  // ── Session Management ────────────────────────────────────────────────────

  /**
   * Clear the context and start fresh.
   */
  async clearContext(): Promise<void> {
    this._log.clear();
    this._systemPrompt = null;
    this._iterationCount = 0;
    this._tokenUsage = {
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
    this._cancelled = true;
    // Abort the active LLM request so the HTTP client terminates fetch().
    if (this._runAbortController && !this._runAbortController.signal.aborted) {
      this._runAbortController.abort();
    }
  }

  /**
   * Reset the cancelled flag so the agent can process new input.
   */
  resetCancel(): void {
    this._cancelled = false;
  }

  /**
   * Get tool definitions for the API.
   */
  async getToolDefs(): Promise<unknown[]> {
    return await this._toolRegistry.getToolDefs();
  }

  /**
   * Get all registered tool names.
   */
  getToolNames(): string[] {
    return Array.from(this._toolRegistry.getAll().map(([name]) => name));
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
    const pipelineResult = await this._hooks.runHookPipeline(
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
    const registered = this._commandRegistry.get(cmd.type);
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
    return this._commandRegistry;
  }

  /**
   * Serialize the agent state for persistence.
   * @returns Serialized state object.
   */
  serialize(): Record<string, unknown> {
    return {
      sessionId: this._sessionId,
      context: this._log.toJSON(),
      model: this.model,
      iterationCount: this._iterationCount,
      reasoningEffort: this._reasoningEffort,
    };
  }

  /**
   * Deserialize agent state from persisted data.
   * @param data
   */
  deserialize(data: Record<string, unknown>): void {
    this._sessionId = data.sessionId as string;
    this._log.replace(
      (data.context as Array<Record<string, unknown>>).map(
        (m: Record<string, unknown>) => new Message(m),
      ),
    );
    this.model = data.model as string;
    this._iterationCount = (data.iterationCount as number) || 0;
    this._reasoningEffort = data.reasoningEffort as string | undefined;
  }
}
