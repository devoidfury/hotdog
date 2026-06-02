// Extension system — re-exports all extension-related modules.

export {
  ExtensionLoader,
  createExtensionLoader,
  extractSchemaDefaults,
  extensionNameToConfigKey,
  getExtensionConfigDefaults,
  emitConfigRegistration,
  resolveExtensionPath,
  isExtensionDirectory,
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

export {
  ToolRegistry,
  createToolRegistry,
} from "./tool-registry.js";

export {
  ToolContext,
} from "./tool-context.js";

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
} from "./tool-utils.js";

export {
  CommandRegistry,
  createSlashCommandRegistry,
  createSubcommandRegistry,
} from "./registries.js";

export {
  ConfigRegistry,
  createConfigRegistry,
} from "./config-registry.js";
