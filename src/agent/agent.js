// Agent — the core AI agent with tool calling support.
// Manages conversation context, model selection, tool execution, and the run loop.

import fs from "node:fs";
import {
  MessageLog,
  outputEvent,
  OUTPUT_EVENT,
  Message,
} from "../context/index.js";
import { LlmClient, LlmError } from "../llm_client/client.js";
import { render } from "../context/render.js";
import { ToolRegistry, ToolContext } from "../tools/registry.js";
import {
  createToolFactory,
  CORE_TOOL_NAMES,
  SUBAGENT_TOOL_NAMES,
  toolResult,
  registerLspTools,
} from "../tools/index.js";
import {
  DEFAULT_MODEL,
  DEFAULT_MAX_TOKENS,
  DEFAULT_MAX_ITERATIONS,
  DEFAULT_ROLE,
  defaultCompactionSettings,
  getProfile,
} from "../config.js";
import { NoopSink } from "../context/output.js";
import {
  buildSystemPrompt,
  loadAspects,
  loadAgentsMd,
} from "../context/system_prompt.js";
import { disabledSessionLog } from "../session_log.js";
import {
  findFirstKeptIndex,
} from "../compaction.js";
import {
  CompactionStrategyRegistry,
} from "../compaction/strategies.js";
import { SummarizeStrategy } from "../compaction/strategies/summarize.js";
import { DropStrategy } from "../compaction/strategies/drop.js";
import { SummarizeShortStrategy } from "../compaction/strategies/summarize-short.js";
import { TokenAwareStrategy } from "../compaction/strategies/token-aware.js";
import { DEFAULT_COMPACTION_STRATEGY } from "../config.js";
import { McpTool } from "../mcp/tools.js";

/**
 * Check if a tool name matches a skill pattern (exact or glob).
 * Used by isToolAllowed and filteredToolDefs.
 */
function _toolMatchesPattern(toolName, patterns) {
  const nameLower = toolName.toLowerCase();
  return Array.from(patterns).some((pattern) => {
    if (pattern === nameLower) return true;
    if (!pattern.includes("*")) return false;
    return _globMatch(pattern, nameLower);
  });
}

export class Agent {
  /**
   * Create a new Agent from a config object.
   * Used by SessionBuilder for agent construction and swapping.
   */
  constructor(config = {}) {
    this.client = config.client || new LlmClient();
    this.context = new MessageLog();
    this.model = config.model || DEFAULT_MODEL;
    this.modelRegistry = config.modelRegistry || {};
    this.sink = config.sink || new NoopSink();
    this.hideTools = config.hideTools !== false;
    this.hideThinking = config.hideThinking === true;
    this.skills = config.skills || [];
    this._allSkills = config.allSkills || [];
    this.skillDirectories = config.skillDirectories || [];
    this.activeSkills = new Set();
    this.maxToolOutputLines = config.maxToolOutputLines || 800;
    this.sessionId = config.sessionId || crypto.randomUUID();
    this.cwdBoundary = config.cwdBoundary || null;
    this.role = config.role || DEFAULT_ROLE;
    this.profileBody = config.profileBody || "";
    this.stream = config.stream !== false;
    this.compaction = config.compaction || defaultCompactionSettings;
    this.compactDebug = config.compactDebug || false;
    this.showTokenUse = config.showTokenUse !== false;
    // Compaction strategy
    this.compactionStrategy = config.compaction?.strategy || DEFAULT_COMPACTION_STRATEGY;
    this.compactionStrategyRegistry = new CompactionStrategyRegistry();
    this._registerBuiltinCompactionStrategies();
    this.profileName = config.profileName || "default";
    this.usedTools = new Set();
    this.iterationCount = 0;
    this.cancelled = false;
    this.outputCache = new Map();
    this.promptsLoader = config.promptsLoader || null;
    this.skillsLoader = config.skillsLoader || null;
    // Session logging
    this.sessionLog = config.sessionLog || disabledSessionLog();
    // Token usage tracking per model
    this.tokenStats = new Map();
    // Task manager for async task delegation (meta profile)
    this.taskManager = config.taskManager || null;
    // Task completion wake-up messages
    this._pendingTaskMessages = [];
    // Tool definition cache
    this._toolDefs = null;
    // MCP connections (from main.js)
    this._mcpConnections = config.mcpConnections || [];
    // Cached MCP tool definitions
    this._mcpToolDefs = null;
    this._mcpToolDefsDirty = true;
    // Config reference for profile lookups
    this._config = config.config || null;
  }

