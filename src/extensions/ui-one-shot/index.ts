import { formatError } from "../../core/error.ts";
import { HOOKS } from "../../core/hooks.ts";
import { CliSubcommandRegistryLike } from "../../core/extensions/registries.ts";
import { logger } from "../../core/logger.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";
import type { LlmClient } from "../../core/llm-client/client.ts";
import { SessionManager, type AgentLike } from "../../core/session/index.ts";
import { createAgentFactory } from "../../core/agent-factory.ts";
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

  // Constructed for its side effect: attach() subscribes the sink to session events.
  new OneShotChannel({
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

  const buildAgent = createAgentFactory(core, { resolved, config, llmClient });

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
