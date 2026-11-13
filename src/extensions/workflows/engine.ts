/**
 * Workflow engine — executes validated Workflow graphs on TaskManager provider
 * lanes.
 *
 * One run = one directory: `run.jsonl` (append-only state-transition log, the
 * session-log idiom) + the nodes' output files. Each node is a *parked*
 * TaskManager task: a gate-failed retry is a warm follow-up turn on the same
 * session (KV cache stays warm; the parked task yields its lane slot
 * while idle so judges/siblings never queue behind it); after an
 * infra failure the next attempt cold re-admits. Gates are machine-readable:
 * declared output files exist inside the run dir and are fresh for the run,
 * plus a `<node>.verdict` file whose first line is `pass|fail|reject`.
 * Every node terminates exactly one way: succeeded / failed / blocked /
 * cancelled. Cancel uses task-interrupt semantics; resume is reconcile
 * (validate completed claims against the filesystem, reuse only what matches).
 */

import { appendFile, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import type {
  SpawnTaskOptions,
  TaskHandle,
  TaskStatus,
  TurnPrompt,
  TurnResult,
} from "@core/session/task-types.ts";
import type { Workflow, WorkflowLimits, WorkflowNode } from "./workflow.ts";
import { nodeDeps, resolveWorkflowLimits } from "./workflow.ts";
import {
  claimRunDir,
  readRunLog,
  readVerdictFile,
  validateClaims,
  RUN_OWNER_FILE,
  type ClaimOptions,
  type FileClaim,
  type RunLogEvents,
} from "./run-store.ts";

export const NODE_STATE = {
  PENDING: "pending",
  /** A worker turn (or its gate evaluation) is the current activity. */
  RUNNING: "running",
  /** Producer files + own verdict passed; the judge node is deciding. */
  JUDGING: "judging",
  SUCCEEDED: "succeeded",
  FAILED: "failed",
  /** Upstream exhausted/failed, or the judge broke: recoverable via reconcile/re-run. */
  BLOCKED: "blocked",
  CANCELLED: "cancelled",
  /**
   * Manager-retirement state: workflow_control action=skip writes it into a
   * dead run's terminal journal event only. The live engine never transitions
   * a node to it -- it exists so readers share one status vocabulary.
   */
  SKIPPED: "skipped",
} as const;
export type NodeState = (typeof NODE_STATE)[keyof typeof NODE_STATE];

const TERMINAL: ReadonlySet<NodeState> = new Set([
  NODE_STATE.SUCCEEDED,
  NODE_STATE.FAILED,
  NODE_STATE.BLOCKED,
  NODE_STATE.CANCELLED,
  NODE_STATE.SKIPPED,
]);

type NodeOutcome = "succeeded" | "failed" | "blocked" | "cancelled" | "skipped";

const OUTCOME_STATE: Record<NodeOutcome, NodeState> = {
  succeeded: NODE_STATE.SUCCEEDED,
  failed: NODE_STATE.FAILED,
  blocked: NODE_STATE.BLOCKED,
  cancelled: NODE_STATE.CANCELLED,
  skipped: NODE_STATE.SKIPPED,
};

/** mtime slack for freshness: fs clock granularity at run start. */
const FRESH_GRACE_MS = 1000;
/** Cap on upstream summaries spliced into a node prompt (pointers, not payloads). */
const MAX_SUMMARY_CHARS = 1200;
/** Cap on judge/worker critique spliced into a retry prompt. */
const MAX_CRITIQUE_CHARS = 2000;

/** The TaskManager surface the engine drives (satisfied by TaskManager). */
export interface EngineTaskPort {
  spawnTask(taskId: string, prompt: TurnPrompt, opts: SpawnTaskOptions): Promise<TaskHandle>;
  taskTurn(taskId: string, message: TurnPrompt): Promise<TurnResult>;
  completeTask(taskId: string): boolean;
  interruptTask(taskId: string): boolean;
  sendFollowUp(taskId: string, message: string): boolean;
  taskStatus?(taskId: string): TaskStatus | null;
}

export interface RunConfig {
  workflow: Workflow;
  runId: string;
  /** Absolute path; created when missing. A dir already holding run.jsonl resumes. */
  runDir: string;
  tasks: EngineTaskPort;
  /**
   * The dispatching session's model, captured at dispatch time: chain
   * default for nodes/judges that carry no pin/group/profile model, so they
   * place on a real provider lane instead of the uncapped bare-name lane.
   */
  parentModel?: string;
  /**
   * Dispatching session id, stamped on every node spawn as managerAgent so
   * the webui subagent feed (scoped by task sessionId) sees them. Absent for
   * session-less hosts (foreground CLI).
   */
  managerSessionId?: string;
  limits?: Partial<WorkflowLimits>;
  /** Test seam for the wall-clock node cap (default: workflow/config minutes).
   *  An explicit override enforces regardless of enableRuntimeTimeouts. */
  maxRuntimeMsOverride?: number;
  /**
   * The effective workflows.enableRuntimeTimeouts AT DISPATCH: the caller
   * reads the live value when it builds this run (B7 -- the extension hands
   * over a per-dispatch read, not a load-time snapshot), and this constructor
   * freezes it for the life of the run. False keeps every runtime-cap kill
   * point dormant; the run duration accounting (and the run.jsonl stats it
   * feeds) is untouched. A publish mid-run changes the NEXT dispatch only.
   */
  enableRuntimeTimeouts?: boolean;
  /** Test seam for the run-dir ownership claim (pid/host/liveness). Defaults to this process. */
  claimOptions?: ClaimOptions;
}

export interface NodeStatusView {
  id: string;
  state: NodeState;
  attempt: number;
  task: string | null;
  taskStatus: TaskStatus | null;
  detail: string | null;
}

export interface RunSummary {
  runId: string;
  /**
   * `skipped` is never produced by the engine itself: workflow_control
   * action=skip writes it into a dead (ownerless) run's journal. It rides the
   * same readers, so the union stays honest end to end.
   */
  outcome: "succeeded" | "failed" | "cancelled" | "skipped";
  states: Record<string, NodeState>;
}

interface GateResult {
  ok: boolean;
  /** The retryOn bucket this failure belongs to. */
  kind: "fail" | "reject";
  detail: string;
  verdict?: string;
  /** Notes below the verdict enum line (judge critique rides here). */
  note?: string;
  files?: Record<string, FileClaim>;
}

/** One-shot promise fed by the task's onTurn callback (or cancel/interrupt). */
class TurnGate {
  #resolve: ((t: TurnResult) => void) | null = null;
  readonly promise: Promise<TurnResult>;
  constructor() {
    this.promise = new Promise<TurnResult>((res) => {
      this.#resolve = res;
    });
  }
  deliver(t: TurnResult): void {
    const r = this.#resolve;
    this.#resolve = null;
    r?.(t);
  }
}

interface NodeRun {
  node: WorkflowNode;
  deps: string[];
  state: NodeState;
  attempt: number;
  /** Live (running, queued or parked) task backing the current attempt chain. */
  task: string | null;
  gate: TurnGate | null;
  /** Wall-clock ms the worker actually spent running (runtime cap source). */
  runtimeUsedMs: number;
  /** Set while a worker turn is running; null while queued or parked-idle. */
  runtimeRunningSince: number | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  runtimeKilled: boolean;
  detail: string | null;
  outcome: NodeOutcome | null;
  /** workflow_control node-cancel: stops the ladder for THIS node only. */
  cancelRequested: boolean;
  verdict: string | null;
  /** Last worker turn result — a pointer summary, safe to splice downstream. */
  summary: string;
  fileClaims: Record<string, FileClaim> | null;
  /** Judges only: own gate ever passed (a verdict was delivered). */
  ownGatePassed: boolean;
  /** Judges only: id of the node this judge gates. */
  judgeFor: string | null;
  settled: Promise<void>;
  resolve: () => void;
}

function livePin(n: WorkflowNode): WorkflowNode["pin"] | undefined {
  return n.pin && (n.pin.provider || n.pin.model) ? n.pin : undefined;
}

function liveRequires(n: WorkflowNode): WorkflowNode["requires"] | undefined {
  const r = n.requires;
  return r && (r.ctx || r.vision || r.toolCalls || r.toolDifficulty) ? r : undefined;
}

function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/** Prompt content part (see #composePrompt for the text/untrusted contract). */
export type PromptPart = Record<string, unknown>;
const partText = (t: string): PromptPart => ({ type: "text", text: t });
const partUntrusted = (t: string): PromptPart => ({ type: "untrusted", text: t });

/**
 * Gate critique spliced into the next attempt: the engine's reason rides as
 * text; the verdict-file note and the prior summary are model-authored and
 * ride `untrusted`.
 */
function critiqueParts(gateResult: GateResult, turnResult: string): PromptPart[] {
  const parts: PromptPart[] = [
    partText(`reason: ${gateResult.kind} — ${gateResult.detail}`),
  ];
  if (gateResult.note) {
    parts.push(partText("critique:"), partUntrusted(clip(gateResult.note, MAX_CRITIQUE_CHARS)));
  }
  parts.push(partText("your previous summary:"), partUntrusted(clip(turnResult, MAX_SUMMARY_CHARS)));
  return parts;
}

export class WorkflowRun {
  #cfg: RunConfig;
  #limits: WorkflowLimits;
  #timeoutsEnabled: boolean;
  #runs = new Map<string, NodeRun>();
  #cancelRequested = false;
  #taskSeq = 0;
  #runStartedMs: number;
  #logChain: Promise<void> = Promise.resolve();

  constructor(cfg: RunConfig) {
    this.#cfg = cfg;
    // Full limits resolved by workflow.ts's normalizer (no engine-side merge
    // of a constant): absent fragments take the module-owned defaults.
    this.#limits = resolveWorkflowLimits(cfg.limits);
    // Effective caps freeze at construction (dispatch): a mid-flight config flip must not re-arm a live run.
    this.#timeoutsEnabled = cfg.enableRuntimeTimeouts === true || cfg.maxRuntimeMsOverride !== undefined;
    this.#runStartedMs = Date.now();
    for (const node of cfg.workflow.nodes) {
      let resolve!: () => void;
      const settled = new Promise<void>((r) => {
        resolve = r;
      });
      this.#runs.set(node.id, {
        node,
        deps: nodeDeps(node),
        state: NODE_STATE.PENDING,
        attempt: 0,
        task: null,
        gate: null,
        runtimeUsedMs: 0,
        runtimeRunningSince: null,
        deadlineTimer: null,
        runtimeKilled: false,
        detail: null,
        outcome: null,
        cancelRequested: false,
        verdict: null,
        summary: "",
        fileClaims: null,
        ownGatePassed: false,
        judgeFor: null,
        settled,
        resolve,
      });
    }
    for (const nr of this.#runs.values()) {
      const jid = nr.node.accept.judge;
      if (jid) {
        const j = this.#runs.get(jid);
        if (j) j.judgeFor = nr.node.id;
      }
    }
  }

  /**
   * Execute the graph. If runDir already holds a run.jsonl for the same
   * workflow, nodes whose completed claims still verify on the filesystem are
   * reused (reconcile-resume); everything else runs normally.
   */
  async run(): Promise<RunSummary> {
    await mkdir(this.#cfg.runDir, { recursive: true });
    // Ownership: refuse to drive a run dir a live process on this host claims
    // (double-driving corrupts run.jsonl and verdict files mid-gate). Stale
    // claims from dead pids are reclaimed; a foreign-host claim cannot be
    // liveness-checked and is reclaimed with a warning (v1 stance).
    const claim = await claimRunDir(this.#cfg.runDir, this.#cfg.claimOptions);
    if (!claim.ok) {
      throw new Error(
        `run '${this.#cfg.runId}' is owned by live process ${claim.owner.pid} on '${claim.owner.host}'` +
          ` (claimed ${claim.owner.claimedAt}); stop it there (Ctrl-C / '/workflow cancel')`,
      );
    }
    // From the claim onward: the owner marker is released in ALL exit paths
    // that reach this frame (including resume-guard throws), so a long-lived
    // session process that failed a resume never parks the dir under its own
    // live pid. A hard process kill skips the finally; pid-liveness then
    // treats the leftover marker as stale.
    try {
      const prior = await readRunLog(this.#cfg.runDir);
      if (prior) {
        await this.#resume(prior);
      } else {
        await this.#log({
          ev: "started",
          runId: this.#cfg.runId,
          workflow: this.#cfg.workflow.name,
          nodes: [...this.#runs.keys()],
          startedAt: this.#runStartedMs,
        });
      }

      await Promise.all([...this.#runs.values()].map((nr) => this.#runNode(nr)));

      const states: Record<string, NodeState> = {};
      for (const nr of this.#runs.values()) states[nr.node.id] = nr.state;
      const outcome = this.#cancelRequested
        ? "cancelled"
        : Object.values(states).every((s) => s === NODE_STATE.SUCCEEDED)
          ? "succeeded"
          : "failed";
      await this.#log({ ev: "finished", outcome, states });
      await this.#logChain;
      return { runId: this.#cfg.runId, outcome, states };
    } finally {
      // Released so a resumed/cancelled dir is cleanly claimable.
      await rm(join(this.#cfg.runDir, RUN_OWNER_FILE), { force: true }).catch(() => {});
    }
  }

  /** Interrupt in-flight nodes (task_interrupt semantics) and stop scheduling. */
  cancel(): void {
    if (this.#cancelRequested) return;
    this.#cancelRequested = true;
    for (const nr of this.#runs.values()) {
      if (nr.deadlineTimer) clearTimeout(nr.deadlineTimer);
      nr.gate?.deliver({ status: "cancelled", result: "Task aborted" });
      nr.gate = null;
    }
    for (const nr of this.#runs.values()) {
      if (nr.task && !TERMINAL.has(nr.state)) this.#cfg.tasks.interruptTask(nr.task);
    }
  }

  /** Mid-turn steering of a node's worker (append-only, cache-neutral). */
  steer(nodeId: string, message: string): boolean {
    const nr = this.#runs.get(nodeId);
    if (!nr?.task) return false;
    return this.#cfg.tasks.sendFollowUp(nr.task, message);
  }

  /**
   * Single-node cancel for workflow_control (action=cancel, node). Interrupts
   * the node's worker through the same task-interrupt seam TaskManager's
   * run-level cancel drives (interruptTask: queued tasks go terminal without
   * ever starting a worker; running ones abort). A per-node flag stops the
   * retry ladder for THIS node only -- the node settles "cancelled", its
   * descendants block through the ordinary dependency rule, siblings and
   * other judges keep running. Unknown and already-terminal nodes report
   * rather than throw; a judge whose owner already settled is terminal
   * (mirrored), so "keep whatever verdict already landed" holds.
   */
  cancelNode(nodeId: string): { ok: true } | { error: "unknown" } | { error: "terminal"; state: NodeState } {
    const nr = this.#runs.get(nodeId);
    if (!nr) return { error: "unknown" };
    if (TERMINAL.has(nr.state)) return { error: "terminal", state: nr.state };
    nr.cancelRequested = true;
    nr.gate?.deliver({ status: "cancelled", result: "Node cancelled" });
    nr.gate = null;
    if (nr.task) this.#cfg.tasks.interruptTask(nr.task);
    // Owner cancelled while its judge holds the floor: end the judge's turn
    // too. #runJudge checks the owner's flag at every loop/disposition point,
    // so the judge settles cancelled (no respawn) and the attempt loop then
    // settles the owner as part of its cancel.
    if (nr.state === NODE_STATE.JUDGING && nr.node.accept.judge) {
      const j = this.#runs.get(nr.node.accept.judge);
      if (j && !TERMINAL.has(j.state)) {
        j.gate?.deliver({ status: "cancelled", result: "Node cancelled" });
        j.gate = null;
        if (j.task) this.#cfg.tasks.interruptTask(j.task);
      }
    }
    return { ok: true };
  }

  status(): NodeStatusView[] {
    return [...this.#runs.values()].map((nr) => ({
      id: nr.node.id,
      state: nr.state,
      attempt: nr.attempt,
      task: nr.task,
      taskStatus: nr.task ? (this.#cfg.tasks.taskStatus?.(nr.task) ?? null) : null,
      detail: nr.detail,
    }));
  }

  // -- node executors -------------------------------------------------------

  async #runNode(nr: NodeRun): Promise<void> {
    try {
      if (nr.judgeFor) return; // gate owners drive judges; never scheduled standalone
      if (TERMINAL.has(nr.state)) return; // reused by reconcile-resume
      if (this.#cancelRequested || nr.cancelRequested) {
        this.#settleNode(nr, "cancelled");
        return;
      }
      await Promise.all(nr.deps.map((d) => this.#runs.get(d)!.settled));
      if (nr.judgeFor) return; // settled by owner while we waited
      const badDep = nr.deps.find((d) => this.#runs.get(d)!.outcome !== "succeeded");
      if (badDep) {
        const why = this.#runs.get(badDep)!.outcome;
        if (this.#cancelRequested || nr.cancelRequested) this.#settleNode(nr, "cancelled");
        else this.#settleNode(nr, "blocked", `dependency '${badDep}' ${why}`);
        return;
      }
      if (this.#cancelRequested || nr.cancelRequested) {
        this.#settleNode(nr, "cancelled");
        return;
      }
      await this.#attemptLoop(nr);
    } catch (e: unknown) {
      // Engine bug: fail the node loudly; never hang the run.
      logger.error(
        `[workflow ${this.#cfg.runId}] engine error on node '${nr.node.id}': ${formatError(e)}`,
      );
      if (!TERMINAL.has(nr.state)) {
        this.#settleNode(nr, "failed", `engine error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  /** See RunConfig.managerSessionId. Empty object for session-less hosts. */
  #managerAgentOpt(): Pick<SpawnTaskOptions, "managerAgent"> | Record<string, never> {
    const sid = this.#cfg.managerSessionId;
    return sid ? { managerAgent: { sessionId: sid } } : {};
  }

  async #attemptLoop(nr: NodeRun): Promise<void> {
    const n = nr.node;
    const accept = n.accept;
    let task: { id: string; handle: TaskHandle } | null = null;
    let critique: PromptPart[] | null = null;

    while (true) {
      if (this.#cancelRequested || nr.cancelRequested) {
        this.#releaseTask(nr);
        this.#settleNode(nr, "cancelled");
        return;
      }
      if (nr.attempt >= accept.maxAttempts) {
        this.#releaseTask(nr);
        this.#settleNode(nr, "failed", nr.detail ?? `attempts exhausted (${accept.maxAttempts})`);
        return;
      }

      // ---- acquire a turn ----
      const gate = new TurnGate();
      nr.gate = gate;
      if (!task) {
        // Cold admission (first attempt or after the backing task died).
        const taskId = `${this.#cfg.runId}:${n.id}#${++this.#taskSeq}`;
        this.#log({ ev: "node", id: n.id, state: "queued", attempt: nr.attempt + 1, task: taskId });
        try {
          const handle = await this.#cfg.tasks.spawnTask(taskId, this.#composePrompt(nr, critique), {
            pin: livePin(n),
            group: n.group,
            requires: liveRequires(n),
            profile: n.profile,
            parentModel: this.#cfg.parentModel,
            ...this.#managerAgentOpt(),
            park: true,
            // The run dir rides to the webui task feed (reveal action); the
            // journal dir IS this run's, so every node/judge task points home.
            runDir: this.#cfg.runDir,
            onTurn: (t) => {
              this.#turnEnded(nr);
              nr.gate?.deliver(t);
            },
            onTurnStart: () => this.#turnStarted(nr),
          });
          task = { id: taskId, handle };
          nr.task = taskId;
        } catch (e: unknown) {
          // Admission refused (e.g. model resolution): counts as an attempt.
          nr.gate = null;
          nr.attempt++;
          nr.detail = e instanceof Error ? e.message : String(e);
          this.#log({ ev: "node", id: n.id, state: "attempt-failed", attempt: nr.attempt, detail: nr.detail });
          critique = null;
          continue;
        }
        // Engine-side state: awaiting this attempt's turn. The underlying
        // taskStatus (queued vs running) shows through in status() views.
        nr.state = NODE_STATE.RUNNING;
        this.#log({ ev: "node", id: n.id, state: "running", attempt: nr.attempt + 1, task: taskId });
      } else {
        // Warm follow-up: same session, lane still held.
        nr.state = NODE_STATE.RUNNING;
        this.#log({ ev: "node", id: n.id, state: "retry-warm", attempt: nr.attempt + 1, task: task.id });
        this.#cfg.tasks
          .taskTurn(task.id, this.#composeRetry(nr, critique))
          .then(
            (t) => {
              // Belt-and-suspenders: a warm turn whose task died while queued
              // for its lane resolves through this promise; the terminal
              // transition may also deliver a synthesized onTurn. TurnGate
              // delivers once, so whichever route arrives first wins and the
              // attempt's gate can never hang.
              if (nr.gate === gate) gate.deliver(t);
            },
            (err: unknown) => {
              if (nr.gate === gate) {
                gate.deliver({ status: "failed", result: `warm turn rejected: task no longer accepting turns: ${formatError(err)}` });
              }
            },
          );
      }
      const turn = await gate.promise;
      nr.gate = null;

      // ---- disposition ----
      nr.attempt++;
      if (this.#cancelRequested || nr.cancelRequested) {
        this.#releaseTask(nr);
        this.#settleNode(nr, "cancelled");
        return;
      }
      // A kill through the task seam (task_interrupt / task_cancel / session
      // delete) ends the backing worker's turn "cancelled" with both flags
      // clear -- the manager stopped work the user asked to stop, so the
      // attempt chain is TERMINAL: mirror the flag-cancel route exactly (no
      // attempt-failed, no cold re-admission; descendants block through the
      // ordinary dependency rule, siblings ride). Excluded: runtimeKilled --
      // the cap kill also arrives as a cancelled turn and owns the
      // failed-max_runtime route below.
      if (turn.status === "cancelled" && !nr.runtimeKilled) {
        // Record the cancel on the node before settling: cancelRequested is the node's per-node user-cancel record, the same footprint cancelNode leaves, so anything consulting it after the settle sees "user cancelled" rather than "worker died".
        nr.cancelRequested = true;
        this.#releaseTask(nr);
        this.#settleNode(nr, "cancelled");
        return;
      }
      if (turn.status !== "completed") {
        task = null;
        nr.task = null;
        critique = null;
        if (nr.runtimeKilled) {
          this.#settleNode(nr, "failed", this.#maxRuntimeDetail(nr));
          return;
        }
        nr.detail = `attempt ${nr.attempt} ${turn.status}: ${turn.result}`;
        this.#log({ ev: "node", id: n.id, state: "attempt-failed", attempt: nr.attempt, detail: nr.detail });
        continue; // cold re-admission if attempts remain
      }
      nr.summary = turn.result;

      // ---- gates ----
      let gateResult = await this.#evaluateGate(n, false);
      if (this.#cancelRequested || nr.cancelRequested) {
        this.#releaseTask(nr);
        this.#settleNode(nr, "cancelled");
        return;
      }
      if (gateResult.ok && accept.judge) {
        nr.state = NODE_STATE.JUDGING;
        this.#log({ ev: "node", id: n.id, state: "judging", attempt: nr.attempt, judge: accept.judge });
        const jres = await this.#runJudge(nr);
        // The owner's own cancel outranks whatever the judge returned: a
        // verdict that landed between the interrupt and here must not accept
        // a node the manager just cancelled.
        if (this.#cancelRequested || nr.cancelRequested) {
          this.#releaseTask(nr);
          this.#settleNode(nr, "cancelled");
          return;
        }
        if (jres.kind === "cancel") {
          this.#releaseTask(nr);
          this.#settleNode(nr, "cancelled");
          return;
        }
        if (jres.kind === "blocked") {
          this.#releaseTask(nr);
          this.#settleNode(nr, "blocked", jres.detail);
          return;
        }
        if (jres.kind !== "pass") {
          gateResult = {
            ok: false,
            kind: jres.kind,
            detail: `judge '${accept.judge}' verdict: ${jres.kind}`,
            verdict: jres.kind,
            note: jres.note,
          };
        }
      }

      if (gateResult.ok) {
        if (nr.runtimeKilled) {
          this.#releaseTask(nr);
          this.#settleNode(nr, "failed", this.#maxRuntimeDetail(nr));
          return;
        }
        const released = task ? this.#cfg.tasks.completeTask(task.id) : false;
        if (task) await task.handle.done;
        if (!released || this.#cancelRequested || nr.cancelRequested) {
          this.#settleNode(nr, "cancelled");
          return;
        }
        nr.fileClaims = gateResult.files ?? {};
        nr.verdict = gateResult.verdict ?? null;
        this.#settleNode(nr, "succeeded");
        return;
      }

      // ---- gate failed ----
      nr.verdict = gateResult.verdict ?? null;
      this.#log({
        ev: "node",
        id: n.id,
        state: "attempt-rejected",
        attempt: nr.attempt,
        kind: gateResult.kind,
        detail: gateResult.detail,
      });
      if (nr.runtimeKilled || this.#runtimeElapsed(nr)) {
        this.#releaseTask(nr);
        this.#settleNode(nr, "failed", `${this.#maxRuntimeDetail(nr)} before acceptance`);
        return;
      }
      if (nr.attempt >= accept.maxAttempts || !accept.retryOn.includes(gateResult.kind)) {
        this.#releaseTask(nr);
        this.#settleNode(nr, "failed", `${gateResult.kind}: ${gateResult.detail}`);
        return;
      }
      critique = critiqueParts(gateResult, turn.result);
      // `task` stays parked; next loop iteration sends the warm follow-up.
    }
  }

  /**
   * Run the gate-owner's judge for the current producer attempt. The judge's
   * own gate checks files + a parsable verdict; the verdict *value* gates the
   * producer, not the judge. Judge infra exhaustion blocks the producer.
   */
  async #runJudge(
    owner: NodeRun,
  ): Promise<{ kind: "pass" | "fail" | "reject" | "blocked" | "cancel"; note?: string; detail?: string }> {
    const jnr = this.#runs.get(owner.node.accept.judge!)!;
    const jn = jnr.node;
    // The judge's attempt budget is per judging (once per producer attempt);
    // total judge work stays bounded by the owner's maxAttempts.
    jnr.attempt = 0;

    // Before the judge's first spawn, await its own declared, non-gated
    // dependencies. The gated owner just passed its file gate, so it is
    // effectively done and must not be awaited here -- its `settled` will not
    // resolve until this judge returns and the owner settles succeeded (that
    // would deadlock). A non-succeeded sibling, however, means the judge could
    // read a missing or mid-write output; block the producer rather than judge
    // on stale evidence. Mirrors the dependency handling in #runNode.
    //
    // Deadlock note: validation guarantees the only path from the judge to the
    // gated owner is the direct dependency edge (any other upstream that waits
    // on the gated node is rejected), so every non-owner dep settled here is
    // independent of this judge returning.
    const judgeDeps = jnr.deps.filter((d) => d !== owner.node.id);
    if (judgeDeps.length > 0) {
      await Promise.all(judgeDeps.map((d) => this.#runs.get(d)!.settled));
      if (this.#cancelRequested || owner.cancelRequested) {
        if (!TERMINAL.has(jnr.state)) {
          this.#settleJudge(jnr, "cancelled", owner.cancelRequested ? `owner '${owner.node.id}' cancelled` : undefined);
        }
        return { kind: "cancel" };
      }
      if (jnr.cancelRequested) {
        const detail = `judge '${jn.id}' cancelled`;
        if (!TERMINAL.has(jnr.state)) this.#settleJudge(jnr, "cancelled", detail);
        return { kind: "blocked", detail };
      }
      const badDep = judgeDeps.find((d) => this.#runs.get(d)!.outcome !== "succeeded");
      if (badDep) {
        const detail = `judge '${jn.id}' blocked: dependency '${badDep}' ${this.#runs.get(badDep)!.outcome}`;
        if (!TERMINAL.has(jnr.state)) this.#settleJudge(jnr, "blocked", detail);
        return { kind: "blocked", detail };
      }
    }
    while (true) {
      // Run-level cancel ends the judge with the run; workflow_control
      // cancelling the OWNER ends it too -- the judge of a cancelled producer
      // must neither keep its turn nor respawn (post-cancel tokens spent on
      // work the manager just stopped would also let a late verdict accept a
      // node that is settling cancelled).
      if (this.#cancelRequested || owner.cancelRequested) {
        this.#releaseTask(jnr);
        if (!TERMINAL.has(jnr.state)) {
          this.#settleJudge(jnr, "cancelled", owner.cancelRequested ? `owner '${owner.node.id}' cancelled` : undefined);
        }
        return { kind: "cancel" };
      }
      // workflow_control cancelled THIS judge: the producer has no gate left
      // for this attempt. Block it honestly (recoverable via reconcile/re-run)
      // rather than cancelling work the manager never touched.
      if (jnr.cancelRequested) {
        this.#releaseTask(jnr);
        const detail = `judge '${jn.id}' cancelled`;
        if (!TERMINAL.has(jnr.state)) this.#settleJudge(jnr, "cancelled", detail);
        return { kind: "blocked", detail };
      }
      if (jnr.attempt >= jn.accept.maxAttempts) {
        this.#releaseTask(jnr);
        if (!TERMINAL.has(jnr.state)) {
          this.#settleJudge(jnr, "failed", `judge attempts exhausted (${jn.accept.maxAttempts})`);
        }
        return { kind: "blocked", detail: `judge '${jn.id}' failed before delivering a verdict` };
      }

      const gate = new TurnGate();
      jnr.gate = gate;
      const taskId = `${this.#cfg.runId}:${jn.id}#${++this.#taskSeq}`;
      this.#log({ ev: "node", id: jn.id, state: "queued", attempt: jnr.attempt + 1, task: taskId, judges: owner.node.id });
      // Assigned only when the spawn below succeeds; read at the verdict
      // release guarded by `jnr.task`, which is set in the same breath.
      let handle!: TaskHandle;
      try {
        handle = await this.#cfg.tasks.spawnTask(taskId, this.#composeJudgePrompt(jnr, owner), {
          pin: livePin(jn),
          group: jn.group,
          requires: liveRequires(jn),
          profile: jn.profile,
          parentModel: this.#cfg.parentModel,
          ...this.#managerAgentOpt(),
          park: true,
          runDir: this.#cfg.runDir,
          onTurn: (t) => {
            this.#turnEnded(jnr);
            jnr.gate?.deliver(t);
          },
          onTurnStart: () => this.#turnStarted(jnr),
        });
        jnr.task = taskId;
      } catch (e: unknown) {
        jnr.gate = null;
        jnr.attempt++;
        this.#log({
          ev: "node",
          id: jn.id,
          state: "attempt-failed",
          attempt: jnr.attempt,
          detail: e instanceof Error ? e.message : String(e),
        });
        continue;
      }
      jnr.state = NODE_STATE.RUNNING;
      this.#log({ ev: "node", id: jn.id, state: "running", attempt: jnr.attempt + 1, task: taskId });
      const turn = await gate.promise;
      jnr.gate = null;
      jnr.attempt++;
      if (this.#cancelRequested || owner.cancelRequested) {
        this.#releaseTask(jnr);
        if (!TERMINAL.has(jnr.state)) {
          this.#settleJudge(jnr, "cancelled", owner.cancelRequested ? `owner '${owner.node.id}' cancelled` : undefined);
        }
        return { kind: "cancel" };
      }
      // A direct task_interrupt (task_cancel / session delete) on the JUDGE's
      // backing task ends its turn "cancelled" with nothing set: terminal --
      // settle the judge cancelled and hand the producer the EXISTING
      // jres.kind === "cancel" route (owner settles cancelled with it, no
      // respawn). Deliberately NOT mirrored onto jnr.cancelRequested: that
      // flag means "workflow_control cancelled this judge" and its route must
      // keep BLOCKING the producer (recoverable, verdict never landed) -- the
      // one distinction between the two cancels worth preserving.
      // runtimeKilled stays on the cold-respawn ladder below (cap semantics).
      if (turn.status === "cancelled" && !jnr.runtimeKilled && !jnr.cancelRequested) {
        this.#releaseTask(jnr);
        if (!TERMINAL.has(jnr.state)) this.#settleJudge(jnr, "cancelled");
        return { kind: "cancel" };
      }
      if (turn.status !== "completed") {
        jnr.task = null;
        continue; // judge attempts are cold; their failures are infra noise
      }
      const g = await this.#evaluateGate(jn, true);
      if (!g.ok) {
        jnr.detail = g.detail;
        this.#log({ ev: "node", id: jn.id, state: "attempt-rejected", attempt: jnr.attempt, detail: g.detail });
        // Judge retries are cold: release the parked task so its lane cannot leak.
        this.#releaseTask(jnr);
        continue;
      }
      // Verdict delivered: release the judge's lane; its fate rides with the owner.
      const released = jnr.task ? this.#cfg.tasks.completeTask(jnr.task) : false;
      if (jnr.task) await handle.done;
      if (!released) {
        if (!TERMINAL.has(jnr.state)) this.#settleJudge(jnr, "cancelled");
        return { kind: "cancel" };
      }
      jnr.verdict = g.verdict ?? null;
      jnr.summary = turn.result;
      jnr.fileClaims = g.files ?? {};
      jnr.ownGatePassed = true;
      this.#log({ ev: "node", id: jn.id, state: "judged", attempt: jnr.attempt, verdict: g.verdict });
      return g.verdict === "pass"
        ? { kind: "pass" }
        : { kind: g.verdict === "reject" ? "reject" : "fail", note: clip(g.note ?? "", MAX_CRITIQUE_CHARS) };
    }
  }

  // -- gates & files ---------------------------------------------------------

  async #evaluateGate(n: WorkflowNode, asJudge: boolean): Promise<GateResult> {
    const dir = this.#cfg.runDir;
    const missing: string[] = [];
    const stale: string[] = [];
    const files: Record<string, FileClaim> = {};
    for (const p of n.accept.files) {
      try {
        const st = await stat(join(dir, p));
        if (st.mtimeMs + FRESH_GRACE_MS < this.#runStartedMs) stale.push(p);
        else files[p] = { size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        missing.push(p);
      }
    }
    if (missing.length || stale.length) {
      const bits: string[] = [];
      if (missing.length) bits.push(`missing outputs: ${missing.join(", ")}`);
      if (stale.length) bits.push(`outputs not fresh this run: ${stale.join(", ")}`);
      return { ok: false, kind: "fail", detail: bits.join("; ") };
    }
    const v = await readVerdictFile(join(this.#cfg.runDir, `${n.id}.verdict`));
    if (!v) {
      return {
        ok: false,
        kind: "fail",
        detail: `verdict file '${n.id}.verdict' missing or first line is not pass|fail|reject`,
      };
    }
    if (!asJudge && v.value !== "pass") {
      return { ok: false, kind: v.value as "fail" | "reject", detail: `worker verdict '${v.value}'`, verdict: v.value, note: v.note, files };
    }
    return { ok: true, kind: "fail", detail: "", verdict: v.value, note: v.note, files };
  }

  // -- prompts ---------------------------------------------------------------
  //
  // Prompts are content parts: engine-composed framing rides `text`, anything
  // a model authored that gets spliced in (upstream summaries, verdict notes,
  // prior turn results) rides `untrusted` -- mangled at the wire serializer,
  // the same boundary the task-completion delivery uses. A poisoned file in
  // the run dir must not steer the next node as harness-faithful prose.

  #composePrompt(nr: NodeRun, critique: PromptPart[] | null): PromptPart[] {
    const n = nr.node;
    const wf = this.#cfg.workflow;
    const dir = this.#cfg.runDir;
    const parts: PromptPart[] = [
      partText(
        [
          `Workflow '${wf.name}' run ${this.#cfg.runId}: node '${n.id}' (attempt ${nr.attempt + 1} of ${n.accept.maxAttempts}).`,
          ...(n.description ? ["", n.description] : []),
          "",
          "You are one node of a deterministic multi-agent workflow. Do the work in the shared workspace as usual.",
        ].join("\n"),
      ),
    ];
    if (nr.deps.length || Object.keys(n.inputs).length) {
      parts.push(partText("Upstream:"));
      for (const d of nr.deps) {
        const dr = this.#runs.get(d)!;
        const outs = dr.node.accept.files.length ? dr.node.accept.files.join(", ") : "verdict only";
        parts.push(
          partText(`- node '${d}': verdict ${dr.verdict ?? "?"}; outputs under ${dir}: ${outs}`),
        );
        if (dr.summary) {
          parts.push(partText("  summary:"), partUntrusted(clip(dr.summary, MAX_SUMMARY_CHARS)));
        }
      }
      for (const [key, ref] of Object.entries(nr.node.inputs)) {
        parts.push(partText(`- input '${key}' refers to '${ref}'`));
      }
    }
    parts.push(
      partText(
        [
          "",
          "Output contract (machine-checked — a broken contract fails the attempt):",
          n.accept.files.length
            ? `- write the declared output files under ${dir} at exactly: ${n.accept.files.join(", ")}`
            : "- no declared output files; the verdict file is your deliverable",
          `- write ${n.id}.verdict under ${dir}: first line exactly one of pass|fail|reject (your honest verdict on your own output), optionally followed by notes`,
          "- finish with a short pointer summary (file paths + verdict); do not paste file contents",
        ].join("\n"),
      ),
    );
    if (critique) {
      parts.push(
        partText("PREVIOUS ATTEMPT WAS NOT ACCEPTED:"),
        ...critique,
        partText("Fix the problems above, re-verify your outputs, then update the verdict file."),
      );
    }
    return parts;
  }

  #composeRetry(nr: NodeRun, critique: PromptPart[] | null): PromptPart[] {
    const n = nr.node;
    const parts: PromptPart[] = [
      partText(
        `Retry follow-up for workflow node '${n.id}' (attempt ${nr.attempt + 1} of ${n.accept.maxAttempts}). The previous attempt was not accepted.`,
      ),
    ];
    if (critique) parts.push(...critique);
    else parts.push(partText("The previous attempt failed its machine-checked gate."));
    parts.push(
      partText(
        "\nFix the problems, re-verify your outputs against the output contract, update " +
          `${n.id}.verdict, then reply with a short pointer summary.`,
      ),
    );
    return parts;
  }

  #composeJudgePrompt(jnr: NodeRun, owner: NodeRun): PromptPart[] {
    const jn = jnr.node;
    const dir = this.#cfg.runDir;
    const outs = owner.node.accept.files.length ? owner.node.accept.files.join(", ") : "(none declared)";
    const parts: PromptPart[] = [
      partText(
        `Workflow '${this.#cfg.workflow.name}' run ${this.#cfg.runId}: JUDGE node '${jn.id}' for producer '${owner.node.id}' (attempt ${jnr.attempt + 1}).`,
      ),
    ];
    if (jn.description) parts.push(partText(jn.description));
    parts.push(
      partText(
        `\nReview the producer's outputs (read the files): under ${dir}: ${outs}\nProducer's own summary:`,
      ),
      partUntrusted(clip(owner.summary, MAX_SUMMARY_CHARS)),
      partText(
        [
          "",
          "Verdict contract (machine-checked):",
          `- write ${jn.id}.verdict under ${dir}: first line exactly one of pass|fail|reject,`,
          "  followed by your critique — it is handed verbatim to the producer for its retry.",
          "- finish with a one-line pointer summary; do not paste file contents.",
        ].join("\n"),
      ),
    );
    return parts;
  }

  // -- runtime cap -------------------------------------------------------------
  //
  // Accumulated worker-run time, not wall clock since queueing: the deadline
  // is armed when a turn actually starts (onTurnStart) and banked when the
  // turn ends, so waiting for a provider-lane slot never burns the cap.
  // When timeouts are disabled only this accounting runs: the deadline never
  // arms (the sole writer of runtimeKilled) and #runtimeElapsed stays false,
  // so all three disposition kill sites are unreachable by construction.

  #runtimeMs(n: WorkflowNode): number {
    if (this.#cfg.maxRuntimeMsOverride !== undefined) return this.#cfg.maxRuntimeMsOverride;
    const mins =
      n.maxRuntimeMins ??
      this.#cfg.workflow.limits.maxRuntimeMins ??
      this.#limits.maxRuntimeMins;
    return mins * 60_000;
  }

  /** Turn time actually used: banked plus the live in-flight turn (may exceed
   * the cap slightly -- the kill lands at turn granularity, which is itself
   * the diagnostic). */
  #runtimeUsedMs(nr: NodeRun): number {
    const live = nr.runtimeRunningSince === null ? 0 : Date.now() - nr.runtimeRunningSince;
    return nr.runtimeUsedMs + live;
  }

  #runtimeElapsed(nr: NodeRun): boolean {
    if (!this.#timeoutsEnabled) return false; // dormant when the toggle is off
    return this.#runtimeUsedMs(nr) >= this.#runtimeMs(nr.node);
  }

  /** Cap-kill failure detail: time used vs the cap (the cap alone is useless). */
  #maxRuntimeDetail(nr: NodeRun): string {
    return `max_runtime exceeded (used ${this.#runtimeUsedMs(nr)}ms of ${this.#runtimeMs(nr.node)}ms cap, attempt ${nr.attempt})`;
  }

  /** onTurnStart: the worker began running; arm the deadline for the cap left. */
  #turnStarted(nr: NodeRun): void {
    if (nr.deadlineTimer !== null) clearTimeout(nr.deadlineTimer);
    nr.runtimeRunningSince = Date.now();
    if (!this.#timeoutsEnabled) return; // bank-only: the kill timer stays unarmed
    const remaining = this.#runtimeMs(nr.node) - nr.runtimeUsedMs;
    nr.deadlineTimer = setTimeout(() => {
      nr.deadlineTimer = null;
      if (TERMINAL.has(nr.state)) return;
      nr.runtimeKilled = true;
      if (nr.task) this.#cfg.tasks.interruptTask(nr.task);
    }, Math.max(remaining, 1));
  }

  /** onTurn: the worker stopped running; bank the elapsed turn and disarm. */
  #turnEnded(nr: NodeRun): void {
    if (nr.runtimeRunningSince === null) return;
    nr.runtimeUsedMs += Date.now() - nr.runtimeRunningSince;
    nr.runtimeRunningSince = null;
    if (nr.deadlineTimer !== null) {
      clearTimeout(nr.deadlineTimer);
      nr.deadlineTimer = null;
    }
  }

  /** Free a parked task if it is still holding its lane; no-op when terminal. */
  #releaseTask(nr: NodeRun): void {
    if (nr.task) this.#cfg.tasks.interruptTask(nr.task);
    nr.task = null;
  }

  // -- terminal transitions ------------------------------------------------------

  /**
   * Shared terminal transition for nodes and judges: clears the runtime
   * deadline and moves the run out of play. Returns false (no-op) when the
   * run already terminated exactly one way; callers do their own logging
   * and mirroring only when this returns true.
   */
  #toTerminal(nr: NodeRun, outcome: NodeOutcome, detail?: string): boolean {
    if (TERMINAL.has(nr.state)) return false;
    if (nr.deadlineTimer) {
      clearTimeout(nr.deadlineTimer);
      nr.deadlineTimer = null;
    }
    nr.outcome = outcome;
    nr.detail = detail ?? null;
    nr.state = OUTCOME_STATE[outcome];
    return true;
  }

  #settleNode(nr: NodeRun, outcome: NodeOutcome, detail?: string): void {
    if (!this.#toTerminal(nr, outcome, detail)) return;

    const ev: Record<string, unknown> = { ev: "node", id: nr.node.id, state: outcome, attempt: nr.attempt };
    if (outcome === "succeeded") {
      ev.verdict = nr.verdict;
      ev.summary = clip(nr.summary, MAX_SUMMARY_CHARS);
      ev.deps = nr.deps;
      ev.files = nr.fileClaims ?? {};
    } else if (detail) {
      ev.detail = detail;
    }
    this.#log(ev);

    // Judge mirror: a judge that delivered a verdict did its job regardless of
    // what the verdict said; one that never ran is blocked by exhaustion (or
    // cancelled with its owner).
    const jid = nr.node.accept.judge;
    if (jid) {
      const j = this.#runs.get(jid);
      if (j && !TERMINAL.has(j.state)) {
        const mirror = j.ownGatePassed ? "succeeded" : outcome === "cancelled" ? "cancelled" : "blocked";
        this.#settleJudge(j, mirror, mirror === "succeeded" ? undefined : (detail ?? undefined));
      }
    }
    nr.resolve();
  }

  #settleJudge(jnr: NodeRun, outcome: NodeOutcome, detail?: string): void {
    if (!this.#toTerminal(jnr, outcome, detail)) return;
    this.#log({
      ev: "node",
      id: jnr.node.id,
      state: outcome,
      attempt: jnr.attempt,
      ...(jnr.verdict ? { verdict: jnr.verdict } : {}),
      ...(detail ? { detail } : {}),
    });
    jnr.resolve();
  }

  // -- resume ----------------------------------------------------------------

  async #resume(prior: RunLogEvents): Promise<void> {
    if (prior.started.workflow !== this.#cfg.workflow.name) {
      throw new Error(
        `run dir '${this.#cfg.runDir}' holds workflow '${prior.started.workflow}', not '${this.#cfg.workflow.name}'`,
      );
    }
    this.#runStartedMs = prior.started.startedAt;
    const currentIds = new Set(this.#runs.keys());
    if (
      prior.started.nodes.length !== currentIds.size ||
      !prior.started.nodes.every((id) => currentIds.has(id))
    ) {
      throw new Error(`run dir '${this.#cfg.runDir}' was recorded for a different node graph`);
    }
    const report = await validateClaims(prior, (id) => join(this.#cfg.runDir, id));
    const valid = new Set(report.valid);
    for (const [id, claim] of prior.succeeded) {
      if (!valid.has(id)) continue;
      const nr = this.#runs.get(id);
      if (!nr) continue;
      nr.state = NODE_STATE.SUCCEEDED;
      nr.outcome = "succeeded";
      nr.verdict = claim.verdict ?? null;
      nr.summary = claim.summary ?? "";
      nr.fileClaims = claim.files ?? {};
      nr.attempt = claim.attempt;
      nr.resolve();
    }
    // A reused producer whose judge did not survive leaves that judge
    // unschedulable (the gate will not run again): mirror it into a terminal
    // state so its own dependents unblock.
    for (const nr of this.#runs.values()) {
      const jid = nr.node.accept.judge;
      if (!jid || nr.state !== NODE_STATE.SUCCEEDED) continue;
      const j = this.#runs.get(jid)!;
      if (TERMINAL.has(j.state)) continue;
      const priorState = prior.lastState.get(jid);
      const mirror =
        priorState === "failed" || priorState === "blocked" || priorState === "cancelled"
          ? priorState
          : "blocked";
      this.#settleJudge(j, mirror, mirror === "blocked" ? "judge of reused node needs reconcile" : undefined);
    }
    await this.#log({
      ev: "resumed",
      runId: this.#cfg.runId,
      valid: report.valid,
      invalid: [...report.invalid, ...report.incomplete],
    });
  }

  // -- run log -----------------------------------------------------------------

  #log(ev: Record<string, unknown>): Promise<void> {
    const line = `${JSON.stringify({ t: new Date().toISOString(), ...ev })}\n`;
    this.#logChain = this.#logChain
      .then(() => appendFile(join(this.#cfg.runDir, "run.jsonl"), line))
      .catch((e: unknown) =>
        logger.error(`[workflow ${this.#cfg.runId}] run log write failed: ${formatError(e)}`),
      );
    return this.#logChain;
  }
}
