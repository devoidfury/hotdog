// Task worker — async delegation with background task agents.
//
// Provides TaskHandle, TaskWorker, and TaskManager for spawning,
// monitoring, and controlling concurrent task agents.

import { MessageLog } from '../context/index.js';
import { LlmClient, LlmError } from '../llm_client/client.js';
import { ToolRegistry, toolResult } from '../tools/registry.js';
import { createToolFactory, CORE_TOOL_NAMES } from '../tools/index.js';
import { DEFAULT_MAX_TOKENS, DEFAULT_MAX_ITERATIONS } from '../config.js';

// ── Task Status ─────────────────────────────────────────────────────────────

export const TASK_STATUS = {
  RUNNING: 'running',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
};

// ── Task Handle ─────────────────────────────────────────────────────────────

/** Handle to a running task agent. Provides status checks, follow-up sending, and interruption. */
export class TaskHandle {
  constructor(taskId, statusRef, abortController, followEmitter) {
    this.taskId = taskId;
    this._statusRef = statusRef;
    this._abortController = abortController;
    this._followEmitter = followEmitter;
  }

  get status() {
    return this._statusRef.value;
  }

  /** Send a follow-up message to a running task. */
  sendFollowUp(message) {
    if (this._followEmitter && this.status === TASK_STATUS.RUNNING) {
      this._followEmitter.emit('follow-up', message);
      return true;
    }
    return false;
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

// ── Task Worker ─────────────────────────────────────────────────────────────

/** Runs a task agent as a background async operation. */
export class TaskWorker {
  constructor(options) {
    this.taskId = options.taskId;
    this.taskDescription = options.taskDescription;
    this.managerContext = options.managerContext;
    this.llmClient = options.llmClient;
    this.modelName = options.modelName || options.modelRegistry?.default || '';
    this.modelRegistry = options.modelRegistry || {};
    this.allowedTools = options.allowedTools || null;
    this.systemPrompt = options.systemPrompt;
    this.wakeUpCallback = options.wakeUpCallback || null;
    this.maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
    this.maxToolOutputLines = options.maxToolOutputLines || 800;

    this.abortController = new AbortController();
    this._followEmitter = null;
    this._statusRef = { value: TASK_STATUS.RUNNING };
  }

  /**
   * Spawn a new task worker as a background async task.
   * Returns the TaskHandle for controlling the task.
   */
  static spawn(options) {
    const worker = new TaskWorker(options);
    const handle = worker._createHandle();

    // Run in background — uncaught errors won't crash the main process
    worker.run().catch((err) => {
      // Task failed — status already updated in run()
    });

    return handle;
  }

  _createHandle() {
    this._followEmitter = { 
      emit: null, 
      on: null,
      listeners: [] 
    };
    // Simple event emitter
    this._followEmitter.listeners = [];
    this._followEmitter.on = (event, cb) => {
      this._followEmitter.listeners.push({ event, cb });
    };
    this._followEmitter.emit = (event, data) => {
      for (const l of this._followEmitter.listeners) {
        if (l.event === event) l.cb(data);
      }
    };

    return new TaskHandle(
      this.taskId,
      this._statusRef,
      this.abortController,
      this._followEmitter
    );
  }

  /** Run the task agent loop. */
  async run() {
    let result;
    try {
      result = await this._runInner();
    } catch (err) {
      if (err instanceof LlmError.Cancelled || this.abortController.signal.aborted) {
        this._statusRef.value = TASK_STATUS.CANCELLED;
        result = `Task ${this.taskId} cancelled`;
      } else {
        this._statusRef.value = TASK_STATUS.FAILED;
        result = `Task ${this.taskId} failed: ${err.message}`;
      }
    }

    if (this._statusRef.value === TASK_STATUS.RUNNING) {
      this._statusRef.value = TASK_STATUS.COMPLETED;
    }

    // Append final result to manager's context
    this.managerContext.addSystemMessage(`[Task ${this.taskId} completed]\n${result}`);

    // Wake up the subagent manager with the result
    if (this.wakeUpCallback) {
      this.wakeUpCallback(this.taskId, result);
    }
  }

  /** Inner run loop with follow-up polling. */
  async _runInner() {
    // Create task agent context with system prompt and task description
    const taskContext = new MessageLog();
    taskContext.addSystemMessage(this.systemPrompt);
    taskContext.addUserMessage(this.taskDescription);

    const modelConfig = this.modelRegistry[this.modelName] || {
      name: this.modelName,
      temperature: null,
      maxTokens: DEFAULT_MAX_TOKENS,
    };

    // Build tool registry for this worker
    const toolNames = this.allowedTools || CORE_TOOL_NAMES;
    const registry = new ToolRegistry();
    const factory = createToolFactory();
    for (const name of toolNames) {
      const tool = await factory.createTool(name, null, toolNames, false);
      if (tool) {
        registry.register(name, tool);
      }
    }

    let iteration = 0;
    while (iteration < this.maxIterations) {
      if (this.abortController.signal.aborted) {
        throw new LlmError.Cancelled('Task cancelled');
      }

      iteration++;

      // Build messages from task context
      const messages = taskContext.getMessages();
      const toolDefs = registry.getToolDefs();

      // Call LLM
      const stream = this.llmClient.chatStreamCancellable(
        messages,
        modelConfig,
        toolDefs,
        { aborted: this.abortController.signal.aborted }
      );

      const response = await this._processStream(stream);

      if (response.finalToolCalls) {
        // Has tool calls — execute them
        taskContext.addAssistantMessage(
          response.fullText,
          response.fullReasoning,
          response.finalToolCalls
        );

        for (const tc of response.finalToolCalls) {
          if (this.abortController.signal.aborted) {
            throw new LlmError.Cancelled('Task cancelled');
          }

          const toolName = tc.function?.name;
          const toolCallId = tc.id;
          const input = tc.function?.arguments || '{}';

          try {
            const tool = registry.get(toolName);
            const toolResultStr = toolResult(await tool.execute(input, {}));
            taskContext.addMessage('tool', toolResultStr, null, null, toolCallId);
          } catch (e) {
            const errorMsg = toolResult(`Error executing tool ${toolName}: ${e.message}`);
            taskContext.addMessage('tool', errorMsg, null, null, toolCallId);
          }
        }

        // Check for follow-up messages (45s timeout)
        const followUp = await this._checkFollowUp();
        if (followUp) {
          taskContext.addUserMessage(followUp);
          continue;
        }
      } else {
        // No tool calls — task is done
        taskContext.addAssistantMessage(response.fullText, response.fullReasoning, null);
        return response.fullText;
      }
    }

    throw new Error(`Task ${this.taskId}: max iterations (${this.maxIterations}) reached`);
  }

  /** Process a streaming LLM response. */
  async _processStream(stream) {
    let fullText = '';
    let fullReasoning = null;
    const toolCallsBuffer = new Map();

    for await (const event of stream) {
      if (this.abortController.signal.aborted) {
        throw new LlmError.Cancelled('Task cancelled');
      }

      switch (event.type) {
        case 'content':
          fullText += event.content;
          break;
        case 'reasoning':
          if (!fullReasoning) fullReasoning = '';
          fullReasoning += event.content;
          break;
        case 'toolName':
          toolCallsBuffer.set(event.index, { name: event.name, args: '', id: '' });
          break;
        case 'toolArgument':
          const existing = toolCallsBuffer.get(event.index) || { name: '', args: '', id: '' };
          existing.args += event.arguments;
          toolCallsBuffer.set(event.index, existing);
          break;
      }
    }

    let finalToolCalls = null;
    if (toolCallsBuffer.size > 0) {
      finalToolCalls = Array.from(toolCallsBuffer.values()).map((tc, index) => ({
        id: `call_${index}_${Date.now()}`,
        type: 'function',
        function: {
          name: tc.name,
          arguments: tc.args,
        },
      }));
    }

    return { fullText, fullReasoning, finalToolCalls };
  }

  /** Check for follow-up messages with 45s timeout. */
  _checkFollowUp() {
    return new Promise((resolve) => {
      let resolved = false;

      // Wait for a follow-up message
      const handler = (message) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          resolve(message);
        }
      };

      this._followEmitter.on('follow-up', handler);

      // 45s timeout
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          resolve(null);
        }
      }, 45_000);
    });
  }
}

