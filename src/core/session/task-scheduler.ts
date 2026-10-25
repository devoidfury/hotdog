import { logger } from "@utils/logger.ts";
import { formatError } from "../error.ts";
import { loadProfileFile, type ProfileManager } from "../config/profiles.ts";
import type { CoreConfigWithExtensions } from "../config/schema-loader.ts";
import type { ModelConfig } from "../config/providers.ts";
import {
  modelInCatalog,
  parseGroupRef,
  planSpawn,
  warmSortCandidates,
  type LaneCaps,
  type SpawnCandidate,
} from "./model-resolver.ts";
import type { LaneLedger, LaneLease } from "./lane-ledger.ts";
import type { ProviderHealth } from "./provider-health.ts";
import {
  TASK_STATUS,
  type SpawnPlan,
  type SpawnTaskOptions,
  type TaskEntry,
  type TaskManagerSessionManager,
} from "./task-types.ts";

/** Live view into the owning TaskManager (the scheduler -> manager edge). */
interface SchedulerEnv {
  /** Every registry entry, in insertion order (Map.values()). */
  tasks(): Iterable<TaskEntry>;
  /** Current session manager (setSessionManager can swap it at runtime). */
  sessionManager(): TaskManagerSessionManager | null;
}

/**
 * Lane placement + admission for the TaskManager. Owns the provider-lane
 * state (caps, ledger, retry timer, health filtering, spawn planning) and the
 * admit scan that starts queued tasks and grants waiting warm turns; talks
 * back to the manager through SchedulerEnv.
 */
export class TaskScheduler {
  #env: SchedulerEnv;
  #taskProfile: string;
  #profileManager: ProfileManager | undefined;
  #config: CoreConfigWithExtensions;
  #modelRegistry: Record<string, ModelConfig>;
  /** Per-lane caps: global taskLanesPerProvider default + provider taskLanes overrides (shared resolution with session turns). */
  #laneCaps: LaneCaps;
  /** Resolved process default model (agent-factory's own fallback); last chain link for spawn placement. */
  #buildDefaultModel: string;
  #peekLoaded: (provider: string) => Promise<Set<string>>;
  #modelGroups: Record<string, string[]>;
  #noSpread: Set<string>;
  /** Cross-process lane slot ledger (null when lanesDir is unset: caps apply to this process only). */
  #lanes: LaneLedger | null;
  #lanesRetryMs: number;
  #lanesRetryTimer: ReturnType<typeof setTimeout> | null;
  /** Cumulative retry timers actually created (regression witness: must stay ~1 per lanesRetryMs window, never multiply). */
  #lanesRetryTicks = 0;
  /** Provider-pool health registry; null = health feature off (no filtering, no demotion). */
  #providerHealth: ProviderHealth | null;

  constructor(options: {
    env: SchedulerEnv;
    taskProfile: string;
    profileManager: ProfileManager | undefined;
    config: CoreConfigWithExtensions;
    modelRegistry: Record<string, ModelConfig>;
    laneCaps: LaneCaps;
    buildDefaultModel: string;
    peekLoaded: (provider: string) => Promise<Set<string>>;
    modelGroups: Record<string, string[]>;
    noSpread: Set<string>;
    lanes: LaneLedger | null;
    lanesRetryMs: number;
    providerHealth: ProviderHealth | null;
  }) {
    this.#env = options.env;
    this.#taskProfile = options.taskProfile;
    this.#profileManager = options.profileManager;
    this.#config = options.config;
    this.#modelRegistry = options.modelRegistry;
    this.#laneCaps = options.laneCaps;
    this.#buildDefaultModel = options.buildDefaultModel;
    this.#peekLoaded = options.peekLoaded;
    this.#modelGroups = options.modelGroups;
    this.#noSpread = options.noSpread;
    this.#lanes = options.lanes;
    this.#lanesRetryMs = options.lanesRetryMs;
    this.#lanesRetryTimer = null;
    this.#providerHealth = options.providerHealth;
  }

  /** Release the health sweep timer, if the manager built one. */
  stop(): void {
    this.#providerHealth?.stop();
  }

  /** The health registry this scheduler consults for placement (null when the feature is off). */
  get providerHealth(): ProviderHealth | null {
    return this.#providerHealth;
  }

  /** True when a cross-process lane slot ledger is configured. */
  get hasLanes(): boolean {
    return this.#lanes !== null;
  }

  /** Ledger re-attempt interval while tasks wait on foreign-held slots (see TaskManagerOptions.lanesRetryMs). */
  get retryMs(): number {
    return this.#lanesRetryMs;
  }

