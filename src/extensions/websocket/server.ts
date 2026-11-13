// WsServer wiring surface. createWsServer composes the pieces that now live
// in sibling modules -- session-registry.ts (SessionRegistry), socket.ts
// (socket type), constants.ts (bounds), replay.ts (history replay), resume.ts
// (adoption + held questions), attach.ts (attach flows), message-routing.ts
// (routeMessage) -- and owns the handlers the host server feeds: onUpgrade,
// onMessage, onClose, plus the TaskManager/question-bridge hookup.
// Originally a single 2,440-line file; this path keeps createWsServer,
// CreateWsServerOptions, and WsServer.

import { HOOKS } from "@core/hooks.ts";
import { buildTaskConfigOptions, type AgentLike } from "@core/session/index.ts";
import { createTurnLanes } from "@core/session/turn-lanes.ts";
import type { SwitchProfile } from "@core/config/profiles.ts";
import { canonEqual, registerConfigApplyHook, type ConfigApplyContext } from "@core/config/apply-hooks.ts";
import type { LlmClient } from "@core/llm-client/client.ts";
import {
  buildProviderModels,
  fetchRemoteModelsOutcome,
  type ModelConfig,
  type ProviderDef,
} from "@core/config/providers.ts";
import { S2C, taskActivityMessage, C2SMessage } from "./protocol.ts";
import { taskActivityWithPosture, taskWire } from "./wire-messages.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import type { TaskObserverEvent } from "@core/session/task-types.ts";
import { registerTaskManagerService } from "../subagents/index.ts";
import { WebSocketQuestionBridge, type QuestionStrategy } from "./question-input.ts";
import type { AuthMiddleware } from "./auth.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createAgentFactory } from "@core/agent-factory.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { resolveSttTarget } from "@core/config/stt.ts";
import { SessionRegistry } from "./session-registry.ts";
import { attachResumedSession, attachToMostRecentSession, fallbackAttach } from "./attach.ts";
import { createAndAttachSession, parseResumeParams, resumedHeldQuestions } from "./resume.ts";
import { routeMessage } from "./message-routing.ts";
import type { HotdogServerSocket } from "./socket.ts";

/** Junk guard for a reassigned numeric client field (the file/write gate is
 *  the bounds gate; this only refuses non-numbers reaching the client). */
const finiteNumber = (name: string, v: unknown): number => {
  if (typeof v !== "number" || !Number.isFinite(v)) {
    throw new Error(`invalid ${name} ${JSON.stringify(v)}`);
  }
  return v;
};

/** Redacted host of an endpoint value -- NEVER the full URL, path/query can
 *  carry tokens (§5.2 audit doctrine: endpoint/credential line, redacted host
 *  only, never value bytes). */
const hostOnly = (v: unknown): string => {
  if (typeof v !== "string" || v === "") return "(endpoint unset)";
  try {
    return new URL(v).host;
  } catch {
    return "(endpoint not a URL)";
  }
};

/**
 * The §3.3 shared-LlmClient row: IN-PLACE public-field reassignment on the
 * ONE shared client object. The rebuild branch is REJECTED (§3.3): the three
 * boot holders -- the server.ts variable, the agent factory's
 * options.llmClient (the path EVERY new agent takes, agent-factory.ts:133),
 * and the SessionRegistry option -- all keep the same object, so a rebuilt
 * reference would re-point at most one of them while the reply claimed live.
 * Fields are public (client.ts:147-156) and every request re-reads them
 * (client.ts:236-245): a request already sent finishes with the body it
 * built, the NEXT attempt reads the new fields.
 *
 * keyPath = the RESOLVED-bag root (the name the client consumes), so the
 * hook fires through every file spelling that moves the resolution chain
 * (`aiUrl` -> resolved `baseUrl`, `chatTimeoutSecs` -> resolved
 * `chatTimeout`, ...). The apply reads the live generation itself.
 */