  // ── Compaction Strategy Registration ──────────────────────────────────────

  /**
   * Register built-in compaction strategies.
   */
  _registerBuiltinCompactionStrategies() {
    this.compactionStrategyRegistry.register(new SummarizeStrategy());
    this.compactionStrategyRegistry.register(new DropStrategy());
    this.compactionStrategyRegistry.register(new SummarizeShortStrategy());
    this.compactionStrategyRegistry.register(new TokenAwareStrategy());
  }

  // ── Tool Allowance ────────────────────────────────────────────────────────

  /**
   * Get the set of tool names allowed by active skills.
   */
  allowedToolNames() {
    if (this.activeSkills.size === 0) return new Set();

    const allowed = new Set();
    for (const skillName of this.activeSkills) {
      const skill = this.skills.find((s) => s.name === skillName);
      if (skill) {
        for (const tool of skill.allowedTools || []) {
          allowed.add(tool.toLowerCase());
        }
      }
    }
    return allowed;
  }

  /**
   * Get combined tool patterns: include_tools + allowed_tools from active skills.
   * Patterns are ADDITIVE — they don't bypass core tools.
   */
  combinedToolPatterns() {
    if (this.activeSkills.size === 0) return new Set();

    const patterns = new Set();
    for (const skillName of this.activeSkills) {
      const skill = this.skills.find((s) => s.name === skillName);
      if (skill) {
        for (const tool of skill.includeTools || []) {
          patterns.add(tool.toLowerCase());
        }
        for (const tool of skill.allowedTools || []) {
          patterns.add(tool.toLowerCase());
        }
      }
    }
    return patterns;
  }

  /**
   * Check if a tool is allowed by active skills.
   * All tools (including core) are subject to skill filtering.
   * If no skills are active, everything is allowed.
   */
  isToolAllowed(toolName) {
    const patterns = this.combinedToolPatterns();
    if (patterns.size === 0) return true;
    return _toolMatchesPattern(toolName, patterns);
  }

  /**
   * Get tool definitions filtered by active skill patterns.
   * All tools (including core) are subject to skill filtering.
   * If no skills are active, all tools are returned.
   */
  filteredToolDefs(toolRegistry) {
    const patterns = this.combinedToolPatterns();
    if (patterns.size === 0) return toolRegistry.getToolDefs();

    const defs = toolRegistry.getToolDefs();
    const result = [];
    const seen = new Set();

    for (const t of defs) {
      const name = t.function?.name || "";
      if (_toolMatchesPattern(name, patterns) && !seen.has(name)) {
        seen.add(name);
        result.push(t);
      }
    }

    return result;
  }

  // ── Context Management ────────────────────────────────────────────────────

  /**
   * Add user input to the context.
   */
  addInput(content, logToSession = true) {
    this.ensureSystemPrompt();
    if (content && content.trim().length > 0) {
      this.context.addUserMessage(content);
      if (logToSession) {
        this.sessionLog.writeInput(content);
      }
    }
  }

  /**
   * Add an assistant response to the context.
   */
  addResponse(content, reasoningContent = null, toolCalls = null) {
    this.context.addAssistantMessage(content, reasoningContent, toolCalls);
    this.sessionLog.writeAssistant(content, toolCalls, reasoningContent);
  }

  /**
   * Build layered messages for the API request.
   */
  buildLayeredMessages() {
    return this.context.getMessages();
  }

  /**
   * Clear context and start a new session.
   */
  clearContext() {
    const newSessionId = crypto.randomUUID();
    this.sessionId = newSessionId;
    this.context.clear();
    this.iterationCount = 0;
    this.sessionLog.writeReset();
  }

  // ── System Prompt ─────────────────────────────────────────────────────────

  /**
   * Ensure system prompt is inserted before any user messages.
   */
  ensureSystemPrompt() {
    if (this.context.systemMessages.length > 0) return;

    const profile = getProfile(this._config || {}, this.profileName);
    const aspects = loadAspects(profile.aspects || []);
    const agentsMd = loadAgentsMd();

    // Build skills preamble content
    const skillsContent = this._buildSkillsPreamble();

    const systemPrompt = buildSystemPrompt({
      role: this.role,
      body: this.profileBody || "",
      model: this.model,
      profileName: this.profileName,
      aspects,
      agentsMd,
      skillsContent,
    });

    this.context.addSystemMessage(systemPrompt);
    this.sessionLog.writeSystemPrompt(systemPrompt);
  }

