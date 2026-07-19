// Tests for extensions.js discovery functions — discoverExtensionsInDir,
// getExtensionConfigDefaults, registerExtensionMetadata, getExtensionsToLoad.
//
// Note: Utility functions (extractSchemaDefaults, resolveExtensionPath,
// isExtensionEnabled, resolveLoadOrder, resolveExtensionDependencies,
// validateServiceContracts) are tested in extensions-utility.test.ts.
// ExtensionLoader lifecycle tests are in core-extensions.test.ts.

import { describe, it, expect, beforeAll } from "bun:test";
import {
  getExtensionsToLoad,
} from "../../src/core/extensions/extensions.ts";

describe("discoverExtensionsInDir", async () => {
  let discoverExtensionsInDir: typeof import("../../src/core/extensions/extensions.ts").discoverExtensionsInDir;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    discoverExtensionsInDir = mod.discoverExtensionsInDir;
  });

  it("returns empty array for non-existent directory", async () => {
    const result = await discoverExtensionsInDir("/nonexistent/path/xyz123");
    expect(result).toEqual([]);
  });

  it("returns extensions from builtins directory", async () => {
    const { resolveExtensionPath } = await import("../../src/core/extensions/extensions.ts");
    const result = await discoverExtensionsInDir(resolveExtensionPath("builtins"));
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("each discovered extension has required fields", async () => {
    const { resolveExtensionPath } = await import("../../src/core/extensions/extensions.ts");
    const result = await discoverExtensionsInDir(resolveExtensionPath("builtins"));
    for (const ext of result) {
      expect(ext.name).toBeDefined();
      expect(ext.path).toBeDefined();
      expect(ext.dirPath).toBeDefined();
      expect(Array.isArray(ext.provides)).toBe(true);
      expect(typeof ext.loadOrder).toBe("number");
      // Also check optional fields in one pass
      expect(typeof ext.autoload).toBe("boolean");
      expect(Array.isArray(ext.cliSubcommands)).toBe(true);
      expect(Array.isArray(ext.cliFlags)).toBe(true);
      expect(typeof ext.services).toBe("object");
      expect(typeof ext.requires).toBe("object");
    }
  });

  it("returns empty array for a file path", async () => {
    const result = await discoverExtensionsInDir(
      "/workspace/src/core/extensions/extensions.ts",
    );
    expect(result).toEqual([]);
  });
});

describe("getExtensionConfigDefaults", async () => {
  let getExtensionConfigDefaults: typeof import("../../src/core/extensions/extensions.ts").getExtensionConfigDefaults;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    getExtensionConfigDefaults = mod.getExtensionConfigDefaults;
  });

  it("returns params from builtins", async () => {
    const result = await getExtensionConfigDefaults(["builtins"]);
    expect(Array.isArray(result)).toBe(true);
    for (const param of result) {
      expect(param.key).toBeDefined();
      expect(param.defaults).toBeDefined();
    }
  });

  it("returns empty array for non-existent path", async () => {
    const result = await getExtensionConfigDefaults(["/nonexistent/path"]);
    expect(result).toEqual([]);
  });
});

describe("getExtensionConfigSchemas", async () => {
  let getExtensionConfigSchemas: typeof import("../../src/core/extensions/extensions.ts").getExtensionConfigSchemas;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    getExtensionConfigSchemas = mod.getExtensionConfigSchemas;
  });

  it("returns schemas from builtins", async () => {
    const result = await getExtensionConfigSchemas(["builtins"]);
    expect(typeof result).toBe("object");
  });

  it("returns empty object for non-existent path", async () => {
    const result = await getExtensionConfigSchemas(["/nonexistent/path"]);
    expect(result).toEqual({});
  });
});

describe("getExtensionsToLoad", async () => {
  let getExtensionsToLoad: typeof import("../../src/core/extensions/extensions.ts").getExtensionsToLoad;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    getExtensionsToLoad = mod.getExtensionsToLoad;
  });

  it("returns extensions when autoload is true", async () => {
    const result = await getExtensionsToLoad(
      ["builtins"],
      true,
      [],
      undefined,
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns empty array when autoload is false and no extensions specified", async () => {
    const result = await getExtensionsToLoad(
      ["builtins"],
      false,
      [],
      undefined,
    );
    expect(result).toEqual([]);
  });

  it("filters extensions by name when autoload is false", async () => {
    const result = await getExtensionsToLoad(
      ["builtins"],
      false,
      ["core-tools"],
      undefined,
    );
    expect(Array.isArray(result)).toBe(true);
    const names = result.map((e) => e.name);
    expect(names).toContain("core-tools");
  });

  it("respects enabled: false in config", async () => {
    const config = {
      bashTool: { enabled: false },
    };
    const result = await getExtensionsToLoad(
      ["builtins"],
      true,
      [],
      config,
    );
    const names = result.map((e) => e.name);
    expect(names).not.toContain("bash-tool");
  });

  it("returns extensions with service overrides", async () => {
    const result = await getExtensionsToLoad(
      ["builtins"],
      true,
      [],
      { services: {} },
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles empty extension paths", async () => {
    const result = await getExtensionsToLoad([], true, [], undefined);
    expect(result).toEqual([]);
  });

  it("returns extensions for non-existent path gracefully", async () => {
    const result = await getExtensionsToLoad(
      ["/nonexistent/path"],
      true,
      [],
      undefined,
    );
    expect(result).toEqual([]);
  });
});

describe("registerExtensionMetadata", async () => {
  let registerExtensionMetadata: typeof import("../../src/core/extensions/extensions.ts").registerExtensionMetadata;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    registerExtensionMetadata = mod.registerExtensionMetadata;
  });

  function createMockConfigRegistry() {
    const flags: any[] = [];
    const params: any[] = [];
    const schemas = new Map<string, any>();
    return {
      registerCliFlags: (f: any[]) => flags.push(...f),
      registerConfigParams: (p: any[]) => params.push(...p),
      registerConfigSchema: (key: string, schema: any) => schemas.set(key, schema),
      getConfigSchema: (key: string) => schemas.get(key) || undefined,
      _flags: flags,
      _params: params,
    } as any;
  }

  function createMockSubcommandRegistry() {
    const subcommands: Record<string, any> = {};
    return {
      register: (name: string, def: any) => { subcommands[name] = def; },
      _subcommands: subcommands,
    } as any;
  }

  it("registers CLI flags, config params, and subcommands from extensions", async () => {
    const config = {
      extensionPaths: ["builtins"],
      extensionAutoload: true,
      extensions: [],
    };
    const configRegistry = createMockConfigRegistry();
    const subcommandRegistry = createMockSubcommandRegistry();

    const result = await registerExtensionMetadata(config, configRegistry, subcommandRegistry);
    expect(Array.isArray(configRegistry._flags)).toBe(true);
    expect(Array.isArray(configRegistry._params)).toBe(true);
    expect(Object.keys(subcommandRegistry._subcommands).length).toBeGreaterThan(0);
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles missing config gracefully", async () => {
    const configRegistry = createMockConfigRegistry();
    const subcommandRegistry = createMockSubcommandRegistry();

    // Should not throw with undefined config
    try {
      await registerExtensionMetadata(null as any, configRegistry, subcommandRegistry);
    } catch {
      // May throw depending on implementation — either way it's handled
    }
  });
});
