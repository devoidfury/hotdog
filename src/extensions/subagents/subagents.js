// Subagent tools — manager agent tools for task delegation.
//
// These tools are only enabled when the profile has `manager: true`.
// They provide task delegation, status checking, follow-up, and interruption.

import {
  toolDef,
  param,
  parseToolArgs,
  ToolResult,
  defaultCallDisplay,
} from "../../core/extensions/tool-utils.js";
import { getVisibleWorkerProfiles } from "../../core/config/profiles.js";

// ── Base class for subagent tools ──────────────────────────────────────────

/**
 * Base class for all subagent tools.
 * Accepts an options object with sessionCore and/or taskManager.
 */
export class SubagentTool {
  constructor(options) {
    if (typeof options === "object" && options !== null) {
      this._sessionCore = options.sessionCore || null;
      this._taskManager = options.taskManager || null;
    } else {
      this._sessionCore = null;
      this._taskManager = null;
    }
  }

  /**
   * Resolve the task management backend.
   * Returns { type: 'sessionCore', value } or { type: 'taskManager', value }.
   */
  _resolveBackend() {
    if (this._sessionCore) {
      return { type: "sessionCore", value: this._sessionCore };
    }
    if (this._taskManager) {
      return { type: "taskManager", value: this._taskManager };
    }
    return { type: "none", value: null };
  }

  /**
   * Check if a backend is available. Subclasses can call this to guard execute().
   * Returns a ToolResult error string when no backend, or the backend object otherwise.
   */
  _ensureBackend() {
    const backend = this._resolveBackend();
    if (backend.type === "none") {
      return "Error: Task manager not available";
    }
    return backend;
  }

  /**
   * Default callDisplay: parse args and show tool name with task_id.
   * Override in subclasses for custom display.
   */
  callDisplay(input) {
    return defaultCallDisplay(
      input,
      (args) => `${this.constructor.name}(${args?.task_id || "?"})`,
    );
  }
}

// ── delegate_task ───────────────────────────────────────────────────────────

/** Spawn a background task agent to perform work. */
export class DelegateTaskTool extends SubagentTool {
  static TOOL_NAME = "delegate_task";

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id || !args.description) {
      return ToolResult.err("Error: task_id and description are required");
    }

    const backend = this._ensureBackend();
    if (typeof backend === "string") return ToolResult.err(backend);

    const handle = await backend.value.spawnTask(
      args.task_id,
      args.description,
      {
        workerModel: args.worker_model || null,
        profile: args.profile || null,
      },
    );
    return ToolResult.ok(
      `Task ${args.task_id} delegated (handle: ${handle.taskId})`,
    ).withEntries({
      task_id: args.task_id,
      handle: handle.taskId,
    });
  }

  toToolDef() {
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
            `Optional profile name to customize the worker agent\'s behavior (role, tools, model). Defaults to 'task-default'.${visibleProfiles.length > 0 ? ` Available profiles: ${visibleProfiles.join(", ")}.` : ""}`,
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
export class TaskStatusTool extends SubagentTool {
  static TOOL_NAME = "task_status";

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id) {
      return ToolResult.err("Error: task_id is required");
    }

    const backend = this._ensureBackend();
    if (typeof backend === "string") return ToolResult.err(backend);

    const status = backend.value.taskOrchestrator.taskStatus(args.task_id);

    if (status === null) {
      return ToolResult.err(`Task ${args.task_id} not found`);
    }
    return ToolResult.ok(`Task ${args.task_id}: ${status}`).withEntries({
      task_id: args.task_id,
      status,
    });
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
export class TaskFollowupTool extends SubagentTool {
  static TOOL_NAME = "task_followup";

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id || !args.message) {
      return ToolResult.err("Error: task_id and message are required");
    }

    const backend = this._ensureBackend();
    if (typeof backend === "string") return ToolResult.err(backend);

    const ok = backend.value.taskOrchestrator.followUp(
      args.task_id,
      args.message,
    );

    if (ok) {
      return ToolResult.ok(`Follow-up sent to task ${args.task_id}`).withEntry(
        "task_id",
        args.task_id,
      );
    }
    return ToolResult.err(`Failed to send follow-up to task ${args.task_id}`);
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
export class TaskInterruptTool extends SubagentTool {
  static TOOL_NAME = "task_interrupt";

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id) {
      return ToolResult.err("Error: task_id is required");
    }

    const backend = this._ensureBackend();
    if (typeof backend === "string") return ToolResult.err(backend);

    const ok = backend.value.taskOrchestrator.interrupt(args.task_id);

    if (ok) {
      return ToolResult.ok(`Task ${args.task_id} interrupted`).withEntry(
        "task_id",
        args.task_id,
      );
    }
    return ToolResult.err(`Failed to interrupt task ${args.task_id}`);
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
export class PlanStatusTool extends SubagentTool {
  static TOOL_NAME = "plan_status";

  async execute(input) {
    const args = parseToolArgs(input);

    const backend = this._ensureBackend();
    if (typeof backend === "string") return ToolResult.err(backend);

    if (args.task_id) {
      const status = backend.value.taskOrchestrator.taskStatus(args.task_id);
      if (status === null) {
        return ToolResult.err(`Task ${args.task_id} not found`);
      }
      return ToolResult.ok(`Task ${args.task_id}: ${status}`).withEntries({
        task_id: args.task_id,
        status,
      });
    }

    const active = backend.value.taskOrchestrator.activeTasks();

    if (active.length === 0) {
      return ToolResult.ok("No active tasks").withEntry(
        "active_task_count",
        "0",
      );
    }

    const lines = ["Active tasks:"];
    for (const taskId of active) {
      const status = backend.value.taskOrchestrator.taskStatus(taskId);
      lines.push(`  ${taskId} — ${status}`);
    }
    return ToolResult.ok(lines.join("\n")).withEntry(
      "active_task_count",
      String(active.length),
    );
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
export class CompleteTaskTool extends SubagentTool {
  static TOOL_NAME = "complete_task";

  async execute(input) {
    const args = parseToolArgs(input);
    if (!args.task_id) {
      return ToolResult.err("Error: task_id is required");
    }

    return ToolResult.ok(`Task ${args.task_id} marked as complete`).withEntry(
      "task_id",
      args.task_id,
    );
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
export class WaitTool extends SubagentTool {
  static TOOL_NAME = "wait";

  async execute(input) {
    const args = parseToolArgs(input);
    const message = args.message || null;
    const note = message ? ` Note: ${message}` : "";
    return ToolResult.ok(
      `Manager has nothing more to do. Waiting for user input.${note}`,
    ).withEntries({
      ...(message ? { message } : {}),
    });
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

// ── Subagent tool names and constructors ────────────────────────────────────

/** Subagent tool names (manager-only) */
export const SUBAGENT_TOOL_NAMES = [
  "delegate_task",
  "task_status",
  "task_followup",
  "task_interrupt",
  "plan_status",
  "complete_task",
  "wait",
];

// Subagent tool constructors (manager-only)
export const SUBAGENT_TOOL_CONSTRUCTORS = {
  delegate_task: (opts) => new DelegateTaskTool(opts),
  task_status: (opts) => new TaskStatusTool(opts),
  task_followup: (opts) => new TaskFollowupTool(opts),
  task_interrupt: (opts) => new TaskInterruptTool(opts),
  plan_status: (opts) => new PlanStatusTool(opts),
  complete_task: (opts) => new CompleteTaskTool(opts),
  wait: (opts) => new WaitTool(opts),
};