  /**
   * Regenerate the system prompt.
   */
  regenerateSystemPrompt() {
    const profile = getProfile(this._config || {}, this.profileName);
    const aspects = loadAspects(profile.aspects || []);
    const agentsMd = loadAgentsMd();
    const skillsContent = this._buildSkillsPreamble();

    const rendered = buildSystemPrompt({
      role: this.role,
      body: this.profileBody || "",
      model: this.model,
      profileName: this.profileName,
      aspects,
      agentsMd,
      skillsContent,
    });

    // Prune old <skill_content> blocks from conversation and replace system
    const oldMessages = this.context.messages();
    const newMessages = [];

    for (let i = 0; i < oldMessages.length; i++) {
      const msg = oldMessages[i];

      if (i === 0 && msg.role === "system") {
        // Replace system message with fresh content
        newMessages.push(
          new Message({
            role: "system",
            content: rendered,
            reasoningContent: null,
            toolCalls: null,
            toolCallId: null,
          }),
        );
      } else if (msg.role === "user" && _hasSkillContent(msg.content)) {
        // Prune: dynamically loaded skill messages are no longer necessary
        // (preloaded skills are now embedded in the system message)
        // → skip this message entirely
      } else {
        // Keep everything else: user input, assistant responses, tool calls, etc.
        newMessages.push(msg);
      }
    }

    this.context.replaceMessages(newMessages);
    return rendered;
  }

  /**
   * Build skills preamble content for the system prompt.
   */
  _buildSkillsPreamble() {
    if (this._allSkills.length === 0) return "";

    const skillDirs = this.skillDirectories.join("\n") || "/skills";
    const visibleSkills = this._allSkills.filter(
      (s) => s.visible && !s.disableModelInvocation,
    );
    if (visibleSkills.length === 0) return "";

    const loadedSkills = visibleSkills.filter((s) => s.loaded);
    const unloadedSkills = visibleSkills.filter((s) => !s.loaded);

    let preamble =
      "# Available Skills\n\nSkill directories: " + skillDirs + "\n\n";

    // Loaded skills with full content
    if (loadedSkills.length > 0) {
      preamble += "## Loaded Skills\n\n";
      for (const skill of loadedSkills) {
        preamble += `<skill_content name="${skill.name}">\n${skill.content}\n</skill_content>\n\n`;
      }
    }

    // Unloaded skills with descriptions
    if (unloadedSkills.length > 0) {
      preamble += "## Available Skills\n\n";
      for (const skill of unloadedSkills) {
        preamble += `<name>${skill.name}</name>\n${skill.description}\n\n`;
      }
    }

    return preamble;
  }

  // ── Tool Execution ────────────────────────────────────────────────────────

  /**
   * Handle tool calls from an LLM response.
   */
  async handleToolCalls(toolCalls, toolRegistry) {
    for (const tc of toolCalls) {
      const toolName = tc.function?.name || tc.toolName;
      const toolCallId = tc.id || tc.toolCallId;
      const input = tc.function?.arguments || tc.input || "{}";

      // Emit tool call event before execution
      this.sink.emit(
        outputEvent(OUTPUT_EVENT.TOOL_CALL, {
          toolName,
          input,
          toolCallId,
        }),
      );

      // Check tool allowance
      if (!this.isToolAllowed(toolName)) {
        const allowed = this.allowedToolNames();
        const errorMsg = `Tool '${toolName}' is not allowed by active skills. Allowed tools: ${Array.from(allowed).join(", ")}`;
        this._emitToolResult(toolName, input, errorMsg, toolCallId);
        this.context.addMessage({ role: "tool", content: errorMsg, reasoningContent: null, toolCalls: null, toolCallId });
        this.sessionLog.writeToolResult(errorMsg, toolCallId, toolName);
        continue;
      }

      // Track duration
      const start = Date.now();

      // Show first-use help on first execution
      const tool = toolRegistry.get(toolName);
      let firstUseHelp = null;
      if (tool && tool.firstUseHelp && !this.usedTools.has(toolName)) {
        this.usedTools.add(toolName);
        firstUseHelp = tool.firstUseHelp;
      }

      // Execute the tool
      const ctx = this.createToolContext();
      let result;
      try {
        result = await tool.execute(input, ctx);
      } catch (e) {
        result = `Error executing tool ${toolName}: ${e.message}`;
      }

      const durationMs = Date.now() - start;

      // Add duration to result
      if (typeof result === "string") {
        result = `${result}\n[duration: ${durationMs}ms]`;
      } else if (result && typeof result === "object") {
        result.duration_ms = durationMs;
      }

      // Convert to string for API
      result = toolResult(result);

      this._emitToolResult(toolName, input, result, toolCallId);

      // Prepend first-use help if present
      const displayResult = firstUseHelp
        ? `<system-notice>${firstUseHelp}</system-notice>\n${result}`
        : result;

      // Add tool result to context
      this.context.addMessage({ role: "tool", content: displayResult, reasoningContent: null, toolCalls: null, toolCallId });

      // Cache output
      this.outputCache.set(toolCallId, displayResult);

      // Log tool result
      this.sessionLog.writeToolResult(displayResult, toolCallId, toolName);

      // If this is the wait tool, signal the loop to exit — the model has
      // nothing more to do and is yielding control back to the user.
      if (toolName === "wait") {
        return "return";
      }
    }

    return "continue";
  }

