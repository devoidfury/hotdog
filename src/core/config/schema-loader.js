/**
 * Schema loader — reads core.config.json and builds the unified config schema.
 *
 * The JSON file is the single source of truth for:
 * - Config key definitions (type, cliFlag metadata)
 * - Resolution layers (cli > config > env > provider > profile > extension > default)
 * - Default values
 */

import { join } from "node:path";
import { getNested } from "../../utils/objects.js";
import configSchema from "../core.config.json" with { type: "json" };
import { camelCase } from "../../utils/strings.js";

/**
 * Map of named cast strings to their function implementations.
 * These are referenced in core.config.json layer definitions.
 *
 * A cast function receives a raw value and either:
 * - Returns a converted value (accepts this layer)
 * - Returns `undefined` (skip to next layer)
 */
const CAST_BUILTINS = {
  /**
   * Cast to boolean. Accepts: boolean, "true"/"on"/"1", "false"/"off"/"0".
   * Returns the boolean value. Returns undefined for unrecognizable input.
   */
  truthy: (v) => {
    if (typeof v === "boolean") return v;
    if (typeof v === "number") return v !== 0;
    if (typeof v !== "string") return undefined;
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "on" || s === "1") return true;
    if (s === "false" || s === "off" || s === "0") return false;
    return undefined;
  },

  /**
   * Like truthy, but negates the result.
   * "true"/"on"/"1" -> false, "false"/"off"/"0" -> true.
   */
  falsy: (v) => {
    const result = CAST_BUILTINS.truthy(v);
    if (result === undefined) return undefined;
    return !result;
  },

  /**
   * Cast to number. Accepts numeric strings and numbers.
   * Returns undefined for non-numeric strings.
   */
  number: (v) => {
    if (typeof v === "number") return v;
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number(v.trim());
      if (!isNaN(n)) return n;
    }
    return undefined;
  },

  /**
   * Cast to non-empty string (trimmed). Returns undefined for empty/whitespace.
   */
  string: (v) => {
    if (typeof v === "string") {
      const trimmed = v.trim();
      return trimmed.length > 0 ? trimmed : undefined;
    }
    return undefined;
  },

  /**
   * Accept any value as-is (never skips).
   */
  any: (v) => v,

  /**
   * Accept arrays.
   */
  array: (v) => (Array.isArray(v) ? v : undefined),
};

/**
 * Map of compute function names to their implementations.
 * These are used for computed defaults like joinConfigDir('skills').
 */
const COMPUTE_BUILTINS = {
  /**
   * Join a sub-path to the config directory.
   * Falls back to CWD-relative path if no configDir is available.
   *
   * @param {string} subPath - Sub-path to join (e.g., 'skills', 'prompts')
   * @param {object} ctx - Resolution context
   * @returns {string}
   */
  joinConfigDir: (subPath, ctx) => {
    if (ctx.configDir) {
      return join(ctx.configDir, subPath);
    }
    // Fallback paths for when configDir is not available
    const fallbacks = {
      skills: "/skills",
      prompts: "./config/prompts",
      profiles: "./config/profiles",
    };
    return fallbacks[subPath] || join("./config", subPath);
  },
};

/**
 * Parse a cast string and return a function.
 *
 * @param {string} cast - Cast name (e.g. "truthy", "falsy", "number", "string", "any").
 * @returns {Function|null} Cast function or null.
 */
export function resolveCast(cast) {
  if (typeof cast === "function") return cast;
  if (typeof cast !== "string") return null;

  const builtin = CAST_BUILTINS[cast];
  return builtin || null;
}

/**
 * Parse a compute string and return a function.
 * Supports named builtins with parameters like joinConfigDir('skills') or joinConfigDir:skills.
 *
 * @param {string} compute - Compute expression string.
 * @returns {Function|null} Compute function or null.
 */
