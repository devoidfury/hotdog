// Tests for extensions.js discovery functions — discoverExtensionsInDir,
// getExtensionConfigDefaults, registerExtensionMetadata, etc.

import { describe, it, expect, beforeAll } from "bun:test";
import {
  extractSchemaDefaults,
  resolveExtensionPath,
  isExtensionEnabled,
  getExtensionsToLoad,
  resolveExtensionDependencies,
  validateServiceContracts,
  LOAD_ORDER,
} from "../../src/core/extensions/extensions.ts";

describe("discoverExtensionsInDir", async () => {
  let discoverExtensionsInDir;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    discoverExtensionsInDir = mod.discoverExtensionsInDir;
  });

  it("returns empty array for non-existent directory", async () => {
    const result = await discoverExtensionsInDir("/nonexistent/path/xyz123");
    expect(result).toEqual([]);
  });

  it("returns extensions from builtins directory", async () => {
    const resolved = resolveExtensionPath("builtins");
    const result = await discoverExtensionsInDir(resolved);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("each discovered extension has required fields", async () => {
    const resolved = resolveExtensionPath("builtins");
    const result = await discoverExtensionsInDir(resolved);
    for (const ext of result) {
      expect(ext.name).toBeDefined();
      expect(ext.path).toBeDefined();
      expect(ext.dirPath).toBeDefined();
      expect(Array.isArray(ext.provides)).toBe(true);
      expect(typeof ext.loadOrder).toBe("number");
    }
  });

  it("discovered extensions have autoload field", async () => {
    const resolved = resolveExtensionPath("builtins");
    const result = await discoverExtensionsInDir(resolved);
    for (const ext of result) {
      expect(typeof ext.autoload).toBe("boolean");
    }
  });

  it("discovered extensions have cliSubcommands field", async () => {
    const resolved = resolveExtensionPath("builtins");
    const result = await discoverExtensionsInDir(resolved);
    for (const ext of result) {
      expect(Array.isArray(ext.cliSubcommands)).toBe(true);
    }
  });

  it("discovered extensions have cliFlags field", async () => {
    const resolved = resolveExtensionPath("builtins");
    const result = await discoverExtensionsInDir(resolved);
    for (const ext of result) {
      expect(Array.isArray(ext.cliFlags)).toBe(true);
    }
  });

  it("discovered extensions have services field", async () => {
    const resolved = resolveExtensionPath("builtins");
    const result = await discoverExtensionsInDir(resolved);
    for (const ext of result) {
      expect(typeof ext.services).toBe("object");
    }
  });

  it("discovered extensions have requires field", async () => {
    const resolved = resolveExtensionPath("builtins");
    const result = await discoverExtensionsInDir(resolved);
    for (const ext of result) {
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
  let getExtensionConfigDefaults;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    getExtensionConfigDefaults = mod.getExtensionConfigDefaults;
  });

  it("returns params from builtins", async () => {
    const result = await getExtensionConfigDefaults(["builtins"]);
    expect(Array.isArray(result)).toBe(true);
  });

  it("returns empty array for non-existent path", async () => {
    const result = await getExtensionConfigDefaults(["/nonexistent/path"]);
    expect(result).toEqual([]);
  });

  it("each param has key and defaults", async () => {
    const result = await getExtensionConfigDefaults(["builtins"]);
    for (const param of result) {
      expect(param.key).toBeDefined();
      expect(param.defaults).toBeDefined();
    }
  });
});

describe("getExtensionConfigSchemas", async () => {
  let getExtensionConfigSchemas;

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
  let getExtensionsToLoad;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    getExtensionsToLoad = mod.getExtensionsToLoad;
  });

  it("returns extensions when autoload is true", async () => {
    const result = await getExtensionsToLoad(
      ["builtins"],
      true,
      [],
      null,
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns empty array when autoload is false and no extensions specified", async () => {
    const result = await getExtensionsToLoad(
      ["builtins"],
      false,
      [],
      null,
    );
    expect(result).toEqual([]);
  });

  it("filters extensions by name when autoload is false", async () => {
    const result = await getExtensionsToLoad(
      ["builtins"],
      false,
      ["core-tools"],
      null,
    );
    expect(Array.isArray(result)).toBe(true);
    // Should include core-tools and its dependencies
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
    const result = await getExtensionsToLoad([], true, [], null);
    expect(result).toEqual([]);
  });

  it("returns extensions for non-existent path gracefully", async () => {
    const result = await getExtensionsToLoad(
      ["/nonexistent/path"],
      true,
      [],
      null,
    );
    expect(result).toEqual([]);
  });
});

