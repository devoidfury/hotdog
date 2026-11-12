import { HOOKS } from "@core/hooks.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
  getExtensionConfig,
  type ConfigKnob,
} from "@core/extensions/types.ts";
import { Tool } from "@core/extensions/tool-registry.ts";
import { INTERNAL_MAX_OUTPUT_LINES } from "@core/extensions/tool-utils.ts";

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

/**
 * The knobs the core tools are built with (B6a, design §4.1): scalar-or-reader.
 * Static scalars stay pinned forever (plain-scalar hosts: test doubles, the
 * mirrored websocket registration pins); the extension entry below passes
 * readers over the live store, so every execute reads the CURRENT generation's
 * coreTools block. Nothing reads a block captured at create()/registration
 * scope. The `enabled` loader gate is untouched (X/P1: false at boot still
 * means this extension does not exist).
 */
interface CoreToolConfig {
  readToolLimit: ConfigKnob<number>;
  maxImageSize: ConfigKnob<number>;
  maxEditInputSize: ConfigKnob<number>;
  grepMaxResults: ConfigKnob<number>;
  findMaxResults: ConfigKnob<number>;
}

const TOOL_FACTORIES: Record<string, (config: CoreToolConfig) => Tool> = {
  overwrite: () => new OverwriteTool(),
  append: () => new AppendTool(),
  // Call-level display parts (ToolMetadata.display) ride the registered
  // metadata here at the seam where this extension assembles its tools:
  // read's result is file-like text; edit's args carry a replace-edit.
  // The *Arg key names must match the tools' real schema parameters
  // (pinned against toToolDef() in tests/extensions/tools-index.test.ts).
  read: (config) => {
    const tool = new ReadTool({
      readLimit: config.readToolLimit,
      maxImageSize: config.maxImageSize,
    });
    tool.metadata = {
      ...tool.metadata,
      display: [{ kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" }],
      // The file box carries the path header; the block title bar keeps only
      // the range args (absent on a whole-file read -> no summary at all).
      headerKeys: ["offset", "limit"],
    };
    return tool;
  },
  edit: (config) => {
    const tool = new EditTool({
      maxEditInputSize: config.maxEditInputSize,
    });
    tool.metadata = {
      ...tool.metadata,
      // pathArg names the file the edit lands in: the diff part gets the same
      // GitHub path header the file parts carry (key pinned against toToolDef()).
      display: [{ kind: "diff", oldArg: "oldString", newArg: "newString", pathArg: "path" }],
      // The diff part carries the path header and shows both sides; the title
      // bar keeps only the multi-edit flag, and only when the model sent it.
      headerKeys: ["replace_all"],
    };
    return tool;
  },
  grep: (config) =>
    new GrepTool({
      maxResults: config.grepMaxResults,
      // maxToolOutputLines config key removed; internal line-shaping default
      // (the seam's maxToolResultChars char cap is the binding constraint).
      maxOutputLines: INTERNAL_MAX_OUTPUT_LINES,
    }),
  find: (config) =>
    new FindTool({
      maxResults: config.findMaxResults,
      maxOutputLines: INTERNAL_MAX_OUTPUT_LINES,
    }),
  explore: () => new ExploreTool(),
  // project_info's file-listing ceiling reuses grepMaxResults (it was the
  // shared grep cap constant; the schema-owned value plumbs through now).
  project_info: (config) => new ProjectInfoTool({ maxFiles: config.grepMaxResults }),
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

// The raw coreTools block shape (scalar fields on the store's bag).
interface RawCoreToolConfig {
  readToolLimit: number;
  maxImageSize: number;
  maxEditInputSize: number;
  grepMaxResults: number;
  findMaxResults: number;
}

export function create(core: CoreContext): ExtensionInstance {
  // Config defaults come from extension.json configSchema. B6a (§4.1): the
  // knobs reach the tools as READERS over the live block -- nothing from the
  // block is captured at create() scope, so a store publish changes the NEXT
  // execute of an already-registered tool (design §4.3 row: read/grep/find/
  // edit read the coreTools block per execute).
  const block = () => getExtensionConfig<RawCoreToolConfig>(core, "coreTools");

  return {
    hooks: {
      [HOOKS.TOOLS_REGISTER]: (registry: ToolsRegisterPayload) => {
        const factory = createToolFactory({
          readToolLimit: () => block().readToolLimit,
          maxImageSize: () => block().maxImageSize,
          maxEditInputSize: () => block().maxEditInputSize,
          grepMaxResults: () => block().grepMaxResults,
          findMaxResults: () => block().findMaxResults,
        });

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
  };
}