// ── Task Manager ────────────────────────────────────────────────────────────

/** Manages concurrent task agents: spawn, status, interrupt, follow-up. */
export class TaskManager {
  constructor(options = {}) {
    this._tasks = new Map();
    this.llmClient = options.llmClient;
    this.modelName = options.modelName || '';
    this.modelRegistry = options.modelRegistry || {};
    this.managerContext = options.managerContext;
    this.systemPrompt = options.systemPrompt;
    this.allowedTools = options.allowedTools || null;
    this.maxIterations = options.maxIterations || DEFAULT_MAX_ITERATIONS;
    this.maxToolOutputLines = options.maxToolOutputLines || 800;
    this._wakeUpCallback = null;
  }

  /** Set the wake-up callback for task completions. */
  setWakeUpCallback(callback) {
    this._wakeUpCallback = callback;
  }

  /** Spawn a new background task agent. Returns a TaskHandle. */
  spawnTask(taskId, taskDescription, workerModel = null) {
    const handle = TaskWorker.spawn({
      taskId,
      taskDescription,
      managerContext: this.managerContext,
      llmClient: this.llmClient,
      modelName: workerModel || this.modelName,
      modelRegistry: this.modelRegistry,
      allowedTools: this.allowedTools,
      systemPrompt: this.systemPrompt,
      wakeUpCallback: this._wakeUpCallback,
      maxIterations: this.maxIterations,
      maxToolOutputLines: this.maxToolOutputLines,
    });

    this._tasks.set(taskId, handle);
    return handle;
  }

  /** Check the status of a task by ID. */
  taskStatus(taskId) {
    const handle = this._tasks.get(taskId);
    if (!handle) return null;
    return handle.status;
  }

  /** Send a follow-up message to a running task. */
  sendFollowUp(taskId, message) {
    const handle = this._tasks.get(taskId);
    if (!handle) return false;
    return handle.sendFollowUp(message);
  }

  /** Interrupt (cancel) a running task. */
  interruptTask(taskId) {
    const handle = this._tasks.get(taskId);
    if (!handle) return false;
    return handle.interrupt();
  }

  /** Get all active (running) task IDs. */
  activeTasks() {
    const active = [];
    for (const [id, handle] of this._tasks) {
      if (handle.status === TASK_STATUS.RUNNING) {
        active.push(id);
      }
    }
    return active;
  }

  /** Get task counts: [active, total]. Returns null if no tasks. */
  taskCounts() {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return [active, this._tasks.size];
  }

  /** Format a progress string showing active tasks. */
  progressMessage() {
    const active = this.activeTasks().length;
    if (active === 0) return null;
    return `${active} task${active === 1 ? '' : 's'} running`;
  }
}

