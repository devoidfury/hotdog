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
export * from "./project-info.ts";
export * from "./explore.ts";

import { OverwriteTool } from "./overwrite.ts";
import { AppendTool } from "./append.ts";
import { ReadTool } from "./read.ts";
import { EditTool } from "./edit.ts";
import { GrepTool } from "./grep.ts";
import { FindTool } from "./find.ts";
import { ProjectInfoTool } from "./project-info.ts";
import { ExploreTool } from "./explore.ts";
import { DEFAULT_MAX_IMAGE_SIZE } from "./defaults.ts";

interface ToolDescriptor {
  name: string;
  disabled: boolean;
}

const TOOL_DESCRIPTORS: ToolDescriptor[] = [
  { name: "overwrite", disabled: false },
  { name: "append", disabled: false },
  { name: "read", disabled: false },
  // explore is disabled by default: it spawns a second LLM session, which on
  // limited local-AI hardware can unload the model and kill the cached session.
  { name: "explore", disabled: true },
  { name: "find", disabled: false },
  { name: "grep", disabled: false },
  { name: "project_info", disabled: false },
  { name: "edit", disabled: false },
];

export const CORE_TOOL_NAMES = TOOL_DESCRIPTORS.map((d) => d.name);

interface CoreToolConfig {
  readToolLimit: number;
  maxEditInputSize: number;
  grepMaxResults: number;
  findMaxResults: number;
  maxToolOutputLines: number;
}

const TOOL_FACTORIES: Record<string, (config: CoreToolConfig) => Tool> = {
  overwrite: () => new OverwriteTool(),
  append: () => new AppendTool(),
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
  explore: () => new ExploreTool(),
  project_info: () => new ProjectInfoTool(),
};

interface ToolFactory {
  createTool(toolName: string, whitelist?: string[] | null): Tool | null;
  createAndRegister(
    toolName: string,
    registry: ToolsRegisterPayload,
    whitelist?: string[] | null,
  ): void;
}

export function createToolFactory(config: CoreToolConfig): ToolFactory {
  const createTool = (
    toolName: string,
    whitelist: string[] | null = null,
  ): Tool | null => {
    const descriptor = TOOL_DESCRIPTORS.find((d) => d.name === toolName);
    if (descriptor) {
      if (descriptor.disabled && !whitelist?.includes(toolName)) {
        return null;
      }
      if (
        whitelist &&
        Array.isArray(whitelist) &&
        !whitelist.includes(toolName)
      ) {
        return null;
      }
    }

    const factory = TOOL_FACTORIES[toolName];
    if (factory) {
      return factory(config);
    }

    return null;
  };

  const createAndRegister = (
    toolName: string,
    registry: ToolsRegisterPayload,
    whitelist: string[] | null = null,
  ) => {
    const tool = createTool(toolName, whitelist);
    if (tool) {
      registry.register(toolName, tool);
    }
  };

  return { createTool, createAndRegister };
}

// ── Extension Entry Point ───────────────────────────────────────────────────

export function create(core: CoreContext): ExtensionInstance {
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig<CoreToolConfig>(core, "coreTools");

  return {
    hooks: {
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
