import crypto from "node:crypto";
import { Agent, type ModelRegistry, type OutputSink } from "./agent.ts";
import type { LlmClient } from "./llm-client/client.ts";
import { HOOKS, type HookSystem } from "./hooks.ts";
import { getLayerDefault, CONFIG_SCHEMA } from "./config/schema-loader.ts";
import { liveAgentConfig } from "./config/agent-view.ts";
import type { CoreContext, ResolvedConfig } from "./extensions/types.ts";
import type { SwitchProfile } from "./config/profiles.ts";
import { sharedToolExecBroker, toolExecPlaneSettings } from "./tool-exec-broker.ts";
import type { ToolExecLink, WireToolConfig } from "./tool-exec-protocol.ts";
import { INTERNAL_MAX_OUTPUT_LINES } from "./extensions/tool-utils.ts";
import { envScrubExtraKeys } from "@utils/env.ts";

export interface AgentFactoryOptions {
  /** Resolved config; defaults to core.resolved. */
  resolved?: ResolvedConfig | Record<string, unknown> | null;
  /** Raw config bag for Agent.config; defaults to core.config. */
  config?: Record<string, unknown> | null;
  /** Default LlmClient; per-call agentConfig.llmClient overrides it. */
  llmClient: LlmClient;
  /**
   * Session-profile overlays keyed by profile name (websocket/webui pass
   * their map; CLI sites leave it unset and take body from resolved).
   * A FUNCTION is read per build (B3): the factory then follows whatever the
   * host's live source answers -- a profile added after boot lands on the
   * NEXT build instead of never.
   */
  profiles?: Record<string, SwitchProfile> | (() => Record<string, SwitchProfile>) | null;
}

export type AgentBuildFn = (agentConfig?: Record<string, unknown>) => Promise<Agent>;

/**
 * Lifecycle closure for pooled tool-exec runners: a session's pool entries
 * -- live runners with rw binds over its workspace roots -- go with the
 * session, not with the broker's idle reaper. SESSION_END marks genuine
 * session end on the shared hook system: task agents release through
 * task-execution, CLI hosts delete on core.hooks, and the webui registry
 * re-fires the delete on the agent's hooks (its SessionManager owns a
 * private hook system). The factory is the caller that knows both sides
 * (plane posture + host hooks); one handler per hook system, since the
 * link is the process-shared broker and hosts create several factories.
 * Exported for tests: a fake link pins the wiring without a plane.
 */
const reapWiredHooks = new WeakSet<object>();

export function wireSessionEndReap(hooks: HookSystem, link: ToolExecLink): void {
  if (reapWiredHooks.has(hooks)) return;
  reapWiredHooks.add(hooks);
  hooks.on(
    HOOKS.SESSION_END,
    ({ sessionId }: { sessionId?: string }) => {
      if (typeof sessionId === "string" && sessionId !== "") link.reap?.(sessionId);
    },
    "tool-exec-plane",
  );
}

