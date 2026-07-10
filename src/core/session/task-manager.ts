// TaskManager — manages background task agents using the Agent class.

import { Message } from "../context/message.ts";
import { LlmError } from "../error.ts";
import { OUTPUT_EVENT } from "../context/output.ts";
import { AgentSink } from "./agent-sink.ts";
import { loadProfileFile } from "../config/profiles.ts";

// ── Task Status ─────────────────────────────────────────────────────────────

export const TASK_STATUS = {
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
} as const;

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS];

// ── Task Handle ─────────────────────────────────────────────────────────────

/** Handle to a running task agent. Provides status checks, follow-up sending, and interruption. */
export class TaskHandle {
  taskId: string;
  _statusRef: { value: TaskStatus };
  _abortController: AbortController;

  constructor(taskId: string, statusRef: { value: TaskStatus }, abortController: AbortController) {
    this.taskId = taskId;
    this._statusRef = statusRef;
    this._abortController = abortController;
  }

  get status(): TaskStatus {
    return this._statusRef.value;
  }

  /** Interrupt (cancel) a running task. */
  interrupt(): boolean {
    if (this.status === TASK_STATUS.RUNNING) {
      this._abortController.abort();
      return true;
    }
    return false;
  }
}

// ── TaskManager ─────────────────────────────────────────────────────────────

export interface TaskAgent {
  _abortSignal: AbortSignal | null;
  run(description: string): Promise<string | undefined>;
  _notifyCompletion(result: string): void;
  addMessage(msg: Message): void;
  _followQueue?: string[];
}

export interface SpawnTaskOptions {
  workerModel?: string;
  profile?: string;
}

export interface TaskManagerOptions {
  llmClient: unknown;
  modelRegistry: Record<string, unknown>;
  config: Record<string, unknown>;
  hooks: unknown;
  sessionManager?: { getAgent: () => TaskAgent | undefined } | null;
}

export interface TaskManagerRequiredOptions {
  buildAgent: (config: Record<string, unknown>) => Promise<TaskAgent>;
  maxIterations: number;
  taskProfile: string;
  taskRole: string;
}

/**
 * Manages concurrent task agents: spawn, status, interrupt, follow-up.
 *
 * Task agents are full Agent instances with:
 * - Restricted tool sets (whitelist from profile)
 * - Filtered output (silent to UI)
 * - Background execution with AbortController
 */
export class TaskManager {
  _buildAgent: (config: Record<string, unknown>) => Promise<TaskAgent>;
  _llmClient: unknown;
  _modelRegistry: Record<string, unknown>;
  _config: Record<string, unknown>;
  _hooks: unknown;
  _sessionManager: { getAgent: () => TaskAgent | undefined } | null;
  _maxIterations: number;
  _taskProfile: string;
  _taskRole: string;
  _tasks: Map<string, {
    agent: TaskAgent;
    abortController: AbortController;
    statusRef: { value: TaskStatus };
    runPromise: Promise<string>;
  }>;
  _bus: { enqueue: (text: string) => void } | null;

  /**
   * @param options
   * @param options.buildAgent — Function to create Agent instances
   * @param options.llmClient — LLM client instance
   * @param options.modelRegistry — Model name → config map
   * @param options.config — Config reference
   * @param options.hooks — HookSystem instance
   * @param options.sessionManager — SessionManager for context injection
   * @param options.maxIterations — Max iterations per task (from resolved config)
   * @param options.taskProfile — Default task profile name (from resolved config)
   * @param options.taskRole — Default task role (from resolved config)
   */
  constructor(options: TaskManagerOptions & TaskManagerRequiredOptions) {
    this._buildAgent = options.buildAgent;
    this._llmClient = options.llmClient;
    this._modelRegistry = options.modelRegistry || {};
    this._config = options.config || {};
    this._hooks = options.hooks || null;
    this._sessionManager = options.sessionManager || null;
    this._maxIterations = options.maxIterations;
    this._taskProfile = options.taskProfile;
    this._taskRole = options.taskRole;
    this._tasks = new Map();
    this._bus = null;
  }

  /**
   * Set the session manager for context injection on task completion.
   * Called once after SessionManager is created.
   * @param sessionManager — SessionManager instance
   */
  setSessionManager(sessionManager: { getAgent: () => TaskAgent | undefined }): void {
    this._sessionManager = sessionManager;
  }

  /**
   * Set the message bus for waking up the manager agent.
   * Called once after the bus is created.
   * @param bus — MessageBus instance with enqueue() method
   */
  setBus(bus: { enqueue: (text: string) => void }): void {
    this._bus = bus;
  }

  /**
   * Internal: handle task completion — append result to manager context and wake up.
   * This is the single place where task completion logic lives.
   * @param taskId
   * @param result
   * @private
   */
  _onTaskComplete(taskId: string, result: string): void {
    // Append result to manager's context
    if (this._sessionManager) {
      const agent = this._sessionManager.getAgent();
      if (agent) {
        const tag = "system-notice"; // this keeps the marker mangler from interfering with the tag
        agent.addMessage(
          new Message({
            role: "user",
            content: `<${tag}>[Task ${taskId} completed]\n${result}</${tag}>`,
          }),
        );
      }
    }

    // Wake up the manager via bus
    if (this._bus) {
      this._bus.enqueue(`[Task ${taskId} completed]\n${result}`);
    }
  }