export function resolveCompute(compute) {
  if (typeof compute !== "string") return null;

  let name, arg;

  // Try name('arg') form first
  const parenMatch = compute.match(/^(\w+)\('(.*)'\)$/);
  if (parenMatch) {
    [, name, arg] = parenMatch;
  } else {
    // Try name:arg form
    const colonMatch = compute.match(/^(\w+):(.+)$/);
    if (colonMatch) {
      [, name, arg] = colonMatch;
    }
  }

  if (name && arg !== undefined) {
    const fn = COMPUTE_BUILTINS[name];
    if (fn) {
      // Try to parse JSON for the argument
      try {
        const parsed = JSON.parse(arg);
        return (ctx) => fn(parsed, ctx);
      } catch {
        return (ctx) => fn(arg, ctx);
      }
    }
  }

  return null;
}

/**
 * Load the core config schema from core.config.json.
 * Returns the raw keys object from the JSON file.
 *
 * @returns {object} The keys object from core.config.json.
 */
export function loadCoreSchema() {
  return configSchema;
}

/**
 * Convert a raw JSON schema entry to a runtime-ready schema entry.
 * Resolves string casts to functions.
 * Preserves function defaults.
 *
 * @param {object} rawKey - A key entry from core.config.json.
 * @returns {object} Runtime-ready schema entry with resolved casts.
 */
export function compileSchemaKey(rawKey) {
  const { layers, ...rest } = rawKey;

  const compiledLayers = layers.map((layer) => {
    const compiled = { ...layer };

    // Resolve cast string to function
    if (typeof compiled.cast === "string") {
      compiled.cast = resolveCast(compiled.cast);
    }

    // Resolve compute layer to function
    if (compiled.compute) {
      const computeFn = resolveCompute(compiled.compute);
      if (computeFn) {
        // Convert compute layer to a default layer with a function
        compiled.default = computeFn;
        delete compiled.compute;
      }
    }

    return compiled;
  });

  return { ...rest, layers: compiledLayers };
}

/**
 * Build the full CONFIG_SCHEMA from the JSON file.
 * This is the canonical CONFIG_SCHEMA export.
 *
 * @returns {object} CONFIG_SCHEMA object with all keys compiled.
 */
export function buildConfigSchema() {
  const rawKeys = loadCoreSchema();
  const schema = {};

  for (const [keyName, rawKey] of Object.entries(rawKeys)) {
    schema[keyName] = compileSchemaKey(rawKey);
  }

  return schema;
}

/**
 * Extract the default value from a schema key's layers.
 * Walks the layers and returns the first default value found.
 * For function defaults, returns the function itself (not evaluated).
 *
 * @param {object} schemaKey - A compiled schema key entry.
 * @returns {*} The default value or function.
 */
export function getLayerDefault(schemaKey) {
  if (!schemaKey || !schemaKey.layers) return undefined;

  for (const layer of schemaKey.layers) {
    if ("default" in layer) {
      return layer.default;
    }
  }
  return undefined;
}

/**
 * Load extension schemas and merge them into the unified schema.
 * Extracts `layers` from extension configSchema properties.
 *
 * @param {Array<object>} extensions - Array of extension metadata with configSchema.
 * @returns {object} Unified schema with core + extension keys.
 */
export function loadExtensionSchemas(extensions) {
  const extensionKeys = {};

  for (const ext of extensions) {
    if (!ext.configSchema) continue;

    const configKey = camelCase(ext.name);

    // If extension has layers in its configSchema properties, extract them
    if (ext.configSchema.properties) {
      for (const [propName, propSchema] of Object.entries(
        ext.configSchema.properties,
      )) {
        if (propSchema.layers) {
          extensionKeys[`${configKey}.${propName}`] = compileSchemaKey({
            type: propSchema.type,
            layers: propSchema.layers,
          });
        }
      }
    }
  }

  return extensionKeys;
}

/**
 * Build a unified schema combining core and extension schemas.
 *
 * @param {Array<object>} [extensions] - Array of extension metadata.
 * @returns {object} Unified schema object.
 */
export function buildUnifiedSchema(extensions) {
  const coreSchema = buildConfigSchema();
  const extensionSchema = extensions ? loadExtensionSchemas(extensions) : {};

  return { ...coreSchema, ...extensionSchema };
}

/**
 * Generate CLI flag definitions from the schema.
 * Returns an array of flag objects compatible with the CLI parser.
 *
 * @param {object} schema - The CONFIG_SCHEMA or a subset of it.
 * @returns {Array<object>} Array of CLI flag definitions.
 */
