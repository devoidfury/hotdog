#!/usr/bin/env bun
// oa-agent — AI agent harness with tool calling support.
// CLI entry point — wired to the extension architecture.

import {
  createHooks,
  createToolRegistry,
  createExtensionLoader,
  SessionManager,
  Agent,
} from "./core/index.js";
import { HOOKS } from "./hooks.js";
import { CliOutputSink } from "./ui/cli.js";
import { parseArgs, HELP_TEXT } from "./cli.js";
import { loadConfig } from "./config.js";
import { buildConfig } from "./config.js";
import { formatError, isExpectedError } from "./context/error.js";
import { OUTPUT_EVENT } from "./context/output.js";
import { createSubcommandRegistry } from "./core/subcommand-registry.js";
import { TaskManager } from "./session/task_manager.js";
import { Message } from "./context/message.js";
import {
  sessionExists,
  readSessionEntries,
  replayEntriesIntoContext,
} from "../extensions/session-log/session_log.js";

// ── Extension Loading ────────────────────────────────────────────────────────

/**
 * Load all extensions into the core.
 * Returns the loaded extensions for reference.
 *
 * Note: Extension paths are resolved relative to src/core/extensions.js
 * (the file that does the import()), not relative to src/main.js.
 */
async function loadExtensions(core, { taskManager } = {}) {
  const loaded = [];

  // 0. Refresh extension — hot-reload capabilities (loaded first to track others)
  const refreshExt = await core.extensions.load(
    "refresh",
    "../../extensions/refresh/index.js",
  );
  if (refreshExt) loaded.push(refreshExt);

  // 1. Compaction extension — handles context compaction
  const compactionExt = await core.extensions.load(
    "compaction",
    "../../extensions/compaction/index.js",
  );
  if (compactionExt) loaded.push(compactionExt);

  // 2. Core tools extension — registers bash, write, read, edit, etc.
  const coreToolsExt = await core.extensions.load(
    "core-tools",
    "../../extensions/core-tools/index.js",
    { taskManager },
  );
  if (coreToolsExt) loaded.push(coreToolsExt);

  // 3. Skills extension — manages skills loading and activation
  const skillsExt = await core.extensions.load(
    "skills",
    "../../extensions/skills/index.js",
  );
  if (skillsExt) loaded.push(skillsExt);

  // 4. Prompts extension — manages prompt templates
  const promptsExt = await core.extensions.load(
    "prompts",
    "../../extensions/prompts/index.js",
  );
  if (promptsExt) loaded.push(promptsExt);

  // 5. Session log extension — JSONL audit trail
  const sessionLogExt = await core.extensions.load(
    "session-log",
    "../../extensions/session-log/index.js",
  );
  if (sessionLogExt) loaded.push(sessionLogExt);

  // 6. LSP extension — registers LSP tools (hover, definition, completion, etc.)
  const lspExt = await core.extensions.load(
    "lsp",
    "../../extensions/lsp/index.js",
  );
  if (lspExt) loaded.push(lspExt);

  // 7. MCP extension — connects to MCP servers and registers their tools
  const mcpExt = await core.extensions.load(
    "mcp",
    "../../extensions/mcp/index.js",
  );
  if (mcpExt) loaded.push(mcpExt);

  // 8. Info-Show-Prompt extension — provides info, show-prompt subcommands
  const { create: createInfoShowPrompt } =
    await import("../extensions/info-show-prompt/index.js");
  const infoExt = createInfoShowPrompt(core);
  if (infoExt) {
    await core.extensions.load("info-show-prompt", infoExt);
    loaded.push(infoExt);
  }

  // 9. Session-Review extension — provides review subcommand
  const { create: createSessionReview } =
    await import("../extensions/session-review/index.js");
  const reviewExt = createSessionReview(core);
  if (reviewExt) {
    await core.extensions.load("session-review", reviewExt);
    loaded.push(reviewExt);
  }

  return loaded;
}

