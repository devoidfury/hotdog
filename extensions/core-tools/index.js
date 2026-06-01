// Tools module — exports all core tools and the tool registry.
// Core tools are independent of other extensions. Subagent tools are
// registered by the subagents extension via its own HOOKS.TOOLS_REGISTER handler.
// The review tool is registered by the session-review extension.

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
  { name: "edit", disabled: false },
];

export const CORE_TOOL_NAMES = TOOL_DESCRIPTORS.map((d) => d.name);

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
  };
}
