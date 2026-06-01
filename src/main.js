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
import { getExtensionsToLoad, emitConfigRegistration } from "./core/extensions.js";
import { HOOKS, EXTENSION_PROVIDES } from "./hooks.js";
import { CliOutputSink } from "./ui/cli.js";
import { parseArgs, generateHelpText } from "./cli.js";
import { loadConfig, buildConfig } from "./config.js";
import { createConfigRegistry } from "./config-registry.js";
import { formatError, isExpectedError } from "./context/error.js";
import { OUTPUT_EVENT } from "./context/output.js";
import { createSubcommandRegistry } from "./core/subcommand-registry.js";
import { TaskManager } from "./session/task_manager.js";
import { Message } from "./context/message.js";
import {
  sessionExists,
  readSessionEntries,
  replayEntriesIntoContext,
} from "./session/session-log.js";

// ── Extension Loading ────────────────────────────────────────────────────────

/**
 * Load all extensions into the core.
 * Returns the loaded extensions for reference.
 *
 * Note: Extension paths are resolved relative to src/core/extensions.js
 * (the file that does the import()), not relative to src/main.js.
 */
/**
 * Load all extensions into the core based on config settings.
 * Extensions are auto-discovered from configured paths and loaded in
 * the proper order (refresh first, core-tools second, then others).
 *
 * @param {Object} core - The core object with hooks, extensions, etc.
 * @param {Object} options - Loading options.
 * @param {Object} options.taskManager - TaskManager instance for subagent tools.
 * @param {Object} options.config - Resolved config with extension settings.
 * @returns {Promise<Array>} Loaded extension instances.
 */
async function loadExtensions(core, { taskManager, config } = {}) {
  const loaded = [];

  // Discover extensions from config (returns sorted by load order)
  const extensionPaths = config?.extensionPaths || ["builtins"];
  const extensionAutoload = config?.extensionAutoload ?? false;
  const extensionsList = config?.extensions || [];

  const extensionsToLoad = await getExtensionsToLoad(
    extensionPaths,
    extensionAutoload,
    extensionsList,
  );

  // Load all extensions in proper order via the extension loader.
  // The loader handles import + create() call. taskManager is passed
  // to all extensions (extensions that don't need it simply ignore it).
  for (const ext of extensionsToLoad) {
    const extInstance = await core.extensions.load(ext.name, ext.path, {
      taskManager,
    });
    if (extInstance) loaded.push(extInstance);
  }

  return loaded;
}

/**
 * Load CLI subcommand extensions — extensions that provide CLI subcommands.
 * These are loaded early (before core config) and register subcommands via hooks.
 * CLI extensions are automatically discovered by their 'provides' capability.
 *
 * @param {Object} earlyCore - Minimal core with hooks for subcommand registration.
 * @param {Object} earlyCore.config - Configuration object.
 * @returns {Promise<Array>} Loaded extension instances.
 */
async function loadCliExtensions(earlyCore) {
  const loaded = [];

  // Discover all extensions and filter for CLI providers
  const extensionPaths = earlyCore.config?.extensionPaths || ["builtins"];
  const extensionAutoload = earlyCore.config?.extensionAutoload ?? false;
  const extensionsList = earlyCore.config?.extensions || [];

  const allExtensions = await getExtensionsToLoad(
    extensionPaths,
    extensionAutoload,
    extensionsList,
  );

  // Filter to only extensions that provide CLI subcommands
  const cliExtensions = allExtensions.filter((ext) =>
    ext.provides?.includes(EXTENSION_PROVIDES.CLI_SUBCOMMANDS),
  );

  // Load CLI extensions via the extension loader (handles import + create() call)
  // Note: Path is ../../extensions/... because the import happens from
  // extensions.js context (where ExtensionLoader.load() does the import)
  for (const ext of cliExtensions) {
    const extInstance = await earlyCore.extensions.load(ext.name, ext.path);
    if (extInstance) loaded.push(extInstance);
  }

  return loaded;
}

// ── Core Infrastructure ─────────────────────────────────────────────────────

/**
 * Create the core infrastructure: hooks, tool registry, extension loader.
 *
 * @param {Object} config - Configuration object.
 * @param {Object} [configRegistry] - Optional config registry for extension CLI flags & config params.
 * @returns {Object} Core object with hooks, toolRegistry, extensions, config.
 */
function createCore(config, configRegistry) {
  const hooks = createHooks();
  const toolRegistry = createToolRegistry();
  const extensions = createExtensionLoader({
    hooks,
    toolRegistry,
    config,
    configRegistry,
  });

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
  // ── Create config registry for extension CLI flags & config params ──────
  const configRegistry = createConfigRegistry();

  // ── Parse CLI args with extension flags ─────────────────────────────────
  const cli = parseArgs(configRegistry);

  // ── Early core for CLI extension loading ────────────────────────────────
  // Create minimal core with hooks for CLI subcommand registration
  const earlyHooks = createHooks();
  const cliSubcommandRegistry = createSubcommandRegistry();
  const earlyToolRegistry = createToolRegistry();
  const earlyExtensions = createExtensionLoader({
    hooks: earlyHooks,
    toolRegistry: earlyToolRegistry,
    config: null,
    cliSubcommandRegistry,
    configRegistry,
  });
  // Minimal extension config for discovery (loaded before full config)
  // Use autoload mode to discover all extensions for CLI subcommand registration
  const extConfig = {
    extensionPaths: ["builtins"],
    extensionAutoload: true,
    extensions: [],
  };

  const earlyCore = {
    hooks: earlyHooks,
    config: extConfig,
    buildConfig,
    cliSubcommandRegistry,
    configRegistry,
    extensions: earlyExtensions,
  };

  // ── Load CLI extensions (auto-discovered via provides capability) ────────
  const cliExtensions = await loadCliExtensions(earlyCore);

  // ── Subcommand dispatch ─────────────────────────────────────────────────
  if (cli.subcommand) {
    const subcommandDef = cliSubcommandRegistry.get(cli.subcommand);
    if (subcommandDef) {
      // Load config if needed (with extension params)
      if (subcommandDef.requiresConfig) {
        const extParams = configRegistry.getConfigParams();
        const config = await loadConfig(cli.config, extParams);
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
    const fullHelp = generateHelpText(configRegistry);
    console.log(fullHelp.replace("<subcommands>", subcommandHelp));
    process.exit(0);
  }

  // ── Build complete config ───────────────────────────────────────────────
  const { resolved, modelRegistry, providers } = await buildConfig(cli);

  // Get extension config params for merging into config
  const extParams = configRegistry.getConfigParams();
  const config = await loadConfig(cli.config, extParams);

  // ── Create core infrastructure ──────────────────────────────────────────
  const core = createCore(config, configRegistry);

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
  await loadExtensions(core, { taskManager, config });

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
