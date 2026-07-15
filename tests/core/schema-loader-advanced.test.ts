// Advanced tests for schema-loader.ts — resolveCast, resolveCompute,
// compileSchemaKey, resolveExtensionConfig, and edge cases.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  resolveCast,
  resolveCompute,
  compileSchemaKey,
  resolveKey,
  resolveAll,
  resolveExtensionConfig,
  buildConfigSchema,
  CONFIG_SCHEMA,
} from "../../src/core/config/schema-loader.ts";

describe("resolveCast", () => {
  it("returns null for non-string input", () => {
    expect(resolveCast(123)).toBeNull();
    expect(resolveCast(null)).toBeNull();
    expect(resolveCast(undefined)).toBeNull();
    expect(resolveCast({})).toBeNull();
  });

  it("returns function for known cast names", () => {
    expect(typeof resolveCast("truthy")).toBe("function");
    expect(typeof resolveCast("falsy")).toBe("function");
    expect(typeof resolveCast("number")).toBe("function");
    expect(typeof resolveCast("string")).toBe("function");
    expect(typeof resolveCast("any")).toBe("function");
    expect(typeof resolveCast("array")).toBe("function");
  });

  it("returns null for unknown cast name", () => {
    expect(resolveCast("unknown")).toBeNull();
  });

  it("passes through function input", () => {
    const fn = (v: unknown) => v;
    expect(resolveCast(fn)).toBe(fn);
  });
});

describe("CAST_BUILTINS", () => {
  describe("truthy", () => {
    const truthy = resolveCast("truthy")!;

    it("casts booleans through", () => {
      expect(truthy(true)).toBe(true);
      expect(truthy(false)).toBe(false);
    });

    it("casts truthy strings/numbers to true", () => {
      for (const v of [1, 42, "true", "on", "1", "TRUE", "On", "  true  "]) {
        expect(truthy(v)).toBe(true);
      }
    });

    it("casts falsy strings/numbers to false", () => {
      for (const v of [0, "false", "off", "0", "FALSE", "OFF", "  false  "]) {
        expect(truthy(v)).toBe(false);
      }
    });

    it("returns undefined for unrecognized values", () => {
      expect(truthy("yes")).toBeUndefined();
      expect(truthy("no")).toBeUndefined();
      expect(truthy({})).toBeUndefined();
      expect(truthy([])).toBeUndefined();
    });
  });

  describe("falsy", () => {
    const falsy = resolveCast("falsy")!;

    it("negates boolean and string values", () => {
      expect(falsy(true)).toBe(false);
      expect(falsy(false)).toBe(true);
      expect(falsy("true")).toBe(false);
      expect(falsy("false")).toBe(true);
    });

    it("returns undefined for unrecognized input", () => {
      expect(falsy("yes")).toBeUndefined();
    });
  });

  describe("number", () => {
    const number = resolveCast("number")!;

    it("passes numbers through", () => {
      expect(number(42)).toBe(42);
      expect(number(-10)).toBe(-10);
      expect(number(3.14)).toBe(3.14);
    });

    it("parses numeric strings", () => {
      expect(number("42")).toBe(42);
      expect(number("  42  ")).toBe(42);
      expect(number("-10")).toBe(-10);
    });

    it("returns undefined for non-numeric input", () => {
      expect(number("abc")).toBeUndefined();
      expect(number("")).toBeUndefined();
      expect(number("   ")).toBeUndefined();
      expect(number({})).toBeUndefined();
      expect(number(null)).toBeUndefined();
      expect(number(true)).toBeUndefined();
    });
  });

  describe("string", () => {
    const string = resolveCast("string")!;

    it("trims and returns non-empty strings", () => {
      expect(string("hello")).toBe("hello");
      expect(string("  hello  ")).toBe("hello");
    });

    it("returns undefined for empty or non-strings", () => {
      expect(string("")).toBeUndefined();
      expect(string("   ")).toBeUndefined();
      expect(string(42)).toBeUndefined();
      expect(string(null)).toBeUndefined();
    });
  });

  describe("any", () => {
    const any = resolveCast("any")!;

    it("accepts any value as-is", () => {
      expect(any(42)).toBe(42);
      expect(any("hello")).toBe("hello");
      expect(any(null)).toBeNull();
      expect(any(undefined)).toBeUndefined();
      expect(any({})).toEqual({});
    });
  });

  describe("array", () => {
    const array = resolveCast("array")!;

    it("accepts arrays", () => {
      expect(array([1, 2, 3])).toEqual([1, 2, 3]);
    });

    it("returns undefined for non-arrays", () => {
      expect(array("not-array")).toBeUndefined();
      expect(array({})).toBeUndefined();
      expect(array(null)).toBeUndefined();
    });
  });
});

