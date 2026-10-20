import crypto from "node:crypto";
import { HOOKS, createHooks } from "@core/hooks.ts";
import { SessionManager, type AgentLike } from "@core/session/index.ts";
import { indexSessionModel, getSessionRow } from "@core/session/session-index.ts";
import { createTurnLanes, type TurnLanes } from "@core/session/turn-lanes.ts";
import type { SwitchProfile } from "@core/config/profiles.ts";
import { WebSocketChannel } from "./websocket-channel.ts";
import { C2S, S2C, C2SMessage, wireImages, taskActivityMessage, type TaskActivityWire } from "./protocol.ts";
import { parseUploadedFiles } from "./uploads.ts";
import { DEFAULT_MAX_IMAGE_SIZE } from "@extensions/core-tools/defaults.ts";
import { modelAcceptsImages } from "@core/config/providers.ts";
import { TaskManager, type TaskObserverEvent } from "@core/session/task-manager.ts";
import { registerTaskManagerService } from "../subagents/index.ts";
import { WebSocketQuestionBridge, type QuestionStrategy } from "./question-input.ts";
import type { LlmClient } from "@core/llm-client/client.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { getExtensionConfig } from "@core/extensions/types.ts";
import type { AuthMiddleware } from "./auth.ts";
import { Agent } from "@core/agent.ts";
import { createAgentFactory } from "@core/agent-factory.ts";
import { execFenceDisplay, toolExecModeLabel, sharedToolExecDegraded } from "@core/tool-exec-broker.ts";
import {
  LOG_SOURCE,
  MAX_CONSECUTIVE_AUTO_RESUMES,
  collectDurabilityFacts,
  conversationContent,
  epochEntries,
  epochStartIndex,
  readSessionEntries,
  restoreSessionIntoAgent,
  sessionExists,
  sessionPath,
  listSessionLogs,
  deleteSessionLog,
  type AgentForRestore,
  type LogEntry,
  type PendingQuestion,
} from "@core/session/session-log.ts";
import { Message } from "@core/context/message.ts";
import { formatToolResult } from "@core/extensions/tool-utils.ts";
import { safeCallDisplay, type ToolRegistry } from "@core/extensions/tool-registry.ts";
import type { QuestionDef } from "@core/context/input.ts";
import { AgentError, formatError } from "@core/error.ts";
import { parseForkArg } from "@core/command-handlers.ts";
import { completionPrefix, parseCompletionContext } from "@core/completion.ts";
import { logger } from "@utils/logger.ts";
import { splitFileIncludes, toolContentText, wrapperContentText } from "@utils/tool-content.ts";
import { transcribeAudio } from "@utils/stt.ts";
import { resolveSttTarget, type SttTarget } from "@core/config/stt.ts";

/** Activity-replay ring bounds (see SessionRegistry.recordTaskActivity). */
const MAX_TASK_ACTIVITY_HISTORY_ITEMS = 300;
const MAX_TASK_ACTIVITY_HISTORY_TASKS = 50;

interface SessionMetadata {
  profile: string;
  /**
   * Explicit session name, independent of the active profile. null means the
   * display name follows `profile`; an explicit title survives profile
   * switches.
   */
  title: string | null;
  model: string;
  createdAt: number;
  lastActivityAt: number;
  connectedClients: number;
  questionStrategy: string;
  questionTimeoutSecs: number;
  userMessageCount: number;
}

interface CreateSessionOptions {
  profile?: string;
  model?: string;
  questionStrategy?: string;
  questionTimeoutSecs?: number;
  /** Adopt an existing session id (cold-log resume keeps its identity). */
  sessionId?: string;
}

interface SwitchProfileOptions {
  sessionId: string;
  profileName: string;
}

interface SessionRegistryOptions {
  buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  llmClient?: LlmClient;
  questionTimeoutSecs?: number;
  questionStrategy?: string;
  sessionTimeoutMin?: number;
  profiles?: Record<string, SwitchProfile>;
  /** Resolved STT backend (explicit sttUrl or audio-capable registry model); advertised as sttEnabled. */
  sttTarget?: SttTarget | null;
  /** Invoked when a session is deleted (cancels its pending questions). */
  onSessionDeleted?: (sessionId: string) => void;
  /**
   * Resolved bag the tool-exec plane posture is read from. Omitted
   * = inline (unfenced): a registry built without it advertises no plane.
   */
  toolExecResolved?: Record<string, unknown>;
  /** Provider-lane coordinator for session turns. Without it webui turns
   *  run uncoordinated: two live sessions double up requests on one backend
   *  instead of queueing on the lane. */
  turnLanes?: TurnLanes;
}

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

export type HotdogServerSocket<T = undefined> = Bun.ServerWebSocket<T> & {
  activeSessionId?: string;
  activeChannel?: WebSocketChannel;
  authToken?: string;
  /** Reconnect identity from the upgrade URL (?session=...&cursor=...): the
   *  session the client was on, plus its replay position (full log length at
   *  the last attach -- an append-only coordinate, stable across RESETs). */
  resumeSessionId?: string;
  resumeCursor?: number;
  /** True once an implicit attach has been started for this socket. The
   *  post-AUTH attach site must not fire its own while the upgrade-site
   *  attach is in flight: activeSessionId is only set once the attach's
   *  first awaits settle, so it cannot gate the race (a token-upgrade client
   *  that also sends AUTH would otherwise get two attach bursts). Never
   *  cleared: a socket takes at most one implicit attach; later switches
   *  are explicit (SWITCH_SESSION). */
  attachStarted?: boolean;
};

// How long a socket that never authenticates is kept before the cleanup
// loop closes it. Comfortably longer than a legit AUTH round-trip (first
// message after open), short enough that anonymous sockets do not pile up.
const PENDING_AUTH_TIMEOUT_MS = 30_000;

// Idle-cleanup grace: this many recently-active, client-free sessions stay
// hot past the idle timeout ("what was I doing" window); the rest go cold.
const MAX_HOT_IDLE_SESSIONS = 3;

// SIGTERM drain bounds: 10s for a turn to reach its commit point, then
// interrupt and 2s for the unwind. Fits well inside systemd's default
// TimeoutStopSec (90s); a longer generation is cut, never half-persisted.
const DRAIN_TIMEOUT_MS = 10_000;
const DRAIN_POLL_MS = 100;
const DRAIN_SETTLE_MS = 2_000;

// Cap for client-supplied completion input; nothing legit needs more.
const MAX_COMPLETE_LINE = 10_000;

/**
 * Transport frame bound for upgraded sockets -- enforced on the `websocket:`
 * handler of the host's Bun.serve (see webui/server.ts, which applies it;
 * Bun quirk: a root-level maxPayloadLength is ignored in 1.4.2). The biggest
 * legitimate frame is a webui upload: one 10 MB image (core-tools/defaults)
 * riding base64 on a C2S send (~4/3 expansion) plus its JSON envelope. The
 * value sits just above that so the app-level parsers stay the last line of
 * defense, and stays under Bun's 16 MiB default (a genuine tightening).
 * Exported so app-level upload caps stay derived from it (no drift).
 */
export const WS_MAX_PAYLOAD_BYTES = 4 * Math.ceil(DEFAULT_MAX_IMAGE_SIZE / 3) + 1024 * 1024;

// Ceiling on one transcribe upload. It USED to mirror OpenAI's whisper 25MB
// limit -- unreachable: audio rides the same WS frames as image uploads, and
// a 25 MB blob base64's past WS_MAX_PAYLOAD_BYTES, so the socket closed at
// the transport instead of answering with the app-level "audio too large".
// Now derived from the frame bound: 10 MiB audio base64's to exactly the
// frame bound minus its 1 MiB envelope headroom (same shape as an image
// upload), so any recording the transport can carry at all gets the explicit
// app-level rejection; a recording so large its FRAME exceeds the bound dies
// at the socket like any oversized frame (chunked uploads are out of scope).
// Checked against the base64 string length before decoding, so an oversized
// blob never costs a decode.
export const MAX_TRANSCRIBE_AUDIO_BYTES = 10 * 1024 * 1024;
/** @internal Exposed for testing (bound-alignment pin against the frame cap). */
export const MAX_TRANSCRIBE_BASE64_CHARS = Math.ceil(MAX_TRANSCRIBE_AUDIO_BYTES / 3) * 4;

export class SessionRegistry {
  #sessionManager: SessionManager;
  #buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  #questionTimeoutSecs: number;
  #questionStrategy: string;
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;
  #timeoutMin: number;
  #allConnections = new Set<HotdogServerSocket<unknown>>();
  // Sockets that opened without a validated token and are waiting on the
  // protocol AUTH handshake (webui upgrades arrive unauthenticated). The
  // cleanup loop reaps these: without it a client could hold an anonymous
  // socket open forever.
  #pendingAuth = new Map<HotdogServerSocket<unknown>, number>();
  #metadata: Map<string, SessionMetadata>;
  #channels: Map<string, Set<WebSocketChannel>>;
  #profiles: Record<string, SwitchProfile>;
  #onSessionDeleted: ((sessionId: string) => void) | null;
  #taskManager: TaskManager | null = null;
  #taskActivityHistory = new Map<string, TaskActivityWire[]>();
  /** Resolved STT backend; every sessionCreated payload advertises its presence as sttEnabled. */
  readonly sttTarget: SttTarget | null;
  #toolExecResolved: Record<string, unknown>;

