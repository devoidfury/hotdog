// Tests for schema-loader.js uncovered functions.

import { describe, it, expect } from "bun:test";
import {
  buildConfigSchema,
  getLayerDefault,
  loadExtensionSchemas,
  buildUnifiedSchema,
  cliFlagsFromSchema,
  resolveLayerValue,
  resolveModel,
  resolveModelWithProvider,
  CONFIG_SCHEMA,
} from "../../src/core/config/schema-loader.ts";

describe("buildConfigSchema", () => {
  it("returns a schema object with all keys compiled", () => {
    const schema = buildConfigSchema();
    expect(Object.keys(schema)).toHaveLength(Object.keys(CONFIG_SCHEMA).length);
    for (const [key, value] of Object.entries(schema)) {
      expect(Array.isArray(value.layers)).toBe(true);
      expect(typeof value.type).toBe("string");
    }
  });
});

describe("getLayerDefault", () => {
  it("returns undefined for null/undefined schema key", () => {
    expect(getLayerDefault(null)).toBeUndefined();
    expect(getLayerDefault(undefined)).toBeUndefined();
  });

  it("returns undefined when no layers", () => {
    expect(getLayerDefault({ type: "string" })).toBeUndefined();
  });

  it("returns default value from layer", () => {
    const schema = {
      layers: [
        { source: "cli", key: "model" },
        { default: "qwen3.5-0.8b" },
      ],
    };
    expect(getLayerDefault(schema)).toBe("qwen3.5-0.8b");
  });

  it("returns function default without calling it", () => {
    const fn = () => "dynamic";
    const schema = {
      layers: [
        { default: fn },
      ],
    };
    expect(getLayerDefault(schema)).toBe(fn);
  });

  it("returns first default found", () => {
    const schema = {
      layers: [
        { default: "first" },
        { default: "second" },
      ],
    };
    expect(getLayerDefault(schema)).toBe("first");
  });

  it("skips non-default layers", () => {
    const schema = {
      layers: [
        { source: "cli", key: "model" },
        { source: "config", key: "model" },
        { default: "fallback" },
      ],
    };
    expect(getLayerDefault(schema)).toBe("fallback");
  });
});

describe("loadExtensionSchemas", () => {
  it("returns empty object when no extensions", () => {
    expect(loadExtensionSchemas([])).toEqual({});
  });

  it("skips extensions without configSchema", () => {
    const result = loadExtensionSchemas([
      { configSchema: undefined } as any,
      { configSchema: null } as any,
      { configSchema: [] } as any,
    ]);
    expect(result).toEqual({});
  });

  it("compiles extension schemas with layers", () => {
    const extensions = [
      {
        name: "my-ext",
        configSchema: {
          myExt: {
            type: "object",
            layers: [
              { source: "cli", key: "myExt" },
              { default: {} },
            ],
          },
        },
      },
    ];
    const result = loadExtensionSchemas(extensions);
    expect(result).toHaveProperty("myExt");
    expect(Array.isArray(result.myExt!.layers)).toBe(true);
  });

  it("skips extension keys without layers", () => {
    const extensions = [
      {
        name: "my-ext",
        configSchema: {
          myExt: {
            type: "object",
            // No layers
          },
        },
      },
    ];
    const result = loadExtensionSchemas(extensions);
    expect(result).toEqual({});
  });
});

describe("buildUnifiedSchema", () => {
  it("returns schema with same keys as CONFIG_SCHEMA when no extensions", () => {
    const schema = buildUnifiedSchema();
    const coreKeys = Object.keys(CONFIG_SCHEMA).sort();
    const schemaKeys = Object.keys(schema).sort();
    expect(schemaKeys).toEqual(coreKeys);
  });

  it("merges core and extension schemas", () => {
    const extensions = [
      {
        name: "my-ext",
        configSchema: {
          myExt: {
            type: "object",
            layers: [
              { default: {} },
            ],
          },
        },
      },
    ];
    const schema = buildUnifiedSchema(extensions);
    expect(schema).toHaveProperty("baseUrl");
    expect(schema).toHaveProperty("myExt");
  });
});

describe("cliFlagsFromSchema", () => {
  it("returns empty array when no cliFlag defined", () => {
    const schema = {
      someKey: { type: "string", layers: [{ default: "test" }] },
    };
    expect(cliFlagsFromSchema(schema)).toEqual([]);
  });

  it("extracts flag definitions from schema", () => {
    const schema = {
      model: {
        type: "string",
        cliFlag: {
          short: "-m",
          long: "model",
          type: "string",
          description: "Model to use",
        },
        layers: [{ default: "test" }],
      },
      showTools: {
        type: "boolean",
        cliFlag: {
          long: "show-tools",
          type: "boolean",
          description: "Show tool calls",
        },
        layers: [{ default: false }],
      },
    };
    const flags = cliFlagsFromSchema(schema);
    expect(flags).toHaveLength(2);
    expect(flags[0]!.key).toBe("model");
    expect(flags[0]!.short).toBe("-m");
    expect(flags[0]!.long).toBe("model");
    expect(flags[0]!.hasValue).toBe(true);
    expect(flags[1]!.key).toBe("showTools");
    expect(flags[1]!.hasValue).toBe(false);
  });
});

