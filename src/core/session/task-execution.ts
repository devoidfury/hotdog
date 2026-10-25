import { logger } from "@utils/logger.ts";
import { HOOKS } from "../hooks.ts";
import { LlmError, formatError, isExpectedError } from "../error.ts";
import type { AgentLike } from "./index.ts";
import {
  TASK_STATUS,
  type TaskEntry,
  type TaskStatus,
  type TurnPrompt,
  type TurnResult,
} from "./task-types.ts";
import type { TaskScheduler } from "./task-scheduler.ts";

/** Execution edge back into the owning TaskManager (execution -> manager). */
interface ExecutionEnv {
  /** The manager's single status write point (timestamps + observer + eviction). */
  setStatus(entry: TaskEntry, status: TaskStatus): void;
  /** Emit a fresh task snapshot to the observer (turn start/end display anchors). */
  notifyTask(entry: TaskEntry): void;
  buildAgent(config: Record<string, unknown>): Promise<AgentLike>;
  /** The scheduler: lane release, admit re-runs, and health notes. */
  scheduler: TaskScheduler;
}

/**
 * Turn execution for a started task: agent build, one-turn drive, parked-task
 * accounting, and the terminal finalize (status, agent release, lane free,
 * settle). TaskTurn/completeTask/interrupt in the manager drive it through
 * the public methods; talks back through ExecutionEnv.
 */
export class TaskExecution {
  #env: ExecutionEnv;

  constructor(env: ExecutionEnv) {
    this.#env = env;
  }