  /**
   * Emit tool result event through the output sink.
   */
  _emitToolResult(toolName, input, result, toolCallId) {
    this.sink.emit(
      outputEvent(OUTPUT_EVENT.TOOL_RESULT, {
        toolName,
        input,
        result,
      }),
    );
  }
  // ── Compaction ────────────────────────────────────────────────────────────

  /**
   * Compact the message log using the configured compaction strategy.
   */
  async compactMessages(overrideKeep) {
    const messages = this.context.messages();
    const keepRecent = overrideKeep ?? this.compaction.keepRecentMessages;

    // Filter out system messages for compaction decision
    const allMessages = messages.filter((m) => m.role !== "system");
    if (allMessages.length <= keepRecent * 2) return null;

    this.sink.emit(
      outputEvent(OUTPUT_EVENT.COMPACTING, {
        messageCount: allMessages.length,
        keepRecent,
      }),
    );

    // Convert Message objects to plain objects for API serialization
    const plainMessages = allMessages.map((m) => m.toJSON());

    // Get the configured strategy
    const strategy = this.compactionStrategyRegistry.get(this.compactionStrategy);
    if (!strategy) {
      console.warn(`Compaction strategy '${this.compactionStrategy}' not found, falling back to 'summarize'`);
      this.compactionStrategy = 'summarize';
      const fallback = this.compactionStrategyRegistry.get('summarize');
      if (!fallback) return null;
      return this._executeCompaction(fallback, plainMessages, keepRecent, allMessages);
    }

    return this._executeCompaction(strategy, plainMessages, keepRecent, allMessages);
  }

  /**
   * Execute compaction using a specific strategy.
   * Shared logic for both direct calls and fallback.
   */
  async _executeCompaction(strategy, plainMessages, keepRecent, allMessages) {
    // Check if compaction is enabled (strategies don't check this)
    if (!this.compaction.enabled) return null;

    const result = await strategy.execute(
      plainMessages,
      // Pass settings with 'keepRecent' property that strategies expect
      { enabled: this.compaction.enabled, keepRecent, reserveTokens: this.compaction.reserveTokens },
      // LLM chat callback — convert plain objects to Message instances
      // because chatStreamCancellable calls msg.toJSON() on each message
      async (msgs, model) => {
        const modelConfig = this.modelRegistry[this.model] || {
          name: this.model,
          temperature: null,
          maxTokens: DEFAULT_MAX_TOKENS,
        };
        const messageObjects = msgs.map((m) => new Message(m));
        const stream = this.client.chatStreamCancellable(
          messageObjects,
          modelConfig,
          [],
          { aborted: this.cancelled },
        );
        let fullText = "";
        for await (const event of stream) {
          if (event.type === "content") {
            fullText += event.content;
          }
        }
        return fullText;
      },
      this.model,
    );

    if (!result) return null;

    // Rebuild context: system prompt + <m_buzefmhm52i8k2m2> + kept messages
    this.context.clear();

    // Add system prompt back
    this.ensureSystemPrompt();

    // Add compaction summary as user message (or empty marker for drop strategy)
    if (result.summary) {
      const summaryContent = `<m_buzefmhm52i8k2m2>${result.summary}</m_buzefmhm52i8k2m2>`;
      this.context.addUserMessage(summaryContent);
    } else {
      // Drop strategy: no summary, just a marker
      const summaryContent = `<m_buzefmhm52i8k2m2>Context compacted: ${result.messagesCompacted} messages removed</m_buzefmhm52i8k2m2>`;
      this.context.addUserMessage(summaryContent);
    }

    // Add kept messages (from result.messagesCompacted index onward)
    const keptMessages = allMessages.slice(result.messagesCompacted);
    for (const msg of keptMessages) {
      this.context.addMessage({
        role: msg.role,
        content: msg.content,
        reasoningContent: msg.reasoning_content || null,
        toolCalls: msg.tool_calls || null,
        toolCallId: msg.tool_call_id || null,
      });
    }

    // Log compaction
    this.sessionLog.writeCompaction(result.messagesCompacted, result.summary);

    // Emit compaction result event
    this.sink.emit(
      outputEvent(OUTPUT_EVENT.COMPACTION_RESULT, {
        summary: result.summary,
        messagesCompacted: result.messagesCompacted,
        strategy: this.compactionStrategy,
      }),
    );

    // Debug: write serialized context to compaction.out.json
    if (this.compactDebug) {
      this.writeCompactionDebugFile();
    }

    return result.summary;
  }

