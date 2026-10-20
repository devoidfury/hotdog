// WsServer wiring surface. createWsServer composes the pieces that now live
// in sibling modules -- session-registry.ts (SessionRegistry), socket.ts
// (socket type), constants.ts (bounds), replay.ts (history replay), resume.ts
// (adoption + held questions), attach.ts (attach flows), message-routing.ts
// (routeMessage) -- and owns the handlers the host server feeds: onUpgrade,
// onMessage, onClose, plus the TaskManager/question-bridge hookup.
// Originally a single 2,440-line file; this path keeps createWsServer,
// CreateWsServerOptions, and WsServer.

import { HOOKS } from "@core/hooks.ts";
import type { AgentLike } from "@core/session/index.ts";
import { createTurnLanes } from "@core/session/turn-lanes.ts";
import type { SwitchProfile } from "@core/config/profiles.ts";
import { S2C, taskActivityMessage, C2SMessage } from "./protocol.ts";
import { TaskManager, type TaskObserverEvent } from "@core/session/task-manager.ts";
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

  const buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike> =
    customBuildAgent ?? createAgentFactory(core, { profiles, llmClient: sharedLlmClient });

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
    questionTimeoutSecs,
    questionStrategy,
    sessionTimeoutMin,
    profiles,
    sttTarget,
    turnLanes,
    // Posture strip source: the resolved plane keys, read per payload.
    toolExecResolved: (core.resolved as Record<string, unknown> | undefined) ?? {},
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
  // the webui subagents panel consumes it, and nothing reaches the main chat transcript.
  // Hoisted so the returned stopTaskManager() can reach it (null when no registry).
  let taskManager: TaskManager | null = null;
  if (resolvedCore?.modelRegistry) {
    const tm = new TaskManager({
      buildAgent: buildAgent as (config: Record<string, unknown>) => Promise<AgentLike>,
      modelRegistry: resolvedCore.modelRegistry,
      config: core.config,
      maxIterations: resolvedCore.maxIterations,
      taskProfile: resolvedCore.taskProfile || "task-default",
      lanesPerProvider: resolvedCore.taskLanesPerProvider,
      lanesDir: resolvedCore.taskLanesDir ?? null,
      spawnLogPath: resolvedCore.taskSpawnsPath ?? null,
      defaultModel: resolvedCore.model ?? null,
      healthIntervalSecs: resolvedCore.providerHealthCheckIntervalSecs,
      healthCheckTimeoutSecs: resolvedCore.healthCheckTimeout,
      healthContextLimit: resolvedCore.contextLimit,
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
            task: ev.task,
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
      // Buffer always for replay; live delivery only to the owning session
      // (orphan tasks belong to no tab).
      registry.recordTaskActivity(ev.taskId, activityMsg.activity);
      const owner = tm.getTaskSession(ev.taskId);
      if (owner) registry.broadcastScoped(owner, activityMsg);
    });
  }

  bridge = new WebSocketQuestionBridge({
    getPolicy: (sid) => {
      const meta = registry.get(sid)?.metadata;
      return {
        strategy: (meta?.questionStrategy ||
          questionStrategy) as QuestionStrategy,
        timeoutSecs: meta?.questionTimeoutSecs || questionTimeoutSecs,
      };
    },
    hasChannels: (sid) => registry.hasChannels(sid),
    interrupt: (sid) => registry.getSessionManager().interrupt(sid),
    // Task-host lane handoff: the worker yields its lane slot while a
    // question is pending, back on settle.
    onQuestionAsked: (sid, qs) => taskManager?.onTaskQuestionAsked(sid, qs),
    onQuestionSettled: (sid) => taskManager?.onTaskQuestionSettled(sid),
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
    onUpgrade,
    onMessage,
    onClose,
    startCleanupLoop: () => registry.startCleanupLoop(sessionTimeoutMin),
    stopCleanupLoop: () => registry.stopCleanupLoop(),
    drainSessions: (timeoutMs?: number) => registry.drainSessions(timeoutMs),
    stopTaskManager: () => taskManager?.stop(),
  };
}
