// The `hotdog rpc` subcommand: a persistent machine session. Boot mirrors the
// one-shot CLI (same SessionManager bootstrap, same `-s` resume semantics,
// minus the structured-output tool), then hands the connection to RpcServer:
// command records in on stdin, event records out on stdout.
//
// The question seam is mounted on every agent's tool context while an RPC
// connection is live, so the question tool and user-gate prompts round-trip
// through `ask`/`answer` records instead of failing closed. One connection
// per process: this is the stdio embedding shape, not a hub.

import readline from "node:readline";
import { formatError } from "@core/error.ts";
import { HOOKS } from "@core/hooks.ts";
import { Message } from "@core/context/message.ts";
import { formatToolResult } from "@core/extensions/tool-utils.ts";
import { CliSubcommandRegistryLike } from "@core/extensions/registries.ts";
import { logger } from "@utils/logger.ts";
import { buildTaskConfigOptions, SessionManager, type AgentLike } from "@core/session/index.ts";
import { createAgentFactory } from "@core/agent-factory.ts";
import { restoreSessionIntoAgent } from "@core/session/session-log.ts";
import { getSessionRow } from "@core/session/session-index.ts";
import { registerTaskManagerService } from "../subagents/index.ts";
import { RpcServer } from "./rpc-server.ts";
import type { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import type { CoreConfigWithExtensions, CliArgv } from "@core/config/index.ts";
import type { ModelConfig } from "@core/config/providers.ts";

/** The live connection's seam, mounted on agent tool contexts (same pattern
 *  as the interactive CLI's currentInput). One process serves one connection. */
let currentServer: RpcServer | null = null;

async function runRpcServer(cli: CliArgv, core: CoreContext): Promise<number> {
  const { config } = core;
  const resolved = core.resolved!;
  const modelRegistry = resolved.modelRegistry;
  const llmClient = core.createLlmClient();
  const factory = createAgentFactory(core, { resolved, config, llmClient });

  // `-s <id>` continues that session, same contract as one-shot: replay the
  // log, restore the profile, honor the attested model. Questions still held
  // by the log cannot be re-asked through the seam (the tool call is gone),
  // so they close honestly as unanswered.
  const buildAgent: (agentConfig: Record<string, unknown>) => Promise<AgentLike> = async (agentConfig) => {
    const agent = await factory(agentConfig);
    const { pendingQuestions, profile } = await restoreSessionIntoAgent(agent, cli.sessionId as string | undefined);
    if (profile && resolved.profileManager) {
      const profiles = resolved.profileManager.getProfilesForSwitch();
      const p = profiles[profile];
      if (p) agent.applyProfile(profile, p);
    }
    if (cli.sessionId && agent.sessionId === cli.sessionId) {
      const cliModel = typeof cli.model === "string" && cli.model ? cli.model : null;
      const attestedModel = getSessionRow(cli.sessionId)?.model ?? null;
      if (!cliModel && attestedModel) {
        agent.model = attestedModel;
      }
    }
    for (const q of pendingQuestions) {
      agent.addMessage(
        new Message({
          role: "tool",
          content: [
            formatToolResult(
              "User is not connected (session resumed over a fresh connection); this question was not answered.",
              "question",
              false,
            ),
          ],
          toolCallId: q.toolCallId,
          source: "tool",
        }),
      );
    }
    return agent;
  };

  const sessionManager = await SessionManager.create({
    hooks: core.hooks,
    extensions: core.extensions,
    buildAgent,
    initialConfig: cli,
    llmClient,
    modelRegistry: modelRegistry as Record<string, ModelConfig>,
    coreConfig: config as CoreConfigWithExtensions,
    taskConfig: buildTaskConfigOptions(resolved),
    profileManager: resolved.profileManager,
  });
  registerTaskManagerService(core, sessionManager.getTaskManager());

  const sessionId = sessionManager.sessionId()!;
  const info = sessionManager.getSessionInfo?.(sessionId);
  const server = new RpcServer({
    sessionManager,
    sessionId,
    writeLine: (line: string) => process.stdout.write(line),
  });
  currentServer = server;
  server.hello(info?.model);

  let exitCode = 0;
  // readline over stdin: async-iterable lines, terminal-free (no echo, no
  // tty handling -- the machine client is not a person at a keyboard).
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  try {
    await server.run(rl);
  } catch (e: unknown) {
    logger.error(formatError(e));
    exitCode = 1;
  } finally {
    rl.close();
    currentServer = null;
    sessionManager.getTaskManager()?.stop();
    await core.extensions.cleanup();
  }
  return exitCode;
}

export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: core.hooks
      ? {
          [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry: CliSubcommandRegistryLike) => {
            registry.register("rpc", {
              description: "Machine interface: JSONL command/event session over stdin/stdout",
              handler: runRpcServer,
            });
          },
          [HOOKS.AGENT_TOOL_CONTEXT]: (payload: { toolCtx: { set: (key: string, value: unknown) => void } }) => {
            if (currentServer) {
              payload.toolCtx.set("input", currentServer.seam);
            }
          },
        }
      : undefined,
  };
}