  /**
   * Write the serialized context after compaction to compaction.out.json.
   */
  writeCompactionDebugFile() {
    const messages = this.context.getMessages();
    const chatMessages = messages.map((m) => m.toJSON());
    const json = JSON.stringify(chatMessages, null, 2);
    try {
      fs.writeFileSync("compaction.out.json", json);
    } catch (e) {
      console.warn(e);
    }
  }

  // ── Prompt Execution ──────────────────────────────────────────────────────

  /**
   * Execute a saved prompt template.
   */
  executePrompt(name, args) {
    if (!this.promptsLoader) {
      return { success: false, error: "Prompts loader not configured" };
    }

    const promptsLoader = this.promptsLoader;
    const prompt = promptsLoader.getPrompt(name);
    if (!prompt) {
      const available = promptsLoader
        .allPrompts()
        .filter((p) => !p.disableModelInvocation)
        .map((p) => p.name);
      return {
        success: false,
        error: `Unknown prompt '${name}'. Available prompts: ${available.length === 0 ? "(none)" : available.join(", ")}`,
      };
    }

    // Render template with ARGS using the template engine
    let rendered = prompt.content;
    if (args) {
      try {
        rendered = render(prompt.content, { ARGS: args });
      } catch {
        // If template rendering fails, fall back to raw content
        rendered = prompt.content;
      }
    }

    // Append as user message (preserves context)
    this.context.addUserMessage(rendered);
    this.sessionLog.writePrompt(rendered);

    return { success: true, prompt: rendered };
  }

  // ── Skill Activation ──────────────────────────────────────────────────────

  /**
   * Activate a skill (mark as loaded, inject into context).
   */
  activateSkill(name) {
    if (!this.skillsLoader) {
      return { success: false, error: "Skills loader not configured" };
    }

    // Deduplication: skip if already active
    if (this.activeSkills.has(name)) return { success: true };

    this.skillsLoader.activateSkill(name);
    this.activeSkills.add(name);

    // Wrap in structured tags
    const skill = this.skills.find((s) => s.name === name);
    if (!skill) return { success: true };

    const additionalFiles = skill.additionalFiles || [];
    const resourcesSection =
      additionalFiles.length > 0
        ? `<skill_resources>\n${additionalFiles.map((f) => `  <file>${f}</file>`).join("\n")}\n</skill_resources>`
        : "(none)";

    const wrappedContent = `<skill_content name="${skill.name}">\n${skill.content}\n\nSkill directory: ${skill.location}\nRelative paths in this skill are relative to the skill directory.\n\n<skill_resources>\n${resourcesSection}\n</skill_resources>\n</skill_content>`;

    this.context.addUserMessage(wrappedContent);
    this.sessionLog.writeInput(wrappedContent);

    // Rebuild system prompt to include the loaded skill
    this.context.systemMessages = [];

    return { success: true };
  }

  /**
   * Get the current model name.
   */
  currentModel() {
    return this.model;
  }

  /**
   * Set the output sink for this agent.
   */
  setSink(sink) {
    this.sink = sink;
  }

