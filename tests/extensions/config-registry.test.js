/**
 * Tests for the ConfigRegistry system.
 *
 * The ConfigRegistry allows extensions to register their own CLI flags
 * and config parameters dynamically, instead of having these hardcoded
 * in src/cli.js and src/config.js.
 *
 * Config params are now primarily defined in extension.json configSchema,
 * which is the single source of truth. Extensions can still use the
 * CONFIG_PARAMS_REGISTER hook for programmatic control.
 *
 * Usage in an extension:
 *
 *   export function create(core) {
 *     return {
 *       hooks: {
 *         [HOOKS.CONFIG_CLI_FLAGS_REGISTER]: function(configRegistry) {
 *           configRegistry.registerCliFlags([
 *             {
 *               short: '-x',
 *               long: '--my-flag',
 *               description: 'My extension flag',
 *               type: 'string',
 *               default: 'default',
 *             },
 *           ]);
 *         },
 *         // Optional: CONFIG_PARAMS_REGISTER for programmatic control
 *         [HOOKS.CONFIG_PARAMS_REGISTER]: function(configRegistry) {
 *           configRegistry.registerConfigParams([
 *             {
 *               key: 'myExtension',
 *               description: 'My extension config section',
 *               defaults: {
 *                 enabled: true,
 *                 timeout: 30,
 *               },
 *             },
 *           ]);
 *         },
 *       },
 *     };
 *   }
 */

