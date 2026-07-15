import { describe, it, expect } from "bun:test";
import {
  getExtensionConfig,
  getConfigSchemaProperties,
  getConfigDefault,
} from "../../src/core/extensions/types.ts";

describe("getExtensionConfig", () => {
  it("returns config block from core.config", () => {
    const core = {
      config: { myExtension: { enabled: true, timeout: 30 } },
    } as any;
    const result = getExtensionConfig(core, "myExtension");
    expect(result).toEqual({ enabled: true, timeout: 30 });
  });

  it("returns empty object when config key not found", () => {
    const core = {
      config: { otherExtension: { enabled: true } },
    } as any;
    const result = getExtensionConfig(core, "myExtension");
    expect(result).toEqual({});
  });

  it("returns empty object when config is null", () => {
    const core = { config: null } as any;
    const result = getExtensionConfig(core, "myExtension");
    expect(result).toEqual({});
  });

  it("returns empty object when config block is not an object", () => {
    const core = {
      config: { myExtension: "not-an-object" },
    } as any;
    const result = getExtensionConfig(core, "myExtension");
    expect(result).toEqual({});
  });

  it("returns empty object when config block is an array", () => {
    const core = {
      config: { myExtension: ["item1", "item2"] },
    } as any;
    const result = getExtensionConfig(core, "myExtension");
    expect(result).toEqual({});
  });

  it("validates against configRegistry schema when present", () => {
    let calledWithKey: string | undefined;
    let calledWithValue: unknown;
    const core = {
      config: { myExtension: { value: 42 } },
      configRegistry: {
        validateConfigByKey: (key: string, value: unknown) => {
          calledWithKey = key;
          calledWithValue = value;
          return { valid: true, errors: [] };
        },
      },
    } as any;
    const result = getExtensionConfig(core, "myExtension");
    expect(calledWithKey).toBe("myExtension");
    expect(calledWithValue).toEqual({ value: 42 });
    expect(result).toEqual({ value: 42 });
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
    const result = getConfigSchemaProperties(schema, "myExtension");
    expect(result).toEqual({
      enabled: { type: "boolean", default: true },
      timeout: { type: "number", default: 30 },
    });
  });

  it("returns empty object when key not found", () => {
    const schema = {
      otherExtension: { type: "object", properties: {} },
    };
    const result = getConfigSchemaProperties(schema, "myExtension");
    expect(result).toEqual({});
  });

  it("returns empty object when schema is null", () => {
    const result = getConfigSchemaProperties(null, "myExtension");
    expect(result).toEqual({});
  });

  it("returns empty object when schema is undefined", () => {
    const result = getConfigSchemaProperties(undefined, "myExtension");
    expect(result).toEqual({});
  });

  it("returns empty object when block has no properties", () => {
    const schema = {
      myExtension: { type: "object" },
    };
    const result = getConfigSchemaProperties(schema, "myExtension");
    expect(result).toEqual({});
  });

  it("returns empty object when properties is not an object", () => {
    const schema = {
      myExtension: { type: "object", properties: "not-an-object" },
    } as any;
    const result = getConfigSchemaProperties(schema, "myExtension");
    expect(result).toEqual({});
  });

  it("returns empty object when block is an array", () => {
    const schema = {
      myExtension: [{ type: "object" }],
    };
    const result = getConfigSchemaProperties(schema, "myExtension");
    expect(result).toEqual({});
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

  it("returns undefined when property not found", () => {
    const props = { enabled: { type: "boolean", default: true } };
    expect(getConfigDefault(props, "missing")).toBeUndefined();
  });

  it("returns undefined when property is not an object", () => {
    const props = { enabled: "not-an-object" } as any;
    expect(getConfigDefault<boolean>(props, "enabled")).toBeUndefined();
  });

  it("returns undefined when default is null", () => {
    const props = {
      enabled: { type: "boolean", default: null },
    };
    expect(getConfigDefault<boolean>(props, "enabled")).toBeUndefined();
  });

  it("returns undefined when no default is set", () => {
    const props = {
      enabled: { type: "boolean" },
    };
    expect(getConfigDefault<boolean>(props, "enabled")).toBeUndefined();
  });

  it("returns falsy defaults like 0 and empty string", () => {
    const props = {
      count: { type: "number", default: 0 },
      name: { type: "string", default: "" },
      flag: { type: "boolean", default: false },
    };
    expect(getConfigDefault<number>(props, "count")).toBe(0);
    expect(getConfigDefault<string>(props, "name")).toBe("");
    expect(getConfigDefault<boolean>(props, "flag")).toBe(false);
  });

  it("returns complex default values", () => {
    const props = {
      tags: { type: "array", default: ["a", "b"] },
      options: { type: "object", default: { nested: true } },
    };
    expect(getConfigDefault<string[]>(props, "tags")).toEqual(["a", "b"]);
    expect(getConfigDefault<{ nested: boolean }>(props, "options")).toEqual({ nested: true });
  });
});
