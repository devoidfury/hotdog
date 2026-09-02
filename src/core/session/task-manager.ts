import { logger } from "../logger.ts";
import { Message, type MessageSource } from "../context/message.ts";
import { LlmError, formatError } from "../error.ts";
import { loadProfileFile, ProfileManager } from "../config/profiles.ts";
import { type CoreConfigWithExtensions } from "../config/schema-loader.ts";
import type { ModelConfig } from "../config/providers.ts";
import type { AgentLike } from "./index.ts";

export const TASK_STATUS = {
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

export class TaskHandle {
  taskId: string;
  #statusRef: { value: TaskStatus };
  #abortController: AbortController;

  constructor(taskId: string, statusRef: { value: TaskStatus }, abortController: AbortController) {
    this.taskId = taskId;
    this.#statusRef = statusRef;
    this.#abortController = abortController;
  }

  get status(): TaskStatus {
    return this.#statusRef.value;
  }

  interrupt(): boolean {
    if (this.status === TASK_STATUS.RUNNING) {
      this.#abortController.abort();
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
  /** Look up a session's bus by id; used to route task results to the right session. */
  getBus?: (sessionId: string) => TaskResultBus | undefined;
}

export interface SpawnTaskOptions {
  workerModel?: string;
  profile?: string;
  /**
   * The agent that delegated this task. Its session's bus is the delivery
   * target for the completion result. Without this, the result falls back to
   * a direct append to the session manager's current agent's context.
   */
  managerAgent?: { sessionId: string } | null;
}

export interface TaskManagerOptions {
  modelRegistry: Record<string, ModelConfig>;
  config: CoreConfigWithExtensions;
  sessionManager?: TaskManagerSessionManager | null;
  profileManager?: ProfileManager;
}

export interface TaskManagerRequiredOptions {
  buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  maxIterations: number;
  taskProfile: string;
  taskRole: string;
}

export class TaskManager {
  #buildAgent: (config: Record<string, unknown>) => Promise<AgentLike>;
  #modelRegistry: Record<string, ModelConfig>;
  #config: CoreConfigWithExtensions;
  #sessionManager: TaskManagerSessionManager | null;
  #maxIterations: number;
  #taskProfile: string;
  #taskRole: string;
  #tasks: Map<string, {
    agent: AgentLike;
    abortController: AbortController;
    statusRef: { value: TaskStatus };
    runPromise: Promise<string>;
    /** The delegating session that spawned this task (null if none). Used to
     *  abort the task when that session is deleted. */
    sessionId: string | null;
  }>;
  #profileManager: ProfileManager | undefined;

  constructor(options: TaskManagerOptions & TaskManagerRequiredOptions) {
    this.#buildAgent = options.buildAgent;
    this.#modelRegistry = options.modelRegistry || {};
    this.#config = options.config || {};
    this.#sessionManager = options.sessionManager || null;
    this.#maxIterations = options.maxIterations;
    this.#taskProfile = options.taskProfile;
    this.#taskRole = options.taskRole;
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

  _onTaskComplete(
    taskId: string | null,
    result: string,
    delivery: { sessionId: string } | null = null,
  ): void {
    // Harness structure: trusted framing around the model-generated result,
    // which rides an `untrusted` part (raw in context and logs, mangled only
    // at the wire serializer).
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
    taskDescription: string,
    options: SpawnTaskOptions = {} as SpawnTaskOptions,
  ): Promise<TaskHandle> {
    const profileName = options.profile || this.#taskProfile;
    const taskProfile = this.#profileManager
      ? this.#profileManager.getProfile(profileName)
      : await loadProfileFile(this.#config.profilesPath ?? "", profileName);

    const resolvedModel =
      options.workerModel ||
      (taskProfile?.model ?? undefined) ||
      (this.#modelRegistry as { default?: string }).default ||
      "";

    const resolvedRole = taskProfile?.role || this.#taskRole;
    const resolvedProfileBody = taskProfile?.body || "";

    const toolWhitelist = taskProfile?.whitelistTools || null;

    // Capture the delegating agent up front so completion is delivered to
    // ITS session's bus, even if other sessions are created in the meantime.
    const delivery = options.managerAgent ?? null;

    // Task agents are silent to the UI; only onTaskComplete matters.
    const sink = {
      emit: (_event: unknown) => {},
      onTaskComplete: (result: string) => this._onTaskComplete(taskId, result, delivery),
    };

    const agentConfig: Record<string, unknown> = {
      model: resolvedModel,
      role: resolvedRole,
      profileBody: resolvedProfileBody,
      sink,
      toolWhitelist,
      hideTools: true,
      hideThinking: true,
      showTokenUse: false,
      maxIterations: this.#maxIterations,
    };

    const agent = await this.#buildAgent(agentConfig);

    const abortController = new AbortController();
    const statusRef: { value: TaskStatus } = { value: TASK_STATUS.RUNNING };

    const runPromise = this._runTask(
      taskId,
      agent,
      taskDescription,
      abortController,
      statusRef,
    );

    this.#tasks.set(taskId, {
      agent,
      abortController,
      statusRef,
      runPromise,
      // Ownership by delegating session: lets session deletion abort this
      // task (and only this session's tasks).
      sessionId: delivery ? delivery.sessionId : null,
    });

    return new TaskHandle(taskId, statusRef, abortController);
  }

  private async _runTask(
    taskId: string,
    agent: AgentLike,
    description: string,
    abortController: AbortController,
    statusRef: { value: TaskStatus },
  ): Promise<string> {
    let result: string;

    try {
      agent.abortSignal = abortController.signal;

      // Task descriptions are composed by the delegating model.
      const runResult = await agent.run(description, undefined, { source: "model" });

      if (runResult?.type === 'completion') {
        result = runResult.content;
      } else if (runResult?.type === 'tool_return') {
        result = `Task completed via tool return: ${runResult.outcome}`;
      } else {
        result = `Task provided no response`;
      }

      if (statusRef.value === TASK_STATUS.RUNNING) {
        statusRef.value = TASK_STATUS.COMPLETED;
      }

      agent.notifyCompletion?.(result);
    } catch (err: unknown) {
      if (LlmError.isCancelled(err) || abortController.signal.aborted) {
        statusRef.value = TASK_STATUS.CANCELLED;
        result = `Task aborted`;
      } else {
        statusRef.value = TASK_STATUS.FAILED;
        // Error Handling rule: report through formatError() -- unexpected
        // errors (bugs) log message + full stack, expected ones message
        // only. The delegating model gets the message alone; a stack in its
        // context would waste tokens and leak internals.
        logger.error(`[task ${taskId}] ${formatError(err)}`);
        result = `Task failed: ${err instanceof Error ? err.message : String(err)}`;
      }

      agent.notifyCompletion?.(result);
    }

    return result;
  }

  taskStatus(taskId: string): TaskStatus | null {
    const task = this.#tasks.get(taskId);
    if (!task) return null;
    return task.statusRef.value;
  }

  sendFollowUp(taskId: string, message: string): boolean {
    const task = this.#tasks.get(taskId);
    if (!task || task.statusRef.value !== TASK_STATUS.RUNNING) {
      return false;
    }

    // followQueue is drained between LLM calls.
    if (task.agent.followQueue) {
      task.agent.followQueue.push(message);
      return true;
    }

    task.agent.addMessage(new Message({ role: "user", content: message, source: "user" }));
    return true;
  }

  interruptTask(taskId: string): boolean {
    const task = this.#tasks.get(taskId);
    if (!task) return false;
    task.abortController.abort();
    return true;
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
      if (
        task.sessionId === sessionId &&
        task.statusRef.value === TASK_STATUS.RUNNING
      ) {
        task.abortController.abort();
        interrupted++;
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
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return `${active} task${active === 1 ? "" : "s"} running`;
  }
}