function pickBoolean(value: unknown, fallback: boolean | undefined): boolean | undefined {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Single agent-assembly pipeline for every UI entry point (interactive CLI, one-shot, websocket/webui).
 * Precedence per field: agentConfig override > profile overlay (when `profiles` is set) > resolved config.
 *
 * Fires COMMANDS_REGISTER after construction (all entry points need it).
 * `agentConfig.sink` must pass through: TaskManager hands spawnTask a silent sink whose onTaskComplete delivers the task result.
 */
export function createAgentFactory(
  core: CoreContext,
  options: AgentFactoryOptions,
): AgentBuildFn {
  return async (agentConfig: Record<string, unknown> = {}) => {
    const resolved = (options.resolved ?? core.resolved ?? {}) as ResolvedConfig;
    // B5 (design §4.2): the live view applies ONLY on the default core.* path
    // -- a host that passes EITHER base explicitly (ui-interactive-cli,
    // ui-one-shot, workflows, test doubles) is PINNED BY CONSTRUCTION and
    // keeps today's point-in-time copy; a core without a store (fake/embedded)
    // pins the same way.
    const store =
      options.config == null && options.resolved == null ? core.configStore : undefined;
    const profileName = (agentConfig.profileName as string) || resolved.profileName || "default";
    // Profile overlay read PER BUILD (B3): a reader re-resolves the map from
    // the host's live source each time; a static map keeps the old behavior.
    // On the live path the construction-time map goes away when unset: the
    // current generation's profileManager output (resolved.profiles) is read
    // per build, so a profile added after boot lands on the NEXT build.
    const profilesMap =
      typeof options.profiles === "function"
        ? options.profiles()
        : options.profiles ??
          (store ? (resolved as { profiles?: Record<string, SwitchProfile> }).profiles : undefined);
    const profile = profilesMap?.[profileName] || null;
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

    // Tool execution plane: an invalid posture
    // fails the build loudly; a worker plane shares one broker per process
    // and hands the pooled runners the merged tool-config scalars they are
    // not allowed to resolve themselves (the runner never boots the config).
    const plane = toolExecPlaneSettings(resolved);
    // The worker plane's pooled runners are keyed by session, so the plane
    // registers the SESSION_END reaper on the host's hooks (idempotent per
    // hook system; see wireSessionEndReap).
    const toolExecLink =
      plane.mode === "worker"
        ? sharedToolExecBroker({
            fence: plane.fence,
            // The fence posture is a plan-time decision, not a boot pin: what a
            // pool entry enforces is whatever its spawn argv asked for, so the
            // broker follows the file for every plan that lands after a write
            // (an entry already running keeps its kernel fence; the supervisor
            // swaps an entry only when a frame arrives under a different plan,
            // and a call in flight when that happens answers with the loud
            // "replaced" shape rather than a silent re-fence). A host pinned by
            // construction -- one that handed this factory an explicit bag --
            // keeps the scalar it booted with, exactly like every other knob
            // here.
            fencePolicy: store
              ? () =>
                  toolExecPlaneSettings(store.current().resolved as unknown as Record<string, unknown>)
                    .fence
              : plane.fence,
            // The plane's env policy is the resolved one: with scrubbing on,
            // provider keys never enter it; with `envScrubbing: false`, the
            // full copy reaches bash, exactly as `--disable-env-scrubbing`
            // promises. See ToolExecBrokerOptions.envScrubbing.
            envScrubbing: resolved.envScrubbing !== false,
            envScrubExtra: envScrubExtraKeys(baseConfig),
            // Pool tool descriptors: collected HERE, the one site that sees
            // both the loaded extensions and the broker's construction; the
            // broker ships them in its register frame at spawn. An empty
            // list means pool invokes answer the loud "not registered in
            // the runner" error, never a silent fallback.
            toolDescriptors: core.extensions?.wireToolDescriptors?.() ?? [],
          })
        : null;
    if (toolExecLink) wireSessionEndReap(core.hooks, toolExecLink);
    // The maxToolOutputLines config keys are removed (the seam char cap is the
    // binding constraint), but the pooled runner still reqNums the scalar, so
    // the tool's internal line-shaping default is injected AFTER the spread: a
    // stale user key in the raw config bag can never drift the plane away from
    // what the inline tool factories do with the same constant.
    // EXEMPTION E1 (B6a, design §4.3/§5.2): this is the WORKER-PLANE SNAPSHOT.
    // Runners never boot the config, so these scalars are pinned at plane
    // entry, not read live -- a live config write changes NEW POOL ENTRIES
    // ONLY (P3); existing entries keep their spawn-time posture and the
    // broker's drift/keep-pinned behavior (postureDrift in tool-exec-broker.ts)
    // stands exactly as ruled. The INLINE plane is the live one: the
    // core-tools / bash-tool entries hand their tools scalar-or-reader knobs
    // over the store (design §4.1, batch B6a).
    const toolExecConfig: WireToolConfig = {
      bashTool: {
        ...(baseConfig.bashTool as Record<string, unknown> | undefined),
        maxToolOutputLines: INTERNAL_MAX_OUTPUT_LINES,
      },
      coreTools: {
        ...(baseConfig.coreTools as Record<string, unknown> | undefined),
        maxToolOutputLines: INTERNAL_MAX_OUTPUT_LINES,
      },
      envScrubbing: resolved.envScrubbing !== false,
      envScrubExtra: envScrubExtraKeys(baseConfig),
    };

    // Resolved-sourced values the agent needs (the §4.2 bucket ledger). On
    // the pinned path they become own-props of the copied bag exactly as
    // before; on the live path they become the per-agent OVERLAY (build pins)
    // or ride the resolved-aware base unpin -- never re-sourced from the raw
    // bag as an independent second truth.
    const maxIterationsValue = (agentConfig.maxIterations as number) || resolved.maxIterations;
    const maxEmptyRetriesValue =
      (resolved.maxEmptyRetries as number) ??
      (getLayerDefault(CONFIG_SCHEMA.maxEmptyRetries) as number);
    const workspaceRootsPin = (resolved.workspaceRoots as string[]) || [process.cwd()];
    // Carry the resolved deny list through verbatim, including an
    // explicit [] (denylist disabled by config). null means unresolved
    // so ToolExecutor applies the built-in DEFAULT_DENY_PATTERNS.
    const workspaceDenyPin =
      (resolved.workspaceDeny as readonly string[] | undefined) ?? null;
    // Trust pins (P5): agent.ts reads these per request off the config view
    // (getToolDefs); without a pin they would move mid-session, so they ride
    // the overlay. Resolved-first here too (maxToolDifficulty has a cli layer)
    // -- same chain the base would answer, frozen at build.
    const pinFromLive = (k: string): unknown =>
      (resolved as Record<string, unknown>)[k] ?? baseConfig[k];

    // agent.config: the live view on the default path -- overlay own props
    // win, everything else reads store.current() resolved-first at USE time
    // (maxRetries / toolRetryDelay / maxToolResultChars are deliberately NOT
    // overlay pins; the ToolExecutor reads the cap per finalize). Pinned
    // hosts keep the byte-identical point-in-time copy.
    const agentConfigView = store
      ? (liveAgentConfig(store, {
          // profile pin: resolved/profile-derived filter (applyProfile writes
          // land in the same overlay).
          blacklistTools: toolBlacklist ?? undefined,
          // trust pins (P5): stay pinned for the agent's lifetime.
          workspaceRoots: workspaceRootsPin,
          workspaceDeny: workspaceDenyPin,
          sandboxMode: pinFromLive("sandboxMode"),
          maxToolDifficulty: pinFromLive("maxToolDifficulty"),
          defaultMaxToolDifficulty: pinFromLive("defaultMaxToolDifficulty"),
          // loop/exec scalars frozen with the build: the loop reads the ctor
          // field; the overlay keeps the view honest (explicit per-call
          // agentConfig.maxIterations included). Live class: next-session.
          maxIterations: maxIterationsValue,
          maxToolCallsPerIteration: resolved.maxToolCallsPerIteration as number,
          maxEmptyRetries: maxEmptyRetriesValue,
        }) as NonNullable<Agent["config"]>)
      : {
          ...baseConfig,
          blacklistTools: toolBlacklist ?? undefined,
          maxToolCallsPerIteration: resolved.maxToolCallsPerIteration as number,
          maxRetries: resolved.maxRetries as number,
          toolRetryDelay: resolved.toolRetryDelay as number,
          // Schema-default fallback like main.ts's createLlmClient maxRetries:
          // hand-built resolved bags (tests, embedded hosts) stay valid.
          maxEmptyRetries: maxEmptyRetriesValue,
          // Hand-built resolved bags (tests, embedded hosts) fall back to the
          // schema default layer, same posture as maxEmptyRetries above.
          maxToolResultChars:
            (resolved.maxToolResultChars as number) ??
            (getLayerDefault(CONFIG_SCHEMA.maxToolResultChars) as number),
          workspaceRoots: workspaceRootsPin,
          workspaceDeny: workspaceDenyPin,
        };

    const agent = new Agent({
      hooks: core.hooks,
      toolRegistry: core.toolRegistry,
      llmClient: (agentConfig.llmClient as LlmClient | undefined) || options.llmClient,
      model: (agentConfig.model as string) || resolved.model || "",
      maxIterations: maxIterationsValue,
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
      config: agentConfigView,
      sessionId: (agentConfig.sessionId as string) || crypto.randomUUID(),
      abortSignal: (agentConfig.abortSignal as AbortSignal | null | undefined) ?? null,
      toolWhitelist,
      toolExec: plane.mode,
      toolExecLink,
      toolExecConfig,
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
