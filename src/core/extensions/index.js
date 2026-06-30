// Extension system — re-exports all extension-related modules.

export {
  ExtensionLoader,
  createExtensionLoader,
  extractSchemaDefaults,
  getExtensionConfigDefaults,
  emitConfigRegistration,
  resolveExtensionPath,
  isExtensionDirectory,
  isExtensionEnabled,
  discoverExtensionsInDir,
  LOAD_ORDER,
  resolveLoadOrder,
  discoverExtensions,
  getExtensionConfigSchemas,
  getExtensionsToLoad,
  resolveExtensionDependencies,
  registerExtensionMetadata,
  HOOKS,
  EXTENSION_PROVIDES,
} from "./extensions.js";

export { ToolRegistry, createToolRegistry } from "./tool-registry.js";

export { ToolContext } from "./tool-context.js";

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
} from "./tool-utils.js";

export {
  CommandRegistry,
  createCommandRegistry,
  createSubcommandRegistry,
} from "./registries.js";

export { ConfigRegistry, createConfigRegistry } from "./config-registry.js";

export { ServiceRegistry, createServiceRegistry } from "./service-registry.js";

export { validateServiceContracts } from "./extensions.js";
