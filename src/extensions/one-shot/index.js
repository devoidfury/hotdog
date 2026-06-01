// One-Shot Extension
// Provides one-shot prompt mode as a CLI subcommand.
// Runs a single prompt and exits — no interactive session.
// Registers CLI flag (-c/--prompt), subcommand, and CLI args hook handler.

import { MessageBus } from "../../core/index.js";
import { formatError } from "../../core/error.js";
import { HOOKS } from "../../core/hooks.js";
import { CliOutputSink } from "../../core/ui/cli.js";
import { LlmClient } from "../../core/llm_client/client.js";
import { MarkerMangler } from "../../core/marker_mangler.js";
import { TaskManager } from "../../core/session/task_manager.js";
import { SessionManager } from "../../core/session/index.js";
import { Agent } from "../../core/agent.js";

/**
 * Register CLI flags for the one-shot extension.
 */
function registerOneShotConfig(core) {
  if (core.configRegistry) {
    core.configRegistry.registerCliFlags([
      {
        short: '-c',
        long: '--prompt',
        description: 'One-shot prompt — run a single prompt and exit',
        type: 'string',
        default: null,
      },
    ]);
  }
}

/**
 * Run one-shot mode: execute a single prompt and exit.
 */
async function runOneShot(cli, core, resolved, config, modelRegistry, sink, buildAgent) {
  const llmClient = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: resolved.stream,
    chatTimeoutSecs: resolved.chatTimeout,
    providers: config.providers || [],
    markerMangler: new MarkerMangler(),
  });

  const taskManager = new TaskManager({
    buildAgent,
    llmClient,
    modelRegistry,
    config,
    hooks: core.hooks,
    maxIterations: config.maxIterations || 1000,
  });

  // Create SessionManager
  const sessionManager = await SessionManager.create({
    hooks: core.hooks,
    extensions: core.extensions,
    buildAgent,
    initialConfig: { sessionId: cli.sessionId || null },
  });

  // Wire taskManager to sessionManager
  taskManager.setSessionManager(sessionManager);

  // Create MessageBus
  const bus = new MessageBus({ sessionManager, sink });

  // Wire up task completion
  taskManager.setBus(bus);

  // Enqueue the prompt
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

// ── Extension Entry Point ───────────────────────────────────────────────────

/**
 * Create the one-shot extension.
 * Registers the "prompt" subcommand and -c/--prompt CLI flag for one-shot mode.
 */
export function create(core) {
  // Register CLI flags
  registerOneShotConfig(core);

  // Register hook to handle -c/--prompt flag by setting subcommand
  if (core.hooks) {
    core.hooks.on(HOOKS.CLI_ARGS_PARSED, ({ cli }) => {
      if (cli.prompt) {
        cli.subcommand = 'prompt';
      }
    });
  }

  // Register subcommand if the registry is available
  if (core.cliSubcommandRegistry) {
    core.cliSubcommandRegistry.register("prompt", {
      description: "One-shot prompt mode — run a single prompt and exit",
      requiresConfig: true,
      handler: async (cli, core) => {
        const { config, buildConfig, resolved, modelRegistry } = core;

        // Build output sink
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

        // Build agent function (same as in main.js)
        const llmClient = new LlmClient({
          baseUrl: resolved.baseUrl,
          apiKey: resolved.apiKey,
          stream: resolved.stream,
          chatTimeoutSecs: resolved.chatTimeout,
          providers: config.providers || [],
          markerMangler: new MarkerMangler(),
        });

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

          core.hooks.emit(HOOKS.SLASH_COMMANDS_REGISTER, {
            registry: agent.getSlashCommandRegistry(),
            agent,
          });

          return agent;
        };

        await runOneShot(cli, core, resolved, config, modelRegistry, sink, buildAgent);
      },
    });
  }

  return {
    hooks: core.hooks ? {} : undefined,
  };
}