  /**
   * Spawn a new background task agent.
   * @param taskId - Unique task identifier
   * @param taskDescription - Description of what the task should do
   * @param options
   * @param options.workerModel - Optional model override for the worker
   * @param options.profile - Optional profile name (default: 'task-default')
   * @returns TaskHandle
   */
  async spawnTask(
    taskId: string,
    taskDescription: string,
    options: SpawnTaskOptions = {} as SpawnTaskOptions,
  ): Promise<TaskHandle> {
    // 1. Load task profile
    const profileName = options.profile || this._taskProfile;
    const taskProfile = loadProfileFile((this._config as Record<string, unknown>).profilesPath as string, profileName);

    // 2. Resolve model
    const resolvedModel =
      options.workerModel ||
      (taskProfile && (taskProfile as Record<string, unknown>).model) ||
      (this._modelRegistry as { default?: string }).default ||
      "";

    // 3. Build system prompt from profile
    const resolvedRole = (taskProfile as Record<string, unknown>)?.role || this._taskRole;
    const resolvedProfileBody = (taskProfile as Record<string, unknown>)?.body || "";

    // 4. Resolve allowed tools: profile whitelist takes precedence
    const toolWhitelist = (taskProfile as Record<string, unknown>)?.whitelistTools || null;

    // 5. Create task-specific sink (filters output, captures completion)
    const sink = new AgentSink({
      isTaskAgent: true,
      onTaskComplete: (id, result) => this._onTaskComplete(id, result),
    });
    sink.setTaskAgentId(taskId);

    // 6. Build agent config
    const agentConfig: Record<string, unknown> = {
      model: resolvedModel,
      role: resolvedRole,
      profileBody: resolvedProfileBody,
      sink,
      toolWhitelist,
      hideTools: true,
      hideThinking: true,
      showTokenUse: false,
      maxIterations: this._maxIterations,
    };

    // 7. Create the agent
    const agent = await this._buildAgent(agentConfig);

    // 8. Create abort controller and status ref
    const abortController = new AbortController();
    const statusRef: { value: TaskStatus } = { value: TASK_STATUS.RUNNING };

    // 9. Run the agent in background
    const runPromise = this._runTask(
      agent,
      taskDescription,
      abortController,
      statusRef,
    );

    // 10. Store task info
    this._tasks.set(taskId, {
      agent,
      abortController,
      statusRef,
      runPromise,
    });

    return new TaskHandle(taskId, statusRef, abortController);
  }

  /**
   * Run a task agent in the background.
   * @param agent - The Agent instance
   * @param description - Task description
   * @param abortController
   * @param statusRef
   * @returns Result string
   */
  async _runTask(
    agent: TaskAgent,
    description: string,
    abortController: AbortController,
    statusRef: { value: TaskStatus },
  ): Promise<string> {
    let result: string;

    try {
      // Run with abort signal support
      agent._abortSignal = abortController.signal;

      result = (await agent.run(description)) as string;

      if (statusRef.value === TASK_STATUS.RUNNING) {
        statusRef.value = TASK_STATUS.COMPLETED;
      }

      // Notify sink of completion (for task agents)
      agent._notifyCompletion(result);
    } catch (err: unknown) {
      if (err instanceof LlmError.Cancelled || abortController.signal.aborted) {
        statusRef.value = TASK_STATUS.CANCELLED;
        result = `Task aborted`;
      } else {
        statusRef.value = TASK_STATUS.FAILED;
        result = `Task failed: ${(err as Error).message}`;
      }

      // Still notify sink even on error
      agent._notifyCompletion(result);
    }

    return result;
  }

  /**
   * Check the status of a task by ID.
   * @param taskId
   * @returns Task status or null if not found.
   */
  taskStatus(taskId: string): TaskStatus | null {
    const task = this._tasks.get(taskId);
    if (!task) return null;
    return task.statusRef.value;
  }

  /**
   * Send a follow-up message to a running task.
   * @param taskId
   * @param message
   * @returns Whether the follow-up was sent.
   */
  sendFollowUp(taskId: string, message: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task || task.statusRef.value !== TASK_STATUS.RUNNING) {
      return false;
    }

    // Add follow-up to the agent's context
    // Note: This works if the agent is between LLM calls (draining follow-ups)
    if (task.agent._followQueue) {
      task.agent._followQueue.push(message);
      return true;
    }

    // If no follow-up queue, add directly to context
    task.agent.addMessage(new Message({ role: "user", content: message }));
    return true;
  }

  /**
   * Interrupt (cancel) a running task.
   * @param taskId
   * @returns Whether the task was interrupted.
   */
  interruptTask(taskId: string): boolean {
    const task = this._tasks.get(taskId);
    if (!task) return false;
    return task.abortController.abort();
  }

  /**
   * Get all active (running) task IDs.
   * @returns Array of active task IDs.
   */
  activeTasks(): string[] {
    const active: string[] = [];
    for (const [id, task] of this._tasks) {
      if (task.statusRef.value === TASK_STATUS.RUNNING) {
        active.push(id);
      }
    }
    return active;
  }

  /**
   * Get task counts: [active, total]. Returns null if no tasks.
   * @returns [active, total] or null.
   */
  taskCounts(): [number, number] | null {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return [active, this._tasks.size];
  }

  /**
   * Format a progress string showing active tasks.
   * @returns Progress string or null.
   */
  progressMessage(): string | null {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return `${active} task${active === 1 ? "" : "s"} running`;
  }
}