  get sttEnabled(): boolean {
    return this.sttTarget !== null;
  }

  /**
   * Tool-exec plane posture for the webui status strip. Read per
   * payload so the degraded flag is current at attach time; a strip that went
   * stale mid-session refreshes on the next attach or session switch.
   */
  get toolExecLabel(): string {
    return toolExecModeLabel(
      this.#toolExecResolved,
      sharedToolExecDegraded(),
      execFenceDisplay(this.#toolExecResolved),
    );
  }

  /** Publish the TaskManager whose observer feeds the webui subagents panel. */
  setTaskManager(taskManager: TaskManager | null): void {
    this.#taskManager = taskManager;
  }

  getTaskManager(): TaskManager | null {
    return this.#taskManager;
  }

  /** Send to sockets whose active session is `sessionId`: task traffic never crosses sessions. */
  broadcastScoped(sessionId: string, msg: Record<string, unknown>): void {
    if (!sessionId) return;
    for (const ws of this.#allConnections) {
      if (ws.activeSessionId === sessionId) SessionRegistry.sendSafe(ws, msg);
    }
  }

  /** Buffer activity for reconnect replay (C2S TASK_ACTIVITY_REQUEST).
   * Bounded: items per task, tasks per server (oldest-inserted evicted). */
  recordTaskActivity(taskId: string, activity: TaskActivityWire): void {
    let items = this.#taskActivityHistory.get(taskId);
    if (!items) {
      items = [];
      this.#taskActivityHistory.set(taskId, items);
      while (this.#taskActivityHistory.size > MAX_TASK_ACTIVITY_HISTORY_TASKS) {
        const oldest = this.#taskActivityHistory.keys().next().value as string;
        this.#taskActivityHistory.delete(oldest);
      }
    }
    items.push(activity);
    if (items.length > MAX_TASK_ACTIVITY_HISTORY_ITEMS) {
      items.splice(0, items.length - MAX_TASK_ACTIVITY_HISTORY_ITEMS);
    }
  }

  getTaskActivityHistory(taskId: string): TaskActivityWire[] {
    return this.#taskActivityHistory.get(taskId) ?? [];
  }

  /** Current subagent task snapshot for one socket (sent when it attaches to a session). */
  sendTaskSnapshot(ws: HotdogServerSocket<unknown>): void {
    const sessionId = ws.activeSessionId;
    if (!sessionId || !this.#taskManager) return;
    SessionRegistry.sendSafe(ws, {
      type: S2C.TASK_LIST,
      tasks: this.#taskManager.listTasks().filter((t) => t.sessionId === sessionId),
    });
  }

  constructor({
    buildAgent,
    llmClient,
    questionTimeoutSecs = 300,
    questionStrategy = "wait",
    sessionTimeoutMin = 30,
    profiles = {},
    sttTarget = null,
    onSessionDeleted,
    turnLanes,
    toolExecResolved = {},
  }: SessionRegistryOptions) {
    this.#buildAgent = buildAgent;
    this.#questionTimeoutSecs = questionTimeoutSecs;
    this.#questionStrategy = questionStrategy;
    this.#timeoutMin = sessionTimeoutMin;
    this.sttTarget = sttTarget;
    this.#toolExecResolved = toolExecResolved;
    this.#metadata = new Map();
    this.#channels = new Map();
    this.#profiles = profiles;
    this.#onSessionDeleted = onSessionDeleted ?? null;

    this.#sessionManager = new SessionManager({
      hooks: createHooks(),
      extensions: null,
      buildAgent: buildAgent as (
        config: Record<string, unknown>,
      ) => Promise<AgentLike>,
      llmClient: llmClient,
      turnLanes,
    });
  }

  registerConnection(ws: HotdogServerSocket<unknown>): void {
    this.#allConnections.add(ws);
  }

  unregisterConnection(ws: HotdogServerSocket<unknown>): void {
    this.#allConnections.delete(ws);
  }

  addPendingAuth(ws: HotdogServerSocket<unknown>): void {
    this.#pendingAuth.set(ws, Date.now());
  }

  removePendingAuth(ws: HotdogServerSocket<unknown>): void {
    this.#pendingAuth.delete(ws);
  }

  broadcast(msg: Record<string, unknown>): void {
    for (const ws of this.#allConnections) {
      SessionRegistry.sendSafe(ws, msg);
    }
  }

  /**
   * Broadcast to every registered connection except one. The exclusion is
   * for the adopting socket, which already refreshed its sidebar.
   */
  broadcastExcept(except: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    for (const ws of this.#allConnections) {
      if (ws === except) continue;
      SessionRegistry.sendSafe(ws, msg);
    }
  }

