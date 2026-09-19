// Tests for extensions.js discovery functions — discoverExtensionsInDir,
// getExtensionConfigDefaults, registerExtensionMetadata, getExtensionsToLoad.

import { describe, it, expect, beforeAll } from "bun:test";

describe("discoverExtensionsInDir", async () => {
  let discoverExtensionsInDir: typeof import("@core/extensions/extensions.ts").discoverExtensionsInDir;

  beforeAll(async () => {
    const mod = await import("@core/extensions/extensions.ts");
    discoverExtensionsInDir = mod.discoverExtensionsInDir;
  });

  it("returns empty array for non-existent directory", async () => {
    const result = await discoverExtensionsInDir("/nonexistent/path/xyz123");
    expect(result).toEqual([]);
  });

  it("returns extensions from builtins directory", async () => {
    const { resolveExtensionPath } = await import("@core/extensions/extensions.ts");
    const result = await discoverExtensionsInDir(resolveExtensionPath("@extensions"));
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("each discovered extension has required fields", async () => {
    const { resolveExtensionPath } = await import("@core/extensions/extensions.ts");
    const result = await discoverExtensionsInDir(resolveExtensionPath("@extensions"));
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

  it("computes scan-relative path and dirPath for nested extensions", async () => {
    const fs = await import("node:fs/promises");
    const os = await import("node:os");
    const nodePath = await import("node:path");
    const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), "hotdog-ext-disc-"));
    try {
      const nested = nodePath.join(tmp, "group", "nested-ext");
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(nodePath.join(nested, "extension.json"), "{}");
      await fs.writeFile(nodePath.join(nested, "index.ts"), "export default {};");

      const result = await discoverExtensionsInDir(tmp);
      expect(result.length).toBe(1);
      expect(result[0]!.name).toBe("nested-ext");
      expect(result[0]!.path).toBe("group/nested-ext");
      expect(result[0]!.dirPath).toBe(nested);

      // Module specifier must keep the intermediate directory segment.
      const { discoverExtensions } = await import("@core/extensions/extensions.ts");
      const loaded = await discoverExtensions([tmp]);
      expect(loaded.length).toBe(1);
      expect(loaded[0]!.path!.endsWith(
        nodePath.join("group", "nested-ext", "index.ts"),
      )).toBe(true);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("@experimental token", async () => {
  it("resolves to the bundled src/experimental directory", async () => {
    const nodePath = await import("node:path");
    const { resolveExtensionPath } = await import("@core/extensions/extensions.ts");
    const resolved = resolveExtensionPath("@experimental");
    expect(resolved.endsWith(nodePath.join("src", "experimental"))).toBe(true);
  });

  it("discovers the bundled experimental extensions", async () => {
    const { resolveExtensionPath, discoverExtensionsInDir } = await import("@core/extensions/extensions.ts");
    const result = await discoverExtensionsInDir(resolveExtensionPath("@experimental"));
    expect(result.map((ext) => ext.name)).toContain("file-watch");
  });

  it("emits token import specifiers so Bun resolves them via the tsconfig alias", async () => {
    const { discoverExtensions } = await import("@core/extensions/extensions.ts");
    const loaded = await discoverExtensions(["@experimental"]);
    const fileWatch = loaded.find((ext) => ext.name === "file-watch");
    expect(fileWatch).toBeDefined();
    // Must be the alias specifier, not a ROOT_DIR-relative path — Bun only
    // resolves "@experimental/..." through the tsconfig paths mapping.
    expect(fileWatch!.path).toBe("@experimental/file-watch/index.ts");
  });

  it("does not treat unknown @tokens as aliases (bad config surfaces, not a silent scan)", async () => {
    const nodePath = await import("node:path");
    const { resolveExtensionPath } = await import("@core/extensions/extensions.ts");
    // Unknown tokens fall through to plain cwd-relative resolution...
    expect(resolveExtensionPath("@bogus")).toBe(nodePath.resolve(process.cwd(), "@bogus"));
    // ...which discovers nothing instead of silently scanning an extension tier.
    const { discoverExtensionsInDir } = await import("@core/extensions/extensions.ts");
    const result = await discoverExtensionsInDir(resolveExtensionPath("@bogus"));
    expect(result).toEqual([]);
  });
});

describe("getExtensionConfigDefaults", async () => {
  let getExtensionConfigDefaults: typeof import("@core/extensions/extensions.ts").getExtensionConfigDefaults;

  beforeAll(async () => {
    const mod = await import("@core/extensions/extensions.ts");
    getExtensionConfigDefaults = mod.getExtensionConfigDefaults;
  });

  it("returns params from builtins", async () => {
    const result = await getExtensionConfigDefaults(["@extensions"]);
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
  let getExtensionConfigSchemas: typeof import("@core/extensions/extensions.ts").getExtensionConfigSchemas;

  beforeAll(async () => {
    const mod = await import("@core/extensions/extensions.ts");
    getExtensionConfigSchemas = mod.getExtensionConfigSchemas;
  });

  it("returns schemas from builtins", async () => {
    const result = await getExtensionConfigSchemas(["@extensions"]);
    expect(typeof result).toBe("object");
  });

  it("returns empty object for non-existent path", async () => {
    const result = await getExtensionConfigSchemas(["/nonexistent/path"]);
    expect(result).toEqual({});
  });
});

describe("getExtensionsToLoad", async () => {
  let getExtensionsToLoad: typeof import("@core/extensions/extensions.ts").getExtensionsToLoad;

  beforeAll(async () => {
    const mod = await import("@core/extensions/extensions.ts");
    getExtensionsToLoad = mod.getExtensionsToLoad;
  });

  it("returns extensions when autoload is true", async () => {
    const result = await getExtensionsToLoad(
      ["@extensions"],
      true,
      [],
      undefined,
    );
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
  });

  it("returns empty array when autoload is false and no extensions specified", async () => {
    const result = await getExtensionsToLoad(
      ["@extensions"],
      false,
      [],
      undefined,
    );
    expect(result).toEqual([]);
  });

  it("filters extensions by name when autoload is false", async () => {
    const result = await getExtensionsToLoad(
      ["@extensions"],
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
      ["@extensions"],
      true,
      [],
      config,
    );
    const names = result.map((e) => e.name);
    expect(names).not.toContain("bash-tool");
  });

  it("returns extensions with service overrides", async () => {
    const result = await getExtensionsToLoad(
      ["@extensions"],
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
  let registerExtensionMetadata: typeof import("@core/extensions/extensions.ts").registerExtensionMetadata;

  beforeAll(async () => {
    const mod = await import("@core/extensions/extensions.ts");
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
      extensionPaths: ["@extensions"],
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

  it("handles missing config with built-in defaults", async () => {
    const configRegistry = createMockConfigRegistry();
    const subcommandRegistry = createMockSubcommandRegistry();

    // A null config must fall back to defaults: @extensions path, autoload on.
    const result = await registerExtensionMetadata(null as any, configRegistry, subcommandRegistry);
    expect(Array.isArray(result)).toBe(true);
    // Built-in extensions still register their subcommands.
    expect(Object.keys(subcommandRegistry._subcommands).length).toBeGreaterThan(0);
  });
});

describe("extension.json manifest validation", async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const nodePath = await import("node:path");
  const { discoverExtensionsInDir } = await import(
    "@core/extensions/extensions.ts"
  );

  // Builds <tmp>/bad-ext with the given manifest content; discovery runs
  // against tmp (the parent), so the extension is the scanned child.
  async function makeTmpExt(manifest: string): Promise<string> {
    const tmp = await fs.mkdtemp(nodePath.join(os.tmpdir(), "hotdog-ext-meta-"));
    const extDir = nodePath.join(tmp, "bad-ext");
    await fs.mkdir(extDir);
    await fs.writeFile(nodePath.join(extDir, "extension.json"), manifest);
    await fs.writeFile(nodePath.join(extDir, "index.ts"), "export default {};");
    return tmp;
  }

  it("records manifestError on a malformed manifest instead of throwing or silently defaulting", async () => {
    const tmp = await makeTmpExt("{ not valid json ");
    try {
      const result = await discoverExtensionsInDir(tmp);
      expect(result.length).toBe(1);
      expect(result[0]!.provides).toEqual([]); // defaults
      expect(result[0]!.manifestError).toContain("invalid extension.json");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("records manifestError when the manifest is valid JSON but not an object", async () => {
    const tmp = await makeTmpExt('["provides"]');
    try {
      const result = await discoverExtensionsInDir(tmp);
      expect(result[0]!.manifestError).toContain("expected a JSON object");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("is fatal when a broken manifest would actually load (autoload)", async () => {
    const { getExtensionsToLoad } = await import("@core/extensions/extensions.ts");
    const tmp = await makeTmpExt("{ not valid json ");
    try {
      // Fail closed: a manifest that cannot be parsed cannot disable itself.
      await expect(getExtensionsToLoad([tmp], true, [], undefined)).rejects.toThrow(
        /Cannot load extension "bad-ext".*invalid extension\.json/s,
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("is fatal when a broken manifest is explicitly selected", async () => {
    const { getExtensionsToLoad } = await import("@core/extensions/extensions.ts");
    const tmp = await makeTmpExt("{ not valid json ");
    try {
      await expect(
        getExtensionsToLoad([tmp], false, ["bad-ext"], undefined),
      ).rejects.toThrow(/Cannot load extension "bad-ext"/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("stays silent when config disables the broken extension", async () => {
    const { getExtensionsToLoad } = await import("@core/extensions/extensions.ts");
    const tmp = await makeTmpExt("{ not valid json ");
    try {
      const result = await getExtensionsToLoad(
        [tmp],
        true,
        [],
        { badExt: { enabled: false } } as never,
      );
      expect(result.map((e) => e.name)).not.toContain("bad-ext");
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("stays silent when the extensions list omits the broken extension", async () => {
    const { getExtensionsToLoad } = await import("@core/extensions/extensions.ts");
    const tmp = await makeTmpExt("{ not valid json ");
    try {
      const result = await getExtensionsToLoad(
        [tmp],
        false,
        ["some-other-ext"],
        undefined,
      );
      expect(result).toEqual([]);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("ignores (but does not crash on) wrong-typed fields", async () => {
    const tmp = await makeTmpExt(
      JSON.stringify({
        provides: "tools", // string, not array
        services: 42, // number, not object
        loadOrder: "first", // string, not number
      }),
    );
    try {
      const result = await discoverExtensionsInDir(tmp);
      expect(result.length).toBe(1);
      expect(result[0]!.provides).toEqual([]);
      expect(result[0]!.services).toEqual({});
      expect(result[0]!.loadOrder).toBe(10); // LOAD_ORDER.DEFAULT
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("keeps parsing a valid manifest with all fields", async () => {
    const tmp = await makeTmpExt(
      JSON.stringify({
        name: "renamed",
        provides: ["cli:subcommands"],
        loadOrder: 2,
        autoload: false,
        description: "a valid one",
        dependsOn: ["core-tools"],
        configSchema: { type: "object" },
        services: { "x.y": ["do"] },
      }),
    );
    try {
      const result = await discoverExtensionsInDir(tmp);
      expect(result.length).toBe(1);
      expect(result[0]!.name).toBe("renamed");
      expect(result[0]!.provides).toEqual(["cli:subcommands"]);
      expect(result[0]!.loadOrder).toBe(2);
      expect(result[0]!.autoload).toBe(false);
      expect(result[0]!.description).toBe("a valid one");
      expect(result[0]!.dependsOn).toEqual(["core-tools"]);
      expect(result[0]!.configSchema).toEqual({ type: "object" });
      expect(result[0]!.services).toEqual({ "x.y": ["do"] });
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