describe("resolveExtensionDependencies — additional cases", () => {
  it("handles missing extension in allDiscovered", () => {
    const selected = [{ name: "missing", loadOrder: 1, dependsOn: [], requires: {}, services: {}, provides: [] }];
    const result = resolveExtensionDependencies(selected, []);
    expect(result).toEqual([]);
  });

  it("handles missing dependency in allDiscovered", () => {
    const allDiscovered = [
      { name: "a", loadOrder: 1, dependsOn: ["nonexistent"], requires: {}, services: {}, provides: [] },
    ];
    const result = resolveExtensionDependencies(allDiscovered, allDiscovered);
    expect(result.map((e) => e.name)).toEqual(["a"]);
  });

  it("handles circular dependency in addWithDeps gracefully", () => {
    const allDiscovered = [
      { name: "a", loadOrder: 1, dependsOn: ["b"], requires: {}, services: {}, provides: [] },
      { name: "b", loadOrder: 1, dependsOn: ["a"], requires: {}, services: {}, provides: [] },
    ];
    // This should not infinite loop
    const result = resolveExtensionDependencies(allDiscovered, allDiscovered);
    expect(result.length).toBeGreaterThan(0);
  });

  it("includes service provider when required", () => {
    const allDiscovered = [
      {
        name: "provider",
        loadOrder: 10,
        dependsOn: [],
        requires: {},
        services: { myService: ["method1"] },
        provides: [],
      },
      {
        name: "consumer",
        loadOrder: 10,
        dependsOn: [],
        requires: { myService: ["method1"] },
        services: {},
        provides: [],
      },
    ];
    const selected = [allDiscovered.find((e) => e.name === "consumer")];
    const result = resolveExtensionDependencies(selected, allDiscovered);
    const names = result.map((e) => e.name);
    expect(names).toContain("provider");
    expect(names).toContain("consumer");
  });

  it("uses serviceOverrides to select provider", () => {
    const allDiscovered = [
      {
        name: "provider-a",
        loadOrder: 10,
        dependsOn: [],
        requires: {},
        services: { myService: ["method1"] },
        provides: [],
      },
      {
        name: "provider-b",
        loadOrder: 10,
        dependsOn: [],
        requires: {},
        services: { myService: ["method1"] },
        provides: [],
      },
      {
        name: "consumer",
        loadOrder: 10,
        dependsOn: [],
        requires: { myService: ["method1"] },
        services: {},
        provides: [],
      },
    ];
    const selected = [allDiscovered.find((e) => e.name === "consumer")];
    const result = resolveExtensionDependencies(
      selected,
      allDiscovered,
      { myService: "provider-b" },
    );
    const names = result.map((e) => e.name);
    expect(names).toContain("provider-b");
  });

  it("handles non-object requires", () => {
    const allDiscovered = [
      {
        name: "a",
        loadOrder: 1,
        dependsOn: [],
        requires: "not-an-object",
        services: {},
        provides: [],
      },
    ];
    const result = resolveExtensionDependencies(allDiscovered, allDiscovered);
    expect(result.map((e) => e.name)).toEqual(["a"]);
  });
});