import { describe, it, expect } from "bun:test";
import { createConfigRegistry } from "../../src/core/extensions/config-registry.js";
import { parseArgs } from "../../src/core/cli.js";
import { loadConfig } from "../../src/core/config/index.js";
import { HOOKS } from "../../src/core/hooks.js";
import {
  emitConfigRegistration,
  extractSchemaDefaults,
  isExtensionEnabled,
  getExtensionsToLoad,
} from "../../src/core/extensions/extensions.js";

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
      expect(flags[0].short).toBe("-x");
      expect(flags[0].long).toBe("--my-flag");
    });

    it("should reject invalid flags", () => {
      const registry = createConfigRegistry();
      expect(() => registry.registerCliFlags([{ type: "string" }])).toThrow(
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
      expect(params[0].key).toBe("myExtension");
    });

    it("should reject invalid params", () => {
      const registry = createConfigRegistry();
      expect(() => registry.registerConfigParams([{ defaults: {} }])).toThrow(
        "Each config param must have a key",
      );
      expect(() => registry.registerConfigParams([{ key: "test" }])).toThrow(
        "must have a defaults object",
      );
    });

    it("should build defaults", () => {
      const registry = createConfigRegistry();
      registry.registerConfigParams([
        {
          key: "myExtension",
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
          defaults: { enabled: true, timeout: 30 },
        },
      ]);

      const config = await loadConfig(null, null, registry.getConfigParams());

      expect(config.myExtension).toEqual({ enabled: true, timeout: 30 });
    });
  });

  describe("emitConfigRegistration", () => {
    it("should emit CLI flags registration hook", async () => {
      const registry = createConfigRegistry();
      const mockExtension = {
        hooks: {
          [HOOKS.CONFIG_CLI_FLAGS_REGISTER]: function (configRegistry) {
            configRegistry.registerCliFlags([
              { long: "--hook-flag", description: "Hook flag", type: "string" },
            ]);
          },
        },
      };

      await emitConfigRegistration(mockExtension, registry);

      const flags = registry.getCliFlags();
      expect(flags).toHaveLength(1);
      expect(flags[0].long).toBe("--hook-flag");
    });

    it("should emit config params registration hook", async () => {
      const registry = createConfigRegistry();
      const mockExtension = {
        hooks: {
          [HOOKS.CONFIG_PARAMS_REGISTER]: function (configRegistry) {
            configRegistry.registerConfigParams([
              {
                key: "hookConfig",
                defaults: { setting: "value" },
              },
            ]);
          },
        },
      };

      await emitConfigRegistration(mockExtension, registry);

      const params = registry.getConfigParams();
      expect(params).toHaveLength(1);
      expect(params[0].key).toBe("hookConfig");
    });
  });

  describe("Skills extension config", () => {
    it("should register --preload-skills CLI flag", async () => {
      const registry = createConfigRegistry();

      // Simulate skills extension registration
      registry.registerCliFlags([
        {
          short: null,
          long: "--preload-skills",
          description: "Preload skills by name (comma-separated)",
          type: "array",
          default: [],
        },
      ]);

      const flags = registry.getCliFlags();
      expect(flags).toHaveLength(1);
      expect(flags[0].long).toBe("--preload-skills");
      expect(flags[0].type).toBe("array");
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
      expect(params[0].key).toBe("skills");

      const defaults = registry.buildDefaults();
      expect(defaults.skills.preloadSkills).toEqual([]);
    });
  });

  describe("extractSchemaDefaults", () => {
    it("should extract one entry per namespace key with merged property defaults", () => {
      const schema = {
        myExtension: {
          type: "object",
          properties: {
            enabled: { type: "boolean", default: true },
            timeout: { type: "number", default: 30 },
            name: { type: "string" }, // no default
          },
        },
      };

      const params = extractSchemaDefaults(schema);
      expect(params).toHaveLength(1);
      expect(params[0].key).toBe("myExtension");
      expect(params[0].defaults).toEqual({
        enabled: true,
        timeout: 30,
      });
    });

    it("should handle array-type namespace keys", () => {
      const schema = {
        mcpServers: {
          type: "array",
          default: [],
          items: { type: "object" },
        },
      };

      const params = extractSchemaDefaults(schema);
      expect(params).toHaveLength(1);
      expect(params[0].key).toBe("mcpServers");
      expect(params[0].defaults).toEqual([]);
    });

    it("should return empty array for schema without properties or defaults", () => {
      const schema = {
        myExtension: {
          type: "object",
          properties: {
            name: { type: "string" },
          },
        },
      };

      const params = extractSchemaDefaults(schema);
      expect(params).toHaveLength(1);
      expect(params[0].key).toBe("myExtension");
      expect(params[0].defaults).toEqual({});
    });

    it("should return empty array for null schema", () => {
      const params = extractSchemaDefaults(null);
      expect(params).toHaveLength(0);
    });
  });

  describe("isExtensionEnabled", () => {
    it("should return true when config is null/undefined", () => {
      expect(isExtensionEnabled("bash-tool", null)).toBe(true);
      expect(isExtensionEnabled("bash-tool", undefined)).toBe(true);
    });

    it("should return true when extension config section does not exist", () => {
      const config = { someOtherConfig: {} };
      expect(isExtensionEnabled("bash-tool", config)).toBe(true);
    });

    it("should return true when enabled is not set (defaults to enabled)", () => {
      const config = { bashTool: { timeout: 5000 } };
      expect(isExtensionEnabled("bash-tool", config)).toBe(true);
    });

    it("should return true when enabled is explicitly true", () => {
      const config = { bashTool: { enabled: true } };
      expect(isExtensionEnabled("bash-tool", config)).toBe(true);
    });

    it("should return false when enabled is explicitly false", () => {
      const config = { bashTool: { enabled: false } };
      expect(isExtensionEnabled("bash-tool", config)).toBe(false);
    });

    it("should handle kebab-case extension names correctly", () => {
      const config = {
        coreTools: { enabled: true },
        modelSwitch: { enabled: false },
        sessionLog: { enabled: true },
      };
      expect(isExtensionEnabled("core-tools", config)).toBe(true);
      expect(isExtensionEnabled("model-switch", config)).toBe(false);
      expect(isExtensionEnabled("session-log", config)).toBe(true);
    });

    it("should handle single-word extension names", () => {
      const config = { skills: { enabled: false } };
      expect(isExtensionEnabled("skills", config)).toBe(false);
    });
  });
});