  /**
   * Cancel or reset the current run. Defaults to cancelling.
   */
  cancel(flag = true) {
    this.cancelled = flag;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Build the agent's tool registry.
   */
  async buildToolRegistry(
    whitelist = null,
    blacklist = null,
    managerToolsEnabled = false,
  ) {
    const registry = new ToolRegistry();
    const ctx = this.createToolContext();
    const factory = createToolFactory(this.taskManager);

    // Core tools
    const coreToolNames = CORE_TOOL_NAMES.filter((name) => {
      if (whitelist && !whitelist.includes(name)) return false;
      if (blacklist && blacklist.includes(name)) return false;
      return true;
    });

    for (const name of coreToolNames) {
      const tool = await factory.createTool(
        name,
        ctx,
        whitelist,
        managerToolsEnabled,
      );
      if (tool) {
        registry.register(name, tool);
      }
    }

    // Subagent tools (manager-only)
    if (managerToolsEnabled && this.taskManager) {
      const subagentNames = SUBAGENT_TOOL_NAMES.filter((name) => {
        if (whitelist && !whitelist.includes(name)) return false;
        if (blacklist && blacklist.includes(name)) return false;
        return true;
      });

      for (const name of subagentNames) {
        const tool = await factory.createTool(
          name,
          ctx,
          whitelist,
          managerToolsEnabled,
        );
        if (tool) {
          registry.register(name, tool);
        }
      }
    }

    // MCP tools
    await this._registerMcpTools(registry, whitelist, blacklist);

    // LSP tools (when LSP is enabled)
    await registerLspTools(registry, ctx);

    return registry;
  }

  /**
   * Register tools from MCP connections.
   */
  async _registerMcpTools(registry, profileWhitelist, profileBlacklist) {
    for (const { connection, serverConfig } of this._mcpConnections) {
      // Check if server is enabled
      if (serverConfig.enabled === false) continue;

      // Build server-level tool filter
      const serverBlacklist = new Set(serverConfig.blacklistTools || []);
      const serverWhitelist = serverConfig.whitelistTools
        ? new Set(serverConfig.whitelistTools)
        : null;

      // Build profile-level tool filter
      const profileBlacklistSet = new Set(profileBlacklist || []);
      const profileWhitelistSet = profileWhitelist
        ? new Set(profileWhitelist)
        : null;

      const prefix = `${connection.serverName}/`;

      for (const toolDef of connection.tools) {
        const fullName = `${prefix}${toolDef.name}`;

        // Apply server-level filter
        if (serverWhitelist && !serverWhitelist.has(toolDef.name)) continue;
        if (serverBlacklist.has(toolDef.name)) continue;

        // Apply profile-level filter
        if (profileWhitelistSet && !profileWhitelistSet.has(fullName)) continue;
        if (profileBlacklistSet.has(fullName)) continue;

        // Create and register the MCP tool
        const handle = connection.handle();
        const mcpTool = new McpTool(connection.serverName, toolDef, handle);
        registry.register(fullName, mcpTool);
      }
    }
  }

  /**
   * Create a ToolContext for tools.
   */
  createToolContext() {
    const workspaceRoot = this.cwdBoundary || process.cwd();
    const lspConfig = this._config?.lsp || null;
    return new ToolContext({
      skills: this.skills,
      allSkills: this._allSkills,
      skillDirectories: this.skillDirectories,
      modelRegistry: this.modelRegistry,
      cwdBoundary: this.cwdBoundary,
      workspaceRoot,
      lspConfig,
      onActivateSkill: (name) => {
        this.activeSkills.add(name);
      },
      onSwitchModel: (modelName) => {
        this.model = modelName;
      },
      onClearContext: () => {
        this.clearContext();
      },
      onCacheToolOutput: (toolCallId, output) => {
        this.outputCache.set(toolCallId, output);
      },
      onGetCachedToolOutput: (toolCallId) => {
        return this.outputCache.get(toolCallId);
      },
      isCancelled: () => this.cancelled,
    });
  }

  /**
   * Get tool definitions for the API request.
   */
  getToolDefs(toolRegistry) {
    return this.filteredToolDefs(toolRegistry);
  }

  /**
   * Process a streaming LLM response.
   */
  async processStream(stream, generationDurationMs) {
    let fullText = "";
    let fullReasoning = null;
    const toolCallsBuffer = new Map();
    let usage = null;
    let finalToolCalls = null;

    for await (const event of stream) {
      if (this.cancelled) {
        throw LlmError.Cancelled("Agent cancelled");
      }

      switch (event.type) {
        case "content":
          fullText += event.content;
          if (this.stream) {
            this.sink.emit(
              outputEvent(OUTPUT_EVENT.STREAMING_CHUNK, {
                content: event.content,
              }),
            );
          }
          break;
        case "reasoning":
          if (!fullReasoning) fullReasoning = "";
          fullReasoning += event.content;
          if (this.stream) {
            this.sink.emit(
              outputEvent(OUTPUT_EVENT.STREAMING_REASONING_CHUNK, {
                content: event.content,
              }),
            );
          }
          break;
        case "toolName":
          toolCallsBuffer.set(event.index, {
            name: event.name,
            args: "",
            id: event.toolCallId || "",
          });
          break;
        case "toolArgument":
          const existing = toolCallsBuffer.get(event.index) || {
            name: "",
            args: "",
            id: "",
          };
          existing.args += event.arguments;
          toolCallsBuffer.set(event.index, existing);
          break;
        case "usage":
          usage = event.data;
          break;
      }
    }

    // Build final tool calls from buffer
    if (toolCallsBuffer.size > 0) {
      finalToolCalls = Array.from(toolCallsBuffer.values()).map(
        (tc, index) => ({
          id: tc.id || `call_${index}_${Date.now()}`,
          type: "function",
          function: {
            name: tc.name,
            arguments: tc.args,
          },
        }),
      );
    }

    return {
      fullText,
      fullReasoning,
      finalToolCalls,
      usage,
      generationDurationMs,
    };
  }

  /**
   * Process an accumulated response.
   */
  async processResponse(response) {
    const {
      fullText,
      fullReasoning,
      finalToolCalls,
      usage,
      generationDurationMs,
    } = response;

    if (finalToolCalls) {
      this.addResponse(fullText, fullReasoning, finalToolCalls);
      const outcome = await this.handleToolCalls(
        finalToolCalls,
        this._currentTools,
      );
      return outcome === "continue" ? "continue" : "return";
    } else {
      this.addResponse(fullText, fullReasoning, null);
      return fullText;
    }
  }

  /**
   * Drain pending task completion messages into the agent's context.
   * Returns true if any messages were drained.
   */
  drainPendingTaskMessages() {
    if (this._pendingTaskMessages.length === 0) return false;

    const messages = this._pendingTaskMessages.splice(0);
    for (const msg of messages) {
      this.context.addSystemMessage(msg);
      this.sessionLog.writeSystemPrompt(msg);
      this.sink.emit(
        outputEvent(OUTPUT_EVENT.TASK_PROGRESS, {
          status: "task_result_received",
        }),
      );
    }
    return true;
  }

  /**
   * Wait for all delegated tasks to complete and drain their results.
   * Returns true if any task results were processed.
   */
  async waitForTasksAndDrain() {
    if (!this.taskManager) return this.drainPendingTaskMessages();

    let drained = false;

    // Drain any pending task messages first
    if (this.drainPendingTaskMessages()) {
      drained = true;
    }

    const activeTasks = this.taskManager.activeTasks();
    if (activeTasks.length === 0) return drained;

    // Wait for all active tasks to complete
    let iterations = 0;
    const maxWaitIterations = 120; // ~60s max wait

    while (activeTasks.length > 0 && iterations < maxWaitIterations) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const remaining = this.taskManager.activeTasks();

      // Drain any completed task messages
      if (this.drainPendingTaskMessages()) {
        drained = true;
      }

      if (remaining.length === 0) break;
      iterations++;
    }

    // Final drain
    if (this.drainPendingTaskMessages()) {
      drained = true;
    }

    return drained;
  }

