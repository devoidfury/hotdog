import crypto from "node:crypto";
import { Agent, type ModelRegistry, type OutputSink } from "./agent.ts";
import type { LlmClient } from "./llm-client/client.ts";
import { HOOKS } from "./hooks.ts";
import type { CoreContext, ResolvedConfig } from "./extensions/types.ts";
import type { SwitchProfile } from "./config/profiles.ts";

export interface AgentFactoryOptions {
  /** Resolved config; defaults to core.resolved. */
  resolved?: ResolvedConfig | Record<string, unknown> | null;
  /** Raw config bag for Agent.config; defaults to core.config. */
  config?: Record<string, unknown> | null;
  /** Default LlmClient; per-call agentConfig.llmClient overrides it. */
  llmClient: LlmClient;
  /**
   * Session-profile overlays keyed by profile name (websocket/webui pass
   * their own map; CLI sites leave it unset and take role/body from resolved).
   */
  profiles?: Record<string, SwitchProfile> | null;
}

export type AgentBuildFn = (agentConfig?: Record<string, unknown>) => Promise<Agent>;

function pickBoolean(value: unknown, fallback: boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Single agent-assembly pipeline for every UI entry point (interactive CLI,
 * one-shot, websocket/webui). Precedence per field: agentConfig override >
 * profile overlay (when `profiles` is set) > resolved config.
 *
 * Fires COMMANDS_REGISTER after construction (all entry points need it).
 * `agentConfig.sink` must pass through: TaskManager hands spawnTask a silent
 * sink whose onTaskComplete delivers the task result.
 */
export function createAgentFactory(
  core: CoreContext,
  options: AgentFactoryOptions,
): AgentBuildFn {
  return async (agentConfig: Record<string, unknown> = {}) => {
    const resolved = (options.resolved ?? core.resolved ?? {}) as ResolvedConfig;
    const profileName = (agentConfig.profileName as string) || resolved.profileName || "default";
    const profile = options.profiles?.[profileName] || null;

    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient: (agentConfig.llmClient as LlmClient | undefined) || options.llmClient,
      model: (agentConfig.model as string) || resolved.model || "",
      maxIterations: (agentConfig.maxIterations as number) || resolved.maxIterations,
      contextLimit: (agentConfig.contextLimit as number) || resolved.contextLimit,
      hideTools: pickBoolean(agentConfig.hideTools, resolved.hideTools),
      hideThinking: pickBoolean(agentConfig.hideThinking, resolved.hideThinking),
      showTokenUse: pickBoolean(agentConfig.showTokenUse, resolved.showTokenUse),
      sink: (agentConfig.sink as OutputSink | undefined) ?? null,
      modelRegistry:
        (agentConfig.modelRegistry as ModelRegistry | undefined) ||
        resolved.modelRegistry ||
        {},
      profileName,
      role: (agentConfig.role as string) || profile?.role || resolved.role,
      profileBody: (agentConfig.profileBody as string) || profile?.body || resolved.profileBody,
      stream: pickBoolean(agentConfig.stream, resolved.stream),
      config: {
        ...(options.config ?? core.config),
        maxToolCallsPerIteration: resolved.maxToolCallsPerIteration as number,
        maxRetries: resolved.maxRetries as number,
        toolRetryDelay: resolved.toolRetryDelay as number,
        workspaceRoots: (resolved.workspaceRoots as string[]) || [process.cwd()],
      },
      sessionId: (agentConfig.sessionId as string) || crypto.randomUUID(),
      abortSignal: (agentConfig.abortSignal as AbortSignal | null | undefined) ?? null,
      toolWhitelist: (agentConfig.toolWhitelist as string[] | null | undefined) ?? profile?.whitelistTools ?? null,
    });

    core.hooks.notifyHooks(HOOKS.COMMANDS_REGISTER, {
      registry: agent.commandRegistry,
      agent,
    });

    return agent;
  };
}
