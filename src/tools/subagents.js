// Subagent tools — manager agent tools for task delegation.
//
// These tools are only enabled when the profile has `manager: true`.
// They provide task delegation, status checking, follow-up, and interruption.

import { toolDef, param, parseToolArgs, toolResult } from "./registry.js";
import { getVisibleWorkerProfiles } from "../config.js";

// ── delegate_task ───────────────────────────────────────────────────────────

/** Spawn a background task agent to perform work. */
export class DelegateTaskTool {
  constructor(taskManager) {
    this._taskManager = taskManager;
  }

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id || !args.description) {
      return toolResult("Error: task_id and description are required");
    }

    const tm = this._taskManager;
    if (!tm) {
      return toolResult("Error: Task manager not available");
    }

    const handle = tm.spawnTask(
      args.task_id,
      args.description,
      args.worker_model || null,
      args.profile || null,
    );
    return toolResult(
      `Task ${args.task_id} delegated (handle: ${handle.taskId})`,
    );
  }

  toToolDef() {
    // Build dynamic list of visible worker profiles
    const config = this._taskManager?._config;
    const visibleProfiles = config ? getVisibleWorkerProfiles(config) : [];
    const profileList =
      visibleProfiles.length > 0
        ? `\n\nAvailable worker profiles (visible-worker: true): ${visibleProfiles.join(", ")}.`
        : "";

    return toolDef(
      "delegate_task",
      `Spawn a background task agent to perform work. The task runs concurrently and its result is appended to the manager\'s context when complete. IMPORTANT: Task agents are expensive — only delegate substantial autonomous work (build features, fix bugs, implement plans, audit code). Do NOT delegate trivial operations like creating a single file, running a command, or reading a file — do those directly with your tools. Batch related changes into a single task.${profileList}`,
      {
        properties: {
          task_id: param("string", "Unique identifier for this task"),
          description: param(
            "string",
            "Description of what the task agent should do",
          ),
          worker_model: param(
            "string",
            "Optional model name for the worker agent (e.g. 'ai365/qwen3.5-4b'). If omitted, uses the manager's model.",
          ),
          profile: param(
            "string",
            `Optional profile name to customize the worker agent\'s behavior (role, tools, model). Defaults to \'task-default\'.${visibleProfiles.length > 0 ? ` Available profiles: ${visibleProfiles.join(", ")}.` : ""}`,
          ),
        },
        required: ["task_id", "description"],
      },
    );
  }

  callDisplay(input) {
    const args = parseToolArgs(input);
    const display = (args.description || "...").slice(0, 40);
    return `delegate_task(${args.task_id || "?"} -> ${display})`;
  }
}

// ── task_status ─────────────────────────────────────────────────────────────

/** Check the status of a specific running task agent. */
export class TaskStatusTool {
  constructor(taskManager) {
    this._taskManager = taskManager;
  }

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id) {
      return toolResult("Error: task_id is required");
    }

    const tm = this._taskManager;
    if (!tm) {
      return toolResult("Error: Task manager not available");
    }

    const status = tm.taskStatus(args.task_id);
    if (status === null) {
      return toolResult(`Task ${args.task_id} not found`);
    }
    return toolResult(`Task ${args.task_id}: ${status}`);
  }

  toToolDef() {
    return toolDef(
      "task_status",
      "[DO NOT USE for polling] Check the status of a specific running task agent. WARNING: Do NOT use this tool to poll for task progress after delegation. Tasks notify you automatically when complete via system messages. Only call this when the user explicitly asks you to check the status of a specific task.",
      {
        properties: {
          task_id: param("string", "The task ID to check"),
        },
        required: ["task_id"],
      },
    );
  }

  callDisplay(input) {
    const args = parseToolArgs(input);
    return `task_status(${args.task_id || "?"})`;
  }
}

// ── task_followup ───────────────────────────────────────────────────────────

/** Send a follow-up message to a running task agent. */
export class TaskFollowupTool {
  constructor(taskManager) {
    this._taskManager = taskManager;
  }

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id || !args.message) {
      return toolResult("Error: task_id and message are required");
    }

    const tm = this._taskManager;
    if (!tm) {
      return toolResult("Error: Task manager not available");
    }

    const ok = tm.sendFollowUp(args.task_id, args.message);
    if (ok) {
      return toolResult(`Follow-up sent to task ${args.task_id}`);
    }
    return toolResult(`Failed to send follow-up to task ${args.task_id}`);
  }

  toToolDef() {
    return toolDef(
      "task_followup",
      "Send a follow-up message to a running task agent. WARNING: Do NOT use this to check on task progress. Tasks are autonomous and will notify you when complete. Only use this to send additional instructions or clarifications to a running task.",
      {
        properties: {
          task_id: param("string", "The task ID to send a follow-up to"),
          message: param("string", "The follow-up message to send"),
        },
        required: ["task_id", "message"],
      },
    );
  }

  callDisplay(input) {
    const args = parseToolArgs(input);
    const display = (args.message || "...").slice(0, 40);
    return `task_followup(${args.task_id || "?"} -> ${display})`;
  }
}