  /**
   * The agent's run loop.
   */
  async run(userInput) {
    this.ensureSystemPrompt();
    this.addInput(userInput);
    this.iterationCount = 0;

    while (this.iterationCount < DEFAULT_MAX_ITERATIONS) {
      if (this.cancelled) {
        throw LlmError.Cancelled("Agent cancelled");
      }

      this.iterationCount++;

      // Drain any pending task completion messages into context
      this.drainPendingTaskMessages();

      // Build messages
      const messages = this.buildLayeredMessages();

      // Build tool registry for this iteration
      const profile = getProfile(this._config || {}, this.profileName);
      this._currentTools = await this.buildToolRegistry(
        profile.whitelistTools,
        profile.blacklistTools,
        profile.manager,
      );

      const modelConfig = this.modelRegistry[this.model] || {
        name: this.model,
        temperature: null,
        maxTokens: DEFAULT_MAX_TOKENS,
      };

      const toolDefs = this.getToolDefs(this._currentTools);

      // Call the LLM
      let stream;
      try {
        stream = this.client.chatStreamCancellable(
          messages,
          modelConfig,
          toolDefs,
          { aborted: this.cancelled },
        );
      } catch (e) {
        throw e;
      }

      const start = Date.now();
      const response = await this.processStream(stream, Date.now() - start);
      const duration = Date.now() - start;

      // Process the response
      const outcome = await this.processResponse(response);

      // Emit token usage
      if (this.showTokenUse && response.usage) {
        this.sink.emit(
          outputEvent(OUTPUT_EVENT.TOKEN_USAGE, {
            promptTokens: response.usage.prompt_tokens || 0,
            cachedTokens:
              response.usage.prompt_tokens_details?.cached_tokens || 0,
            completionTokens: response.usage.completion_tokens || 0,
            totalTokens: response.usage.total_tokens || 0,
          }),
        );
        // Track stats per model
        this.trackTokenStats(response.usage, this.model);
      }

      // Check if we should return
      if (outcome !== "continue") {
        return outcome;
      }

      // Compact if needed
      if (
        this.compaction.enabled &&
        this.context.size() > modelConfig.maxTokens / 100
      ) {
        await this.compactMessages();
      }
    }

    throw new Error(`Max iterations (${DEFAULT_MAX_ITERATIONS}) reached`);
  }

