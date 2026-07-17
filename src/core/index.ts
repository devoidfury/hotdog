// Core module — the minimal foundation for the extension architecture.

export * from "./hooks.ts";
export { isPromise } from "../utils/promise.ts";
export {
  logger,
  initializeLogger,
  LOG_LEVELS,
  resolveLogLevel,
  resolveLogTarget,
} from "./logger.ts";

// Extension system
export {
  ExtensionLoader,
  createExtensionLoader,
  extractSchemaDefaults,
  getExtensionConfigDefaults,
  registerExtensionMetadata,
} from "./extensions/extensions.ts";

export {
  ToolRegistry,
  createToolRegistry,
} from "./extensions/tool-registry.ts";

export { ToolContext } from "./extensions/tool-context.ts";

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
} from "./extensions/tool-utils.ts";

export {
  AgentCommandRegistry,
  CliSubcommandRegistry,
  createCommandRegistry,
  createSubcommandRegistry,
} from "./extensions/registries.ts";

export {
  ConfigRegistry,
  createConfigRegistry,
} from "./extensions/config-registry.ts";

export {
  ServiceRegistry,
  createServiceRegistry,
} from "./extensions/service-registry.ts";

export * from "./context/message-log.ts";
export * from "./agent.ts";
export * from "./commands.ts";
export * from "./command-handlers.ts";
export * from "./token-tracker.ts";
export * from "./session/index.ts";

// Session components
export * from "./session/agent-sink.ts";
export * from "./session/task-manager.ts";
export * from "./session/message-bus.ts";
