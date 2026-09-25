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

import { appendFile, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { formatError } from "@core/error.ts";
import { createExclusive } from "@utils/fs-atomic.ts";
import { logger } from "@utils/logger.ts";
import type {
  SpawnTaskOptions,
  TaskHandle,
  TaskStatus,
  TurnPrompt,
  TurnResult,
} from "@core/session/task-manager.ts";
import type { Workflow, WorkflowLimits, WorkflowNode } from "./workflow.ts";
import { DEFAULT_WORKFLOW_LIMITS, nodeDeps } from "./workflow.ts";

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
} as const;
export type NodeState = (typeof NODE_STATE)[keyof typeof NODE_STATE];

const TERMINAL: ReadonlySet<NodeState> = new Set([
  NODE_STATE.SUCCEEDED,
  NODE_STATE.FAILED,
  NODE_STATE.BLOCKED,
  NODE_STATE.CANCELLED,
]);

type NodeOutcome = "succeeded" | "failed" | "blocked" | "cancelled";

const OUTCOME_STATE: Record<NodeOutcome, NodeState> = {
  succeeded: NODE_STATE.SUCCEEDED,
  failed: NODE_STATE.FAILED,
  blocked: NODE_STATE.BLOCKED,
  cancelled: NODE_STATE.CANCELLED,
};

const VERDICTS = new Set(["pass", "fail", "reject"]);
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
  limits?: Partial<WorkflowLimits>;
  /** Test seam for the wall-clock node cap (default: workflow/config minutes). */
  maxRuntimeMsOverride?: number;
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
  outcome: "succeeded" | "failed" | "cancelled";
  states: Record<string, NodeState>;
}

interface FileClaim {
  size: number;
  mtimeMs: number;
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
  startedAt: number | null;
  deadlineTimer: ReturnType<typeof setTimeout> | null;
  runtimeKilled: boolean;
  detail: string | null;
  outcome: NodeOutcome | null;
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
  #runs = new Map<string, NodeRun>();
  #cancelRequested = false;
  #taskSeq = 0;
  #runStartedMs: number;
  #logChain: Promise<void> = Promise.resolve();

