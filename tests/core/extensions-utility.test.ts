// Tests for utility functions in extensions.js that are not covered by
// the ExtensionLoader tests in core-extensions.test.js.

import { describe, it, expect } from "bun:test";
import {
  extractSchemaDefaults,
  resolveExtensionPath,
  isExtensionEnabled,
  resolveLoadOrder,
  resolveExtensionDependencies,
  validateServiceContracts,
  LOAD_ORDER,
  ExtensionMetadata,
} from "../../src/core/extensions/extensions.ts";
import { ExtensionError } from "../../src/core/error.ts";

describe("extractSchemaDefaults", () => {
  it("returns empty array for null schema", () => {
    expect(extractSchemaDefaults(null)).toEqual([]);
    expect(extractSchemaDefaults(undefined)).toEqual([]);
    expect(extractSchemaDefaults({})).toEqual([]);
  });

  it("extracts defaults from object-type schema", () => {
    const schema = {
      bashTool: {
        type: "object",
        description: "Bash tool config",
        properties: {
          timeout: { type: "number", default: 30 },
          shell: { type: "string", default: "/bin/bash" },
          noDefault: { type: "string" },
        },
      },
    };
    const result = extractSchemaDefaults(schema);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe("bashTool");
    expect(result[0]!.description).toBe("Bash tool config");
    expect(result[0]!.defaults).toEqual({
      timeout: 30,
      shell: "/bin/bash",
    });
    expect(result[0]!.schema).toBe(schema.bashTool);
  });

  it("extracts defaults from array-type schema with direct default", () => {
    const schema = {
      extensions: {
        type: "array",
        default: ["bash-tool", "read-tool"],
      },
    };
    const result = extractSchemaDefaults(schema);
    expect(result).toHaveLength(1);
    expect(result[0]!.key).toBe("extensions");
    expect(result[0]!.defaults).toEqual(["bash-tool", "read-tool"]);
  });

  it("includes layers when present", () => {
    const schema = {
      myExt: {
        type: "object",
        layers: [{ source: "cli", key: "myExt" }],
        properties: {
          enabled: { type: "boolean", default: true },
        },
      },
    };
    const result = extractSchemaDefaults(schema);
    expect(result[0]!.layers).toEqual([{ source: "cli", key: "myExt" }]);
  });

  it("handles schema without defaults", () => {
    const schema = {
      myExt: {
        type: "object",
        properties: {
          name: { type: "string" },
        },
      },
    };
    const result = extractSchemaDefaults(schema);
    expect(result).toHaveLength(1);
    expect(result[0]!.defaults).toEqual({});
  });
});

describe("resolveExtensionPath", () => {
  it("resolves 'builtins' to the extensions directory", () => {
    const resolved = resolveExtensionPath("builtins");
    expect(resolved).toContain("extensions");
    expect(resolved.endsWith("extensions")).toBe(true);
  });

  it("returns absolute paths as-is", () => {
    expect(resolveExtensionPath("/absolute/path")).toBe("/absolute/path");
  });

  it("resolves relative paths against CWD", () => {
    const resolved = resolveExtensionPath("./my-extensions");
    expect(resolved).toContain("my-extensions");
    expect(resolved.startsWith(process.cwd())).toBe(true);
  });
});

describe("isExtensionEnabled", () => {
  it("returns true when config is null", () => {
    expect(isExtensionEnabled("bash-tool", null)).toBe(true);
    expect(isExtensionEnabled("bash-tool", undefined)).toBe(true);
  });

  it("returns true when extension config is not present", () => {
    const config = { otherKey: "value" };
    expect(isExtensionEnabled("bash-tool", config)).toBe(true);
  });

  it("returns true when enabled is not set (defaults to enabled)", () => {
    const config = { bashTool: { timeout: 30 } };
    expect(isExtensionEnabled("bash-tool", config)).toBe(true);
  });

  it("returns true when enabled is explicitly true", () => {
    const config = { bashTool: { enabled: true } };
    expect(isExtensionEnabled("bash-tool", config)).toBe(true);
  });

  it("returns false when enabled is false", () => {
    const config = { bashTool: { enabled: false } };
    expect(isExtensionEnabled("bash-tool", config)).toBe(false);
  });

  it("converts kebab-case extension name to camelCase config key", () => {
    const config = { myCoolExt: { enabled: false } };
    expect(isExtensionEnabled("my-cool-ext", config)).toBe(false);
    expect(isExtensionEnabled("my-cool-ext", { myCoolExt: {} })).toBe(true);
  });

  it("handles multi-kebab-case names", () => {
    const config = { mySuperCoolExt: { enabled: false } };
    expect(isExtensionEnabled("my-super-cool-ext", config)).toBe(false);
  });
});