describe("resolveLayerValue", () => {
  it("resolves default layer", () => {
    const layer = { default: "test-value" };
    expect(resolveLayerValue(layer, {})).toBe("test-value");
  });

  it("resolves default function layer", () => {
    const layer = { default: (ctx: { profileName: string }) => `value-${ctx.profileName}` };
    expect(resolveLayerValue(layer, { profileName: "my-profile" })).toBe("value-my-profile");
  });

  it("resolves from cli source", () => {
    const layer = { source: "cli", key: "model" };
    expect(resolveLayerValue(layer, { cli: { model: "gpt-4" } })).toBe("gpt-4");
  });

  it("resolves from config source", () => {
    const layer = { source: "config", key: "aiUrl" };
    expect(resolveLayerValue(layer, { config: { aiUrl: "http://test" } })).toBe("http://test");
  });

  it("resolves from env source", () => {
    const layer = { source: "env", key: "TEST_LAYER_VAR" };
    process.env.TEST_LAYER_VAR = "env-value";
    try {
      expect(resolveLayerValue(layer, {})).toBe("env-value");
    } finally {
      delete process.env.TEST_LAYER_VAR;
    }
  });

  it("resolves from provider source with dot path", () => {
    const layer = { source: "provider", path: "url" };
    expect(
      resolveLayerValue(layer, { provider: { url: "http://provider" } })
    ).toBe("http://provider");
  });

  it("resolves from provider source with nested dot path", () => {
    const layer = { source: "provider", path: "nested.value" };
    expect(
      resolveLayerValue(layer, { provider: { nested: { value: "deep" } } })
    ).toBe("deep");
  });

  it("resolves from providerDefault source", () => {
    const layer = { source: "providerDefault" };
    expect(
      resolveLayerValue(layer, {
        provider: { name: "test", models: [{ name: "model-1" }] },
      })
    ).toBe("model-1");
  });

  it("returns undefined for providerDefault with no models", () => {
    const layer = { source: "providerDefault" };
    expect(resolveLayerValue(layer, { provider: { name: "test" } })).toBeUndefined();
  });

  it("resolves from profile source", () => {
    const layer = { source: "profile", key: "role" };
    expect(
      resolveLayerValue(layer, { profile: { role: "Profile role" } })
    ).toBe("Profile role");
  });

  it("returns undefined for unknown source", () => {
    const layer = { source: "unknown", key: "x" };
    expect(resolveLayerValue(layer, {})).toBeUndefined();
  });
});

describe("resolveModel", () => {
  it("profile model takes highest priority", () => {
    expect(
      resolveModel("cli-model", "profile-model", "config-model", null, "default")
    ).toBe("profile-model");
  });

  it("profile model with provider prefix", () => {
    const provider = { name: "openai", models: [{ name: "profile-model" }, { name: "m1" }] };
    expect(
      resolveModel("cli-model", "profile-model", "config-model", provider, "default")
    ).toBe("openai/profile-model");
  });

  it("CLI model takes second priority", () => {
    expect(
      resolveModel("cli-model", undefined, "config-model", null, "default")
    ).toBe("cli-model");
  });

  it("CLI model with provider prefix", () => {
    const provider = { name: "openai", models: [{ name: "cli-model" }] };
    expect(
      resolveModel("cli-model", undefined, "config-model", provider, "default")
    ).toBe("openai/cli-model");
  });

  it("provider default model takes third priority", () => {
    expect(
      resolveModel(undefined, undefined, "config-model", { name: "provider", models: [{ name: "m1" }] }, "default")
    ).toBe("provider/m1");
  });

  it("config model takes fourth priority", () => {
    expect(
      resolveModel(undefined, undefined, "config-model", null, "default")
    ).toBe("config-model");
  });

  it("falls back to default model", () => {
    expect(
      resolveModel(undefined, undefined, null, null, "qwen3.5-0.8b")
    ).toBe("qwen3.5-0.8b");
  });

  it("returns model with provider prefix when provider matches", () => {
    expect(
      resolveModel(undefined, "gpt-4", undefined, { name: "openai", models: [{ name: "gpt-4" }, { name: "gpt-3.5" }] }, "default")
    ).toBe("openai/gpt-4");
  });

  it("returns model name as-is when provider has no matching model", () => {
    expect(
      resolveModel(undefined, "unknown-model", undefined, { name: "provider", models: [{ name: "m1" }] }, "default")
    ).toBe("unknown-model");
  });
});

describe("resolveModelWithProvider", () => {
  it("returns name as-is when already qualified", () => {
    expect(resolveModelWithProvider("openai/gpt-4", null)).toBe("openai/gpt-4");
  });

  it("returns name as-is when null", () => {
    expect(resolveModelWithProvider(null as any, undefined)).toBeNull();
  });

  it("prefixes with provider name when model found", () => {
    const provider = { name: "openai", models: [{ name: "gpt-4" }, { name: "gpt-3.5" }] };
    expect(resolveModelWithProvider("gpt-4", provider)).toBe("openai/gpt-4");
  });

  it("returns name as-is when model not found in provider", () => {
    const provider = { name: "openai", models: [{ name: "gpt-4" }] };
    expect(resolveModelWithProvider("claude", provider)).toBe("claude");
  });

  it("returns name as-is when provider is null", () => {
    expect(resolveModelWithProvider("gpt-4", undefined)).toBe("gpt-4");
  });

  it("returns name as-is when provider has no models", () => {
    expect(resolveModelWithProvider("gpt-4", { name: "test", models: [] } as any)).toBe("gpt-4");
  });
});
