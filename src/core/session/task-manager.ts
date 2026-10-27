import { logger } from "@utils/logger.ts";
import { HOOKS } from "../hooks.ts";
import { Message } from "../context/message.ts";
import type { OutputEvent } from "../context/output.ts";
import { formatError } from "../error.ts";
import { ProfileManager } from "../config/profiles.ts";
import { type CoreConfigWithExtensions } from "../config/schema-loader.ts";
import type { ProviderDef } from "../config/providers.ts";
import {
  laneKeyOf,
  makeLaneCaps,
  makeRunningPeeker,
} from "./model-resolver.ts";
import { LaneLedger } from "./lane-ledger.ts";
import { SpawnLog, type OrphanedTask } from "./spawn-log.ts";
import { resolveLanesRetryMs } from "./turn-lanes.ts";
import { makeProviderHealth, type ProviderHealth } from "./provider-health.ts";
import { TaskScheduler } from "./task-scheduler.ts";
import { TaskExecution } from "./task-execution.ts";
import type { AgentLike } from "./index.ts";

import {
  TASK_STATUS,
  MAX_TERMINAL_TASKS,
  TaskHandle,
  describeTask,
  isTerminalStatus,
  type TaskStatus,
  type TaskInfo,
  type TaskObserverEvent,
  type TaskObserver,
  type TurnResult,
  type TaskCompletion,
  type TurnPrompt,
  type TaskEntry,
  type SpawnPlan,
  type SpawnTaskOptions,
  type TaskManagerOptions,
  type TaskManagerRequiredOptions,
  type TaskManagerSessionManager,
} from "./task-types.ts";


export class TaskManager {
  #buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  #config: CoreConfigWithExtensions;
  #sessionManager: TaskManagerSessionManager | null;
  #maxIterations: number;
  /** Lane placement + admission for spawned tasks (caps, ledger, planning, health). */
  #scheduler: TaskScheduler;
  /** Turn execution for started tasks (build, drive, finalize). */
  #execution: TaskExecution;
  // Terminal tasks keep a slim record (no agent) so a long-lived manager --
  // the webui TaskManager outlives every session -- does not pin each dead
  // task's full Agent/context forever. See #finalizeTurn for the release point.
  // The slim records are themselves bounded: only the most recent
  // MAX_TERMINAL_TASKS terminal entries survive (see #evictTerminalTasks).
  #tasks: Map<string, TaskEntry>;
  /** Restart sidecar for delegate_task records (null: disabled). */
  #spawnLog: SpawnLog | null;
  #profileManager: ProfileManager | undefined;
  /** External observer (websocket/webui relay); null = task agents stay silent. */
  #observer: TaskObserver | null = null;
  /** Follow-up -> pending-question answer seam (null: plain steer only). */
  #resolvePendingQuestion: ((sessionId: string, text: string) => boolean) | null;