  static sendSafe(ws: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    try {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify(msg));
      }
    } catch {}
  }

  async create({
    profile,
    model,
    questionStrategy,
    questionTimeoutSecs,
    sessionId,
  }: CreateSessionOptions = {}): Promise<{
    sessionId: string;
    agent: AgentLike;
  }> {
    // Caller-supplied id (cold-log adoption) wins: the agent adopts the log's
    // own id or the session loses its identity across restarts.
    const proposedSessionId = sessionId ?? crypto.randomUUID();

    const agent = await this.#buildAgent({
      model,
      sessionId: proposedSessionId,
      profileName: profile,
    });
    const actualSessionId = agent.sessionId || proposedSessionId;

    this.#metadata.set(actualSessionId, {
      profile: profile || "default",
      title: null,
      model: agent.model || "",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      connectedClients: 0,
      questionStrategy: questionStrategy || this.#questionStrategy,
      questionTimeoutSecs: questionTimeoutSecs || this.#questionTimeoutSecs,
      userMessageCount: 0,
    });

    this.#sessionManager.registerAgent(agent, {
      // Build-config shape (profileName, not profile): forkSession reuses this entry
      // metadata as the fork's buildAgent config, so the keys must match what #buildAgent reads.
      profileName: profile || "default",
      model,
    });

    this.#trackModelChanges(actualSessionId);
    return { sessionId: actualSessionId, agent };
  }

  /**
   * Branch a registry session (webui `/fork`): SessionManager.forkSession plus UI-side metadata
   * for the new session. No prompt here on purpose -- the caller enqueues it after re-targeting
   * the requesting socket, so the prompt's user message echoes live exactly once and the history
   * replay snapshot never races it.
   */
  async fork(
    sourceSessionId: string,
    opts: { turnsBack: number },
  ): Promise<{ sessionId: string; agent: AgentLike }> {
    const meta = this.#metadata.get(sourceSessionId);
    if (!meta) {
      throw new AgentError(`Cannot fork unknown session: ${sourceSessionId}`);
    }

    const { sessionId: newSessionId } = await this.#sessionManager.forkSession(
      sourceSessionId,
      opts,
    );
    const agent = this.#sessionManager.getAgentBySessionId(newSessionId);
    if (!agent) {
      throw new AgentError(`Forked session vanished: ${newSessionId}`);
    }

    this.#metadata.set(newSessionId, {
      profile: meta.profile,
      title: null,
      model: agent.model || meta.model,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      connectedClients: 0,
      questionStrategy: meta.questionStrategy,
      questionTimeoutSecs: meta.questionTimeoutSecs,
      userMessageCount: agent
        .getMessages()
        .filter((m) => m.role === "user").length,
    });

    this.#trackModelChanges(newSessionId);
    return { sessionId: newSessionId, agent };
  }

  #trackModelChanges(sessionId: string): void {
    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (!agent || !agent.hooks || typeof agent.hooks.on !== "function") return;
    agent.hooks.on(HOOKS.MODEL_CHANGE, async ({ newModel }: { newModel: string }) => {
      const meta = this.#metadata.get(sessionId);
      if (meta) meta.model = newModel;
      await indexSessionModel(sessionId, newModel);
    });
  }

  get(
    sessionId: string,
  ): { agent: AgentLike; metadata: SessionMetadata } | null {
    const metadata = this.#metadata.get(sessionId);
    if (!metadata) return null;
    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (!agent) return null;
    return { agent, metadata };
  }

  list(): Array<{
    id: string;
    profile: string;
    title: string | null;
    model: string;
    createdAt: number;
    lastActivityAt: number;
    connectedClients: number;
    userMessageCount: number;
  }> {
    const result: Array<{
      id: string;
      profile: string;
      title: string | null;
      model: string;
      createdAt: number;
      lastActivityAt: number;
      connectedClients: number;
      userMessageCount: number;
    }> = [];
    for (const [id, meta] of this.#metadata) {
      const agent = this.#sessionManager.getAgentBySessionId(id);
      result.push({
        id,
        profile: meta.profile,
        title: meta.title,
        model: agent?.model || meta.model,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        connectedClients: meta.connectedClients,
        userMessageCount: meta.userMessageCount,
      });
    }
    return result;
  }

  delete(sessionId: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta) return false;

    const channels = this.#channels.get(sessionId);
    if (channels) {
      for (const ch of channels) {
        ch.close();
      }
      this.#channels.delete(sessionId);
    }

    this.#sessionManager.deleteSession(sessionId);
    // The registry's SessionManager is built without taskConfig (this host's
    // TaskManager is the published one), so its delete cascade cannot reach
    // the tasks -- interrupt them here or a deleted session's delegates run
    // forever with nobody to receive results.
    this.#taskManager?.interruptTasksForSession(sessionId);
    this.#metadata.delete(sessionId);
    this.#onSessionDeleted?.(sessionId);
    return true;
  }

  /** True if the session has at least one connected channel. */
  hasChannels(sessionId: string): boolean {
    return (this.#channels.get(sessionId)?.size ?? 0) > 0;
  }

  /**
   * Set the session's display title. Independent of the active profile: the
   * profile keeps driving behavior (tools, model), while the title is
   * purely the label shown in the UI.
   */
  rename(sessionId: string, newName: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta) return false;
    meta.title = newName;
    return true;
  }

  listProfiles(): Record<string, SwitchProfile> {
    return { ...this.#profiles };
  }

  /**
   * Switch the session's profile. Context is preserved -- switching never
   * clears the message log (applyProfile rebuilds the system prompt and tool
   * defs without touching messages; `/clear` stays the explicit wipe). Fires
   * PROFILE_SWITCH so the session-log extension mirrors the switch into the
   * log and the index -- without it a webui switch would be invisible to a
   * future cold resume.
   */
  async switchProfile({
    sessionId,
    profileName,
  }: SwitchProfileOptions): Promise<{ success: boolean; error?: string }> {
    const meta = this.#metadata.get(sessionId);
    if (!meta) {
      return { success: false, error: "Session not found" };
    }

    const profile = this.#profiles[profileName];
    if (!profile) {
      return { success: false, error: `Profile "${profileName}" not found` };
    }

    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (agent) {
      const fromProfile = agent.profileName;
      agent.applyProfile(profileName, profile);
      meta.model = agent.model;
      // Fire-and-forget: notifyHooks swallows handler errors, and the switch
      // must not fail because a log/index write did.
      agent.hooks?.notifyHooks(HOOKS.PROFILE_SWITCH, {
        agent: agent as Agent,
        fromProfile,
        toProfile: profileName,
      });
    }
    meta.profile = profileName;
    meta.lastActivityAt = Date.now();

    return { success: true };
  }

  incrementUserMessageCount(sessionId: string): void {
    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.userMessageCount += 1;
    }
  }

  createChannel(
    sessionId: string,
    ws: HotdogServerSocket<unknown>,
  ): WebSocketChannel | undefined {
    const session = this.get(sessionId);
    if (!session) return undefined;

    const channel = new WebSocketChannel({
      sessionManager: this.#sessionManager,
      ws,
      sessionId,
      broadcastCallback: (msg: Record<string, unknown>) => this.broadcast(msg),
    });

    if (!this.#channels.has(sessionId)) {
      this.#channels.set(sessionId, new Set());
    }
    this.#channels.get(sessionId)!.add(channel);

    session.metadata.connectedClients += 1;
    session.metadata.lastActivityAt = Date.now();

    return channel;
  }

  removeChannel(sessionId: string, channel: WebSocketChannel): void {
    channel.detach(sessionId);

    const channels = this.#channels.get(sessionId);
    if (!channels) return;
    channels.delete(channel);

    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.connectedClients = Math.max(0, meta.connectedClients - 1);
    }
  }

  // Prevents idle cleanup of the session.
  touch(sessionId: string): void {
    const meta = this.#metadata.get(sessionId);
    if (meta) {
      meta.lastActivityAt = Date.now();
    }
  }

  startCleanupLoop(timeoutMin: number): void {
    this.#timeoutMin = timeoutMin;
    if (this.#cleanupTimer) return;
    this.#cleanupTimer = setInterval(() => {
      this.#cleanupIdleSessions();
      this.#reapPendingAuth();
    }, 60_000);
  }

  stopCleanupLoop(): void {
    if (this.#cleanupTimer) {
      clearInterval(this.#cleanupTimer);
      this.#cleanupTimer = null;
    }
  }

  #cleanupIdleSessions(): void {
    const now = Date.now();
    const timeoutMs = this.#timeoutMin * 60 * 1000;
    // Idle past the timeout and holding no clients, most recently active first.
    const stale = [...this.#metadata.entries()]
      .filter(([, meta]) => meta.connectedClients === 0 && now - meta.lastActivityAt > timeoutMs)
      .sort((a, b) => b[1].lastActivityAt - a[1].lastActivityAt);
    // Keep the recent few hot (the in-memory agent makes a return visit
    // instant). Older ones go cold (log-only); logs are never deleted here.
    for (const [id] of stale.slice(MAX_HOT_IDLE_SESSIONS)) this.delete(id);
  }

  /**
   * SIGTERM commit-point drain. In-flight turns get up to `timeoutMs` to
   * reach their next fsynced commit point; anything still running after the
   * window is interrupted (aborted mid-LLM, so no partial stream persists;
   * a started tool call replays as outcome-unknown). Queued messages that
   * never reached a turn were never logged -- honest loss.
   */
  async drainSessions(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
    const manager = this.#sessionManager;
    const running = () =>
      manager.sessionIds().filter((id) => manager.isSessionRunning(id));
    const deadline = Date.now() + timeoutMs;
    while (running().length > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
    for (const id of running()) {
      manager.interrupt(id);
    }
    // Give the interrupts a beat to unwind (abort propagation, turn end)
    // before the caller stops the server.
    const settleDeadline = Date.now() + DRAIN_SETTLE_MS;
    while (running().length > 0 && Date.now() < settleDeadline) {
      await new Promise((r) => setTimeout(r, DRAIN_POLL_MS));
    }
  }

  // Close sockets that never completed the AUTH handshake. A validated
  // token lands in ws.authToken (routeMessage), so authenticated sockets
  // just leave the map without being touched.
  #reapPendingAuth(): void {
    const now = Date.now();
    for (const [ws, since] of this.#pendingAuth) {
      if (ws.authToken) {
        this.#pendingAuth.delete(ws);
      } else if (now - since > PENDING_AUTH_TIMEOUT_MS) {
        this.#pendingAuth.delete(ws);
        try {
          ws.close(4001, "Authentication timeout");
        } catch {}
      }
    }
  }

  get size(): number {
    return this.#metadata.size;
  }

  /** @internal */
  getSessionManager(): SessionManager {
    return this.#sessionManager;
  }

  /** @internal */
  get _test_metadata(): Map<string, SessionMetadata> {
    return this.#metadata;
  }

  /** @internal */
  get _test_pendingAuth(): Map<HotdogServerSocket<unknown>, number> {
    return this.#pendingAuth;
  }

  /** @internal */
  _test_cleanupIdleSessions(): void {
    this.#cleanupIdleSessions();
    this.#reapPendingAuth();
  }
}

/**
 * Cold-log adoption: build a fresh agent that ADOPTS the log's own session
 * id and replay the log into it (restoreSessionIntoAgent: fsyncs the
 * resume_attempt record, classifies dangling calls, reports held questions).
 * The session keeps its identity across restarts, and the cap's counter
 * lands in the log it counts. The same id is never adopted twice: concurrent
 * adoptions (two tabs reconnecting to one cold session) would fork two
 * writers onto one JSONL file.
 */
const pendingAdoptions = new Map<
  string,
  Promise<{ pendingQuestions: PendingQuestion[]; openTurn: boolean; modelWarning: string | null }>
>();

export async function adoptSessionLog(
  sessionId: string,
  registry: SessionRegistry,
  auto: boolean,
  /** The FULL log read before adoption: reused for the metadata overlay so
   *  the log is not re-read for a session this call is about to grow. */
  preAdoptionEntries: LogEntry[],
): Promise<{ pendingQuestions: PendingQuestion[]; openTurn: boolean; adopted: boolean; modelWarning: string | null }> {
  const inFlight = pendingAdoptions.get(sessionId);
  if (inFlight) {
    const result = await inFlight;
    return { ...result, adopted: false };
  }
  const attempt = (async () => {
    // Restore persisted model and profile so the resumed session runs with
    // the tool set it ended on. The index is the source of truth for cold
    // loads; metadata is in-memory-only and lost on restart. registry.create
    // takes `profile` (it maps to the buildAgent config's `profileName`).
    const row = getSessionRow(sessionId);
    const { agent } = await registry.create({
      ...(row?.model ? { model: row.model } : {}),
      ...(row?.profile ? { profile: row.profile } : {}),
      sessionId,
    });
    // Model fidelity, loud half: with no log-attested model (legacy log or a
    // rebuild from one), the session resumes on the host default -- that is
    // a model swap the user must never discover from a transcript that
    // "looks fine", so it is announced, not assumed. The chat-visible half
    // must NOT ride the sink here: output events are neither persisted nor
    // replayed, and the resuming socket only subscribes during attach, so a
    // pre-attach emit reaches no one (the one flow that needs it). The text
    // rides back to attachResumedSession and is sent after attach lands.
    let modelWarning: string | null = null;
    if (!row?.model) {
      modelWarning =
        `Resuming ${sessionId} with no model attested in the session log ` +
        "(legacy log or an index rebuilt from one): continuing on the host default model. " +
        "Set the model explicitly (/model or the selector) if that is wrong.";
      logger.error(`[session-index] ${modelWarning}`);
    }
    // The agent adopted the id (registry.create hands it through), so this
    // replays the log into the same log and writes the resume_attempt record.
    // Real agents always carry the restore surface; AgentLike is looser.
    const { pendingQuestions, profile, openTurn } = await restoreSessionIntoAgent(
      agent as unknown as AgentForRestore,
      sessionId,
      { auto },
    );
    const meta = registry.get(sessionId)?.metadata;
    // The log may have a PROFILE_SWITCH the index row hasn't mirrored yet.
    // Overlay it.
    if (profile && profile !== agent.profileName) {
      const p = registry.listProfiles()[profile];
      if (p) {
        agent.applyProfile(profile, p);
        if (meta) meta.profile = profile;
      }
    }
    // Restore UI metadata from the log's own timeline so the sidebar agrees
    // with what the user sees.
    if (meta) {
      meta.userMessageCount = agent
        .getMessages()
        .filter((m) => m.role === "user").length;
      let createdAt = 0;
      let lastActivityAt = 0;
      for (const e of preAdoptionEntries) {
        const t = Date.parse(e.ts);
        if (!(t > 0)) continue;
        if (createdAt === 0 || t < createdAt) createdAt = t;
        if (t > lastActivityAt) lastActivityAt = t;
      }
      if (createdAt > 0) meta.createdAt = createdAt;
      if (lastActivityAt > 0) meta.lastActivityAt = lastActivityAt;
    }
    return { pendingQuestions, openTurn, modelWarning };
  })();
  pendingAdoptions.set(sessionId, attempt);
  try {
    const result = await attempt;
    return { ...result, adopted: true };
  } finally {
    pendingAdoptions.delete(sessionId);
  }
}