/**
 * Load CLI subcommand extensions — extensions that provide CLI subcommands.
 * These are loaded early (before core config) and register subcommands via hooks.
 *
 * @param {Object} earlyCore - Minimal core with hooks for subcommand registration.
 * @returns {Promise<Array>} Loaded extension instances.
 */
async function loadCliExtensions(earlyCore) {
  const loaded = [];

  // Info-Show-Prompt extension — provides info, show-prompt subcommands
  const { create: createInfoShowPrompt } =
    await import("../extensions/info-show-prompt/index.js");
  const infoExt = createInfoShowPrompt(earlyCore);
  if (infoExt) {
    loaded.push(infoExt);
  }

  // Session-Review extension — provides review subcommand
  const { create: createSessionReview } =
    await import("../extensions/session-review/index.js");
  const reviewExt = createSessionReview(earlyCore);
  if (reviewExt) {
    loaded.push(reviewExt);
  }

  return loaded;
}

// ── Core Infrastructure ─────────────────────────────────────────────────────

/**
 * Create the core infrastructure: hooks, tool registry, extension loader.
 */
function createCore(config) {
  const hooks = createHooks();
  const toolRegistry = createToolRegistry();
  const extensions = createExtensionLoader({ hooks, toolRegistry, config });

  return { hooks, toolRegistry, extensions, config };
}

// ── Message Bus ──────────────────────────────────────────────────────────────

/**
 * A simple message bus that owns the agent run loop.
 * Uses SessionManager for agent access.
 */
class MessageBus {
  /**
   * @param {Object} options
   * @param {SessionManager} options.sessionManager
   * @param {Object} options.sink
   */
  constructor({ sessionManager, sink }) {
    this._sessionManager = sessionManager;
    this._sink = sink;
    this._queue = [];
    this._isRunning = false;
    this._cancelled = false;
  }

  enqueue(text) {
    this._queue.push(text);
  }

  cancel() {
    this._cancelled = true;
    const agent = this._sessionManager.getAgent();
    if (agent) agent.cancel();
  }

  isIdle() {
    return !this._isRunning && this._queue.length === 0;
  }

  get sessionManager() {
    return this._sessionManager;
  }

  get agent() {
    return this._sessionManager.getAgent();
  }

  /**
   * Run the dispatch loop. Drains messages sequentially.
   */
  async run() {
    await this._dispatchLoop(false);
  }

  /**
   * Run the dispatch loop, draining remaining messages after cancellation.
   */
  async runUntilCancelled() {
    await this._dispatchLoop(true);
  }

  async _dispatchLoop(drain) {
    if (drain && this._cancelled && this._queue.length === 0) return;

    while (true) {
      const text = this._queue.shift();
      if (text === undefined) {
        if (this._cancelled) {
          if (!drain) break;
          await this._sleep(50);
          continue;
        }
        await this._sleep(50);
        continue;
      }

      if (this._cancelled) {
        if (!drain) break;
      }

      this._isRunning = true;
      const agent = this._sessionManager.getAgent();
      if (agent) agent.cancel(false);

      try {
        await agent.run(text);
      } catch (e) {
        if (isExpectedError(e)) {
          this._sink.emit({
            type: OUTPUT_EVENT.COMMAND_RESULT,
            content: e.message,
          });
        } else {
          this._sink.emit({
            type: OUTPUT_EVENT.COMMAND_RESULT,
            content: formatError(e),
          });
        }
      }

      if (agent) agent.cancel(false);
      this._cancelled = false;
      this._isRunning = false;

      if (drain && this._queue.length === 0) break;
    }
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Execute a slash command through the agent.
   */
  async executeCommand(cmdText) {
    const { parseCommand } = await import("./core/commands.js");
    const agent = this._sessionManager.getAgent();
    const cmd = parseCommand(cmdText, agent?.getSlashCommandRegistry());

    if (!agent) {
      this._sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: "No agent available.",
      });
      return;
    }

