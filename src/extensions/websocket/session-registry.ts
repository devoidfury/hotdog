// The SessionRegistry: the facade every websocket handler imports. Split
// its two concerns into sibling modules -- agent-sessions.ts (the session
// book: rows, birth kind, lifecycle, list projection, worker rows, the idle
// sweep, the drain) and channel-hub.ts (sockets, channels, broadcast
// scoping, pending-auth reap) -- and this class keeps its exported surface
// unchanged, delegating to the two, so no call site changed. The facade is
// transitional: handlers migrate to the collaborators batch by batch, and it
// dies when the last delegator does.

import type { ForkCut } from "@core/context/rewind.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { SwitchProfile } from "@core/config/profiles.ts";
import { type WebSocketChannel } from "./websocket-channel.ts";
import type { TaskManager } from "@core/session/task-manager.ts";
import type { WorkerSessionStartedInfo } from "@core/session/task-types.ts";
import type { LlmClient } from "@core/llm-client/client.ts";
import type { SttTarget } from "@core/config/stt.ts";
import type { HotdogServerSocket } from "./socket.ts";
import type { TurnLanes } from "@core/session/turn-lanes.ts";
import {
  AgentSessions,
  type CreateSessionOptions,
  type SessionMetadata,
  type SwitchProfileOptions,
} from "./agent-sessions.ts";
import { ChannelHub } from "./channel-hub.ts";

export interface SessionRegistryOptions {
  buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  llmClient?: LlmClient;
  // No questionTimeoutSecs/questionStrategy here by design: defaults resolve
  // at question-armed time (server.ts getPolicy), not as a per-session copy.
  sessionTimeoutMin?: number;
  profiles?: Record<string, SwitchProfile>;
  /** Resolved STT backend (explicit sttUrl or audio-capable registry model); advertised as sttEnabled. */
  sttTarget?: SttTarget | null;
  /** Invoked when a session is deleted (cancels its pending questions). */
  onSessionDeleted?: (sessionId: string) => void;
  /**
   * Resolved bag the tool-exec plane posture is read from. Pass the BAG for
   * a pinned snapshot (tests, embedded hosts) or a READER for a live strip
   * (the real server hands one over, so the label follows store.current()
   * per payload). Omitted = inline (unfenced): a registry built
   * without it advertises no plane.
   */
  toolExecResolved?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Provider-lane coordinator for session turns. Without it webui turns
   *  run uncoordinated: two live sessions double up requests on one backend
   *  instead of queueing on the lane. */
  turnLanes?: TurnLanes;
  /** Live stream-batch window reader (webui.streamBatchMs), handed to every
   *  channel the hub creates; per-frame read, so panel edits apply without a
   *  restart. Omitted = off (raw embedders keep today's byte behavior). */
  streamBatchMs?: () => number;
  /** Injectable stream-batch timer for deterministic tests. */
  streamBatchTimer?: (cb: () => void, ms: number) => () => void;
}

export class SessionRegistry {
  #sessions: AgentSessions;
  #hub: ChannelHub;

