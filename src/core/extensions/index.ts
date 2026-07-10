// Extension system — re-exports all extension-related modules.

export {
  ExtensionLoader,
  createExtensionLoader,
  extractSchemaDefaults,
  getExtensionConfigDefaults,
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
} from "./extensions.ts";

export { ToolRegistry, createToolRegistry } from "./tool-registry.ts";

export { ToolContext } from "./tool-context.ts";

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
} from "./tool-utils.ts";

export {
  AgentCommandRegistry,
  CliSubcommandRegistry,
  createCommandRegistry,
  createSubcommandRegistry,
} from "./registries.ts";

export { ConfigRegistry, createConfigRegistry } from "./config-registry.ts";

export { ServiceRegistry, createServiceRegistry } from "./service-registry.ts";

export { validateServiceContracts } from "./extensions.ts";