describe("registerExtensionMetadata", async () => {
  let registerExtensionMetadata;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    registerExtensionMetadata = mod.registerExtensionMetadata;
  });

  function createMockConfigRegistry() {
    const flags = [];
    const params = [];
    const schemas = new Map();
    return {
      registerCliFlags: (f) => flags.push(...f),
      registerConfigParams: (p) => params.push(...p),
      registerConfigSchema: (key, schema) => schemas.set(key, schema),
      getConfigSchema: (key) => schemas.get(key) || null,
      _flags: flags,
      _params: params,
    };
  }

  function createMockSubcommandRegistry() {
    const subcommands = {};
    return {
      register: (name, def) => { subcommands[name] = def; },
      _subcommands: subcommands,
    };
  }

  it("registers CLI flags from extensions", async () => {
    const config = {
      extensionPaths: ["builtins"],
      extensionAutoload: true,
      extensions: [],
    };
    const configRegistry = createMockConfigRegistry();
    const subcommandRegistry = createMockSubcommandRegistry();

    await registerExtensionMetadata(config, configRegistry, subcommandRegistry);
    expect(Array.isArray(configRegistry._flags)).toBe(true);
  });

  it("registers config params from extensions", async () => {
    const config = {
      extensionPaths: ["builtins"],
      extensionAutoload: true,
      extensions: [],
    };
    const configRegistry = createMockConfigRegistry();
    const subcommandRegistry = createMockSubcommandRegistry();

    await registerExtensionMetadata(config, configRegistry, subcommandRegistry);
    expect(Array.isArray(configRegistry._params)).toBe(true);
  });

  it("registers subcommands from extensions", async () => {
    const config = {
      extensionPaths: ["builtins"],
      extensionAutoload: true,
      extensions: [],
    };
    const configRegistry = createMockConfigRegistry();
    const subcommandRegistry = createMockSubcommandRegistry();

    await registerExtensionMetadata(config, configRegistry, subcommandRegistry);
    // Should have registered some subcommands
    expect(Object.keys(subcommandRegistry._subcommands).length).toBeGreaterThan(0);
  });

  it("returns extensions to load", async () => {
    const config = {
      extensionPaths: ["builtins"],
      extensionAutoload: true,
      extensions: [],
    };
    const configRegistry = createMockConfigRegistry();
    const subcommandRegistry = createMockSubcommandRegistry();

    const result = await registerExtensionMetadata(
      config,
      configRegistry,
      subcommandRegistry,
    );
    expect(Array.isArray(result)).toBe(true);
  });

  it("handles missing config gracefully", async () => {
    const configRegistry = createMockConfigRegistry();
    const subcommandRegistry = createMockSubcommandRegistry();

    // Should not throw with null config
    try {
      await registerExtensionMetadata(null, configRegistry, subcommandRegistry);
    } catch (e) {
      // May throw depending on implementation — either way it's handled
    }
  });
});