describe("resolveCompute", () => {
  it("returns null for non-string input", () => {
    expect(resolveCompute(123)).toBeNull();
    expect(resolveCompute(null)).toBeNull();
  });

  it("parses name('arg') form", () => {
    const fn = resolveCompute("joinConfigDir('skills')")!;
    expect(typeof fn).toBe("function");
    const result = fn!({ configDir: "/tmp/config" });
    expect(result).toBe("/tmp/config/skills");
  });

  it("parses name:arg form", () => {
    const fn = resolveCompute("joinConfigDir:profiles");
    expect(typeof fn).toBe("function");
    const result = fn!({ configDir: "/tmp/config" });
    expect(result).toBe("/tmp/config/profiles");
  });

  it("returns null for unknown compute name", () => {
    expect(resolveCompute("unknown('arg')")).toBeNull();
  });

  it("handles fallback when configDir not available", () => {
    const fn = resolveCompute("joinConfigDir('skills')");
    const result = fn!({});
    expect(result).toContain("skills");
  });

  it("handles unknown subpath in fallback", () => {
    const fn = resolveCompute("joinConfigDir('custom')");
    const result = fn!({});
    expect(result).toContain("custom");
  });

  it("handles JSON-parsable arguments", () => {
    const fn = resolveCompute("joinConfigDir('\"prompts\"')");
    expect(typeof fn).toBe("function");
  });
});

describe("compileSchemaKey", () => {
  it("resolves cast strings to functions", () => {
    const rawKey = {
      type: "boolean",
      layers: [
        { source: "cli", key: "hideTools", cast: "truthy" },
        { default: true },
      ],
    };
    const compiled = compileSchemaKey(rawKey);
    expect(typeof compiled.layers![0]!.cast).toBe("function");
  });

  it("resolves compute to default function", () => {
    const rawKey = {
      type: "string",
      layers: [
        { source: "cli", key: "dataPath" },
        { compute: "joinConfigDir('data')" },
        { default: "./config/data" },
      ],
    };
    const compiled = compileSchemaKey(rawKey);
    // The compute layer should be converted to a default layer with function
    expect(typeof compiled.layers![1]!.default).toBe("function");
    expect(compiled.layers![1]!.compute).toBeUndefined();
  });

  it("compiles nested property layers", () => {
    const rawKey = {
      type: "object",
      layers: [{ default: {} }],
      properties: {
        apiKey: {
          type: "string",
          layers: [
            { source: "cli", key: "webui.apiKey", cast: "string" },
            { default: null },
          ],
        },
      },
    };
    const compiled = compileSchemaKey(rawKey);
    expect(compiled.properties).toBeDefined();
    expect(typeof compiled.properties!.apiKey!.layers![0]!.cast).toBe("function");
  });

  it("handles key without layers", () => {
    const rawKey = { type: "string", layers: [] };
    const compiled = compileSchemaKey(rawKey);
    expect(compiled.type).toBe("string");
    expect(compiled.layers).toEqual([]);
  });

  it("preserves other properties", () => {
    const rawKey = {
      type: "string",
      description: "Test key",
      cliFlag: { long: "test" },
      layers: [{ default: "value" }],
    };
    const compiled = compileSchemaKey(rawKey);
    expect(compiled.description).toBe("Test key");
    expect(compiled.cliFlag!.long).toBe("test");
  });
});

describe("resolveAll", () => {
  it("resolves all keys in schema", () => {
    const schema = buildConfigSchema();
    const context = {
      cli: {},
      config: {},
      provider: null,
      profile: null,
      profileName: "default",
    };

    const result = resolveAll(schema, context);
    // Should resolve all keys in the schema
    for (const key of Object.keys(schema)) {
      expect(result).toHaveProperty(key);
    }
  });

  it("resolves with CLI overrides", () => {
    const schema = buildConfigSchema();
    const context = {
      cli: { model: "cli-model" },
      config: { defaultModel: "config-model" },
      provider: null,
      profile: null,
      profileName: "default",
    };

    const result = resolveAll(schema, context);
    // defaultModel resolves from cli.model first per schema layers
    expect(result.defaultModel).toBe("cli-model");
  });
});

describe("resolveExtensionConfig", () => {
  it("returns empty object when no params have layers", () => {
    const extParams = [
      { key: "ext1", defaults: { enabled: true } },
    ];
    const result = resolveExtensionConfig(extParams, {});
    expect(result).toEqual({});
  });

  it("resolves extension params with layers", () => {
    const extParams = [
      {
        key: "myExt",
        schema: { type: "object" },
        defaults: { enabled: true },
        layers: [
          { source: "config", key: "myExt" },
          { default: { enabled: true } },
        ],
      },
    ];
    const context = {
      cli: {},
      config: { myExt: { timeout: 30 } },
    };
    const result = resolveExtensionConfig(extParams, context);
    expect(result.myExt).toEqual({ timeout: 30 });
  });

  it("skips params without layers", () => {
    const extParams = [
      { key: "noLayers", defaults: "value" },
      {
        key: "withLayers",
        layers: [{ default: "default-value" }],
      },
    ];
    const result = resolveExtensionConfig(extParams, { cli: {}, config: {} });
    expect(result.noLayers).toBeUndefined();
    expect(result.withLayers).toBe("default-value");
  });
});

