// TaskManager — manages background task agents using the Agent class.
//
// Replaces the old TaskWorker-based implementation. Task agents are now
// full Agent instances with restricted tool sets and filtered output.

import { Message } from "../context/message.js";
import { LlmError } from "../llm_client/client.js";
import { OUTPUT_EVENT } from "../context/output.js";
import { AgentSink } from "./agent_sink.js";
import { loadProfileFile } from "../config.js";

// ── Task Status ─────────────────────────────────────────────────────────────

export const TASK_STATUS = {
  RUNNING: "running",
  COMPLETED: "completed",
  FAILED: "failed",
  CANCELLED: "cancelled",
};

// ── Task Handle ─────────────────────────────────────────────────────────────

/** Handle to a running task agent. Provides status checks, follow-up sending, and interruption. */
export class TaskHandle {
  constructor(taskId, statusRef, abortController) {
    this.taskId = taskId;
    this._statusRef = statusRef;
    this._abortController = abortController;
  }

  get status() {
    return this._statusRef.value;
  }

  /** Interrupt (cancel) a running task. */
  interrupt() {
    if (this.status === TASK_STATUS.RUNNING) {
      this._abortController.abort();
      return true;
    }
    return false;
  }
}

// ── TaskManager ─────────────────────────────────────────────────────────────

/**
 * Manages concurrent task agents: spawn, status, interrupt, follow-up.
 *
 * Task agents are full Agent instances with:
 * - Restricted tool sets (whitelist from profile)
 * - Filtered output (silent to UI)
 * - Background execution with AbortController
 */
export class TaskManager {
  /**
   * @param {Object} options
   * @param {Function} options.buildAgent — Function to create Agent instances
   * @param {Object} options.llmClient — LLM client instance
   * @param {Object} options.modelRegistry — Model name → config map
   * @param {Object} options.config — Config reference
   * @param {Object} options.hooks — HookSystem instance
   * @param {Object} [options.sessionManager] — SessionManager for context injection
   * @param {number} [options.maxIterations=1000] — Max iterations per task
   */
  constructor(options = {}) {
    this._buildAgent = options.buildAgent;
    this._llmClient = options.llmClient;
    this._modelRegistry = options.modelRegistry || {};
    this._config = options.config || {};
    this._hooks = options.hooks || null;
    this._sessionManager = options.sessionManager || null;
    this._maxIterations = options.maxIterations || 1000;
    this._tasks = new Map();
    this._bus = null;
  }

  /**
   * Set the session manager for context injection on task completion.
   * Called once after SessionManager is created.
   * @param {Object} sessionManager — SessionManager instance
   */
  setSessionManager(sessionManager) {
    this._sessionManager = sessionManager;
  }

  /**
   * Set the message bus for waking up the manager agent.
   * Called once after the bus is created.
   * @param {Object} bus — MessageBus instance with enqueue() method
   */
  setBus(bus) {
    this._bus = bus;
  }

  /**
   * Internal: handle task completion — append result to manager context and wake up.
   * This is the single place where task completion logic lives.
   * @param {string} taskId
   * @param {string} result
   * @private
   */
  _onTaskComplete(taskId, result) {
    // Append result to manager's context
    if (this._sessionManager) {
      const agent = this._sessionManager.getAgent();
      if (agent) {
        agent.context.push(
          new Message({
            role: "system",
            content: `[Task ${taskId} completed]\n${result}`,
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
   * @param {string} taskId - Unique task identifier
   * @param {string} taskDescription - Description of what the task should do
   * @param {Object} [options]
   * @param {string} [options.workerModel] - Optional model override for the worker
   * @param {string} [options.profile] - Optional profile name (default: 'task-default')
   * @returns {TaskHandle}
   */
  async spawnTask(taskId, taskDescription, options = {}) {
    // 1. Load task profile
    const profileName = options.profile || "task-default";
    const taskProfile = loadProfileFile(this._config, profileName);

    // 2. Resolve model
    const resolvedModel =
      options.workerModel ||
      (taskProfile && taskProfile.model) ||
      this._modelRegistry.default ||
      "";

    // 3. Build system prompt from profile
    const resolvedRole = taskProfile?.role || "A focused worker that executes tasks autonomously";
    const resolvedProfileBody = taskProfile?.body || "";

    // 4. Resolve allowed tools: profile whitelist takes precedence
    const toolWhitelist = taskProfile?.whitelistTools || null;

    // 5. Create task-specific sink (filters output, captures completion)
    const sink = new AgentSink({
      isTaskAgent: true,
      onTaskComplete: (id, result) => this._onTaskComplete(id, result),
    });
    sink.setTaskAgentId(taskId);

    // 6. Build agent config
    const agentConfig = {
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
    const statusRef = { value: TASK_STATUS.RUNNING };

    // 9. Run the agent in background
    const runPromise = this._runTask(agent, taskDescription, abortController, statusRef);

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
   * @param {Object} agent - The Agent instance
   * @param {string} description - Task description
   * @param {AbortController} abortController
   * @param {Object} statusRef
   * @returns {Promise<string>} Result string
   */
  async _runTask(agent, description, abortController, statusRef) {
    let result;

    try {
      // Run with abort signal support
      agent._abortSignal = abortController.signal;

      result = await agent.run(description);

      if (statusRef.value === TASK_STATUS.RUNNING) {
        statusRef.value = TASK_STATUS.COMPLETED;
      }

      // Notify sink of completion (for task agents)
      agent._notifyCompletion(result);
    } catch (err) {
      if (err instanceof LlmError.Cancelled || abortController.signal.aborted) {
        statusRef.value = TASK_STATUS.CANCELLED;
        result = `Task aborted`;
      } else {
        statusRef.value = TASK_STATUS.FAILED;
        result = `Task failed: ${err.message}`;
      }

      // Still notify sink even on error
      agent._notifyCompletion(result);
    }

    return result;
  }

  /**
   * Check the status of a task by ID.
   * @param {string} taskId
   * @returns {string|null}
   */
  taskStatus(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return null;
    return task.statusRef.value;
  }

  /**
   * Send a follow-up message to a running task.
   * @param {string} taskId
   * @param {string} message
   * @returns {boolean}
   */
  sendFollowUp(taskId, message) {
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
    task.agent.context.push(new Message({ role: "user", content: message }));
    return true;
  }

  /**
   * Interrupt (cancel) a running task.
   * @param {string} taskId
   * @returns {boolean}
   */
  interruptTask(taskId) {
    const task = this._tasks.get(taskId);
    if (!task) return false;
    return task.abortController.abort();
  }

  /**
   * Get all active (running) task IDs.
   * @returns {string[]}
   */
  activeTasks() {
    const active = [];
    for (const [id, task] of this._tasks) {
      if (task.statusRef.value === TASK_STATUS.RUNNING) {
        active.push(id);
      }
    }
    return active;
  }

  /**
   * Get task counts: [active, total]. Returns null if no tasks.
   * @returns {[number, number]|null}
   */
  taskCounts() {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return [active, this._tasks.size];
  }

  /**
   * Format a progress string showing active tasks.
   * @returns {string|null}
   */
  progressMessage() {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return `${active} task${active === 1 ? "" : "s"} running`;
  }
}
