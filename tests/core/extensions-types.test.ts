// Tests for extension config helpers in types.ts.

import { describe, it, expect } from "bun:test";
import {
  getExtensionConfig,
  getConfigSchemaProperties,
  getConfigDefault,
} from "../../src/core/extensions/types.ts";

describe("getExtensionConfig", () => {
  it("returns config block from core.config", () => {
    const core = { config: { myExtension: { enabled: true, timeout: 30 } } } as any;
    expect(getExtensionConfig<{ enabled: boolean; timeout: number }>(core, "myExtension")).toEqual({ enabled: true, timeout: 30 });
  });

  it("returns empty object for missing/null/non-object config", () => {
    expect(getExtensionConfig<{ }>({} as any, "missing")).toEqual({});
    expect(getExtensionConfig<{ }>(({ config: null } as any), "x")).toEqual({});
    expect(getExtensionConfig<{ }>(({ config: { x: "string" } } as any), "x")).toEqual({});
    expect(getExtensionConfig<{ }>(({ config: { x: ["arr"] } } as any), "x")).toEqual({});
  });

  it("validates against configRegistry schema when present", () => {
    let calledWithKey: string | undefined;
    const core = {
      config: { myExtension: { value: 42 } },
      configRegistry: {
        validateConfigByKey: (key: string, value: unknown) => {
          calledWithKey = key;
          return { valid: true, errors: [] };
        },
      },
    } as any;
    getExtensionConfig(core, "myExtension");
    expect(calledWithKey).toBe("myExtension");
  });
});

describe("getConfigSchemaProperties", () => {
  it("returns properties from config schema", () => {
    const schema = {
      myExtension: {
        type: "object",
        properties: {
          enabled: { type: "boolean", default: true },
          timeout: { type: "number", default: 30 },
        },
      },
    };
    expect(getConfigSchemaProperties(schema, "myExtension")).toEqual({
      enabled: { type: "boolean", default: true },
      timeout: { type: "number", default: 30 },
    });
  });

  it("returns empty object for missing/invalid schema", () => {
    expect(getConfigSchemaProperties(null, "x")).toEqual({});
    expect(getConfigSchemaProperties(undefined, "x")).toEqual({});
    expect(getConfigSchemaProperties({}, "missing")).toEqual({});
    expect(getConfigSchemaProperties({ x: { type: "object" } }, "x")).toEqual({});
    expect(getConfigSchemaProperties({ x: { properties: "bad" } } as any, "x")).toEqual({});
    expect(getConfigSchemaProperties({ x: [{ type: "object" }] } as any, "x")).toEqual({});
  });
});

describe("getConfigDefault", () => {
  it("returns default value from property", () => {
    const props = {
      enabled: { type: "boolean", default: true },
      timeout: { type: "number", default: 30 },
    };
    expect(getConfigDefault<boolean>(props, "enabled")).toBe(true);
    expect(getConfigDefault<number>(props, "timeout")).toBe(30);
  });

  it("returns undefined for missing/invalid property or null default", () => {
    const props = {
      enabled: { type: "boolean", default: true },
      nullDefault: { type: "boolean", default: null },
      noDefault: { type: "boolean" },
    };
    expect(getConfigDefault(props, "missing")).toBeUndefined();
    expect(getConfigDefault(props, "nullDefault")).toBeUndefined();
    expect(getConfigDefault(props, "noDefault")).toBeUndefined();
  });

  it("returns falsy defaults and complex values", () => {
    const props = {
      count: { type: "number", default: 0 },
      name: { type: "string", default: "" },
      flag: { type: "boolean", default: false },
      tags: { type: "array", default: ["a", "b"] },
      options: { type: "object", default: { nested: true } },
    };
    expect(getConfigDefault<number>(props, "count")).toBe(0);
    expect(getConfigDefault<string>(props, "name")).toBe("");
    expect(getConfigDefault<boolean>(props, "flag")).toBe(false);
    expect(getConfigDefault<string[]>(props, "tags")).toEqual(["a", "b"]);
    expect(getConfigDefault<{ nested: boolean }>(props, "options")).toEqual({ nested: true });
  });

  it("returns undefined for non-object property", () => {
    expect(getConfigDefault({ enabled: "not-an-object" } as any, "enabled")).toBeUndefined();
  });
});