  /**
   * Get all available prompts.
   */
  availablePrompts() {
    if (!this.promptsLoader) return [];
    return this.promptsLoader.allPrompts();
  }

  /**
   * Get all available skills (including hidden).
   */
  allSkills() {
    if (!this.skillsLoader) return [];
    return this.skillsLoader.allSkills();
  }

  /**
   * Auto-activate skills based on available tools.
   */
  autoActivateSkills(toolNames) {
    if (!this.skillsLoader) return;
    this.skillsLoader.autoActivate(toolNames);
  }

  /**
   * Track token usage stats per model.
   */
  trackTokenStats(usage, modelName) {
    if (!this.tokenStats.has(modelName)) {
      this.tokenStats.set(modelName, {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        latestPromptTokens: 0,
        latestCachedTokens: 0,
        latestCompletionTokens: 0,
        latestTotalTokens: 0,
      });
    }
    const stats = this.tokenStats.get(modelName);
    stats.totalRequests++;
    stats.successfulRequests++;
    stats.latestPromptTokens = usage.prompt_tokens || 0;
    stats.latestCachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
    stats.latestCompletionTokens = usage.completion_tokens || 0;
    stats.latestTotalTokens = usage.total_tokens || 0;
  }

  /**
   * Get token usage stats as a formatted string.
   */
  tokenStatsDisplay() {
    if (this.tokenStats.size === 0) {
      return `Token Usage (model: ${this.model})`;
    }
    const lines = [`Token Usage (model: ${this.model})`];
    for (const [model, stats] of this.tokenStats) {
      const uncached = stats.latestPromptTokens - stats.latestCachedTokens;
      lines.push(
        `  ${model}: ${stats.successfulRequests} ok, ` +
          `${uncached} prompt + ${stats.latestCachedTokens} cached + ` +
          `${stats.latestCompletionTokens} completion = ` +
          `${stats.latestTotalTokens} total tokens`,
      );
    }
    return lines.join("\n");
  }

  /**
   * Get all token stats.
   */
  getTokenStats() {
    return new Map(this.tokenStats);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Check if a string contains <skill_content name="..."> tags.
 */
function _hasSkillContent(content) {
  return (
    typeof content === "string" && content.includes("<skill_content name=")
  );
}

/**
 * Glob pattern matching for tool name filtering.
 * Same algorithm as patternMatches in skills/loader.js.
 */
function _globMatch(pattern, text) {
  if (pattern === text) return true;
  if (!pattern.includes("*")) return false;

  const pat = pattern.split("");
  const name = text.split("");
  const patLen = pat.length;
  const nameLen = name.length;

  const dp = Array.from({ length: patLen + 1 }, () =>
    Array(nameLen + 1).fill(false),
  );
  dp[0][0] = true;

  for (let i = 1; i <= patLen; i++) {
    if (pat[i - 1] === "*") dp[i][0] = dp[i - 1][0];
    else break;
  }

  for (let i = 1; i <= patLen; i++) {
    for (let j = 1; j <= nameLen; j++) {
      if (pat[i - 1] === "*") {
        dp[i][j] = dp[i - 1][j] || dp[i][j - 1];
      } else if (pat[i - 1] === name[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      }
    }
  }

  return dp[patLen][nameLen];
}
