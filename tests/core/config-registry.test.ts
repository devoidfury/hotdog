/**
 * Tests for the ConfigRegistry system.
 *
 * The ConfigRegistry manages extension-registered CLI flags and config params.
 * Config params and CLI flags are defined in extension.json (configSchema and cli:flags)
 * and automatically registered by the extension loader.
 */

import { describe, it, expect } from "bun:test";
import { ConfigRegistry, createConfigRegistry } from "../../src/core/extensions/config-registry.ts";
import { parseArgs } from "../../src/core/cli.ts";
import { loadConfig } from "../../src/core/config/index.ts";
import { getExtensionsToLoad } from "../../src/core/extensions/extensions.ts";

describe("ConfigRegistry", () => {
  describe("registerCliFlags", () => {
    it("should register CLI flags", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([
        {
          short: "-x",
          long: "--my-flag",
          description: "My test flag",
          type: "string",
          default: "default",
        },
      ]);

      const flags = registry.getCliFlags();
      expect(flags).toHaveLength(1);
      expect(flags[0]!.short).toBe("-x");
      expect(flags[0]!.long).toBe("--my-flag");
    });

    it("should reject invalid flags", () => {
      const registry = createConfigRegistry();
      expect(() => registry.registerCliFlags([{ type: "string", long: "", description: "" }])).toThrow(
        "Each CLI flag must have a short or long form",
      );
    });

    it("should generate help text", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([
        {
          short: "-x",
          long: "--my-flag",
          description: "My flag",
          type: "string",
        },
        { long: "--my-bool", description: "A bool", type: "boolean" },
      ]);

      const help = registry.getCliHelpText();
      expect(help).toContain("--my-flag");
      expect(help).toContain("--my-bool");
    });
  });

  describe("registerConfigParams", () => {
    it("should register config params", () => {
      const registry = createConfigRegistry();
      registry.registerConfigParams([
        {
          key: "myExtension",
          description: "My extension config",
          defaults: { enabled: true, timeout: 30 },
        },
      ]);

      const params = registry.getConfigParams();
      expect(params).toHaveLength(1);
      expect(params[0]!.key).toBe("myExtension");
    });

    it("should reject invalid params", () => {
      const registry = createConfigRegistry();
      expect(() => registry.registerConfigParams([{ defaults: {}, key: "", description: "" }])).toThrow(
        "Each config param must have a key",
      );
      expect(() => registry.registerConfigParams([{ key: "test", description: "" as never }] as any[])).toThrow(
        "must have a defaults object",
      );
    });

    it("should build defaults", () => {
      const registry = createConfigRegistry();
      registry.registerConfigParams([
        {
          key: "myExtension",
          description: "My extension config",
          defaults: { enabled: true, timeout: 30 },
        },
      ]);

      const defaults = registry.buildDefaults();
      expect(defaults.myExtension).toEqual({ enabled: true, timeout: 30 });
    });
  });

  describe("parseArgs with extension flags", () => {
    it("should parse extension string flags", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([
        { long: "--my-flag", description: "Test flag", type: "string" },
      ]);

      process.argv = ["node", "test", "--my-flag", "hello"];
      const options = parseArgs(registry);

      expect(options.myFlag).toBe("hello");
    });

    it("should parse extension boolean flags", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([
        { long: "--my-bool", description: "Test bool", type: "boolean" },
      ]);

      process.argv = ["node", "test", "--my-bool"];
      const options = parseArgs(registry);

      expect(options.myBool).toBe(true);
    });

    it("should parse extension number flags", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([
        { long: "--my-number", description: "Test number", type: "number" },
      ]);

      process.argv = ["node", "test", "--my-number", "42"];
      const options = parseArgs(registry);

      expect(options.myNumber).toBe(42);
    });

    it("should parse extension array flags", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([
        { long: "--my-tags", description: "Test array", type: "array" },
      ]);

      process.argv = ["node", "test", "--my-tags", "a,b,c"];
      const options = parseArgs(registry);

      expect(options.myTags).toEqual(["a", "b", "c"]);
    });

    it("should parse short flags", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([
        {
          short: "-x",
          long: "--my-flag",
          description: "Test flag",
          type: "string",
        },
      ]);

      process.argv = ["node", "test", "-x", "world"];
      const options = parseArgs(registry);

      expect(options.myFlag).toBe("world");
    });

    it("should use custom parser", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([
        {
          long: "--my-flag",
          description: "Test flag",
          type: "string",
          parse: (value) => value.toUpperCase(),
        },
      ]);

      process.argv = ["node", "test", "--my-flag", "hello"];
      const options = parseArgs(registry);

      expect(options.myFlag).toBe("HELLO");
    });
  });

  describe("loadConfig with extension params", () => {
    it("should merge extension config defaults", async () => {
      const registry = createConfigRegistry();
      registry.registerConfigParams([
        {
          key: "myExtension",
          description: "My extension config",
          defaults: { enabled: true, timeout: 30 },
        },
      ]);

      const config = await loadConfig(undefined, undefined, registry.getConfigParams());

      expect((config as unknown as Record<string, unknown>).myExtension).toEqual({ enabled: true, timeout: 30 });
    });
  });

  describe("Skills extension config", () => {
    it("should register --preload-skills CLI flag", async () => {
      const registry = createConfigRegistry();

      // Simulate skills extension registration
      registry.registerCliFlags([
        {
          long: "--preload-skills",
          description: "Preload skills by name (comma-separated)",
          type: "array",
          default: [],
        },
      ]);

      const flags = registry.getCliFlags();
      expect(flags).toHaveLength(1);
      expect(flags[0]!.long).toBe("--preload-skills");
      expect(flags[0]!.type).toBe("array");
    });

    it("should register skills config params with preloadSkills", async () => {
      const registry = createConfigRegistry();

      // Simulate skills extension registration
      registry.registerConfigParams([
        {
          key: "skills",
          description: "Skills extension configuration",
          defaults: {
            preloadSkills: [],
          },
        },
      ]);

      const params = registry.getConfigParams();
      expect(params).toHaveLength(1);
      expect(params[0]!.key).toBe("skills");

      const defaults = registry.buildDefaults();
      expect((defaults as Record<string, unknown>).skills).toBeDefined();
      expect(((defaults as Record<string, unknown>).skills as Record<string, unknown>).preloadSkills).toEqual([]);
    });
  });

  describe("ConfigRegistry constructor", () => {
    it("creates registry with empty state", () => {
      const registry = createConfigRegistry();
      expect(registry.getCliFlags()).toEqual([]);
      expect(registry.getConfigParams()).toEqual([]);
      expect(registry.buildDefaults()).toEqual({});
    });
  });

  describe("registerCliFlags — edge cases", () => {
    it("throws for non-array input", () => {
      const registry = createConfigRegistry();
      expect(() => registry.registerCliFlags("not-an-array" as unknown as Array<{ short?: string; long: string; description: string; type: string }>)).toThrow("must be an array");
    });

    it("defaults type to string when not provided", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([{ long: "--test", description: "Test flag", type: "" }]);
      expect(registry.getCliFlags()[0]!.type).toBe("string");
    });

    it("handles flags with only short form", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([{ short: "-t", long: "--test", description: "Test flag", type: "string" }]);
      const help = registry.getCliHelpText();
      expect(help).toContain("-t");
    });

    it("handles empty flags array", () => {
      const registry = createConfigRegistry();
      registry.registerCliFlags([]);
      expect(registry.getCliFlags()).toEqual([]);
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
      expect(() => registry.registerConfigSchema(123 as unknown as string, {})).toThrow("key must be a non-empty string");
    });

    it("registerConfigSchema throws for invalid schema", () => {
      const registry = createConfigRegistry();
      expect(() => registry.registerConfigSchema("key", null as unknown as Record<string, unknown>)).toThrow("schema must be a non-null object");
      expect(() => registry.registerConfigSchema("key", "not-an-object" as unknown as Record<string, unknown>)).toThrow("schema must be a non-null object");
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
          description: "Test config param",
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
  });
});
