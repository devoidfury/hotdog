/**
 * Schema loader — reads core.config.json and builds the unified config schema.
 *
 * The JSON file is the single source of truth for:
 * - Config key definitions (type, cliFlag metadata)
 * - Resolution layers (cli > config > env > provider > profile > extension > default)
 * - Default values
 *
 * String casts in the JSON are resolved to functions by the resolver at runtime.
 */

import { join } from "node:path";
import configSchema from "../core.config.json" with { type: "json" };

// ── Built-in cast functions ────────────────────────────────────────────────

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
   * Accept non-empty arrays only.
   */
  nonemptyArray: (v) => (Array.isArray(v) && v.length > 0 ? v : undefined),
};

// ── Built-in compute functions ────────────────────────────────────────────

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

// ── Cast Resolution ────────────────────────────────────────────────────────

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

// ── Schema Loading ─────────────────────────────────────────────────────────

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

    // noLog env vars use standard cast from JSON (falsy for OA_AGENT_LOG, truthy for OA_AGENT_NO_LOG)

    return compiled;
  });

  return { ...rest, layers: compiledLayers };
}

/**
 * Build the full CONFIG_SCHEMA from the JSON file.
 * This is the direct replacement for the CONFIG_SCHEMA export in schema.js.
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

    const configKey = ext.name
      .split("-")
      .map((part, i) =>
        i === 0 ? part : part.charAt(0).toUpperCase() + part.slice(1),
      )
      .join("");

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

// ── Default exports ─────────────────────────────────────────────────────────

/**
 * The CONFIG_SCHEMA object — derived from core.config.json.
 * This is the canonical schema used by the resolver.
 */
export const CONFIG_SCHEMA = buildConfigSchema();
