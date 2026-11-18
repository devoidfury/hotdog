// The session book: live session rows (metadata + birth kind), the list
// projection, the question-badge mirror, the idle sweep, and the SIGTERM
// drain. Split out of session-registry.ts (B1): a row
// is now an addressable entity that exists with or without sockets and with
// or without a private-SessionManager entry -- transport lives in
// channel-hub.ts, and SessionRegistry stays the facade every handler
// imports.
//
// Row kinds (the B1 birth attribute): rows created by create()/fork() are
// INTERACTIVE (the attribute stays absent -- interactive is the default, so
// every pre-B1 read path is byte-identical). Worker rows are born at
// registerWorker (a task agent's build) and die at releaseWorker (the task's
// terminal event); they never enter the private SessionManager (no bus, no
// run loop -- getBus(workerSid) stays undefined, keeping the manager-side
// oracle honest) and never surface in the interactive projection (list(),
// size), so the SESSIONS payload and the fallback attach can never see one.

import crypto from "node:crypto";
import { HOOKS, createHooks } from "@core/hooks.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import type { ForkCut } from "@core/context/rewind.ts";
import { SessionManager, type AgentLike } from "@core/session/index.ts";
import { indexSessionModel, indexUserInput, getSessionRow } from "@core/session/session-index.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { trySessionPath } from "@core/session/session-log.ts";
import { getPinnedIds } from "./pin-store.ts";
import type { TurnLanes } from "@core/session/turn-lanes.ts";
import type { SwitchProfile } from "@core/config/profiles.ts";
import { S2C } from "./protocol.ts";
import { taskWire, taskLineageWire } from "./wire-messages.ts";
import type { TaskManager } from "@core/session/task-manager.ts";
import type { WorkerSessionStartedInfo } from "@core/session/task-types.ts";
import type { LlmClient } from "@core/llm-client/client.ts";
import { sharedExecFenceDisplay, toolExecModeLabel, sharedToolExecDegraded } from "@core/tool-exec-broker.ts";
import {
  getRecordCount,
  seedRecordCount,
} from "@extensions/session-log/record-count.ts";
import type { Agent } from "@core/agent.ts";
import { AgentError } from "@core/error.ts";
import type { SttTarget } from "@core/config/stt.ts";
import type { HotdogServerSocket } from "./socket.ts";
import { ChannelHub } from "./channel-hub.ts";
import {
  DRAIN_POLL_MS,
  DRAIN_SETTLE_MS,
  DRAIN_TIMEOUT_MS,
  MAX_HOT_IDLE_SESSIONS,
  MAX_SUBAGENT_LINEAGE_ROWS,
} from "./constants.ts";

export interface SessionMetadata {
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
  /**
   * EXPLICIT per-session question policy (C2S create message). Unset means
   * "no explicit choice": the defaults are read at question-armed time
   * (createWsServer's getPolicy, through the live surface) -- a session row
   * never freezes a boot copy of them (B3). An armed question keeps the
   * policy its timer was armed with (P8 benign twin).
   */
  questionStrategy?: string;
  questionTimeoutSecs?: number;
  /**
   * Last token_usage snapshot (per-call totalTokens + contextWindow), the
   * same numbers the chat token bubble shows. Cached for the sidebar's ctx
   * segment; absent until the session's first usage event.
   */
  ctxUsed?: number;
  ctxTotal?: number;
  /** A pending question from the websocket question bridge is blocking this
   *  session (sidebar badges the card awaiting_question). Absent = false;
   *  kept in step by the bridge hooks via setQuestionPending. */
  questionPending?: boolean;
  /**
   * Birth attribute (B1). ABSENT reads as "interactive": create()/fork()
   * never write it, so every pre-B1 path reads exactly as before. "worker"
   * rows are task-agent sessions registered through registerWorker --
   * book-only rows (no private-SessionManager entry, no bus, no run loop),
   * invisible to the interactive projection and to the handler-facing
   * mutation APIs.
   */
  kind?: "interactive" | "worker";
  /** Worker rows only (D4): the TaskManager task id. DISTINCT from the
   *  worker sid (the row key / entry.agentSessionId) and parentSessionId --
   *  the three ids are never conflated. */
  taskId?: string;
  /** Worker rows only (D4): the delegating manager's entry.sessionId
   *  (null: session-less/engine spawn). */
  parentSessionId?: string | null;
  /** Worker rows only: set by releaseWorker at the task's terminal event.
   *  The sweep NEVER reclaims a non-terminal worker row (a watched-by-nobody
   *  worker is the NORMAL state, R2 -- the client metric is an
   *  interactive-sessions policy), and a released row sweeps free of the
   *  hot-idle exemption. */
  workerTerminal?: boolean;
  /** Worker rows only: an ACCESSOR over the LIVE task entry's agent (not a
   *  raw handle), null after releaseWorker. The accessor goes null on its
   *  own once finalizeTurn nulls entry.agent (task-execution.ts) -- matching
   *  the TaskEntry contract that the log becomes the only transcript source. */
  getAgent?: (() => AgentLike | null) | null;
  /** Worker rows only: unsubscribes the usage mirror. Worker sessions never
   *  enter the private manager's event bus, so no deleteSession ever runs
   *  for them -- releaseWorker must clean the subscription up itself. */
  offUsage?: (() => void) | null;
}

