/**
 * Lightweight JSON Schema (draft 2020-12) validation.
 *
 * Standalone, reusable validator supporting: type, enum, const,
 * minLength/maxLength, minimum/maximum, exclusiveMinimum/maximum,
 * required, properties, additionalProperties, items (arrays),
 * minItems/maxItems, pattern (regex), and default (skip validation).
 */

// ── Type checking helpers ────────────────────────────────────────────────────

type TypeCheckFn = (v: unknown) => boolean;

/**
 * Map JSON Schema type names to JavaScript type checks.
 */
const TYPE_CHECKS: Record<string, TypeCheckFn> = {
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
export function typeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

// ── Default matching ─────────────────────────────────────────────────────────

/**
 * Check if a value matches a schema's default (deep equality).
 * Used to skip validation when value equals default.
 */
function matchesDefault(value: unknown, defaultValue: unknown): boolean {
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
 */
export function validate(
  value: unknown,
  schema: unknown,
  path: string = "",
): string[] {
  const errors: string[] = [];

  if (!schema || typeof schema !== "object") return errors;

  const schemaObj = schema as Record<string, unknown>;

  // ── Default: skip validation if value matches ──
  if (
    schemaObj.default !== undefined &&
    matchesDefault(value, schemaObj.default)
  ) {
    return errors;
  }

  // ── Const check ──
  if (schemaObj.const !== undefined) {
    if (!matchesDefault(value, schemaObj.const)) {
      errors.push(
        `${path || "root"}: must be ${JSON.stringify(schemaObj.const)}`,
      );
    }
    return errors;
  }

  // ── Enum check ──
  if (schemaObj.enum !== undefined && Array.isArray(schemaObj.enum)) {
    const matches = schemaObj.enum.some(
      (e: unknown) => JSON.stringify(e) === JSON.stringify(value),
    );
    if (!matches) {
      errors.push(
        `${path || "root"}: value ${JSON.stringify(value)} not in enum [${schemaObj.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}]`,
      );
    }
  }

  // ── Type check ──
  if (schemaObj.type !== undefined) {
    const typeStr = schemaObj.type as string;
    const checkFn = TYPE_CHECKS[typeStr];
    if (checkFn && !checkFn(value)) {
      errors.push(
        `${path || "root"}: expected ${typeStr}, got ${typeName(value)}`,
      );
      return errors; // No point checking further constraints on wrong type
    }
  }

  // ── String constraints ──
  if (typeof value === "string") {
    if (
      schemaObj.minLength !== undefined &&
      value.length < (schemaObj.minLength as number)
    ) {
      errors.push(
        `${path || "root"}: string length ${value.length} is less than minimum ${schemaObj.minLength}`,
      );
    }
    if (
      schemaObj.maxLength !== undefined &&
      value.length > (schemaObj.maxLength as number)
    ) {
      errors.push(
        `${path || "root"}: string length ${value.length} exceeds maximum ${schemaObj.maxLength}`,
      );
    }
    if (schemaObj.pattern !== undefined) {
      const regex = new RegExp(schemaObj.pattern as string);
      if (!regex.test(value)) {
        errors.push(
          `${path || "root"}: must match pattern "${schemaObj.pattern}"`,
        );
      }
    }
  }

  // ── Number constraints ──
  if (typeof value === "number") {
    if (
      schemaObj.minimum !== undefined &&
      value < (schemaObj.minimum as number)
    ) {
      errors.push(
        `${path || "root"}: value ${value} is less than minimum ${schemaObj.minimum}`,
      );
    }
    if (
      schemaObj.maximum !== undefined &&
      value > (schemaObj.maximum as number)
    ) {
      errors.push(
        `${path || "root"}: value ${value} exceeds maximum ${schemaObj.maximum}`,
      );
    }
    if (
      schemaObj.exclusiveMinimum !== undefined &&
      value <= (schemaObj.exclusiveMinimum as number)
    ) {
      errors.push(
        `${path || "root"}: value ${value} must be greater than ${schemaObj.exclusiveMinimum}`,
      );
    }
    if (
      schemaObj.exclusiveMaximum !== undefined &&
      value >= (schemaObj.exclusiveMaximum as number)
    ) {
      errors.push(
        `${path || "root"}: value ${value} must be less than ${schemaObj.exclusiveMaximum}`,
      );
    }
  }

  // ── Object: properties + required ──
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const valueObj = value as Record<string, unknown>;

    // Required fields
    if (schemaObj.required && Array.isArray(schemaObj.required)) {
      for (const field of schemaObj.required as string[]) {
        if (!(field in valueObj)) {
          errors.push(
            `${path ? `${path}.` : ""}${field}: missing required field`,
          );
        }
      }
    }

    // Validate known properties
    if (
      schemaObj.properties &&
      typeof schemaObj.properties === "object"
    ) {
      for (const [key, propSchema] of Object.entries(
        schemaObj.properties as Record<string, unknown>,
      )) {
        if (key in valueObj) {
          const childErrors = validate(
            valueObj[key],
            propSchema,
            path ? `${path}.${key}` : key,
          );
          errors.push(...childErrors);
        }
      }
    }

    // Additional properties check
    if (schemaObj.additionalProperties === false) {
      const allowedKeys = new Set([
        ...Object.keys(schemaObj.properties as Record<string, unknown> || {}),
        ...(schemaObj.required as string[] || []),
      ]);
      for (const key of Object.keys(valueObj)) {
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
    if (schemaObj.items) {
      for (let i = 0; i < value.length; i++) {
        const itemErrors = validate(
          value[i]!,
          schemaObj.items,
          `${path ? `${path}[` : "["}${i}]`,
        );
        errors.push(...itemErrors);
      }
    }
    if (
      schemaObj.minItems !== undefined &&
      value.length < (schemaObj.minItems as number)
    ) {
      errors.push(
        `${path || "root"}: array length ${value.length} is less than minimum ${schemaObj.minItems}`,
      );
    }
    if (
      schemaObj.maxItems !== undefined &&
      value.length > (schemaObj.maxItems as number)
    ) {
      errors.push(
        `${path || "root"}: array length ${value.length} exceeds maximum ${schemaObj.maxItems}`,
      );
    }
  }

  return errors;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate arguments against a JSON Schema.
 */
export function validateParams(
  args: unknown,
  schema: unknown,
): ValidationResult {
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
 */
export function formatValidationErrors(errors: string[]): string {
  if (errors.length === 0) return "";
  const header = "Parameter validation failed:";
  const body = errors.map((e, i) => `  ${i + 1}. ${e}`).join("\n");
  return `${header}\n${body}`;
}