const CLIENT_LIVE_FIELDS: ReadonlyArray<{
  keyPath: string;
  /** Reassigns the client's field from the resolved value; returns the
   *  audit summary (secret-free by construction -- never value bytes). */
  apply: (client: LlmClient, value: unknown) => string;
}> = [
  {
    keyPath: "baseUrl",
    apply: (c, v) => {
      c.baseUrl = typeof v === "string" && v !== "" ? v : null;
      return `endpoint changed -> ${hostOnly(v)} (host redacted; value not shown)`;
    },
  },
  {
    keyPath: "apiKey",
    apply: (c, v) => {
      c.apiKey = typeof v === "string" && v !== "" ? v : null;
      return "endpoint credential replaced (value not shown)";
    },
  },
  {
    keyPath: "chatTimeout",
    apply: (c, v) => {
      c.chatTimeoutSecs = finiteNumber("resolved.chatTimeout", v);
      return `chat timeout now ${c.chatTimeoutSecs}s`;
    },
  },
  {
    keyPath: "healthCheckTimeout",
    apply: (c, v) => {
      c.healthCheckTimeoutSecs = finiteNumber("resolved.healthCheckTimeout", v);
      return `health-check timeout now ${c.healthCheckTimeoutSecs}s`;
    },
  },
  {
    keyPath: "streamIdleTimeout",
    apply: (c, v) => {
      c.streamIdleTimeoutSecs = finiteNumber("resolved.streamIdleTimeout", v);
      return `stream-idle watchdog now ${c.streamIdleTimeoutSecs}s`;
    },
  },
  {
    keyPath: "maxRetries",
    apply: (c, v) => {
      c.maxRetries = finiteNumber("resolved.maxRetries", v);
      return `max retries now ${c.maxRetries}`;
    },
  },
  {
    keyPath: "modelWireFormat",
    apply: (c, v) => {
      c.defaultWireFormat = typeof v === "string" && v !== "" ? v : undefined;
      return `default wire format now ${c.defaultWireFormat ?? "(unset)"}`;
    },
  },
  {
    keyPath: "modelRoleMapping",
    apply: (c, v) => {
      c.defaultRoleMapping = typeof v === "string" && v !== "" ? v : undefined;
      return `default role mapping now ${c.defaultRoleMapping ?? "(unset)"}`;
    },
  },
];

export interface CreateWsServerOptions {
  buildAgent?: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  sessionTimeoutMin?: number;
  questionTimeoutSecs?: number;
  questionStrategy?: string;
  auth?: AuthMiddleware;
  profiles?: Record<string, SwitchProfile>;
}

export interface WsServer {
  sessionRegistry: SessionRegistry;
  /** The ONE shared LlmClient this server's factory and registry hold -- the
   *  object the §3.3 live fields are reassigned IN PLACE on. Exposed so an
   *  embedder (and the §9 agent-plane probe) observes exactly what the agents
   *  observe; it is not a second client. */
  llmClient: LlmClient;
  onUpgrade: (
    req: { url: string; headers?: Record<string, string> },
    ws: HotdogServerSocket<unknown>,
  ) => void;
  onMessage: (ws: HotdogServerSocket<unknown>, raw: string | Buffer) => void;
  onClose: (ws: HotdogServerSocket<unknown>) => void;
  startCleanupLoop: () => void;
  stopCleanupLoop: () => void;
  /** SIGTERM commit-point drain: wait (bounded) for in-flight turns to
   *  settle, then interrupt stragglers -- exit at a commit point, not mid-write. */
  drainSessions: (timeoutMs?: number) => Promise<void>;
  /** Release the TaskManager's provider-health sweep timer, if a TaskManager was built. */
  stopTaskManager: () => void;
}