describe("resolveKey — edge cases", () => {
  it("returns undefined when no layers match", () => {
    const schema = {
      layers: [
        { source: "cli", key: "nonexistent" },
      ],
    };
    const result = resolveKey("test", schema, { cli: {} });
    expect(result).toBeUndefined();
  });

  it("skips null values before cast", () => {
    const schema = {
      layers: [
        { source: "cli", key: "model" },
        { default: "fallback" },
      ],
    };
    const result = resolveKey("test", schema, { cli: { model: null } });
    expect(result).toBe("fallback");
  });

  it("skips empty string values before cast", () => {
    const schema = {
      layers: [
        { source: "cli", key: "model" },
        { default: "fallback" },
      ],
    };
    const result = resolveKey("test", schema, { cli: { model: "" } });
    expect(result).toBe("fallback");
  });

  it("skips undefined values before cast", () => {
    const schema = {
      layers: [
        { source: "cli", key: "model" },
        { default: "fallback" },
      ],
    };
    const result = resolveKey("test", schema, { cli: { model: undefined } });
    expect(result).toBe("fallback");
  });

  it("default layer with null value returns null (not skipped)", () => {
    const schema = {
      layers: [
        { source: "cli", key: "model" },
        { default: null },
      ],
    };
    const result = resolveKey("test", schema, { cli: {} });
    expect(result).toBeNull();
  });

  it("cast function returning undefined skips to next layer", () => {
    const schema = {
      layers: [
        { source: "cli", key: "flag", cast: resolveCast("truthy") },
        { default: true },
      ],
    };
    // "yes" is not recognized by truthy, so it returns undefined and skips
    const result = resolveKey("test", schema, { cli: { flag: "yes" } });
    expect(result).toBe(true);
  });

  it("cast function returning a value accepts that layer", () => {
    const schema = {
      layers: [
        { source: "cli", key: "flag", cast: resolveCast("truthy") },
        { default: true },
      ],
    };
    const result = resolveKey("test", schema, { cli: { flag: "on" } });
    expect(result).toBe(true);
  });

  it("resolveKey with cast returning undefined for number", () => {
    const schema = {
      layers: [
        { source: "cli", key: "timeout", cast: resolveCast("number") },
        { default: 60 },
      ],
    };
    const result = resolveKey("test", schema, { cli: { timeout: "abc" } });
    expect(result).toBe(60);
  });

  it("resolveKey with string cast trims whitespace", () => {
    const schema = {
      layers: [
        { source: "cli", key: "name", cast: resolveCast("string") },
        { default: "fallback" },
      ],
    };
    const result = resolveKey("test", schema, { cli: { name: "  hello  " } });
    expect(result).toBe("hello");
  });

  it("resolveKey with string cast returns undefined for empty", () => {
    const schema = {
      layers: [
        { source: "cli", key: "name", cast: resolveCast("string") },
        { default: "fallback" },
      ],
    };
    const result = resolveKey("test", schema, { cli: { name: "   " } });
    expect(result).toBe("fallback");
  });

  it("resolveKey with array cast", () => {
    const schema = {
      layers: [
        { source: "cli", key: "items", cast: resolveCast("array") },
        { default: [] },
      ],
    };
    const result = resolveKey("test", schema, { cli: { items: [1, 2] } });
    expect(result).toEqual([1, 2]);
  });

  it("resolveKey with array cast rejects non-arrays", () => {
    const schema = {
      layers: [
        { source: "cli", key: "items", cast: resolveCast("array") },
        { default: ["default"] },
      ],
    };
    const result = resolveKey("test", schema, { cli: { items: "not-array" } });
    expect(result).toEqual(["default"]);
  });

  it("resolveKey with falsy cast", () => {
    const schema = {
      layers: [
        { source: "cli", key: "noLog", cast: resolveCast("falsy") },
        { default: false },
      ],
    };
    // "true" with falsy cast → false
    const result = resolveKey("test", schema, { cli: { noLog: "true" } });
    expect(result).toBe(false);
  });

  it("resolveKey with env source", () => {
    const schema = {
      layers: [
        { source: "env", key: "TEST_RESOLVE_VAR" },
        { default: "fallback" },
      ],
    };
    process.env.TEST_RESOLVE_VAR = "env-value";
    try {
      const result = resolveKey("test", schema, {});
      expect(result).toBe("env-value");
    } finally {
      delete process.env.TEST_RESOLVE_VAR;
    }
  });

  it("resolveKey with provider source", () => {
    const schema = {
      layers: [
        { source: "provider", path: "url" },
        { default: "http://default" },
      ],
    };
    const result = resolveKey("test", schema, {
      provider: { url: "http://custom" },
    });
    expect(result).toBe("http://custom");
  });

  it("resolveKey with profile source", () => {
    const schema = {
      layers: [
        { source: "profile", key: "role" },
        { default: "default role" },
      ],
    };
    const result = resolveKey("test", schema, {
      profile: { role: "Profile role" },
    });
    expect(result).toBe("Profile role");
  });

  it("resolveKey with providerDefault source", () => {
    const schema = {
      layers: [
        { source: "providerDefault" },
        { default: "qwen3.5-0.8b" },
      ],
    };
    const result = resolveKey("test", schema, {
      provider: { name: "test", models: [{ name: "m1" }] },
    });
    expect(result).toBe("m1");
  });

  it("resolveKey with compute function default", () => {
    const schema = {
      layers: [
        { source: "cli", key: "dataPath", cast: resolveCast("string") },
        { default: resolveCompute("joinConfigDir('data')") },
      ],
    };
    const result = resolveKey("test", schema, { cli: {}, configDir: "/tmp/config" });
    expect(result).toBe("/tmp/config/data");
  });

  it("resolveKey with any cast", () => {
    const schema = {
      layers: [
        { source: "cli", key: "value", cast: resolveCast("any") },
        { default: "fallback" },
      ],
    };
    const result = resolveKey("test", schema, { cli: { value: 0 } });
    // 0 is not null/undefined/empty, so it passes through any cast
    expect(result).toBe(0);
  });

  it("resolves nested properties for object types", () => {
    const schema = {
      type: "object",
      layers: [
        { default: { host: "localhost", port: 8080 } },
      ],
      properties: {
        host: {
          type: "string",
          layers: [
            { source: "cli", key: "webui.host", cast: resolveCast("string") },
          ],
        },
        port: {
          type: "number",
          layers: [
            { source: "cli", key: "webui.port", cast: resolveCast("number") },
          ],
        },
      },
    };

    // Without CLI overrides, defaults should be preserved
    const result = resolveKey("webui", schema, { cli: {} }) as Record<string, unknown>;
    expect(result.host).toBe("localhost");
    expect(result.port).toBe(8080);
  });

  it("overrides nested properties with CLI values", () => {
    const schema = {
      type: "object",
      layers: [
        { default: { host: "localhost", port: 8080 } },
      ],
      properties: {
        host: {
          type: "string",
          layers: [
            { source: "cli", key: "webui.host", cast: resolveCast("string") },
          ],
        },
        port: {
          type: "number",
          layers: [
            { source: "cli", key: "webui.port", cast: resolveCast("number") },
          ],
        },
      },
    };

    const result = resolveKey("webui", schema, { cli: { "webui.host": "0.0.0.0", "webui.port": "9000" } }) as Record<string, unknown>;
    expect(result.host).toBe("0.0.0.0");
    expect(result.port).toBe(9000);
  });

  it("handles non-object parent value in resolveNestedProperties", () => {
    const schema = {
      type: "object",
      layers: [
        { default: "string-instead-of-object" },
      ],
      properties: {
        host: { type: "string", layers: [{ default: "localhost" }] },
      },
    };

    // Non-object default should pass through without nested resolution
    const result = resolveKey("test", schema, { cli: {} });
    expect(result).toBe("string-instead-of-object");
  });

  it("handles null parent value in resolveNestedProperties", () => {
    const schema = {
      type: "object",
      layers: [
        { default: null },
      ],
      properties: {
        host: { type: "string", layers: [{ default: "localhost" }] },
      },
    };

    const result = resolveKey("test", schema, { cli: {} });
    expect(result).toBeNull();
  });

  it("applies defaults for properties without layers", () => {
    const schema = {
      type: "object",
      layers: [
        { default: {} },
      ],
      properties: {
        host: { type: "string", default: "default-host" },
        port: { type: "number", default: 8080 },
      },
    };

    const result = resolveKey("server", schema, { cli: {} }) as Record<string, unknown>;
    expect(result.host).toBe("default-host");
    expect(result.port).toBe(8080);
  });

  it("does not override existing parent values with property defaults", () => {
    const schema = {
      type: "object",
      layers: [
        { default: { host: "explicit-host", port: 3000 } },
      ],
      properties: {
        host: { type: "string", default: "default-host" },
        port: { type: "number", default: 8080 },
      },
    };

    const result = resolveKey("server", schema, { cli: {} }) as Record<string, unknown>;
    // Parent values should take precedence over property defaults
    expect(result.host).toBe("explicit-host");
    expect(result.port).toBe(3000);
  });
});