export function cliFlagsFromSchema(schema) {
  const flags = [];
  for (const [key, def] of Object.entries(schema)) {
    if (def.cliFlag) {
      flags.push({
        key,
        short: def.cliFlag.short || null,
        long: def.cliFlag.long,
        type: def.cliFlag.type || def.type,
        hasValue: def.cliFlag.type !== "boolean",
        description: def.cliFlag.description || "",
      });
    }
  }
  return flags;
}

/**
 * Resolve the raw value for a single layer from the context.
 * Shared between resolveKey() and traceConfigResolution().
 *
 * @param {object} layer - The layer definition.
 * @param {object} context - The resolution context.
 * @returns {*} The raw value from this layer, or undefined.
 */
export function resolveLayerValue(layer, context) {
  if ("default" in layer) {
    return typeof layer.default === "function"
      ? layer.default(context)
      : layer.default;
  }

  switch (layer.source) {
    case "cli":
      return context.cli[layer.key];
    case "config":
      return context.config[layer.key];
    case "env":
      return process.env[layer.key];
    case "provider":
      return getNested(context.provider, layer.path);
    case "providerDefault":
      if (context.provider?.models?.length && context.provider.models[0].name) {
        return context.provider.models[0].name;
      }
      return undefined;
    case "profile":
      return getNested(context.profile, layer.key || layer.path);
    case "extension":
      return getNested(context.extensions, layer.key);
    default:
      return undefined;
  }
}

/**
 * Resolve a single config key by walking its declared layers.
 *
 * @param {string} keyName - The config key name (for debugging).
 * @param {object} schema - The schema entry for this key.
 * @param {object} context - The resolution context (cli, config, provider, etc.).
 * @returns {*} The resolved value.
 */
export function resolveKey(keyName, schema, context) {
  const { layers } = schema;

  for (const layer of layers) {
    // Default layer always wins — return immediately, even if null
    if ("default" in layer) {
      return resolveLayerValue(layer, context);
    }

    const value = resolveLayerValue(layer, context);

    // Skip undefined, null, empty string before cast
    if (value === undefined || value === null || value === "") continue;

    // Apply cast — converts value or returns undefined to skip
    if (layer.cast && typeof layer.cast === "function") {
      const casted = layer.cast(value, context);
      if (casted === undefined) continue;
      return casted;
    }

    // No cast — return raw value
    return value;
  }

  // No layer matched — return undefined (should not happen if schema has a default)
  return undefined;
}

/**
 * Resolve all config keys from a schema against a context.
 *
 * @param {object} schema - The CONFIG_SCHEMA object mapping key names to schema entries.
 * @param {object} context - The resolution context.
 * @returns {object} Object with all resolved key-value pairs.
 */
export function resolveAll(schema, context) {
  const result = {};

  for (const [keyName, keySchema] of Object.entries(schema)) {
    result[keyName] = resolveKey(keyName, keySchema, context);
  }

  return result;
}

/**
 * Resolve a model name to provider/model format.
 * If the name already contains "/", it's assumed to be fully qualified.
 * Otherwise, looks up the model in the provider's models array.
 *
 * @param {string} name - Model name (may or may not include provider prefix).
 * @param {object} [provider] - Provider object with name and models array.
 * @returns {string} Fully qualified model name.
 */
export function resolveModelWithProvider(name, provider) {
  if (!name) return name;
  if (name.includes("/")) return name;
  if (provider?.models) {
    const match = provider.models.find((m) => m.name === name);
    if (match) return `${provider.name}/${name}`;
  }
  return name;
}

/**
 * Resolve model name with priority: profile → CLI → provider default → config → default.
 */
export function resolveModel(
  cliModel,
  profileModel,
  configModel,
  provider,
  defaultModel,
) {
  if (profileModel) return resolveModelWithProvider(profileModel, provider);
  if (cliModel) return resolveModelWithProvider(cliModel, provider);
  if (provider?.models?.length)
    return resolveModelWithProvider(provider.models[0].name, provider);
  if (configModel) return resolveModelWithProvider(configModel, provider);
  return defaultModel;
}

/**
 * The CONFIG_SCHEMA object — derived from core.config.json.
 * This is the canonical schema used by the resolver.
 */
export const CONFIG_SCHEMA = buildConfigSchema();
