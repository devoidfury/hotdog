#!/usr/bin/env bun
// oa-agent — AI agent harness with tool calling support.
// CLI entry point — wired to the extension architecture.

import readline from "node:readline";
import {
  createHooks,
  createToolRegistry,
  createExtensionLoader,
  SessionManager,
  Agent,
} from "./core/index.js";
import { CliOutputSink } from "./ui/cli.js";
import { parseArgs, HELP_TEXT } from "./cli.js";
import { loadConfig } from "./config.js";
import { buildConfig } from "./init/resolution.js";
import { formatError, isExpectedError } from "./context/error.js";
import { OUTPUT_EVENT } from "./context/output.js";
import { shutdownAll } from "../ext/lsp/index.js";

// ── Extension Loading ────────────────────────────────────────────────────────

/**
 * Load all extensions into the core.
 * Returns the loaded extensions for reference.
 *
 * Note: Extension paths are resolved relative to src/core/extensions.js
 * (the file that does the import()), not relative to src/main.js.
 */
async function loadExtensions(core) {
  const loaded = [];

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

  return loaded;
}

/**
 * Load the info-show-prompt extension (info, show-prompt).
 * Returns the extension instance with CLI handlers.
 */
async function loadInfoShowPromptExtension() {
  const { create: createInfoShowPrompt } =
    await import("../extensions/info-show-prompt/index.js");
  const core = {
    config: null, // Will be set after config loading
    buildConfig,
  };
  const ext = createInfoShowPrompt(core);
  return ext;
}

/**
 * Load the session-review extension (review subcommand).
 * Returns the extension instance with CLI handlers.
 */
async function loadSessionReviewExtension() {
  const { create: createSessionReview } =
    await import("../extensions/session-review/index.js");
  const core = {
    config: null,
  };
  const ext = createSessionReview(core);
  return ext;
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
    const cmd = parseCommand(cmdText);
    const agent = this._sessionManager.getAgent();

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

  // ── Subcommand dispatch ─────────────────────────────────────────────────
  // Load info-show-prompt extension first (needs config)
  const infoShowPromptExt = await loadInfoShowPromptExtension();

  if (cli.subcommand === "info") {
    const config = await loadConfig(cli.config);
    infoShowPromptExt.cli._core = { config, buildConfig };
    await infoShowPromptExt.cli.info(cli);
    return;
  }
  if (cli.subcommand === "show-prompt") {
    const config = await loadConfig(cli.config);
    infoShowPromptExt.cli._core = { config, buildConfig };
    await infoShowPromptExt.cli["show-prompt"].call(infoShowPromptExt.cli, cli);
    return;
  }

  // Load session-review extension for review subcommand
  const sessionReviewExt = await loadSessionReviewExtension();

  if (cli.subcommand === "review") {
    const config = await loadConfig(cli.config);
    sessionReviewExt.cli._core = { config };
    await sessionReviewExt.cli.review.call(sessionReviewExt.cli, cli);
    return;
  }

  if (cli.version) {
    console.log("oa-agent 0.1.0");
    process.exit(0);
  }
  if (cli.help) {
    console.log(HELP_TEXT);
    process.exit(0);
  }

  // ── Build complete config ───────────────────────────────────────────────
  const { resolved, modelRegistry, providers } = await buildConfig(cli);
  const config = await loadConfig(cli.config);

  // ── Create core infrastructure ──────────────────────────────────────────
  const core = createCore(config);

  // ── Load extensions ─────────────────────────────────────────────────────
  await loadExtensions(core);

  // ── Emit tools:register hook to trigger tool registration ───────────────
  await core.hooks.emitAsync("tools:register", core.toolRegistry);

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

  // ── Create SessionManager with buildAgent function ──────────────────────
  const sessionManager = await SessionManager.create({
    hooks: core.hooks,
    extensions: core.extensions,
    buildAgent: async (agentConfig) => {
      // Build agent using core Agent with hooks and tool registry
      const agent = new Agent({
        hooks: core.hooks,
        toolRegistry: core.toolRegistry,
        llmClient,
        model: agentConfig.model || resolved.model,
        maxIterations: config.maxIterations || 1000,
        maxTokens: config.maxTokens || 32000,
        hideTools: resolved.hideTools,
        hideThinking: resolved.hideThinking,
        showTokenUse: resolved.showTokenUse,
        sink,
        modelRegistry: modelRegistry,
        profileName: resolved.profileName,
        role: resolved.role,
        profileBody: resolved.profileBody,
        stream: resolved.stream,
        config,
        sessionId: resolved.sessionId || crypto.randomUUID(),
      });

      // Ensure system prompt is built
      await agent.ensureSystemPrompt();

      return agent;
    },
  });

  // ── One-shot mode ───────────────────────────────────────────────────────
  if (cli.prompt) {
    const bus = new MessageBus({ sessionManager, sink });
    bus.enqueue(cli.prompt);
    try {
      await bus.runUntilCancelled();
      console.log("\n");
    } catch (e) {
      console.error(formatError(e));
      await shutdownAll();
      process.exit(1);
    }
    await shutdownAll();
    process.exit(0);
  }

  // ── Interactive mode ────────────────────────────────────────────────────
  const agent = sessionManager.getAgent();

  console.log("oa-agent 0.1.0 (interactive mode)");
  console.log(`Model: ${resolved.model}`);
  console.log(`Profile: ${resolved.profileName}`);
  console.log(`Session: ${agent?.sessionId || "unknown"}`);
  console.log("Type /quit or /exit to exit.\n");

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `(${resolved.model})> `,
  });

  const bus = new MessageBus({ sessionManager, sink });

  // Interactive session loop
  const { runInteractiveSession } = await import("./ui/session.js");
  runInteractiveSession({
    rl,
    sessionManager,
    bus,
    sink,
    resolved,
  });
  bus.run();
}

main().catch(async (e) => {
  console.error(formatError(e));
  await shutdownAll();
  process.exit(1);
});