/**
 * Replay a slice of a session's FULL log as S2C messages. `startIdx` is the
 * client's replay cursor: a position in the full log (append-only -- a RESET
 * never moves an earlier entry), so the slice is exactly the tail the
 * client does not hold. Full replays pass the epoch's start as `startIdx`.
 * Only conversation entries are sent; bookkeeping records never surface.
 * Tool-result names resolve across the WHOLE log, so a result whose call
 * predates the slice (even across a RESET) carries the right name.
 */
function replayLogSlice(
  ws: HotdogServerSocket<unknown>,
  sessionId: string,
  entries: LogEntry[],
  startIdx: number,
  toolRegistry?: ToolRegistry,
): void {
  const callNames = new Map<string, string>();
  for (const e of entries) {
    if (e.source !== LOG_SOURCE.LLM || !Array.isArray(e.tool_calls)) continue;
    for (const tc of e.tool_calls as Array<{ id?: string; function?: { name?: string } }>) {
      if (tc?.id && tc.function?.name) callNames.set(tc.id, tc.function.name);
    }
  }

  for (let i = startIdx; i < entries.length; i++) {
    const e = entries[i]!;
    // Conversation sources only hold text or content parts (see the helper).
    const content = conversationContent(e);
    switch (e.source) {
      case LOG_SOURCE.INPUT:
      case LOG_SOURCE.PROMPT: {
        const userImgs = wireImages(e.images);
        const display = splitFileIncludes(content);
        ws.send(
          JSON.stringify({
            type: S2C.USER_MESSAGE,
            sessionId,
            content: display.text,
            ...(display.files.length > 0 ? { files: display.files } : {}),
            ...(userImgs ? { images: userImgs } : {}),
          }),
        );
        break;
      }
      case LOG_SOURCE.LLM: {
        if (e.reasoning_content) {
          ws.send(
            JSON.stringify({ type: S2C.THINKING, sessionId, content: e.reasoning_content }),
          );
        }
        const toolCalls = Array.isArray(e.tool_calls)
          ? (e.tool_calls as Array<{ id: string; function?: { name?: string; arguments?: string } }>)
          : undefined;
        if (toolCalls && toolCalls.length > 0) {
          for (const tc of toolCalls) {
            const name = tc.function?.name || "unknown";
            const args = tc.function?.arguments || "{}";
            // Replay has no live tool object: resolve the display header from
            // the registry by name (undefined when the tool is unknown now).
            const display = safeCallDisplay(toolRegistry?.get(name), args);
            ws.send(
              JSON.stringify({
                type: S2C.TOOL_CALL,
                sessionId,
                name,
                args,
                ...(tc.id ? { toolCallId: tc.id } : {}),
                ...(display !== undefined ? { display } : {}),
              }),
            );
          }
        }
        const text = wrapperContentText(content);
        if (text) {
          ws.send(JSON.stringify({ type: S2C.ASSISTANT_MESSAGE, sessionId, content: text }));
        }
        break;
      }
      case LOG_SOURCE.TOOL_RESULT: {
        const toolImgs = wireImages(e.images);
        const callId = typeof e.tool_call_id === "string" ? e.tool_call_id : undefined;
        ws.send(
          JSON.stringify({
            type: S2C.TOOL_RESULT,
            sessionId,
            name: (callId ? callNames.get(callId) : undefined) || "unknown",
            output: toolContentText(content ?? ""),
            ...(callId ? { toolCallId: callId } : {}),
            ...(toolImgs ? { images: toolImgs } : {}),
          }),
        );
        break;
      }
      default:
        break; // bookkeeping records never replay as conversation
    }
  }
}

/**
 * Attach a socket to a LIVE session: channel, sessionCreated, history
 * replay from the log at `cursor`, in-flight partial-stream flush, and the
 * new replay cursor (FULL log length). The log -- not the in-memory
 * messages -- is replayed, so the cursor the client persists is exactly a
 * full-log index it can hand back on the next reconnect.
 *
 * The cursor lives in the full log's append-only coordinate space: an
 * epoch-length cursor is only valid while no RESET has moved the index
 * space, and a RESET that shrinks the epoch below the cursor and regrows
 * it past it would silently replay the wrong slice. The full log only ever
 * grows, so a valid cursor stays valid across compactions.
 *
 * `cursor > 0` means the client asked for a delta (it only sends one when
 * its transcript ends exactly at that position: the slice is the exact
 * tail, nothing to clear or duplicate). The client skips its transcript
 * clear when it sees `replayDelta: true` on sessionCreated. Two cases
 * clamp to a full replay instead: a cursor beyond the full length (the log
 * shrank under it -- truncation/corruption; a RESET only appends), and a
 * slice that CROSSES a RESET (a rewind re-appends its kept messages below
 * the marker, so the tail would replay copies the client already holds).
 * Compaction writes no RESET (replaceContext), so common-case cursors are
 * unaffected.
 */
/** The sessionCreated payload for a live session (attach + broadcast share it). */
function sessionCreatedPayload(
  registry: SessionRegistry,
  sessionId: string,
): Record<string, unknown> {
  const session = registry.get(sessionId);
  const agent = (session?.agent as Agent) || null;
  const meta = session?.metadata;
  return {
    type: S2C.SESSION_CREATED,
    sessionId,
    profile: agent?.profileName || meta?.profile || "default",
    title: meta?.title ?? null,
    currentModel: agent?.model || meta?.model || "?",
    models: Object.keys(agent?.modelRegistry || {}),
    sttEnabled: registry.sttEnabled,
    toolExec: registry.toolExecLabel,
  };
}

export async function attachLiveSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
  bridge: WebSocketQuestionBridge,
  sessionId: string,
  cursor = 0,
  fullOverride?: LogEntry[],
): Promise<boolean> {
  const session = registry.get(sessionId);
  if (!session) return false;
  if (ws.activeSessionId && ws.activeChannel) {
    registry.removeChannel(ws.activeSessionId, ws.activeChannel);
  }
  const channel = registry.createChannel(sessionId, ws);
  if (!channel) return false;
  ws.activeSessionId = sessionId;
  ws.activeChannel = channel;

  const agent = session.agent as Agent;

  // Cold adoption passes the PRE-adoption full log (the log has since grown
  // by bookkeeping records); live attaches read the current one.
  const full = fullOverride ?? (await readSessionEntries(sessionId, { full: true }));
  // A cursor beyond the full length means the log shrank under it
  // (truncation/corruption): the retained transcript is stale, so a full
  // replay (the epoch -- the context's view) instead of a delta that would
  // keep the stale head. A delta sends the exact full-log tail past it.
  const epochStart = epochStartIndex(full);
  const c = Number.isFinite(cursor) && cursor > 0 ? Math.trunc(cursor) : 0;
  // A slice crossing a RESET is not the exact tail of the client's
  // transcript: full replay, not a duplicate-laden delta.
  const replayDelta =
    c > 0 && c <= full.length && !full.slice(c).some((e) => e.source === LOG_SOURCE.RESET);
  const start = replayDelta ? c : epochStart;

  SessionRegistry.sendSafe(ws, {
    ...sessionCreatedPayload(registry, sessionId),
    ...(replayDelta ? { replayDelta: true } : {}),
  });

  replayLogSlice(ws, sessionId, full, start, agent?.toolRegistry);

  // Flush in-flight chunks that haven't reached the log yet (their LLM
  // entry lands when the response completes).
  const partialReasoning = agent.currentStreamingReasoning;
  const partialContent = agent.currentStreamingContent;
  if (partialReasoning) {
    SessionRegistry.sendSafe(ws, {
      type: S2C.STREAMING_REASONING_CHUNK,
      sessionId,
      content: partialReasoning,
    });
  }
  if (partialContent) {
    SessionRegistry.sendSafe(ws, { type: S2C.STREAMING_CHUNK, sessionId, content: partialContent });
  }

  // The client's new replay position for the next reconnect (full log
  // length: the append-only coordinate the cursor lives in). 0 when a
  // partial was flushed above: the transcript then holds content the log
  // lacks at that position, so the next reconnect must full-replay instead
  // of a delta that could replay the finished response on top of the
  // partial.
  SessionRegistry.sendSafe(ws, {
    type: S2C.SESSION_STATE,
    sessionId,
    key: "cursor",
    value: partialReasoning || partialContent ? 0 : full.length,
  });
  const isRunning = registry.getSessionManager().isSessionRunning(sessionId);
  SessionRegistry.sendSafe(ws, { type: S2C.SESSION_STATE, sessionId, key: "working", value: isRunning });
  replayPendingQuestion(bridge, sessionId, ws);
  registry.sendTaskSnapshot(ws);
  return true;
}

