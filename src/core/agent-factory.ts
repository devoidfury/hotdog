import crypto from "node:crypto";
import { Agent, type ModelRegistry, type OutputSink } from "./agent.ts";
import type { LlmClient } from "./llm-client/client.ts";
import { HOOKS } from "./hooks.ts";
import { getLayerDefault, CONFIG_SCHEMA } from "./config/schema-loader.ts";
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
   * their own map; CLI sites leave it unset and take body from resolved).
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
    // The startup profile picked by the config chain (CLI --profile / config.profile).
    // CLI entry points pass no profiles overlay, so its tool filters live only on profileDef --
    // without this fallback a `--profile X` session runs unfiltered.
    // Only inherited when the requested name IS the resolved one, so an explicitly
    // requested profile never drags the startup profile's filters along.
    const startupProfile =
      profile ?? (profileName === resolved.profileName ? (resolved.profileDef ?? null) : null);
    const toolWhitelist =
      agentConfig.toolWhitelist !== undefined
        ? (agentConfig.toolWhitelist as string[] | null)
        : (startupProfile?.whitelistTools ?? null);
    const baseConfig = { ...(options.config ?? core.config) } as Record<string, unknown>;
    const toolBlacklist =
      agentConfig.blacklistTools !== undefined
        ? (agentConfig.blacklistTools as string[] | null)
        : startupProfile?.blacklistTools?.length
          ? startupProfile.blacklistTools
          : ((baseConfig.blacklistTools as string[] | null | undefined) ?? null);

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
      //  TaskManager passes an explicit "" for a frontmatter-only worker profile;
      // falsy-fallthrough would graft the session profile's body onto the worker's system prompt.
      profileBody:
        agentConfig.profileBody !== undefined
          ? (agentConfig.profileBody as string)
          : profile?.body || resolved.profileBody,
      // Loaded template text from buildConfig; the agent must never depend on
      // process-global template state (multi-session hosts resolve config
      // per entry point).
      systemPromptTemplate: resolved.systemPromptTemplate,
      config: {
        ...baseConfig,
        blacklistTools: toolBlacklist ?? undefined,
        maxToolCallsPerIteration: resolved.maxToolCallsPerIteration as number,
        maxRetries: resolved.maxRetries as number,
        toolRetryDelay: resolved.toolRetryDelay as number,
        // Schema-default fallback like main.ts's createLlmClient maxRetries:
        // hand-built resolved bags (tests, embedded hosts) stay valid.
        maxEmptyRetries:
          (resolved.maxEmptyRetries as number) ??
          (getLayerDefault(CONFIG_SCHEMA.maxEmptyRetries) as number),
        workspaceRoots: (resolved.workspaceRoots as string[]) || [process.cwd()],
        // Carry the resolved deny list through verbatim, including an
        // explicit [] (denylist disabled by config). null means unresolved
        // so ToolExecutor applies the built-in DEFAULT_DENY_PATTERNS.
        workspaceDeny: (resolved.workspaceDeny as readonly string[] | undefined) ?? null,
      },
      sessionId: (agentConfig.sessionId as string) || crypto.randomUUID(),
      abortSignal: (agentConfig.abortSignal as AbortSignal | null | undefined) ?? null,
      toolWhitelist,
      // Precedence: explicit override > profile overlay > resolved profileDef
      // (the profile the config resolution chain picked at startup).
      managerProfile: pickBoolean(
        agentConfig.managerProfile,
        profile?.manager ?? (startupProfile?.manager === true),
      ),
    });

    await core.hooks.notifyHooks(HOOKS.COMMANDS_REGISTER, {
      registry: agent.commandRegistry,
      agent,
    });

    return agent;
  };
}
