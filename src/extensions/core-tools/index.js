// Core tools are independent of other extensions.

import { HOOKS } from "../../core/hooks.js";

export * from "./write.js";
export * from "./read.js";
export * from "./edit.js";
export * from "./grep.js";
export * from "./find.js";
export * from "./pager.js";
export * from "./project-info.js";
export * from "./explore.js";

// Import classes for factory use
import { WriteTool } from "./write.js";
import { ReadTool } from "./read.js";
import { EditTool } from "./edit.js";
import { GrepTool } from "./grep.js";
import { FindTool } from "./find.js";
import { PagerTool } from "./pager.js";
import { ProjectInfoTool } from "./project-info.js";
import { ExploreTool } from "./explore.js";

// Tool descriptors — declarative table of all core tools.
// Note: bash is registered by the bash-tool extension, not here.
const TOOL_DESCRIPTORS = [
  { name: "write", disabled: false },
  { name: "read", disabled: false },
  { name: "pager", disabled: false },
  { name: "explore", disabled: true },
  { name: "find", disabled: false },
  { name: "grep", disabled: false },
  { name: "project_info", disabled: true },
  { name: "edit", disabled: false },
];

export const CORE_TOOL_NAMES = TOOL_DESCRIPTORS.map((d) => d.name);

// Declarative tool constructor map — maps tool names to their constructor functions.
// Note: bash is registered by the bash-tool extension, not here.
const TOOL_CONSTRUCTORS = {
  write: () => new WriteTool(),
  read: () => new ReadTool(),
  edit: () => new EditTool(),
  grep: () => new GrepTool(),
  find: () => new FindTool(),
  pager: () => new PagerTool(),
  explore: () => new ExploreTool(),
  project_info: () => new ProjectInfoTool(),
};

/**
 * Create a tool factory that can create and register core tools.
 *
 * @param {Object} [ctx] — Core context object.
 * @returns {{ createTool: Function, createAndRegister: Function }}
 */
export function createToolFactory(ctx = {}) {
  const createToolInternal = (toolName, whitelist = null) => {
    const descriptor = TOOL_DESCRIPTORS.find((d) => d.name === toolName);
    if (descriptor) {
      // Check disabled status
      if (descriptor.disabled && !whitelist?.includes(toolName)) {
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

    return null;
  };

  return {
    createTool(toolName, ctx, whitelist = null) {
      return createToolInternal(toolName, whitelist);
    },

    async createAndRegister(toolName, registry, whitelist = null) {
      const tool = this.createTool(toolName, whitelist);
      if (tool) {
        registry.register(toolName, tool);
      }
    },
  };
}

// ── Extension Entry Point ───────────────────────────────────────────────────

import {
  DEFAULT_MAX_TOOL_OUTPUT_LINES,
  DEFAULT_READ_TOOL_LIMIT,
  DEFAULT_FIND_MAX_RESULTS,
  DEFAULT_GREP_MAX_RESULTS,
  DEFAULT_MAX_DIFF_SIZE,
  DEFAULT_MAX_EDIT_INPUT_SIZE,
} from "./defaults.js";

/**
 * Create the core-tools extension.
 *
 * @param {Object} core - The core object.
 * @returns {Object} The extension instance.
 */
export function create(core) {
  return {
    hooks: {
      /**
       * Register all core tools when requested.
       * Subagent tools are registered by the subagents extension.
       * The review tool is registered by the session-review extension.
       * The bash tool is registered by the bash-tool extension.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        const factory = createToolFactory(core);

        for (const descriptor of TOOL_DESCRIPTORS) {
          try {
            const tool = factory.createTool(descriptor.name);
            if (tool) {
              registry.register(descriptor.name, tool);
            }
          } catch (e) {
            console.error(
              `[core-tools] Failed to create tool '${descriptor.name}': ${e.message}`,
            );
          }
        }
      },
    },

    // Expose for external use
    TOOL_DESCRIPTORS,
    CORE_TOOL_NAMES,
    // Re-export defaults for tools that need them
    defaults: {
      DEFAULT_MAX_TOOL_OUTPUT_LINES,
      DEFAULT_READ_TOOL_LIMIT,
      DEFAULT_FIND_MAX_RESULTS,
      DEFAULT_GREP_MAX_RESULTS,
      DEFAULT_MAX_DIFF_SIZE,
      DEFAULT_MAX_EDIT_INPUT_SIZE,
    },
  };
}
