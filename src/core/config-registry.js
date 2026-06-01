// Config Registry — allows extensions to register their own CLI flags
// and config parameters dynamically.
//
// Extensions register during the CONFIG_CLI_FLAGS_REGISTER and
// CONFIG_PARAMS_REGISTER hooks. The core collects these and uses
// them during CLI parsing and config resolution.
//
// Usage in an extension:
//
//   export function create(core) {
//     core.configRegistry.registerCliFlags([
//       {
//         short: '-x',
//         long: '--my-flag',
//         description: 'My extension flag',
//         type: 'string',       // 'string', 'boolean', 'number', 'array'
//         default: null,
//         parse: (value) => value,  // optional custom parser
//       },
//     ]);
//
//     core.configRegistry.registerConfigParams([
//       {
//         key: 'myExtension',
//         description: 'My extension config section',
//         defaults: {
//           enabled: true,
//           timeout: 30,
//         },
//       },
//     ]);
//
//     return { /* ... */ };
//   }

import { validate } from "./json-schema.js";

/**
 * Registry for extension-registered CLI flags and config parameters.
 */
export class ConfigRegistry {
  constructor() {
    /** @type {Array<{short: string, long: string, description: string, type: string, default: any, parse?: Function}>} */
    this._cliFlags = [];

    /** @type {Array<{key: string, description: string, defaults: Object, schema?: Object}>} */
    this._configParams = [];

    /** @type {Map<string, Object>|null} */
    this._configSchemas = null;
  }

  /**
   * Register CLI flags for this extension.
   *
   * @param {Array<Object>} flags - Array of flag definitions.
   * @param {string} flags[].short - Short flag (e.g., '-x').
   * @param {string} flags[].long - Long flag (e.g., '--my-flag').
   * @param {string} flags[].description - Help text for this flag.
   * @param {string} flags[].type - Type: 'string', 'boolean', 'number', 'array'.
   * @param {any} flags[].default - Default value when flag is not provided.
   * @param {Function} [flags[].parse] - Optional custom parser function(value) => parsedValue.
   */
  registerCliFlags(flags) {
    if (!Array.isArray(flags)) {
      throw new TypeError("flags must be an array");
    }
    for (const flag of flags) {
      if (!flag.long && !flag.short) {
        throw new Error("Each CLI flag must have a short or long form");
      }
      if (!flag.type) {
        flag.type = "string";
      }
      this._cliFlags.push(flag);
    }
  }

  /**
   * Register config parameters for this extension.
   *
   * @param {Array<Object>} params - Array of parameter definitions.
   * @param {string} params[].key - Config key (e.g., 'myExtension').
   * @param {string} params[].description - Description for help text.
   * @param {Object} params[].defaults - Default values for this config section.
   * @param {Object} [params[].schema] - Optional JSON Schema for validation.
   */
  registerConfigParams(params) {
    if (!Array.isArray(params)) {
      throw new TypeError("params must be an array");
    }
    for (const param of params) {
      if (!param.key) {
        throw new Error("Each config param must have a key");
      }
      if (!param.defaults || typeof param.defaults !== "object") {
        throw new Error(
          `Config param '${param.key}' must have a defaults object`,
        );
      }
      this._configParams.push(param);
    }
  }

  /**
   * Get all registered CLI flags.
   * @returns {Array<Object>}
   */
  getCliFlags() {
    return [...this._cliFlags];
  }

  /**
   * Get all registered config parameters.
   * @returns {Array<Object>}
   */
  getConfigParams() {
    return [...this._configParams];
  }

  /**
   * Get help text for all registered CLI flags.
   * @returns {string}
   */
  getCliHelpText() {
    const lines = [];
    for (const flag of this._cliFlags) {
      const parts = [];
      if (flag.short && flag.long) {
        parts.push(`${flag.short}, ${flag.long}`);
      } else if (flag.short) {
        parts.push(flag.short);
      } else {
        parts.push(flag.long);
      }

      if (flag.type !== "boolean") {
        parts.push(`<${flag.type === "array" ? "value,..." : "value"}>`);
      }

      const help = parts.join(" ");
      const desc = flag.description || "";
      lines.push(`  ${help.padEnd(35)} ${desc}`);
    }
    return lines.join("\n");
  }

  /**
   * Build a default config object from all registered config params.
   * @returns {Object}
   */
  buildDefaults() {
    const defaults = {};
    for (const param of this._configParams) {
      defaults[param.key] = { ...param.defaults };
    }
    return defaults;
  }

  // ── Schema Validation ──────────────────────────────────────────────────────

  /**
   * Validate a config object against a JSON Schema (draft 2020-12).
   * Uses the shared json-schema.js validator.
   *
   * @param {any} config - The config object to validate.
   * @param {Object} schema - JSON Schema (draft 2020-12) to validate against.
   * @returns {{valid: boolean, errors: string[]}} Validation result.
   */
  validateConfig(config, schema) {
    const errors = validate(config, schema, "");
    return { valid: errors.length === 0, errors };
  }

  /**
   * Register a config schema for a given key.
   *
   * @param {string} key - Config key (e.g., 'mcpServers').
   * @param {Object} schema - JSON Schema (draft 2020-12) for this config.
   */
  registerConfigSchema(key, schema) {
    if (!key || typeof key !== "string") {
      throw new TypeError("key must be a non-empty string");
    }
    if (!schema || typeof schema !== "object") {
      throw new TypeError("schema must be a non-null object");
    }
    if (!this._configSchemas) {
      this._configSchemas = new Map();
    }
    this._configSchemas.set(key, schema);
  }

  /**
   * Get the registered schema for a config key.
   * @param {string} key - Config key.
   * @returns {Object|null} Schema or null if not registered.
   */
  getConfigSchema(key) {
    if (!this._configSchemas) return null;
    return this._configSchemas.get(key) || null;
  }

  /**
   * Validate a config value using its registered schema (if any).
   * Also checks schema from config params that have a schema field.
   *
   * @param {string} key - Config key.
   * @param {any} config - Config value to validate.
   * @returns {{valid: boolean, errors: string[]}} Validation result.
   */
  validateConfigByKey(key, config) {
    // Check registered schemas first
    const schema = this.getConfigSchema(key);
    if (schema) {
      return this.validateConfig(config, schema);
    }

    // Check config params for inline schema
    for (const param of this._configParams) {
      if (param.key === key && param.schema) {
        return this.validateConfig(config, param.schema);
      }
    }

    // No schema found — consider valid by default
    return { valid: true, errors: [] };
  }
}

/**
 * Create a new ConfigRegistry instance.
 * @returns {ConfigRegistry}
 */
export function createConfigRegistry() {
  return new ConfigRegistry();
}
