/**
 * Schema loader — reads core.config.json and builds the unified config schema.
 *
 * The JSON file is the single source of truth for:
 * - Config key definitions (type, cliFlag metadata)
 * - Resolution layers (cli > config > env > provider > profile > extension > default)
 * - Default values
 *
 * String predicates and transforms in the JSON are resolved to functions
 * by the resolver at runtime.
 */

import { join } from "node:path";
import coreConfig from "../core.config.json" with { type: "json" };

// ── Built-in predicate functions ──────────────────────────────────────────

/**
 * Map of named predicate strings to their function implementations.
 * These are referenced in core.config.json layer definitions.
 */
const PREDICATE_BUILTINS = {
  /** Value is truthy (not undefined, null, false, 0, or empty string) */
  truthy: (v) => !!v,

  /** Value is falsy */
  falsy: (v) => !v,

  /** Value is not undefined */
  notUndefined: (v) => v !== undefined,

  /** Value is not null */
  notNull: (v) => v !== null,

  /** Value is not false */
  notFalse: (v) => v !== false,

  /** Value is a non-empty string (after trim) */
  nonempty: (v) => typeof v === "string" && v.trim().length > 0,

  /** Value is a non-empty array */
  nonemptyArray: (v) => Array.isArray(v) && v.length > 0,

  /** Value equals a specific value (JSON-parsed: equals:true → boolean true) */
  equals: (expected) => (v) => v === expected,

  /** Value equals a specific string (always compares as string) */
  equalsStr: (expected) => (v) => String(v) === expected,
};

// ── Built-in transform functions ──────────────────────────────────────────

/**
 * Map of named transform strings to their function implementations.
 * These are referenced in core.config.json layer definitions.
 */
const TRANSFORM_BUILTINS = {
  /** Negate a boolean value */
  negate: (v) => !v,

  /** Trim whitespace from a string */
  trim: (v) => (typeof v === "string" ? v.trim() : v),

  /** Convert to boolean (truthy/falsy) */
  toBoolean: (v) => !!v,

  /** Convert to boolean, but treat palette objects as true */
  toBooleanOrPalette: (v) => {
    if (typeof v === "object" && v !== null) {
      if (
        "thinking" in v ||
        "tool_call" in v ||
        "tool_result" in v
      ) {
        return true;
      }
    }
    return !!v;
  },
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

// ── Predicate/Transform Resolution ──────────────────────────────────────────

/**
 * Parse a predicate string and return a function.
 * Supports named builtins and parameterized forms like equals:false or equals('false').
 *
 * @param {string|Function} predicate - Predicate string or function.
 * @returns {Function|null} Predicate function or null.
 */
export function resolvePredicate(predicate) {
  if (typeof predicate === "function") return predicate;
  if (typeof predicate !== "string") return null;

  // Check for parameterized form: name('arg') or name:arg
  let name, arg;

  // Try name('arg') form first
  const parenMatch = predicate.match(/^(\w+)\('(.*)'\)$/);
  if (parenMatch) {
    [, name, arg] = parenMatch;
  } else {
    // Try name:arg form
    const colonMatch = predicate.match(/^(\w+):(.+)$/);
    if (colonMatch) {
      [, name, arg] = colonMatch;
    }
  }

  if (name && arg !== undefined) {
    const factory = PREDICATE_BUILTINS[name];
    if (factory) {
      // For equalsStr, always use raw string (no JSON parsing)
      if (name === "equalsStr") {
        return factory(arg);
      }
      // Try to parse as JSON first (handles true/false/null/numbers)
      try {
        return factory(JSON.parse(arg));
      } catch {
        // Use as string
        return factory(arg);
      }
    }
  }

  // Check for named builtin
  const builtin = PREDICATE_BUILTINS[predicate];
  if (builtin) return builtin;

  // Unknown predicate — return null (no filtering)
  return null;
}

/**
 * Parse a transform string and return a function.
 * Supports named builtins.
 *
 * @param {string|Function} transform - Transform string or function.
 * @returns {Function|null} Transform function or null.
 */
export function resolveTransform(transform) {
  if (typeof transform === "function") return transform;
  if (typeof transform !== "string") return null;

  const builtin = TRANSFORM_BUILTINS[transform];
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
  return coreConfig.keys;
}

/**
 * Convert a raw JSON schema entry to a runtime-ready schema entry.
 * Resolves string predicates and transforms to functions.
 * Preserves function defaults.
 *
 * @param {object} rawKey - A key entry from core.config.json.
 * @returns {object} Runtime-ready schema entry with resolved predicates/transforms.
 */
export function compileSchemaKey(rawKey) {
  const { layers, ...rest } = rawKey;

  const compiledLayers = layers.map((layer) => {
    const compiled = { ...layer };

    // Resolve predicate string to function
    if (typeof compiled.predicate === "string") {
      compiled.predicate = resolvePredicate(compiled.predicate);
    }

    // Resolve transform string to function
    if (typeof compiled.transform === "string") {
      compiled.transform = resolveTransform(compiled.transform);
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

    // Handle noLog special transforms
    if (layer.source === "env" && layer.key === "OA_AGENT_LOG") {
      compiled.transform = () => false;
    }
    if (layer.source === "env" && layer.key === "OA_AGENT_NO_LOG") {
      compiled.transform = () => true;
    }

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
        i === 0
          ? part
          : part.charAt(0).toUpperCase() + part.slice(1),
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