/**
 * Attach a socket to the session it was last on (reconnect identity): the
 * session id survives the disconnect; the cursor (optional) lets the client
 * keep its transcript and take only the delta. Live: attach directly. Cold:
 * adopt the log under its own id, with the livelock cap enforced for AUTO
 * resumes only (manual resumes always pass). Unknown or parked sessions
 * fall back to the most recent, with an honest error after the fallback
 * lands (so it survives the client's transcript clear).
 */
export async function attachResumedSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
  bridge: WebSocketQuestionBridge,
  sessionId: string,
  cursor = 0,
  auto: boolean,
): Promise<void> {
  const fallBack = (reason: string): Promise<void> =>
    fallbackAttach(ws, registry, bridge, reason);

  try {
    sessionPath(sessionId); // invalid id (traversal, separators) = unknown
  } catch {
    return fallBack(`Session ${JSON.stringify(String(sessionId).slice(0, 80))} is not a valid id.`);
  }

  if (registry.get(sessionId)) {
    // The live session can go cold between the get and the attach; fall
    // back instead of stranding the socket.
    if (!(await attachLiveSession(ws, registry, bridge, sessionId, cursor))) {
      return fallBack(`Session ${sessionId} could not be attached.`);
    }
    return;
  }

  if (!(await sessionExists(sessionId))) {
    return fallBack(`Session ${sessionId} no longer exists (no log found).`);
  }

  // One full-log read serves both consumers: the cap's counter (an audit
  // trail a RESET must not recharge) and the pre-adoption full log (the
  // cursor's coordinate space) come from the same array.
  const fullEntries = await readSessionEntries(sessionId, { full: true });
  if (epochEntries(fullEntries).length === 0) {
    return fallBack(`Session ${sessionId}'s log is empty.`);
  }

  if (auto) {
    const { consecutiveAutoResumes } = collectDurabilityFacts(fullEntries);
    if (consecutiveAutoResumes >= MAX_CONSECUTIVE_AUTO_RESUMES) {
      return fallBack(
        `Session ${sessionId} is parked after ${consecutiveAutoResumes} consecutive auto-resumes ` +
          `without progress. Open it from Recent Logs and pick Continue to resume it manually.`,
      );
    }
  }

  const { pendingQuestions, openTurn, adopted, modelWarning } = await adoptSessionLog(
    sessionId,
    registry,
    auto,
    fullEntries,
  );
  // Replay the PRE-adoption full log: the log now also holds the adoption's
  // session_start/resume_attempt records (bookkeeping, never sent), and the
  // client's cursor indexes the pre-adoption positions.
  const attached = await attachLiveSession(ws, registry, bridge, sessionId, cursor, fullEntries);
  if (!attached) return fallBack(`Session ${sessionId} could not be resumed.`);

  // The adopt-time model warning, delivered where it can be seen: the socket
  // only subscribes during attach and output events are never replayed, so
  // this rides the attach burst right after the cursor (like the held
  // questions below), before any continuation turn starts.
  if (modelWarning) {
    SessionRegistry.sendSafe(ws, {
      type: S2C.SYSTEM_MESSAGE,
      sessionId,
      content: modelWarning,
    });
  }

  if (adopted) {
    // Newly live session: other tabs' sidebars learn it moved from Recent
    // Logs as a SIDEBAR REFRESH, not a sessionCreated -- that event is an
    // attach command on the client (re-targets the socket, clears the
    // transcript), so broadcasting it would yank tabs working on other
    // sessions. The adopting socket is excluded (it refreshed itself).
    registry.broadcastExcept(ws, { type: S2C.SESSIONS, sessions: registry.list() });
  }

  // Held questions (the log died mid-question): the adopting client re-presents
  // them; later attachers get them via replayPendingQuestion on the bridge.
  if (adopted && pendingQuestions.length > 0) {
    seedResumedQuestions(bridge, registry, sessionId, pendingQuestions);
    SessionRegistry.sendSafe(ws, {
      type: S2C.QUESTION,
      sessionId,
      questions: pendingQuestions[0]!.questions as QuestionDef[],
    });
  }

  // Interrupted turn (v2: turn_started with no turn_end): restart the agent
  // loop so it continues from the repaired context (interrupted tool results
  // ride along as outcome-unknown). Held questions win: a turn must not
  // start on a dangling question call (400 on strict backends); the
  // question's ANSWER enqueues the continuation instead. Only the adopting
  // client triggers it (concurrent adopters dedupe); no double-start.
  if (adopted && openTurn && pendingQuestions.length === 0) {
    registry.getSessionManager().getBus(sessionId)?.enqueue("", { continuation: true });
  }
}

/** Fallback attach (saved session unknown/parked): most recent session, or a
 *  fresh one when the server holds none. The reason is sent AFTER the
 *  fallback's sessionCreated: the client clears its transcript on attach, so
 *  an earlier error would never render. */
async function fallbackAttach(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
  bridge: WebSocketQuestionBridge,
  reason: string,
): Promise<void> {
  if (registry.size > 0) {
    await attachToMostRecentSession(ws, registry, bridge);
  } else {
    await createAndAttachSession(ws, registry);
  }
  SessionRegistry.sendSafe(ws, { type: S2C.ERROR, message: reason });
}

/** Held resumed questions per session (cold log with unanswered questions):
 *  each answer lands as its held call's tool result, the next question
 *  chains, the last queues a continuation turn. A new prompt dismisses
 *  whatever is still held (honest error results) -- no turn may start on a
 *  dangling call (guaranteed 400 on strict backends). */
const resumedHeldQuestions = new Map<string, PendingQuestion[]>();

function resumedToolResult(content: string, toolCallId: string, success: boolean): Message {
  return new Message({
    role: "tool",
    content: [formatToolResult(content, "question", success)],
    toolCallId,
    source: "tool",
  });
}

export function seedResumedQuestions(
  bridge: WebSocketQuestionBridge,
  registry: SessionRegistry,
  sessionId: string,
  pending: PendingQuestion[],
): void {
  if (pending.length === 0) return;
  resumedHeldQuestions.set(sessionId, pending.slice());
  const injectNext = (queue: PendingQuestion[]): void => {
    const q = queue[0];
    if (!q) {
      resumedHeldQuestions.delete(sessionId);
      return;
    }
    bridge.inject(sessionId, q.questions as QuestionDef[], (answers, cancelled) => {
      // The hold was dismissed (new prompt) or the session deleted since the
      // inject: never write tool results for calls we no longer hold.
      if (!resumedHeldQuestions.has(sessionId)) return;
      // Resolve the agent fresh: /model or a profile switch may have replaced
      // it between load and answer; the result must land on the live one.
      const agent = registry.get(sessionId)?.agent;
      if (!agent) return; // session gone with the hold: nothing to answer
      agent.addMessage(
        cancelled
          ? resumedToolResult(
              "Question unanswered: it was dismissed without an answer (cancel resolves with defaults, and defaults are not the user's reply).",
              q.toolCallId,
              false,
            )
          : resumedToolResult(JSON.stringify(answers, null, 2), q.toolCallId, true),
      );
      const rest = queue.slice(1);
      if (rest.length > 0) {
        resumedHeldQuestions.set(sessionId, rest);
        injectNext(rest);
        registry.broadcast({ type: S2C.QUESTION, sessionId, questions: rest[0]!.questions });
        return;
      }
      // All held calls answered: drop the hold BEFORE the continuation, so a
      // following prompt's dismiss cannot re-answer calls already resolved.
      resumedHeldQuestions.delete(sessionId);
      registry.getSessionManager().getBus(sessionId)?.enqueue("", { continuation: true });
    });
  };
  injectNext(pending);
}

/**
 * A new prompt abandons any still-held resumed questions: each unanswered
 * call gets an honest error tool result so the context stays wire-valid.
 * (Live questions are untouched -- they belong to a running turn, and their
 * messages simply queue behind it.)
 */
export function dismissResumedQuestions(
  bridge: WebSocketQuestionBridge,
  registry: SessionRegistry,
  sessionId: string,
): void {
  const held = resumedHeldQuestions.get(sessionId);
  if (!held || held.length === 0) return;
  const agent = registry.get(sessionId)?.agent;
  resumedHeldQuestions.delete(sessionId);
  bridge.remove(sessionId); // the queued resolve would write a duplicate answer
  // Clear any question card still on clients -- answering a stale one would
  // get "No pending question" back. Same event as the live answer path,
  // flagged dismissed with empty answers.
  registry.broadcast({
    type: S2C.QUESTION_ANSWERED,
    sessionId,
    answers: {},
    dismissed: true,
  });
  if (!agent) return;
  for (const q of held) {
    agent.addMessage(
      resumedToolResult(
        "Question unanswered: a new message arrived before an answer; the question was dismissed.",
        q.toolCallId,
        false,
      ),
    );
  }
}

