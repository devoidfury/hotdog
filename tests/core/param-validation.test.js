import { describe, it, expect } from "bun:test";
import {
  validateParams,
  formatValidationErrors,
} from "../../src/core/json-schema.js";

// ── Helper: build a minimal schema ───────────────────────────────────────────

function schema(props, required = []) {
  return { type: "object", properties: props, required };
}

// ── Basic type validation ────────────────────────────────────────────────────

describe("validateParams — type checking", () => {
  it("valid arguments pass through", () => {
    const result = validateParams(
      { name: "test", count: 5 },
      schema({ name: { type: "string" }, count: { type: "integer" } }, [
        "name",
        "count",
      ]),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("detects string where number expected", () => {
    const result = validateParams(
      { value: "not a number" },
      schema({ value: { type: "number" } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("expected number");
    expect(result.errors[0]).toContain("got string");
  });

  it("detects number where string expected", () => {
    const result = validateParams(
      { name: 123 },
      schema({ name: { type: "string" } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("expected string");
    expect(result.errors[0]).toContain("got number");
  });

  it("detects object where array expected", () => {
    const result = validateParams(
      { items: { key: "val" } },
      schema({ items: { type: "array" } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("expected array");
  });

  it("detects array where object expected", () => {
    const result = validateParams(
      { data: [1, 2, 3] },
      schema({ data: { type: "object" } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("expected object");
  });

  it("accepts boolean type", () => {
    const result = validateParams(
      { enabled: true },
      schema({ enabled: { type: "boolean" } }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects string as boolean", () => {
    const result = validateParams(
      { enabled: "true" },
      schema({ enabled: { type: "boolean" } }),
    );
    expect(result.valid).toBe(false);
  });

  it("validates integer type strictly (rejects floats)", () => {
    const result = validateParams(
      { count: 3.14 },
      schema({ count: { type: "integer" } }),
    );
    expect(result.valid).toBe(false);
  });

  it("accepts integer value for integer type", () => {
    const result = validateParams(
      { count: 42 },
      schema({ count: { type: "integer" } }),
    );
    expect(result.valid).toBe(true);
  });
});

// ── Required fields ──────────────────────────────────────────────────────────

describe("validateParams — required fields", () => {
  it("detects missing required field", () => {
    const result = validateParams(
      {},
      schema({ name: { type: "string" }, age: { type: "integer" } }, [
        "name",
        "age",
      ]),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.errors[0]).toContain("name");
    expect(result.errors[1]).toContain("age");
  });

  it("passes when all required fields present", () => {
    const result = validateParams(
      { name: "Alice", age: 30 },
      schema({ name: { type: "string" }, age: { type: "integer" } }, [
        "name",
        "age",
      ]),
    );
    expect(result.valid).toBe(true);
  });

  it("allows optional fields to be absent", () => {
    const result = validateParams(
      { name: "Bob" },
      schema({ name: { type: "string" }, age: { type: "integer" } }, ["name"]),
    );
    expect(result.valid).toBe(true);
  });
});

// ── Enum validation ──────────────────────────────────────────────────────────

describe("validateParams — enum", () => {
  it("accepts valid enum value", () => {
    const result = validateParams(
      { color: "red" },
      schema({ color: { type: "string", enum: ["red", "green", "blue"] } }),
    );
    expect(result.valid).toBe(true);
  });

  it("detects invalid enum value", () => {
    const result = validateParams(
      { color: "purple" },
      schema({ color: { type: "string", enum: ["red", "green", "blue"] } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("not in enum");
  });

  it("detects wrong type even if value matches enum concept", () => {
    const result = validateParams(
      { color: 123 },
      schema({ color: { type: "string", enum: ["red", "green", "blue"] } }),
    );
    expect(result.valid).toBe(false);
  });
});

// ── Range validation (number) ────────────────────────────────────────────────

describe("validateParams — number range", () => {
  it("detects value below minimum", () => {
    const result = validateParams(
      { score: -1 },
      schema({ score: { type: "integer", minimum: 0 } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("less than minimum");
  });

  it("detects value above maximum", () => {
    const result = validateParams(
      { score: 150 },
      schema({ score: { type: "integer", maximum: 100 } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("exceeds maximum");
  });

  it("accepts value within range", () => {
    const result = validateParams(
      { score: 50 },
      schema({ score: { type: "integer", minimum: 0, maximum: 100 } }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts value at exact minimum", () => {
    const result = validateParams(
      { score: 0 },
      schema({ score: { type: "integer", minimum: 0 } }),
    );
    expect(result.valid).toBe(true);
  });

  it("accepts value at exact maximum", () => {
    const result = validateParams(
      { score: 100 },
      schema({ score: { type: "integer", maximum: 100 } }),
    );
    expect(result.valid).toBe(true);
  });

  it("detects exclusiveMinimum violation", () => {
    const result = validateParams(
      { temp: 0 },
      schema({ temp: { type: "number", exclusiveMinimum: 0 } }),
    );
    expect(result.valid).toBe(false);
  });

  it("accepts value above exclusiveMinimum", () => {
    const result = validateParams(
      { temp: 0.01 },
      schema({ temp: { type: "number", exclusiveMinimum: 0 } }),
    );
    expect(result.valid).toBe(true);
  });
});

// ── String length validation ─────────────────────────────────────────────────

describe("validateParams — string length", () => {
  it("detects string too short", () => {
    const result = validateParams(
      { name: "A" },
      schema({ name: { type: "string", minLength: 2 } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("less than minimum");
  });

  it("detects string too long", () => {
    const result = validateParams(
      { name: "Abcdefghij" },
      schema({ name: { type: "string", maxLength: 5 } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("exceeds maximum");
  });

  it("accepts string within length bounds", () => {
    const result = validateParams(
      { name: "Abcde" },
      schema({ name: { type: "string", minLength: 2, maxLength: 10 } }),
    );
    expect(result.valid).toBe(true);
  });
});

// ── Nested object validation ─────────────────────────────────────────────────

describe("validateParams — nested objects", () => {
  it("validates nested object properties", () => {
    const result = validateParams(
      { address: { city: 123 } },
      schema({
        address: {
          type: "object",
          properties: {
            city: { type: "string" },
            zip: { type: "string" },
          },
          required: ["city"],
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("city");
    expect(result.errors[0]).toContain("expected string");
  });

  it("detects missing required nested field", () => {
    const result = validateParams(
      { address: {} },
      schema({
        address: {
          type: "object",
          properties: { city: { type: "string" } },
          required: ["city"],
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("city");
    expect(result.errors[0]).toContain("missing required");
  });

  it("validates deeply nested objects", () => {
    const result = validateParams(
      { user: { profile: { age: "old" } } },
      schema({
        user: {
          type: "object",
          properties: {
            profile: {
              type: "object",
              properties: {
                age: { type: "integer" },
              },
              required: ["age"],
            },
          },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("profile.age");
  });

  it("passes valid nested objects", () => {
    const result = validateParams(
      { address: { city: "Paris", zip: "75001" } },
      schema({
        address: {
          type: "object",
          properties: {
            city: { type: "string" },
            zip: { type: "string" },
          },
          required: ["city"],
        },
      }),
    );
    expect(result.valid).toBe(true);
  });
});

// ── Array items validation ───────────────────────────────────────────────────

describe("validateParams — arrays", () => {
  it("validates array item types", () => {
    const result = validateParams(
      { tags: ["a", 123, "c"] },
      schema({ tags: { type: "array", items: { type: "string" } } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("expected string");
  });

  it("accepts valid array of items", () => {
    const result = validateParams(
      { tags: ["a", "b", "c"] },
      schema({ tags: { type: "array", items: { type: "string" } } }),
    );
    expect(result.valid).toBe(true);
  });

  it("detects array too short (minItems)", () => {
    const result = validateParams(
      { items: [1] },
      schema({ items: { type: "array", minItems: 2 } }),
    );
    expect(result.valid).toBe(false);
  });

  it("detects array too long (maxItems)", () => {
    const result = validateParams(
      { items: [1, 2, 3, 4, 5] },
      schema({ items: { type: "array", maxItems: 3 } }),
    );
    expect(result.valid).toBe(false);
  });

  it("accepts array within bounds", () => {
    const result = validateParams(
      { items: [1, 2] },
      schema({ items: { type: "array", minItems: 1, maxItems: 5 } }),
    );
    expect(result.valid).toBe(true);
  });

  it("validates nested objects inside arrays", () => {
    const result = validateParams(
      { users: [{ name: "Alice" }, { name: 123 }] },
      schema({
        users: {
          type: "array",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
            },
            required: ["name"],
          },
        },
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("name");
  });
});

// ── Additional properties ────────────────────────────────────────────────────

describe("validateParams — additionalProperties", () => {
  it("allows unknown fields when additionalProperties is not set", () => {
    const result = validateParams(
      { name: "test", extraField: "ignored" },
      schema({ name: { type: "string" } }),
    );
    expect(result.valid).toBe(true);
  });

  it("rejects unknown fields when additionalProperties is false", () => {
    const result = validateParams(
      { name: "test", extraField: "not allowed" },
      {
        type: "object",
        properties: { name: { type: "string" } },
        required: [],
        additionalProperties: false,
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("additional property not allowed");
  });

  it("allows extra fields if they are in required list", () => {
    // This tests edge case: extra fields that happen to be in required
    const result = validateParams(
      { name: "test", required_field: "val" },
      {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["required_field"],
        additionalProperties: false,
      },
    );
    expect(result.valid).toBe(true);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe("validateParams — edge cases", () => {
  it("returns error for null input", () => {
    const result = validateParams(null, schema({}));
    expect(result.valid).toBe(false);
  });

  it("returns error for array input", () => {
    const result = validateParams([1, 2, 3], schema({}));
    expect(result.valid).toBe(false);
  });

  it("returns error for string input", () => {
    const result = validateParams("hello", schema({}));
    expect(result.valid).toBe(false);
  });

  it("passes with empty object and no required fields", () => {
    const result = validateParams({}, schema({}, []));
    expect(result.valid).toBe(true);
  });

  it("passes with empty schema", () => {
    const result = validateParams({ anything: "goes" }, {});
    expect(result.valid).toBe(true);
  });

  it("passes with null/undefined schema", () => {
    expect(validateParams({ a: 1 }, null).valid).toBe(true);
    expect(validateParams({ a: 1 }, undefined).valid).toBe(true);
  });
});

// ── formatValidationErrors ───────────────────────────────────────────────────

describe("formatValidationErrors", () => {
  it("returns empty string for no errors", () => {
    expect(formatValidationErrors([])).toBe("");
  });

  it("formats single error", () => {
    const formatted = formatValidationErrors(["one error"]);
    expect(formatted).toContain("Parameter validation failed:");
    expect(formatted).toContain("1. one error");
  });

  it("formats multiple errors with numbering", () => {
    const formatted = formatValidationErrors(["error a", "error b", "error c"]);
    expect(formatted).toContain("1. error a");
    expect(formatted).toContain("2. error b");
    expect(formatted).toContain("3. error c");
  });
});

// ── Integration: tool execution flow ─────────────────────────────────────────

describe("Integration — validation blocks invalid tool execution", () => {
  it("returns error message instead of executing when args are invalid", () => {
    // Simulate what the tool execution flow should do:
    // 1. Parse args
    // 2. Validate against schema
    // 3. If invalid, return error; if valid, execute
    const toolSchema = {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        max_results: { type: "integer", minimum: 1, maximum: 1000 },
        pattern: { type: "string" },
      },
      required: ["pattern"],
    };

    // Invalid: missing required pattern
    const result1 = validateParams({}, toolSchema);
    expect(result1.valid).toBe(false);
    expect(result1.errors.some((e) => e.includes("pattern"))).toBe(true);

    // Invalid: wrong type for max_results
    const result2 = validateParams(
      { pattern: "hello", max_results: "five" },
      toolSchema,
    );
    expect(result2.valid).toBe(false);
    expect(result2.errors.some((e) => e.includes("expected integer"))).toBe(
      true,
    );

    // Invalid: max_results out of range
    const result3 = validateParams(
      { pattern: "hello", max_results: 9999 },
      toolSchema,
    );
    expect(result3.valid).toBe(false);
    expect(result3.errors.some((e) => e.includes("exceeds maximum"))).toBe(
      true,
    );

    // Valid: all good
    const result4 = validateParams(
      { pattern: "hello", max_results: 10 },
      toolSchema,
    );
    expect(result4.valid).toBe(true);
    expect(result4.errors).toEqual([]);
  });

  it("mimics the tool dispatch flow: invalid args → error result", () => {
    // This test mimics the pattern that tool-registry.js should follow:
    //   const validation = validateParams(args, toolSchema);
    //   if (!validation.valid) return ToolResult.err(formatValidationErrors(validation.errors));
    //   return await tool.execute(args);

    const toolSchema = {
      type: "object",
      properties: {
        command: { type: "string", enum: ["ls", "cat", "echo"] },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["command", "args"],
    };

    // LLM sends invalid command
    const llmArgs = { command: "rm -rf /", args: ["/"] };
    const validation = validateParams(llmArgs, toolSchema);

    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
    // The tool should NOT execute — instead return the validation error
    const errorMsg = formatValidationErrors(validation.errors);
    expect(errorMsg).toContain("Parameter validation failed");
    expect(errorMsg).toContain("rm -rf /");
  });
});

// ── ToolRegistry.validateToolArgs integration ────────────────────────────────

import { ToolRegistry } from "../../src/core/extensions/tool-registry.js";

describe("ToolRegistry.validateToolArgs", () => {
  it("returns null for unknown tool", () => {
    const registry = new ToolRegistry();
    expect(registry.validateToolArgs("nonexistent", "{}")).toBeNull();
  });

  it("returns null for tool without toToolDef", () => {
    const registry = new ToolRegistry();
    registry.register("mytool", { execute: async () => "ok" });
    expect(registry.validateToolArgs("mytool", "{}")).toBeNull();
  });

  it("returns null when tool has no parameters", async () => {
    const registry = new ToolRegistry();
    registry.register("mytool", {
      toToolDef() {
        return {
          type: "function",
          function: { name: "mytool", description: "" },
        };
      },
      execute: async () => "ok",
    });
    expect(registry.validateToolArgs("mytool", '{"a": 1}')).toBeNull();
  });

  it("detects missing required field via registry", async () => {
    const registry = new ToolRegistry();
    registry.register("testtool", {
      toToolDef() {
        return {
          type: "function",
          function: {
            name: "testtool",
            description: "test",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        };
      },
      execute: async () => "ok",
    });
    const error = registry.validateToolArgs("testtool", "{}");
    expect(error).not.toBeNull();
    expect(error).toContain("name");
    expect(error).toContain("missing required");
  });

  it("detects wrong type via registry", async () => {
    const registry = new ToolRegistry();
    registry.register("testtool", {
      toToolDef() {
        return {
          type: "function",
          function: {
            name: "testtool",
            description: "test",
            parameters: {
              type: "object",
              properties: { count: { type: "integer" } },
              required: [],
            },
          },
        };
      },
      execute: async () => "ok",
    });
    const error = registry.validateToolArgs("testtool", '{"count": "five"}');
    expect(error).not.toBeNull();
    expect(error).toContain("expected integer");
  });

  it("passes valid args via registry", async () => {
    const registry = new ToolRegistry();
    registry.register("testtool", {
      toToolDef() {
        return {
          type: "function",
          function: {
            name: "testtool",
            description: "test",
            parameters: {
              type: "object",
              properties: {
                name: { type: "string" },
                count: { type: "integer" },
              },
              required: ["name"],
            },
          },
        };
      },
      execute: async () => "ok",
    });
    const error = registry.validateToolArgs(
      "testtool",
      '{"name": "test", "count": 5}',
    );
    expect(error).toBeNull();
  });

  it("handles JSON string input", async () => {
    const registry = new ToolRegistry();
    registry.register("testtool", {
      toToolDef() {
        return {
          type: "function",
          function: {
            name: "testtool",
            description: "test",
            parameters: {
              type: "object",
              properties: { name: { type: "string" } },
              required: ["name"],
            },
          },
        };
      },
      execute: async () => "ok",
    });
    // Valid JSON string
    expect(
      registry.validateToolArgs("testtool", '{"name": "test"}'),
    ).toBeNull();
    // Invalid JSON string
    expect(
      registry.validateToolArgs("testtool", '{"name": 123}'),
    ).not.toBeNull();
  });

  it("detects enum violation via registry", async () => {
    const registry = new ToolRegistry();
    registry.register("testtool", {
      toToolDef() {
        return {
          type: "function",
          function: {
            name: "testtool",
            description: "test",
            parameters: {
              type: "object",
              properties: {
                mode: { type: "string", enum: ["read", "write", "append"] },
              },
              required: ["mode"],
            },
          },
        };
      },
      execute: async () => "ok",
    });
    const error = registry.validateToolArgs("testtool", '{"mode": "delete"}');
    expect(error).not.toBeNull();
    expect(error).toContain("not in enum");
  });
});
