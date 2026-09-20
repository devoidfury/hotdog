import { formatError } from "@core/error.ts";
import { HOOKS } from "@core/hooks.ts";
import { CliSubcommandRegistryLike } from "@core/extensions/registries.ts";
import { logger } from "@utils/logger.ts";
import { CliOutputSink } from "@utils/cli/cli.ts";
import type { LlmClient } from "@core/llm-client/client.ts";
import { SessionManager, type AgentLike } from "@core/session/index.ts";
import { createAgentFactory } from "@core/agent-factory.ts";
import { restoreSessionIntoAgent } from "@core/session/session-log.ts";
import { registerTaskManagerService } from "../subagents/index.ts";
import { OneShotChannel } from "./oneshot-channel.ts";
import { StructuredOutputTool, resolveOutputSchema, STRUCTURED_OUTPUT_TOOL_NAME } from "./structured-output.ts";
import type { CoreContext, ExtensionInstance, ResolvedConfig } from "@core/extensions/types.ts";
import type { PaletteOptions } from "@utils/cli/colors.ts";
import type { CoreConfigWithExtensions, CliArgv } from "@core/config/index.ts";
import type { ModelConfig } from "@core/config/providers.ts";

/** Per-run capture for `--json-schema` mode. */
interface StructuredRun {
  payload: Record<string, unknown> | null;
}

async function runOneShot(
  cli: CliArgv,
  core: CoreContext,
  resolved: ResolvedConfig,
  config: CoreConfigWithExtensions,
  modelRegistry: Record<string, ModelConfig>,
  sink: CliOutputSink | null,
  buildAgent: (agentConfig: Record<string, unknown>) => Promise<AgentLike>,
  llmClient: LlmClient,
  structured: StructuredRun | null,
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
    },
    // Mirrors the interactive CLI: without it the TaskManager cannot resolve
    // worker profiles from the config directory.
    profileManager: resolved.profileManager,
  });

  // Publish the TaskManager for lazy lookup by subagent tools; extensions
  // (and their tools) were loaded before this session existed.
  registerTaskManagerService(core, sessionManager.getTaskManager());

  // --json-schema: one turn is the whole contract. The bus loop otherwise only ends on cancel(),
  // so end the main session's first stopped turn by cancelling the bus; that resolves runUntilCancelled deterministically
  // rather than relying on event-loop drain so the payload print below always runs. Subagent TURN_ENDs are filtered by session id.
  if (structured) {
    const mainSessionId = sessionManager.sessionId();
    core.hooks.on(HOOKS.TURN_END, ({ stopped, agent }: { stopped: boolean; agent?: { sessionId?: string } }) => {
      if (!stopped || !mainSessionId) return;
      if (agent?.sessionId && agent.sessionId !== mainSessionId) return;
      sessionManager.cancel(mainSessionId);
    });
  }

  // Constructed for side-effect: attach() subscribes the sink to session events.
  // In --json schema mode there is no sink(structured), raw JSON is printed at the end instead, so skip the channel and all normal stdout.
  if (sink) {
    new OneShotChannel({
      sessionManager,
      sessionId: sessionManager.sessionId()!,
      sink,
    });
  }

  const promptText = cli.prompt || (Array.isArray(cli.args) ? cli.args.join(" ") : "");
  sessionManager.enqueue(sessionManager.sessionId()!, promptText);

  let exitCode = 0;
  try {
    const bus = sessionManager.getBus(sessionManager.sessionId()!);
    if (bus) {
      await bus.runUntilCancelled();
    }
    if (!structured) console.log("\n");
  } catch (e: unknown) {
    logger.error(formatError(e));
    exitCode = (e as { exitCode?: number }).exitCode ?? 1;
  } finally {
    if (!structured) {
      const oneShotSessionId = sessionManager.sessionId();
      if (oneShotSessionId) {
        console.log(`Session: ${oneShotSessionId}`);
      }
    }
    await core.extensions.cleanup();
  }

  if (structured) {
    if (structured.payload === null) {
      logger.error(
        "run ended without a valid " + STRUCTURED_OUTPUT_TOOL_NAME + " tool call",
      );
      exitCode = exitCode || 1;
    } else {
      console.log(JSON.stringify(structured.payload));
    }
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

  // --json-schema: register the synthetic terminal tool and capture its payload. When present, the normal CLI sink is dropped so stdout carries only the bare JSON.
  let structured: StructuredRun | null = null;
  const schemaArg = (cli as Record<string, unknown>).jsonSchema;
  if (typeof schemaArg === "string" && schemaArg.trim().length > 0) {
    const { schema, error } = await resolveOutputSchema(schemaArg);
    if (!schema) {
      console.error(`--json-schema: ${error}`);
      return 1;
    }
    structured = { payload: null };
    const capture = structured;
    const tool = new StructuredOutputTool(schema, (payload) => {
      capture.payload = payload;
    });
    core.toolRegistry.register(STRUCTURED_OUTPUT_TOOL_NAME, tool);
  }

  let sink: CliOutputSink | null = null;
  if (!structured) {
    const palette = await CliOutputSink.resolve(
      cli.colors !== false,
      (cli.theme || config.theme || "dark") as string,
      (config.colors as PaletteOptions) || null,
    );
    sink = new CliOutputSink({
      ...resolved,
      palette,
      thinkerFormat: resolved.thinkerFormat,
      toolCallDisplayFormat: resolved.toolCallDisplayFormat,
      toolOutputFmt: resolved.toolOutputFmt,
    });
  }

  const llmClient = core.createLlmClient();

  const factory = createAgentFactory(core, { resolved, config, llmClient });

  // `-s <id>` on a one-shot run means "continue that session": the factory
  // adopts the id (initialConfig is the CLI argv), so replay the existing
  // log into the fresh agent. Without this the run appends to a log the
  // model never read. Same helper as the interactive CLI's resume.
  const buildAgent: (agentConfig: Record<string, unknown>) => Promise<AgentLike> = async (agentConfig) => {
    const agent = await factory(agentConfig);
    await restoreSessionIntoAgent(agent, cli.sessionId as string | undefined);
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
    structured,
  );
}

export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: core.hooks
      ? {
          // The `-p/--prompt` flag selects this subcommand declaratively
          // (extension.json "isSubcommand"), so it resolves before extensions
          // load and `main()` can bail early when nothing will run.
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