describe("LOAD_ORDER", () => {
  it("has correct constants", () => {
    expect(LOAD_ORDER.REFRESH).toBe(0);
    expect(LOAD_ORDER.CORE_TOOLS).toBe(1);
    expect(LOAD_ORDER.CLI).toBe(2);
    expect(LOAD_ORDER.DEFAULT).toBe(10);
  });
});

describe("resolveLoadOrder", () => {
  it("respects loadOrder priority for independent extensions", () => {
    const extensions = [
      { name: "cli", loadOrder: 2, dependsOn: [], requires: {} },
      { name: "tools", loadOrder: 1, dependsOn: [], requires: {} },
    ];
    const result = resolveLoadOrder(extensions as any);
    expect(result[0]!.name).toBe("tools");
    expect(result[1]!.name).toBe("cli");
  });

  it("handles no dependencies — alphabetical order", () => {
    const extensions = [
      { name: "b", loadOrder: 10, dependsOn: [], requires: {} },
      { name: "a", loadOrder: 10, dependsOn: [], requires: {} },
    ];
    const result = resolveLoadOrder(extensions as any);
    expect(result.map((e) => e.name)).toEqual(["a", "b"]);
  });

  it("throws on circular dependency", () => {
    const extensions = [
      { name: "a", loadOrder: 10, dependsOn: ["b"], requires: {} },
      { name: "b", loadOrder: 10, dependsOn: ["a"], requires: {} },
    ];
    expect(() => resolveLoadOrder(extensions as any)).toThrow(/Circular dependency/);
  });

  it("filters out unknown dependsOn entries", () => {
    const extensions = [
      { name: "a", loadOrder: 10, dependsOn: ["nonexistent"], requires: {} },
    ];
    const result = resolveLoadOrder(extensions as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe("a");
  });

  it("resolves abstract service dependencies", () => {
    const extensions = [
      {
        name: "session-provider",
        loadOrder: 10,
        dependsOn: [],
        requires: {},
        services: { session: ["list", "get"] },
      },
      {
        name: "session-user",
        loadOrder: 10,
        dependsOn: [],
        requires: { session: ["list"] },
        services: {},
      },
    ];
    const result = resolveLoadOrder(extensions as any);
    const names = result.map((e) => e.name);
    expect(names.indexOf("session-provider")).toBeLessThan(
      names.indexOf("session-user"),
    );
  });

  it("uses serviceOverrides to pick service provider", () => {
    const extensions = [
      {
        name: "provider-a",
        loadOrder: 10,
        dependsOn: [],
        requires: {},
        services: { myService: ["doStuff"] },
      },
      {
        name: "provider-b",
        loadOrder: 10,
        dependsOn: [],
        requires: {},
        services: { myService: ["doStuff"] },
      },
      {
        name: "user",
        loadOrder: 10,
        dependsOn: [],
        requires: { myService: ["doStuff"] },
        services: {},
      },
    ];
    const result = resolveLoadOrder(extensions as any, { myService: "provider-b" });
    const names = result.map((e) => e.name);
    expect(names.indexOf("provider-b")).toBeLessThan(names.indexOf("user"));
  });

  it("handles single-level dependency", () => {
    const extensions = [
      { name: "a", loadOrder: 1, dependsOn: [], requires: {} },
      { name: "b", loadOrder: 2, dependsOn: ["a"], requires: {} },
    ];
    const result = resolveLoadOrder(extensions as any);
    expect(result.map((e) => e.name)).toEqual(["a", "b"]);
  });
});

describe("resolveExtensionDependencies", () => {
  it("includes transitive dependencies", () => {
    const allDiscovered = [
      { name: "a", loadOrder: 1, dependsOn: [], requires: {}, services: {}, provides: [] },
      { name: "b", loadOrder: 1, dependsOn: ["a"], requires: {}, services: {}, provides: [] },
      { name: "c", loadOrder: 1, dependsOn: ["b"], requires: {}, services: {}, provides: [] },
    ];
    const selected = [{ name: "c", loadOrder: 1, dependsOn: ["b"], requires: {}, services: {}, provides: [] }];
    const result = resolveExtensionDependencies(selected as any, allDiscovered as any);
    const names = result.map((e) => e.name);
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).toContain("c");
  });

  it("includes service provider dependencies", () => {
    const allDiscovered = [
      {
        name: "provider",
        loadOrder: 10,
        dependsOn: [],
        requires: {},
        services: { session: ["list"] },
        provides: [],
      },
      {
        name: "user",
        loadOrder: 10,
        dependsOn: [],
        requires: { session: ["list"] },
        services: {},
        provides: [],
      },
    ];
    const selected = [allDiscovered.find((e) => e.name === "user")!];
    const result = resolveExtensionDependencies(selected as any, allDiscovered as any);
    const names = result.map((e) => e.name);
    expect(names).toContain("provider");
    expect(names).toContain("user");
  });

  it("returns empty array for empty input", () => {
    expect(resolveExtensionDependencies([], [])).toEqual([]);
  });

  it("does not include self as dependency", () => {
    const allDiscovered = [
      {
        name: "self-service",
        loadOrder: 10,
        dependsOn: [],
        requires: { myService: ["do"] },
        services: { myService: ["do"] },
        provides: [],
      },
    ];
    const selected = [allDiscovered[0]];
    const result = resolveExtensionDependencies(selected as any, allDiscovered as any);
    expect(result.map((e) => e.name)).toEqual(["self-service"]);
  });
});

