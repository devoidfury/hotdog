export {
  ExtensionLoader,
  createExtensionLoader,
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

export type { CliSubcommandRegistryLike, SubcommandDefinition } from "./registries.ts";

export { ConfigRegistry, extractSchemaDefaults } from "./config.ts";

export { ServiceRegistry, createServiceRegistry } from "./service-registry.ts";

export { validateServiceContracts } from "./extensions.ts";

// Type-only exports (stripped at runtime by Bun)
export type {
  CoreContext,
  ResolvedConfig,
  ExtensionInstance,
  ToolsRegisterPayload,
  CommandsRegisterPayload,
  HookPayloads,
  HookHandlerFor,
  HookReturnTypes,
} from "./types.ts";

export type { LoaderCore } from "./extensions.ts";

export {
  getExtensionConfig,
  getConfigSchemaProperties,
  getConfigDefault,
} from "./types.ts";