export interface CreateSessionOptions {
  profile?: string;
  model?: string;
  questionStrategy?: string;
  questionTimeoutSecs?: number;
  /** Adopt an existing session id (cold-log resume keeps its identity). */
  sessionId?: string;
}

export interface SwitchProfileOptions {
  sessionId: string;
  profileName: string;
}

export interface AgentSessionsOptions {
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
   * per payload -- B3). Omitted = inline (unfenced): a registry built
   * without it advertises no plane.
   */
  toolExecResolved?: Record<string, unknown> | (() => Record<string, unknown>);
  /** Provider-lane coordinator for session turns. Without it webui turns
   *  run uncoordinated: two live sessions double up requests on one backend
   *  instead of queueing on the lane. */
  turnLanes?: TurnLanes;
  /** Transport hooks the facade wires to the ChannelHub: channel teardown for
   *  the delete path, the broadcast used by the title mirror, and the
   *  pending-auth reaper sharing the sweep ticker. */
  closeChannels: (sessionId: string) => void;
  broadcast: (msg: Record<string, unknown>) => void;
  reapPendingAuth: () => void;
}

export class AgentSessions {
  #sessionManager: SessionManager;
  #buildAgent: (config: {
    model?: string;
    sessionId?: string;
    profileName?: string;
  }) => Promise<AgentLike>;
  #cleanupTimer: ReturnType<typeof setInterval> | null = null;
  #timeoutMin: number;
  #metadata: Map<string, SessionMetadata>;
  #profiles: Record<string, SwitchProfile>;
  #onSessionDeleted: ((sessionId: string) => void) | null;
  #taskManager: TaskManager | null = null;
  #closeChannels: (sessionId: string) => void;
  #broadcast: (msg: Record<string, unknown>) => void;
  #reapPendingAuth: () => void;
  /** Resolved STT backend; every sessionCreated payload advertises its presence as sttEnabled.
   *  Re-pointable: a config write to sttUrl/sttModel re-resolves and swaps it here, so the
   *  NEXT upload (handlers-transcribe.ts reads this per request) and the next attach see the
   *  new backend while an upload already in flight keeps the target it started with. */
  #sttTarget: SttTarget | null;
  #getToolExecResolved: () => Record<string, unknown>;

  get sttTarget(): SttTarget | null {
    return this.#sttTarget;
  }

  get sttEnabled(): boolean {
    return this.#sttTarget !== null;
  }

  /**
   * Swap the resolved STT backend. Returns whether ENABLEDNESS flipped -- the
   * mic affordance is the only part clients track, so the caller pushes the
   * sessionState frame exactly when a repaint is warranted (a same-value
   * re-resolve must not spam every open panel).
   */
  setSttTarget(next: SttTarget | null): boolean {
    const before = this.#sttTarget !== null;
    this.#sttTarget = next;
    return before !== (next !== null);
  }

  /**
   * Tool-exec plane posture for the webui status strip, resolved PER SESSION:
   * the label describes the session the client is attached to, so its runtime
   * `/fence` override (if any) is what the strip shows -- sessions that never
   * toggled follow the boot config. Read per payload so the degraded flag is
   * current at attach time. A live toggle pushes the new label to this
   * session's clients (C2S execFence answers with a sessionState key
   * "toolExec" via broadcastScoped, built from this method), and the next
   * attach or session switch re-reads it.
   */
  toolExecLabel(sessionId: string): string {
    // Plane keys read PER PAYLOAD through the injected source: with a reader
    // (the real server's wiring) a swapped generation changes the label of
    // the NEXT payload -- the strip no longer holds the boot bag ref.
    const resolved = this.#getToolExecResolved();
    return toolExecModeLabel(
      resolved,
      sharedToolExecDegraded(),
      sharedExecFenceDisplay(sessionId, resolved),
    );
  }

  /** Publish the TaskManager whose observer feeds the webui subagent feed. */
  setTaskManager(taskManager: TaskManager | null): void {
    this.#taskManager = taskManager;
  }

  getTaskManager(): TaskManager | null {
    return this.#taskManager;
  }

  /** Current subagent task snapshot for one socket (sent when it attaches to a
   * session): this lifetime's tasks, plus the sidecar-rebuilt durable rows for
   * managers whose tasks predate a restart (taskLineageWire owns their honest
   * grammar). Awaited: the sidecar read is real I/O (once-cached per process). */
  async sendTaskSnapshot(ws: HotdogServerSocket<unknown>): Promise<void> {
    const sessionId = ws.activeSessionId;
    if (!sessionId || !this.#taskManager) return;
    const live = this.#taskManager
      .listTasks()
      .filter((t) => t.sessionId === sessionId)
      .map(taskWire);
    const durable = (await this.#taskManager.lineageTasks())
      .filter((r) => r.sessionId === sessionId)
      .slice(-MAX_SUBAGENT_LINEAGE_ROWS)
      .map(taskLineageWire);
    ChannelHub.sendSafe(ws, {
      type: S2C.TASK_LIST,
      tasks: [...live, ...durable],
    });
  }

  constructor({
    buildAgent,
    llmClient,
    sessionTimeoutMin = 30,
    profiles = {},
    sttTarget = null,
    onSessionDeleted,
    turnLanes,
    toolExecResolved = {},
    closeChannels,
    broadcast,
    reapPendingAuth,
  }: AgentSessionsOptions) {
    this.#buildAgent = buildAgent;
    this.#timeoutMin = sessionTimeoutMin;
    this.#sttTarget = sttTarget;
    this.#getToolExecResolved =
      typeof toolExecResolved === "function"
        ? toolExecResolved
        : () => toolExecResolved ?? {};
    this.#metadata = new Map();
    this.#profiles = profiles;
    this.#onSessionDeleted = onSessionDeleted ?? null;
    this.#closeChannels = closeChannels;
    this.#broadcast = broadcast;
    this.#reapPendingAuth = reapPendingAuth;

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
      // Explicit caller values only (unset = resolve at question-armed time);
      // the old per-session copy of the host defaults froze the boot values.
      questionStrategy,
      questionTimeoutSecs,
    });

    this.#sessionManager.registerAgent(agent, {
      // Build-config shape (profileName, not profile): forkSession reuses this entry
      // metadata as the fork's buildAgent config, so the keys must match what #buildAgent reads.
      profileName: profile || "default",
      model,
    });

    // Seed the writer-side record count from the existing log ONCE (cold-log
    // adoption brings its file; a fresh id seeds 0). The sidebar's live-row
    // messageCount then rides the append chokepoint (record-count.ts), never
    // a registry-side tally -- parity with the cold rows is structural.
    await seedRecordCount(actualSessionId);

    this.#trackModelChanges(actualSessionId);
    this.#trackUsage(actualSessionId);
    this.#trackUserInput(actualSessionId);
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
    opts: { cut: ForkCut },
  ): Promise<{ sessionId: string; agent: AgentLike }> {
    const meta = this.#metadata.get(sourceSessionId);
    // A worker row is not a forkable session: the birth attribute gates the
    // same "unknown session" refusal the pre-B1 world gave an arbitrary id
    // (and a worker has no manager entry to fork anyway).
    if (!meta || meta.kind === "worker") {
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
      // No count to carry: the fork's log starts empty and the kept messages
      // ride addMessage -> CONTEXT_MESSAGE -> the writer chokepoint, which
      // counts them into the fork's own tally as they land.
    });

    this.#trackModelChanges(newSessionId);
    this.#trackUsage(newSessionId);
    this.#trackUserInput(newSessionId);
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

  /**
   * Mirror live user input into the index title (set-once: the first
   * title-worthy message wins). CONTEXT_MESSAGE fires on every addMessage,
   * cold-resume replay included; the title IS NULL guard makes replays
   * honest no-ops that never clobber and never rebroadcast. Harness-role
   * messages (tool results, system injections) must NOT title: only what
   * the user asked becomes the headline. A real set broadcasts the sessions
   * list (the sidebar-refresh idiom) so the row gains its middle line live.
   */
  #trackUserInput(sessionId: string): void {
    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (!agent || !agent.hooks || typeof agent.hooks.on !== "function") return;
    agent.hooks.on(
      HOOKS.CONTEXT_MESSAGE,
      ({ message }: { message?: { role?: unknown; content?: unknown } }) => {
        if (message?.role !== "user") return;
        try {
          if (indexUserInput(sessionId, message.content)) {
            this.#broadcast({ type: S2C.SESSIONS, sessions: this.list() });
          }
        } catch (err) {
          logger.error(`[websocket] live title mirror failed: ${formatError(err)}`);
        }
      },
    );
  }

  /**
   * Cache the last token_usage snapshot per session for the sidebar's ctx
   * segment (used = the call's totalTokens -- the number the chat bubble
   * shows; total = contextWindow). Subscribed on the session event bus, so
   * cold-resume replays seed it too; deleteSession drops the subscription
   * with the session.
   */
  #trackUsage(sessionId: string): () => void {
    return this.#sessionManager.onSessionEvents(sessionId, (event) => {
      if (event.type !== OUTPUT_EVENT.TOKEN_USAGE) return;
      const meta = this.#metadata.get(sessionId);
      if (!meta) return;
      meta.ctxUsed = event.totalTokens || 0;
      if (typeof event.contextWindow === "number" && Number.isFinite(event.contextWindow)) {
        meta.ctxTotal = event.contextWindow;
      }
    });
  }

  /**
   * The LIVE-session oracle: a row whose agent is registered with the
   * private SessionManager. Worker rows read null here by design (they are
   * book-only), which is exactly what keeps every get()-gated handler
   * refusing a worker sid with the pre-B1 "Session not found" posture.
   */
  get(
    sessionId: string,
  ): { agent: AgentLike; metadata: SessionMetadata } | null {
    const metadata = this.#metadata.get(sessionId);
    if (!metadata) return null;
    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    if (!agent) return null;
    return { agent, metadata };
  }

  /** Raw row lookup INCLUDING worker rows (the interactive projection stays
   *  list()/size; this is the row-kind-aware accessor's B1 home -- the
   *  server's getPolicy worker branch reads it). */
  getRow(sessionId: string): SessionMetadata | null {
    return this.#metadata.get(sessionId) ?? null;
  }

  /**
   * Register a worker's session row (B1): the task agent's birth in the
   * session book, fired from the TaskManager's onWorkerSessionStarted seam
   * (the recordAgentSession site -- entry.agent in hand before the first
   * turn, so the row exists before any question can arm). Book-only:
   * registers NOTHING with the private SessionManager -- no bus, no run
   * loop; getBus(workerSid) stays undefined. Idempotent on a double event.
   */
  registerWorker(info: WorkerSessionStartedInfo): void {
    if (this.#metadata.has(info.workerSid)) return;
    const agent = info.getAgent();
    this.#metadata.set(info.workerSid, {
      profile: info.profile || "default",
      title: null,
      model: agent?.model || "",
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      connectedClients: 0,
      kind: "worker",
      // D4 linkage: DISTINCT ids, never conflated -- the row key itself is
      // the worker sid (entry.agentSessionId).
      taskId: info.taskId,
      parentSessionId: info.managerSid,
      // The ACCESSOR (not a raw handle) reads the live entry: it goes null
      // when finalizeTurn releases the agent, so a terminal row never pins a
      // dead context (the log becomes the only transcript source).
      getAgent: info.getAgent,
    });
    // Seed the writer-side record count (the append chokepoint already
    // counts worker sessions; this seeds the base the same way create()'s
    // does -- a missing log seeds 0). Fire-and-forget: the seam callback is
    // synchronous inside task launch.
    void seedRecordCount(info.workerSid);
    // The usage mirror, same subscribe idiom as interactive rows. Workers
    // never enter the manager's event bus today, so this stays inert until
    // the live-tail producer publishes through it; releaseWorker
    // unsubscribes (no deleteSession ever runs for a worker).
    const off = this.#trackUsage(info.workerSid);
    const row = this.#metadata.get(info.workerSid);
    if (row) row.offUsage = off;
  }

  /**
   * Release a worker row at its task's terminal event. MARKS the row
   * terminal and nulls the agent accessor; it does NOT force-close watcher
   * channels (frames simply stop -- a pane mid-read must not get yanked) and
   * does NOT delete the row (the idle sweep reclaims terminal worker rows
   * that hold zero clients). Unknown sid and non-worker rows are no-ops.
   */
  releaseWorker(workerSid: string): void {
    const meta = this.#metadata.get(workerSid);
    if (!meta || meta.kind !== "worker") return;
    if (meta.workerTerminal) return;
    meta.workerTerminal = true;
    meta.getAgent = null;
    // Unsubscribe the usage mirror; the manager's unsubscribe reclaims the
    // #eventHandlers key once the set empties (no dead key per worker).
    meta.offUsage?.();
    meta.offUsage = null;
  }

  list(): Array<{
    id: string;
    profile: string;
    title: string | null;
    model: string;
    createdAt: number;
    lastActivityAt: number;
    connectedClients: number;
    /**
     * Conversation message count (the sidebar metric): the session-log
     * writer's committed-record tally -- what listSessionLogs reports for
     * this session's file at this moment (same rule: only user input and
     * model responses count; tool traffic and bookkeeping records never do).
     * Omitted while the count is unknowable (a failed seed), never
     * fabricated.
     */
    messageCount?: number;
    ctxUsed?: number;
    ctxTotal?: number;
    /** Server-persisted sidebar pin (pin-store.ts); always present so a
     *  payload rebuilds the client's pin marks outright. */
    pinned: boolean;
    /** True while a pending question blocks the session (sidebar badge);
     *  always present, same rebuild-outright rule as pinned. */
    questionPending: boolean;
    /** Absolute JSONL log path (sidebar "Copy log file path"); omitted when
     *  the id fails the core path helper's safety gate. */
    logPath?: string;
  }> {
    const result: Array<{
      id: string;
      profile: string;
      title: string | null;
      model: string;
      createdAt: number;
      lastActivityAt: number;
      connectedClients: number;
      messageCount?: number;
      ctxUsed?: number;
      ctxTotal?: number;
      pinned: boolean;
      questionPending: boolean;
      logPath?: string;
    }> = [];
    const pinnedIds = getPinnedIds();
    for (const [id, meta] of this.#metadata) {
      // R4 projection: worker rows are nested under their task, never
      // top-level rows. The exclusion happens HERE, so the SESSIONS payload,
      // attachToMostRecentSession, and every list() consumer never see one.
      if (meta.kind === "worker") continue;
      const agent = this.#sessionManager.getAgentBySessionId(id);
      const logPath = trySessionPath(id);
      const recordCount = getRecordCount(id);
      result.push({
        id,
        profile: meta.profile,
        // Priority chain: rename (in-memory meta) > derived (index row) >
        // nothing. Renames stay in-memory only, exactly as before.
        title: meta.title ?? getSessionRow(id)?.title ?? null,
        model: agent?.model || meta.model,
        createdAt: meta.createdAt,
        lastActivityAt: meta.lastActivityAt,
        connectedClients: meta.connectedClients,
        ...(recordCount !== undefined ? { messageCount: recordCount } : {}),
        ...(meta.ctxUsed !== undefined ? { ctxUsed: meta.ctxUsed } : {}),
        ...(meta.ctxTotal !== undefined ? { ctxTotal: meta.ctxTotal } : {}),
        pinned: pinnedIds.has(id),
        questionPending: meta.questionPending === true,
        ...(logPath !== undefined ? { logPath } : {}),
      });
    }
    return result;
  }

  delete(sessionId: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta) return false;
    // A worker row's lifecycle belongs to the TaskManager, not this book:
    // delete() reads exactly like the pre-B1 "unknown id" refusal for one
    // (the terminal observer releases it; B3's refusal table formalizes it).
    if (meta.kind === "worker") return false;

    this.#closeChannels(sessionId);

    // The manager owns a private hook system, so its delete notice never
    // reaches extensions; re-fire it on the agent's (shared) hooks so
    // per-session extension state and tool-exec pool entries are reclaimed
    // when the session dies -- the same contract deleteSession promises on
    // hosts whose manager shares core.hooks. Fire-and-forget, after the
    // removal, mirroring task-execution's terminal-then-notify ordering.
    const agent = this.#sessionManager.getAgentBySessionId(sessionId);
    this.#sessionManager.deleteSession(sessionId);
    agent?.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId });
    // The registry's SessionManager is built without taskConfig (this host's
    // TaskManager is the published one), so its delete cascade cannot reach
    // the tasks -- interrupt them here or a deleted session's delegates run
    // forever with nobody to receive results.
    this.#taskManager?.interruptTasksForSession(sessionId);
    this.#metadata.delete(sessionId);
    this.#onSessionDeleted?.(sessionId);
    return true;
  }

  /** Mirror the question bridge's pending state onto the row (sidebar
   *  awaiting_question badge). Returns whether the flag actually changed,
   *  so callers can broadcast the list only on real transitions.
   *  Worker rows read as immutable here: their badge is B2's nested task-row
   *  questionPending (mirroring a hidden row would add a pointless SESSIONS
   *  broadcast frame -- B1's zero-behavior-change bar). */
  setQuestionPending(sessionId: string, pending: boolean): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta || meta.kind === "worker") return false;
    if (Boolean(meta.questionPending) === pending) return false;
    meta.questionPending = pending;
    return true;
  }

  /**
   * Set the session's display title. Independent of the active profile: the
   * profile keeps driving behavior (tools, model), while the title is
   * purely the label shown in the UI.
   */
  rename(sessionId: string, newName: string): boolean {
    const meta = this.#metadata.get(sessionId);
    if (!meta || meta.kind === "worker") return false;
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
    if (!meta || meta.kind === "worker") {
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

  // Prevents idle cleanup of the session.
  touch(sessionId: string): void {
    const meta = this.#metadata.get(sessionId);
    // Worker rows never ride the interactive activity clock: their birth/
    // release lifecycle owns them, and the sweep guard below ignores their
    // age while non-terminal anyway.
    if (meta && meta.kind !== "worker") {
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
    // The hot window is an INTERACTIVE policy: worker rows never consume a
    // slot, are NEVER reclaimed while their task is non-terminal (a
    // watched-by-nobody worker is the NORMAL state, R2 -- connectedClients
    // is not a worker-reclaim signal), and a RELEASED (terminal) worker row
    // sweeps free of the hot exemption -- a settled worker returns only
    // through cold-log Continue-adoption, so the hot-agent rationale does
    // not apply to it.
    const staleInteractive = stale.filter(([, meta]) => meta.kind !== "worker");
    const staleWorkers = stale.filter(
      ([, meta]) => meta.kind === "worker" && meta.workerTerminal === true,
    );
    // Keep the recent few hot (the in-memory agent makes a return visit
    // instant). Older ones go cold (log-only); logs are never deleted here.
    for (const [id] of staleInteractive.slice(MAX_HOT_IDLE_SESSIONS)) this.delete(id);
    for (const [id] of staleWorkers) this.#reclaimWorker(id);
  }

  /** Reclaim a released worker row: drop the book entry (and any channel
   *  set, though the zero-client sweep gate means there is none). No private-
   *  manager teardown (the worker was never registered there), no SESSION_END
   *  re-fire (finalizeTurn already fired it on the agent's shared hooks), no
   *  task interrupt (the task is terminal). */
  #reclaimWorker(sessionId: string): void {
    this.#closeChannels(sessionId);
    this.#metadata.delete(sessionId);
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

  get size(): number {
    // The interactive projection, same rule as list(): a worker row is never
    // counted, so the attach fallback (registry.size > 0) never treats a
    // lone unwatched worker as "there is a session to attach to".
    let interactive = 0;
    for (const meta of this.#metadata.values()) {
      if (meta.kind !== "worker") interactive++;
    }
    return interactive;
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
  _test_cleanupIdleSessions(): void {
    this.#cleanupIdleSessions();
  }
}