  constructor(options: TaskManagerOptions & TaskManagerRequiredOptions) {
    this.#buildAgent = options.buildAgent;
    const modelRegistry = options.modelRegistry || {};
    this.#config = options.config || {};
    this.#sessionManager = options.sessionManager || null;
    this.#maxIterations = options.maxIterations;
    const providerDefs =
      ((options.config as Record<string, unknown>).providers as ProviderDef[]) ?? [];
    const peekLoaded =
      options.runningPeek ??
      makeRunningPeeker(providerDefs, {
        baseUrl: (options.config as Record<string, unknown>).baseUrl as string | undefined,
        apiKey: (options.config as Record<string, unknown>).apiKey as string | undefined,
      });
    // modelGroups / noSpread ride the resolved config bag, same as providers.
    const modelGroups =
      ((options.config as Record<string, unknown>).modelGroups as Record<string, string[]>) ?? {};
    // Per-lane caps: the global lanesPerProvider (taskLanesPerProvider) is the  fleet default;
    // a numeric provider taskLanes overrides it for that lane only. Both normalize below 1 to unlimited (shared with session turns).
    const laneCaps = makeLaneCaps(options.lanesPerProvider, providerDefs);
    const buildDefaultModel =
      typeof options.defaultModel === "string" ? options.defaultModel.trim() : "";
    const noSpread = new Set(
      providerDefs
        .filter((p) => (p as { noSpread?: boolean }).noSpread === true)
        .map((p) => p.name),
    );
    const lanes = options.lanesDir ? new LaneLedger({ dir: options.lanesDir }) : null;
    logger.debug(
      `[lanes] TaskManager placement: lanesPerProvider=${options.lanesPerProvider ?? "unset(=unlimited)"} ` +
        `lanesDir=${options.lanesDir ?? "unset(=process-local caps only)"} ` +
        `providerOverrides=${
          providerDefs
            .filter((p) => typeof (p as { taskLanes?: unknown }).taskLanes === "number")
            .map((p) => `${p.name}=${(p as { taskLanes?: number }).taskLanes}`)
            .join(",") || "none"
        }`,
    );
    const lanesRetryMs = resolveLanesRetryMs(options);
    this.#tasks = new Map();
    this.#spawnLog = options.spawnLogPath
      ? new SpawnLog(options.spawnLogPath, options.spawnLogPidAlive)
      : null;
    this.#profileManager = options.profileManager;
    this.#resolvePendingQuestion = options.resolvePendingQuestion ?? null;
    // One health registry per manager: explicit injection wins (shared / test seams),
    // explicit null opts out, otherwise build one. The interval gates only the
    // TIMER inside makeProviderHealth, so a 0 interval keeps failure-driven demotion
    // and placement filtering alive. The recovered callback re-admits queued tasks when
    // a provider comes back -- nothing else calls the admit scan on a pure health transition.
    const providerHealth =
      options.providerHealth !== undefined
        ? options.providerHealth
        : makeProviderHealth({
            providers: providerDefs,
            globals: {
              baseUrl: options.config.baseUrl,
              apiKey: options.config.apiKey,
            },
            intervalMs: (options.healthIntervalSecs ?? 0) * 1000,
            timeoutMs: (options.healthCheckTimeoutSecs ?? 5) * 1000,
            modelRegistry,
            contextLimit: options.healthContextLimit,
            onRecover: () => this.#scheduler.retryQueued(),
          });
    this.#scheduler = new TaskScheduler({
      env: {
        tasks: () => this.#tasks.values(),
        sessionManager: () => this.#sessionManager,
      },
      taskProfile: options.taskProfile,
      profileManager: options.profileManager,
      // The scheduler's profile-file branch needs the resolved profiles dir;
      // the explicit option wins, else the value riding the config bag.
      profilesPath: options.profilesPath ?? this.#config.profilesPath,
      modelRegistry,
      laneCaps,
      buildDefaultModel,
      peekLoaded,
      modelGroups,
      noSpread,
      lanes,
      lanesRetryMs,
      providerHealth,
    });
    this.#execution = new TaskExecution({
      setStatus: (entry, status) => this.#setStatus(entry, status),
      notifyTask: (entry) => this.#notify({ kind: "task", task: this.#infoOf(entry) }),
      buildAgent: (config) => this.#buildAgent(config),
      scheduler: this.#scheduler,
    });
  }

  setSessionManager(sessionManager: TaskManagerSessionManager): void {
    this.#sessionManager = sessionManager;
  }

  /** The health registry this manager consults for placement (null when the feature is off). */
  get providerHealth(): ProviderHealth | null {
    return this.#scheduler.providerHealth;
  }

  /**
   * Re-run the admission pass (health recovery callback, tests). Clears
   * lane-blocked flags too: a provider coming back invalidates every "whole
   * candidate set fleet-wide busy" verdict, exactly like a lanes-retry tick --
   * still-full lanes just re-block themselves on the next pass.
   */
  retryQueued(): void {
    this.#scheduler.retryQueued();
  }

  /** Release the health sweep timer, if this manager built one. */
  stop(): void {
    this.#scheduler.stop();
  }

  /**
   * Attach (or detach with null) the per-task observer. Late attaches receive nothing retroactively;
   * callers wanting history use listTasks().
   */
  setObserver(observer: TaskObserver | null): void {
    this.#observer = observer;
  }

  #notify(event: TaskObserverEvent): void {
    const observer = this.#observer;
    if (!observer) return;
    try {
      observer(event);
    } catch (e: unknown) {
      // A faulty relay (e.g. a closed socket serializer) must not disturb
      // task execution.
      const id = event.kind === "task" ? event.task.taskId : event.taskId;
      logger.error(`[task ${id}] task observer threw: ${formatError(e)}`);
    }
  }

  #infoOf(entry: TaskEntry): TaskInfo {
    return {
      taskId: entry.taskId,
      description: entry.description,
      sessionId: entry.sessionId,
      status: entry.statusRef.value,
      createdAt: entry.createdAt,
      startedAt: entry.startedAt,
      endedAt: entry.endedAt,
      activeMs: entry.activeMs,
      inRun: entry.inRun,
      turnStartedAt: entry.turnStartedAt,
    };
  }

  /**
   * The single status write point: records started/ended timestamps and notifies
   * the observer on every change. Direct `statusRef.value =` is a bug -- it skips both.
   */
  #setStatus(entry: TaskEntry, status: TaskStatus): void {
    if (entry.statusRef.value === status) return;
    entry.statusRef.value = status;
    const now = Date.now();
    if (status === TASK_STATUS.RUNNING) {
      if (entry.startedAt === null) entry.startedAt = now;
    } else if (isTerminalStatus(status)) {
      entry.endedAt = now;
      // A terminal transition can cut across an in-flight turn (synthesized
      // cancels, release races): bank the partial turn so the terminal
      // snapshot's activeMs is complete and frozen (the guarded bank in
      // #driveTurn then skips).
      if (entry.turnStartedAt !== null) {
        entry.activeMs += Math.max(0, now - entry.turnStartedAt);
        entry.turnStartedAt = null;
        entry.inRun = false;
      }
    }
    this.#notify({ kind: "task", task: this.#infoOf(entry) });
    // One status write point = one sweep point: every terminal transition
    // (natural finish, queued cancel, parked cancel) passes through here,
    // so the terminal-record bound holds at all times.
    if (isTerminalStatus(status)) {
      // Restart sidecar: the end line for this lifetime's spawn (parked tasks
      // were never recorded; a stray end line stays inert on read).
      if (!entry.parked) this.#spawnLog?.recordEnd(entry.taskId, status);
      this.#evictTerminalTasks();
    }
  }

  /**
   * Enforce MAX_TERMINAL_TASKS: drop the terminal records that ended earliest.
   * Sorting by endedAt keeps a long-running task's record after its late finish --
   * "most recent" means most recently ENDED, which is what follow-ups/status queries on finished work actually target.
   * The entry that just turned terminal has the freshest endedAt, so it is evicted by its own sweep only on an exact tie --
   * and an evicted id reads like a post-restart id, so the worst case is a just-finished task aging out a few ms early.
   */
  #evictTerminalTasks(): void {
    let terminal = 0;
    for (const entry of this.#tasks.values()) {
      if (isTerminalStatus(entry.statusRef.value)) terminal++;
    }
    if (terminal <= MAX_TERMINAL_TASKS) return;
    const victims: Array<{ id: string; endedAt: number; order: number }> = [];
    let order = 0;
    for (const [id, entry] of this.#tasks) {
      if (isTerminalStatus(entry.statusRef.value)) {
        victims.push({ id, endedAt: entry.endedAt ?? 0, order: order++ });
      } else {
        order++;
      }
    }
    victims.sort((a, b) => a.endedAt - b.endedAt || a.order - b.order);
    for (const victim of victims) {
      if (terminal <= MAX_TERMINAL_TASKS) break;
      this.#tasks.delete(victim.id);
      terminal--;
    }
  }

  /** Snapshot of every task the registry still holds (terminal ones included). */
  listTasks(): TaskInfo[] {
    return Array.from(this.#tasks.values(), (entry) => this.#infoOf(entry));
  }

  /** Delegating session of a known task (null: no parent); undefined for
   * unknown ids. The websocket relay uses it for feed scoping and replay gating. */
  getTaskSession(taskId: string): string | null | undefined {
    const entry = this.#tasks.get(taskId);
    return entry ? entry.sessionId : undefined;
  }

  /** Worker agent's session for a known task (null: agent released or never
   * built); undefined for unknown ids. Pending questions live under the
   * worker's session, not the delegating one, so terminal cleanup must key
   * on this. Set is guaranteed at terminal-event time: #finalizeTurn and
   * #interruptEntry notify before nulling entry.agent. */
  getTaskAgentSession(taskId: string): string | null | undefined {
    const entry = this.#tasks.get(taskId);
    if (!entry) return undefined;
    return entry.agent ? entry.agent.sessionId : null;
  }

  /** Exposed for extensions. */
  get config(): Record<string, unknown> {
    return this.#config;
  }

  /** Exposed for extensions. */
  get profileManager(): ProfileManager | undefined {
    return this.#profileManager;
  }

  /**
   * Deliver a background-work completion to a session as a trusted harness
   * message. PUBLIC API for extensions owning async work on the
   * task-completion path (workflow runs; the task agents below) -- the
   * framing here (harness source, model-authored body wrapped `untrusted`) is
   * the security boundary and must not be reimplemented.
   *
   * `delivery` is the delegating session captured at dispatch; with no
   * routable target the result lands on the current agent's context.
   */
  deliverTaskCompletion(
    taskId: string | null,
    result: string,
    delivery: { sessionId: string } | null = null,
  ): void {
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: `[Task ${taskId} completed]\n` },
      { type: "untrusted", text: result },
    ];

    // Route to the bus of the session that owns the agent which spawned the
    // task. A "last-known bus" fallback is NOT safe: in multi-session setups
    // it can be a different (even unrelated) session.
    if (delivery && this.#sessionManager?.getBus) {
      const bus = this.#sessionManager.getBus(delivery.sessionId);
      if (bus) {
        bus.enqueue(content, { source: "harness" });
        return;
      }
      // The delegating session is gone (deleted, or the delegator owns no
      // session entry, e.g. a nested task agent). Misdelivery to an
      // unrelated session is worse than dropping the result, so drop it.
      logger.warn(
        `[task ${taskId}] delegating session ${delivery.sessionId} has no bus; dropping task result`,
      );
      return;
    }

    // No routable delivery target (no delegating session captured, or the
    // session manager exposes no getBus — e.g. a harness without session
    // entries): append directly to the current agent's context.
    // Enqueue-only when a bus exists: the bus run loop appends via
    // agent.run(), so also addMessage()-ing would inject the result twice.
    const agent = this.#sessionManager?.getAgent();
    if (agent) {
      agent.addMessage(
        new Message({
          role: "harness",
          content,
          source: "harness",
        }),
      );
    }
  }

  async spawnTask(
    taskId: string,
    taskDescription: TurnPrompt,
    options: SpawnTaskOptions = {} as SpawnTaskOptions,
  ): Promise<TaskHandle> {
    // A live id collision would silently replace the registry entry: the
    // orphaned task keeps running but becomes unaddressable (status/interrupt/
    // steer hit the new entry). Refuse loud, before registration, like pin
    // failures. Terminal ids stay reusable (slim records, long-lived webui
    // managers: "task-1" in a new session must not collide).
    const existing = this.#tasks.get(taskId);
    if (
      existing &&
      (existing.statusRef.value === TASK_STATUS.QUEUED ||
        existing.statusRef.value === TASK_STATUS.RUNNING)
    ) {
      throw new Error(`[task ${taskId}] task id already in use (task is ${existing.statusRef.value})`);
    }
    // A reused terminal id must sit at the recency END: Map.set keeps an
    // existing key's insertion position, and that position is the
    // same-endedAt tiebreak in the terminal-record sweep. Without the
    // delete-then-set, a respawn on an old id would inherit the old
    // record's spot and lose a flood tie against younger records.
    if (existing) this.#tasks.delete(taskId);
    // Synchronous id reservation. Everything between the collision check and
    // the entry being startable awaits (profile load, resolver peek up to 2 s);
    // an await is exactly where a second same-id spawnTask slips in: without a
    // reservation both calls pass and the second silently replaces the first,
    // orphaning it. Registering here -- no await between the check and this set
    // -- makes the claim atomic. The placeholder is QUEUED but flagged planning
    // (never scheduled); a plan failure deletes it, and a cancel in the
    // planning window is honored by the terminal check below.
    const abortController = new AbortController();
    const statusRef: { value: TaskStatus } = { value: TASK_STATUS.QUEUED };
    let settleFn!: (completion: TaskCompletion) => void;
    const done = new Promise<TaskCompletion>((resolve) => {
      settleFn = resolve;
    });
    const entry: TaskEntry = {
      taskId,
      description: describeTask(taskDescription),
      createdAt: Date.now(),
      startedAt: null,
      endedAt: null,
      agent: null,
      abortController,
      statusRef,
      // Capture the delegating session with the reservation, so a session
      // teardown during the planning window can abort the task too.
      sessionId: options.managerAgent ? options.managerAgent.sessionId : null,
      provider: "",
      model: "",
      intent: "",
      candidates: null,
      placing: false,
      planning: true,
      agentConfig: {},
      start: null,
      lease: null,
      acquiring: false,
      blocked: false,
      parked: false,
      inRun: false,
      activeMs: 0,
      turnStartedAt: null,
      turnPending: false,
      turnGranted: false,
      turnWaiters: [],
      releaseRequested: false,
      questionYielded: false,
      onTurn: undefined,
      onTurnStart: undefined,
      lastResult: undefined,
      settled: false,
      settle: (status, result) => {
        if (entry.settled) return;
        entry.settled = true;
        settleFn({ status, result });
      },
    };
    this.#tasks.set(taskId, entry);

    let plan: SpawnPlan;
    try {
      plan = await this.#scheduler.planForSpawn(taskId, options);
    } catch (e: unknown) {
      // Plan failures keep their pre-reservation semantics: loud throw to the
      // delegating tool, and no phantom entry lingers in the registry.
      if (this.#tasks.get(taskId) === entry) this.#tasks.delete(taskId);
      throw e;
    }
    const { profileName, taskProfile, candidates, modelLabel, headKey } = plan;

    // A cancel during the planning window (interruptTask by id, or the
    // delegating session deleted) already made the placeholder terminal and
    // settled `done`. Honor it: hand back the handle without starting.
    if (statusRef.value !== TASK_STATUS.QUEUED) {
      return new TaskHandle(
        taskId,
        statusRef,
        abortController,
        () => this.#interruptEntry(entry),
        done,
      );
    }

    // A found-but-frontmatter-only profile has body "" -- that must reach the
    // factory as an explicit empty string, never fall through to the session
    // profile's body (which leaked the meta manager prompt into workers).
    const resolvedProfileBody = taskProfile ? taskProfile.body : undefined;

    const toolWhitelist = taskProfile?.whitelistTools || null;
    const toolBlacklist = taskProfile?.blacklistTools || null;

    // Capture the delegating agent up front so completion is delivered to ITS
    // session's bus, even if other sessions are created in the meantime.
    const delivery = options.managerAgent ?? null;

    // Parked tasks are consumed directly (onTurn/taskTurn/done); bus delivery
    // would duplicate every result into a session context.
    const parked = options.park === true;

    // Restart sidecar (fire-and-forget): parked spawns are workflow-engine
    // owned -- their lifecycle lives in the run journal, so only delegate-style
    // tasks are recorded here. A failed write never disturbs execution.
    if (!parked) {
      this.#spawnLog?.recordSpawn({ taskId, description: entry.description, sessionId: entry.sessionId });
    }

    // Task agents are silent to the UI; only onTaskComplete matters -- unless an
    // observer (websocket/webui relay) is attached, forwarding every agent
    // OutputEvent tagged with the task id. Nothing reaches the main transcript.
    const sink = {
      emit: (event: unknown) => {
        this.#notify({ kind: "activity", taskId, event: event as OutputEvent });
      },
      onTaskComplete: (result: string) => {
        if (parked) return;
        this.deliverTaskCompletion(taskId, result, delivery);
      },
    };

    const agentConfig: Record<string, unknown> = {
      model: headKey,
      // Name the worker profile explicitly; without it the factory resolves the
      // *session* profile name, re-enabling manager gating and grafting the
      // session profile's overlays onto the worker.
      profileName,
      ...(taskProfile ? { managerProfile: taskProfile.manager } : {}),
      profileBody: resolvedProfileBody,
      sink,
      toolWhitelist,
      blacklistTools: toolBlacklist,
      hideTools: true,
      hideThinking: true,
      showTokenUse: false,
      maxIterations: this.#maxIterations,
    };

    // Fill the reserved entry with the resolved profile / placement fields.
    // Multi-candidate entries carry "" (and the intent label) until a lane is
    // granted; strict/expanded-single entries are locked at spawn.
    entry.intent = modelLabel;
    entry.model = candidates ? modelLabel : headKey;
    entry.provider = candidates ? "" : laneKeyOf(headKey);
    entry.candidates = candidates;
    entry.agentConfig = agentConfig;
    entry.parked = parked;
    entry.onTurn = options.onTurn;
    entry.onTurnStart = options.onTurnStart;
    entry.start = () => {
      entry.start = null;
      this.#setStatus(entry, TASK_STATUS.RUNNING);
      // Last-resort net: a residual throw inside #launch (a throwing consumer
      // onTurn, bus enqueue, or notifyCompletion) would be an unhandled
      // rejection -- killing the process -- leaving the entry dangling
      // non-terminal, hanging `done` and pinning its lane.
      this.#execution.launch(taskId, entry, agentConfig, taskDescription, sink.onTaskComplete).catch(
        (e: unknown) => this.#execution.recoverTask(taskId, entry, e),
      );
    };
    // The entry is startable now: admit may schedule it.
    entry.planning = false;
    // Announce the spawn (status QUEUED) before admit can flip it to RUNNING.
    this.#notify({ kind: "task", task: this.#infoOf(entry) });
    // Starts immediately when the provider lane is free; otherwise the task
    // sits QUEUED until a terminal transition re-runs the admit scan.
    this.#scheduler.admit();

    return new TaskHandle(
      taskId,
      statusRef,
      abortController,
      () => this.#interruptEntry(entry),
      done,
    );
  }

  /**
   * Warm follow-up turn on a parked task (workflow engine retries): same
   * session, append-only context, KV cache stays warm. Throws if the task is
   * not parked-idle (unknown, not parked, terminal, or busy). A parked task
   * yields its lane while idle, so the turn may queue: it starts when the
   * provider lane has room again (waiting turns are granted before new
   * spawns); if the task dies while queued, resolves as cancelled.
   */
  async taskTurn(taskId: string, message: TurnPrompt): Promise<TurnResult> {
    const entry = this.#tasks.get(taskId);
    if (
      !entry ||
      !entry.parked ||
      entry.statusRef.value !== TASK_STATUS.RUNNING ||
      !entry.agent ||
      entry.inRun ||
      entry.turnPending ||
      entry.turnGranted ||
      entry.releaseRequested ||
      entry.abortController.signal.aborted
    ) {
      throw new Error(
        `[task ${taskId}] not ready for a warm turn (unknown, unparked, terminal, or busy)`,
      );
    }
    const laneCap = this.#scheduler.laneCap(entry.provider);
    const coordinated = this.#scheduler.hasLanes && Number.isFinite(laneCap);
    let ready = false;
    if (coordinated && this.#scheduler.laneUsed(entry) < laneCap) {
      // Reserve in-process first (the busy guard sees turnGranted), then let
      // the cross-process ledger decide whether the lane has room.
      entry.turnGranted = true;
      const got = await this.#scheduler.acquireSlotSafe(entry.provider);
      if (
        entry.statusRef.value !== TASK_STATUS.RUNNING ||
        !entry.agent ||
        entry.releaseRequested ||
        entry.abortController.signal.aborted
      ) {
        // Died while awaiting the slot: hand it back.
        entry.turnGranted = false;
        if (got.ok && got.lease) await this.#scheduler.releaseLease(got.lease);
        return { status: "cancelled", result: "Task aborted" };
      }
      if (got.ok) {
        entry.lease = got.lease;
        ready = true;
      }
      entry.turnGranted = false;
    }
    if (!ready) {
      // The slot was taken while this session sat idle (in-process or by another process):
      // queue for #admit (waiting turns are granted before new spawns).
      entry.turnPending = true;
      // Register the waiter BEFORE admitting: a coordination-off grant wakes
      // synchronously inside #admit, and a wake with no registered waiter
      // would hang this await forever.
      const wake = new Promise<void>((resolve) => entry.turnWaiters.push(resolve));
      this.#scheduler.admit();
      await wake;
      entry.turnGranted = false;
      if (
        entry.statusRef.value !== TASK_STATUS.RUNNING ||
        !entry.agent ||
        entry.releaseRequested ||
        entry.abortController.signal.aborted
      ) {
        // Cancelled/released while queued; no agent turn ran. The cancelling
        // transition delivers the synthesized cancelled onTurn itself; a
        // completeTask release does not (its result was already delivered),
        // so this resolution is what unparks that case.
        return { status: "cancelled", result: "Task aborted" };
      }
    }
    const agent = entry.agent;
    const turn = await this.#execution.driveTurn(taskId, entry, agent, message);
    if (!this.#execution.parked(entry, turn)) this.#execution.finalizeTurn(entry, agent, turn);
    return turn;
  }

  /**
   * Release a parked task as completed. Called while a turn is in flight, the release takes effect once it ends.
   * Returns false for non-parked or non-running tasks.
   */
  completeTask(taskId: string): boolean {
    const entry = this.#tasks.get(taskId);
    if (!entry || !entry.parked || entry.statusRef.value !== TASK_STATUS.RUNNING) return false;
    entry.releaseRequested = true;
    if (!entry.inRun && entry.agent) {
      this.#execution.finalizeTurn(entry, entry.agent, {
        status: "completed",
        result: entry.lastResult ?? "",
      });
    }
    return true;
  }
  /** @internal Test-only view of the task registry. */
  get _test_tasks(): ReadonlyMap<string, { agent: AgentLike | null }> {
    return this.#tasks;
  }

  /** @internal Cumulative retry timers created (witness for the setInterval multiplication regression). */
  get _test_retryTicks(): number {
    return this.#scheduler.retryTicks;
  }

  taskStatus(taskId: string): TaskStatus | null {
    const task = this.#tasks.get(taskId);
    if (!task) return null;
    return task.statusRef.value;
  }

  /**
   * Tasks whose spawn the sidecar recorded but whose terminal transition never
   * landed and whose writer pid is not alive: survivors of a process restart,
   * from THIS lifetime's view. Surfacing only -- nothing is auto-respawned.
   * Empty when the sidecar is unset.
   */
  orphanedTasks(): Promise<OrphanedTask[]> {
    return this.#spawnLog ? this.#spawnLog.orphans() : Promise.resolve([]);
  }

  /** Locked model + provider lane for a spawned task, or null if unknown. Provider is null while a multi-candidate task waits unplaced (model then shows the intent). */
  taskLane(taskId: string): { model: string; provider: string | null } | null {
    const task = this.#tasks.get(taskId);
    if (!task) return null;
    return { model: task.model, provider: task.provider || null };
  }

  sendFollowUp(taskId: string, message: string): boolean {
    const task = this.#tasks.get(taskId);
    if (!task || task.statusRef.value !== TASK_STATUS.RUNNING) {
      return false;
    }
    // A RUNNING entry can still be inside #launch's build window (agent not
    // yet assigned); nothing to steer yet. A parked-idle task has no steering
    // queue being drained -- its follow-up path is taskTurn().
    if (!task.agent || !task.inRun) return false;

    // A pending question eats the follow-up as its answer: a steer would sit behind it forever.
    const sessionId = task.agent.sessionId;
    if (sessionId && this.#resolvePendingQuestion?.(sessionId, message)) {
      return true;
    }

    if (typeof task.agent.steer === "function") {
      task.agent.steer(message);
      return true;
    }
    return false;
  }

  /**
   * A task agent put a question to its human: yield its lane slot while the
   * wait holds (why: TaskEntry.questionYielded) and wake the delegating
   * session. The slot comes back in onTaskQuestionSettled.
   */
  onTaskQuestionAsked(sessionId: string, questions: Array<{ key: string; prompt: string; options?: string[] }>): void {
    const entry = this.#entryBySession(sessionId);
    if (!entry || entry.statusRef.value !== TASK_STATUS.RUNNING) return;
    entry.questionYielded = true;
    this.#scheduler.releaseSlot(entry);
    this.#deliverQuestion(entry, questions);
  }

  /**
   * The pending question for `sessionId` settled (answered, timed out, or cancelled).
   * Re-acquires the slot yielded by onTaskQuestionAsked before the question tool's promise resolves,
   * so the agent's next LLM call can never fire without a lane slot. A dead or aborted task takes no slot back.
   */
  async onTaskQuestionSettled(sessionId: string): Promise<void> {
    const entry = this.#entryBySession(sessionId);
    if (!entry || !entry.questionYielded) return;
    entry.questionYielded = false;
    if (entry.statusRef.value !== TASK_STATUS.RUNNING || entry.abortController.signal.aborted) {
      return; // interrupt/delete won the race; #finalizeTurn owns the lane
    }
    const cap = this.#scheduler.laneCap(entry.provider);
    if (!this.#scheduler.hasLanes || !Number.isFinite(cap)) return; // uncoordinated: nothing to take back
    // Wait out a full lane exactly like a queued turn does.
    for (;;) {
      const got = await this.#scheduler.acquireSlotSafe(entry.provider);
      if (entry.statusRef.value !== TASK_STATUS.RUNNING || entry.abortController.signal.aborted) {
        if (got.ok && got.lease) await this.#scheduler.releaseLease(got.lease);
        return;
      }
      if (got.ok && got.lease) {
        entry.lease = got.lease;
        return;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, this.#scheduler.retryMs));
    }
  }

  /** The RUNNING entry whose agent is the given session, if any. */
  #entryBySession(sessionId: string): TaskEntry | undefined {
    for (const entry of this.#tasks.values()) {
      if (entry.statusRef.value === TASK_STATUS.RUNNING && entry.agent?.sessionId === sessionId) {
        return entry;
      }
    }
    return undefined;
  }

  /**
   * Wake the delegating session with a task's pending question. Same framing boundary as deliverTaskCompletion:
   * harness-trusted wrapper, model-authored body wrapped untrusted. Engine-spawned tasks (no delegating session) have
   * no manager to reach -- the webui relay already showed the question.
   */
  #deliverQuestion(
    entry: TaskEntry,
    questions: Array<{ key: string; prompt: string; options?: string[] }>,
  ): void {
    if (!entry.sessionId || !this.#sessionManager?.getBus) return;
    const lines = questions.map(
      (q) => `- ${q.prompt}${q.options?.length ? ` (options: ${q.options.join(" | ")})` : ""}`,
    );
    const body =
      `Task ${entry.taskId} is waiting for an answer:\n${lines.join("\n")}\n` +
      `Reply with task_followup("${entry.taskId}", "<your answer>") -- the worker resumes as soon as the question is answered.`;
    const content: Array<Record<string, unknown>> = [
      { type: "text", text: "[Task question]\n" },
      { type: "untrusted", text: body },
    ];
    const bus = this.#sessionManager.getBus(entry.sessionId);
    if (bus) {
      bus.enqueue(content, { source: "harness" });
    } else {
      logger.warn(
        `[task ${entry.taskId}] delegating session ${entry.sessionId} has no bus; dropping task question`,
      );
    }
  }

  /** Cancel: queued -> terminal; running -> abort the in-flight turn; parked-idle -> terminal. */
  #interruptEntry(entry: TaskEntry): boolean {
    const status = entry.statusRef.value;
    if (status === TASK_STATUS.QUEUED) {
      // Release any placement reservation so the lane is instantly reusable.
      entry.placing = false;
      // A planning entry (id reserved, plan still awaiting) cancels like any other queued task;
      // the continuation sees the terminal state and returns the handle without starting.
      entry.planning = false;
      entry.candidates = null;
      entry.provider = "";
      entry.model = entry.intent;
      this.#setStatus(entry, TASK_STATUS.CANCELLED);
      entry.onTurn?.({ status: "cancelled", result: "Task aborted" });
      entry.settle(TASK_STATUS.CANCELLED, "Task aborted");
      this.#scheduler.admit();
      return true;
    }
    if (status !== TASK_STATUS.RUNNING) return false;
    if (entry.parked && !entry.inRun && entry.agent) {
      // Nothing in flight to abort; terminate directly and free the lane
      // (a task parked before its first turn completed still holds its slot).
      const agent = entry.agent;
      this.#setStatus(entry, TASK_STATUS.CANCELLED);
      entry.agent = null;
      this.#execution.wakeTurnWaiters(entry);
      this.#scheduler.releaseSlot(entry);
      this.#scheduler.admit();
      entry.onTurn?.({ status: "cancelled", result: "Task aborted" });
      agent.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId: agent.sessionId });
      entry.settle(TASK_STATUS.CANCELLED, "Task aborted");
      return true;
    }
    entry.abortController.abort();
    return true;
  }

  interruptTask(taskId: string): boolean {
    const task = this.#tasks.get(taskId);
    if (!task) return false;
    return this.#interruptEntry(task);
  }

  /**
   * Abort every RUNNING/QUEUED task delegated from the given session.
   * Called when that session is deleted, so its subagents don't keep running/burning tokens with no session to receive results.
   * Other sessions' tasks are untouched. Returns how many were aborted.
   */
  interruptTasksForSession(sessionId: string): number {
    let interrupted = 0;
    for (const task of this.#tasks.values()) {
      if (task.sessionId !== sessionId) continue;
      if (task.statusRef.value === TASK_STATUS.QUEUED || task.statusRef.value === TASK_STATUS.RUNNING) {
        if (this.#interruptEntry(task)) interrupted++;
      }
    }
    return interrupted;
  }

  activeTasks(): string[] {
    const active: string[] = [];
    for (const [id, task] of this.#tasks) {
      if (task.statusRef.value === TASK_STATUS.RUNNING) {
        active.push(id);
      }
    }
    return active;
  }

  taskCounts(): [number, number] | null {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return [active, this.#tasks.size];
  }

  progressMessage(): string | null {
    let active = 0;
    let queued = 0;
    for (const task of this.#tasks.values()) {
      if (task.statusRef.value === TASK_STATUS.RUNNING) active++;
      else if (task.statusRef.value === TASK_STATUS.QUEUED) queued++;
    }
    if (active === 0 && queued === 0) return null;
    const parts: string[] = [];
    if (active > 0) parts.push(`${active} task${active === 1 ? "" : "s"} running`);
    if (queued > 0) parts.push(`${queued} queued`);
    return parts.join(", ");
  }
}
