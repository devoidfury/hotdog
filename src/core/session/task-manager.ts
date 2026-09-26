import { logger } from "@utils/logger.ts";
import { HOOKS } from "../hooks.ts";
import { Message, type MessageSource } from "../context/message.ts";
import { LlmError, formatError } from "../error.ts";
import { loadProfileFile, ProfileManager, type ProfileDef } from "../config/profiles.ts";
import { type CoreConfigWithExtensions } from "../config/schema-loader.ts";
import type { ModelConfig, ProviderDef } from "../config/providers.ts";
import {
  laneKeyOf,
  makeLaneCaps,
  makeRunningPeeker,
  parseGroupRef,
  planSpawn,
  warmSortCandidates,
  type LaneCaps,
  type ModelRequirements,
  type SpawnCandidate,
  type SpawnPin,
} from "./model-resolver.ts";
import { LaneLedger, type LaneLease } from "./lane-ledger.ts";
import { DEFAULT_LANES_RETRY_MS } from "./turn-lanes.ts";
import type { AgentLike } from "./index.ts";

export const TASK_STATUS = {
  RUNNING: "running",
  /** Waiting for a free provider lane (see lanesPerProvider). */
  QUEUED: "queued",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

/** One agent turn's outcome (a task may run several turns when parked). */
export interface TurnResult {
  status: "completed" | "failed" | "cancelled";
  result: string;
}

/** Terminal outcome a spawned task's `done` promise resolves with. */
export interface TaskCompletion {
  status: TaskStatus;
  result: string;
}

/**
 * Prompt accepted by spawnTask/taskTurn. A parts array lets the composer
 * (e.g. the workflow engine) mark spliced model-authored content `untrusted`
 * -- mangled at the wire serializer, like every other untrusted boundary.
 */
export type TurnPrompt = string | Array<Record<string, unknown>>;

export class TaskHandle {
  taskId: string;
  #statusRef: { value: TaskStatus };
  #abortController: AbortController;
  #interrupt: (() => boolean) | null;
  #done: Promise<TaskCompletion>;

  constructor(
    taskId: string,
    statusRef: { value: TaskStatus },
    abortController: AbortController,
    /** Manager-bound interrupt (also settles `done`); absent on bare test handles. */
    interrupt?: () => boolean,
    /** Resolves when the task reaches a terminal state. Only bound by spawnTask. */
    done?: Promise<TaskCompletion>,
  ) {
    this.taskId = taskId;
    this.#statusRef = statusRef;
    this.#abortController = abortController;
    this.#interrupt = interrupt ?? null;
    this.#done = done ?? new Promise<TaskCompletion>(() => {});
  }

  get status(): TaskStatus {
    return this.#statusRef.value;
  }

  /**
   * Resolves when the task reaches a terminal state with the final status and
   * result. A handle not created by spawnTask (test construction) never
   * resolves; read `status` there instead.
   */
  get done(): Promise<TaskCompletion> {
    return this.#done;
  }

  interrupt(): boolean {
    if (this.#interrupt) return this.#interrupt();
    const status = this.#statusRef.value;
    if (status === TASK_STATUS.RUNNING) {
      this.#abortController.abort();
      return true;
    }
    if (status === TASK_STATUS.QUEUED) {
      // Never started; the lane scan skips non-QUEUED entries.
      this.#statusRef.value = TASK_STATUS.CANCELLED;
      return true;
    }
    return false;
  }
}

/** Bus surface needed for task-result delivery. */
export interface TaskResultBus {
  enqueue(content: string | Array<Record<string, unknown>>, opts?: { source?: MessageSource }): void;
}

/** Minimal session-manager surface the TaskManager needs for result delivery. */
export interface TaskManagerSessionManager {
  getAgent: () => AgentLike | undefined;
  /** Look up a specific session's agent (chain-default model for delegated spawns). */
  getAgentBySessionId?: (sessionId: string) => AgentLike | undefined;
  /** Look up a session's bus by id; used to route task results to the right session. */
  getBus?: (sessionId: string) => TaskResultBus | undefined;
}

export interface SpawnTaskOptions {
  workerModel?: string;
  profile?: string;
  /**
   * Explicit model pin, validated against the model catalog, locked for the task's lifetime. Supersedes workerModel.
   */
  pin?: SpawnPin;
  /**
   * Capability requirements resolved against the catalog when no pin is given. Progressive enhancement; loaded-model preference via /running.
   */
  requires?: ModelRequirements;
  /**
   * Declared model-group fanout (config modelGroups; "group:<name>" through
   * worker_model and the worker profile's `group` field also land here).
   * Members are interchangeable: placement takes any member with a free lane.
   * Mutually exclusive with pin.
   */
  group?: string;
  /**
   * The agent that delegated this task. Its session's bus is the delivery
   * target for the completion result. Without this, the result falls back to
   * a direct append to the session manager's current agent's context.
   */
  managerAgent?: { sessionId: string } | null;
  /**
   * Park between turns (workflow-engine only): after each agent turn the task
   * stays RUNNING with its warm session; it holds its provider-lane slot
   * through turns but yields it while idle, so queued spawns and other nodes
   * (e.g. its judge) run on; a follow-up turn re-acquires the slot. The consumer
   * drives further turns via taskTurn() and releases via completeTask() or
   * interruptTask(). Bus delivery is suppressed -- the consumer receives every
   * turn through onTurn/taskTurn instead.
   */
  park?: boolean;
  /**
   * Fires after every agent turn (including the turn that ends a parked task),
   * and also with a synthesized failed/cancelled result when a task dies
   * without ever running a turn (agent-build failure, cancel while queued or
   * parked-idle) -- a parked consumer waiting on onTurn can never hang.
   * completeTask on a parked-idle task does not re-fire it (its result was
   * already delivered).
   */
  onTurn?: (turn: TurnResult) => void;
}

export interface TaskManagerOptions {
  modelRegistry: Record<string, ModelConfig>;
  config: CoreConfigWithExtensions;
  sessionManager?: TaskManagerSessionManager | null;
  profileManager?: ProfileManager;
  /** Override the llama-swap /running peek (tests, exotic transports). */
  runningPeek?: (provider: string) => Promise<Set<string>>;
  /**
   * Directory for the cross-process lane slot ledger (resolved config:
   * taskLanesDir). With a finite lane cap, slot files under this dir make
   * `lanesPerProvider` a machine-wide bound shared by every hotdog process;
   * unset disables cross-process coordination (per-process caps only).
   */
  lanesDir?: string | null;
  /** Ledger re-attempt interval while tasks wait on foreign-held slots. Test seam. */
  lanesRetryMs?: number;
}

export interface TaskManagerRequiredOptions {
  buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  maxIterations: number;
  taskProfile: string;
  /**
   * Concurrent task-agent turns allowed per provider lane (resolved config: taskLanesPerProvider).
   * A provider's `taskLanes` in config overrides this for its lane.
   * Undefined or < 1 means unlimited -- lane queueing exists because backend nodes thrash KV caches when too many models swap concurrently.
   * A parked task holds its slot only while a turn is in flight (or waiting); while idle it yields, so it never
   * blocks nodes that must run against it (e.g. a judge for the parked producer).
   */
  lanesPerProvider?: number;
}


interface TaskEntry {
  /** Spawn id, for diagnostics. */
  taskId: string;
  agent: AgentLike | null;
  abortController: AbortController;
  statusRef: { value: TaskStatus };
  /** The delegating session that spawned this task (null if none). Used to abort the task when that session is deleted. */
  sessionId: string | null;
  /** Provider lane this task occupies while RUNNING. "" until a multi-candidate placement locks it. */
  provider: string;
  /** Locked "provider/model", or the intent string while a multi-candidate task is still unplaced. */
  model: string;
  /** Spawn-time intent label; a released placement reverts `model` to this (see #warmPlace). */
  intent: string;
  /**
   * Ordered placement plan while unplaced (null once locked). Placement takes
   * the first candidate whose lane has capacity; multi-candidate entries
   * reserve then re-sort warm before starting.
   */
  candidates: SpawnCandidate[] | null;
  /** Multi-candidate placement in flight: the reserved lane must not be double-taken. */
  placing: boolean;
  /**
   * spawnTask reservation: the entry is registered (claiming the id against
   * concurrent same-id spawns) while the async profile load / model plan runs.
   * #admit skips planning entries -- they have no start yet. Cleared when the
   * entry is filled; deleted outright if the plan fails.
   */
  planning: boolean;
  /** Agent config built at spawn; `model` is rewritten at placement before start. */
  agentConfig: Record<string, unknown>;
  /** Pending start for QUEUED tasks; cleared when the task starts. */
  start: (() => void) | null;
  /** Cross-process ledger slot held while this task occupies its lane (null: none, unlimited, or no ledger). */
  lease: LaneLease | null;
  /** A ledger acquire for this entry is in flight (do not schedule a second one). */
  acquiring: boolean;
  /** Last ledger acquire failed because every slot on the lane is fleet-wide busy; retried on the lanes timer. */
  blocked: boolean;
  parked: boolean;
  /** True while an agent turn is in flight. */
  inRun: boolean;
  /** True while a warm taskTurn waits for a free lane slot (granted by #admit). */
  turnPending: boolean;
  /** True between a #admit grant of a warm turn and the turn actually starting (holds the slot). */
  turnGranted: boolean;
  turnWaiters: Array<() => void>;
  /** Set by completeTask(); finalizes the task after the in-flight turn ends. */
  releaseRequested: boolean;
  onTurn?: (turn: TurnResult) => void;
  /** Result of the most recent turn (completeTask on a parked-idle task reports it). */
  lastResult: string | undefined;
  /** True once `settle` has resolved the handle's `done` promise. */
  settled: boolean;
  /** Idempotent resolution of the handle's `done` promise. */
  settle: (status: TaskStatus, result: string) => void;
}

/** Profile + placement plan produced by #planForSpawn before an entry starts. */
interface SpawnPlan {
  taskProfile: ProfileDef | null;
  candidates: SpawnCandidate[] | null;
  modelLabel: string;
  headKey: string;
}

export class TaskManager {
  #buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  #modelRegistry: Record<string, ModelConfig>;
  #config: CoreConfigWithExtensions;
  #sessionManager: TaskManagerSessionManager | null;
  #maxIterations: number;
  #taskProfile: string;
  /** Per-lane caps: global taskLanesPerProvider default + provider taskLanes overrides (shared resolution with session turns). */
  #laneCaps: LaneCaps;
  #peekLoaded: (provider: string) => Promise<Set<string>>;
  #modelGroups: Record<string, string[]>;
  #noSpread: Set<string>;
  /** Cross-process lane slot ledger (null when lanesDir is unset: caps apply to this process only). */
  #lanes: LaneLedger | null;
  #lanesRetryMs: number;
  #lanesRetryTimer: ReturnType<typeof setInterval> | null;
  // Terminal tasks keep a slim record (no agent) so a long-lived manager --
  // the webui TaskManager outlives every session -- does not pin each dead
  // task's full Agent/context forever. See #finalizeTurn for the release point.
  #tasks: Map<string, TaskEntry>;
  #profileManager: ProfileManager | undefined;

  constructor(options: TaskManagerOptions & TaskManagerRequiredOptions) {
    this.#buildAgent = options.buildAgent;
    this.#modelRegistry = options.modelRegistry || {};
    this.#config = options.config || {};
    this.#sessionManager = options.sessionManager || null;
    this.#maxIterations = options.maxIterations;
    this.#taskProfile = options.taskProfile;
    const providerDefs =
      ((options.config as Record<string, unknown>).providers as ProviderDef[]) ?? [];
    this.#peekLoaded =
      options.runningPeek ??
      makeRunningPeeker(providerDefs, {
        baseUrl: (options.config as Record<string, unknown>).baseUrl as string | undefined,
        apiKey: (options.config as Record<string, unknown>).apiKey as string | undefined,
      });
    // modelGroups / noSpread ride the resolved config bag, same as providers.
    this.#modelGroups =
      ((options.config as Record<string, unknown>).modelGroups as Record<string, string[]>) ?? {};
    // Per-lane caps: the global lanesPerProvider (taskLanesPerProvider) is the
    // fleet default; a numeric provider taskLanes overrides it for that lane
    // only. Both normalize below 1 to unlimited (shared with session turns).
    this.#laneCaps = makeLaneCaps(options.lanesPerProvider, providerDefs);
    this.#noSpread = new Set(
      providerDefs
        .filter((p) => (p as { noSpread?: boolean }).noSpread === true)
        .map((p) => p.name),
    );
    this.#lanes = options.lanesDir ? new LaneLedger({ dir: options.lanesDir }) : null;
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
    this.#lanesRetryMs =
      typeof options.lanesRetryMs === "number" && options.lanesRetryMs >= 1
        ? options.lanesRetryMs
        : DEFAULT_LANES_RETRY_MS;
    this.#lanesRetryTimer = null;
    this.#tasks = new Map();
    this.#profileManager = options.profileManager;
  }

  setSessionManager(sessionManager: TaskManagerSessionManager): void {
    this.#sessionManager = sessionManager;
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
   * message. PUBLIC API for extensions that own async work riding the
   * task-completion delivery path (workflow runs; the task agents below) --
   * the framing here (harness source, model-authored body wrapped as
   * `untrusted`) is the security boundary and must not be reimplemented.
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
    // steer hit the new entry). Refuse loud, before any registration, like
    // pin failures. Terminal ids stay reusable (slim records, long-lived
    // webui managers: "task-1" in a new session must not collide).
    const existing = this.#tasks.get(taskId);
    if (
      existing &&
      (existing.statusRef.value === TASK_STATUS.QUEUED ||
        existing.statusRef.value === TASK_STATUS.RUNNING)
    ) {
      throw new Error(`[task ${taskId}] task id already in use (task is ${existing.statusRef.value})`);
    }
    // Synchronous id reservation. Everything between the collision check
    // above and the entry being startable awaits (profile load, resolver peek
    // up to 2 s), and an await is exactly where a second same-id spawnTask
    // slips in: without a reservation both calls pass the check and the
    // second silently replaces the first registry entry, orphaning the first
    // task. Registering here -- no await between the check and this set --
    // makes the claim atomic. The placeholder is QUEUED but flagged planning
    // (never scheduled); a plan failure deletes it, and a cancel landing in
    // the planning window is honored by the terminal check below.
    const abortController = new AbortController();
    const statusRef: { value: TaskStatus } = { value: TASK_STATUS.QUEUED };
    let settleFn!: (completion: TaskCompletion) => void;
    const done = new Promise<TaskCompletion>((resolve) => {
      settleFn = resolve;
    });
    const entry: TaskEntry = {
      taskId,
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
      turnPending: false,
      turnGranted: false,
      turnWaiters: [],
      releaseRequested: false,
      onTurn: undefined,
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
      plan = await this.#planForSpawn(taskId, options);
    } catch (e: unknown) {
      // Plan failures keep their pre-reservation semantics: loud throw to the
      // delegating tool, and no phantom entry lingers in the registry.
      if (this.#tasks.get(taskId) === entry) this.#tasks.delete(taskId);
      throw e;
    }
    const { taskProfile, candidates, modelLabel, headKey } = plan;

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

    const resolvedProfileBody = taskProfile?.body || "";

    const toolWhitelist = taskProfile?.whitelistTools || null;

    // Capture the delegating agent up front so completion is delivered to
    // ITS session's bus, even if other sessions are created in the meantime.
    const delivery = options.managerAgent ?? null;

    // Parked tasks are consumed directly (onTurn/taskTurn/done); bus delivery
    // would duplicate every result into a session context.
    const parked = options.park === true;

    // Task agents are silent to the UI; only onTaskComplete matters.
    const sink = {
      emit: (_event: unknown) => {},
      onTaskComplete: (result: string) => {
        if (parked) return;
        this.deliverTaskCompletion(taskId, result, delivery);
      },
    };

    const agentConfig: Record<string, unknown> = {
      model: headKey,
      profileBody: resolvedProfileBody,
      sink,
      toolWhitelist,
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
    entry.start = () => {
      entry.start = null;
      statusRef.value = TASK_STATUS.RUNNING;
      // Last-resort net: a residual throw inside #launch (a throwing
      // consumer onTurn, bus enqueue, or notifyCompletion) would otherwise
      // be an unhandled rejection -- which kills the process -- and the
      // entry would dangle non-terminal, hanging `done` and pinning its lane.
      this.#launch(taskId, entry, agentConfig, taskDescription, sink.onTaskComplete).catch(
        (e: unknown) => this.#recoverTask(taskId, entry, e),
      );
    };
    // The entry is startable now: admit may schedule it.
    entry.planning = false;
    // Starts immediately when the provider lane is free; otherwise the task
    // sits QUEUED until a terminal transition re-runs the admit scan.
    this.#admit();

    return new TaskHandle(
      taskId,
      statusRef,
      abortController,
      () => this.#interruptEntry(entry),
      done,
    );
  }

  /**
   * The delegating session's current model, when the spawn names a manager
   * agent (delegate_task path). The chain default for a bare spawn: same
   * model as the parent, then copy-expanded across providers by the caller.
   */
  #parentModel(managerAgent: SpawnTaskOptions["managerAgent"]): string | undefined {
    if (!managerAgent) return undefined;
    const model = this.#sessionManager?.getAgentBySessionId?.(managerAgent.sessionId)?.model;
    return typeof model === "string" && model.length > 0 ? model : undefined;
  }

  /**
   * Profile load + model admission for spawnTask, kept in its own async
   * method so the collision check -> id reservation sequence in spawnTask
   * contains no await. Plan failures throw loud, like pin misses; the
   * caller drops the reservation and lets the error reach the delegating tool.
   */
  async #planForSpawn(taskId: string, options: SpawnTaskOptions): Promise<SpawnPlan> {
    const profileName = options.profile || this.#taskProfile;
    const taskProfile = this.#profileManager
      ? this.#profileManager.getProfile(profileName)
      : await loadProfileFile(this.#config.profilesPath ?? "", profileName);

    // Model admission -> placement plan. pin/group/requires validate against
    // the catalog and fail loud before registration; the legacy chain expands
    // bare values and the registry default into cross-provider copies (cold,
    // never errors), while a provider-qualified explicit value stays strict.
    // A worker profile may bind fanout itself via its `group` field; an
    // explicit worker_model wins over it, same precedence as over profile model.
    const profileGroup = taskProfile?.group || undefined;
    if (
      !options.workerModel &&
      typeof taskProfile?.model === "string" &&
      taskProfile.model.startsWith("group:")
    ) {
      // Otherwise this lands in the legacy expand branch, finds no catalog
      // copies for the pseudo-name, and launches with the literal string
      // "group:..." as the model -- a runtime API error, not a config error.
      throw new Error(
        `[task ${taskId}] profile '${profileName}' model '${taskProfile.model}' looks like a group reference; declare it with the profile 'group' field instead`,
      );
    }
    const groupRef =
      options.group ??
      parseGroupRef(options.workerModel) ??
      (options.workerModel ? undefined : profileGroup);
    if (options.pin && groupRef) {
      throw new Error(`[task ${taskId}] pin and group are mutually exclusive`);
    }
    if (groupRef && groupRef === profileGroup && taskProfile?.model) {
      logger.warn(
        `[task ${taskId}] profile '${profileName}' declares both 'group' and 'model'; group wins for placement`,
      );
    }
    logger.debug(
      `[task ${taskId}] plan inputs: profile='${profileName}' profile.group=${profileGroup ?? "-"} ` +
        `worker_model=${options.workerModel ?? "-"} pin=${options.pin?.model ?? options.pin?.provider ?? "-"} ` +
        `requires=${options.requires ? JSON.stringify(options.requires) : "-"} ` +
        `parent=${options.managerAgent ? this.#parentModel(options.managerAgent) ?? "?" : "-"} registrySize=${Object.keys(this.#modelRegistry).length}`,
    );
    let candidates: SpawnCandidate[] | null = null;
    let modelLabel: string;
    let headKey: string;
    if (options.pin || options.requires || groupRef) {
      const plan = await planSpawn({
        registry: this.#modelRegistry,
        pin: options.pin,
        group: groupRef,
        requires: options.requires,
        modelGroups: this.#modelGroups,
        noSpread: this.#noSpread,
        peekLoaded: this.#peekLoaded,
      });
      if (!plan.ok) {
        // Loud and before registration: the delegating tool sees the error
        // and no phantom task lingers in the registry.
        throw new Error(`[task ${taskId}] ${plan.error}`);
      }
      modelLabel = plan.intent;
      headKey = plan.candidates[0]!.key;
      if (plan.candidates.length > 1) candidates = plan.candidates;
    } else {
      const registryDefault = (this.#modelRegistry as { default?: string }).default || "";
      const explicit = options.workerModel || (taskProfile?.model ?? undefined) || undefined;
      // Chain default: the delegating (parent) session's model, then the
      // catalog's `default` key (vestigial in practice: buildModelRegistry
      // never sets one). Explicit qualified values honor their provider;
      // bare values and the chain default are placement-eligible anywhere
      // the name exists.
      const parentModel = this.#parentModel(options.managerAgent);
      const chainDefault = parentModel || registryDefault;
      const expandable = !explicit || explicit === registryDefault || !explicit.includes("/");
      modelLabel = explicit || chainDefault;
      headKey = modelLabel;
      if (!modelLabel) {
        logger.warn(
          `[task ${taskId}] no model resolved (no worker_model, profile model, parent session model, or catalog default); the build default will run the task, unplaced on the bare-name lane`,
        );
      }
      if (modelLabel && expandable) {
        const plan = await planSpawn({
          registry: this.#modelRegistry,
          expand: modelLabel,
          noSpread: this.#noSpread,
          cold: true,
        });
        if (plan.ok && plan.candidates.length > 1) {
          candidates = plan.candidates;
          headKey = plan.candidates[0]!.key;
        }
      }
    }
    logger.debug(
      `[task ${taskId}] plan '${modelLabel}' -> ${
        candidates
          ? `fanout [${candidates.map((c) => `${c.key}(${c.provider})`).join(", ")}]`
          : `${headKey} (locked, no fanout)`
      }`,
    );
    return { taskProfile, candidates, modelLabel, headKey };
  }

  /**
   * Whether an entry consumes a slot on its provider lane right now.
   * Non-parked tasks hold their slot from start to terminal. A parked task
   * holds it through its first turn and whenever a turn is in flight or
   * waiting, but yields while idle between turns: an idle parked session
   * generates no model traffic, and holding on would deadlock it against
   * whatever must run on its lane (a judge for the parked producer, under
   * the default cap of 1). Warm turns re-acquire the slot through this scan.
   */
  #occupies(task: TaskEntry): boolean {
    if (task.statusRef.value !== TASK_STATUS.RUNNING) return false;
    return (
      !task.parked ||
      task.inRun ||
      task.turnGranted ||
      task.turnPending ||
      task.lastResult === undefined
    );
  }

  /** Concurrent turns allowed on a lane: the provider's taskLanes override, else the global cap. */
  #laneCap(provider: string): number {
    return this.#laneCaps.capOf(provider);
  }

  /** Lanes used by OTHER entries on this entry's provider. */
  #laneUsed(entry: TaskEntry): number {
    let n = 0;
    for (const task of this.#tasks.values()) {
      if (task !== entry && task.provider === entry.provider && this.#occupies(task)) n++;
    }
    return n;
  }

  /**
   * Start QUEUED entries and grant waiting warm turns whose provider lane has
   * room, in insertion order. The scan is global, not per-lane, so a task
   * queued on a saturated provider never head-of-line-blocks a later task on
   * a free provider. Waiting warm turns are granted before new spawns: a
   * parked session that yielded its slot gets it back ahead of fresh work.
   *
   * Placement: locked entries (candidates === null) enter on their lane as
   * before; multi-candidate entries take the first candidate with capacity
   * (plan order = warm-first), reserving then re-ranking via #warmPlace.
   * Every start/grant additionally takes a slot in the cross-process ledger
   * (when configured): the in-process scan decides ORDER, the ledger decides
   * CAPACITY across all hotdog processes on the machine.
   */
  #admit(): void {
    // Warm grants count occupancy WITHOUT other warm waiters: a pending
    // waiter reserves the slot but does not hold it. Counting waiters made
    // each one see the next waiter as the blocker, so two waiters on a
    // cap-1 lane mutually refused and none was ever granted. A grant flips
    // the waiter to turnGranted, which DOES count, so waiters on one lane
    // are granted one at a time in insertion order (FIFO).
    const warmUsed = new Map<string, number>();
    for (const task of this.#tasks.values()) {
      if ((this.#occupies(task) || task.placing) && !task.turnPending) {
        warmUsed.set(task.provider, (warmUsed.get(task.provider) ?? 0) + 1);
      }
    }
    for (const task of this.#tasks.values()) {
      if (!task.turnPending || task.statusRef.value !== TASK_STATUS.RUNNING) continue;
      if (task.blocked) continue; // ledger-full last pass; the lanes timer retries
      const n = warmUsed.get(task.provider) ?? 0;
      if (n < this.#laneCap(task.provider)) {
        warmUsed.set(task.provider, n + 1);
        // Optimistic flip: the reservation counts like a grant (turnGranted
        // holds the in-process slot). #tryGrant rolls back to turnPending +
        // blocked when the ledger has no slot (a foreign process holds the lane).
        task.turnPending = false;
        task.turnGranted = true;
        void this.#tryGrant(task);
      }
    }
    // New spawns still see ungranted waiters as holding a reservation (a
    // waiting warm turn outranks fresh work). Recomputed here because the
    // grants above flipped turnPending entries into turnGranted ones.
    // Placement reservations (placing) count too: the lane is promised.
    const used = this.#laneOccupancy();
    for (const task of this.#tasks.values()) {
      if (task.statusRef.value !== TASK_STATUS.QUEUED) continue;
      // Planning reservations claim the id but are not startable yet (the
      // spawnTask continuation fills and clears `planning` before admitting).
      if (task.blocked || task.acquiring || task.planning) continue;
      if (!task.candidates) {
        const n = used.get(task.provider) ?? 0;
        if (n < this.#laneCap(task.provider)) {
          used.set(task.provider, (used.get(task.provider) ?? 0) + 1);
          void this.#tryStart(task);
        } else {
          logger.debug(
            `[task ${task.taskId}] locked lane '${task.provider}' in-process full (${n}/${this.#laneCap(task.provider)}); queued`,
          );
        }
        continue;
      }
      if (task.placing) continue;
      // Multi-candidate entry: eligibility FIRST (a warm-but-full lane must
      // never starve a cold-idle one), then plan order (warm-first at spawn,
      // refreshed by #warmPlace before the start).
      const eligible = task.candidates.filter(
        (c) => (used.get(c.provider) ?? 0) < this.#laneCap(c.provider),
      );
      if (eligible.length === 0) {
        logger.debug(
          `[task ${task.taskId}] every candidate lane in-process full (${task.candidates
            .map((c) => `${c.provider}:${used.get(c.provider) ?? 0}/${this.#laneCap(c.provider)}`)
            .join(", ")}); queued`,
        );
        continue; // whole copy-set/group saturated
      }
      if (eligible.length === 1 && task.candidates.length === 1) {
        this.#place(task, eligible[0]!);
        task.candidates = null;
        used.set(task.provider, (used.get(task.provider) ?? 0) + 1);
        void this.#tryStart(task);
        continue;
      }
      // Several possible homes: reserve the head now so concurrent admit
      // passes (or the sibling of a two-task fanout) cannot double-take it,
      // then re-rank by CURRENT warmth and start.
      this.#place(task, eligible[0]!);
      task.placing = true;
      used.set(task.provider, (used.get(task.provider) ?? 0) + 1);
      void this.#warmPlace(task);
    }
  }

  /** Per-lane occupancy by RUNNING holders and placement reservations. */
  #laneOccupancy(except?: TaskEntry): Map<string, number> {
    const used = new Map<string, number>();
    for (const task of this.#tasks.values()) {
      if (task === except) continue;
      if (this.#occupies(task) || task.placing) {
        used.set(task.provider, (used.get(task.provider) ?? 0) + 1);
      }
    }
    return used;
  }

  /** Lock a placement candidate into the entry (lane, display model, agent config). */
  #place(task: TaskEntry, c: SpawnCandidate): void {
    task.provider = c.provider;
    task.model = c.key;
    task.agentConfig.model = c.key;
  }

  /**
   * Finish a multi-candidate placement: re-sort the plan by current cache
   * warmth, take a slot on the warmest candidate whose lane has in-process
   * room, then start. If every candidate is fleet-wide busy, drop the
   * reservation and stay QUEUED; the lanes timer retries. Cancelled entries
   * unwind without ever starting, and their reservation is released with the
   * flag.
   */
  async #warmPlace(task: TaskEntry): Promise<void> {
    const plan = task.candidates ?? [];
    let warm: SpawnCandidate[];
    try {
      warm = await warmSortCandidates(this.#modelRegistry, plan, this.#peekLoaded);
    } catch (e: unknown) {
      // Unreachable in practice (the peeker degrades internally); cold-place
      // the reservation rather than strand it.
      warm = plan;
    }
    task.placing = false;
    if (task.statusRef.value !== TASK_STATUS.QUEUED || task.candidates === null) {
      this.#admit();
      return;
    }
    logger.debug(
      `[task ${task.taskId}] warm placement: ${warm.map((c) => c.key).join(" > ")}`,
    );
    const used = this.#laneOccupancy(task);
    for (const c of warm) {
      if ((used.get(c.provider) ?? 0) >= this.#laneCap(c.provider)) {
        logger.debug(
          `[task ${task.taskId}] skip '${c.provider}': in-process full (${used.get(c.provider)}/${this.#laneCap(c.provider)})`,
        );
        continue;
      }
      const got = await this.#acquireSlotSafe(c.provider);
      if (task.statusRef.value !== TASK_STATUS.QUEUED || !task.start) {
        // Cancelled while awaiting the slot: hand it straight back.
        if (got.ok && got.lease) await this.#releaseLease(got.lease);
        this.#admit();
        return;
      }
      if (!got.ok) {
        logger.debug(`[task ${task.taskId}] skip '${c.provider}': ledger full (fleet-wide)`);
        continue; // this lane is fleet-wide busy; try the next home
      }
      if (c.provider !== task.provider || c.key !== task.model) this.#place(task, c);
      task.candidates = null;
      task.lease = got.lease;
      logger.debug(
        `[task ${task.taskId}] placed on '${c.provider}' (${c.key})${got.lease ? ` slot=${got.lease.path}` : " (no ledger)"}`,
      );
      task.start!();
      this.#admit();
      return;
    }
    // No lane has room anymore: release the reservation and wait. The
    // abandoned candidate key must not linger in the view: while unplaced,
    // model shows the intent (taskLane's documented contract).
    logger.debug(`[task ${task.taskId}] no placement home left; queued for retry`);
    task.provider = "";
    task.model = task.intent;
    if (this.#lanes) {
      task.blocked = true;
      this.#armLanesRetry();
    }
    this.#admit();
  }

  // -- cross-process lane slots ---------------------------------------------

  /** Take a ledger slot for `provider`; ok with a null lease when coordination is off/uncapped. */
  async #acquireSlot(provider: string): Promise<{ ok: true; lease: LaneLease | null } | { ok: false }> {
    const cap = this.#laneCap(provider);
    if (!this.#lanes || !Number.isFinite(cap)) return { ok: true, lease: null };
    const lease = await this.#lanes.acquire(provider, cap);
    return lease ? { ok: true, lease } : { ok: false };
  }

  /** Acquire that FAILS OPEN on ledger filesystem errors: an unusable state dir must not deadlock tasks. */
  async #acquireSlotSafe(provider: string): Promise<{ ok: true; lease: LaneLease | null } | { ok: false }> {
    try {
      return await this.#acquireSlot(provider);
    } catch (e: unknown) {
      logger.error(
        `[lanes] slot acquire failed for '${provider}' (proceeding uncoordinated): ${formatError(e)}`,
      );
      return { ok: true, lease: null };
    }
  }

  /**
   * Start a locked QUEUED entry once its ledger slot is in hand. A cancel
   * during the acquire releases the slot right back; a ledger-full result
   * marks the entry blocked (the retry timer clears the flag and re-admits).
   * With coordination off the start stays synchronous, exactly as before the
   * ledger existed.
   */
  async #tryStart(task: TaskEntry): Promise<void> {
    const cap = this.#laneCap(task.provider);
    if (!this.#lanes || !Number.isFinite(cap)) {
      logger.debug(
        `[task ${task.taskId}] start on '${task.provider}' uncoordinated (lane cap ${cap === Number.POSITIVE_INFINITY ? "unlimited" : cap}, ledger ${this.#lanes ? "on" : "off"})`,
      );
      if (task.statusRef.value === TASK_STATUS.QUEUED && task.start) task.start();
      return;
    }
    task.acquiring = true;
    const got = await this.#acquireSlotSafe(task.provider);
    task.acquiring = false;
    if (!got.ok) {
      logger.debug(`[task ${task.taskId}] lane '${task.provider}' ledger full; blocked`);
      task.blocked = true;
      this.#armLanesRetry();
      return;
    }
    if (task.statusRef.value !== TASK_STATUS.QUEUED || !task.start) {
      if (got.lease) await this.#releaseLease(got.lease);
      return;
    }
    task.lease = got.lease;
    logger.debug(
      `[task ${task.taskId}] start on '${task.provider}'${got.lease ? ` slot=${got.lease.path}` : ""}`,
    );
    task.start();
  }

  /**
   * Complete an optimistically-granted warm turn: take the ledger slot, then
   * wake the taskTurn waiters. Roll the optimistic flip back on a full ledger
   * (another process holds the lane; the retry timer re-attempts, and other
   * waiters get their pass).
   */
  async #tryGrant(task: TaskEntry): Promise<void> {
    const cap = this.#laneCap(task.provider);
    if (!this.#lanes || !Number.isFinite(cap)) {
      // Coordination off: wake synchronously, as before the ledger.
      const waiters = task.turnWaiters;
      task.turnWaiters = [];
      for (const wake of waiters) wake();
      return;
    }
    const got = await this.#acquireSlotSafe(task.provider);
    if (!got.ok) {
      logger.debug(
        `[task ${task.taskId}] warm turn still waiting: lane '${task.provider}' ledger full`,
      );
      if (task.turnGranted && !task.turnPending) {
        task.turnGranted = false;
        task.turnPending = true;
        task.blocked = true;
        this.#armLanesRetry();
      }
      return;
    }
    if (task.statusRef.value !== TASK_STATUS.RUNNING || !task.turnGranted) {
      // The entry died or its grant was revoked (wakeTurnWaiters) mid-acquire.
      if (got.lease) await this.#releaseLease(got.lease);
      return;
    }
    task.lease = got.lease;
    const waiters = task.turnWaiters;
    task.turnWaiters = [];
    for (const wake of waiters) wake();
  }

  async #releaseLease(lease: LaneLease): Promise<void> {
    if (!this.#lanes) return;
    try {
      await this.#lanes.release(lease);
    } catch (e: unknown) {
      logger.error(`[lanes] slot release failed: ${formatError(e)}`);
    }
  }

  /**
   * Drop an entry's ledger slot (terminal transitions and parked-idle
   * yields). The unlink is async, so a same-lane waiter admitted in the same
   * synchronous pass may momentarily see the slot still held; the post-
   * release wake clears that entry's blocked flag and re-admits it, keeping
   * in-process lane handoff off the slow retry path.
   */
  #releaseSlot(task: TaskEntry): void {
    const lease = task.lease;
    if (!lease) return;
    task.lease = null;
    if (!this.#lanes) return;
    void this.#releaseLease(lease).then(() => {
      let woke = false;
      for (const t of this.#tasks.values()) {
        if (t.blocked && t.provider === lease.lane) {
          t.blocked = false;
          woke = true;
        }
      }
      if (woke) this.#admit();
    });
  }

  /** One shared retry tick while ANY entry waits on a fleet-full lane. */
  #armLanesRetry(): void {
    if (this.#lanesRetryTimer) return;
    const timer = setInterval(() => {
      this.#lanesRetryTimer = null;
      for (const task of this.#tasks.values()) task.blocked = false;
      this.#admit();
    }, this.#lanesRetryMs);
    (timer as { unref?: () => void }).unref?.();
    this.#lanesRetryTimer = timer;
  }

  /** Build and run a started task. Failures land on the task result, not as a rejection to the spawnTask caller. */
  async #launch(
    taskId: string,
    entry: TaskEntry,
    agentConfig: Record<string, unknown>,
    description: TurnPrompt,
    notify: (result: string) => void,
  ): Promise<void> {
    let agent: AgentLike;
    try {
      agent = await this.#buildAgent(agentConfig);
    } catch (err: unknown) {
      // Build failures used to throw out of spawnTask into the delegating
      // tool; queued tasks make that impossible, so they are reported the
      // same way run failures are.
      entry.statusRef.value = TASK_STATUS.FAILED;
      logger.error(`[task ${taskId}] ${formatError(err)}`);
      const result = `Task failed: ${err instanceof Error ? err.message : String(err)}`;
      notify(result);
      // No-turn terminal transition: deliver a synthesized turn result so a
      // parked consumer (workflow engine attempt gate) can never hang.
      entry.onTurn?.({ status: "failed", result });
      this.#releaseSlot(entry);
      entry.settle(TASK_STATUS.FAILED, result);
      this.#admit();
      return;
    }
    if (entry.statusRef.value !== TASK_STATUS.RUNNING) {
      // Cancelled while building. The cancelling transition settles `done`
      // itself; this branch must not assume it (a dangling `done` would hang
      // a parked consumer waiting on onTurn), so settle idempotently after
      // the SESSION_END reclaim, mirroring #finalizeTurn's ordering.
      agent.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId: agent.sessionId });
      if (!entry.settled) {
        this.#releaseSlot(entry);
        entry.onTurn?.({ status: "cancelled", result: "Task aborted" });
        entry.settle(entry.statusRef.value, "Task aborted");
        this.#admit();
      }
      return;
    }
    if (entry.abortController.signal.aborted) {
      entry.statusRef.value = TASK_STATUS.CANCELLED;
      notify("Task aborted");
      entry.onTurn?.({ status: "cancelled", result: "Task aborted" });
      // Discarded fresh agent (turn never ran): same reclaim as above,
      // ordered like #finalizeTurn (status terminal -> hook -> settle).
      agent.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId: agent.sessionId });
      this.#releaseSlot(entry);
      entry.settle(TASK_STATUS.CANCELLED, "Task aborted");
      this.#admit();
      return;
    }
    entry.agent = agent;
    await this.#runTask(taskId, entry, agent, description);
  }

  /**
   * Last-resort recovery for a residual throw inside #launch: log, force a
   * terminal FAILED (idempotent via `settled`), free the lane, then deliver
   * the synthesized turn result and hooks. Consumer callbacks run last and
   * inside their own guard so a faulty consumer cannot resurrect the
   * rejection this method exists to swallow.
   */
  #recoverTask(taskId: string, entry: TaskEntry, e: unknown): void {
    logger.error(`[task ${taskId}] unhandled task fault: ${formatError(e)}`);
    if (!entry.settled) {
      entry.statusRef.value = TASK_STATUS.FAILED;
      const agent = entry.agent;
      entry.agent = null;
      this.#releaseSlot(entry);
      this.#wakeTurnWaiters(entry);
      const result = `Task failed: ${e instanceof Error ? e.message : String(e)}`;
      entry.settle(TASK_STATUS.FAILED, result);
      this.#admit();
      try {
        entry.onTurn?.({ status: "failed", result });
        agent?.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId: agent.sessionId });
      } catch (inner: unknown) {
        logger.error(`[task ${taskId}] recovery callback threw: ${formatError(inner)}`);
      }
    }
  }

  /** Whether a finished turn leaves a parked task RUNNING (its lane slot is held only through the turn). */
  #parked(entry: TaskEntry, turn: TurnResult): boolean {
    return (
      entry.parked &&
      turn.status === "completed" &&
      !entry.releaseRequested &&
      !entry.abortController.signal.aborted
    );
  }

  async #runTask(taskId: string, entry: TaskEntry, agent: AgentLike, description: TurnPrompt): Promise<void> {
    const turn = await this.#driveTurn(taskId, entry, agent, description);
    if (!this.#parked(entry, turn)) this.#finalizeTurn(entry, agent, turn);
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
    const laneCap = this.#laneCap(entry.provider);
    const coordinated = this.#lanes !== null && Number.isFinite(laneCap);
    let ready = false;
    if (coordinated && this.#laneUsed(entry) < laneCap) {
      // Reserve in-process first (the busy guard sees turnGranted), then let
      // the cross-process ledger decide whether the lane has room.
      entry.turnGranted = true;
      const got = await this.#acquireSlotSafe(entry.provider);
      if (
        entry.statusRef.value !== TASK_STATUS.RUNNING ||
        !entry.agent ||
        entry.releaseRequested ||
        entry.abortController.signal.aborted
      ) {
        // Died while awaiting the slot: hand it back.
        entry.turnGranted = false;
        if (got.ok && got.lease) await this.#releaseLease(got.lease);
        return { status: "cancelled", result: "Task aborted" };
      }
      if (got.ok) {
        entry.lease = got.lease;
        ready = true;
      }
      entry.turnGranted = false;
    }
    if (!ready) {
      // The slot was taken while this session sat idle (in-process or by
      // another process): queue for #admit (waiting turns are granted before
      // new spawns).
      entry.turnPending = true;
      // Register the waiter BEFORE admitting: a coordination-off grant wakes
      // synchronously inside #admit, and a wake with no registered waiter
      // would hang this await forever.
      const wake = new Promise<void>((resolve) => entry.turnWaiters.push(resolve));
      this.#admit();
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
    const turn = await this.#driveTurn(taskId, entry, agent, message);
    if (!this.#parked(entry, turn)) this.#finalizeTurn(entry, agent, turn);
    return turn;
  }

  /**
   * Release a parked task as completed. Called while a turn is in flight, the
   * release takes effect once it ends. Returns false for non-parked or
   * non-running tasks.
   */
  completeTask(taskId: string): boolean {
    const entry = this.#tasks.get(taskId);
    if (!entry || !entry.parked || entry.statusRef.value !== TASK_STATUS.RUNNING) return false;
    entry.releaseRequested = true;
    if (!entry.inRun && entry.agent) {
      this.#finalizeTurn(entry, entry.agent, {
        status: "completed",
        result: entry.lastResult ?? "",
      });
    }
    return true;
  }

  /** Run one agent turn; never throws -- failures come back as TurnResult. */
  async #driveTurn(
    taskId: string,
    entry: TaskEntry,
    agent: AgentLike,
    prompt: TurnPrompt,
  ): Promise<TurnResult> {
    entry.inRun = true;
    let turn: TurnResult;
    try {
      agent.abortSignal = entry.abortController.signal;

      // Task descriptions are composed by the delegating model / engine.
      const runResult = await agent.run(prompt, undefined, { source: "model" });

      if (runResult?.type === "completion") {
        turn = { status: "completed", result: runResult.content };
      } else if (runResult?.type === "tool_return") {
        turn = { status: "completed", result: `Task completed via tool return: ${runResult.outcome}` };
      } else {
        turn = { status: "completed", result: `Task provided no response` };
      }
    } catch (err: unknown) {
      if (LlmError.isCancelled(err) || entry.abortController.signal.aborted) {
        turn = { status: "cancelled", result: `Task aborted` };
      } else {
        // Error Handling rule: report through formatError() -- unexpected
        // errors (bugs) log message + full stack, expected ones message
        // only. The delegating model gets the message alone; a stack in its
        // context would waste tokens and leak internals.
        logger.error(`[task ${taskId}] ${formatError(err)}`);
        turn = { status: "failed", result: `Task failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    entry.inRun = false;
    entry.lastResult = turn.result;
    entry.onTurn?.(turn);
    // A parked entry that stays RUNNING has just gone idle: it yields its
    // lane slot here -- in-process accounting AND the cross-process ledger
    // file -- letting queued spawns and waiting warm turns in.
    if (this.#parked(entry, turn)) this.#releaseSlot(entry);
    this.#admit();
    return turn;
  }

  /** Wake queued taskTurn waiters whose entry reached a terminal state. */
  #wakeTurnWaiters(entry: TaskEntry): void {
    entry.turnPending = false;
    entry.turnGranted = false;
    const waiters = entry.turnWaiters;
    entry.turnWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Terminal transition: status, notification, agent release, lane free, `done`. */
  #finalizeTurn(entry: TaskEntry, agent: AgentLike, turn: TurnResult): void {
    if (turn.status === "completed") {
      if (entry.statusRef.value === TASK_STATUS.RUNNING) {
        entry.statusRef.value = TASK_STATUS.COMPLETED;
      }
    } else if (turn.status === "cancelled") {
      entry.statusRef.value = TASK_STATUS.CANCELLED;
    } else {
      entry.statusRef.value = TASK_STATUS.FAILED;
    }

    // For parked tasks the sink drops this (the engine consumed the turn already).
    agent.notifyCompletion?.(turn.result);

    // Release the finished agent: its full message context would otherwise stay pinned in #tasks
    // for the manager's lifetime. The entry keeps only what post-run lookups use; sendFollowUp guards
    // on a live agent, and a RUNNING entry with no agent only exists inside #launch's build window.
    entry.agent = null;

    // Any warm turn still queued behind the lane never runs.
    this.#wakeTurnWaiters(entry);

    // Free lane (ledger slot included): give queued tasks a chance at the
    // released slot.
    this.#releaseSlot(entry);
    this.#admit();

    // The task agent's lifecycle ends here -- announce it through the
    // agent's own (shared) hook system so per-session extension state is
    // reclaimed. Test fakes may carry no hooks, hence the optional chain.
    agent.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId: agent.sessionId });

    entry.settle(entry.statusRef.value, turn.result);
  }

  /** @internal Test-only view of the task registry. */
  get _test_tasks(): ReadonlyMap<string, { agent: AgentLike | null }> {
    return this.#tasks;
  }

  taskStatus(taskId: string): TaskStatus | null {
    const task = this.#tasks.get(taskId);
    if (!task) return null;
    return task.statusRef.value;
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

    if (typeof task.agent.steer === "function") {
      task.agent.steer(message);
      return true;
    }
    return false;
  }

  /** Cancel: queued -> terminal; running -> abort the in-flight turn; parked-idle -> terminal. */
  #interruptEntry(entry: TaskEntry): boolean {
    const status = entry.statusRef.value;
    if (status === TASK_STATUS.QUEUED) {
      // Release any placement reservation so the lane is instantly reusable.
      entry.placing = false;
      // A planning entry (id reserved, plan still awaiting) cancels like any
      // other queued task; the spawnTask continuation sees the terminal state
      // and returns the handle without starting.
      entry.planning = false;
      entry.candidates = null;
      entry.provider = "";
      entry.model = entry.intent;
      entry.statusRef.value = TASK_STATUS.CANCELLED;
      entry.onTurn?.({ status: "cancelled", result: "Task aborted" });
      entry.settle(TASK_STATUS.CANCELLED, "Task aborted");
      this.#admit();
      return true;
    }
    if (status !== TASK_STATUS.RUNNING) return false;
    if (entry.parked && !entry.inRun && entry.agent) {
      // Nothing in flight to abort; terminate directly and free the lane
      // (a task parked before its first turn completed still holds its slot).
      const agent = entry.agent;
      entry.statusRef.value = TASK_STATUS.CANCELLED;
      entry.agent = null;
      this.#wakeTurnWaiters(entry);
      this.#releaseSlot(entry);
      this.#admit();
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
   * Abort every RUNNING task delegated from the given session. Called when
   * that session is deleted, so its subagent tasks don't keep running (and
   * burning tokens) with no session left to receive their results. Tasks
   * owned by other sessions are untouched. Returns how many were aborted.
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