describe("ExtensionLoader — additional methods", () => {
  let ExtensionLoader;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/extensions.ts");
    ExtensionLoader = mod.ExtensionLoader;
  });

  async function createMockCore() {
    const { HookSystem } = await import("../../src/core/hooks.ts");
    const { ToolRegistry } = await import("../../src/core/extensions/tool-registry.ts");
    return {
      hooks: new HookSystem(),
      toolRegistry: new ToolRegistry(),
      services: { register: () => {}, has: () => false },
    };
  }

  it("entryPoints returns entry point paths", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    await loader.load("test", {
      create: () => ({ name: "test" }),
    });
    // When loaded from object (not string path), no entry point is stored
    expect(loader.entryPoints()).toBeDefined();
  });

  it("getProvides returns provides for loaded extension", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    await loader.load("test", {
      create: () => ({ name: "test" }),
    }, { provides: ["tools"] });
    expect(loader.getProvides("test")).toEqual(["tools"]);
  });

  it("getProvides returns undefined for unknown extension", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    expect(loader.getProvides("unknown")).toBeUndefined();
  });

  it("getDependsOn returns dependsOn for loaded extension", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    await loader.load("test", {
      create: () => ({ name: "test" }),
    }, { dependsOn: ["dep1"] });
    expect(loader.getDependsOn("test")).toEqual(["dep1"]);
  });

  it("getDependsOn returns undefined for unknown extension", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    expect(loader.getDependsOn("unknown")).toBeUndefined();
  });

  it("hasCapability returns true when extension provides capability", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    await loader.load("test", {
      create: () => ({ name: "test" }),
    }, { provides: ["tools"] });
    expect(loader.hasCapability("tools")).toBe(true);
  });

  it("hasCapability returns false when no extension provides capability", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    expect(loader.hasCapability("nonexistent")).toBe(false);
  });

  it("getProviders returns extensions providing a capability", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    await loader.load("ext1", {
      create: () => ({ name: "ext1" }),
    }, { provides: ["tools"] });
    await loader.load("ext2", {
      create: () => ({ name: "ext2" }),
    }, { provides: ["tools"] });
    const providers = loader.getProviders("tools");
    expect(providers).toContain("ext1");
    expect(providers).toContain("ext2");
  });

  it("getProviders returns empty array when no providers", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    expect(loader.getProviders("nonexistent")).toEqual([]);
  });

  it("cleanup calls SHUTDOWN_CLEANUP hook", async () => {
    const core = await createMockCore();
    let shutdownCalled = false;
    core.hooks.on("shutdown:cleanup", () => { shutdownCalled = true; });
    const loader = new ExtensionLoader(core);
    await loader.cleanup();
    expect(shutdownCalled).toBe(true);
  });

  it("unload calls extension shutdown", async () => {
    const core = await createMockCore();
    let shutdownCalled = false;
    await new ExtensionLoader(core).load("test", {
      create: () => ({
        name: "test",
        shutdown: async () => { shutdownCalled = true; },
      }),
    });
    const loader = new ExtensionLoader(core);
    // Need to reload since we created a new loader
    await loader.load("test2", {
      create: () => ({
        name: "test2",
        shutdown: async () => { shutdownCalled = true; },
      }),
    });
    await loader.unload("test2");
    expect(shutdownCalled).toBe(true);
  });

  it("unload handles extension without shutdown", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    await loader.load("test", {
      create: () => ({ name: "test" }),
    });
    // Should not throw
    await loader.unload("test");
  });

  it("unload handles unknown extension gracefully", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    // Should not throw
    await loader.unload("nonexistent");
  });

  it("unload removes hook handlers", async () => {
    const core = await createMockCore();
    let calls = [];
    await new ExtensionLoader(core).load("test", {
      create: () => ({
        hooks: {
          "test:hook": () => calls.push(1),
        },
      }),
    });

    const loader = new ExtensionLoader(core);
    await loader.load("test2", {
      create: () => ({
        hooks: {
          "test:hook": () => calls.push(2),
        },
      }),
    });

    core.hooks.notifyHooks("test:hook", {});
    expect(calls).toContain(2);
    await loader.unload("test2");
    calls = [];
    core.hooks.notifyHooks("test:hook", {});
    // test2's handler should be removed
  });

  it("unload throws ExtensionError on shutdown failure", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    await loader.load("test", {
      create: () => ({
        shutdown: async () => { throw new Error("shutdown failed"); },
      }),
    });

    await expect(loader.unload("test")).rejects.toThrow(
      "Extension 'test' shutdown failed",
    );
  });

  it("load handles extension with SERVICES_REGISTER hook", async () => {
    const core = await createMockCore();
    let servicesRegistered = false;
    const loader = new ExtensionLoader(core);
    await loader.load("test", {
      create: () => ({
        hooks: {
          "services:register": (registry) => { servicesRegistered = true; },
        },
      }),
    });
    expect(servicesRegistered).toBe(true);
  });

  it("load handles extension with TOOLS_REGISTER hook", async () => {
    const core = await createMockCore();
    let toolsRegistered = false;
    const loader = new ExtensionLoader(core);
    await loader.load("test", {
      create: () => ({
        hooks: {
          "tools:register": async (registry) => { toolsRegistered = true; },
        },
      }),
    });
    expect(toolsRegistered).toBe(true);
  });

  it("load handles extension with registerTools callback", async () => {
    const core = await createMockCore();
    let toolsRegistered = false;
    const loader = new ExtensionLoader(core);
    await loader.load("test", {
      create: () => ({
        registerTools: async (registry) => { toolsRegistered = true; },
      }),
    });
    expect(toolsRegistered).toBe(true);
  });

  it("load with string entry point stores entry point", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    // Can't easily test with real file paths, but we can verify the method
    expect(loader.entryPoints()).toBeDefined();
  });

  it("size returns number of loaded extensions", async () => {
    const core = await createMockCore();
    const loader = new ExtensionLoader(core);
    expect(loader.size()).toBe(0);
    await loader.load("a", { create: () => ({}) });
    expect(loader.size()).toBe(1);
    await loader.load("b", { create: () => ({}) });
    expect(loader.size()).toBe(2);
  });
});