  /** Build and run a started task. Failures land on the task result, not as a rejection to the spawnTask caller. */
  async launch(
    taskId: string,
    entry: TaskEntry,
    agentConfig: Record<string, unknown>,
    description: TurnPrompt,
    notify: (result: string) => void,
  ): Promise<void> {
    let agent: AgentLike;
    try {
      agent = await this.#env.buildAgent(agentConfig);
    } catch (err: unknown) {
      // Build failures used to throw out of spawnTask into the delegating tool;
      // queued tasks make that impossible, so they are reported the same way run failures are.
      this.#env.setStatus(entry, TASK_STATUS.FAILED);
      logger.error(`[task ${taskId}] ${formatError(err)}`);
      const result = `Task failed: ${err instanceof Error ? err.message : String(err)}`;
      notify(result);
      // No-turn terminal transition: deliver a synthesized turn result so a parked consumer (workflow engine attempt gate) can never hang.
      entry.onTurn?.({ status: "failed", result });
      this.#env.scheduler.releaseSlot(entry);
      entry.settle(TASK_STATUS.FAILED, result);
      this.#env.scheduler.admit();
      return;
    }
    if (entry.statusRef.value !== TASK_STATUS.RUNNING) {
      // Cancelled while building. The cancelling transition settles `done`
      // itself; this branch must not assume it (a dangling `done` would hang
      // a parked consumer waiting on onTurn), so settle idempotently after
      // the SESSION_END reclaim, mirroring #finalizeTurn's ordering.
      agent.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId: agent.sessionId });
      if (!entry.settled) {
        this.#env.scheduler.releaseSlot(entry);
        entry.onTurn?.({ status: "cancelled", result: "Task aborted" });
        entry.settle(entry.statusRef.value, "Task aborted");
        this.#env.scheduler.admit();
      }
      return;
    }
    if (entry.abortController.signal.aborted) {
      this.#env.setStatus(entry, TASK_STATUS.CANCELLED);
      notify("Task aborted");
      entry.onTurn?.({ status: "cancelled", result: "Task aborted" });
      // Discarded fresh agent (turn never ran): same reclaim as above,
      // ordered like #finalizeTurn (status terminal -> hook -> settle).
      agent.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId: agent.sessionId });
      this.#env.scheduler.releaseSlot(entry);
      entry.settle(TASK_STATUS.CANCELLED, "Task aborted");
      this.#env.scheduler.admit();
      return;
    }
    entry.agent = agent;
    await this.#runTask(taskId, entry, agent, description);
  }

  /**
   * Last-resort recovery for a residual throw inside #launch: log, force a
   * terminal FAILED (idempotent via `settled`), free the lane, then deliver
   * the synthesized turn result and hooks. Consumer callbacks run last and
   * inside their own guard so a faulty consumer can't resurrect the rejection
   * this method exists to swallow.
   */
  recoverTask(taskId: string, entry: TaskEntry, e: unknown): void {
    logger.error(`[task ${taskId}] unhandled task fault: ${formatError(e)}`);
    if (!entry.settled) {
      this.#env.setStatus(entry, TASK_STATUS.FAILED);
      const agent = entry.agent;
      entry.agent = null;
      this.#env.scheduler.releaseSlot(entry);
      this.wakeTurnWaiters(entry);
      const result = `Task failed: ${e instanceof Error ? e.message : String(e)}`;
      entry.settle(TASK_STATUS.FAILED, result);
      this.#env.scheduler.admit();
      try {
        entry.onTurn?.({ status: "failed", result });
        agent?.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId: agent.sessionId });
      } catch (inner: unknown) {
        logger.error(`[task ${taskId}] recovery callback threw: ${formatError(inner)}`);
      }
    }
  }

  /** Whether a finished turn leaves a parked task RUNNING (its lane slot is held only through the turn). */
  parked(entry: TaskEntry, turn: TurnResult): boolean {
    return (
      entry.parked &&
      turn.status === "completed" &&
      !entry.releaseRequested &&
      !entry.abortController.signal.aborted
    );
  }

  async #runTask(taskId: string, entry: TaskEntry, agent: AgentLike, description: TurnPrompt): Promise<void> {
    const turn = await this.driveTurn(taskId, entry, agent, description);
    if (!this.parked(entry, turn)) this.finalizeTurn(entry, agent, turn);
  }


  /** Run one agent turn; never throws -- failures come back as TurnResult. */
  async driveTurn(
    taskId: string,
    entry: TaskEntry,
    agent: AgentLike,
    prompt: TurnPrompt,
  ): Promise<TurnResult> {
    entry.inRun = true;
    entry.turnStartedAt = Date.now();
    // Turn-start snapshot: the display clock needs the live anchor even when
    // the status stays RUNNING (a warm retry after a park never re-notifies
    // through #setStatus).
    this.#env.notifyTask(entry);
    // Turn-start signal (runtime-cap accounting): the lane is in hand and the
    // agent turn begins here. A faulty callback must not disturb the turn.
    try {
      entry.onTurnStart?.();
    } catch (e: unknown) {
      logger.error(`[task ${taskId}] onTurnStart threw: ${formatError(e)}`);
    }
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
        // Only unexpected errors (bugs) log via formatError() with full stack.
        // Expected ones (LlmError api/http/timeout/...) are already the task
        // result the delegating model receives; a log line would echo it. The
        // model always gets the message alone -- a stack would waste tokens
        // and leak internals.
        if (!isExpectedError(err)) {
          logger.error(`[task ${taskId}] ${formatError(err)}`);
        }
        // Failure-driven demotion: a connection-level chat failure takes the
        // provider out immediately so the next fanout avoids the same dead
        // provider. llm-client throws LlmError.Http only for connection-level
        // rejects (refused/DNS/reset mid-body); HTTP-status failures arrive as
        // LlmError.Api and timeouts as LlmError.Timeout -- neither demotes: a
        // 500 or a stall proves the socket answers, and demoting on those would
        // flap the pool around live-but-unhappy providers.
        if (this.#env.scheduler.providerHealth && entry.provider && err instanceof LlmError && err.type === "http") {
          this.#env.scheduler.providerHealth.markDown(entry.provider, `task ${taskId} chat failed: ${err.message}`);
        }
        turn = { status: "failed", result: `Task failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    }
    // Recovery evidence: a completed turn means at least one chat
    // round-tripped, so the provider is up. This is the recovery path when the
    // sweep timer is off (interval 0): fail-open placements and in-flight
    // traffic keep producing evidence. Failed turns decide nothing here (the
    // branch above owns demotion); cancelled turns are inconclusive.
    if (turn.status === "completed" && this.#env.scheduler.providerHealth && entry.provider) {
      this.#env.scheduler.providerHealth.noteUp(entry.provider);
    }
    entry.inRun = false;
    // Bank the finished turn (display accounting mirror of the engine's cap:
    // only the task's own turns run the clock). Guarded because a terminal
    // transition may have banked it already (see #setStatus).
    if (entry.turnStartedAt !== null) {
      entry.activeMs += Math.max(0, Date.now() - entry.turnStartedAt);
      entry.turnStartedAt = null;
    }
    // Turn-end snapshot: parked tasks flip to the frozen waiting clock here.
    this.#env.notifyTask(entry);
    entry.lastResult = turn.result;
    entry.onTurn?.(turn);
    // A parked entry that stays RUNNING has just gone idle: it yields its
    // lane slot here -- in-process accounting AND the cross-process ledger
    // file -- letting queued spawns and waiting warm turns in.
    if (this.parked(entry, turn)) this.#env.scheduler.releaseSlot(entry);
    this.#env.scheduler.admit();
    return turn;
  }

  /** Wake queued taskTurn waiters whose entry reached a terminal state. */
  wakeTurnWaiters(entry: TaskEntry): void {
    entry.turnPending = false;
    entry.turnGranted = false;
    const waiters = entry.turnWaiters;
    entry.turnWaiters = [];
    for (const wake of waiters) wake();
  }

  /** Terminal transition: status, notification, agent release, lane free, `done`. */
  finalizeTurn(entry: TaskEntry, agent: AgentLike, turn: TurnResult): void {
    if (turn.status === "completed") {
      if (entry.statusRef.value === TASK_STATUS.RUNNING) {
        this.#env.setStatus(entry, TASK_STATUS.COMPLETED);
      }
    } else if (turn.status === "cancelled") {
      this.#env.setStatus(entry, TASK_STATUS.CANCELLED);
    } else {
      this.#env.setStatus(entry, TASK_STATUS.FAILED);
    }

    // For parked tasks the sink drops this (the engine consumed the turn already).
    agent.notifyCompletion?.(turn.result);

    // Release the finished agent: its full message context would otherwise
    // stay pinned in #tasks for the manager's lifetime. The entry keeps only
    // what post-run lookups use; sendFollowUp guards on a live agent, and a
    // RUNNING entry with no agent only exists inside #launch's build window.
    entry.agent = null;

    // Any warm turn still queued behind the lane never runs.
    this.wakeTurnWaiters(entry);

    // Free lane (ledger slot included): give queued tasks a chance at the released slot.
    this.#env.scheduler.releaseSlot(entry);
    this.#env.scheduler.admit();

    // The task agent's lifecycle ends here -- announce it through the
    // agent's own (shared) hook system so per-session extension state is
    // reclaimed. Test fakes may carry no hooks, hence the optional chain.
    agent.hooks?.notifyHooks(HOOKS.SESSION_END, { sessionId: agent.sessionId });

    entry.settle(entry.statusRef.value, turn.result);
  }

}
