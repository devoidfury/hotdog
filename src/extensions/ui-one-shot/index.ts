import { formatError } from "../../core/error.ts";
import { HOOKS } from "../../core/hooks.ts";
import { CliSubcommandRegistryLike } from "../../core/extensions/registries.ts";
import { logger } from "../../core/logger.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";
import type { LlmClient } from "../../core/llm-client/client.ts";
import { SessionManager, type AgentLike } from "../../core/session/index.ts";
import { Agent } from "../../core/agent.ts";
import { registerTaskManagerService } from "../subagents/index.ts";
import { OneShotChannel } from "./oneshot-channel.ts";
import type { CoreContext, ExtensionInstance, ResolvedConfig } from "../../core/extensions/types.ts";
import type { PaletteOptions } from "../../utils/cli/colors.ts";
import type { CoreConfigWithExtensions, CliArgv } from "../../core/config/index.ts";
import type { ModelConfig } from "../../core/config/providers.ts";

interface CliArgs {
  prompt?: string;
  colors?: boolean;
  theme?: string;
  sessionId?: string;
  args?: string[];
  [key: string]: unknown;
}

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
    // Mirrors the interactive CLI: without it the TaskManager cannot resolve
    // worker profiles from the config directory.
    profileManager: resolved.profileManager,
  });

  // Publish the TaskManager for lazy lookup by subagent tools; extensions
  // (and their tools) were loaded before this session existed.
  registerTaskManagerService(core, sessionManager.getTaskManager());

  const channel = new OneShotChannel({
    sessionManager,
    sessionId: sessionManager.sessionId()!,
    sink,
  });

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

async function handlePromptSubcommand(
  cli: CliArgv,
  core: CoreContext,
): Promise<number> {
  const { config } = core;
  const resolved = core.resolved!;

  const modelRegistry = resolved.modelRegistry;

  const palette = await CliOutputSink.resolve(
    cli.colors !== false,
    (cli.theme || config.theme || "dark") as string,
    (config.colors as PaletteOptions) || null,
  );

  const sink = new CliOutputSink({
    ...resolved,
    palette,
    thinkerFormat: resolved.thinkerFormat,
    toolFormat: resolved.toolCallDisplayFormat,
    toolOutputFmt: resolved.toolOutputFmt,
  });

  const llmClient = core.createLlmClient();

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