// ── task_interrupt ──────────────────────────────────────────────────────────

/** Interrupt (cancel) a running task agent. */
export class TaskInterruptTool {
  constructor(taskManager) {
    this._taskManager = taskManager;
  }

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id) {
      return toolResult("Error: task_id is required");
    }

    const tm = this._taskManager;
    if (!tm) {
      return toolResult("Error: Task manager not available");
    }

    const ok = tm.interruptTask(args.task_id);
    if (ok) {
      return toolResult(`Task ${args.task_id} interrupted`);
    }
    return toolResult(`Failed to interrupt task ${args.task_id}`);
  }

  toToolDef() {
    return toolDef(
      "task_interrupt",
      "Interrupt (cancel) a running task agent. The task will stop and its status will be set to Cancelled. WARNING: Do NOT use this to check status. Only use this to cancel a task that is no longer needed.",
      {
        properties: {
          task_id: param("string", "The task ID to interrupt"),
        },
        required: ["task_id"],
      },
    );
  }

  callDisplay(input) {
    const args = parseToolArgs(input);
    return `task_interrupt(${args.task_id || "?"})`;
  }
}

// ── plan_status ─────────────────────────────────────────────────────────────

/** Check the status of task agents. Shows all active tasks or the status of a specific task. */
export class PlanStatusTool {
  constructor(taskManager) {
    this._taskManager = taskManager;
  }

  async execute(input) {
    const args = parseToolArgs(input);

    const tm = this._taskManager;
    if (!tm) {
      return toolResult("Error: Task manager not available");
    }

    if (args.task_id) {
      const status = tm.taskStatus(args.task_id);
      if (status === null) {
        return toolResult(`Task ${args.task_id} not found`);
      }
      return toolResult(`Task ${args.task_id}: ${status}`);
    }

    const active = tm.activeTasks();
    if (active.length === 0) {
      return toolResult("No active tasks");
    }

    const lines = ["Active tasks:"];
    for (const taskId of active) {
      const status = tm.taskStatus(taskId);
      lines.push(`  ${taskId} — ${status}`);
    }
    return toolResult(lines.join("\n"));
  }

  toToolDef() {
    return toolDef(
      "plan_status",
      "[DO NOT USE for polling] Check the status of task agents. Shows all active tasks or the status of a specific task. WARNING: Do NOT use this tool to poll for task progress after delegation. Tasks notify you automatically when complete. Only call this when the user explicitly asks you to check status.",
      {
        properties: {
          task_id: param(
            "string",
            "Optional task ID to check status of. If omitted, shows all active tasks.",
          ),
        },
        required: [],
      },
    );
  }

  callDisplay(input) {
    const args = parseToolArgs(input);
    return `plan_status(task=${args.task_id || "all"})`;
  }
}

// ── complete_task ───────────────────────────────────────────────────────────

/** Mark a task as complete. The task agent\'s result is already appended to the manager\'s context. */
export class CompleteTaskTool {
  constructor(taskManager) {
    this._taskManager = taskManager;
  }

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id) {
      return toolResult("Error: task_id is required");
    }

    const tm = this._taskManager;
    if (!tm) {
      return toolResult("Error: Task manager not available");
    }

    return toolResult(`Task ${args.task_id} marked as complete`);
  }

  toToolDef() {
    return toolDef(
      "complete_task",
      "Mark a task as complete. The task agent's result is already appended to the manager's context.",
      {
        properties: {
          task_id: param("string", "The task ID to mark as complete"),
        },
        required: ["task_id"],
      },
    );
  }

  callDisplay(input) {
    const args = parseToolArgs(input);
    return `complete_task(${args.task_id || "?"})`;
  }
}

// ── wait ────────────────────────────────────────────────────────────────────

/** Wait for user input — signal that the manager has nothing more to do. */
export class WaitTool {
  static TOOL_NAME = "wait";

  constructor(taskManager) {
    this._taskManager = taskManager;
  }

  async execute(input) {
    const args = parseToolArgs(input);
    const message = args.message || null;
    const note = message ? ` Note: ${message}` : "";
    return toolResult(
      `Manager has nothing more to do. Waiting for user input.${note}`,
    );
  }

  toToolDef() {
    return toolDef(
      "wait",
      "Signal that you have nothing more to do and are yielding control back to the user. Call this when all work is complete and you are done.",
      {
        properties: {
          message: param(
            "string",
            'Optional brief note about why you are waiting (e.g. "All tasks complete").',
          ),
        },
        required: [],
      },
    );
  }

  callDisplay(input) {
    const args = parseToolArgs(input);
    const message = args.message || "";
    return `wait(${message || "no-op"})`;
  }
}
