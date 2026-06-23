// Agent - the core AI agent with tool calling support.
// Thin orchestrator that delegates behavior to hooks.

import crypto from "node:crypto";
import { Message } from "./context/message.js";
import { LlmError } from "./llm-client/client.js";
import { OUTPUT_EVENT } from "./context/output.js";
import { formatError } from "./error.js";
import { HOOKS } from "./hooks.js";
import { ToolContext } from "./extensions/tool-context.js";
import { xmlEscape } from "./extensions/tool-utils.js";
import { createCommandRegistry } from "./extensions/registries.js";
import { DEFAULT_MAX_TOKENS } from "./config/defaults.js";

/**
 * Minimal Agent that runs the LLM loop and delegates behavior to hooks.
 */
export class Agent {
  /**
   * @param {Object} options
   * @param {Object} options.hooks — HookSystem instance
   * @param {Object} options.toolRegistry — ToolRegistry instance
   * @param {Object} options.llmClient — LlmClient instance
   * @param {string} options.model — Model name
   * @param {number} [options.maxIterations=1000] — Max loop iterations
   * @param {number} [options.maxTokens] — Token threshold for context:full (default: DEFAULT_MAX_TOKENS)
   * @param {boolean} [options.hideTools=true] — Hide tool display
   * @param {boolean} [options.hideThinking=false] — Hide thinking display
   * @param {boolean} [options.showTokenUse=true] — Show token usage
   * @param {Object} [options.sink] — Output sink
   * @param {Object} [options.modelRegistry] — Model name → config map
   * @param {string} [options.profileName] — Current profile name
   * @param {Object} [options.config] — Config reference
   * @param {string} [options.sessionId] — Session ID
   * @param {string} [options.role] — Role description
   * @param {string} [options.profileBody] — Profile body content
   * @param {boolean} [options.stream=true] — Enable streaming
   * @param {AbortSignal} [options.abortSignal] — Abort signal for cancellation
   * @param {string[]} [options.toolWhitelist] — Allowed tool names (restricts available tools)
   */
  constructor(options = {}) {
    this._hooks = options.hooks;
    this._toolRegistry = options.toolRegistry;
    this._llmClient = options.llmClient;
    this._context = [];
    this.__model = options.model;
    this._maxIterations = options.maxIterations || 1000;
    this._maxTokens = options.maxTokens || DEFAULT_MAX_TOKENS;
    this._hideTools = options.hideTools !== false;
    this._hideThinking = options.hideThinking === true;
    this._showTokenUse = options.showTokenUse !== false;
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
    this._toolDefs = null;
    // Task agent support
    this._abortSignal = options.abortSignal || null;
    this._toolWhitelist = options.toolWhitelist || null;
    this._followQueue = [];
    // AbortController for the current LLM request — created per iteration,
    // aborted on cancel() so the HTTP client properly terminates fetch().
    this._runAbortController = null;
    // Command registry — extensions register commands here
    this._commandRegistry = options.commandRegistry || createCommandRegistry();
  }

  // ── Properties ────────────────────────────────────────────────────────────

  get model() {
    return this.__model;
  }
  set model(v) {
    const oldModel = this.__model;
    this.__model = v;
    // Pull in the new model's config from the registry
    const entry = this._modelRegistry[v];
    if (entry) {
      this._maxTokens = entry.maxTokens || DEFAULT_MAX_TOKENS;
      // Reset reasoning effort to the new model's default —
      // the user can re-override via /reasoning if needed.
      this._reasoningEffort = entry.reasoningEffort;
    }
    this._hooks.notifyHooks(HOOKS.MODEL_CHANGE, {
      agent: this,
      oldModel,
      newModel: v,
    });
  }

  get isRestoring() {
    return this._isRestoring;
  }
  set isRestoring(v) {
    const oldVal = this._isRestoring;
    this._isRestoring = v;
    if (oldVal !== v) {
      this._hooks.notifyHooks(HOOKS.SESSION_RESTORE_ACTIVE, {
        agent: this,
        isRestoring: v,
      });
    }
  }