export function createWsServer(
  core: CoreContext,
  options: CreateWsServerOptions = {},
): WsServer {
  const {
    buildAgent: customBuildAgent,
    sessionTimeoutMin = 30,
    questionTimeoutSecs = 300,
    questionStrategy = "wait",
    auth,
    profiles,
  } = options;

  const sharedLlmClient = core.createLlmClient();

  // Speech-to-text: explicit sttUrl, else auto-pick an audio-capable model
  // from the registry (its provider supplies URL + key, like show-me's
  // image models). Null = disabled; the webui hides its mic affordance from
  // the sttEnabled flag on the sessionCreated payload.
  const sttTarget = resolveSttTarget(core.resolved, sharedLlmClient);

  // Profile overlays read PER BUILD through the live surface (B3): the map
  // behind core.resolved.profileManager re-derives at each agent build, so a
  // profile added after boot lands on the NEXT build. The host-passed boot
  // snapshot stays the fallback for hosts without a manager (mock cores,
  // embedded embedders); webui's own map comes from this same manager.
  const profilesForBuild = (): Record<string, SwitchProfile> =>
    core.resolved?.profileManager?.getProfilesForSwitch() ?? profiles ?? {};

  const buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike> =
    customBuildAgent ??
    createAgentFactory(core, { profiles: profilesForBuild, llmClient: sharedLlmClient });

  // Question tool integration: the bridge resolves pending question-tool
  // calls when a client answers. Declared before the registry so the
  // onSessionDeleted callback can reference it (called lazily).
  let bridge: WebSocketQuestionBridge | null = null;

  // Webui turns must queue on the provider lane like everything else. The ws
  // registry builds its SessionManager without taskConfig (its TaskManager
  // lives here), so hand the lanes in explicitly: same caps, same ledger,
  // same raw-config source the CLI's SessionManager uses.
  const resolvedCore = core.resolved;
  const turnLanes = resolvedCore
    ? createTurnLanes({
        lanesDir: resolvedCore.taskLanesDir ?? null,
        lanesPerProvider: resolvedCore.taskLanesPerProvider,
        providerDefs:
          (core.config?.providers as { name: string; taskLanes?: unknown }[] | undefined) ?? [],
      })
    : undefined;

  const registry = new SessionRegistry({
    buildAgent,
    llmClient: sharedLlmClient,
    // No question defaults here: they resolve at question-armed time below,
    // so a session row never freezes a copy of them (B3).
    sessionTimeoutMin,
    profiles,
    sttTarget,
    turnLanes,
    // Posture strip source: a READER over the live resolved plane, consulted
    // per payload -- the strip follows store.current() instead of holding the
    // boot bag reference (B3).
    toolExecResolved: () => (core.resolved as Record<string, unknown> | undefined) ?? {},
    onSessionDeleted: (sid) => {
      // Drop the hold FIRST: dropSession cancels the pending question, and
      // the resolve callback checks resumedHeldQuestions before touching the
      // (now deleted) session's agent or bus.
      resumedHeldQuestions.delete(sid);
      bridge?.dropSession(sid);
    },
  });

  // Subagent tasks for webui/ws sessions: the registry's SessionManager is built without taskConfig,
  // so the TaskManager lives here. Publishing it as the taskManager service lets delegate_task
  // resolve lazily; the observer relays spawn/status/activity to every connected client --
  // the webui subagent feed consumes it, and nothing reaches the main chat transcript.
  // Hoisted so the returned stopTaskManager() can reach it (null when no registry).
  let taskManager: TaskManager | null = null;
  if (resolvedCore?.modelRegistry) {
    const tm = new TaskManager({
      ...buildTaskConfigOptions(resolvedCore),
      buildAgent: buildAgent as (config: Record<string, unknown>) => Promise<AgentLike>,
      modelRegistry: resolvedCore.modelRegistry,
      config: core.config,
      // Placement reads modelGroups through the live config accessor (B3):
      // placement N+1 after a swap sees the new member set.
      getModelGroups: () =>
        ((core.config as Record<string, unknown> | undefined)?.modelGroups as
          | Record<string, string[]>
          | undefined) ?? {},
      profileManager: resolvedCore.profileManager,
      sessionManager: registry.getSessionManager(),
      // A follow-up on a session blocked in a question becomes its answer.
      resolvePendingQuestion: (sid, text) => bridge?.answerWithText(sid, text) ?? false,
    });
    taskManager = tm;
    // Hand-built mock cores (tests, embedded hosts) may carry no service
    // registry; the relay still works, only delegate_task lookup is skipped.
    if (core.services) registerTaskManagerService(core, tm);
    registry.setTaskManager(tm);
    tm.setObserver((ev: TaskObserverEvent) => {
      if (ev.kind === "task") {
        if (ev.task.sessionId) {
          registry.broadcastScoped(ev.task.sessionId, {
            type: S2C.TASK_UPDATE,
            // Wire-mapped beside the snapshot idiom (agentLogPath rides).
            task: taskWire(ev.task),
          });
        }
        // A terminal task has no live turn left to resolve its pending
        // question; drop the stale entry so it cannot replay on reconnect or
        // swallow a later answer. Keyed on the WORKER's session: the pending
        // is registered there, and the delegating session may carry its own
        // live question that must not be cancelled.
        const terminal =
          ev.task.status === "cancelled" ||
          ev.task.status === "failed" ||
          ev.task.status === "completed";
        if (terminal) {
          const sid = tm.getTaskAgentSession(ev.task.taskId);
          if (sid && bridge && bridge.hasPending(sid)) bridge.cancel(sid);
        }
        return;
      }
      const activityMsg = taskActivityMessage(ev.taskId, ev.event);
      if (!activityMsg) return;
      // Posture parity (owner ruling 2026-11-13): the display-DSL
      // descriptors the session TOOL_CALL frames carry ride here too,
      // resolved from the worker agent's own tool registry -- so the
      // subagent transcript's ToolBlocks reach the identical read-box /
      // inline-diff / code-block postures. Enriched BEFORE buffering, so
      // live delivery and taskActivityHistory replay carry the same bytes.
      activityMsg.activity = taskActivityWithPosture(
        activityMsg.activity,
        ev.event,
        (toolName) => tm.getTaskToolMetadata(ev.taskId, toolName),
      );
      // Buffer always for replay (the reset sentinel trims instead of
      // storing; see recordTaskActivity); live delivery only to the owning
      // session (orphan tasks belong to no tab).
      registry.recordTaskActivity(ev.taskId, activityMsg.activity);
      const owner = tm.getTaskSession(ev.taskId);
      if (owner) registry.broadcastScoped(owner, activityMsg);
    });
  }

  bridge = new WebSocketQuestionBridge({
    // Question defaults resolve at QUESTION-ARMED time (this callback runs
    // once per ask, before the timer is armed): the live websocket block
    // answers, so a swap changes the NEXT armed question while an in-flight
    // one keeps its armed timer (P8's benign twin -- that IS the B3 posture).
    // The createWsServer options stay as the host hint for cores with no
    // websocket block (hand-built mocks).
    getPolicy: (sid) => {
      const meta = registry.get(sid)?.metadata;
      const ws = (core.config?.websocket ?? {}) as Record<string, unknown>;
      const strategy = (ws.questionStrategy as string | undefined) ?? questionStrategy;
      const timeoutSecs =
        (ws.questionTimeoutSecs as number | undefined) ?? questionTimeoutSecs;
      return {
        strategy: (meta?.questionStrategy || strategy) as QuestionStrategy,
        timeoutSecs: meta?.questionTimeoutSecs || timeoutSecs,
      };
    },
    hasChannels: (sid) => registry.hasChannels(sid),
    interrupt: (sid) => registry.getSessionManager().interrupt(sid),
    // Task-host lane handoff: the worker yields its lane slot while a
    // question is pending, back on settle.
    // Sidebar badge: mirror the pending flag onto the registry row and
    // rebroadcast the sessions list (the sidebar-refresh idiom) so every
    // tab's card swaps its status glyph to the question hook.
    onQuestionAsked: (sid, qs) => {
      taskManager?.onTaskQuestionAsked(sid, qs);
      if (registry.setQuestionPending(sid, true)) {
        registry.broadcast({ type: S2C.SESSIONS, sessions: registry.list() });
      }
    },
    onQuestionSettled: (sid) => {
      taskManager?.onTaskQuestionSettled(sid);
      if (registry.setQuestionPending(sid, false)) {
        registry.broadcast({ type: S2C.SESSIONS, sessions: registry.list() });
      }
    },
  });

  // ── Config-live apply hooks (B4, design §3.3) ─────────────────────────────
  // Registered once, at this host's create(). Load order: createCore already
  // put the core-side hookTrace row in the table before any extension
  // loaded, so core hooks run before these extension rows (registration
  // order = run order). The unregister closures are deliberately not
  // surfaced: the WsServer has no per-object teardown today (webui stops the
  // cleanup loop and the TaskManager only) -- B8's auth seam introduces the
  // lifecycle that needs them; see b4-notes.
  registerConfigApplyHook({
    keyPath: "websocket.sessionTimeoutMin",
    phase: "apply",
    handle: (ctx) => {
      // The extension block lives in the config bag; the re-resolve applied
      // the schema defaults, so a present-but-invalid value is a real bug
      // (throw -> degraded, the old age keeps running).
      const block = (ctx.store.current().config as Record<string, unknown>)
        .websocket as Record<string, unknown> | undefined;
      const v = block?.sessionTimeoutMin;
      if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) {
        throw new Error(`invalid websocket.sessionTimeoutMin ${JSON.stringify(v)}`);
      }
      // Already-idempotent re-arm (session-registry.ts:689-696): one 60s
      // ticker, the age read per tick; #timeoutMin moves immediately, the
      // eviction itself lands on the next tick.
      registry.startCleanupLoop(v);
      ctx.notice(
        `websocket.sessionTimeoutMin: idle-session age is now ${v} min; the cleanup sweep ticks every 60s, so the effect lands on the next tick`,
      );
    },
  });

  registerConfigApplyHook({
    keyPath: "providerHealthCheckIntervalSecs",
    phase: "apply",
    handle: (ctx) => {
      const health = taskManager?.providerHealth ?? null;
      if (!health) {
        throw new Error("no provider-health registry on this host (TaskManager was never built)");
      }
      const v = ctx.store.current().resolved?.providerHealthCheckIntervalSecs;
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
        throw new Error(`invalid providerHealthCheckIntervalSecs ${JSON.stringify(v)}`);
      }
      health.setIntervalSecs(v); // stop + recreate; 0 disables; failure-driven demotion untouched
      ctx.notice(
        v > 0
          ? `providerHealthCheckIntervalSecs: health sweep re-armed every ${v}s (live next interval; failure-driven demotion unchanged)`
          : "providerHealthCheckIntervalSecs: health sweep timer disabled (0); failure-driven demotion stays active",
      );
    },
  });

  for (const field of CLIENT_LIVE_FIELDS) {
    registerConfigApplyHook({
      keyPath: field.keyPath,
      phase: "apply",
      handle: (ctx) => {
        const resolved = ctx.store.current().resolved as Record<string, unknown> | undefined;
        const summary = field.apply(sharedLlmClient, resolved?.[field.keyPath]);
        ctx.notice(`${field.keyPath}: ${summary} (live on the shared client from the next request attempt)`);
      },
    });
  }

  // ── Provider list: shared-client re-point + model-catalog refresh ────────
  // The `providers` root fires for every write under it (card edits, the list
  // ops, a `providers[2].url` REPLACE), so the value-changed guard is the hook
  // itself: an unchanged list does nothing at all, no network, no notice.
  //
  // Two halves, deliberately different in failure posture:
  //  1. the SHARED CLIENT re-point -- synchronous, cannot fail, and the part
  //     the agents actually use. `sharedLlmClient.providers` is reassigned in
  //     place on the one object the agent factory and the session registry
  //     both hold, and every request re-reads its fields, so the NEXT attempt
  //     resolves against the new list (a request already sent finishes with
  //     the body it built).
  //  2. the MODEL CATALOG -- awaited here under an explicit timeout, because a
  //     catalog read is a network call and this transaction holds the panel's
  //     own reply. A dead endpoint therefore reports degraded while the store
  //     stays on the new value (a failed apply never re-swaps); the periodic
  //     health sweep retries on its own schedule. The entries land as an UPSERT
  //     into the registry object the store carries -- the same piggyback the
  //     sweep uses, never a replacement: live sessions, locked placements and
  //     the profile manager all hold that object's identity.
  //
  // What this does NOT rebuild is the sweep's PROBE SET: the health registry
  // snapshot of provider definitions is taken once at construction, so a
  // provider added or removed here is invisible to the sweep until restart. The
  // notice says exactly that rather than implying full coverage.
  registerConfigApplyHook({
    keyPath: "providers",
    phase: "apply",
    timeoutMs: 12_000,
    handle: async (ctx, previous, next) => {
      if (canonEqual(previous, next)) return; // root match with no list change
      const generation = ctx.store.current();
      // `providers` is a config-bag passthrough key: the resolution chain reads
      // it to build the registry but never copies it into the resolved bag, so
      // the file's array -- not `resolved.providers` -- is the authority here.
      // (Reading the wrong bag would blank the client's list on every write.)
      const providers =
        (((generation.config as Record<string, unknown>)?.providers as ProviderDef[] | undefined) ??
          ((generation.resolved as Record<string, unknown>)?.providers as ProviderDef[] | undefined) ??
          []);
      sharedLlmClient.providers = providers;

      const resolved = generation.resolved as Record<string, unknown> | undefined;
      const registry = resolved?.modelRegistry as Record<string, ModelConfig> | undefined;
      const contextLimit = resolved?.contextLimit as number | undefined;
      const globals = {
        baseUrl: resolved?.baseUrl as string | undefined,
        apiKey: resolved?.apiKey as string | undefined,
      };
      const fetchers = providers
        .filter((p) => p.fetchModels && registry)
        .map(async (p) => {
          const baseUrl = p.url || globals.baseUrl;
          if (!baseUrl) return; // no endpoint to read: the static models stand
          const outcome = await fetchRemoteModelsOutcome(baseUrl, p.apiKey || globals.apiKey);
          if (!outcome.reachable) {
            throw new Error(
              `provider "${p.name}" catalog unreadable at ${hostOnly(baseUrl)} (${outcome.reason ?? "unreachable"})`,
            );
          }
          Object.assign(registry!, await buildProviderModels(p, contextLimit ?? 0, globals, outcome.entries));
        });
      // Concurrent, same doctrine as the boot build and the sweep: a dead
      // backend costs one timeout, not one per provider.
      const settled = await Promise.allSettled(fetchers);
      const failures = settled
        .filter((s): s is PromiseRejectedResult => s.status === "rejected")
        .map((s) => formatError(s.reason));

      ctx.notice(
        `providers: list re-pointed on the shared client (${providers.length} entries; live on the next request attempt), ` +
          (failures.length === 0
            ? `model catalog refreshed${registry ? " into the live registry" : ""}; probe set: restart-bound -- the health sweep keeps the provider set it built with until restart`
            : `model catalog INCOMPLETE (${failures.join("; ")}); the health sweep retries, and previously catalogued models stay as they were; probe set: restart-bound -- the health sweep keeps the provider set it built with until restart`),
      );
      if (failures.length > 0) {
        // Report the degradation to the reply after the notice above has said
        // precisely what did and did not move.
        throw new Error(
          `${failures.length} provider catalog(s) unreadable; the list is live, the catalog is not: ${failures.join("; ")}`,
        );
      }
    },
  });

  // ── Speech-to-text target rebuild ────────────────────────────────────────
  // The boot resolve lives once in this closure today; these rows re-run it
  // against the swapped resolved bag so the NEXT dictation upload (and the next
  // attach's sttEnabled flag) follows the file. An upload already in flight
  // keeps the target it read when it started: the transcribe handler grabs the
  // field once per request, which is the same next-use posture every other row
  // in this host ships.
  const applySttRebuild = (ctx: ConfigApplyContext, summary: string): void => {
    const resolved = ctx.store.current().resolved as Record<string, unknown> | undefined;
    const next = resolveSttTarget(
      resolved as unknown as Parameters<typeof resolveSttTarget>[0],
      sharedLlmClient,
    );
    const enabledFlipped = registry.setSttTarget(next);
    if (enabledFlipped) {
      // The mic affordance is the one part of this a client renders, and the
      // flag is SERVER-wide (unlike the toolExec posture, which is per session
      // because `/fence` is per session), so every live session's sockets get
      // the frame. Same sessionState channel and frame shape as the fence
      // push; the client echo lives in webui/ui/chat.ts.
      for (const row of registry.list()) {
        registry.broadcastScoped(row.id, {
          type: S2C.SESSION_STATE,
          sessionId: row.id,
          key: "sttEnabled",
          value: registry.sttEnabled,
        });
      }
    }
    ctx.notice(
      `${summary}; new sessions advertise sttEnabled=${registry.sttEnabled}` +
        (enabledFlipped
          ? ` and every connected client was pushed the sessionState flip (an upload already in flight keeps the target it started with)`
          : ` (the mic affordance does not move: enabledness is unchanged)`),
    );
  };

  registerConfigApplyHook({
    keyPath: "sttUrl",
    phase: "apply",
    handle: (ctx, previous, next) => {
      if (canonEqual(previous, next)) return;
      applySttRebuild(
        ctx,
        // The line names only the host:port a parse of the URL yields; the
        // full value (path, query, any userinfo) never reaches a log.
        `sttUrl: transcription endpoint now ${hostOnly(next)} (host:port only, value not shown)`,
      );
    },
  });

  registerConfigApplyHook({
    keyPath: "sttModel",
    phase: "apply",
    handle: (ctx, previous, next) => {
      if (canonEqual(previous, next)) return;
      applySttRebuild(
        ctx,
        `sttModel: transcription model selection now ${JSON.stringify(next ?? null)} (registry-resolved; no credential involved)`,
      );
    },
  });

  // ── Tool-exec plane: the two file keys whose reach is decided by physics ─
  // A pool entry's isolation IS its spawn argv, so no hook can retro-fit a
  // running entry: the new posture is what the next spawn gets (the broker
  // reads the plan-time posture off the live store through its fence reader),
  // an entry that is already up keeps the fence it was born with, and an
  // invoke in flight keeps the fence the frame it was sent under carried.
  // The attestation therefore claims the new-entry class, and what this row
  // adds is the audit line -- a posture change is a trust change, so it is
  // logged the same way an endpoint or a credential change is.
  registerConfigApplyHook({
    keyPath: "execFence",
    phase: "apply",
    handle: (ctx, previous, next) => {
      if (canonEqual(previous, next)) return;
      ctx.notice(
        `execFence: pool-entry fence posture is now ${JSON.stringify(next)} (was ${JSON.stringify(previous)})` +
          `${ctx.actor ? ` (written by session ${ctx.actor})` : ""} -- entries spawned from here follow it; a running entry keeps its kernel fence, a call already in flight keeps the fence its frame carried, and a per-session /fence override still outranks the file for its own session`,
      );
    },
  });

  registerConfigApplyHook({
    keyPath: "toolExec",
    phase: "apply",
    handle: (ctx, previous, next) => {
      if (canonEqual(previous, next)) return;
      ctx.notice(
        `toolExec: execution plane is now ${JSON.stringify(next)} (was ${JSON.stringify(previous)}) for the next agent build` +
          `${ctx.actor ? ` (written by session ${ctx.actor})` : ""} -- running agents keep the plane they were built on, and worker pool entries drain through the idle reaper and session end`,
      );
    },
  });

  // Give every tool call for WS agents an Input implementation that resolves
  // via the bridge (same pattern as ui-interactive-cli, which sets it
  // unconditionally). Not filtering on toolName here means the approvals
  // extension can reach the human on any tool, not just `question`.
  if (core.hooks && typeof core.hooks.on === "function") {
    core.hooks.on(
      HOOKS.AGENT_TOOL_CONTEXT,
      ({ toolCtx, agent }) => {
        const sessionId = agent?.sessionId;
        if (sessionId) toolCtx.set("input", bridge!.inputFor(sessionId));
      },
      { source: "websocket" },
    );
  }

  function onUpgrade(
    req: { url: string; headers?: Record<string, string> },
    ws: HotdogServerSocket<unknown>,
  ): void {
    const url = new URL(req.url, `http://${req.headers?.host || "localhost"}`);
    const token = url.searchParams.get("token");

    // Reconnect identity (?session=...&cursor=...): parsed up front so both
    // attach sites (no-auth upgrade, post-AUTH) can use it.
    const resumed = parseResumeParams(url);
    if (resumed) {
      ws.resumeSessionId = resumed.sessionId;
      ws.resumeCursor = resumed.cursor;
    }

    // Only register a socket for broadcasts once it is authenticated (or
    // auth is disabled): an unauthenticated socket must not receive
    // broadcast events (e.g. question answers) while it waits to auth.
    if (auth && token) {
      if (!auth.validateToken(token)) {
        ws.send(
          JSON.stringify({
            type: S2C.AUTH_ERROR,
            message: "Invalid or expired token",
          }),
        );
        ws.close(4001, "Invalid token");
        return;
      }
      ws.authToken = token;
      registry.registerConnection(ws);
    } else if (auth && !token) {
      // Socket stays open so the client can still authenticate via a
      // protocol AUTH message; routeMessage() gates everything else.
      // Registration for broadcasts happens on AUTH success. The cleanup
      // loop reaps the socket if AUTH never arrives (see #pendingAuth).
      registry.addPendingAuth(ws);
      ws.send(JSON.stringify({ type: S2C.AUTH_REQUIRED }));
      return;
    } else {
      registry.registerConnection(ws);
    }

    // Reconnect first, then fall back to the historical default. attachStarted
    // (not activeSessionId, which the in-flight attach has not set yet) keeps
    // a token-upgrade client's later AUTH message from firing a second attach.
    if (resumed) {
      ws.attachStarted = true;
      attachResumedSession(
        ws,
        registry,
        bridge!,
        resumed.sessionId,
        resumed.cursor,
        true,
      ).catch((err: unknown) => {
        logger.error(`[websocket] resumed attach failed: ${formatError(err)}`);
        void fallbackAttach(ws, registry, bridge!, "Session resume failed.");
      });
    } else if (registry.size > 0) {
      ws.attachStarted = true;
      void attachToMostRecentSession(ws, registry, bridge!).catch((err: unknown) => {
        logger.error(`[websocket] attach to most recent failed: ${formatError(err)}`);
      });
    } else {
      ws.attachStarted = true;
      createAndAttachSession(ws, registry);
    }
  }

  async function onMessage(
    ws: HotdogServerSocket<unknown>,
    raw: string | Buffer,
  ): Promise<void> {
    let msg: C2SMessage;
    try {
      msg = JSON.parse(
        typeof raw === "string" ? raw : raw.toString(),
      ) as C2SMessage;
    } catch {
      try {
        ws.send(JSON.stringify({ type: S2C.ERROR, message: "Invalid JSON" }));
      } catch {}
      return;
    }

    if (!msg.type) {
      try {
        ws.send(
          JSON.stringify({ type: S2C.ERROR, message: "Message type required" }),
        );
      } catch {}
      return;
    }

    try {
      await routeMessage(ws, msg, registry, auth, bridge!, core);
    } catch (err: unknown) {
      // Don't let errors from dropped connections kill the server.
      const typedErr = err as Error;
      if (
        typedErr.message !== "WebSocket is not open: readyState 2 (CLOSING)" &&
        typedErr.message !== "WebSocket is not open: readyState 3 (CLOSED)"
      ) {
        logger.error(`[websocket] message handling error: ${formatError(typedErr)}`);
      }
    }
  }

  function onClose(ws: HotdogServerSocket<unknown>): void {
    if (ws.activeSessionId && ws.activeChannel) {
      registry.removeChannel(ws.activeSessionId, ws.activeChannel);
      ws.activeChannel.close();
    }
    registry.removePendingAuth(ws);
    registry.unregisterConnection(ws);
  }

  return {
    sessionRegistry: registry,
    llmClient: sharedLlmClient,
    onUpgrade,
    onMessage,
    onClose,
    startCleanupLoop: () => registry.startCleanupLoop(sessionTimeoutMin),
    stopCleanupLoop: () => registry.stopCleanupLoop(),
    drainSessions: (timeoutMs?: number) => registry.drainSessions(timeoutMs),
    stopTaskManager: () => taskManager?.stop(),
  };
}
