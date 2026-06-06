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
import { DEFAULT_MAX_IMAGE_SIZE } from "./defaults.js";

// Tool descriptors — declarative table of all core tools.
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

// Tool constructor map with config — maps tool names to factory functions that accept config.
const TOOL_FACTORIES = {
  write: () => new WriteTool(),
  read: (config) =>
    new ReadTool({
      readLimit: config.readToolLimit,
      maxImageSize: DEFAULT_MAX_IMAGE_SIZE,
    }),
  edit: (config) =>
    new EditTool({
      maxEditInputSize: config.maxEditInputSize,
    }),
  grep: (config) =>
    new GrepTool({
      maxResults: config.grepMaxResults,
      maxOutputLines: config.maxToolOutputLines,
    }),
  find: (config) =>
    new FindTool({
      maxResults: config.findMaxResults,
      maxOutputLines: config.maxToolOutputLines,
    }),
  pager: () => new PagerTool(),
  explore: () => new ExploreTool(),
  project_info: () => new ProjectInfoTool(),
};

/**
 * Create a tool factory that can create and register core tools.
 *
 * @param {Object} [ctx] — Core context object with config.
 * @returns {{ createTool: Function, createAndRegister: Function }}
 */
export function createToolFactory(ctx = {}) {
  const config = ctx?.config || {};

  const createToolInternal = (toolName, whitelist = null) => {
    const descriptor = TOOL_DESCRIPTORS.find((d) => d.name === toolName);
    if (descriptor) {
      // Check disabled status
      if (descriptor.disabled && !whitelist?.includes(toolName)) {
        return null;
      }
      // Check whitelist
      if (
        whitelist &&
        Array.isArray(whitelist) &&
        !whitelist.includes(toolName)
      ) {
        return null;
      }
    }

    // Core tools — lookup from declarative map
    const factory = TOOL_FACTORIES[toolName];
    if (factory) {
      return factory(config);
    }

    return null;
  };

  return {
    createTool(toolName, ctxOrWhitelist = {}, whitelist = null) {
      // Support both old API (toolName, ctx, whitelist) and new API (toolName, whitelist)
      // If ctxOrWhitelist is an array, treat it as whitelist
      if (Array.isArray(ctxOrWhitelist)) {
        return createToolInternal(toolName, ctxOrWhitelist);
      }
      return createToolInternal(toolName, whitelist);
    },

    async createAndRegister(
      toolName,
      registry,
      ctxOrWhitelist = {},
      whitelist = null,
    ) {
      // Support both old API (toolName, registry, ctx, whitelist) and new API (toolName, registry, whitelist)
      // If ctxOrWhitelist is an array, treat it as whitelist
      let effectiveWhitelist = whitelist;
      if (Array.isArray(ctxOrWhitelist)) {
        effectiveWhitelist = ctxOrWhitelist;
      }
      const tool = this.createTool(toolName, null, effectiveWhitelist);
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
  // Config defaults come from extension.json configSchema
  const config = core.config?.coreTools || {};

  return {
    hooks: {
      /**
       * Register all core tools when requested.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        const factory = createToolFactory({ config });

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
    // Re-export defaults for tools that need them (non-configurable)
    defaults: {
      DEFAULT_MAX_IMAGE_SIZE,
    },
  };
}
