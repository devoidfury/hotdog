// Session builder — encapsulates the full agent initialization pipeline.
//
// Accepts a pre-built resolved config and constructs LlmClient,
// ModelRegistry, ToolRegistry, and Agent. Enables agent swaps
// (profile switching) without reconstructing the builder.

import { LlmClient } from "../llm_client/client.js";
import { CliOutputSink } from "../ui/cli.js";
import { PromptsLoader } from "../prompts/loader.js";
import { SkillsLoader } from "../skills/loader.js";
import { McpConnection } from "../mcp/index.js";
import { TaskManager } from "./worker.js";
import { Agent } from "./agent.js";
import { SessionLog, disabledSessionLog, readSessionEntries, replayEntriesIntoContext } from "../session_log.js";
import { DEFAULT_SKILLS_PATH, DEFAULT_PROMPTS_PATH, loadProfileFile, defaultCompactionSettings } from "../config.js";
import { MarkerMangler } from "../marker_mangler.js";

/**
 * Encapsulates the full agent initialization pipeline.
 *
 * Accepts a pre-built resolved config object (from buildConfig()) and
 * constructs shared resources (model registry, skills, prompts, MCP connections).
 */
export class SessionBuilder {
  /**
   * Create a new SessionBuilder from a pre-built resolved config.
   * @param {object} resolved - Resolved config object (from buildConfig().resolved)
   * @param {object} config - Raw config object (from config.js loadConfig)
   * @param {object} [modelRegistry] - Model lookup map (optional, built if omitted)
   */
  constructor(resolved, config, modelRegistry) {
    this._resolved = resolved;
    this._config = config;
    this._modelRegistry = modelRegistry || {};
    this._markerMangler = new MarkerMangler();
    this._skillsLoader = this._buildSkillsLoader();
    this._promptsLoader = this._buildPromptsLoader();
    this._palette = this._buildPalette();
    this._mcpConnections = this._buildMcpConnections();
    this._taskManager = this._buildTaskManager();
  }

  /**
   * Build an Agent instance with the given output sink.
   * @param {import("../context/output.js").OutputSink} sink - Output sink
   * @returns {Promise<Agent>} The constructed agent
   */
  async buildAgent(sink) {
    const sessionLog = this._resolved.noLog
      ? disabledSessionLog()
      : new SessionLog(crypto.randomUUID());

    const client = new LlmClient({
      baseUrl: this._resolved.baseUrl,
      apiKey: this._resolved.apiKey,
      stream: this._resolved.stream,
      chatTimeoutSecs: this._resolved.chatTimeout,
      providers: this._config.providers || [],
      markerMangler: this._markerMangler,
    });

    const mcpConnections = await this._mcpConnections;

    const agent = new Agent({
      client,
      model: this._resolved.model,
      modelRegistry: this._modelRegistry,
      sink,
      hideTools: this._resolved.hideTools,
      hideThinking: this._resolved.hideThinking,
      compactDebug: this._resolved.compactDebug,
      showTokenUse: this._resolved.showTokenUse,
      role: this._resolved.role,
      profileBody: this._resolved.profileBody,
      stream: this._resolved.stream,
      profileName: this._resolved.profileName,
      compaction: this._config.compaction || defaultCompactionSettings,
      config: this._config,
      skillsLoader: this._skillsLoader,
      promptsLoader: this._promptsLoader,
      skills: this._skillsLoader.allSkills().filter((s) => s.loaded),
      allSkills: this._skillsLoader
        .allSkills()
        .filter((s) => !s.disableModelInvocation),
      skillDirectories: this._skillsLoader.directories(),
      sessionLog,
      sessionId: this._resolved.sessionId || crypto.randomUUID(),
      taskManager: this._taskManager,
      mcpConnections,
    });

    // Replay existing session if a session ID was provided and logging is enabled
    if (this._resolved.sessionId && !this._resolved.noLog) {
      const entries = readSessionEntries(this._resolved.sessionId);
      if (entries.length > 0) {
        const replayed = replayEntriesIntoContext(agent, entries);
        if (replayed > 0) {
          // Set the system prompt after replaying so it appears before replayed messages
          agent.ensureSystemPrompt();
        }
      }
    }

    return agent;
  }

