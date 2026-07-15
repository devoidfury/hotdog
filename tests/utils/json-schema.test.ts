import { describe, it, expect } from "bun:test";
import {
  validateParams,
  formatValidationErrors,
} from "../../src/utils/json-schema.ts";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.ts";

function schema(props: Record<string, Record<string, unknown>>, required: string[] = []) {
  return { type: "object" as const, properties: props, required };
}

describe("validateParams — type checking", () => {
  it("valid arguments pass through", () => {
    const result = validateParams(
      { name: "test", count: 5, enabled: true },
      schema({ name: { type: "string" }, count: { type: "integer" }, enabled: { type: "boolean" } }, ["name"]),
    );
    expect(result.valid).toBe(true);
  });

  it("detects type mismatches", () => {
    expect(validateParams({ value: "not a number" }, schema({ value: { type: "number" } })).valid).toBe(false);
    expect(validateParams({ name: 123 }, schema({ name: { type: "string" } })).valid).toBe(false);
    expect(validateParams({ items: {} }, schema({ items: { type: "array" } })).valid).toBe(false);
    expect(validateParams({ data: [1] }, schema({ data: { type: "object" } })).valid).toBe(false);
    expect(validateParams({ enabled: "true" }, schema({ enabled: { type: "boolean" } })).valid).toBe(false);
  });

  it("validates integer strictly (rejects floats)", () => {
    expect(validateParams({ count: 3.14 }, schema({ count: { type: "integer" } })).valid).toBe(false);
    expect(validateParams({ count: 42 }, schema({ count: { type: "integer" } })).valid).toBe(true);
  });
});

describe("validateParams — required fields", () => {
  it("detects missing required fields", () => {
    const result = validateParams({}, schema({ name: { type: "string" }, age: { type: "integer" } }, ["name", "age"]));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBe(2);
  });

  it("passes when all required fields present", () => {
    expect(validateParams({ name: "Alice", age: 30 }, schema({ name: { type: "string" }, age: { type: "integer" } }, ["name", "age"])).valid).toBe(true);
  });
});

