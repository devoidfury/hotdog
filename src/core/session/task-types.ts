import type { MessageSource } from "../context/message.ts";
import type { OutputEvent } from "../context/output.ts";
import type { ProfileDef, ProfileManager } from "../config/profiles.ts";
import type { CoreConfigWithExtensions } from "../config/schema-loader.ts";
import type { ModelConfig } from "../config/providers.ts";
import type { ModelRequirements, SpawnCandidate, SpawnPin } from "./model-resolver.ts";
import type { LaneLease } from "./lane-ledger.ts";
import type { ProviderHealth } from "./provider-health.ts";
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

export function isTerminalStatus(status: TaskStatus): boolean {
  return (
    status === TASK_STATUS.COMPLETED ||
    status === TASK_STATUS.FAILED ||
    status === TASK_STATUS.CANCELLED
  );
}

/**
 * Hard bound on terminal (completed/failed/cancelled) records kept in the registry.
 * Without it a long-lived daemon's #tasks grows with every task ever run:
 * terminal entries are otherwise removed by nobody (only the spawn-plan-failure path deletes),
 * and several lookups are full scans.
 * 
 * Policy: on every terminal transition, keep the most recent MAX_TERMINAL_TASKS terminal records --
 * most recently ENDED first, insertion order breaking same-clock ties -- and evict the rest.
 * QUEUED/RUNNING entries are never touched. An evicted id reads exactly like a post-restart id.
 */
export const MAX_TERMINAL_TASKS = 200;

/** Display-oriented snapshot of one task (webui subagents panel, diagnostics). */
export interface TaskInfo {
  taskId: string;
  /** Spawn description, whitespace-flattened and truncated. */
  description: string;
  /** The delegating session (null: no parent, e.g. workflow-engine spawns). */
  sessionId: string | null;
  status: TaskStatus;
  createdAt: number;
  /** Set when the task first enters RUNNING; null while queued. */
  startedAt: number | null;
  /** Set on the terminal transition; null until then. */
  endedAt: number | null;
  /**
   * Accumulated wall milliseconds the task's OWN agent turns have run, banked at each turn end.
   * Excludes lane-queue waits, judging parks, and between-retry gaps (mirrors the engine's runtime-cap accounting).
   * The display clock should use activeMs (+ live turn time) rather than now - startedAt, so parked RUNNING tasks freeze.
   */
  activeMs: number;
  /** True while an agent turn is in flight. RUNNING && !inRun means parked. */
  inRun: boolean;
  /** Wall start of the in-flight turn; null when none. Live display = activeMs + (now - turnStartedAt); frozen at activeMs while null. */
  turnStartedAt: number | null;
}

/**
 * Observation stream for external consumers (the websocket/webui relay).
 * `task` fires once at spawn, on every status change, and at every turn
 * boundary (start/end) with a fresh snapshot -- the turn-boundary events carry
 * the inRun/turnStartedAt flips the display clock needs while status stays
 * RUNNING (parked judge waits, warm retries);
 * `activity` forwards every OutputEvent the task agent's sink receives, tagged with the task id.
 * Task output never reaches the main chat transcript through this path.
 */
export type TaskObserverEvent =
  | { kind: "task"; task: TaskInfo }
  | { kind: "activity"; taskId: string; event: OutputEvent };

export type TaskObserver = (event: TaskObserverEvent) => void;

/** Single-line task description for displays; flatten whitespace, cap length. */
export function describeTask(prompt: TurnPrompt): string {
  const MAX = 140;
  let text = "";
  if (typeof prompt === "string") {
    text = prompt;
  } else {
    text = prompt
      .map((p) => {
        const part = p as { type?: unknown; text?: unknown };
        return part && part.type === "text" && typeof part.text === "string" ? part.text : "";
      })
      .join(" ");
  }
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX ? `${flat.slice(0, MAX - 1)}…` : flat;
}

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
  /** Explicit model pin, validated against the catalog, locked for the task's lifetime. Supersedes workerModel. */
  pin?: SpawnPin;
  /** Capability requirements resolved against the catalog when no pin is given; loaded-model preference via /running. */
  requires?: ModelRequirements;
  /**
   * Declared model-group fanout (config modelGroups; "group:<name>" through
   * worker_model and the worker profile's `group` field also land here).
   * Members are interchangeable: placement takes any member with a free lane.
   * Mutually exclusive with pin.
   */
  group?: string;
  /** The agent that delegated this task; its session's bus is the delivery target for the completion result. */
  managerAgent?: { sessionId: string } | null;
  /**
   * Chain-default model hint: the delegating session's model, captured at call
   * time. Used by spawn paths the session store cannot resolve (workflow
   * engine's parked nodes; hosts without a wired sessionManager), so the task
   * is placed on the parent's model lane rather than the bare-name lane.
   * Takes precedence over the managerAgent store lookup.
   */
  parentModel?: string;
  /**
   * Park between turns (workflow-engine only): after each agent turn the task
   * stays RUNNING with its warm session; it holds its provider-lane slot
   * through turns but yields it while idle, so queued spawns and other nodes
   * (e.g. its judge) run on; a follow-up turn re-acquires the slot. The
   * consumer drives further turns via taskTurn() and releases via
   * completeTask() or interruptTask(). Bus delivery is suppressed -- the
   * consumer receives every turn through onTurn/taskTurn instead.
   */
  park?: boolean;
  /**
   * Fires after every agent turn (including the one that ends a parked task),
   * and with a synthesized failed/cancelled result when a task dies without
   * ever running a turn -- a parked consumer waiting on onTurn can never hang.
   * completeTask on a parked-idle task does not re-fire it (already delivered).
   */
  onTurn?: (turn: TurnResult) => void;
  /**
   * Fires when an agent turn actually begins: on cold start (lane in hand) and
   * on each warm taskTurn once it re-acquires the lane -- NOT while queued for
   * a slot. Lets consumers (the workflow engine's runtime cap) count only real
   * worker run time.
   */
  onTurnStart?: () => void;
}

