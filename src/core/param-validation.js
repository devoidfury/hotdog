/**
 * Lightweight JSON Schema parameter validation.
 *
 * Validates tool arguments against the tool's JSON Schema before execution.
 * Catches common LLM mistakes: wrong types, missing required fields,
 * invalid enums, out-of-range numbers, strings too long/short, etc.
 *
 * Inspired by OpenViking's Tool.validate_params().
 * Handles: type, enum, minimum/maximum, minLength/maxLength, required,
 * properties, items (arrays), additionalProperties.
 */

// ── Type checking helpers ────────────────────────────────────────────────────

/**
 * Map JSON Schema type names to JavaScript type checks.
 */
const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && !Number.isNaN(v),
  integer: (v) => typeof v === "number" && Number.isInteger(v) && !Number.isNaN(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  null: (v) => v === null,
};

/**
 * Get a human-readable type name for a JavaScript value.
 */
function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ── Recursive validation ─────────────────────────────────────────────────────

/**
 * Validate a single value against a schema node.
 * Returns an array of error strings (empty if valid).
 */
function validateValue(value, schema, path) {
  const errors = [];

  if (!schema || typeof schema !== "object") return errors;

  // ── Type check ──
  if (schema.type !== undefined) {
    const checkFn = TYPE_CHECKS[schema.type];
    if (checkFn && !checkFn(value)) {
      errors.push(
        `${path || "root"}: expected ${schema.type}, got ${typeName(value)}`,
      );
      return errors; // No point checking further constraints on wrong type
    }
  }

  // ── Enum check ──
  if (schema.enum !== undefined) {
    if (!schema.enum.includes(value)) {
      errors.push(
        `${path || "root"}: value ${JSON.stringify(value)} not in enum [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}]`,
      );
    }
  }

  // ── String constraints ──
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(
        `${path || "root"}: string length ${value.length} is less than minimum ${schema.minLength}`,
      );
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(
        `${path || "root"}: string length ${value.length} exceeds maximum ${schema.maxLength}`,
      );
    }
  }

  // ── Number constraints ──
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(
        `${path || "root"}: value ${value} is less than minimum ${schema.minimum}`,
      );
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(
        `${path || "root"}: value ${value} exceeds maximum ${schema.maximum}`,
      );
    }
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) {
      errors.push(
        `${path || "root"}: value ${value} must be greater than ${schema.exclusiveMinimum}`,
      );
    }
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) {
      errors.push(
        `${path || "root"}: value ${value} must be less than ${schema.exclusiveMaximum}`,
      );
    }
  }

  // ── Object: properties + required ──
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    // Required fields
    if (schema.required && Array.isArray(schema.required)) {
      for (const field of schema.required) {
        if (!(field in value)) {
          errors.push(`${path ? `${path}.` : ""}${field}: missing required field`);
        }
      }
    }

    // Validate known properties
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          const childErrors = validateValue(value[key], propSchema, path ? `${path}.${key}` : key);
          errors.push(...childErrors);
        }
      }
    }

    // Additional properties check
    if (schema.additionalProperties === false) {
      const allowedKeys = new Set([
        ...Object.keys(schema.properties || {}),
        ...schema.required || [],
      ]);
      for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
          errors.push(`${path ? `${path}.` : ""}${key}: additional property not allowed`);
        }
      }
    }
  }

  // ── Array: items ──
  if (Array.isArray(value)) {
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = validateValue(value[i], schema.items, `${path ? `${path}[` : "["}${i}]`);
        errors.push(...itemErrors);
      }
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(
        `${path || "root"}: array length ${value.length} is less than minimum ${schema.minItems}`,
      );
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(
        `${path || "root"}: array length ${value.length} exceeds maximum ${schema.maxItems}`,
      );
    }
  }

  return errors;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Validate tool arguments against a JSON Schema.
 *
 * @param {object} args - Parsed arguments to validate
 * @param {object} schema - JSON Schema object (the "parameters" portion of a tool definition)
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateParams(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { valid: false, errors: ["Arguments must be an object"] };
  }
  if (!schema || typeof schema !== "object") {
    return { valid: true, errors: [] };
  }

  const errors = validateValue(args, schema, "");
  return { valid: errors.length === 0, errors };
}

/**
 * Format validation errors as a human-readable message.
 *
 * @param {string[]} errors - Array of error strings
 * @returns {string} Formatted error message
 */
export function formatValidationErrors(errors) {
  if (errors.length === 0) return "";
  const header = "Parameter validation failed:";
  const body = errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n");
  return `${header}\n${body}`;
}
