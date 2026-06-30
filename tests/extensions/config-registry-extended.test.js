// Extended tests for ConfigRegistry — schema validation, layers, edge cases.
import { describe, it, expect } from "bun:test";
import { ConfigRegistry, createConfigRegistry } from "../../src/core/extensions/config-registry.js";

describe("ConfigRegistry constructor", () => {
  it("creates registry with empty state", () => {
    const registry = new ConfigRegistry();
    expect(registry.getCliFlags()).toEqual([]);
    expect(registry.getConfigParams()).toEqual([]);
    expect(registry.buildDefaults()).toEqual({});
  });
});

describe("createConfigRegistry", () => {
  it("returns a new ConfigRegistry instance", () => {
    const registry = createConfigRegistry();
    expect(registry).toBeInstanceOf(ConfigRegistry);
  });
});

describe("registerCliFlags — edge cases", () => {
  it("throws for non-array input", () => {
    const registry = createConfigRegistry();
    expect(() => registry.registerCliFlags("not-an-array")).toThrow("must be an array");
  });

  it("defaults type to string when not provided", () => {
    const registry = createConfigRegistry();
    registry.registerCliFlags([{ long: "--test" }]);
    expect(registry.getCliFlags()[0].type).toBe("string");
  });

  it("handles flags with only short form", () => {
    const registry = createConfigRegistry();
    registry.registerCliFlags([{ short: "-t", type: "string" }]);
    const help = registry.getCliHelpText();
    expect(help).toContain("-t");
  });

  it("handles empty flags array", () => {
    const registry = createConfigRegistry();
    registry.registerCliFlags([]);
    expect(registry.getCliFlags()).toEqual([]);
  });
});

describe("registerConfigParams — layers", () => {
  it("registers config params with layers", () => {
    const registry = createConfigRegistry();
    registry.registerConfigParams([
      {
        key: "test",
        defaults: { value: 1 },
        layers: [
          { source: "cli", key: "testValue" },
          { source: "config", key: "testValue" },
        ],
      },
    ]);
    expect(registry.getConfigLayers("test")).toEqual([
      { source: "cli", key: "testValue" },
      { source: "config", key: "testValue" },
    ]);
  });

  it("getConfigLayers returns null when no layers registered", () => {
    const registry = createConfigRegistry();
    expect(registry.getConfigLayers("nonexistent")).toBeNull();
  });

  it("getAllConfigLayers returns all layers", () => {
    const registry = createConfigRegistry();
    registry.registerConfigParams([
      {
        key: "test1",
        defaults: { a: 1 },
        layers: [{ source: "cli" }],
      },
      {
        key: "test2",
        defaults: { b: 2 },
        layers: [{ source: "config" }],
      },
    ]);
    const allLayers = registry.getAllConfigLayers();
    expect(allLayers.test1).toEqual([{ source: "cli" }]);
    expect(allLayers.test2).toEqual([{ source: "config" }]);
  });

  it("getAllConfigLayers returns empty object when no layers", () => {
    const registry = createConfigRegistry();
    expect(registry.getAllConfigLayers()).toEqual({});
  });
});

describe("getCliHelpText", () => {
  it("returns empty string when no flags registered", () => {
    const registry = createConfigRegistry();
    expect(registry.getCliHelpText()).toBe("");
  });

  it("formats array type flag", () => {
    const registry = createConfigRegistry();
    registry.registerCliFlags([
      { long: "--tags", type: "array", description: "Tags" },
    ]);
    const help = registry.getCliHelpText();
    expect(help).toContain("value,...");
  });

  it("formats boolean flag without value placeholder", () => {
    const registry = createConfigRegistry();
    registry.registerCliFlags([
      { long: "--verbose", type: "boolean", description: "Verbose" },
    ]);
    const help = registry.getCliHelpText();
    expect(help).not.toContain("<value>");
  });
});

describe("Schema Validation", () => {
  it("registerConfigSchema stores schema", () => {
    const registry = createConfigRegistry();
    const schema = { type: "object", properties: { name: { type: "string" } } };
    registry.registerConfigSchema("mcpServers", schema);
    expect(registry.getConfigSchema("mcpServers")).toBe(schema);
  });

  it("getConfigSchema returns null when not registered", () => {
    const registry = createConfigRegistry();
    expect(registry.getConfigSchema("nonexistent")).toBeNull();
  });

  it("registerConfigSchema throws for invalid key", () => {
    const registry = createConfigRegistry();
    expect(() => registry.registerConfigSchema("", {})).toThrow("key must be a non-empty string");
    expect(() => registry.registerConfigSchema(123, {})).toThrow("key must be a non-empty string");
  });

  it("registerConfigSchema throws for invalid schema", () => {
    const registry = createConfigRegistry();
    expect(() => registry.registerConfigSchema("key", null)).toThrow("schema must be a non-null object");
    expect(() => registry.registerConfigSchema("key", "not-an-object")).toThrow("schema must be a non-null object");
  });

  it("validateConfig validates against schema", () => {
    const registry = createConfigRegistry();
    const schema = { type: "object", properties: { name: { type: "string" } } };
    const result = registry.validateConfig({ name: "test" }, schema);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("validateConfig returns errors for invalid config", () => {
    const registry = createConfigRegistry();
    const schema = { type: "object", required: ["name"], properties: { name: { type: "string" } } };
    const result = registry.validateConfig({}, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("validateConfigByKey uses registered schema", () => {
    const registry = createConfigRegistry();
    const schema = { type: "object", properties: { name: { type: "string" } } };
    registry.registerConfigSchema("test", schema);
    const result = registry.validateConfigByKey("test", { name: "ok" });
    expect(result.valid).toBe(true);
  });

  it("validateConfigByKey uses inline schema from config params", () => {
    const registry = createConfigRegistry();
    registry.registerConfigParams([
      {
        key: "test",
        defaults: { value: 1 },
        schema: { type: "object", properties: { value: { type: "number" } } },
      },
    ]);
    const result = registry.validateConfigByKey("test", { value: 1 });
    expect(result.valid).toBe(true);
  });

  it("validateConfigByKey returns valid when no schema found", () => {
    const registry = createConfigRegistry();
    const result = registry.validateConfigByKey("nonexistent", {});
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("registerConfigSchemaWithLayers stores schema and layers", () => {
    const registry = createConfigRegistry();
    const schema = { type: "object" };
    const layers = [{ source: "cli" }];
    registry.registerConfigSchemaWithLayers("test", schema, layers);
    expect(registry.getConfigSchema("test")).toBe(schema);
    expect(registry.getConfigLayers("test")).toEqual(layers);
  });

  it("registerConfigSchemaWithLayers throws for invalid key", () => {
    const registry = createConfigRegistry();
    expect(() => registry.registerConfigSchemaWithLayers("", {}, [])).toThrow("key must be a non-empty string");
  });

  it("registerConfigSchemaWithLayers throws for invalid schema", () => {
    const registry = createConfigRegistry();
    expect(() => registry.registerConfigSchemaWithLayers("key", null, [])).toThrow("schema must be a non-null object");
  });

  it("registerConfigSchemaWithLayers handles no layers", () => {
    const registry = createConfigRegistry();
    registry.registerConfigSchemaWithLayers("test", { type: "object" }, null);
    expect(registry.getConfigSchema("test")).toEqual({ type: "object" });
  });
});
