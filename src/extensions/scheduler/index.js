// Scheduler Extension — timed and recurring task scheduling.
//
// Schedules one-shot (delay) and recurring (interval) tasks that inject
// messages into the MessageBus when they fire. The LLM can schedule tasks
// via the `schedule` tool, and users via /schedule slash commands.
//
// Bus wiring: the interactive CLI calls scheduler.setBus(bus) after
// creating the message bus. Without a bus, scheduling throws an error.

import { HOOKS } from "../../core/hooks.js";
import { Scheduler } from "./scheduler.js";
import { createScheduleTool } from "./schedule-tool.js";
import {
  createScheduleCommand,
  createScheduleListCommand,
  createScheduleCancelCommand,
} from "./schedule-commands.js";

// Module-level reference for bus wiring by the interactive CLI.
let _schedulerInstance = null;

/**
 * Get the scheduler instance (for bus wiring by the interactive CLI).
 * @returns {Scheduler|null}
 */
export function getScheduler() {
  return _schedulerInstance;
}

/**
 * Create the scheduler extension.
 *
 * @param {Object} core - The core object with hooks, services, config.
 * @returns {Object|null} Extension instance, or null if disabled.
 */
export function create(core) {
  const config = core.config?.scheduler || {};

  const enabled = config.enabled !== false;
  if (!enabled) return null;

  const scheduler = new Scheduler({
    maxTasks: config.maxTasks || 50,
    logActivity: config.logActivity || false,
  });

  // Store module-level reference for bus wiring
  _schedulerInstance = scheduler;

  // Register as a service so other extensions can access it
  if (core.services) {
    core.services.register("scheduler", scheduler);
  }

  return {
    hooks: {
      /**
       * Register the schedule tool.
       */
      [HOOKS.TOOLS_REGISTER]: (registry) => {
        registry.register("schedule", createScheduleTool(scheduler));
      },

      /**
       * Register slash commands: /schedule, /schedule:list, /schedule:cancel
       */
      [HOOKS.COMMANDS_REGISTER]: ({ registry }) => {
        registry.register("schedule", createScheduleCommand(scheduler));
        registry.register("schedule:list", createScheduleListCommand(scheduler));
        registry.register("schedule:cancel", createScheduleCancelCommand(scheduler));
      },

      /**
       * Clean up all scheduled tasks on shutdown.
       */
      [HOOKS.SHUTDOWN_CLEANUP]: () => {
        scheduler.cleanup();
      },
    },

    // Expose for external use
    scheduler,
  };
}