  constructor(options: SessionRegistryOptions) {
    // The two collaborators know each other only through these closures:
    // the book reaches the hub for channel teardown, its broadcasts, and the
    // pending-auth reaper on the sweep ticker; the hub reaches the book for
    // row lookups and the private SessionManager.
    this.#sessions = new AgentSessions({
      ...options,
      closeChannels: (sessionId) => this.#hub.closeChannels(sessionId),
      broadcast: (msg) => this.#hub.broadcast(msg),
      reapPendingAuth: () => this.#hub.reapPendingAuth(),
    });
    this.#hub = new ChannelHub({
      getSession: (sessionId) => this.#sessions.get(sessionId),
      getRow: (sessionId) => this.#sessions.getRow(sessionId),
      getSessionManager: () => this.#sessions.getSessionManager(),
      streamBatchMs: options.streamBatchMs,
      streamBatchTimer: options.streamBatchTimer,
    });
  }

  static sendSafe(ws: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    ChannelHub.sendSafe(ws, msg);
  }

  get sttTarget(): SttTarget | null {
    return this.#sessions.sttTarget;
  }

  get sttEnabled(): boolean {
    return this.#sessions.sttEnabled;
  }

  /**
   * Swap the resolved STT backend. Returns whether ENABLEDNESS flipped -- the
   * mic affordance is the only part clients track, so the caller pushes the
   * sessionState frame exactly when a repaint is warranted (a same-value
   * re-resolve must not spam every open panel).
   */
  setSttTarget(next: SttTarget | null): boolean {
    return this.#sessions.setSttTarget(next);
  }

  /** Tool-exec plane posture for the webui status strip (per-session). */
  toolExecLabel(sessionId: string): string {
    return this.#sessions.toolExecLabel(sessionId);
  }

  /** Publish the TaskManager whose observer feeds the webui subagent feed. */
  setTaskManager(taskManager: TaskManager | null): void {
    this.#sessions.setTaskManager(taskManager);
  }

  getTaskManager(): TaskManager | null {
    return this.#sessions.getTaskManager();
  }

  /** Send to sockets whose active session is `sessionId`: task traffic never crosses sessions. */
  broadcastScoped(sessionId: string, msg: Record<string, unknown>): void {
    this.#hub.broadcastScoped(sessionId, msg);
  }

  /** Current subagent task snapshot for one socket (sent when it attaches). */
  async sendTaskSnapshot(ws: HotdogServerSocket<unknown>): Promise<void> {
    await this.#sessions.sendTaskSnapshot(ws);
  }

  registerConnection(ws: HotdogServerSocket<unknown>): void {
    this.#hub.registerConnection(ws);
  }

  unregisterConnection(ws: HotdogServerSocket<unknown>): void {
    this.#hub.unregisterConnection(ws);
  }

  addPendingAuth(ws: HotdogServerSocket<unknown>): void {
    this.#hub.addPendingAuth(ws);
  }

  removePendingAuth(ws: HotdogServerSocket<unknown>): void {
    this.#hub.removePendingAuth(ws);
  }

  broadcast(msg: Record<string, unknown>): void {
    this.#hub.broadcast(msg);
  }

  /** Drain ONE socket's stream batches before a direct `ws.send` that can
   *  carry a transcript-committing frame (S2C.ERROR); see ChannelHub. */
  flushSocket(ws: HotdogServerSocket<unknown>): void {
    this.#hub.flushSocket(ws);
  }

  /**
   * Broadcast to every registered connection except one. The exclusion is
   * for the adopting socket, which already refreshed its sidebar.
   */
  broadcastExcept(except: HotdogServerSocket<unknown>, msg: Record<string, unknown>): void {
    this.#hub.broadcastExcept(except, msg);
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
    return this.#sessions.create({
      profile,
      model,
      questionStrategy,
      questionTimeoutSecs,
      sessionId,
    });
  }

  /**
   * Branch a registry session (webui `/fork`): SessionManager.forkSession plus UI-side metadata
   * for the new session. No prompt here on purpose -- the caller enqueues it after re-targeting
   * the requesting socket, so the prompt's user message echoes live exactly once and the history
   * replay snapshot never races it.
   */
  async fork(
    sourceSessionId: string,
    opts: { cut: ForkCut },
  ): Promise<{ sessionId: string; agent: AgentLike }> {
    return this.#sessions.fork(sourceSessionId, opts);
  }

  get(
    sessionId: string,
  ): { agent: AgentLike; metadata: SessionMetadata } | null {
    return this.#sessions.get(sessionId);
  }

  /** Raw row lookup INCLUDING worker rows (get() stays the live-agent
   *  oracle; worker rows read null there by design until the attach
   *  migration). */
  getRow(sessionId: string): SessionMetadata | null {
    return this.#sessions.getRow(sessionId);
  }

  /**
   * Register a worker's session row (born from the TaskManager's
   * onWorkerSessionStarted seam). Book-only: no private-SessionManager
   * entry, no bus, no run loop. Idempotent on a double event.
   */
  registerWorker(info: WorkerSessionStartedInfo): void {
    this.#sessions.registerWorker(info);
  }

  /** Re-title a cold-log adoption of a worker-attested id to the worker
   *  birth attributes (see AgentSessions.registerAdoptedWorker). */
  registerAdoptedWorker(
    sessionId: string,
    link: { taskId: string | null; parentSessionId: string | null; attest: boolean },
  ): void {
    this.#sessions.registerAdoptedWorker(sessionId, link);
  }

  /** Resolve the lineage cache feeding the live rows' `subagents` field
   *  (see AgentSessions.ensureLineageCache). */
  async ensureLineageCache(): Promise<void> {
    await this.#sessions.ensureLineageCache();
  }

  /**
   * Release a worker row at its task's terminal event (marks it terminal,
   * nulls the agent accessor; no channel force-close). Unknown sid is a
   * no-op; the idle sweep reclaims released rows that hold zero clients.
   */
  releaseWorker(workerSid: string): void {
    this.#sessions.releaseWorker(workerSid);
  }

  /** Live worker session (if any) attested to a task id (the re-dispatch
   *  guard's liveness probe; see AgentSessions.liveWorkerSessionForTask). */
  liveWorkerSessionForTask(taskId: string): string | null {
    return this.#sessions.liveWorkerSessionForTask(taskId);
  }

  list() {
    return this.#sessions.list();
  }

  delete(sessionId: string): boolean {
    return this.#sessions.delete(sessionId);
  }

  /** True if the session has at least one connected channel. */
  hasChannels(sessionId: string): boolean {
    return this.#hub.hasChannels(sessionId);
  }

  /** Watcher count for one session (ONE map lookup; the live-tail
   *  producer's zero-watcher gate reads this before any mapping). */
  channelCount(sessionId: string): number {
    return this.#hub.channelCount(sessionId);
  }

  /** Deliver one frame to the sockets attached to `sessionId` (the worker
   *  live-tail path; scope semantics per activeSessionId, see ChannelHub). */
  publish(sessionId: string, frame: Record<string, unknown>): void {
    this.#hub.publish(sessionId, frame);
  }

  /** Mirror the question bridge's pending state onto the row (sidebar
   *  awaiting_question badge). Returns whether the flag actually changed,
   *  so callers can broadcast the list only on real transitions. */
  setQuestionPending(sessionId: string, pending: boolean): boolean {
    return this.#sessions.setQuestionPending(sessionId, pending);
  }

  /**
   * Set the session's display title. Independent of the active profile: the
   * profile keeps driving behavior (tools, model), while the title is
   * purely the label shown in the UI.
   */
  rename(sessionId: string, newName: string): boolean {
    return this.#sessions.rename(sessionId, newName);
  }

  listProfiles(): Record<string, SwitchProfile> {
    return this.#sessions.listProfiles();
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
    return this.#sessions.switchProfile({ sessionId, profileName });
  }

  createChannel(
    sessionId: string,
    ws: HotdogServerSocket<unknown>,
  ): WebSocketChannel | undefined {
    return this.#hub.createChannel(sessionId, ws);
  }

  removeChannel(sessionId: string, channel: WebSocketChannel): void {
    this.#hub.removeChannel(sessionId, channel);
  }

  // Prevents idle cleanup of the session.
  touch(sessionId: string): void {
    this.#sessions.touch(sessionId);
  }

  startCleanupLoop(timeoutMin: number): void {
    this.#sessions.startCleanupLoop(timeoutMin);
  }

  stopCleanupLoop(): void {
    this.#sessions.stopCleanupLoop();
  }

  /**
   * SIGTERM commit-point drain. In-flight turns get up to `timeoutMs` to
   * reach their next fsynced commit point; anything still running after the
   * window is interrupted (aborted mid-LLM, so no partial stream persists;
   * a started tool call replays as outcome-unknown). Queued messages that
   * never reached a turn were never logged -- honest loss.
   */
  async drainSessions(timeoutMs?: number): Promise<void> {
    await this.#sessions.drainSessions(timeoutMs);
  }

  get size(): number {
    return this.#sessions.size;
  }

  /** @internal */
  getSessionManager() {
    return this.#sessions.getSessionManager();
  }

  /** @internal */
  get _test_metadata(): Map<string, SessionMetadata> {
    return this.#sessions._test_metadata;
  }

  /** @internal */
  get _test_pendingAuth(): Map<HotdogServerSocket<unknown>, number> {
    return this.#hub._test_pendingAuth;
  }

  /** @internal */
  _test_cleanupIdleSessions(): void {
    this.#sessions._test_cleanupIdleSessions();
    this.#hub.reapPendingAuth();
  }
}
