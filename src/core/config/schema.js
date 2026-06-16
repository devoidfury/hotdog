/**
 * Unified config schema — derived from core.config.json.
 *
 * This module re-exports the CONFIG_SCHEMA from schema-loader.js,
 * which reads and compiles the JSON schema file. The JSON file
 * (src/core/core.config.json) is the single source of truth for:
 * - Config key definitions (type, cliFlag metadata)
 * - Resolution layers (cli > config > env > provider > profile > extension > default)
 * - Default values
 */

export {
  CONFIG_SCHEMA,
  cliFlagsFromSchema,
  loadCoreSchema,
  buildConfigSchema,
  buildUnifiedSchema,
  loadExtensionSchemas,
  compileSchemaKey,
  getLayerDefault,
  resolvePredicate,
  resolveTransform,
  resolveCompute,
} from "./schema-loader.js";
