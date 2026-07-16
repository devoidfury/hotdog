// Subagents Extension
// Registers subagent tools (delegate_task, task_status, etc.) via tools:register hook.
// Only activates when taskManager is provided (manager mode).

import { HOOKS } from "../../core/hooks.ts";
import { logger } from "../../core/logger.ts";
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
} from "./subagents.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
} from "../../core/extensions/types.ts";

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

interface ToolCtx {
  set(key: string, value: unknown): void;
}

interface SubagentOptions {
  taskManager?: {
    _config?: Record<string, unknown>;
    spawnTask(taskId: string, description: string, options: Record<string, unknown>): Promise<Record<string, string>>;
    taskStatus(taskId: string): string | null;
    sendFollowUp(taskId: string, message: string): boolean;
    interruptTask(taskId: string): boolean;
    activeTasks(): string[];
  } | null;
  sessionCore?: unknown;
}

/**
 * Create the subagents extension.
 */
export function create(core: CoreContext, options: SubagentOptions = {}): ExtensionInstance | null {
  const { taskManager, sessionCore } = options;
  if (!taskManager) {
    return null; // Subagent tools require taskManager
  }

  // Check if the current profile is a manager profile
  const profile = (core.config.profile as Record<string, unknown>) || {};
  const isManager = profile.manager === true;
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
        (toolCtx as { set: (key: string, value: unknown) => void }).set("taskManager", taskManager);
        (toolCtx as { set: (key: string, value: unknown) => void }).set("sessionCore", sessionCore || null);
      },

      /**
       * Register subagent tools when requested.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry: ToolsRegisterPayload & { register(name: string, tool: SubagentTool): void }) => {
        for (const toolName of SUBAGENT_TOOL_NAMES) {
          try {
            const ctor = SUBAGENT_TOOL_CONSTRUCTORS[toolName];
            if (ctor) {
              const tool = ctor({ sessionCore, taskManager });
              registry.register(toolName, tool);
            }
          } catch (e: unknown) {
            logger.error(
              `[subagents] Failed to create tool '${toolName}': ${(e as Error).message}`,
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
