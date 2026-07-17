// One-Shot Extension
// Provides one-shot prompt mode as a CLI subcommand.
// Runs a single prompt and exits — no interactive session.
// Registers CLI flag (-c/--prompt), subcommand, and CLI args hook handler.

import { MessageBus } from "../../core/session/message-bus.ts";
import { formatError } from "../../core/error.ts";
import { HOOKS } from "../../core/hooks.ts";
import { logger } from "../../core/logger.ts";
import { CliOutputSink } from "../../utils/cli/cli.ts";
import { LlmClient, ProviderConfig } from "../../core/llm-client/client.ts";
import { MarkerMangler } from "../../core/marker-mangler.ts";
import { TaskManager } from "../../core/session/task-manager.ts";
import { SessionManager } from "../../core/session/index.ts";
import { Agent } from "../../core/agent.ts";
import { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";
import { type CommandRegistryLike } from "../../core/commands.ts";

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
): Promise<number> {
  const llmClient = new LlmClient({
    baseUrl: resolved.baseUrl,
    apiKey: resolved.apiKey,
    stream: resolved.stream,
    chatTimeoutSecs: resolved.chatTimeout,
    maxRetries: resolved.maxRetries,
    providers: (config.providers as ProviderConfig[]) || [],
    markerMangler: new MarkerMangler(),
  });

  const taskManager = new TaskManager({
    buildAgent,
    llmClient,
    modelRegistry,
    config,
    hooks: core.hooks,
    maxIterations: resolved.maxIterations,
    taskProfile: resolved.taskProfile || "task-default",
    taskRole: resolved.taskDefaultRole || "",
  });

  // Create SessionManager
  const sessionManager = await SessionManager.create({
    hooks: core.hooks as unknown as { notifyHooksAsync: (hookName: string, data: unknown) => Promise<void>; notifyHooks: (hookName: string, data: unknown) => void },
    extensions: core.extensions,
    buildAgent,
    initialConfig: { sessionId: cli.sessionId || null },
  });

  // Wire taskManager to sessionManager
  taskManager.setSessionManager(sessionManager as { getAgent: () => { abortSignal: AbortSignal | null; run: (description: string) => Promise<string | undefined>; notifyCompletion: (result: string) => void; addMessage: (msg: unknown) => void; followQueue?: string[] } | undefined });

  // Create MessageBus
  const bus = new MessageBus({
    sessionManager: sessionManager as unknown as { getAgent: () => { hooks: { runHookPipeline: (hookName: string, data: unknown, opts?: { shouldStop?: (result: unknown) => boolean }) => Promise<unknown> }; run: (text: string) => Promise<unknown>; resetCancel: () => void; cancel: () => void; commandRegistry: CommandRegistryLike | undefined; executeCommand: (cmd: unknown) => Promise<unknown> } | undefined },
    sink,
  });

  // Wire up task completion
  taskManager.setBus(bus);

  // Enqueue the prompt
  (bus as { enqueue: (text: string) => void }).enqueue(cli.prompt || (cli.args || []).join(" "));

  let exitCode = 0;
  try {
    await bus.runUntilCancelled();
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

  // Build agent function (same as in main.ts)
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
      llmClient,
      model: (agentConfig.model as string) || (resolved as ResolvedConfig).model,
      maxIterations:
        (agentConfig.maxIterations as number) || (resolved as ResolvedConfig).maxIterations || 100,
      contextLimit: 128000,
      hideTools: typeof agentConfig.hideTools === "boolean" ? agentConfig.hideTools : (resolved as ResolvedConfig).hideTools,
      hideThinking: typeof agentConfig.hideThinking === "boolean" ? agentConfig.hideThinking : (resolved as ResolvedConfig).hideThinking,
      showTokenUse: typeof agentConfig.showTokenUse === "boolean" ? agentConfig.showTokenUse : (resolved as ResolvedConfig).showTokenUse,
      sink: (agentConfig.sink as { emit: (event: unknown) => void } | undefined) || sink,
      modelRegistry: modelRegistry as { [key: string]: { contextLimit?: number; reasoningEffort?: string; [key: string]: unknown } },
      profileName: (agentConfig.profileName as string) || (resolved as ResolvedConfig).profileName,
      role: (agentConfig.role as string) || (resolved as ResolvedConfig).role,
      profileBody: (agentConfig.profileBody as string) || (resolved as ResolvedConfig).profileBody,
      stream: typeof agentConfig.stream === "boolean" ? agentConfig.stream : (resolved as ResolvedConfig).stream,
      config,
      sessionId,
      abortSignal: (agentConfig.abortSignal as AbortSignal) || null,
      toolWhitelist: (agentConfig.toolWhitelist as string[]) || null,
    });

    await agent.ensureSystemPrompt();

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
  );
}

/**
 * Create the one-shot extension.
 * Registers the "prompt" subcommand and -c/--prompt CLI flag for one-shot mode.
 * All registration happens through hooks.
 */
export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: core.hooks
      ? {
          // Handle -c/--prompt flag by setting subcommand
          // (flag itself is declared in extension.json for static discovery)
          [HOOKS.CLI_ARGS_PARSED]: ({ cli }: { cli: CliArgs }) => {
            if (cli.prompt) {
              cli.subcommand = "prompt";
            }
          },

          // Register the "prompt" subcommand
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
