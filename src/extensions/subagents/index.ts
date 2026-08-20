// Subagents Extension
// Registers subagent tools (delegate_task, task_status, etc.) via tools:register hook.
// Only activates for manager profiles (profile.manager: true).
//
// The TaskManager is resolved lazily: extensions load in main() BEFORE the
// SessionManager (and its TaskManager) exists, so tools look the manager up
// at use time via the "taskManager" service. UI entry points call
// registerTaskManagerService() right after SessionManager creation. The
// eager taskManager option remains for tests and custom hosts.
//
// Note: extension.json deliberately does not declare "requires" for this
// service -- validateServiceContracts() runs at extension-load time, when
// no session (and therefore no TaskManager) exists yet.

import { HOOKS } from "../../core/hooks.ts";
import { formatError } from "../../core/error.ts";
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
  WaitTool,
} from "./subagents.ts";
import {
  CoreContext,
  ExtensionInstance,
} from "../../core/extensions/types.ts";
import { TaskManager } from "../../core/index.ts";

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
  WaitTool,
};

interface SubagentOptions {
  taskManager?: TaskManager | null;
  sessionCore?: unknown;
}

/** Service name under which the owning SessionManager's TaskManager is published. */
export const TASK_MANAGER_SERVICE = "taskManager";

/**
 * Publish a SessionManager's TaskManager for lazy lookup by the subagent
 * tools. Called by UI entry points right after SessionManager creation,
 * since extensions (and their tools) are loaded before any session exists.
 * No-op when taskManager is null (e.g. flows without task support).
 */
export function registerTaskManagerService(
  core: CoreContext,
  taskManager: TaskManager | null | undefined,
): void {
  if (!taskManager) return;
  core.services.register(TASK_MANAGER_SERVICE, taskManager);
  // Tool defs may have been cached before the manager existed (e.g. by the
  // info subcommand); drop the cache so the refreshed delegate_task
  // description (worker profile list) can be built on next use.
  core.toolRegistry.clearToolDefs();
}

/**
 * Create the subagents extension.
 *
 * Active for manager profiles only. The TaskManager may be provided eagerly
 * (tests, custom hosts) or resolved lazily from the TASK_MANAGER_SERVICE
 * at tool-use time (normal CLI flow, where sessions are created after
 * extensions load).
 */
export function create(core: CoreContext, options: SubagentOptions = {}): ExtensionInstance | null {
  const { taskManager, sessionCore } = options;

  // Subagent tools only for manager profiles.
  const profile = core.config.profileDef;
  const isManager = profile?.manager === true;
  if (!isManager) {
    return null;
  }

  // Lazy fallback for the normal flow: extensions load before the
  // SessionManager builds its TaskManager.
  const taskManagerProvider = taskManager
    ? undefined
    : () =>
        core.services.has(TASK_MANAGER_SERVICE)
          ? (core.services.get(TASK_MANAGER_SERVICE) as TaskManager)
          : null;

  const resolveTaskManager = (): TaskManager | null =>
    taskManager || taskManagerProvider?.() || null;

  return {
    hooks: {
      /**
       * Mount taskManager and sessionCore on the shared context container.
       * Tools access them via toolCtx.get('taskManager') and toolCtx.get('sessionCore').
       */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx }) => {
        toolCtx.set("taskManager", resolveTaskManager());
        toolCtx.set("sessionCore", sessionCore || null);
      },

      /**
       * Register subagent tools when requested.
       * Note: call registry.register() on the payload object itself -- the
       * loader passes a ToolRegistry instance, and a detached register()
       * method would lose its `this` binding.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        for (const toolName of SUBAGENT_TOOL_NAMES) {
          try {
            const ctor = SUBAGENT_TOOL_CONSTRUCTORS[toolName];
            if (ctor) {
              const tool = ctor({
                sessionCore,
                taskManager: taskManager ?? null,
                taskManagerProvider,
              });
              registry.register(toolName, tool);
            }
          } catch (e: unknown) {
            logger.error(
              `[subagents] Failed to create tool '${toolName}': ${formatError(e)}`,
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
