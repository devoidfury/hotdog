// Subagents Extension
// Registers subagent tools (delegate_task, task_status, etc.) via tools:register hook.
// Tools carry metadata.managerOnly and are filtered per-request in
// Agent.getToolDefs() alongside sandbox/difficulty, so they appear and
// disappear with the active profile -- including on /profile switch.
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

import { HOOKS } from "@core/hooks.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { SUBAGENT_TOOL_NAMES, SUBAGENT_TOOL_CONSTRUCTORS } from "./subagents.ts";
import {
  CoreContext,
  ExtensionInstance,
} from "@core/extensions/types.ts";
import { TaskManager } from "@core/session/task-manager.ts";

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
  // The delegate_task tool schema is now static; the available model groups
  // and worker profiles ride the per-request delegation system-prompt chunk
  // (built from this live TaskManager), so no tool-def cache refresh is needed.
}

/** System prompt instructions on delegation. */
function buildDelegateChunk(taskManager: TaskManager | null): string {
  const groups = Object.keys(
    ((taskManager?.config as { modelGroups?: Record<string, unknown> })?.modelGroups) ?? {},
  ).sort();

  const profiles = taskManager?.profileManager
    ? taskManager.profileManager.getVisibleWorkerProfiles()
    : [];

  const parts = [
    "## Task delegation options",
  ];

  if (groups.length > 0) {
    parts.push(
      "",
      `Available model groups (spread a task across one with \`group:<name>\` in \`worker_model\`): ${groups.join(", ")}.`,
    );
  }

  if (profiles.length > 0) {
    const profileManager = taskManager?.profileManager;
    const profileLines = profiles
      .map((name) => {
        const desc = profileManager?.getProfile(name)?.description ?? "";
        return desc ? `- \`${name}\`: ${desc}` : `- \`${name}\``;
      })
      .join("\n");
    parts.push(
      "",
      `Available worker profiles (visible-worker: true; set via \`profile\`):`,
      profileLines,
    );
  }

  return parts.join("\n");
}

/**
 * Create the subagents extension.
 *
 * Always active; managerOnly filtering happens in Agent.getToolDefs(). The
 * TaskManager may be provided eagerly (tests, custom hosts) or resolved
 * lazily from the TASK_MANAGER_SERVICE at tool-use time (normal CLI flow,
 * where sessions are created after extensions load).
 */
export function create(core: CoreContext, options: SubagentOptions = {}): ExtensionInstance {
  const { taskManager, sessionCore } = options;

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
       * Delegation guidance for the manager prompt. The available model groups
       * and worker profiles (each with its description) are moved here (one
       * copy in the prompt) instead of being repeated in the delegate_task
       * tool schema per request. Resolved against the live TaskManager.
       */
      [HOOKS.SYSTEM_PROMPT_BUILD]: async ({ agent }) => {
        if (!agent?.managerProfile) return;
        const content = buildDelegateChunk(resolveTaskManager());
        return { name: "delegation", priority: 250, content };
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
