// Tools module — exports all tools and the tool registry.
// Core tools are independent of other extensions. LSP tools are registered
// by the LSP extension via its own HOOKS.TOOLS_REGISTER handler.

import { HOOKS } from "../../src/hooks.js";

export * from "./registry.js";
export * from "./bash.js";
export * from "./write.js";
export * from "./read.js";
export * from "./edit.js";
export * from "./grep.js";
export * from "./find.js";
export * from "./fetch.js";
export * from "./question.js";
export * from "./pager.js";
export * from "./model.js";

export * from "./project_info.js";
export * from "./review.js";
export * from "./explore.js";

// Import classes for factory use
import { BashTool } from "./bash.js";
import { WriteTool } from "./write.js";
import { ReadTool } from "./read.js";
import { EditTool } from "./edit.js";
import { GrepTool } from "./grep.js";
import { FindTool } from "./find.js";
import { FetchTool } from "./fetch.js";
import { QuestionTool } from "./question.js";
import { PagerTool } from "./pager.js";
import { ModelTool } from "./model.js";
import { ProjectInfoTool } from "./project_info.js";
import { ReviewTool } from "./review.js";
import { ExploreTool } from "./explore.js";

// Tool descriptors — declarative table of all core tools.
const TOOL_DESCRIPTORS = [
  { name: "bash", disabled: false },
  { name: "write", disabled: false },
  { name: "model", disabled: false },
  { name: "read", disabled: false },
  { name: "question", disabled: false },
  { name: "pager", disabled: false },
  { name: "explore", disabled: true },
  { name: "find", disabled: false },
  { name: "grep", disabled: false },
  { name: "fetch", disabled: false },
  { name: "project_info", disabled: true },
  { name: "review", disabled: false },
  { name: "edit", disabled: false },
];

export const CORE_TOOL_NAMES = TOOL_DESCRIPTORS.map((d) => d.name);

// Import subagent tools
import {
  DelegateTaskTool,
  TaskStatusTool,
  TaskFollowupTool,
  TaskInterruptTool,
  PlanStatusTool,
  CompleteTaskTool,
  WaitTool,
} from "./subagents.js";

// Subagent tool names (manager-only)
export const SUBAGENT_TOOL_NAMES = [
  "delegate_task",
  "task_status",
  "task_followup",
  "task_interrupt",
  "plan_status",
  "complete_task",
  "wait",
];

// Declarative tool constructor map — maps tool names to their constructor functions.
const TOOL_CONSTRUCTORS = {
  bash: () => new BashTool(),
  write: () => new WriteTool(),
  read: () => new ReadTool(),
  edit: () => new EditTool(),
  grep: () => new GrepTool(),
  find: () => new FindTool(),
  fetch: () => new FetchTool(),
  question: () => new QuestionTool(),
  pager: () => new PagerTool(),
  explore: () => new ExploreTool(),
  model: (ctx) => new ModelTool(ctx?.modelRegistry || {}),
  project_info: () => new ProjectInfoTool(),
  review: () => new ReviewTool(),
};

// Subagent tool constructors (manager-only)
// Accepts either { sessionCore, taskManager } or just taskManager (legacy)
const SUBAGENT_TOOL_CONSTRUCTORS = {
  delegate_task: (opts) => new DelegateTaskTool(opts),
  task_status: (opts) => new TaskStatusTool(opts),
  task_followup: (opts) => new TaskFollowupTool(opts),
  task_interrupt: (opts) => new TaskInterruptTool(opts),
  plan_status: (opts) => new PlanStatusTool(opts),
  complete_task: (tm) => new CompleteTaskTool(tm),
  wait: (tm) => new WaitTool(tm),
};

/**
 * Create a tool factory that can create and register tools.
 *
 * @param {Object} [taskManager] — TaskManager instance for subagent tools (required for subagent tools).
 * @param {Object} [sessionCore] — Session core for subagent tools.
 * @returns {{ createTool: Function, createAndRegister: Function }}
 */
export function createToolFactory(taskManager = null, sessionCore = null) {
  // When taskManager is not provided, we can only create core tools.
  // Subagent tools are rejected (they require taskManager).
  const hasTaskManager = !!taskManager;

  const createToolInternal = (
    toolName,
    ctx,
    whitelist = null,
    managerToolsEnabled = false,
  ) => {
    const descriptor = TOOL_DESCRIPTORS.find((d) => d.name === toolName);
    if (descriptor) {
      // Check disabled status
      if (
        descriptor.disabled &&
        !whitelist?.includes(toolName) &&
        !managerToolsEnabled
      ) {
        return null;
      }
      // Check whitelist
      if (whitelist && !whitelist.includes(toolName)) {
        return null;
      }
    }

    // Core tools — lookup from declarative map
    const coreCtor = TOOL_CONSTRUCTORS[toolName];
    if (coreCtor) {
      return coreCtor(ctx);
    }

    // Subagent tools (manager-only) — taskManager is required
    if (managerToolsEnabled && hasTaskManager) {
      const subCtor = SUBAGENT_TOOL_CONSTRUCTORS[toolName];
      if (subCtor) {
        return subCtor({
          sessionCore: sessionCore || ctx?.sessionCore || null,
          taskManager,
        });
      }
    }

    return null;
  };

  return {
    createTool(toolName, ctx, whitelist = null, managerToolsEnabled = false) {
      return createToolInternal(toolName, ctx, whitelist, managerToolsEnabled);
    },

    async createAndRegister(
      toolName,
      registry,
      ctx,
      whitelist = null,
      managerToolsEnabled = false,
    ) {
      const tool = this.createTool(
        toolName,
        ctx,
        whitelist,
        managerToolsEnabled,
      );
      if (tool) {
        registry.register(toolName, tool);
      }
    },
  };
}

// ── Extension Entry Point ───────────────────────────────────────────────────

/**
 * Create the core-tools extension.
 *
 * @param {Object} core - The core object.
 * @param {Object} [options] - Optional extension options.
 * @param {Object} [options.taskManager] - TaskManager instance for subagent tools.
 * @returns {Object} The extension instance.
 */
export function create(core, { taskManager } = {}) {
  return {
    hooks: {
      /**
       * Register all core tools and subagent tools when requested.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        // Register core tools (no taskManager needed)
        const factory = createToolFactory();

        for (const descriptor of TOOL_DESCRIPTORS) {
          try {
            const tool = factory.createTool(descriptor.name, core);
            if (tool) {
              registry.register(descriptor.name, tool);
            }
          } catch (e) {
            console.error(
              `[core-tools] Failed to create tool '${descriptor.name}': ${e.message}`,
            );
          }
        }

        // Register subagent tools (taskManager is required)
        if (taskManager) {
          const subagentFactory = createToolFactory(taskManager);
          for (const toolName of SUBAGENT_TOOL_NAMES) {
            const tool = subagentFactory.createTool(toolName, core, null, true);
            if (tool) {
              registry.register(toolName, tool);
            }
          }
        }
      },
    },

    // Expose for external use
    TOOL_DESCRIPTORS,
    CORE_TOOL_NAMES,
  };
}