// Re-emit a session's history as S2C messages so the frontend can reconstruct the chat.
function replaySessionHistory(
  sessionId: string,
  agent: AgentLike,
  ws: HotdogServerSocket<unknown>,
): void {
  const messages = agent.getMessages();

  try {
    let pendingToolCalls: Array<{
      id: string;
      function?: { name?: string; arguments?: string };
    }> = [];

    for (const msg of messages) {
      switch (msg.role) {
        case "user": {
          const userImgs = wireImages((msg as { images?: unknown }).images);
          // Attachments in `files`; the text excludes file-include parts.
          const display = splitFileIncludes(msg.content);
          ws.send(
            JSON.stringify({
              type: S2C.USER_MESSAGE,
              sessionId,
              content: display.text,
              ...(display.files.length > 0 ? { files: display.files } : {}),
              ...(userImgs ? { images: userImgs } : {}),
            }),
          );
          break;
        }

        case "assistant": {
          if (msg.reasoningContent) {
            ws.send(
              JSON.stringify({
                type: S2C.THINKING,
                sessionId,
                content: msg.reasoningContent,
              }),
            );
          }

          const toolCalls = msg.toolCalls as
            | Array<{
                id: string;
                function?: { name?: string; arguments?: string };
              }>
            | undefined;
          if (toolCalls && toolCalls.length > 0) {
            pendingToolCalls = toolCalls;
            for (const tc of toolCalls) {
              const name = tc.function?.name || "unknown";
              const args = tc.function?.arguments || "{}";
              const display = safeCallDisplay((agent as Agent).toolRegistry?.get(name), args);
              ws.send(
                JSON.stringify({
                  type: S2C.TOOL_CALL,
                  sessionId,
                  name,
                  args,
                  ...(tc.id ? { toolCallId: tc.id } : {}),
                  ...(display !== undefined ? { display } : {}),
                }),
              );
            }
          }
          const textContent =
            typeof msg.getTextContent === "function"
              ? msg.getTextContent()
              : msg.content || "";
          if (textContent) {
            ws.send(
              JSON.stringify({
                type: S2C.ASSISTANT_MESSAGE,
                sessionId,
                content: textContent,
              }),
            );
          }
          break;
        }

        case "tool": {
          const matchedCall = pendingToolCalls.find(
            (tc) => tc.id === msg.toolCallId,
          );
          const toolImgs = wireImages((msg as { images?: unknown }).images);
          ws.send(
            JSON.stringify({
              type: S2C.TOOL_RESULT,
              sessionId,
              name: matchedCall?.function?.name || "unknown",
              // Parts (tool-result) flatten for this string-only transport;
              // legacy entries are already plain text.
              output: toolContentText(msg.content ?? ""),
              ...(msg.toolCallId ? { toolCallId: msg.toolCallId } : {}),
              ...(toolImgs ? { images: toolImgs } : {}),
            }),
          );
          break;
        }

        default:
          break;
      }
    }

    // Flush in-flight chunks that haven't reached the message log yet.
    const agentImpl = agent as Agent;
    const partialReasoning = agentImpl.currentStreamingReasoning;
    const partialContent = agentImpl.currentStreamingContent;
    if (partialReasoning) {
      ws.send(
        JSON.stringify({
          type: S2C.STREAMING_REASONING_CHUNK,
          sessionId,
          content: partialReasoning,
        }),
      );
    }
    if (partialContent) {
      ws.send(
        JSON.stringify({
          type: S2C.STREAMING_CHUNK,
          sessionId,
          content: partialContent,
        }),
      );
    }
  } catch {
    // Connection dropped mid-replay -- nothing to do.
  }
}

/**
 * Upload size limits, reused from the fileAttachment extension config
 * (its schema defaults: 100KB per text file, 10MB per image, 10 files per message).
 * uploads and @refs share one ceiling, including the separate image budget (fileAttachment.maxImageSize).
 */
function uploadLimits(core: CoreContext): { maxFileSize: number; maxImageSize: number; maxFiles: number } {
  const cfg = getExtensionConfig<{ maxFileSize?: number; maxImageSize?: number; maxFiles?: number }>(
    core,
    "fileAttachment",
  );

  return {
    maxFileSize: typeof cfg.maxFileSize === "number" ? cfg.maxFileSize : 102400,
    maxImageSize: typeof cfg.maxImageSize === "number" ? cfg.maxImageSize : DEFAULT_MAX_IMAGE_SIZE,
    maxFiles: typeof cfg.maxFiles === "number" ? cfg.maxFiles : 10,
  };
}

/**
 * Push-to-talk transcription: decode the base64 audio, forward it to the
 * OpenAI-compatible endpoint resolved from config (`sttUrl`/`sttModel`), and
 * answer with a `transcript` message correlated by the client's request id.
 * All failures land in-band ({ ok:false, error }): a missing or broken STT
 * backend must never drop the socket.
 */