describe("validateServiceContracts", () => {
  function createMockServiceRegistry() {
    const services = new Map<string, Record<string, unknown>>();
    return {
      has: (name: string) => services.has(name),
      register: (name: string, impl: Record<string, unknown>) => services.set(name, impl),
      checkContract: (serviceName: string, expectedMethods: string[]) => {
        const service = services.get(serviceName);
        if (!service) return { valid: false, missing: expectedMethods };
        const missing = expectedMethods.filter(
          (m: string) => typeof service[m] !== "function",
        );
        return { valid: missing.length === 0, missing };
      },
    };
  }

  it("returns no errors when all contracts are satisfied", () => {
    const registry = createMockServiceRegistry();
    registry.register("session", { list: () => [], get: () => {} });

    const extensions = [
      {
        name: "my-ext",
        requires: { session: ["list", "get"] },
      },
    ];
    const errors = validateServiceContracts(extensions as any, registry);
    expect(errors).toEqual([]);
  });

  it("returns error when service is missing entirely", () => {
    const registry = createMockServiceRegistry();

    const extensions = [
      {
        name: "my-ext",
        requires: { session: ["list", "get"] },
      },
    ];
    const errors = validateServiceContracts(extensions as any, registry);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.extension).toBe("my-ext");
    expect(errors[0]!.service).toBe("session");
    expect(errors[0]!.missing).toEqual(["list", "get"]);
  });

  it("returns error when some methods are missing", () => {
    const registry = createMockServiceRegistry();
    registry.register("session", { list: () => [] });

    const extensions = [
      {
        name: "my-ext",
        requires: { session: ["list", "get", "create"] },
      },
    ];
    const errors = validateServiceContracts(extensions as any, registry);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.missing).toEqual(["get", "create"]);
  });

  it("skips extensions without requires", () => {
    const registry = createMockServiceRegistry();

    const extensions = [
      { name: "no-requires", requires: null },
      { name: "no-requires-field" },
      { name: "empty-requires", requires: {} },
    ];
    const errors = validateServiceContracts(extensions as any, registry);
    expect(errors).toEqual([]);
  });

  it("handles multiple extensions with errors", () => {
    const registry = createMockServiceRegistry();
    registry.register("session", { list: () => [] });

    const extensions = [
      {
        name: "ext-a",
        requires: { session: ["list", "get"] },
      },
      {
        name: "ext-b",
        requires: { resourceLoader: ["read"] },
      },
    ];
    const errors = validateServiceContracts(extensions as any, registry);
    expect(errors).toHaveLength(2);
    expect(errors[0]!.extension).toBe("ext-a");
    expect(errors[1]!.extension).toBe("ext-b");
  });
});