describe("validateParams — enum", () => {
  it("accepts valid enum value", () => {
    expect(validateParams({ color: "red" }, schema({ color: { type: "string", enum: ["red", "green", "blue"] } })).valid).toBe(true);
  });

  it("rejects invalid enum value", () => {
    const result = validateParams({ color: "purple" }, schema({ color: { type: "string", enum: ["red", "green", "blue"] } }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("not in enum");
  });
});

describe("validateParams — number range", () => {
  it("validates minimum and maximum", () => {
    expect(validateParams({ score: -1 }, schema({ score: { type: "integer", minimum: 0 } })).valid).toBe(false);
    expect(validateParams({ score: 150 }, schema({ score: { type: "integer", maximum: 100 } })).valid).toBe(false);
    expect(validateParams({ score: 50 }, schema({ score: { type: "integer", minimum: 0, maximum: 100 } })).valid).toBe(true);
    expect(validateParams({ score: 0 }, schema({ score: { type: "integer", minimum: 0 } })).valid).toBe(true);
  });

  it("validates exclusiveMinimum", () => {
    expect(validateParams({ temp: 0 }, schema({ temp: { type: "number", exclusiveMinimum: 0 } })).valid).toBe(false);
    expect(validateParams({ temp: 0.01 }, schema({ temp: { type: "number", exclusiveMinimum: 0 } })).valid).toBe(true);
  });
});

describe("validateParams — string length", () => {
  it("validates minLength and maxLength", () => {
    expect(validateParams({ name: "A" }, schema({ name: { type: "string", minLength: 2 } })).valid).toBe(false);
    expect(validateParams({ name: "Abcdefghij" }, schema({ name: { type: "string", maxLength: 5 } })).valid).toBe(false);
    expect(validateParams({ name: "Abcde" }, schema({ name: { type: "string", minLength: 2, maxLength: 10 } })).valid).toBe(true);
  });
});

describe("validateParams — nested objects", () => {
  it("validates nested object properties", () => {
    const result = validateParams(
      { address: { city: 123 } },
      schema({ address: { type: "object", properties: { city: { type: "string" }, zip: { type: "string" } }, required: ["city"] } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("city");
  });

  it("detects missing required nested field", () => {
    const result = validateParams(
      { address: {} },
      schema({ address: { type: "object", properties: { city: { type: "string" } }, required: ["city"] } }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("missing required");
  });

  it("passes valid nested objects", () => {
    expect(validateParams(
      { address: { city: "Paris", zip: "75001" } },
      schema({ address: { type: "object", properties: { city: { type: "string" }, zip: { type: "string" } }, required: ["city"] } }),
    ).valid).toBe(true);
  });
});

describe("validateParams — arrays", () => {
  it("validates array item types", () => {
    expect(validateParams({ tags: [123] }, schema({ tags: { type: "array", items: { type: "string" } } })).valid).toBe(false);
    expect(validateParams({ tags: ["a", "b"] }, schema({ tags: { type: "array", items: { type: "string" } } })).valid).toBe(true);
  });

  it("validates minItems and maxItems", () => {
    expect(validateParams({ items: [1] }, schema({ items: { type: "array", minItems: 2 } })).valid).toBe(false);
    expect(validateParams({ items: [1, 2, 3, 4, 5] }, schema({ items: { type: "array", maxItems: 3 } })).valid).toBe(false);
    expect(validateParams({ items: [1, 2] }, schema({ items: { type: "array", minItems: 1, maxItems: 5 } })).valid).toBe(true);
  });
});

describe("validateParams — additionalProperties", () => {
  it("allows extra fields by default", () => {
    expect(validateParams({ name: "test", extra: "ignored" }, schema({ name: { type: "string" } })).valid).toBe(true);
  });

  it("rejects extra fields when additionalProperties is false", () => {
    const result = validateParams(
      { name: "test", extra: "not allowed" },
      { type: "object", properties: { name: { type: "string" } }, required: [], additionalProperties: false },
    );
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("additional property not allowed");
  });
});

describe("validateParams — edge cases", () => {
  it("rejects non-object input", () => {
    expect(validateParams(null, schema({})).valid).toBe(false);
    expect(validateParams([1], schema({})).valid).toBe(false);
    expect(validateParams("hello", schema({})).valid).toBe(false);
  });

  it("passes with empty object and no required fields", () => {
    expect(validateParams({}, schema({}, [])).valid).toBe(true);
  });

  it("passes with null/undefined schema", () => {
    expect(validateParams({ a: 1 }, null).valid).toBe(true);
    expect(validateParams({ a: 1 }, undefined).valid).toBe(true);
  });
});

describe("formatValidationErrors", () => {
  it("formats errors with numbering", () => {
    expect(formatValidationErrors([])).toBe("");
    const formatted = formatValidationErrors(["error a", "error b"]);
    expect(formatted).toContain("Parameter validation failed:");
    expect(formatted).toContain("1. error a");
    expect(formatted).toContain("2. error b");
  });
});

describe("Integration — validation blocks invalid tool execution", () => {
  it("detects multiple validation errors in tool args", () => {
    const toolSchema = {
      type: "object",
      properties: {
        path: { type: "string", minLength: 1 },
        max_results: { type: "integer", minimum: 1, maximum: 1000 },
        pattern: { type: "string" },
      },
      required: ["pattern"],
    };
    expect(validateParams({}, toolSchema).valid).toBe(false);
    expect(validateParams({ pattern: "hello", max_results: "five" }, toolSchema).valid).toBe(false);
    expect(validateParams({ pattern: "hello", max_results: 9999 }, toolSchema).valid).toBe(false);
    expect(validateParams({ pattern: "hello", max_results: 10 }, toolSchema).valid).toBe(true);
  });

  it("formats validation errors for tool dispatch", () => {
    const toolSchema = {
      type: "object",
      properties: {
        command: { type: "string", enum: ["ls", "cat", "echo"] },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["command", "args"],
    };
    const validation = validateParams({ command: "rm -rf /", args: ["/"] }, toolSchema);
    expect(validation.valid).toBe(false);
    expect(formatValidationErrors(validation.errors)).toContain("Parameter validation failed");
  });
});

describe("ToolRegistry.validateToolArgs", () => {
  function registerTool(registry: ToolRegistry, name: string, params: Record<string, unknown>) {
    registry.register(name, {
      toToolDef() {
        return { type: "function", function: { name, description: "test", parameters: params } };
      },
      execute: async () => "ok",
    });
  }

  it("returns null for unknown tool or tool without params", async () => {
    const registry = new ToolRegistry();
    expect(await registry.validateToolArgs("nonexistent", "{}")).toBeNull();
    registry.register("no-def", { execute: async () => "ok" });
    expect(await registry.validateToolArgs("no-def", "{}")).toBeNull();
    registerTool(registry, "no-params", {});
    expect(await registry.validateToolArgs("no-params", '{"a": 1}')).toBeNull();
  });

  it("detects validation errors", async () => {
    const registry = new ToolRegistry();
    registerTool(registry, "testtool", {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "integer" } },
      required: ["name"],
    });
    expect(await registry.validateToolArgs("testtool", "{}")).toContain("name");
    expect(await registry.validateToolArgs("testtool", '{"count": "five"}')).toContain("expected integer");
    expect(await registry.validateToolArgs("testtool", '{"name": "test", "count": 5}')).toBeNull();
  });

  it("detects enum violation", async () => {
    const registry = new ToolRegistry();
    registerTool(registry, "testtool", {
      type: "object",
      properties: { mode: { type: "string", enum: ["read", "write"] } },
      required: ["mode"],
    });
    expect(await registry.validateToolArgs("testtool", '{"mode": "delete"}')).toContain("not in enum");
  });

  it("handles non-object input with a clear error message", async () => {
    const registry = new ToolRegistry();
    registerTool(registry, "testtool", {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    });
    // null input
    const nullResult = await registry.validateToolArgs("testtool", null);
    expect(nullResult).toContain("null");

    // number input
    const numResult = await registry.validateToolArgs("testtool", 42);
    expect(numResult).toContain("number");

    // boolean input
    const boolResult = await registry.validateToolArgs("testtool", true);
    expect(boolResult).toContain("boolean");

    // array input (not an object)
    const arrResult = await registry.validateToolArgs("testtool", [1, 2, 3]);
    expect(arrResult).toContain("array");

    // undefined input
    const undefResult = await registry.validateToolArgs("testtool", undefined);
    expect(undefResult).toContain("undefined");
  });
});

describe("validateWithSchema edge cases", () => {
  it("validates const values", () => {
    const result = validateParams(
      { value: "hello" },
      {
        type: "object",
        properties: {
          value: { type: "string", const: "hello" },
        },
      },
    );
    expect(result.valid).toBe(true);
  });

  it("rejects non-const values", () => {
    const result = validateParams(
      { value: "world" },
      {
        type: "object",
        properties: {
          value: { type: "string", const: "hello" },
        },
      },
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validates pattern matching", () => {
    const result = validateParams(
      { value: "abc123" },
      {
        type: "object",
        properties: {
          value: { type: "string", pattern: "^[a-z]+[0-9]+$" },
        },
      },
    );
    expect(result.valid).toBe(true);
  });

  it("rejects pattern mismatch", () => {
    const result = validateParams(
      { value: "123abc" },
      {
        type: "object",
        properties: {
          value: { type: "string", pattern: "^[a-z]+[0-9]+$" },
        },
      },
    );
    expect(result.valid).toBe(false);
  });

  it("validates exclusiveMaximum", () => {
    const result = validateParams(
      { value: 5 },
      {
        type: "object",
        properties: {
          value: { type: "integer", exclusiveMaximum: 10 },
        },
      },
    );
    expect(result.valid).toBe(true);
  });

  it("rejects exclusiveMaximum violation", () => {
    const result = validateParams(
      { value: 15 },
      {
        type: "object",
        properties: {
          value: { type: "integer", exclusiveMaximum: 10 },
        },
      },
    );
    expect(result.valid).toBe(false);
  });

  it("handles matchesDefault with non-stringifiable values", () => {
    // Create a circular reference to test the error handling in matchesDefault
    // But avoid triggering JSON.stringify in error message by using a non-circular const
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = validateParams(
      circular,
      {
        type: "object",
        const: { simple: "value" }, // Non-circular const
      },
    );
    // matchesDefault catches the JSON.stringify error and returns false
    // so the const check fails, adding an error
    expect(result.valid).toBe(false);
  });
});
