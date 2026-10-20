// The SessionRegistry: live session metadata, channels, connection/broadcast
// bookkeeping, the pending-auth map, idle cleanup, and the SIGTERM drain.
// Split out of server.ts, which keeps only the wiring.

import crypto from "node:crypto";
import { HOOKS, createHooks } from "@core/hooks.ts";
import { SessionManager, type AgentLike } from "@core/session/index.ts";
import { indexSessionModel } from "@core/session/session-index.ts";
import type { TurnLanes } from "@core/session/turn-lanes.ts";
import type { SwitchProfile } from "@core/config/profiles.ts";
import { WebSocketChannel } from "./websocket-channel.ts";
import { S2C, type TaskActivityWire } from "./protocol.ts";
import type { TaskManager } from "@core/session/task-manager.ts";
import type { LlmClient } from "@core/llm-client/client.ts";
import { execFenceDisplay, toolExecModeLabel, sharedToolExecDegraded } from "@core/tool-exec-broker.ts";
import type { Agent } from "@core/agent.ts";
import { AgentError } from "@core/error.ts";
import type { SttTarget } from "@core/config/stt.ts";
import type { HotdogServerSocket } from "./socket.ts";
import {
  DRAIN_POLL_MS,
  DRAIN_SETTLE_MS,
  DRAIN_TIMEOUT_MS,
  MAX_HOT_IDLE_SESSIONS,
  MAX_TASK_ACTIVITY_HISTORY_ITEMS,
  MAX_TASK_ACTIVITY_HISTORY_TASKS,
  PENDING_AUTH_TIMEOUT_MS,
} from "./constants.ts";

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