export interface TaskManagerOptions {
  modelRegistry: Record<string, ModelConfig>;
  config: CoreConfigWithExtensions;
  /**
   * Resolved profiles dir (resolved config: profilesPath, compute default).
   * Used when no ProfileManager is injected: task profiles load from this dir.
   * Hand-built hosts may carry it on the config bag instead.
   */
  profilesPath?: string;
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
  /**
   * Append-only restart sidecar for delegate_task records (resolved config:
   * taskSpawnsPath, a JSONL file in the data dir). One spawn line per
   * non-parked spawn, one end line per terminal transition; the next process
   * lifetime reads it to surface restart orphans (plan_status / task_status).
   * Unset disables the sidecar entirely. Parked (workflow-engine) spawns are
   * skipped: their lifecycle lives in the run journal, not here.
   */
  spawnLogPath?: string | null;
  /** Test seam for the spawn sidecar's owner-liveness check (default: signal-0 on this host). */
  spawnLogPidAlive?: (pid: number) => boolean;
  /** Ledger re-attempt interval while tasks wait on foreign-held slots. Test seam. */
  lanesRetryMs?: number;
  /**
   * Shared provider-pool health registry. An explicit injection wins
   * (shared / test seams); an explicit null opts out. When absent the manager
   * builds its own: healthIntervalSecs gates only the sweep TIMER, so
   * failure-driven demotion and placement filtering stay active even at 0.
   */
  providerHealth?: ProviderHealth | null;
  /** Sweep interval in seconds (resolved providerHealthCheckIntervalSecs). */
  healthIntervalSecs?: number;
  /** Probe timeout in seconds (resolved healthCheckTimeout). */
  healthCheckTimeoutSecs?: number;
  /**
   * Resolved contextLimit (default 128000): the fallback for catalog-piggyback entries.
   * Must be the resolved value, not config.contextLimit; a sweep must give a context-less remote model the same limit the boot registry did.
   */
  healthContextLimit?: number;
  /**
   * Treat a follow-up as the answer to the task's pending question (the
   * websocket host wires its question bridge in). True when it was: a steer
   * would sit behind the question forever.
   */
  resolvePendingQuestion?: (sessionId: string, text: string) => boolean;
}

export interface TaskManagerRequiredOptions {
  buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  maxIterations: number;
  taskProfile: string;
  /**
   * Concurrent task-agent turns allowed per provider lane (resolved config:
   * taskLanesPerProvider). A provider's `taskLanes` in config overrides this
   * for its lane. Undefined or < 1 means unlimited -- lane queueing exists
   * because backend nodes thrash KV caches when too many models swap
   * concurrently. A parked task holds its slot only while a turn is in flight
   * (or waiting); while idle it yields, so it never blocks nodes that must run
   * against it (e.g. a judge for the parked producer).
   */
  lanesPerProvider?: number;
  /**
   * The process's resolved default model (resolved config: model) -- exactly
   * what the agent factory falls back to when a spawn leaves the model empty.
   * Last link in the spawn chain default (after parent model and catalog
   * default), so the task is PLACED on the provider its traffic actually hits
   * instead of running unplaced on the phantom bare-name lane, where its
   * provider cap and ledger slot would never apply.
   */
  defaultModel?: string | null;
}


export interface TaskEntry {
  /** Spawn id, for diagnostics. */
  taskId: string;
  /** Display metadata for observers (webui subagents panel). */
  description: string;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
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
  /** Accumulated agent-turn milliseconds, banked at each turn end (see TaskInfo.activeMs). */
  activeMs: number;
  /** Wall start of the in-flight turn; null when none (see TaskInfo.turnStartedAt). */
  turnStartedAt: number | null;
  /** True while a warm taskTurn waits for a free lane slot (granted by #admit). */
  turnPending: boolean;
  /** True between a #admit grant of a warm turn and the turn actually starting (holds the slot). */
  turnGranted: boolean;
  turnWaiters: Array<() => void>;
  /** Set by completeTask(); finalizes the task after the in-flight turn ends. */
  releaseRequested: boolean;
  /**
   * Blocked in a question-tool wait. onTaskQuestionAsked yielded the lane slot
   * (a blocked asker holding the lane keeps the delegating manager -- often on
   * the same lane -- from waking to answer); onTaskQuestionSettled takes it
   * back before the tool's promise resolves.
   */
  questionYielded: boolean;
  onTurn?: (turn: TurnResult) => void;
  /** Fires at the start of every agent turn (see SpawnTaskOptions.onTurnStart). */
  onTurnStart?: () => void;
  /** Result of the most recent turn (completeTask on a parked-idle task reports it). */
  lastResult: string | undefined;
  /** True once `settle` has resolved the handle's `done` promise. */
  settled: boolean;
  /** Idempotent resolution of the handle's `done` promise. */
  settle: (status: TaskStatus, result: string) => void;
}

/** Profile + placement plan produced by #planForSpawn before an entry starts. */
export interface SpawnPlan {
  /** Resolved worker profile name (options.profile || task-profile default). */
  profileName: string;
  taskProfile: ProfileDef | null;
  candidates: SpawnCandidate[] | null;
  modelLabel: string;
  headKey: string;
}
