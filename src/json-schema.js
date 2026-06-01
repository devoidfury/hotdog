/**
 * Lightweight JSON Schema (draft 2020-12) validation.
 *
 * Standalone, reusable validator supporting: type, enum, const,
 * minLength/maxLength, minimum/maximum, exclusiveMinimum/maximum,
 * required, properties, additionalProperties, items (arrays),
 * minItems/maxItems, pattern (regex), and default (skip validation).
 */

// ── Type checking helpers ────────────────────────────────────────────────────

/**
 * Map JSON Schema type names to JavaScript type checks.
 */
const TYPE_CHECKS = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && !Number.isNaN(v),
  integer: (v) =>
    typeof v === "number" && Number.isInteger(v) && !Number.isNaN(v),
  boolean: (v) => typeof v === "boolean",
  array: (v) => Array.isArray(v),
  object: (v) => typeof v === "object" && v !== null && !Array.isArray(v),
  null: (v) => v === null,
};

/**
 * Get a human-readable type name for a JavaScript value.
 */
export function typeName(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ── Default matching ─────────────────────────────────────────────────────────

/**
 * Check if a value matches a schema's default (deep equality).
 * Used to skip validation when value equals default.
 */
function matchesDefault(value, defaultValue) {
  try {
    return JSON.stringify(value) === JSON.stringify(defaultValue);
  } catch {
    return false;
  }
}

// ── Recursive validation ─────────────────────────────────────────────────────

/**
 * Validate a single value against a schema node.
 * Returns an array of error strings (empty if valid).
 *
 * @param {any} value - Value to validate.
 * @param {object} schema - JSON Schema fragment.
 * @param {string} path - Current JSON path (for error messages).
 * @returns {string[]} Array of error strings.
 */
export function validate(value, schema, path = "") {
  const errors = [];

  if (!schema || typeof schema !== "object") return errors;

  // ── Default: skip validation if value matches ──
  if (schema.default !== undefined && matchesDefault(value, schema.default)) {
    return errors;
  }

  // ── Const check ──
  if (schema.const !== undefined) {
    if (!matchesDefault(value, schema.const)) {
      errors.push(`${path || "root"}: must be ${JSON.stringify(schema.const)}`);
    }
    return errors;
  }

  // ── Enum check ──
  if (schema.enum !== undefined && Array.isArray(schema.enum)) {
    const matches = schema.enum.some(
      (e) => JSON.stringify(e) === JSON.stringify(value),
    );
    if (!matches) {
      errors.push(
        `${path || "root"}: value ${JSON.stringify(value)} not in enum [${schema.enum.map((e) => JSON.stringify(e)).join(", ")}]`,
      );
    }
  }

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
    if (schema.pattern !== undefined) {
      const regex = new RegExp(schema.pattern);
      if (!regex.test(value)) {
        errors.push(
          `${path || "root"}: must match pattern "${schema.pattern}"`,
        );
      }
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
    if (
      schema.exclusiveMinimum !== undefined &&
      value <= schema.exclusiveMinimum
    ) {
      errors.push(
        `${path || "root"}: value ${value} must be greater than ${schema.exclusiveMinimum}`,
      );
    }
    if (
      schema.exclusiveMaximum !== undefined &&
      value >= schema.exclusiveMaximum
    ) {
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
          errors.push(
            `${path ? `${path}.` : ""}${field}: missing required field`,
          );
        }
      }
    }

    // Validate known properties
    if (schema.properties && typeof schema.properties === "object") {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          const childErrors = validate(
            value[key],
            propSchema,
            path ? `${path}.${key}` : key,
          );
          errors.push(...childErrors);
        }
      }
    }

    // Additional properties check
    if (schema.additionalProperties === false) {
      const allowedKeys = new Set([
        ...Object.keys(schema.properties || {}),
        ...(schema.required || []),
      ]);
      for (const key of Object.keys(value)) {
        if (!allowedKeys.has(key)) {
          errors.push(
            `${path ? `${path}.` : ""}${key}: additional property not allowed`,
          );
        }
      }
    }
  }

  // ── Array: items ──
  if (Array.isArray(value)) {
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = validate(
          value[i],
          schema.items,
          `${path ? `${path}[` : "["}${i}]`,
        );
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

/**
 * Validate arguments against a JSON Schema.
 *
 * @param {object} args - Parsed arguments to validate
 * @param {object} schema - JSON Schema object
 * @returns {object} { valid: boolean, errors: string[] }
 */
export function validateParams(args, schema) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return { valid: false, errors: ["Arguments must be an object"] };
  }
  if (!schema || typeof schema !== "object") {
    return { valid: true, errors: [] };
  }

  const errors = validate(args, schema, "");
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