  constructor(cfg: RunConfig) {
    this.#cfg = cfg;
    this.#limits = { ...DEFAULT_WORKFLOW_LIMITS, ...cfg.limits };
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
        startedAt: null,
        deadlineTimer: null,
        runtimeKilled: false,
        detail: null,
        outcome: null,
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
      if (this.#cancelRequested) {
        this.#settleNode(nr, "cancelled");
        return;
      }
      await Promise.all(nr.deps.map((d) => this.#runs.get(d)!.settled));
      if (nr.judgeFor) return; // settled by owner while we waited
      const badDep = nr.deps.find((d) => this.#runs.get(d)!.outcome !== "succeeded");
      if (badDep) {
        const why = this.#runs.get(badDep)!.outcome;
        if (this.#cancelRequested) this.#settleNode(nr, "cancelled");
        else this.#settleNode(nr, "blocked", `dependency '${badDep}' ${why}`);
        return;
      }
      if (this.#cancelRequested) {
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

  async #attemptLoop(nr: NodeRun): Promise<void> {
    const n = nr.node;
    const accept = n.accept;
    let task: { id: string; handle: TaskHandle } | null = null;
    let critique: PromptPart[] | null = null;
    nr.startedAt ??= Date.now();

    while (true) {
      if (this.#cancelRequested) {
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
            park: true,
            onTurn: (t) => nr.gate?.deliver(t),
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
        this.#armRuntime(nr);
        // Engine-side state: awaiting this attempt's turn. The underlying
        // taskStatus (queued vs running) shows through in status() views.
        nr.state = NODE_STATE.RUNNING;
        this.#log({ ev: "node", id: n.id, state: "running", attempt: nr.attempt + 1, task: taskId });
      } else {
        // Warm follow-up: same session, lane still held.
        nr.state = NODE_STATE.RUNNING;
        this.#armRuntime(nr);
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
            () => {
              if (nr.gate === gate) {
                gate.deliver({ status: "failed", result: "warm turn rejected: task no longer accepting turns" });
              }
            },
          );
      }
      const turn = await gate.promise;
      nr.gate = null;

      // ---- disposition ----
      nr.attempt++;
      if (this.#cancelRequested) {
        this.#releaseTask(nr);
        this.#settleNode(nr, "cancelled");
        return;
      }
      if (turn.status !== "completed") {
        task = null;
        nr.task = null;
        critique = null;
        if (nr.runtimeKilled) {
          this.#settleNode(nr, "failed", `max_runtime exceeded (${this.#runtimeMs(n)}ms)`);
          return;
        }
        nr.detail = `attempt ${nr.attempt} ${turn.status}: ${turn.result}`;
        this.#log({ ev: "node", id: n.id, state: "attempt-failed", attempt: nr.attempt, detail: nr.detail });
        continue; // cold re-admission if attempts remain
      }
      nr.summary = turn.result;

      // ---- gates ----
      let gateResult = await this.#evaluateGate(n, false);
      if (this.#cancelRequested) {
        this.#releaseTask(nr);
        this.#settleNode(nr, "cancelled");
        return;
      }
      if (gateResult.ok && accept.judge) {
        nr.state = NODE_STATE.JUDGING;
        this.#log({ ev: "node", id: n.id, state: "judging", attempt: nr.attempt, judge: accept.judge });
        const jres = await this.#runJudge(nr);
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
          this.#settleNode(nr, "failed", `max_runtime exceeded (${this.#runtimeMs(n)}ms)`);
          return;
        }
        const released = task ? this.#cfg.tasks.completeTask(task.id) : false;
        if (task) await task.handle.done;
        if (!released || this.#cancelRequested) {
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
        this.#settleNode(nr, "failed", `max_runtime exceeded (${this.#runtimeMs(n)}ms) before acceptance`);
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
    jnr.startedAt ??= Date.now();
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
      if (this.#cancelRequested) {
        if (!TERMINAL.has(jnr.state)) this.#settleJudge(jnr, "cancelled");
        return { kind: "cancel" };
      }
      const badDep = judgeDeps.find((d) => this.#runs.get(d)!.outcome !== "succeeded");
      if (badDep) {
        const detail = `judge '${jn.id}' blocked: dependency '${badDep}' ${this.#runs.get(badDep)!.outcome}`;
        if (!TERMINAL.has(jnr.state)) this.#settleJudge(jnr, "blocked", detail);
        return { kind: "blocked", detail };
      }
    }
    while (true) {
      if (this.#cancelRequested) {
        this.#releaseTask(jnr);
        if (!TERMINAL.has(jnr.state)) this.#settleJudge(jnr, "cancelled");
        return { kind: "cancel" };
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
          park: true,
          onTurn: (t) => jnr.gate?.deliver(t),
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
      this.#armRuntime(jnr);
      jnr.state = NODE_STATE.RUNNING;
      this.#log({ ev: "node", id: jn.id, state: "running", attempt: jnr.attempt + 1, task: taskId });
      const turn = await gate.promise;
      jnr.gate = null;
      jnr.attempt++;
      if (this.#cancelRequested) {
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

  #runtimeMs(n: WorkflowNode): number {
    if (this.#cfg.maxRuntimeMsOverride !== undefined) return this.#cfg.maxRuntimeMsOverride;
    const mins =
      n.maxRuntimeMins ??
      this.#cfg.workflow.limits.maxRuntimeMins ??
      this.#limits.maxRuntimeMins;
    return mins * 60_000;
  }

  #runtimeElapsed(nr: NodeRun): boolean {
    return nr.startedAt !== null && Date.now() >= nr.startedAt + this.#runtimeMs(nr.node);
  }

  #armRuntime(nr: NodeRun): void {
    if (nr.deadlineTimer !== null || nr.startedAt === null) return;
    const remaining = nr.startedAt + this.#runtimeMs(nr.node) - Date.now();
    nr.deadlineTimer = setTimeout(() => {
      nr.deadlineTimer = null;
      if (TERMINAL.has(nr.state)) return;
      nr.runtimeKilled = true;
      if (nr.task) this.#cfg.tasks.interruptTask(nr.task);
    }, Math.max(remaining, 1));
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

// ---------------------------------------------------------------------------
// run identity, log reading & reconcile
// ---------------------------------------------------------------------------

/**
 * Shape for caller-supplied run ids (`--id`, the model-supplied
 * `workflow_dispatch` run_id, status/reconcile/cancel args): the generated
 * `YYYYMMDD-HHmm-<name>` form always matches. These ids go straight into
 * `join(runsRoot, id)`, so no separators and no leading dot -- a
 * model-chosen "../anything" must not escape the runs root.
 */
export function isSafeRunId(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(id);
}

/** Shared tail text for rejected run ids (CLI + manager tools stay in sync with the regex above). */
export const RUN_ID_SHAPE_HINT = "must match [a-z0-9][a-z0-9._-]*";

// ---------------------------------------------------------------------------
// run-dir ownership (anti double-drive)
// ---------------------------------------------------------------------------

/** Marker file inside a run dir naming the process currently driving it. */
export const RUN_OWNER_FILE = ".owner";

export interface RunOwner {
  pid: number;
  host: string;
  claimedAt: string;
}

export interface ClaimOptions {
  pid?: number;
  host?: string;
  pidAlive?: (pid: number) => boolean;
}

function pidAliveDefault(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0); // signal 0: existence check only
    return true;
  } catch (e: unknown) {
    return (e as { code?: string }).code === "EPERM"; // exists, not ours
  }
}

function parseOwnerJson(text: string): RunOwner | null {
  try {
    const o = JSON.parse(text) as RunOwner;
    if (typeof o?.pid !== "number" || typeof o?.host !== "string") return null;
    return o;
  } catch {
    return null;
  }
}

export async function readRunOwner(runDir: string): Promise<RunOwner | null> {
  try {
    return parseOwnerJson(await readFile(join(runDir, RUN_OWNER_FILE), "utf8"));
  } catch {
    return null;
  }
}

/**
 * Atomically move the owner marker aside; returns its content, or null when
 * the file was already gone. rename's exclusivity means of several racing
 * reclaimers exactly one wins -- no read-modify-write window where two
 * processes both decide to overwrite. Creation is createExclusive from
 * @utils/fs-atomic.ts, so an existing `.owner` always carries full contents:
 * empty/garbage means a crashed writer, never a mid-write live claim.
 */
async function discardOwnerFile(path: string): Promise<string | null> {
  const away = `${path}.stale-${process.pid}-${Math.random().toString(36).slice(2)}`;
  try {
    await rename(path, away);
  } catch {
    return null; // already gone (another reclaimer won) or never existed
  }
  const content = await readFile(away, "utf8").catch(() => "");
  await rm(away, { force: true }).catch(() => {});
  return content;
}

const sameClaim = (a: RunOwner | null, b: RunOwner | null): boolean =>
  !!a && !!b && a.pid === b.pid && a.host === b.host && a.claimedAt === b.claimedAt;

/**
 * Claim the run dir for this process. Refuses only a same-host claim whose
 * pid is alive (and not our own pid — re-entry for a pre-claim followed by
 * run() must pass). Stale same-host markers (crashed pid) and foreign-host
 * markers — whose liveness cannot be checked from here — are reclaimed; the
 * foreign case logs a warning.
 *
 * All writes are exclusive creates; reclaims race through the atomic
 * rename so one claimer wins the discard. What the winner moved aside is
 * checked against what it judged: a live rival's claim that landed after our
 * read is restored untouched, never overwritten. A corrupt (unreadable)
 * marker is discarded the same way, never truncated in place.
 */
export async function claimRunDir(
  runDir: string,
  opts?: ClaimOptions,
): Promise<{ ok: true; reclaimed?: RunOwner } | { ok: false; owner: RunOwner }> {
  const pid = opts?.pid ?? process.pid;
  const host = opts?.host ?? hostname();
  const alive = opts?.pidAlive ?? pidAliveDefault;
  const ownerPath = join(runDir, RUN_OWNER_FILE);
  const mineJson = () =>
    `${JSON.stringify({ pid, host, claimedAt: new Date().toISOString() } satisfies RunOwner)}\n`;

  for (let round = 0; round < 4; round++) {
    const prior = await readRunOwner(runDir);
    if (prior) {
      if (prior.pid === pid && prior.host === host) {
        return { ok: true, reclaimed: prior };
      }
      if (prior.host === host && alive(prior.pid)) {
        return { ok: false, owner: prior };
      }
      if (prior.host !== host) {
        logger.warn(
          `[workflow] reclaiming run dir '${runDir}' claimed by '${prior.host}' pid ${prior.pid} ` +
            `(liveness cannot be checked across hosts)`,
        );
      }
      // Judged reclaimable (dead same-host or foreign). Race to move it.
      const moved = await discardOwnerFile(ownerPath);
      if (moved === null) continue; // another reclaimer won the discard
      const movedOwner = parseOwnerJson(moved);
      if (movedOwner && !sameClaim(movedOwner, prior) && movedOwner.host === host && alive(movedOwner.pid)) {
        // A live rival's claim landed between our read and rename: restore
        // it exactly and let the next round judge it.
        if (movedOwner.pid === pid) return { ok: true, reclaimed: movedOwner };
        await createExclusive(ownerPath, moved);
        continue;
      }
      if (await createExclusive(ownerPath, mineJson())) {
        return { ok: true, reclaimed: prior };
      }
      continue; // a rival created in our window; re-judge
    }
    if (await createExclusive(ownerPath, mineJson())) return { ok: true };
    // EEXIST with no readable claim: a corrupt marker (creation is atomic, so a
    // live rival's file always parses; empty/garbage means a crashed writer).
    // Re-read once in case a rival finished between reads. If still unreadable,
    // discard the corrupt marker (the rename has a single winner; should the
    // moved bytes turn out to be a live claim, they are restored here).
    if ((await readRunOwner(runDir)) === null) {
      const moved = await discardOwnerFile(ownerPath);
      if (moved !== null) {
        const movedOwner = parseOwnerJson(moved);
        if (movedOwner && movedOwner.host === host && alive(movedOwner.pid)) {
          if (movedOwner.pid === pid) return { ok: true, reclaimed: movedOwner };
          await createExclusive(ownerPath, moved);
        }
      }
    }
    // Loop retries: the slot is now free (we won the discard) or a rival
    // claim exists to be judged at the top of the next round.
  }
  throw new Error(`cannot claim run dir '${runDir}': repeated ownership races`);
}

/**
 * Run directory name: `YYYYMMDD-HHmm-<workflow-name>`.
 * The directory is RESERVED here with an exclusive mkdir, not probed for a
 * run.jsonl: two processes dispatching in the same minute would otherwise
 * both pass the probe (neither log written yet) and share one run dir. Any
 * existing directory -- started run or crashed-before-log -- belongs to an
 * earlier claim, so numeric suffixes keep run dirs one-per-execution;
 * resuming is an explicit `--id`, never a same-minute accident.
 */
export async function nextRunId(
  runsRoot: string,
  workflowName: string,
  now = new Date(),
): Promise<string> {
  const p = (n: number) => String(n).padStart(2, "0");
  const base =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}-${workflowName}`;
  await mkdir(runsRoot, { recursive: true });
  let id = base;
  for (let i = 2; ; i++) {
    try {
      await mkdir(join(runsRoot, id)); // exclusive: the reservation
      return id;
    } catch (e: unknown) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      id = `${base}-${i}`;
    }
  }
}

export interface DiskRunSummary {
  runId: string;
  workflow: string;
  /** finished-event outcome, or null when the run never completed (crashed or still in flight elsewhere). */
  outcome: string | null;
  /** Node ids in graph order, with the last terminal state seen in the log. */
  nodes: Array<{ id: string; state: string }>;
}

/** Disk view of a run dir's run.jsonl for `workflow list|status|cancel` -- read-only, no claim validation. */
export async function readRunSummary(runDir: string): Promise<DiskRunSummary | null> {
  const prior = await readRunLog(runDir);
  if (!prior) return null;
  return {
    runId: prior.started.runId,
    workflow: prior.started.workflow,
    outcome: prior.finished?.outcome ?? null,
    nodes: prior.started.nodes.map((id) => ({ id, state: prior.lastState.get(id) ?? "pending" })),
  };
}

interface SucceededClaim {
  id: string;
  attempt: number;
  verdict: string | null;
  summary: string;
  deps: string[];
  files: Record<string, FileClaim>;
}

interface RunLogEvents {
  started: { runId: string; workflow: string; nodes: string[]; startedAt: number };
  /** node id -> last node event state seen */
  lastState: Map<string, string>;
  succeeded: Map<string, SucceededClaim>;
  finished: { outcome: string } | null;
}

async function readRunLog(runDir: string): Promise<RunLogEvents | null> {
  let text: string;
  try {
    text = await readFile(join(runDir, "run.jsonl"), "utf8");
  } catch {
    return null;
  }
  let started: RunLogEvents["started"] | null = null;
  let finished: RunLogEvents["finished"] = null;
  const lastState = new Map<string, string>();
  const succeeded = new Map<string, SucceededClaim>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue; // tolerate a torn final line
    }
    if (ev.ev === "started") {
      started = {
        runId: String(ev.runId),
        workflow: String(ev.workflow),
        nodes: (ev.nodes as string[]) ?? [],
        startedAt: Number(ev.startedAt),
      };
    } else if (ev.ev === "finished") {
      finished = { outcome: String(ev.outcome) };
    } else if (ev.ev === "node") {
      const id = String(ev.id);
      const state = String(ev.state);
      if (!["succeeded", "failed", "blocked", "cancelled"].includes(state)) continue;
      lastState.set(id, state);
      if (state === "succeeded") {
        succeeded.set(id, {
          id,
          attempt: Number(ev.attempt ?? 0),
          verdict: ev.verdict == null ? null : String(ev.verdict),
          summary: String(ev.summary ?? ""),
          deps: (ev.deps as string[]) ?? [],
          files: (ev.files as Record<string, FileClaim>) ?? {},
        });
      } else {
        succeeded.delete(id);
      }
    }
  }
  return started ? { started, lastState, succeeded, finished } : null;
}

export interface ReconcileReport {
  runId: string;
  workflow: string;
  /** Completed claims whose files and inputs still match the filesystem. */
  valid: string[];
  /** Completed claims that no longer verify (changed/missing outputs or verdict). */
  invalid: string[];
  /** Nodes without a completed claim (need execution on resume). */
  incomplete: string[];
}

/**
 * Reconcile a run directory: check the filesystem against the nodes'
 * completed claims (openclaw resume-from-recorded-facts). A claim survives
 * only if its output files still exist unmodified, its verdict file still
 * parses to the recorded value, and every claimed upstream is itself valid.
 */
export async function reconcileRun(runDir: string): Promise<ReconcileReport> {
  const prior = await readRunLog(runDir);
  if (!prior) throw new Error(`no usable run.jsonl in '${runDir}'`);
  const report = await validateClaims(prior, (p) => join(runDir, p));
  report.runId = prior.started.runId;
  return report;
}

async function validateClaims(
  prior: RunLogEvents,
  resolvePath: (rel: string) => string,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    runId: prior.started.runId,
    workflow: prior.started.workflow,
    valid: [],
    invalid: [],
    incomplete: [],
  };
  const decided = new Map<string, boolean>(); // claim id -> valid

  // Fixed-point over succeeded claims (graphs are small; deps precede).
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, claim] of prior.succeeded) {
      if (decided.has(id)) continue;
      // An upstream without a live succeeded claim (failed/blocked/cancelled,
      // never finished, or invalidated) breaks this claim outright.
      const depsBroken = claim.deps.some((d) => !prior.succeeded.has(d) || decided.get(d) === false);
      if (depsBroken) {
        decided.set(id, false);
        progressed = true;
        continue;
      }
      const unmet = claim.deps.filter((d) => !decided.has(d));
      if (unmet.length > 0) continue; // wait for upstream verdicts
      let ok = true;
      for (const [path, fc] of Object.entries(claim.files)) {
        try {
          const st = await stat(resolvePath(path));
          if (st.size !== fc.size || st.mtimeMs !== fc.mtimeMs) {
            ok = false;
            break;
          }
        } catch {
          ok = false;
          break;
        }
      }
      if (ok) {
        const v = await readVerdictFile(resolvePath(`${id}.verdict`));
        ok = v !== null && (!claim.verdict || v.value === claim.verdict);
      }
      decided.set(id, ok);
      progressed = true;
    }
  }
  // Claims whose upstream never decided (upstream itself stale-pending) -> invalid.
  for (const id of prior.succeeded.keys()) {
    if (!decided.has(id)) decided.set(id, false);
  }
  for (const id of prior.succeeded.keys()) {
    (decided.get(id) ? report.valid : report.invalid).push(id);
  }
  for (const id of prior.started.nodes) {
    if (!prior.succeeded.has(id)) report.incomplete.push(id);
  }
  return report;
}

/**
 * A verdict file's first line is exactly one of pass|fail|reject (the enum
 * gate); anything below is a free-text note (judge critique rides here).
 * Null when the file is missing or the first line is not the enum.
 */
async function readVerdictFile(path: string): Promise<{ value: string; note: string } | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const nl = text.indexOf("\n");
  const first = (nl === -1 ? text : text.slice(0, nl)).trim().toLowerCase();
  if (!VERDICTS.has(first)) return null;
  return { value: first, note: nl === -1 ? "" : text.slice(nl + 1).trim() };
}