  /** Cumulative retry timers created (witness for the setInterval multiplication regression). */
  get retryTicks(): number {
    return this.#lanesRetryTicks;
  }

  /**
   * Re-run the admission pass (health recovery callback, tests). Clears
   * lane-blocked flags too: a provider coming back invalidates every "whole
   * candidate set fleet-wide busy" verdict, exactly like a lanes-retry tick --
   * still-full lanes just re-block themselves on the next pass.
   */
  retryQueued(): void {
    for (const t of this.#env.tasks()) t.blocked = false;
    this.admit();
  }

  /**
   * The chain-default model of the delegating side: the explicit parentModel
   * hint captured at call time (workflow engine, delegate_task), else the
   * manager agent's model via the session store. A parent the store cannot
   * resolve (unregistered session, host without a SessionManager) returns
   * undefined; the caller then falls to the catalog default and finally the
   * process build default, instead of placing the task on the uncapped phantom
   * lane.
   */
  #parentModel(options: SpawnTaskOptions): string | undefined {
    const hint =
      typeof options.parentModel === "string" ? options.parentModel.trim() : "";
    if (hint) return hint;
    if (!options.managerAgent) return undefined;
    const model = this.#env.sessionManager()?.getAgentBySessionId?.(options.managerAgent.sessionId)?.model;
    return typeof model === "string" && model.length > 0 ? model : undefined;
  }

