// Core module — the minimal foundation for the extension architecture.

export * from "./hooks.js";

// Extension system
export {
  ExtensionLoader,
  createExtensionLoader,
  extractSchemaDefaults,
  extensionNameToConfigKey,
  getExtensionConfigDefaults,
  emitConfigRegistration,
  registerExtensionMetadata,
  HOOKS,
  EXTENSION_PROVIDES,
} from "./extensions/extensions.js";

export {
  ToolRegistry,
  createToolRegistry,
} from "./extensions/tool-registry.js";

export {
  ToolContext,
} from "./extensions/tool-context.js";

export {
  ToolResult,
  toolDef,
  param,
  parseToolArgs,
  toolResult,
  xmlEscape,
  truncateOutput,
  parseToolInput,
  defaultCallDisplay,
  generateDiff,
  writeFileWithParents,
  validateCwdBoundary,
  resolvePath,
  resolvePathAndValidate,
  fileSize,
  checkWritable,
  checkReadable,
  getRequiredStr,
  runCommand,
} from "./extensions/tool-utils.js";

export {
  CommandRegistry,
  createSlashCommandRegistry,
  createSubcommandRegistry,
} from "./extensions/registries.js";

export {
  ConfigRegistry,
  createConfigRegistry,
} from "./extensions/config-registry.js";

export * from "./agent.js";
export * from "./session/index.js";

// Session components
export * from "./session/agent-sink.js";
export * from "./session/task-manager.js";
export * from "./session/message-bus.js";
