// Tools module — exports all tools and the tool registry.

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

// Import LSP tool definitions from the LSP extension (single source of truth)
import { LSP_TOOL_NAMES, LSP_TOOL_MAP } from "../lsp/index.js";

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
import {
  LspHoverTool,
  LspDefinitionTool,
  LspCompletionTool,
  LspSignatureTool,
  LspDocumentSymbolTool,
  LspReferencesTool,
  LspCodeActionTool,
  LspFormattingTool,
  LspRenameTool,
  LspDiagnosticsTool,
  LspWorkspaceSymbolTool,
  LspApplyEditTool,
} from "../lsp/index.js";
import { isLspEnabled } from "../lsp/index.js";

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

// Combined tool list (core + LSP)
export const ALL_TOOL_NAMES = [...CORE_TOOL_NAMES, ...LSP_TOOL_NAMES];

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

/**
 * Resolve language ID from a file path.
 * Re-exported from extensions/lsp/utils for internal use.
 */
import { getLanguageId as _getLanguageId } from "../lsp/index.js";

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
 * Create an LSP tool instance with proper client setup.
 */
function createLspInstance(toolName, ctx, lspConfig) {
  const ToolClass = LSP_TOOL_MAP[toolName];
  if (!ToolClass) return null;

  // Determine language ID from context
  let languageId = null;
  const currentFile = ctx?.get('currentFile');
  if (currentFile) {
    languageId = _getLanguageId(currentFile);
  }

  return new ToolClass({
    languageId,
    lspConfig,
  });
}

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

  const createToolInternal = (toolName, ctx, whitelist = null, managerToolsEnabled = false) => {
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

    // LSP tools — only when enabled
    if (LSP_TOOL_MAP[toolName]) {
      // Get LSP config from ctx or profile
      const lspConfig = ctx?.lspConfig || null;
      if (isLspEnabled(lspConfig)) {
        return createLspInstance(toolName, ctx, lspConfig);
      }
      // LSP tools are optional — don't create if not enabled
      return null;
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

/**
 * Register all LSP tools with a registry when LSP is enabled.
 *
 * Factory method that creates and registers all 12 LSP tools.
 * Returns the number of tools registered (0 if LSP is disabled or no server configured).
 *
 * @param {ToolRegistry} registry - The tool registry to register tools with
 * @param {ToolContext} ctx - Tool context (provides lspConfig, currentFile, etc.)
 * @returns {Promise<number>} Number of tools registered
 */
export async function registerLspTools(registry, ctx) {
  const lspConfig = ctx?.get('lspConfig') || null;
  if (!isLspEnabled(lspConfig)) {
    return 0;
  }

  const currentFile = ctx?.get('currentFile');
  const languageId = currentFile ? _getLanguageId(currentFile) : null;
  let registered = 0;

  for (const toolName of LSP_TOOL_NAMES) {
    const tool = createLspInstance(toolName, ctx, lspConfig);
    if (tool) {
      registry.register(toolName, tool);
      registered++;
    }
  }

  return registered;
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
    ALL_TOOL_NAMES,
  };
}
