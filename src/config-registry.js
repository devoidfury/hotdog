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
      throw new TypeError('flags must be an array');
    }
    for (const flag of flags) {
      if (!flag.long && !flag.short) {
        throw new Error('Each CLI flag must have a short or long form');
      }
      if (!flag.type) {
        flag.type = 'string';
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
      throw new TypeError('params must be an array');
    }
    for (const param of params) {
      if (!param.key) {
        throw new Error('Each config param must have a key');
      }
      if (!param.defaults || typeof param.defaults !== 'object') {
        throw new Error(`Config param '${param.key}' must have a defaults object`);
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

      if (flag.type !== 'boolean') {
        parts.push(`<${flag.type === 'array' ? 'value,...' : 'value'}>`);
      }

      const help = parts.join(' ');
      const desc = flag.description || '';
      lines.push(`  ${help.padEnd(35)} ${desc}`);
    }
    return lines.join('\n');
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
   * This is a lightweight inline validator — it does not use any external
   * schema validation library. It supports the most common JSON Schema
   * keywords: type, properties, required, items, additionalProperties,
   * default, enum, const, minLength, maxLength, minimum, maximum,
   * pattern, and nested objects/arrays.
   *
   * @param {any} config - The config object to validate.
   * @param {Object} schema - JSON Schema (draft 2020-12) to validate against.
   * @returns {{valid: boolean, errors: string[]}} Validation result.
   */
  validateConfig(config, schema) {
    const errors = [];
    this._validate(config, schema, errors, '');
    return { valid: errors.length === 0, errors };
  }

  /**
   * Register a config schema for a given key.
   *
   * @param {string} key - Config key (e.g., 'mcpServers').
   * @param {Object} schema - JSON Schema (draft 2020-12) for this config.
   */
  registerConfigSchema(key, schema) {
    if (!key || typeof key !== 'string') {
      throw new TypeError('key must be a non-empty string');
    }
    if (!schema || typeof schema !== 'object') {
      throw new TypeError('schema must be a non-null object');
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

  /**
   * Lightweight JSON Schema validator (draft 2020-12 subset).
   * Supports: type, properties, required, items, additionalProperties,
   * default, enum, const, minLength, maxLength, minimum, maximum, pattern.
   *
   * @param {any} value - Value to validate.
   * @param {Object} schema - JSON Schema fragment.
   * @param {string[]} errors - Error accumulator.
   * @param {string} path - Current JSON path (for error messages).
   * @private
   */
  _validate(value, schema, errors, path) {
    if (!schema || typeof schema !== 'object') return;

    // Check const
    if (schema.const !== undefined) {
      if (JSON.stringify(value) !== JSON.stringify(schema.const)) {
        errors.push(`${path || 'root'}: must be ${JSON.stringify(schema.const)}`);
      }
      return;
    }

    // Check enum
    if (schema.enum && Array.isArray(schema.enum)) {
      if (!schema.enum.some(v => JSON.stringify(v) === JSON.stringify(value))) {
        errors.push(`${path || 'root'}: must be one of ${JSON.stringify(schema.enum)}`);
      }
      return;
    }

    // Check type
    if (schema.type) {
      const actualType = Array.isArray(value) ? 'array' : typeof value;
      if (schema.type === 'integer') {
        if (!Number.isInteger(value)) {
          errors.push(`${path || 'root'}: must be integer, got ${actualType}`);
          return;
        }
      } else if (schema.type !== actualType) {
        errors.push(`${path || 'root'}: must be ${schema.type}, got ${actualType}`);
        return;
      }
    }

    // Validate number constraints
    if (typeof value === 'number') {
      if (schema.minimum !== undefined && value < schema.minimum) {
        errors.push(`${path || 'root'}: must be >= ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        errors.push(`${path || 'root'}: must be <= ${schema.maximum}`);
      }
    }

    // Validate string constraints
    if (typeof value === 'string') {
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        errors.push(`${path || 'root'}: must be at least ${schema.minLength} characters`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${path || 'root'}: must be at most ${schema.maxLength} characters`);
      }
      if (schema.pattern) {
        const regex = new RegExp(schema.pattern);
        if (!regex.test(value)) {
          errors.push(`${path || 'root'}: must match pattern "${schema.pattern}"`);
        }
      }
    }

    // Validate object properties
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      // Check required properties
      if (schema.required && Array.isArray(schema.required)) {
        for (const req of schema.required) {
          if (!(req in value)) {
            errors.push(`${path ? path + '.' : ''}${req}: required property missing`);
          }
        }
      }

      // Validate each declared property
      if (schema.properties && typeof schema.properties === 'object') {
        for (const [propName, propSchema] of Object.entries(schema.properties)) {
          if (propName in value) {
            this._validate(value[propName], propSchema, errors, path ? `${path}.${propName}` : propName);
          }
        }
      }

      // Check additionalProperties
      if (schema.additionalProperties === false) {
        const allowed = new Set([...Object.keys(schema.properties || {}), ...(schema.required || [])]);
        for (const key of Object.keys(value)) {
          if (!allowed.has(key)) {
            errors.push(`${path ? path + '.' : ''}${key}: additional property not allowed`);
          }
        }
      }
    }

    // Validate array items
    if (Array.isArray(value)) {
      if (schema.items) {
        for (let i = 0; i < value.length; i++) {
          this._validate(value[i], schema.items, errors, `${path ? path + '.' : ''}[${i}]`);
        }
      }
      if (schema.minItems !== undefined && value.length < schema.minItems) {
        errors.push(`${path || 'root'}: must have at least ${schema.minItems} items`);
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${path || 'root'}: must have at most ${schema.maxItems} items`);
      }
    }
  }
}

/**
 * Create a new ConfigRegistry instance.
 * @returns {ConfigRegistry}
 */
export function createConfigRegistry() {
  return new ConfigRegistry();
}
