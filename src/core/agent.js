// Minimal Agent — the core AI agent with tool calling support.
// Thin orchestrator that delegates behavior to hooks.
// Behaviors (compaction, tools, system prompt, commands) live in extensions.

import { Message } from "../context/message.js";
import { LlmError } from "../llm_client/client.js";
import { OUTPUT_EVENT } from "../context/output.js";
import { HOOKS } from "./hooks.js";

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
   * @param {number} [options.maxTokens=4096] — Token threshold for context:full
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
   * @param {Object} [options.compaction] — Compaction config
   * @param {boolean} [options.compactDebug] — Write debug file
   */
  constructor(options = {}) {
    this._hooks = options.hooks;
    this._toolRegistry = options.toolRegistry;
    this._llmClient = options.llmClient;
    this._context = [];
    this._model = options.model;
    this._maxIterations = options.maxIterations || 1000;
    this._maxTokens = options.maxTokens || 4096;
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
    this._compaction = options.compaction;
    this._compactDebug = options.compactDebug;
    this._cancelled = false;
    this._iterationCount = 0;
    this._systemPrompt = null;
    this._toolDefs = null;
  }

  // ── Properties ────────────────────────────────────────────────────────────

  get model() {
    return this._model;
  }
  set model(v) {
    this._model = v;
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

  // ── Run Loop ──────────────────────────────────────────────────────────────

  /**
   * Run the agent loop with the given user input.
   * @param {string} userInput
   * @returns {Promise<string|undefined>} Final text response, or undefined if tool calls
   */
  async run(userInput) {
    await this._hooks.emitAsync(HOOKS.AGENT_BEFORE_RUN, { userInput });

    // Add user input to context
    const userMsg = new Message({ role: "user", content: userInput });
    this._context.push(userMsg);
    await this._hooks.emitAsync(HOOKS.CONTEXT_MESSAGE, { message: userMsg });

    let iteration = 0;
    while (iteration < this._maxIterations) {
      iteration++;
      this._iterationCount = iteration;

      if (this._cancelled) {
        throw LlmError.Cancelled("Agent cancelled");
      }

      // Build messages (extensions can modify via hook)
      const messages = this._buildMessages();
      await this._hooks.emitAsync(HOOKS.MESSAGES_BUILD, {
        messages,
        agent: this,
      });

      // Check context size — trigger compaction extension if needed
      if (this._context.length > this._maxTokens / 100) {
        await this._hooks.emitAsync(HOOKS.CONTEXT_FULL, {
          agent: this,
          contextSize: this._context.length,
        });
      }

      // LLM call
      const toolDefs = this._toolRegistry.getToolDefs();
      const modelConfig = this._resolveModelConfig();
      const stream = this._llmClient.chatStreamCancellable(
        messages,
        modelConfig,
        toolDefs,
        { aborted: this._cancelled },
      );

      const response = await this._processStream(stream);
      await this._hooks.emitAsync(HOOKS.MESSAGES_AFTER_LLM, {
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
        const outcome = await this._executeTools(response.finalToolCalls);
        if (outcome !== "continue") return outcome;
      } else {
        await this._hooks.emitAsync(HOOKS.CONTEXT_MESSAGE, {
          message: assistantMsg,
        });
        return response.fullText;
      }
    }

    throw new Error(`Max iterations (${this._maxIterations}) reached`);
  }

  // ── Message Building ──────────────────────────────────────────────────────

  /**
   * Build messages array: system prompt + context.
   * System prompt is built via hooks (extensions add to it).
   * @returns {Message[]}
   */
  _buildMessages() {
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
   * Extensions hook into systemPrompt:build to contribute.
   */
  async ensureSystemPrompt() {
    if (this._systemPrompt) return;

    // Build prompt via hook — extensions can contribute
    const promptParts = [];

    // Core: role + profile body
    if (this._role) promptParts.push(this._role);
    if (this._profileBody) promptParts.push(this._profileBody);

    // Hook: let extensions add to the system prompt
    const hookResult = this._hooks.emit(HOOKS.SYSTEM_PROMPT_BUILD, {
      agent: this,
      promptParts,
    });
    if (hookResult && hookResult.promptParts) {
      promptParts.push(...hookResult.promptParts);
    }

    this._systemPrompt = promptParts.filter(Boolean).join("\n\n");
  }

  // ── Stream Processing ─────────────────────────────────────────────────────

  /**
   * Process a streaming LLM response.
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
          id: tc.id || `call_${index}_${Date.now()}`,
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
   * @param {Array} toolCalls
   * @returns {Promise<string>} 'continue' or 'return'
   */
  async _executeTools(toolCalls) {
    for (const tc of toolCalls) {
      const toolName = tc.function?.name || tc.toolName;
      const toolCallId = tc.id || tc.toolCallId;
      const input = tc.function?.arguments || tc.input || "{}";

      // Emit tool call event
      this._emitOutput("tool_call", { toolName, input, toolCallId });

      // Emit before-execute hook
      await this._hooks.emitAsync(HOOKS.TOOL_BEFORE_EXECUTE, {
        toolName,
        input,
        agent: this,
      });

      // Check tool allowance
      const isAllowed =
        (await this._hooks.emitAsync(HOOKS.TOOL_BEFORE_EXECUTE, {
          toolName,
          agent: this,
        })) || true;
      // (Skill filtering is handled by the skills extension via the hook)

      // Execute the tool
      const tool = this._toolRegistry.get(toolName);
      if (!tool) {
        const errorMsg = `Unknown tool: ${toolName}`;
        this._context.push(
          new Message({
            role: "tool",
            content: errorMsg,
            toolCallId,
          }),
        );
        await this._hooks.emitAsync(HOOKS.CONTEXT_MESSAGE, {
          message: this._context[this._context.length - 1],
        });
        continue;
      }

      let result;
      try {
        result = await tool.execute(input, { agent: this });
      } catch (e) {
        result = `Error executing tool ${toolName}: ${e.message}`;
      }

      // Emit after-execute hook
      await this._hooks.emitAsync(HOOKS.TOOL_AFTER_EXECUTE, {
        toolName,
        result,
        agent: this,
      });

      // Convert result to string for API
      const resultStr = this._formatToolResult(result, toolName);

      // Emit tool result event
      this._emitOutput("tool_result", { toolName, input, result: resultStr });

      // Add tool result to context
      const toolMsg = new Message({
        role: "tool",
        content: resultStr,
        toolCallId,
      });
      this._context.push(toolMsg);
      await this._hooks.emitAsync(HOOKS.CONTEXT_MESSAGE, { message: toolMsg });

      // Check for wait tool — model is yielding control
      if (toolName === "wait") return "return";
    }

    return "continue";
  }

  /**
   * Format a tool result for the API.
   * Default: XML format. Extensions can register custom formatters.
   * @param {*} result
   * @param {string} toolName
   * @returns {string}
   */
  _formatToolResult(result, toolName) {
    // If the result has a toApiContent method, use it (ToolResult)
    if (result && typeof result.toApiContent === "function") {
      return result.toApiContent(toolName);
    }
    // String: wrap in XML
    if (typeof result === "string") {
      return `<tool name="${toolName}" status="success">\n  <output>${this._xmlEscape(result)}</output>\n</tool>`;
    }
    // Object: serialize and wrap
    if (typeof result === "object" && result !== null) {
      const json = JSON.stringify(result);
      return `<tool name="${toolName}" status="success">\n  <output>${this._xmlEscape(json)}</output>\n</tool>`;
    }
    // Primitive
    const str = String(result);
    return `<tool name="${toolName}" status="success">\n  <output>${this._xmlEscape(str)}</output>\n</tool>`;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  _resolveModelConfig() {
    return (
      this._modelRegistry[this._model] || {
        name: this._model,
        temperature: null,
        maxTokens: 4096,
      }
    );
  }

  _emitOutput(type, data) {
    if (this._sink) {
      this._sink.emit({ type: OUTPUT_EVENT[type.toUpperCase()], ...data });
    }
    this._hooks.emit(HOOKS.OUTPUT_EVENT, { type, data });
  }

  _xmlEscape(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  // ── Session Management ────────────────────────────────────────────────────

  /**
   * Clear the context and start fresh.
   */
  clearContext() {
    this._context = [];
    this._systemPrompt = null;
    this._iterationCount = 0;
  }

  /**
   * Cancel the current run.
   */
  cancel(flag = true) {
    this._cancelled = flag;
  }

  /**
   * Get tool definitions for the API.
   */
  getToolDefs() {
    return this._toolRegistry.getToolDefs();
  }

  /**
   * Get all registered tool names.
   */
  getToolNames() {
    return Array.from(this._toolRegistry.getAll().map(([name]) => name));
  }

  /**
   * Execute a slash command. Returns { content } or { error }.
   * Delegates to hooks — extensions handle specific commands.
   * @param {Object} cmd - Command object { type, value }
   * @returns {Promise<Object>}
   */
  async executeCommand(cmd) {
    const result = this._hooks.emit(HOOKS.COMMAND_DISPATCH, {
      command: cmd,
      agent: this,
    });

    // Handle async hook results (Promises)
    if (result && typeof result.then === "function") {
      const awaited = await result;
      if (awaited) return awaited;
    } else if (result) {
      return result;
    }

    // Default command handling (core commands)
    switch (cmd.type) {
      case "clear":
        this.clearContext();
        return { content: "Context cleared." };
      case "quit":
        return { error: "UI command: quit" };
      case "help":
        return { error: "UI command: help" };
      case "model":
        return this._handleModelCommand(cmd);
      case "models":
        return this._handleModelsCommand();
      case "tokens":
        return this._handleTokensCommand();
      case "tools":
        return this._handleToolsCommand();
      case "thinking":
        return this._handleThinkingCommand();
      case "compact":
        return await this._handleCompactCommand(cmd.value);
      case "compact:strategy":
        return this._handleCompactStrategyCommand(cmd.value);
      case "regenerate":
        return this._handleRegenerateCommand();
      default:
        return { error: `Unknown command: ${cmd.type}` };
    }
  }

  // ── Command Handlers ──────────────────────────────────────────────────────

  _handleModelCommand(cmd) {
    if (!cmd?.value) {
      return {
        content: `Available models: ${Object.keys(this._modelRegistry).join(", ")}`,
      };
    }
    this._model = cmd.value;
    this.clearContext();
    return { content: `Switched to model: ${cmd.value}` };
  }

  _handleModelsCommand() {
    const models = Object.keys(this._modelRegistry);
    if (models.length === 0) {
      return {
        content: "No models configured. Add providers to your config file.",
      };
    }
    const lines = ["Available models:"];
    for (const name of models) {
      const m = this._modelRegistry[name];
      const tags = m.tags ? ` [${m.tags.join(", ")}]` : "";
      lines.push(`  ${name}${tags}`);
    }
    lines.push(`\nCurrently using: ${this._model}`);
    return { content: lines.join("\n") };
  }

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

  async _handleCompactCommand(value) {
    if (!value) {
      return { content: "Usage: /compact [n] [--compact-debug]" };
    }
    // Trigger compaction via hook — the compaction extension handles it
    await this._hooks.emitAsync(HOOKS.CONTEXT_FULL, {
      agent: this,
      contextSize: this._context.length,
    });
    return { content: "Compaction triggered." };
  }

  _handleCompactStrategyCommand(value) {
    const { action, name } = value || { action: "list" };

    // Check if compaction extension is loaded
    const compactionExt = this._hooks._extensions?.get?.("compaction");
    if (!compactionExt) {
      return { content: "Compaction extension not loaded." };
    }

    if (action === "list" || action === "") {
      const strategies = compactionExt.getStrategyList();
      const current = compactionExt.settings?.strategy || "summarize";
      const lines = ["\nCompaction Strategies:\n"];
      for (const s of strategies) {
        const marker = s.name === current ? " (current)" : "";
        lines.push(`  ${s.name}${marker} — ${s.description}`);
      }
      lines.push(`\nCurrent strategy: ${current}\n`);
      return { content: lines.join("") };
    }

    if (action === "set") {
      if (!name) {
        return { content: "Usage: /compact:strategy <name>" };
      }
      compactionExt.settings.strategy = name;
      return { content: `Compaction strategy set to: ${name}` };
    }

    if (action === "help") {
      const strategies = compactionExt.getStrategyList();
      const lines = ["\nCompaction Strategies:\n"];
      for (const s of strategies) {
        lines.push(`  ${s.name} — ${s.description}`);
      }
      lines.push(
        "\nUsage:\n" +
          "  /compact:strategy              — List strategies\n" +
          "  /compact:strategy <name>       — Set strategy\n" +
          "  /compact:strategy help         — Show help\n" +
          "  /compact:strategy help <name>  — Show strategy details\n",
      );
      return { content: lines.join("") };
    }

    return { error: `Unknown action: ${action}` };
  }

  _handleRegenerateCommand() {
    this._systemPrompt = null;
    return { content: "System prompt regenerated." };
  }

  /**
   * Serialize the agent state for persistence.
   * @returns {Object}
   */
  serialize() {
    return {
      sessionId: this._sessionId,
      context: this._context.map((m) => m.toJSON()),
      model: this._model,
      iterationCount: this._iterationCount,
    };
  }

  /**
   * Deserialize agent state from persisted data.
   * @param {Object} data
   */
  deserialize(data) {
    this._sessionId = data.sessionId;
    this._context = data.context.map((m) => new Message(m));
    this._model = data.model;
    this._iterationCount = data.iterationCount || 0;
  }
}