    const result = await agent.executeCommand(cmd);

    if (result && result.error) {
      this._sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.error,
      });
    } else if (result && result.content) {
      this._sink.emit({
        type: OUTPUT_EVENT.COMMAND_RESULT,
        content: result.content,
      });
    }
  }
}

export { MessageBus };

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const cli = parseArgs();

  // ── Early core for CLI extension loading ────────────────────────────────
  // Create minimal core with hooks for CLI subcommand registration
  const earlyHooks = createHooks();
  const cliSubcommandRegistry = createSubcommandRegistry();
  const earlyCore = {
    hooks: earlyHooks,
    config: null,
    buildConfig,
    cliSubcommandRegistry,
  };

  // ── Load CLI extensions (info, show-prompt, review, etc.) ───────────────
  const cliExtensions = await loadCliExtensions(earlyCore);

  // ── Subcommand dispatch ─────────────────────────────────────────────────
  if (cli.subcommand) {
    const subcommandDef = cliSubcommandRegistry.get(cli.subcommand);
    if (subcommandDef) {
      // Load config if needed
      if (subcommandDef.requiresConfig) {
        const config = await loadConfig(cli.config);
        earlyCore.config = config;
      }
      // Execute the subcommand handler
      await subcommandDef.handler(cli, earlyCore);
      return;
    }
    console.error(`Unknown subcommand: ${cli.subcommand}`);
    console.log(
      `Available subcommands: ${cliSubcommandRegistry.names().join(", ")}`,
    );
    process.exit(1);
  }

  if (cli.version) {
    console.log("oa-agent 0.1.0");
    process.exit(0);
  }
  if (cli.help) {
    const subcommandHelp = cliSubcommandRegistry.generateHelpText();
    console.log(HELP_TEXT.replace("<subcommands>", subcommandHelp));
    process.exit(0);
  }

  // ── Build complete config ───────────────────────────────────────────────
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const config = await loadConfig(cli.config);

  // ── Create core infrastructure ──────────────────────────────────────────
  const core = createCore(config);

  // ── Output sink ─────────────────────────────────────────────────────────
  const palette = CliOutputSink.resolve(
    cli.colors !== false,
    cli.theme || config.theme || "dark",
    config.colors || null,
  );

  const sink = new CliOutputSink({
    ...resolved,
    palette,
    thinkerFormat: cli.thinker ?? config.thinker ?? "[Thinking: {}]",
    toolFormat: cli.toolfmt ?? config.toolfmt ?? "  → {} {}",
    toolOutputFmt:
      cli.toolOutputFmt ?? config.toolOutputFmt ?? "----\n{}\n----",
  });

  // ── Build LLM client ────────────────────────────────────────────────────
  const { LlmClient } = await import("./llm_client/client.js");
  const { MarkerMangler } = await import("./marker_mangler.js");

  const llmClient = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: resolved.stream,
    chatTimeoutSecs: resolved.chatTimeout,
    providers: config.providers || [],
    markerMangler: new MarkerMangler(),
  });

  // ── Create TaskManager ──────────────────────────────────────────────────
  // buildAgent function defined here so TaskManager can use it
  const buildAgent = async (agentConfig) => {
    const sessionId = agentConfig.sessionId || crypto.randomUUID();
    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient,
      model: agentConfig.model || resolved.model,
      maxIterations: agentConfig.maxIterations || config.maxIterations || 1000,
      maxTokens: config.maxTokens || 32000,
      hideTools: agentConfig.hideTools ?? resolved.hideTools,
      hideThinking: agentConfig.hideThinking ?? resolved.hideThinking,
      showTokenUse: agentConfig.showTokenUse ?? resolved.showTokenUse,
      sink: agentConfig.sink || sink,
      modelRegistry: modelRegistry,
      profileName: agentConfig.profileName || resolved.profileName,
      role: agentConfig.role || resolved.role,
      profileBody: agentConfig.profileBody || resolved.profileBody,
      stream: agentConfig.stream ?? resolved.stream,
      config,
      sessionId,
      abortSignal: agentConfig.abortSignal || null,
      toolWhitelist: agentConfig.toolWhitelist || null,
    });

    await agent.ensureSystemPrompt();

    // Emit hook for extensions to register slash commands
    core.hooks.emit(HOOKS.SLASH_COMMANDS_REGISTER, {
      registry: agent.getSlashCommandRegistry(),
      agent,
    });

    // Restore session from disk if a session ID was explicitly provided
    // and a session log file exists for it
    const explicitSessionId = cli.sessionId;
    if (explicitSessionId && sessionId === explicitSessionId) {
      if (sessionExists(explicitSessionId)) {
        const entries = readSessionEntries(explicitSessionId);
        if (entries.length > 0) {
          // Set restoring flag to prevent duplicate log writes during replay
          agent.isRestoring = true;
          const replayed = replayEntriesIntoContext(agent, entries);
          agent.isRestoring = false;
          if (replayed > 0) {
            console.log(
              `Session restored: ${replayed} messages replayed from ${explicitSessionId}`,
            );
          }
        }
      }
    }

    return agent;
  };

  const taskManager = new TaskManager({
    buildAgent,
    llmClient,
    modelRegistry,
    config,
    hooks: core.hooks,
    maxIterations: config.maxIterations || 1000,
  });

  // ── Load extensions ─────────────────────────────────────────────────────
  // Tool registration happens inside ExtensionLoader.load() via the
  // tools:register hook emission (see extensions.js). No separate emission needed.
  await loadExtensions(core, { taskManager });

  // ── Create SessionManager with buildAgent function ──────────────────────
  const sessionManager = await SessionManager.create({
    hooks: core.hooks,
    extensions: core.extensions,
    buildAgent,
    initialConfig: { sessionId: cli.sessionId || null },
  });

  // Wire taskManager to sessionManager
  taskManager.setSessionManager(sessionManager);

  // ── One-shot mode ───────────────────────────────────────────────────────
  if (cli.prompt) {
    const bus = new MessageBus({ sessionManager, sink });
    // Wire up task completion (appends result to context + wakes manager)
    taskManager.setBus(bus);

    bus.enqueue(cli.prompt);
    let exitCode = 0;
    try {
      await bus.runUntilCancelled();
      console.log("\n");
    } catch (e) {
      console.error(formatError(e));
      exitCode = 1;
    }
    const oneShotSessionId = sessionManager.sessionId();
    if (oneShotSessionId) {
      console.log(`Session: ${oneShotSessionId}`);
    }
    await core.extensions.cleanup();
    process.exit(exitCode);
  }

  // ── Interactive mode ────────────────────────────────────────────────────
  const agent = sessionManager.getAgent();

  console.log("oa-agent 0.1.0 (interactive mode)");
  console.log(`Model: ${resolved.model}`);
  console.log(`Profile: ${resolved.profileName}`);
  console.log(`Session: ${agent?.sessionId || "unknown"}`);
  console.log("Type /quit or /exit to exit.\n");

  const bus = new MessageBus({ sessionManager, sink });

  // Wire up task completion (appends result to context + wakes manager)
  taskManager.setBus(bus);

  // Interactive session loop
  const { runInteractiveSession } = await import("./ui/session.js");
  runInteractiveSession({
    sessionManager,
    bus,
    sink,
    resolved,
    hooks: core.hooks,
    onClose: () => {
      const interactiveSessionId = sessionManager.sessionId();
      if (interactiveSessionId) {
        console.log(`Session: ${interactiveSessionId}`);
      }
      return core.extensions.cleanup();
    },
  });
  bus.run();
}

main().catch(async (e) => {
  console.error(formatError(e));
  process.exit(1);
});
