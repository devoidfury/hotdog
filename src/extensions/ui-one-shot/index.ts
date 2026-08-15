// One-Shot Extension
// Provides one-shot prompt mode as a CLI subcommand.
// Runs a single prompt and exits — no interactive session.
// Registers CLI flag (-p/--prompt), subcommand, and CLI args hook handler.

import { formatError } from "../../core/error.ts";
import { HOOKS } from "../../core/hooks.ts";
import { CliSubcommandRegistryLike } from "../../core/extensions/registries.ts";
import { logger } from "../../core/logger.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";
import { LlmClient, type ProviderConfig } from "../../core/llm-client/client.ts";
import { MarkerMangler } from "../../core/marker-mangler.ts";
import { SessionManager, type AgentLike } from "../../core/session/index.ts";
import { Agent } from "../../core/agent.ts";
import { OneShotChannel } from "./oneshot-channel.ts";
import type { CoreContext, ExtensionInstance, ResolvedConfig } from "../../core/extensions/types.ts";
import type { PaletteOptions } from "../../utils/cli/colors.ts";
import type { CoreConfigWithExtensions, CliArgv } from "../../core/config/index.ts";
import type { ModelConfig } from "../../core/config/providers.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface CliArgs {
  prompt?: string;
  colors?: boolean;
  theme?: string;
  sessionId?: string;
  args?: string[];
  [key: string]: unknown;
}

// ── One-Shot Runner ────────────────────────────────────────────────────────

/**
 * Run one-shot mode: execute a single prompt and exit.
 */
async function runOneShot(
  cli: CliArgv,
  core: CoreContext,
  resolved: ResolvedConfig,
  config: CoreConfigWithExtensions,
  modelRegistry: Record<string, ModelConfig>,
  sink: CliOutputSink,
  buildAgent: (agentConfig: Record<string, unknown>) => Promise<AgentLike>,
  llmClient: LlmClient,
): Promise<number> {
  // Create SessionManager — owns the MessageBus and TaskManager internally
  const sessionManager = await SessionManager.create({
    hooks: core.hooks,
    extensions: core.extensions,
    buildAgent,
    initialConfig: cli,
    llmClient: llmClient,
    modelRegistry,
    coreConfig: config,
    taskConfig: {
      maxIterations: resolved.maxIterations,
      taskProfile: resolved.taskProfile || "task-default",
      taskRole: resolved.taskDefaultRole || "",
    },
  });

  // Create OneShotChannel
  const channel = new OneShotChannel({
    sessionManager,
    sessionId: sessionManager.sessionId()!,
    sink,
  });

  // Enqueue the prompt via the SessionManager
  const promptText = cli.prompt || (Array.isArray(cli.args) ? cli.args.join(" ") : "");
  sessionManager.enqueue(sessionManager.sessionId()!, promptText);

  let exitCode = 0;
  try {
    const bus = sessionManager.getBus(sessionManager.sessionId()!);
    if (bus) {
      await bus.runUntilCancelled();
    }
    console.log("\n");
  } catch (e: unknown) {
    logger.error(formatError(e));
    exitCode = (e as { exitCode?: number }).exitCode ?? 1;
  } finally {
    const oneShotSessionId = sessionManager.sessionId();
    if (oneShotSessionId) {
      console.log(`Session: ${oneShotSessionId}`);
    }
    await core.extensions.cleanup();
  }

  return exitCode;
}

// ── Extension Entry Point ──────────────────────────────────────────────────

/**
 * Handle the "prompt" subcommand: run a single prompt and exit.
 */
async function handlePromptSubcommand(
  cli: CliArgv,
  core: CoreContext,
): Promise<number> {
  const { config, buildConfig } = core;
  const resolved = core.resolved!;
  
  const modelRegistry = resolved.modelRegistry;

  // Build output sink
  const palette = await CliOutputSink.resolve(
    cli.colors !== false,
    (cli.theme || config.theme || "dark") as string,
    (config.colors as PaletteOptions) || null,
  );

  const sink = new CliOutputSink({
    ...resolved,
    palette,
    thinkerFormat: resolved.thinkerFormat,
    toolFormat: resolved.toolFormat,
    toolOutputFmt: resolved.toolOutputFmt,
  });

  // Build agent function
  const llmClient = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: resolved.stream,
    chatTimeoutSecs: resolved.chatTimeout,
    maxRetries: resolved.maxRetries,
    providers: (config.providers as ProviderConfig[]) || [],
    markerMangler: new MarkerMangler(),
  });

  const buildAgent: (agentConfig: Record<string, unknown>) => Promise<AgentLike> = async (agentConfig) => {
    const sessionId = (agentConfig.sessionId as string) || crypto.randomUUID();
    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient: (agentConfig.llmClient as LlmClient) || llmClient,
      model: (agentConfig.model as string) || resolved.model,
      maxIterations:
        (agentConfig.maxIterations as number) || resolved.maxIterations || 100,
      contextLimit: 128000,
      hideTools: typeof agentConfig.hideTools === "boolean" ? agentConfig.hideTools : resolved.hideTools,
      hideThinking: typeof agentConfig.hideThinking === "boolean" ? agentConfig.hideThinking : resolved.hideThinking,
      showTokenUse: typeof agentConfig.showTokenUse === "boolean" ? agentConfig.showTokenUse : resolved.showTokenUse,
      sink: null, // Sink is managed by OneShotChannel via SessionManager
      modelRegistry: (agentConfig.modelRegistry as Record<string, ModelConfig>) ||
        (modelRegistry as Record<string, ModelConfig>),
      profileName: (agentConfig.profileName as string) || resolved.profileName,
      role: (agentConfig.role as string) || resolved.role,
      profileBody: (agentConfig.profileBody as string) || resolved.profileBody,
      stream: typeof agentConfig.stream === "boolean" ? agentConfig.stream : resolved.stream,
      config: {
        ...config,
        maxToolCallsPerIteration: resolved.maxToolCallsPerIteration as number,
        maxRetries: resolved.maxRetries as number,
        toolRetryDelay: resolved.toolRetryDelay as number,
      },
      sessionId,
      abortSignal: (agentConfig.abortSignal as AbortSignal) || null,
      toolWhitelist: (agentConfig.toolWhitelist as string[]) || null,
    });

    core.hooks.notifyHooks(HOOKS.COMMANDS_REGISTER, {
      registry: agent.commandRegistry,
      agent,
    });

    return agent;
  };

  return await runOneShot(
    cli,
    core,
    resolved as ResolvedConfig,
    config,
    modelRegistry as Record<string, ModelConfig>,
    sink,
    buildAgent,
    llmClient,
  );
}

/**
 * Create the one-shot extension.
 */
export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: core.hooks
      ? {
          [HOOKS.CLI_ARGS_PARSED]: ({ cli }: { cli: CliArgs }) => {
            if (cli.prompt) {
              cli.subcommand = "prompt";
            }
          },

          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry: CliSubcommandRegistryLike) => {
            registry.register("prompt", {
              description:
                "One-shot prompt mode — run a single prompt and exit",
              handler: handlePromptSubcommand,
            });
          },
        }
      : undefined,
  };
}
