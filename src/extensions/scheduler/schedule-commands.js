// Schedule slash commands — /schedule, /schedule:list, /schedule:cancel

/**
 * Create the /schedule command handler.
 *
 * Usage:
 *   /schedule <delay_secs> "description"       — one-shot
 *   /schedule <delay_secs> --every <secs> "description" — recurring
 *
 * @param {Object} scheduler - The Scheduler instance
 * @returns {Object} Command definition
 */
export function createScheduleCommand(scheduler) {
  return {
    description: "Schedule a timed task (schedule <delay_secs> [--every <secs>] \"description\")",
    matches: (cmd) => cmd.startsWith("schedule") && !cmd.includes(":"),
    handler: async (_agent, cmdValue) => {
      let rest = cmdValue.slice(8).trim(); // strip "schedule"
      if (!rest) {
        return {
          content:
            "Usage:\n  /schedule <delay_secs> \"description\"           — one-shot\n  /schedule <delay_secs> --every <secs> \"description\" — recurring\n  /schedule:list                              — show active tasks\n  /schedule:cancel <task_id>                  — cancel a task",
        };
      }

      // Parse: <number> [--every <number>] "description"
      let everyMatch = rest.match(/--every\s+(\d+)/);
      const intervalSecs = everyMatch ? parseInt(everyMatch[1], 10) : 0;
      if (everyMatch) rest = rest.replace(everyMatch[0], "").trim();

      const delayMatch = rest.match(/^(\d+)/);
      if (!delayMatch) {
        return { content: "Usage: /schedule <delay_secs> [--every <secs>] \"description\"" };
      }
      const delaySecs = parseInt(delayMatch[1], 10);
      const description = rest
        .slice(delayMatch[0].length)
        .trim()
        .replace(/^["']|["']$/g, "");

      if (!description) {
        return { content: "Description is required. Usage: /schedule <delay_secs> \"description\"" };
      }

      const task = scheduler.schedule(description, delaySecs, intervalSecs);
      const label = task.repeat
        ? `every ${task.intervalSecs}s`
        : `in ${task.delaySecs}s`;
      return {
        content: `Scheduled [${task.id}]: "${description}" ${label}\nFires at: ${new Date(task.nextRun).toISOString()}`,
      };
    },
  };
}

/**
 * Create the /schedule:list command handler.
 * @param {Object} scheduler
 * @returns {Object}
 */
export function createScheduleListCommand(scheduler) {
  return {
    description: "List active scheduled tasks",
    matches: (cmd) => cmd === "schedule:list" || cmd === "schedule:ls",
    handler: async () => {
      const tasks = scheduler.list();
      if (tasks.length === 0) return { content: "No active scheduled tasks." };
      const lines = tasks.map((t) => {
        const remaining = Math.max(0, Math.round((t.nextRun - Date.now()) / 1000));
        const label = t.repeat ? `every ${t.intervalSecs}s` : `in ${remaining}s`;
        return `  ${t.id}  ${label}  "${t.description}"`;
      });
      return { content: `Active scheduled tasks:\n${lines.join("\n")}` };
    },
  };
}

/**
 * Create the /schedule:cancel command handler.
 * @param {Object} scheduler
 * @returns {Object}
 */
export function createScheduleCancelCommand(scheduler) {
  return {
    description: "Cancel a scheduled task",
    matches: (cmd) => cmd.startsWith("schedule:cancel") || cmd.startsWith("schedule:rm"),
    handler: async (_agent, cmdValue) => {
      const id = cmdValue.split(/\s+/).slice(1).join(" ").trim();
      if (!id) return { content: "Usage: /schedule:cancel <task_id>" };
      const cancelled = scheduler.cancel(id);
      return cancelled
        ? { content: `Cancelled task ${id}` }
        : { content: `Task ${id} not found` };
    },
  };
}
