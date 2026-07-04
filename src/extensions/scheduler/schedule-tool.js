// Schedule tool — allows the LLM to schedule, cancel, and list timed tasks.

import { toolDef, param } from "../../core/extensions/tool-utils.js";

/**
 * Create the schedule tool.
 *
 * @param {Object} scheduler - The Scheduler instance
 * @returns {Object} Tool with toToolDef() and execute()
 */
export function createScheduleTool(scheduler) {
  return {
    toToolDef() {
      return toolDef(
        "schedule",
        "Schedule a timed or recurring task. Tasks inject messages into the agent queue after the specified delay. Use mode='cancel' to remove a task, mode='list' to see active tasks.",
        {
          properties: {
            mode: param("string", "Action: 'schedule' to create, 'cancel' to remove, 'list' to show active tasks", {
              enum: ["schedule", "cancel", "list"],
            }),
            description: param(
              "string",
              "What the task should do. This text is enqueued as a message when the task fires. Required for mode='schedule'.",
            ),
            delay_secs: param(
              "number",
              "Seconds until first execution. Minimum 1. Required for mode='schedule'.",
            ),
            interval_secs: param(
              "number",
              "Seconds between repeat executions. Set to 0 for one-shot tasks. Optional, defaults to 0.",
            ),
            task_id: param("string", "ID of the task to cancel. Required for mode='cancel'."),
          },
          required: ["mode"],
        },
      );
    },

    async execute(input) {
      const args = typeof input === "string" ? JSON.parse(input) : input;
      const mode = args.mode;

      if (mode === "schedule") {
        if (!args.description) throw new Error("description is required for scheduling");
        if (!args.delay_secs || args.delay_secs < 1)
          throw new Error("delay_secs must be at least 1");

        const task = scheduler.schedule(
          args.description,
          args.delay_secs,
          args.interval_secs || 0,
        );
        const modeLabel = task.repeat
          ? `recurring every ${task.intervalSecs}s`
          : `one-shot in ${task.delaySecs}s`;
        return {
          task_id: task.id,
          description: task.description,
          mode: modeLabel,
          next_run: new Date(task.nextRun).toISOString(),
        };
      }

      if (mode === "cancel") {
        if (!args.task_id) throw new Error("task_id is required for cancel");
        const cancelled = scheduler.cancel(args.task_id);
        return cancelled
          ? { cancelled: true, task_id: args.task_id }
          : { cancelled: false, task_id: args.task_id, error: "Task not found" };
      }

      if (mode === "list") {
        const tasks = scheduler.list();
        if (tasks.length === 0) return "No active scheduled tasks.";
        const lines = tasks.map((t) => {
          const remaining = Math.max(0, Math.round((t.nextRun - Date.now()) / 1000));
          const label = t.repeat ? `every ${t.intervalSecs}s` : `in ${remaining}s`;
          return `  ${t.id}  ${label}  "${t.description}"`;
        });
        return `Active scheduled tasks:\n${lines.join("\n")}`;
      }

      throw new Error(`Unknown mode: ${mode}. Use 'schedule', 'cancel', or 'list'.`);
    },
  };
}