  get context() {
    return this._context;
  }
  get iterationCount() {
    return this._iterationCount;
  }
  get sessionId() {
    return this._sessionId;
  }
  get cancelled() {
    return this._cancelled;
  }
  get hideTools() {
    return this._hideTools;
  }
  set hideTools(v) {
    this._hideTools = v;
  }

  get hideThinking() {
    return this._hideThinking;
  }
  set hideThinking(v) {
    this._hideThinking = v;
  }

  get systemPrompt() {
    return this._systemPrompt;
  }

  /**
   * The LLM client used for API calls.
   * @type {import('./llm-client/client.js').LlmClient}
   */
  get llmClient() {
    return this._llmClient;
  }

  // ── Run Loop ──────────────────────────────────────────────────────────────

  /**
   * Run the agent loop with the given user input.
   * @param {string} userInput — Text content of the user message
   * @param {Array<{type: string, mimeType: string, data: string}>} [images] — Optional images
   *   Each image: { type: "image_url", mimeType: "image/png", data: "<base64>" }
   * @returns {Promise<string|undefined>} Final text response, or undefined if tool calls
   */
  async run(userInput, images = null) {
    // Ensure system prompt is built (e.g. after /clear or /regenerate)
    await this.ensureSystemPrompt();

    // Add user input to context
    const userMsg = new Message({ role: "user", content: userInput, images });
    this.addMessage(userMsg);

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
        const followUp = this._followQueue.shift();
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
      if (contextResult.lastResult?.messages) {
        messages = contextResult.lastResult.messages;
      }

      // LLM call
      let toolDefs = await this._toolRegistry.getToolDefs();
      let modelConfig = this._resolveModelConfig();

      // Before provider request — sequential, modifiable. Extensions can
      // log the request, modify messages, change model config, or alter tools.
      const reqResult = await this._hooks.runHookPipeline(HOOKS.PROVIDER_REQUEST, {
        messages,
        modelConfig,
        toolDefs,
        agent: this,
      });
      if (reqResult.lastResult?.messages) messages = reqResult.lastResult.messages;
      if (reqResult.lastResult?.modelConfig) modelConfig = reqResult.lastResult.modelConfig;
      if (reqResult.lastResult?.toolDefs) toolDefs = reqResult.lastResult.toolDefs;

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
          () => this._runAbortController.abort(),
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
          messages: this._context,
        });

        // Emit token usage
        if (this._showTokenUse && response.usage) {
          this._emitOutput("token_usage", {
            promptTokens: response.usage.prompt_tokens || 0,
            cachedTokens:
              response.usage.prompt_tokens_details?.cached_tokens || 0,
            completionTokens: response.usage.completion_tokens || 0,
            totalTokens: response.usage.total_tokens || 0,
          });
        }

        const assistantMsg = new Message({
          role: "assistant",
          content: response.fullText,
          reasoningContent: response.fullReasoning,
          toolCalls: response.finalToolCalls,
        });
        this._context.push(assistantMsg);

        // Tool execution
        if (response.finalToolCalls) {
          const { outcome, toolResults } = await this._executeTools(
            response.finalToolCalls,
          );
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

    throw new Error(`Max iterations (${this._maxIterations}) reached`);
  }

  /**
   * Called when the agent completes (for task agents).
   * @param {string} result - The final result text
   */
  _notifyCompletion(result) {
    if (this._sink && typeof this._sink.onTaskComplete === "function") {
      this._sink.onTaskComplete(result);
    }
  }

  // ── Message Building ──────────────────────────────────────────────────────

  /**
   * Build messages array: system prompt + context.
   * System prompt is built via hooks (extensions add to it).
   * Public so extensions can rebuild messages after modifying context
   * (e.g., compaction).
   * @returns {Message[]}
   */
  buildMessages() {
    if (this._systemPrompt) {
      return [
        new Message({ role: "system", content: this._systemPrompt }),
        ...this._context,
      ];
    }
    return [...this._context];
  }

  /**
   * Ensure system prompt is built and cached.
   * Extensions contribute chunks via the SYSTEM_PROMPT_BUILD hook.
   * Chunks are sorted by priority and rendered via the template.
   */
  async ensureSystemPrompt() {
    if (this._systemPrompt) return;

    // Import here to avoid circular dependency
    const { buildSystemPrompt } =
      await import("./context/system-prompt.js");

    // Collect chunks from extensions via hook return values.
    // Each handler returns a chunk object { name, priority, content } or
    // an array of such objects. Source prefixing is applied by the agent
    // based on the handler's registration source.
    const chunks = [];
    const { results } = await this._hooks.runHookPipeline(
      HOOKS.SYSTEM_PROMPT_BUILD,
      { agent: this },
    );
    for (const { result, source } of results) {
      const items = Array.isArray(result) ? result : [result];
      for (const item of items) {
        if (item && item.name && item.content) {
          const fullName = source ? `${source}:${item.name}` : item.name;
          chunks.push({
            name: fullName,
            priority: item.priority,
            content: item.content,
          });
        }
      }
    }

    // Sort by priority (lower = earlier in the prompt)
    chunks.sort((a, b) => a.priority - b.priority);

    // Build the system prompt
    this._systemPrompt = await buildSystemPrompt({
      role: this._role || "",
      body: this._profileBody || "",
      model: this.__model || "",
      profileName: this._profileName || "default",
      chunks,
    });
  }

  // ── Stream Processing ─────────────────────────────────────────────────────

  /**
   * Process a streaming LLM response.
   * Normalizes tool calls to OpenAI format: { id, type, function: { name, arguments } }.
   *
   * @param {AsyncIterable} stream
   * @returns {Promise<Object>} { fullText, fullReasoning, finalToolCalls, usage }
   */
  async _processStream(stream) {
    let fullText = "";
    let fullReasoning = null;
    const toolCallsBuffer = new Map();
    let usage = null;

    for await (const event of stream) {
      if (this._cancelled) throw LlmError.Cancelled("Agent cancelled");

      switch (event.type) {
        case "content":
          fullText += event.content;
          if (this._stream) {
            this._emitOutput("streaming_chunk", { content: event.content });
          }
          break;
        case "reasoning":
          if (!fullReasoning) fullReasoning = "";
          fullReasoning += event.content;
          if (this._stream) {
            this._emitOutput("streaming_reasoning_chunk", {
              content: event.content,
            });
          }
          break;
        case "toolName":
          toolCallsBuffer.set(event.index, {
            name: event.name,
            args: "",
            id: event.toolCallId || "",
          });
          break;
        case "toolArgument": {
          const existing = toolCallsBuffer.get(event.index) || {
            name: "",
            args: "",
            id: "",
          };
          existing.args += event.arguments;
          toolCallsBuffer.set(event.index, existing);
          break;
        }
        case "usage":
          usage = event.data;
          break;
      }
    }

    // Build final tool calls from buffer
    let finalToolCalls = null;
    if (toolCallsBuffer.size > 0) {
      finalToolCalls = Array.from(toolCallsBuffer.values()).map(
        (tc, index) => ({
          id: tc.id || crypto.randomUUID(),
          type: "function",
          function: { name: tc.name, arguments: tc.args },
        }),
      );
    }

    return { fullText, fullReasoning, finalToolCalls, usage };
  }

  // ── Tool Execution ────────────────────────────────────────────────────────

  /**
   * Execute tool calls from an LLM response.
   * Thin loop that delegates per-call logic to _executeSingleToolCall.
   *
   * @param {Array} toolCalls
   * @returns {Promise<{outcome: string, toolResults: Array}>}
   *   outcome: 'continue' or 'return'
   *   toolResults: array of { toolName, input, result } for each tool executed
   */
  async _executeTools(toolCalls) {
    const toolResults = [];

    for (const tc of toolCalls) {
      const result = await this._executeSingleToolCall(tc);
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
   * Tool call shape (normalized by _processStream to match OpenAI format):
   *   { id, type: "function", function: { name, arguments } }
   *
   * @param {Object} tc — Tool call from the LLM response (normalized format).
   * @returns {Promise<{toolName: string, input: string, result: string}>}
   */
  async _executeSingleToolCall(tc) {
    // Tool calls are normalized by _processStream to OpenAI format:
    //   { id, type: "function", function: { name, arguments } }
    const toolName = tc.function?.name;
    const toolCallId = tc.id;
    let input = tc.function?.arguments || "{}";

    // 1. Whitelist check (for task agents)
    if (this._toolWhitelist && !this._toolWhitelist.includes(toolName)) {
      const msg = `Tool '${toolName}' is not available for this agent`;
      return this._writeToolResult(toolName, input, msg, toolCallId);
    }

    // 2. Emit tool call event + before-execute hook
    this._emitOutput("tool_call", { toolName, input, toolCallId });
    await this._hooks.notifyHooksAsync(HOOKS.TOOL_BEFORE_EXECUTE, {
      toolCallId,
      toolName,
      input,
      agent: this,
    });

    // 3. Tool call gate — sequential, modifiable. Handlers can block, modify
    //    input args, or allow execution to proceed.
    //    Actions: { action: "continue" } | { action: "modify", input } | { action: "block", result }
    const callResult = await this._hooks.runHookPipeline(HOOKS.TOOL_CALL, {
      toolCallId,
      toolName,
      input,
      agent: this,
    });
    if (callResult.lastResult?.action === "block") {
      // Extension blocked this tool call — use provided result
      const blockedResult = this._formatToolResult(
        callResult.lastResult.result,
        toolName,
        false,
      );
      return this._writeToolResult(toolName, input, blockedResult, toolCallId);
    }
    if (callResult.lastResult?.action === "modify" && callResult.lastResult.input !== undefined) {
      // Extension modified the input args
      input = callResult.lastResult.input;
    }

    // 4. Build and enrich tool context via hook
    const toolCtx = this._buildToolContext(toolName);
    await this._hooks.notifyHooksAsync(HOOKS.AGENT_TOOL_CONTEXT, {
      toolCtx,
      toolName,
      agent: this,
    });

    // 5. Resolve tool from registry
    const tool = this._toolRegistry.get(toolName);
    if (!tool) {
      return this._writeToolResult(
        toolName,
        input,
        `Unknown tool: ${toolName}`,
        toolCallId,
      );
    }

    // 6. Validate arguments against tool's JSON Schema
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

    // 7. Execute the tool
    let result;
    let success;
    try {
      result = await tool.execute(input, toolCtx);
      success = true;
    } catch (e) {
      result = `Error executing tool ${toolName}: ${e.message}`;
      success = false;
    }

    // 8. After-execute hook + result modification hook
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
    if (resultHook.lastResult?.result !== undefined) {
      result = resultHook.lastResult.result;
    }

    // 9. Extract images from ToolResult before formatting
    const images = result && result.images ? result.images : null;

    // 10. Format and write result to context
    const resultStr = this._formatToolResult(result, toolName, success);
    return this._writeToolResult(
      toolName,
      input,
      resultStr,
      toolCallId,
      images,
    );
  }

  /**
   * Build a ToolContext with standard infrastructure fields.
   * Extensions can further enrich it via the AGENT_TOOL_CONTEXT hook.
   *
   * @param {string} toolName
   * @returns {ToolContext}
   */
  _buildToolContext(toolName) {
    const toolCtx = new ToolContext();
    toolCtx.set("agent", this);
    toolCtx.set("isSessionRestoring", this._isRestoring);
    // Mount infrastructure properties from config
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
   * @param {string} toolName
   * @param {string} input
   * @param {string} result
   * @param {string} toolCallId
   * @param {Array<{type: string, mimeType: string, data: string}>} [images] — Optional images
   * @returns {{toolName: string, input: string, result: string}}
   */
  async _writeToolResult(toolName, input, result, toolCallId, images) {
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

  /**
   * Format a tool result for the API.
   * Default: XML format. Extensions can register custom formatters.
   * @param {*} result
   * @param {string} toolName
   * @returns {string}
   */
  _formatToolResult(result, toolName, success) {
    // If the result has a toApiContent method, use it (ToolResult)
    if (result && typeof result.toApiContent === "function") {
      return result.toApiContent(toolName);
    }
    const successStr = success ? "success" : "error";
    // String: wrap in XML
    if (typeof result === "string") {
      return `<tool name="${toolName}" status="${successStr}">\n  <output>${xmlEscape(result)}</output>\n</tool>`;
    }
    // Object: serialize and wrap
    if (typeof result === "object" && result !== null) {
      const json = JSON.stringify(result);
      return `<tool name="${toolName}" status="${successStr}">\n  <output>${xmlEscape(json)}</output>\n</tool>`;
    }
    // Primitive
    const str = String(result);
    return `<tool name="${toolName}" status="${successStr}">\n  <output>${xmlEscape(str)}</output>\n</tool>`;
  }

  // ── Public Context API ────────────────────────────────────────────────────

  /**
   * Add a single message to the agent's context.
   * Fires the CONTEXT_MESSAGE hook so extensions (session-log, etc.) are notified.
   * Use this instead of directly pushing to _context.
   *
   * @param {Message} msg - The message to add.
   */
  addMessage(msg) {
    this._context.push(msg);
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
   * @param {Array} newContext - The new context array (array of Message objects or plain objects).
   */
  replaceContext(newContext) {
    const oldContext = this._context;
    this._context = newContext;
    this._hooks.notifyHooksAsync(HOOKS.CONTEXT_REPLACED, {
      agent: this,
      oldContext,
      newContext,
    });
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _resolveModelConfig() {
    const fromRegistry = this._modelRegistry[this.__model] || {
      name: this.__model,
      temperature: null,
      maxTokens: DEFAULT_MAX_TOKENS,
      reasoningEffort: undefined,
    };
    // Runtime override via /reasoning command takes priority
    if (this._reasoningEffort !== undefined) {
      return {
        ...fromRegistry,
        reasoningEffort: this._reasoningEffort,
      };
    }
    return fromRegistry;
  }

  _emitOutput(type, data) {
    if (this._sink) {
      this._sink.emit({ type: OUTPUT_EVENT[type.toUpperCase()], ...data });
    }
    this._hooks.notifyHooks(HOOKS.OUTPUT_EVENT, { type, data, agent: this });
  }

  // ── Session Management ────────────────────────────────────────────────────

  /**
   * Clear the context and start fresh.
   */
  async clearContext() {
    this.replaceContext([]);
    this._systemPrompt = null;
    this._iterationCount = 0;
    await this.ensureSystemPrompt();
  }

  /**
   * Cancel the current run.
   * Sets the cancelled flag and aborts the active HTTP request
   * via the per-iteration AbortController.
   */
  cancel(flag = true) {
    this._cancelled = flag;
    // Abort the active LLM request so the HTTP client terminates fetch().
    if (this._runAbortController && !this._runAbortController.signal.aborted) {
      this._runAbortController.abort();
    }
  }

  /**
   * Get tool definitions for the API.
   */
  async getToolDefs() {
    return await this._toolRegistry.getToolDefs();
  }

  /**
   * Get all registered tool names.
   */
  getToolNames() {
    return Array.from(this._toolRegistry.getAll().map(([name]) => name));
  }

  /**
   * Execute a command. Returns { content } or { error }.
   * Delegates to hooks — extensions handle specific commands.
   * @param {Object} cmd - Command object { type, value }
   * @returns {Promise<Object>}
   */
  async executeCommand(cmd) {
    // Check if this is a custom command with a handler
    if (cmd._customCommand && cmd._handler) {
      const result = await cmd._handler(this, cmd.value, cmd);
      if (result) return result;
    }

    // Run COMMAND_DISPATCH hook pipeline — extensions can handle specific commands.
    // The pipeline returns the last handler's result; if it's truthy we use it.
    const pipelineResult = await this._hooks.runHookPipeline(HOOKS.COMMAND_DISPATCH, {
      command: cmd,
      agent: this,
    });

    const lastResult = pipelineResult.lastResult;
    if (lastResult && typeof lastResult.then === "function") {
      const awaited = await lastResult;
      if (awaited) return awaited;
    } else if (lastResult) {
      return lastResult;
    }

    // Default command handling (core commands)
    switch (cmd.type) {
      case "clear":
        await this.clearContext();
        return { content: "Context cleared." };
      case "quit":
        return { error: "UI command: quit" };
      case "help":
        return { error: "UI command: help" };
      case "tokens":
        return this._handleTokensCommand();
      case "tools":
        return this._handleToolsCommand();
      case "thinking":
        return this._handleThinkingCommand();
      case "regenerate":
        return this._handleRegenerateCommand();
      case "reasoning":
        return this._handleReasoningCommand(cmd.value);
      default:
        return { error: `Unknown command: ${cmd.type}` };
    }
  }

  /**
   * Get the command registry.
   * @returns {Object} CommandRegistry instance
   */
  getCommandRegistry() {
    return this._commandRegistry;
  }

  // ── Command Handlers ──────────────────────────────────────────────────────

  _handleTokensCommand() {
    return { content: "Token stats not yet tracked." };
  }

  _handleToolsCommand() {
    this._hideTools = !this._hideTools;
    this._emitOutput("session_state", {
      key: "hideTools",
      value: this._hideTools,
    });
    return {
      content: `Tool display: ${this._hideTools ? "hidden" : "shown"}`,
    };
  }

  _handleThinkingCommand() {
    this._hideThinking = !this._hideThinking;
    this._emitOutput("session_state", {
      key: "hideThinking",
      value: this._hideThinking,
    });
    return {
      content: `Thinking display: ${this._hideThinking ? "hidden" : "shown"}`,
    };
  }

  async _handleRegenerateCommand() {
    this._systemPrompt = null;
    await this.ensureSystemPrompt();
    return { content: "System prompt regenerated." };
  }

  _handleReasoningCommand(value) {
    const valid = ["none", "minimal", "low", "high", "xhigh", "max", "unset"];
    // No argument — show current setting
    if (!value) {
      const current = this._reasoningEffort !== undefined
        ? this._reasoningEffort
        : "(not set, omitted from requests)";
      return { content: `Current reasoning effort: ${current}` };
    }
    if (value === "unset") {
      this._reasoningEffort = undefined;
      return { content: "Reasoning effort unset (omitted from requests)." };
    }
    if (valid.includes(value)) {
      this._reasoningEffort = value;
      return { content: `Reasoning effort set to: ${value}` };
    }
    return {
      error: `Invalid reasoning effort '${value}'. Valid: none, minimal, low, high, xhigh, max, unset`,
    };
  }

  /**
   * Serialize the agent state for persistence.
   * Messages are serialized via Message.toJSON() which handles:
   * - Plain text content as string
   * - Content with images as array of { type: "text", text } and { type: "image_url", image_url } parts
   * - Images stored separately as { type: "image_url", mimeType, data } for session log
   * @returns {Object}
   */
  serialize() {
    return {
      sessionId: this._sessionId,
      context: this._context.map((m) => m.toJSON()),
      model: this.model,
      iterationCount: this._iterationCount,
      reasoningEffort: this._reasoningEffort,
    };
  }

  /**
   * Deserialize agent state from persisted data.
   * Handles both plain text content and array content (with image_url parts).
   * @param {Object} data
   */
  deserialize(data) {
    this._sessionId = data.sessionId;
    this.replaceContext(data.context.map((m) => new Message(m)));
    this.model = data.model;
    this._iterationCount = data.iterationCount || 0;
    this._reasoningEffort = data.reasoningEffort !== undefined ? data.reasoningEffort : undefined;
  }
}
