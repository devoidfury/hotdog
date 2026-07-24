import extensionData from "./extension.json" with { type: "json" };
import { HOOKS } from "../../core/hooks.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
  getExtensionConfig,
} from "../../core/extensions/types.ts";
import { Tool } from "../../core/extensions/tool-registry.ts";

export * from "./overwrite.ts";
export * from "./append.ts";
export * from "./read.ts";
export * from "./edit.ts";
export * from "./grep.ts";
export * from "./find.ts";
export * from "./pager.ts";
export * from "./project-info.ts";
export * from "./explore.ts";

// Import classes for factory use
import { OverwriteTool } from "./overwrite.ts";
import { AppendTool } from "./append.ts";
import { ReadTool } from "./read.ts";
import { EditTool } from "./edit.ts";
import { GrepTool } from "./grep.ts";
import { FindTool } from "./find.ts";
import { PagerTool } from "./pager.ts";
import { ProjectInfoTool } from "./project-info.ts";
import { ExploreTool } from "./explore.ts";
import { DEFAULT_MAX_IMAGE_SIZE } from "./defaults.ts";

interface ToolDescriptor {
  name: string;
  disabled: boolean;
}

// Tool descriptors — declarative table of all core tools.
const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  { name: "overwrite", disabled: false },
  { name: "append", disabled: false },
  { name: "read", disabled: false },
  { name: "pager", disabled: false },
  // explore tool is disabled by default because it invokes another sub LLM session,
  // which is not desirable in lots of default workflows. Currently hardware in
  // local ai circles is more often than not limited.
  // This can cause the model to be unloaded and lose the whole cached session
  // if the hardware is limited or the models are misconfigured, safer to default to off.
  { name: "explore", disabled: true },
  { name: "find", disabled: false },
  { name: "grep", disabled: false },
  { name: "project_info", disabled: false },
  { name: "edit", disabled: false },
];

export const CORE_TOOL_NAMES = TOOL_DESCRIPTORS.map((d) => d.name);

// Tool constructor map with config — maps tool names to factory functions that accept config.
// Config values are pre-resolved with defaults from extension.json configSchema.

interface CoreToolConfig {
  readToolLimit?: number;
  maxEditInputSize?: number;
  grepMaxResults?: number;
  findMaxResults?: number;
  maxToolOutputLines?: number;
}

const TOOL_FACTORIES: Record<string, (config: CoreToolConfig) => Tool> = {
  overwrite: () => new OverwriteTool() as Tool,
  append: () => new AppendTool() as Tool,
  read: (config) =>
    new ReadTool({
      readLimit: config.readToolLimit ?? 500,
      maxImageSize: DEFAULT_MAX_IMAGE_SIZE,
    }) as Tool,
  edit: (config) =>
    new EditTool({
      maxEditInputSize: config.maxEditInputSize ?? 16000,
    }) as Tool,
  grep: (config) =>
    new GrepTool({
      maxResults: config.grepMaxResults ?? 100,
      maxOutputLines: config.maxToolOutputLines ?? 600,
    }) as Tool,
  find: (config) =>
    new FindTool({
      maxResults: config.findMaxResults ?? 200,
      maxOutputLines: config.maxToolOutputLines ?? 600,
    }) as Tool,
  pager: () => new PagerTool() as Tool,
  explore: () => new ExploreTool() as Tool,
  project_info: () => new ProjectInfoTool() as Tool,
};

interface ToolFactory {
  createTool(toolName: string, whitelist?: string[] | null): Tool | null;
  createAndRegister(toolName: string, registry: ToolsRegisterPayload, whitelist?: string[] | null): void;
}

/**
 * Create a tool factory that can create and register core tools.
 */
export function createToolFactory(config: CoreToolConfig = {}): ToolFactory {
  const createTool = (toolName: string, whitelist: string[] | null = null): Tool | null => {
    const descriptor = TOOL_DESCRIPTORS.find((d) => d.name === toolName);
    if (descriptor) {
      // Check disabled status
      if (descriptor.disabled && !whitelist?.includes(toolName)) {
        return null;
      }
      // Check whitelist
      if (whitelist && Array.isArray(whitelist) && !whitelist.includes(toolName)) {
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

  const createAndRegister = (toolName: string, registry: ToolsRegisterPayload, whitelist: string[] | null = null) => {
    const tool = createTool(toolName, whitelist);
    if (tool) {
      registry.register(toolName, tool);
    }
  };

  return { createTool, createAndRegister };
}

// ── Extension Entry Point ───────────────────────────────────────────────────

/**
 * Create the core-tools extension.
 */
export function create(core: CoreContext): ExtensionInstance {
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig<CoreToolConfig>(core, "coreTools");

  return {
    hooks: {
      /**
       * Register all core tools when requested.
       */
      [HOOKS.TOOLS_REGISTER]: (registry: ToolsRegisterPayload) => {
        const factory = createToolFactory(config);

        for (const descriptor of TOOL_DESCRIPTORS) {
          const tool = factory.createTool(descriptor.name);
          if (tool) {
            registry.register(descriptor.name, tool);
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