  /**
   * Get the resolved configuration.
   */
  resolved() {
    return this._resolved;
  }

  /**
   * Get the model registry.
   */
  modelRegistry() {
    return this._modelRegistry;
  }

  /**
   * Get the current model name.
   */
  modelName() {
    return this._resolved.model;
  }

  /**
   * Get the skills loader.
   */
  skillsLoader() {
    return this._skillsLoader;
  }

  /**
   * Get the prompts loader.
   */
  promptsLoader() {
    return this._promptsLoader;
  }

  /**
   * Get the palette for output formatting.
   */
  palette() {
    return this._palette;
  }

  /**
   * Get the MCP connections.
   */
  mcpConnections() {
    return this._mcpConnections;
  }

  /**
   * Get the task manager (if meta profile is active).
   */
  taskManager() {
    return this._taskManager;
  }

  /**
   * Get the config object.
   */
  config() {
    return this._config;
  }

  /**
   * Get the marker mangler for injection prevention.
   */
  markerMangler() {
    return this._markerMangler;
  }

  /**
   * Get the CLI args.
   */
  cli() {
    return this._cli;
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  _buildSkillsLoader() {
    const loader = new SkillsLoader(
      this._resolved.skillsPath || this._config.skillsPath || DEFAULT_SKILLS_PATH,
    );
    loader.loadSkills();
    loader.autoActivate([
      "bash", "read", "write", "edit", "grep", "find",
      "fetch", "question", "pager", "model", "load_skill",
    ]);

    // Preload skills
    const preloadSkills = this._resolved.preloadSkills || [];
    if (preloadSkills.length > 0) {
      for (const name of preloadSkills) {
        const skill = loader.allSkills().find((s) => s.name === name);
        if (skill) skill.loaded = true;
      }
    }

    return loader;
  }

  _buildPromptsLoader() {
    const loader = new PromptsLoader(
      this._resolved.promptsPath || this._config.promptsPath || DEFAULT_PROMPTS_PATH,
    );
    loader.loadPrompts();
    return loader;
  }

  _buildPalette() {
    return CliOutputSink.resolve(
      this._resolved.useColors ?? true,
      this._resolved.theme,
      this._config.colors || null,
    );
  }

  async _buildMcpConnections() {
    const connections = [];
    for (const serverConfig of this._config.mcpServers || []) {
      if (serverConfig.enabled === false) continue;
      try {
        let connection;
        if (serverConfig.url) {
          connection = await McpConnection.connectHttp(
            serverConfig.name, serverConfig.url, serverConfig.headers || {},
          );
        } else if (serverConfig.command) {
          connection = await McpConnection.connectStdio(
            serverConfig.name, serverConfig.command, serverConfig.args || [], serverConfig.env || {},
          );
        } else {
          console.warn(`Warning: MCP server '${serverConfig.name}' has no transport configured`);
          continue;
        }
        connections.push({ connection, serverConfig });
      } catch (e) {
        console.warn(`Warning: failed to connect to MCP server '${serverConfig.name}': ${e.message}`);
      }
    }
    return connections;
  }

  _buildTaskManager() {
    if (!this._resolved.profile.manager) return null;

    const workerTools = ["bash", "read", "write", "edit", "grep", "find"];
    const taskProfile = loadProfileFile(this._config, "task-default");
    const taskSystemPrompt = taskProfile
      ? `${taskProfile.role || "A focused worker that executes tasks autonomously"}\n\n${taskProfile.body}`
      : "You are a focused worker agent that executes delegated tasks autonomously.";

    return new TaskManager({
      llmClient: new LlmClient({
        baseUrl: this._resolved.baseUrl,
        apiKey: this._resolved.apiKey,
        stream: this._resolved.stream,
        chatTimeoutSecs: this._resolved.chatTimeout,
        providers: this._config.providers || [],
        markerMangler: this._markerMangler,
      }),
      modelName: this._resolved.model,
      modelRegistry: this._modelRegistry,
      managerContext: null,
      systemPrompt: taskSystemPrompt,
      allowedTools: workerTools,
      config: this._config,
    });
  }
}
