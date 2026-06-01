// Subagents Extension
// Registers subagent tools (delegate_task, task_status, etc.) via tools:register hook.
// Only activates when taskManager is provided (manager mode).

import { HOOKS } from "../../src/hooks.js";
import {
  SUBAGENT_TOOL_NAMES,
  SUBAGENT_TOOL_CONSTRUCTORS,
  SubagentTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskFollowupTool,
  TaskInterruptTool,
  PlanStatusTool,
  CompleteTaskTool,
  WaitTool,
} from "./subagents.js";

// Re-export for tests and external use
export {
  SUBAGENT_TOOL_NAMES,
  SUBAGENT_TOOL_CONSTRUCTORS,
  SubagentTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskFollowupTool,
  TaskInterruptTool,
  PlanStatusTool,
  CompleteTaskTool,
  WaitTool,
};

/**
 * Create the subagents extension.
 *
 * @param {Object} core - The core object with config.
 * @param {Object} [options] - Optional extension options.
 * @param {Object} [options.taskManager] - TaskManager instance (required for subagent tools).
 * @param {Object} [options.sessionCore] - Session core for subagent tools.
 * @returns {Object|null} The extension instance, or null if taskManager not provided or profile not a manager.
 */
export function create(core, { taskManager, sessionCore } = {}) {
  if (!taskManager) {
    return null; // Subagent tools require taskManager
  }

  // Check if the current profile is a manager profile
  const isManager = core.config?.profile?.manager === true;
  if (!isManager) {
    return null; // Subagent tools only for manager profiles
  }

  return {
    hooks: {
      /**
       * Mount taskManager and sessionCore on the shared context container.
       * Tools access them via toolCtx.get('taskManager') and toolCtx.get('sessionCore').
       */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx }) => {
        toolCtx.set("taskManager", taskManager);
        toolCtx.set("sessionCore", sessionCore || null);
      },

      /**
       * Register subagent tools when requested.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        for (const toolName of SUBAGENT_TOOL_NAMES) {
          try {
            const ctor = SUBAGENT_TOOL_CONSTRUCTORS[toolName];
            if (ctor) {
              const tool = ctor({ sessionCore, taskManager });
              registry.register(toolName, tool);
            }
          } catch (e) {
            console.error(
              `[subagents] Failed to create tool '${toolName}': ${e.message}`,
            );
          }
        }
      },
    },

    // Expose for external use
    SUBAGENT_TOOL_NAMES,
    SUBAGENT_TOOL_CONSTRUCTORS,
  };
}
