// Core module — the minimal foundation for the extension architecture.

export * from "./hooks.js";
export {
  logger,
  initializeLogger,
  LOG_LEVELS,
  resolveLogLevel,
  resolveLogTarget,
} from "./logger.js";

// Extension system
export {
  ExtensionLoader,
  createExtensionLoader,
  extractSchemaDefaults,
  getExtensionConfigDefaults,
  registerExtensionMetadata,
} from "./extensions/extensions.js";

export {
  ToolRegistry,
  createToolRegistry,
} from "./extensions/tool-registry.js";

export { ToolContext } from "./extensions/tool-context.js";

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
  getRequiredStr,
} from "./extensions/tool-utils.js";

export {
  CommandRegistry,
  createCommandRegistry,
  createSubcommandRegistry,
} from "./extensions/registries.js";

export {
  ConfigRegistry,
  createConfigRegistry,
} from "./extensions/config-registry.js";

export {
  ServiceRegistry,
  createServiceRegistry,
} from "./extensions/service-registry.js";

export * from "./context/message-log.js";
export * from "./agent.js";
export * from "./command-handlers.js";
export * from "./session/index.js";

// Session components
export * from "./session/agent-sink.js";
export * from "./session/task-manager.js";
export * from "./session/message-bus.js";
