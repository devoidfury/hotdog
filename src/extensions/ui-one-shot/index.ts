// One-Shot Extension
// Provides one-shot prompt mode as a CLI subcommand.
// Runs a single prompt and exits — no interactive session.
// Registers CLI flag (-p/--prompt), subcommand, and CLI args hook handler.

import { formatError } from "../../core/error.ts";
import { HOOKS } from "../../core/hooks.ts";
import { logger } from "../../core/logger.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";
import { LlmClient, ProviderConfig } from "../../core/llm-client/client.ts";
import { MarkerMangler } from "../../core/marker-mangler.ts";
import { SessionManager } from "../../core/session/index.ts";
import { Agent } from "../../core/agent.ts";
import { OneShotChannel } from "./oneshot-channel.ts";
import { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";

// ── Types ──────────────────────────────────────────────────────────────────

interface CliArgs {
  prompt?: string;
  colors?: boolean;
  theme?: string;
  sessionId?: string;
  args?: string[];
  [key: string]: unknown;
}

interface ResolvedConfig {
  baseUrl: string;
  apiKey: string;
  stream?: boolean;
  chatTimeout: number;
  maxRetries: number;
  model: string;
  maxIterations: number;
  contextLimit?: number;
  hideTools?: boolean;
  hideThinking?: boolean;
  showTokenUse?: boolean;
  thinkerFormat?: string;
  toolFormat?: string;
  toolOutputFmt?: string;
  profileName: string;
  role?: string;
  profileBody?: string;
  modelRegistry: Record<string, unknown>;
  taskProfile?: string;
  taskDefaultRole?: string;
  [key: string]: unknown;
}

// ── One-Shot Runner ────────────────────────────────────────────────────────

/**
 * Run one-shot mode: execute a single prompt and exit.
 */
async function runOneShot(
  cli: CliArgs,
  core: CoreContext,
  resolved: ResolvedConfig,
  config: Record<string, unknown>,
  modelRegistry: Record<string, unknown>,
  sink: CliOutputSink,
  buildAgent: (agentConfig: Record<string, unknown>) => Promise<Agent>,
  llmClient: unknown,
): Promise<number> {
  // Create SessionManager — owns the MessageBus and TaskManager internally
  const sessionManager = await SessionManager.create({
    hooks: core.hooks as unknown as { notifyHooks: (hookName: string, data: unknown) => void },
    extensions: core.extensions,
    buildAgent,
    initialConfig: { sessionId: cli.sessionId || null },
    llmClient,
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
  sessionManager.enqueue(sessionManager.sessionId()!, cli.prompt || (cli.args || []).join(" "));

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
  cli: CliArgs,
  core: CoreContext,
): Promise<number> {
  const { config, buildConfig, resolved } = core;
  const modelRegistry = (core.resolved?.modelRegistry as Record<string, unknown>) || {};

  // Build output sink
  const palette = await CliOutputSink.resolve(
    cli.colors !== false,
    cli.theme || (config.theme as string) || "dark",
    (config.colors as Record<string, unknown>) || null,
  );

  const sink = new CliOutputSink({
    ...(resolved as ResolvedConfig),
    palette,
    thinkerFormat: (resolved as ResolvedConfig).thinkerFormat,
    toolFormat: (resolved as ResolvedConfig).toolFormat,
    toolOutputFmt: (resolved as ResolvedConfig).toolOutputFmt,
  });

  // Build agent function
  const llmClient = new LlmClient({
    baseUrl: (resolved as ResolvedConfig).baseUrl,
    apiKey: (resolved as ResolvedConfig).apiKey,
    stream: (resolved as ResolvedConfig).stream,
    chatTimeoutSecs: (resolved as ResolvedConfig).chatTimeout,
    maxRetries: (resolved as ResolvedConfig).maxRetries,
    providers: (config.providers as ProviderConfig[]) || [],
    markerMangler: new MarkerMangler(),
  });

  const buildAgent = async (agentConfig: Record<string, unknown>) => {
    const sessionId = (agentConfig.sessionId as string) || crypto.randomUUID();
    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient: (agentConfig.llmClient as LlmClient) || llmClient,
      model: (agentConfig.model as string) || (resolved as ResolvedConfig).model,
      maxIterations:
        (agentConfig.maxIterations as number) || (resolved as ResolvedConfig).maxIterations || 100,
      contextLimit: 128000,
      hideTools: typeof agentConfig.hideTools === "boolean" ? agentConfig.hideTools : (resolved as ResolvedConfig).hideTools,
      hideThinking: typeof agentConfig.hideThinking === "boolean" ? agentConfig.hideThinking : (resolved as ResolvedConfig).hideThinking,
      showTokenUse: typeof agentConfig.showTokenUse === "boolean" ? agentConfig.showTokenUse : (resolved as ResolvedConfig).showTokenUse,
      sink: null, // Sink is managed by OneShotChannel via SessionManager
      modelRegistry: (agentConfig.modelRegistry as { [key: string]: { contextLimit?: number; reasoningEffort?: string; [key: string]: unknown } }) ||
        (modelRegistry as { [key: string]: { contextLimit?: number; reasoningEffort?: string; [key: string]: unknown } }),
      profileName: (agentConfig.profileName as string) || (resolved as ResolvedConfig).profileName,
      role: (agentConfig.role as string) || (resolved as ResolvedConfig).role,
      profileBody: (agentConfig.profileBody as string) || (resolved as ResolvedConfig).profileBody,
      stream: typeof agentConfig.stream === "boolean" ? agentConfig.stream : (resolved as ResolvedConfig).stream,
      config,
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
    modelRegistry as Record<string, unknown>,
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

          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (
            registry: { register: (name: string, opts: Record<string, unknown>) => void },
          ) => {
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