async function handleTranscribe(
  ws: HotdogServerSocket<unknown>,
  msg: C2SMessage,
  stt: SttTarget | null,
): Promise<void> {
  const id = typeof msg.id === "string" ? msg.id : "";
  const reply = (payload: { ok: boolean; text?: string; error?: string }) =>
    SessionRegistry.sendSafe(ws, { type: S2C.TRANSCRIPT, id, ...payload });

  if (!stt) {
    reply({
      ok: false,
      error:
        "Speech-to-text is not configured (no audio-capable model in the registry; set sttUrl to override)",
    });
    return;
  }
  if (typeof msg.data !== "string" || msg.data.length === 0) {
    reply({ ok: false, error: "transcribe: missing audio data" });
    return;
  }
  if (msg.data.length > MAX_TRANSCRIBE_BASE64_CHARS) {
    reply({
      ok: false,
      error: `transcribe: audio too large (limit ${MAX_TRANSCRIBE_AUDIO_BYTES / 1024 / 1024}MB)`,
    });
    return;
  }

  try {
    const audio = new Uint8Array(Buffer.from(msg.data, "base64"));
    const text = await transcribeAudio({
      url: stt.url,
      model: stt.model,
      authHeader: stt.authHeader,
      audio,
      mimeType: typeof msg.mimeType === "string" ? msg.mimeType : undefined,
    });
    reply({ ok: true, text });
  } catch (err: unknown) {
    logger.error(`[websocket] transcribe failed: ${formatError(err)}`);
    reply({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}

async function routeMessage(
  ws: HotdogServerSocket<unknown>,
  msg: C2SMessage,
  registry: SessionRegistry,
  authMiddleware: AuthMiddleware | undefined,
  bridge: WebSocketQuestionBridge,
  core: CoreContext,
): Promise<void> {
  const completion = core.completion;
  // Auth gate: when auth is enabled, only the AUTH handshake itself may
  // pass without a validated token. The token is established either at
  // upgrade (URL ?token=) or by a successful AUTH message. This makes the
  // gate hold even for UIs that skip token checks on the HTTP upgrade.
  if (authMiddleware && !ws.authToken && msg.type !== C2S.AUTH) {
    // code:"auth_required" is machine-readable: clients must not treat a
    // pre-auth gate hit as a token failure (see webui/ui/chat.ts authError).
    ws.send(JSON.stringify({ type: S2C.AUTH_ERROR, code: "auth_required", message: "Authentication required" }));
    return;
  }

  const sessionManager = registry.getSessionManager();

  switch (msg.type) {
    case C2S.AUTH: {
      if (authMiddleware) {
        if (msg.token) {
          const valid = authMiddleware.validateToken(msg.token as string);
          if (valid) {
            ws.authToken = msg.token as string;
            // Handshake complete: drop the pending-auth stamp now instead of
            // leaving the reaper to notice ws.authToken on its next sweep.
            registry.removePendingAuth(ws);
            // Authed sockets join the broadcast group (no-op if already
            // registered via a token upgrade).
            registry.registerConnection(ws);
            ws.send(JSON.stringify({ type: S2C.AUTH_OK }));
            // The task snapshot rides the attach paths below. A client that
            // remembers its session (upgrade ?session=...) gets it back
            // instead of the most recent one. attachStarted covers an
            // upgrade-site attach still in flight (activeSessionId is not set
            // until its first awaits settle).
            if (!ws.activeSessionId && !ws.attachStarted) {
              ws.attachStarted = true;
              if (ws.resumeSessionId) {
                attachResumedSession(
                  ws,
                  registry,
                  bridge,
                  ws.resumeSessionId,
                  ws.resumeCursor ?? 0,
                  true,
                ).catch((err: unknown) => {
                  logger.error(`[websocket] resumed attach failed: ${formatError(err)}`);
                  void fallbackAttach(ws, registry, bridge, "Session resume failed.");
                });
              } else if (registry.size > 0) {
                void attachToMostRecentSession(ws, registry, bridge).catch((err: unknown) => {
                  logger.error(`[websocket] attach to most recent failed: ${formatError(err)}`);
                });
              } else {
                createAndAttachSession(ws, registry);
              }
            }
          } else {
            ws.send(
              JSON.stringify({ type: S2C.AUTH_ERROR, message: "Invalid token" }),
            );
          }
        } else {
          // Malformed AUTH: answer instead of going silent, or the client
          // waits out the pending-auth timeout with no clue why.
          ws.send(
            JSON.stringify({ type: S2C.AUTH_ERROR, message: "AUTH message requires a token" }),
          );
        }
      }
      break;
    }

    case C2S.CREATE_SESSION: {
      if (ws.activeSessionId && ws.activeChannel) {
        registry.removeChannel(ws.activeSessionId, ws.activeChannel);
      }
      registry
        .create({
          profile: msg.profile as string | undefined,
          model: msg.model as string | undefined,
          questionStrategy: msg.questionStrategy as string | undefined,
          questionTimeoutSecs: msg.questionTimeoutSecs as number | undefined,
        })
        .then(({ sessionId, agent }) => {
          const channel = registry.createChannel(sessionId, ws);
          ws.activeSessionId = sessionId;
          ws.activeChannel = channel;

          const sessionCreatedMsg = {
            type: S2C.SESSION_CREATED,
            sessionId,
            profile: agent.profileName || "default",
            // Fresh session: no explicit title yet, display follows profile.
            title: null,
            currentModel: agent.model,
            models: Object.keys(agent.modelRegistry || {}),
            sttEnabled: registry.sttEnabled,
            toolExec: registry.toolExecLabel,
          };
          SessionRegistry.sendSafe(ws, sessionCreatedMsg);
          registry.broadcast(sessionCreatedMsg);
          registry.sendTaskSnapshot(ws);
        })
        .catch((err: unknown) => {
          SessionRegistry.sendSafe(ws, {
            type: S2C.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      break;
    }

    case C2S.DELETE_SESSION: {
      if (msg.sessionId) {
        registry.delete(msg.sessionId as string);
        const sessionDeletedMsg = {
          type: S2C.SESSION_DELETED,
          sessionId: msg.sessionId,
        };
        ws.send(JSON.stringify(sessionDeletedMsg));
        registry.broadcast(sessionDeletedMsg);
      }
      break;
    }

    case C2S.RENAME_SESSION: {
      if (msg.sessionId && msg.newName) {
        registry.rename(msg.sessionId as string, msg.newName as string);
      }
      break;
    }

    case C2S.LIST_SESSIONS: {
      const sessions = registry.list();
      ws.send(JSON.stringify({ type: "sessions", sessions }));
      break;
    }

    case C2S.LIST_PROFILES: {
      const profiles = registry.listProfiles();
      ws.send(JSON.stringify({ type: S2C.PROFILES, profiles }));
      break;
    }

    case C2S.SWITCH_PROFILE: {
      if (msg.sessionId && msg.profileName) {
        const result = await registry.switchProfile({
          sessionId: msg.sessionId as string,
          profileName: msg.profileName as string,
        });
        if (result.success) {
          ws.send(
            JSON.stringify({
              type: S2C.PROFILE_SWITCHED,
              sessionId: msg.sessionId,
              profile: msg.profileName,
              success: true,
            }),
          );
        } else {
          ws.send(
            JSON.stringify({
              type: S2C.ERROR,
              message: result.error || "Profile switch failed",
            }),
          );
        }
      }
      break;
    }

    case C2S.SWITCH_SESSION: {
      // Manual sidebar switch: the client has no replay cursor for a session
      // it is not currently on, so this is always a full replay (cursor 0).
      if (msg.sessionId) {
        const attached = await attachLiveSession(
          ws,
          registry,
          bridge,
          msg.sessionId as string,
        );
        if (!attached) {
          ws.send(JSON.stringify({ type: S2C.ERROR, message: "Session not found" }));
        }
      }
      break;
    }

    case C2S.SEND: {
      const sid = msg.sessionId as string | undefined;
      const text = typeof msg.content === "string" ? msg.content : "";
      const files = msg.files;
      if (!sid) break;

      // A new prompt supersedes any resumed question still on hold.
      dismissResumedQuestions(bridge, registry, sid);

      if (Array.isArray(files) && files.length > 0) {
        // Webui upload: base64 files on the send message.
        // Validation is all-or-nothing so nothing is ever silently dropped.
        // Provenance: the parse happened server-side, so this enqueue is harness-authoritative --
        // the only way file-include parts survive the bus queue boundary (sanitizeQueuedContent).
        const agent = sessionManager.getAgentBySessionId(sid);
        const limits = uploadLimits(core);
        const parsed = parseUploadedFiles(files, {
          ...limits,
          vision: modelAcceptsImages(agent?.model, (agent as { modelRegistry?: Record<string, never> } | undefined)?.modelRegistry),
        });
        if (parsed.errors.length > 0) {
          SessionRegistry.sendSafe(ws, {
            type: S2C.ERROR,
            message: `Upload rejected: ${parsed.errors.join("; ")}`,
          });
          break;
        }
        const content: Array<Record<string, unknown>> = [];
        if (text) content.push({ type: "untrusted", text });
        content.push(...parsed.parts);
        if (content.length === 0 && parsed.images.length === 0) break;
        registry.touch(sid);
        registry.incrementUserMessageCount(sid);
        sessionManager.enqueue(sid, content, {
          source: "harness",
          ...(parsed.images.length > 0 ? { images: parsed.images } : {}),
        });
        break;
      }

      if (text) {
        registry.touch(sid);
        registry.incrementUserMessageCount(sid);
        sessionManager.enqueue(
          sid,
          text,
          msg.steering === true ? { steering: true } : undefined,
        );
      }
      break;
    }

    case C2S.CANCEL: {
      if (msg.sessionId) {
        // interrupt() keeps the bus alive for follow-ups; cancel() would abort it.
        sessionManager.interrupt(msg.sessionId as string);
        // Unblock a pending question-tool call so it can't hang.
        bridge.cancel(msg.sessionId as string);
      }
      break;
    }

    // Subagent panel controls: thin delegates onto the TaskManager primitives
    // the task_interrupt / task_followup tools already use. No control logic
    // here -- the primitives own queued/running/parked semantics.
    case C2S.TASK_INTERRUPT: {
      const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
      if (!taskId) break;
      const taskManager = registry.getTaskManager();
      const ok = taskManager ? taskManager.interruptTask(taskId) : false;
      SessionRegistry.sendSafe(ws, {
        type: S2C.TASK_CONTROL,
        taskId,
        action: "interrupt",
        ok,
        ...(ok ? {} : { error: "Task not found or no longer active" }),
      });
      break;
    }

    case C2S.TASK_FOLLOWUP: {
      const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
      const message = typeof msg.message === "string" ? msg.message.trim() : "";
      if (!taskId || !message) break;
      const taskManager = registry.getTaskManager();
      const ok = taskManager ? taskManager.sendFollowUp(taskId, message) : false;
      SessionRegistry.sendSafe(ws, {
        type: S2C.TASK_CONTROL,
        taskId,
        action: "followup",
        ok,
        ...(ok ? {} : { error: "Steering needs a running task with a live turn" }),
      });
      break;
    }
    case C2S.TASK_ACTIVITY_REQUEST: {
      // Buffered tail for one task, requester only. Gated to the socket's own
      // session, so probing arbitrary task ids leaks nothing.
      const taskId = typeof msg.taskId === "string" ? msg.taskId : null;
      if (!taskId) break;
      const taskManager = registry.getTaskManager();
      const owner = taskManager ? taskManager.getTaskSession(taskId) : undefined;
      const allowed = owner !== undefined && owner === ws.activeSessionId;
      SessionRegistry.sendSafe(ws, {
        type: S2C.TASK_ACTIVITY_HISTORY,
        taskId,
        activity: allowed ? registry.getTaskActivityHistory(taskId) : [],
      });
      break;
    }

    case C2S.QUESTION_ANSWER: {
      const sid = msg.sessionId as string | undefined;
      const answers = msg.answers;
      if (sid && answers && typeof answers === "object" && !Array.isArray(answers)) {
        if (bridge.answer(sid, answers as Record<string, unknown>)) {
          // Notify all clients (multiple tabs may be showing the prompt).
          registry.broadcast({
            type: S2C.QUESTION_ANSWERED,
            sessionId: sid,
            answers,
          });
        } else {
          ws.send(
            JSON.stringify({
              type: S2C.ERROR,
              message: `No pending question for session ${sid}`,
            }),
          );
        }
      }
      break;
    }

    case C2S.COMMAND: {
      if (msg.sessionId && msg.command) {
        registry.touch(msg.sessionId as string);
        let cmdText = msg.command as string;
        if (cmdText.startsWith("/")) {
          cmdText = cmdText.slice(1).trim();
        }

        // /fork is intercepted rather than dispatched to the bus: the registry must
        // register the new session's UI metadata and re-target the requesting socket,
        // or the tab stays on the source and the fork is unreachable in the webui.
        if (cmdText === "fork" || cmdText.startsWith("fork ")) {
          const { turnsBack, prompt } = parseForkArg(cmdText.slice("fork".length));
          registry
            .fork(msg.sessionId as string, { turnsBack })
            .then(({ sessionId: newSessionId, agent }) => {
              if (ws.activeSessionId && ws.activeChannel) {
                registry.removeChannel(ws.activeSessionId, ws.activeChannel);
              }
              ws.activeSessionId = newSessionId;
              ws.activeChannel = registry.createChannel(newSessionId, ws);

              const sessionCreatedMsg = {
                type: S2C.SESSION_CREATED,
                sessionId: newSessionId,
                profile: agent.profileName || "default",
                // Fresh session (branch): no explicit title yet, display follows profile.
                title: null,
                currentModel: agent.model,
                models: Object.keys(agent.modelRegistry || {}),
                sttEnabled: registry.sttEnabled,
                toolExec: registry.toolExecLabel,
              };
              SessionRegistry.sendSafe(ws, sessionCreatedMsg);
              registry.broadcast(sessionCreatedMsg);
              // A fresh fork id owns no tasks, so it inherits none of the source's chips.
              registry.sendTaskSnapshot(ws);

              // After the fork's sessionCreated lands (the client clears its list and
              // re-targets), replay the copied history, then start the optional prompt.
              replaySessionHistory(newSessionId, agent, ws);
              // Close the client's attach bookkeeping like every other attach path.
              // Cursor 0 on purpose: this replay came from in-memory messages, not a
              // log read, so no log coordinate can be claimed -- the next reconnect
              // takes a full replay.
              SessionRegistry.sendSafe(ws, {
                type: S2C.SESSION_STATE,
                sessionId: newSessionId,
                key: "cursor",
                value: 0,
              });
              if (prompt) {
                sessionManager.enqueue(newSessionId, prompt);
              }
            })
            .catch((err: unknown) => {
              SessionRegistry.sendSafe(ws, {
                type: S2C.ERROR,
                message: err instanceof Error ? err.message : String(err),
              });
            });
          break;
        }

        sessionManager.executeCommand(msg.sessionId as string, cmdText);
      }
      break;
    }

    case C2S.COMPLETE: {
      // Same core completion system the interactive CLI uses; the client
      // renders the list and replaces `prefix` at its own caret.
      if (!completion || !msg.sessionId) break;
      const session = registry.get(msg.sessionId as string);
      const agent = session?.agent;
      if (!agent) break;

      const line =
        (typeof msg.line === "string" ? msg.line : "").slice(0, MAX_COMPLETE_LINE);
      let cursorPos = Number.isFinite(msg.cursorPos)
        ? Math.trunc(msg.cursorPos as number)
        : line.length;
      cursorPos = Math.max(0, Math.min(cursorPos, line.length));

      const ctx = parseCompletionContext(line, cursorPos, agent);
      const options = await completion.request(ctx, 200);
      SessionRegistry.sendSafe(ws, {
        type: S2C.COMPLETIONS,
        sessionId: msg.sessionId,
        requestId: msg.requestId ?? null,
        prefix: completionPrefix(line, cursorPos),
        options: options.map((o) => ({
          value: o.value,
          display: o.display ?? o.value,
        })),
      });
      break;
    }

    case C2S.TRANSCRIBE: {
      await handleTranscribe(ws, msg, registry.sttTarget);
      break;
    }

    case C2S.LIST_LOGS: {
      listSessionLogs()
        .then((logs) => {
          // Only return cold logs, not sessions that are still live.
          const activeIds = new Set(registry.list().map((s) => s.id));
          const coldLogs = logs
            .filter((log) => !activeIds.has(log.id))
            .map((log) => {
              // The index row carries the session's derived state (parked,
              // interrupted, ...) so the sidebar can badge it; missing row
              // (fresh log, unreconciled) simply has no state.
              const row = getSessionRow(log.id);
              return row ? { ...log, state: row.state } : log;
            });
          SessionRegistry.sendSafe(ws, {
            type: S2C.LOGS_LISTED,
            logs: coldLogs,
          });
        })
        .catch((err: unknown) => {
          SessionRegistry.sendSafe(ws, {
            type: S2C.ERROR,
            message: err instanceof Error ? err.message : String(err),
          });
        });
      break;
    }

    case C2S.LOAD_LOG: {
      // "Continue": resume the log under its OWN session id (identity is
      // preserved; the session keeps living in the same log). User-initiated,
      // so auto=false: the livelock cap never blocks an explicit resume, and
      // its resume_attempt records as manual. If the log is already live
      // (another tab on it), this is just an attach.
      if (msg.logId) {
        attachResumedSession(ws, registry, bridge, msg.logId as string, 0, false).catch(
          (err: unknown) => {
            logger.error(`[websocket] loadLog failed: ${formatError(err)}`);
            SessionRegistry.sendSafe(ws, {
              type: S2C.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
          },
        );
      }
      break;
    }

    case C2S.VIEW_LOG: {
      if (msg.logId) {
        readSessionEntries(msg.logId as string)
          .then((entries) => {
            // Log entries carry raw images; put them through the same wire cap so a huge base64 can't flood the socket.
            const capped = entries.map((entry) => {
              const imgs = wireImages(entry.images);
              if (!entry.images) return entry;
              return { ...entry, images: imgs };
            });
            SessionRegistry.sendSafe(ws, {
              type: S2C.LOG_VIEWED,
              logId: msg.logId,
              entries: capped,
            });
          })
          .catch((err: unknown) => {
            SessionRegistry.sendSafe(ws, {
              type: S2C.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
      break;
    }

    case C2S.DELETE_LOG: {
      if (msg.logId) {
        deleteSessionLog(msg.logId as string)
          .then((deleted) => {
            if (deleted) {
              SessionRegistry.sendSafe(ws, {
                type: S2C.LOG_DELETED,
                logId: msg.logId,
              });
              registry.broadcast({ type: S2C.LOG_DELETED, logId: msg.logId });
            } else {
              SessionRegistry.sendSafe(ws, {
                type: S2C.ERROR,
                message: `Log ${msg.logId} not found`,
              });
            }
          })
          .catch((err: unknown) => {
            SessionRegistry.sendSafe(ws, {
              type: S2C.ERROR,
              message: err instanceof Error ? err.message : String(err),
            });
          });
      }
      break;
    }

    default: {
      ws.send(
        JSON.stringify({
          type: S2C.ERROR,
          message: `Unknown message type: ${(msg as Record<string, unknown>).type}`,
        }),
      );
      break;
    }
  }
}

/** A blocked question outlives the socket that was showing it (tab
 *  refresh, session switch). Re-send after attach so the client
 *  renders the card again. */
function replayPendingQuestion(
  bridge: WebSocketQuestionBridge,
  sessionId: string,
  ws: HotdogServerSocket<unknown>,
): void {
  const questions = bridge.peek(sessionId);
  if (!questions) return;
  SessionRegistry.sendSafe(ws, {
    type: S2C.QUESTION,
    sessionId,
    questions,
  });
}

async function attachToMostRecentSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
  bridge: WebSocketQuestionBridge,
): Promise<void> {
  const sessions = registry.list();
  let mostRecent: { id: string; lastActivityAt: number } | null = null;
  let mostRecentTime = 0;
  for (const s of sessions) {
    if (s.lastActivityAt > mostRecentTime) {
      mostRecent = s;
      mostRecentTime = s.lastActivityAt;
    }
  }

  if (!mostRecent) {
    createAndAttachSession(ws, registry);
    return;
  }

  const attached = await attachLiveSession(ws, registry, bridge, mostRecent.id);
  if (!attached) createAndAttachSession(ws, registry);
}

/**
 * Reconnect identity from the upgrade URL: `?session=<id>[&cursor=<n>]`.
 * The id survives page reloads; the cursor (replay position) only the socket
 * generation. Invalid shapes fall back to the default attach.
 */
function parseResumeParams(url: URL): { sessionId: string; cursor: number } | null {
  const sessionId = url.searchParams.get("session");
  if (!sessionId) return null;
  const cursorRaw = url.searchParams.get("cursor");
  const cursor =
    cursorRaw !== null && /^\d+$/.test(cursorRaw) ? Number(cursorRaw) : 0;
  return { sessionId, cursor };
}

function createAndAttachSession(
  ws: HotdogServerSocket<unknown>,
  registry: SessionRegistry,
): void {
  registry
    .create({})
    .then(({ sessionId, agent }) => {
      const channel = registry.createChannel(sessionId, ws);
      ws.activeSessionId = sessionId;
      ws.activeChannel = channel;

      SessionRegistry.sendSafe(ws, {
        type: S2C.SESSION_CREATED,
        sessionId,
        profile: agent.profileName || "default",
        // Fresh session: no explicit title yet, display follows profile.
        title: null,
        currentModel: agent.model,
        models: Object.keys(agent.modelRegistry || {}),
        sttEnabled: registry.sttEnabled,
        toolExec: registry.toolExecLabel,
      });
      // The replay position for the next reconnect (0 = full replay), closing
      // the client's attach bookkeeping like every other attach path.
      SessionRegistry.sendSafe(ws, {
        type: S2C.SESSION_STATE,
        sessionId,
        key: "cursor",
        value: 0,
      });
      // Always empty here, but every attach path sends its snapshot.
      registry.sendTaskSnapshot(ws);
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, {
        type: S2C.ERROR,
        message: err instanceof Error ? err.message : String(err),
      });
      try {
        ws.close(4003, "Failed to create session");
      } catch {}
    });
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