  /**
   * Profile load + model admission for spawnTask, kept in its own async
   * method so the collision check -> id reservation sequence in spawnTask
   * contains no await. Plan failures throw loud, like pin misses; the
   * caller drops the reservation and lets the error reach the delegating tool.
   */
  async planForSpawn(taskId: string, options: SpawnTaskOptions): Promise<SpawnPlan> {
    const profileName = options.profile || this.#taskProfile;
    const taskProfile = this.#profileManager
      ? this.#profileManager.getProfile(profileName)
      : await loadProfileFile(this.#config.profilesPath ?? "", profileName);

    // Model admission -> placement plan. pin/group/requires validate against
    // the catalog and fail loud before registration; the legacy chain expands
    // bare values and the registry default into cross-provider copies (cold,
    // never errors) while a provider-qualified explicit value stays strict.
    // A worker profile may bind fanout via its `group` field; an explicit
    // worker_model wins over it, same precedence as over profile model.
    const profileGroup = taskProfile?.group || undefined;
    if (
      !options.workerModel &&
      typeof taskProfile?.model === "string" &&
      taskProfile.model.startsWith("group:")
    ) {
      // Otherwise this lands in the legacy expand branch, finds no catalog
      // copies for the pseudo-name, and launches with the literal "group:..."
      // as the model -- a runtime API error, not a config error.
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
        `parent=${this.#parentModel(options) ?? "-"} registrySize=${Object.keys(this.#modelRegistry).length}`,
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
      if (explicit && !modelInCatalog(this.#modelRegistry, explicit)) {
        // A bogus explicit pin is a caller error: fail at dispatch, not as an HTTP 404 from the gateway
        throw new Error(`[task ${taskId}] worker model '${explicit}' is not in the model catalog`);
      }
      // Chain default: the delegating session's model (call-time hint or
      // session-store lookup), then the catalog's `default` key (vestigial in
      // practice), then the process's resolved default model -- the exact value
      // agent-factory runs on an empty model string. Naming it keeps the task
      // PLACED on that provider's lane (cap + ledger slot apply) instead of
      // running unlocked on the phantom bare-name lane. Explicit qualified
      // values honor their provider; bare values and the chain default can go
      // anywhere the name exists.
      const parentModel = this.#parentModel(options);
      const chainDefault = parentModel || registryDefault || this.#buildDefaultModel;
      const expandable = !explicit || explicit === registryDefault || !explicit.includes("/");
      modelLabel = explicit || chainDefault;
      headKey = modelLabel;
      if (!modelLabel) {
        logger.warn(
          `[task ${taskId}] no model resolved (no worker_model, profile model, parent session model, catalog default, or build default model); the agent build default will run the task, unplaced on the bare-name lane`,
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
    return { profileName, taskProfile, candidates, modelLabel, headKey };
  }

  /**
   * Whether an entry consumes a slot on its provider lane right now.
   * Non-parked tasks hold from start to terminal. A parked task holds it
   * through its first turn and whenever a turn is in flight or waiting, but
   * yields while idle between turns: an idle parked session generates no model
   * traffic, and holding on would deadlock it against whatever must run on its
   * lane (a judge for the parked producer, under cap 1). Warm turns
   * re-acquire the slot through this scan.
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
  laneCap(provider: string): number {
    return this.#laneCaps.capOf(provider);
  }

  /** Lanes used by OTHER entries on this entry's provider. */
  laneUsed(entry: TaskEntry): number {
    let n = 0;
    for (const task of this.#env.tasks()) {
      if (task !== entry && task.provider === entry.provider && this.#occupies(task)) n++;
    }
    return n;
  }

  /**
   * Drop placement candidates whose provider is marked down.
   * Fails open when every candidate is down, a task queued forever on
   * a pool we only think is dead is worse than one that retries and fails loudly.
   * Pinned tasks have `candidates === null` and never pass through here.
   */
  #eligibleByHealth(cands: SpawnCandidate[]): SpawnCandidate[] {
    if (!this.#providerHealth) return cands;
    const up = cands.filter((c) => !this.#providerHealth!.isDown(c.provider));
    return up.length > 0 ? up : cands;
  }

  /**
   * Start QUEUED entries and grant waiting warm turns whose provider lane has
   * room, in insertion order. The scan is global, not per-lane, so a task
   * queued on a saturated provider never head-of-line-blocks a later task on a
   * free provider; waiting warm turns are granted before new spawns, and a
   * parked session that yielded its slot gets it back ahead of fresh work.
   *
   * Placement: locked entries (candidates === null) enter on their lane;
   * multi-candidate entries take the first candidate with capacity
   * (plan order = warm-first), reserving then re-ranking via #warmPlace. Every
   * start/grant additionally takes a cross-process ledger slot (when
   * configured): the in-process scan decides ORDER, the ledger CAPACITY across
   * all hotdog processes on the machine.
   */
  admit(): void {
    // Warm grants count occupancy WITHOUT other warm waiters: a pending waiter reserves the slot but does not hold it.
    // Counting waiters made each one see the next waiter as the blocker,
    // so two waiters on a cap-1 lane mutually refused and none was ever granted.
    // A grant flips the waiter to turnGranted, which DOES count, so waiters on one lane are granted one at a time in insertion order (FIFO).
    const warmUsed = new Map<string, number>();
    for (const task of this.#env.tasks()) {
      if ((this.#occupies(task) || task.placing) && !task.turnPending) {
        warmUsed.set(task.provider, (warmUsed.get(task.provider) ?? 0) + 1);
      }
    }
    for (const task of this.#env.tasks()) {
      if (!task.turnPending || task.statusRef.value !== TASK_STATUS.RUNNING) continue;
      if (task.blocked) continue; // ledger-full last pass; the lanes timer retries
      const n = warmUsed.get(task.provider) ?? 0;
      if (n < this.laneCap(task.provider)) {
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
    for (const task of this.#env.tasks()) {
      if (task.statusRef.value !== TASK_STATUS.QUEUED) continue;
      // Planning reservations claim the id but are not startable yet (the
      // spawnTask continuation fills and clears `planning` before admitting).
      if (task.blocked || task.acquiring || task.planning) continue;
      if (!task.candidates) {
        const n = used.get(task.provider) ?? 0;
        if (n < this.laneCap(task.provider)) {
          used.set(task.provider, (used.get(task.provider) ?? 0) + 1);
          void this.#tryStart(task);
        } else {
          logger.debug(
            `[task ${task.taskId}] locked lane '${task.provider}' in-process full (${n}/${this.laneCap(task.provider)}); queued`,
          );
        }
        continue;
      }
      if (task.placing) continue;
      // Multi-candidate entry:
      // health first (a dead provider looks idle and warm, i.e. the PREFERRED victim),
      // then eligibility (warm-but-full lane must not starve a cold-idle one),
      // then plan order (warm-first at spawn, refreshed by #warmPlace before the start).
      const pool = this.#eligibleByHealth(task.candidates);
      const eligible = pool.filter(
        (c) => (used.get(c.provider) ?? 0) < this.laneCap(c.provider),
      );
      if (eligible.length === 0) {
        logger.debug(
          `[task ${task.taskId}] every candidate lane in-process full (${task.candidates
            .map((c) => `${c.provider}:${used.get(c.provider) ?? 0}/${this.laneCap(c.provider)}`)
            .join(", ")}); queued`,
        );
        continue; // whole copy-set/group saturated
      }
      if (eligible.length === 1 && task.candidates.length === 1) {
        this.place(task, eligible[0]!);
        task.candidates = null;
        used.set(task.provider, (used.get(task.provider) ?? 0) + 1);
        void this.#tryStart(task);
        continue;
      }
      // Several possible homes: reserve the head now so concurrent admit
      // passes (or the sibling of a two-task fanout) cannot double-take it,
      // then re-rank by CURRENT warmth and start.
      this.place(task, eligible[0]!);
      task.placing = true;
      used.set(task.provider, (used.get(task.provider) ?? 0) + 1);
      void this.warmPlace(task);
    }
  }

  /** Per-lane occupancy by RUNNING holders and placement reservations. */
  #laneOccupancy(except?: TaskEntry): Map<string, number> {
    const used = new Map<string, number>();
    for (const task of this.#env.tasks()) {
      if (task === except) continue;
      if (this.#occupies(task) || task.placing) {
        used.set(task.provider, (used.get(task.provider) ?? 0) + 1);
      }
    }
    return used;
  }

  /** Lock a placement candidate into the entry (lane, display model, agent config). */
  place(task: TaskEntry, c: SpawnCandidate): void {
    task.provider = c.provider;
    task.model = c.key;
    task.agentConfig.model = c.key;
  }

  /**
   * Finish a multi-candidate placement: re-sort the plan by current cache
   * warmth, take a slot on the warmest candidate whose lane has in-process
   * room, then start. If every candidate is fleet-wide busy, drop the
   * reservation and stay QUEUED (the lanes timer retries). Cancelled entries
   * unwind without starting, releasing their reservation with the flag.
   */
  async warmPlace(task: TaskEntry): Promise<void> {
    // filter the plan BEFORE the warm sort: warmSortCandidates peeks /running on every plan provider (2s timeout each),
    // so a known-dead node would add a peek penalty to every placement attempt.
    const plan = this.#eligibleByHealth(task.candidates ?? []);
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
      this.admit();
      return;
    }
    logger.debug(
      `[task ${task.taskId}] warm placement: ${warm.map((c) => c.key).join(" > ")}`,
    );
    const used = this.#laneOccupancy(task);
    // failure-driven markDown lands synchronously, so filter on health again:
    // the provider can go down between the admit pass and here.
    for (const c of this.#eligibleByHealth(warm)) {
      if ((used.get(c.provider) ?? 0) >= this.laneCap(c.provider)) {
        logger.debug(
          `[task ${task.taskId}] skip '${c.provider}': in-process full (${used.get(c.provider)}/${this.laneCap(c.provider)})`,
        );
        continue;
      }
      const got = await this.acquireSlotSafe(c.provider);
      if (task.statusRef.value !== TASK_STATUS.QUEUED || !task.start) {
        // Cancelled while awaiting the slot: hand it straight back.
        if (got.ok && got.lease) await this.releaseLease(got.lease);
        this.admit();
        return;
      }
      if (!got.ok) {
        logger.debug(`[task ${task.taskId}] skip '${c.provider}': ledger full (fleet-wide)`);
        continue; // this lane is fleet-wide busy; try the next home
      }
      // The `used` snapshot above is one await stale: this entry's reservation
      // was dropped at the top, so a sibling could have committed to this lane
      // while we awaited the slot (both saw it free). Without the re-check two
      // tasks can double-book a capped lane.
      const usedNow = this.#laneOccupancy(task).get(c.provider) ?? 0;
      if (usedNow >= this.laneCap(c.provider)) {
        logger.debug(
          `[task ${task.taskId}] skip '${c.provider}': filled during slot acquire (${usedNow}/${this.laneCap(c.provider)})`,
        );
        if (got.ok && got.lease) await this.releaseLease(got.lease);
        continue;
      }
      if (c.provider !== task.provider || c.key !== task.model) this.place(task, c);
      task.candidates = null;
      task.lease = got.lease;
      logger.debug(
        `[task ${task.taskId}] placed on '${c.provider}' (${c.key})${got.lease ? ` slot=${got.lease.path}` : " (no ledger)"}`,
      );
      task.start!();
      this.admit();
      return;
    }
    // No lane has room anymore: release the reservation and wait. The abandoned
    // candidate key must not linger in the view: while unplaced, model shows
    // the intent (taskLane's documented contract).
    logger.debug(`[task ${task.taskId}] no placement home left; queued for retry`);
    task.provider = "";
    task.model = task.intent;
    if (this.#lanes) {
      task.blocked = true;
      this.#armLanesRetry();
    }
    this.admit();
  }

  // -- cross-process lane slots ---------------------------------------------

  /** Take a ledger slot for `provider`; ok with a null lease when coordination is off/uncapped. */
  async #acquireSlot(provider: string): Promise<{ ok: true; lease: LaneLease | null } | { ok: false }> {
    const cap = this.laneCap(provider);
    if (!this.#lanes || !Number.isFinite(cap)) return { ok: true, lease: null };
    const lease = await this.#lanes.acquire(provider, cap);
    return lease ? { ok: true, lease } : { ok: false };
  }

  /** Acquire that FAILS OPEN on ledger filesystem errors: an unusable state dir must not deadlock tasks. */
  async acquireSlotSafe(provider: string): Promise<{ ok: true; lease: LaneLease | null } | { ok: false }> {
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
   * during the acquire releases the slot back; a ledger-full result marks the
   * entry blocked (the retry timer clears the flag and re-admits). With
   * coordination off the start stays synchronous, as before the ledger.
   */
  async #tryStart(task: TaskEntry): Promise<void> {
    const cap = this.laneCap(task.provider);
    if (!this.#lanes || !Number.isFinite(cap)) {
      logger.debug(
        `[task ${task.taskId}] start on '${task.provider}' uncoordinated (lane cap ${cap === Number.POSITIVE_INFINITY ? "unlimited" : cap}, ledger ${this.#lanes ? "on" : "off"})`,
      );
      if (task.statusRef.value === TASK_STATUS.QUEUED && task.start) task.start();
      return;
    }
    task.acquiring = true;
    const got = await this.acquireSlotSafe(task.provider);
    task.acquiring = false;
    if (!got.ok) {
      logger.debug(`[task ${task.taskId}] lane '${task.provider}' ledger full; blocked`);
      task.blocked = true;
      this.#armLanesRetry();
      return;
    }
    if (task.statusRef.value !== TASK_STATUS.QUEUED || !task.start) {
      if (got.lease) await this.releaseLease(got.lease);
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
   * (another process holds the lane; the retry timer re-attempts, waiters get
   * their pass).
   */
  async #tryGrant(task: TaskEntry): Promise<void> {
    const cap = this.laneCap(task.provider);
    if (!this.#lanes || !Number.isFinite(cap)) {
      // Coordination off: wake synchronously, as before the ledger.
      const waiters = task.turnWaiters;
      task.turnWaiters = [];
      for (const wake of waiters) wake();
      return;
    }
    const got = await this.acquireSlotSafe(task.provider);
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
      if (got.lease) await this.releaseLease(got.lease);
      return;
    }
    task.lease = got.lease;
    const waiters = task.turnWaiters;
    task.turnWaiters = [];
    for (const wake of waiters) wake();
  }

  async releaseLease(lease: LaneLease): Promise<void> {
    if (!this.#lanes) return;
    try {
      await this.#lanes.release(lease);
    } catch (e: unknown) {
      logger.error(`[lanes] slot release failed: ${formatError(e)}`);
    }
  }

  /**
   * Drop an entry's ledger slot (terminal transitions and parked-idle yields).
   * The unlink is async, so a same-lane waiter admitted in the same sync pass
   * may momentarily see the slot still held; the post-release wake clears that
   * entry's blocked flag and re-admits it, keeping in-process lane handoff off
   * the slow retry path.
   */
  releaseSlot(task: TaskEntry): void {
    const lease = task.lease;
    if (!lease) return;
    task.lease = null;
    if (!this.#lanes) return;
    void this.releaseLease(lease).then(() => {
      let woke = false;
      for (const t of this.#env.tasks()) {
        if (t.blocked && t.provider === lease.lane) {
          t.blocked = false;
          woke = true;
        }
      }
      if (woke) this.admit();
    });
  }

  /**
   * One shared retry tick while ANY entry waits on a fleet-full lane.
   * Deliberately a one-shot setTimeout: the callback clears the tracked handle
   * before re-admitting, and every still-failing pass re-arms through here, so
   * the slot guard admits at most one pending tick.
   */
  #armLanesRetry(): void {
    if (this.#lanesRetryTimer) return;
    this.#lanesRetryTicks++;
    const timer = setTimeout(() => {
      this.#lanesRetryTimer = null;
      for (const task of this.#env.tasks()) task.blocked = false;
      this.admit();
    }, this.#lanesRetryMs);
    timer.unref?.();
    this.#lanesRetryTimer = timer;
  }
}
