// Tests for config/index.ts.

import { describe, it, expect } from "bun:test";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import {
  resolveConfigDir,
  mergeExtensionConfigDefaults,
  getDefaultConfig,
  loadConfig,
  validateConfig,
  failOnInvalidConfig,
} from "@core/config/index.ts";
import bashToolManifest from "@extensions/bash-tool/extension.json" with { type: "json" };
import coreToolsManifest from "@extensions/core-tools/extension.json" with { type: "json" };

describe("resolveConfigDir", () => {
  it("returns CLI config-dir when provided", () => {
    expect(resolveConfigDir("/my/config")).toBe("/my/config");
  });

  it("resolves relative CLI path", () => {
    const result = resolveConfigDir("./config");
    expect(result).toBe(path.resolve("./config"));
  });

  it("resolves to one of the documented fallback candidates", () => {
    const saved = process.env.HOTDOG_CONFIG_DIR;
    delete process.env.HOTDOG_CONFIG_DIR;
    try {
      const result = resolveConfigDir();
      // fallback chain: /etc/hotdog -> ~/.config/hotdog,
      // with the bundled examples dir as last resort when all of those are absent.
      // (CWD ./config is not a candidate: repo-local auto-discovery was removed.)
      const candidates = [
        "/etc/hotdog",
        path.join(os.homedir(), ".config", "hotdog"),
        path.resolve(new URL("../../examples/minimal-config/config", import.meta.url).pathname),
      ];
      expect(candidates).toContain(result);
    } finally {
      process.env.HOTDOG_CONFIG_DIR = saved;
    }
  });

  it("resolves to examples config dir when given explicitly", () => {
    const examplesConfig = resolveConfigDir("./examples/devoidfury/config");
    expect(examplesConfig).toContain("examples/devoidfury/config");
  });
});

describe("mergeExtensionConfigDefaults", () => {
  it("returns default config when no ext params", () => {
    const config = { key: "value" };
    expect(mergeExtensionConfigDefaults(config, null)).toBe(config);
    expect(mergeExtensionConfigDefaults(config, [])).toBe(config);
    expect(mergeExtensionConfigDefaults(config, undefined)).toBe(config);
  });

  it("adds extension defaults for missing keys", () => {
    const config = { existingKey: "value" };
    const extParams = [
      { key: "newKey", defaults: { timeout: 30 } },
    ];
    const result = mergeExtensionConfigDefaults(config, extParams);
    expect(result.existingKey).toBe("value");
    expect(result.newKey).toEqual({ timeout: 30 });
  });

  it("deep merges object defaults with existing objects", () => {
    const config = { myExt: { existing: true } };
    const extParams = [
      { key: "myExt", defaults: { timeout: 30, shell: "/bin/bash" } },
    ];
    const result = mergeExtensionConfigDefaults(config, extParams);
    expect(result.myExt).toEqual({
      existing: true,
      timeout: 30,
      shell: "/bin/bash",
    });
  });

  it("does not overwrite non-object values", () => {
    const config = { myKey: "existing" };
    const extParams = [
      { key: "myKey", defaults: "new" },
    ];
    const result = mergeExtensionConfigDefaults(config, extParams);
    expect(result.myKey).toBe("existing");
  });

  it("does not deep merge when existing is null", () => {
    const config = { myKey: null };
    const extParams = [
      { key: "myKey", defaults: { nested: true } },
    ];
    const result = mergeExtensionConfigDefaults(config, extParams);
    expect(result.myKey).toBe(null);
  });

  it("does not deep merge when defaults is null", () => {
    const config = { myKey: { nested: true } };
    const extParams = [
      { key: "myKey", defaults: null },
    ];
    const result = mergeExtensionConfigDefaults(config, extParams);
    expect(result.myKey).toEqual({ nested: true });
  });
});

describe("getDefaultConfig", () => {
  it("returns default config without ext params", () => {
    const config = getDefaultConfig();
    expect(config.providers).toEqual([]);
    expect(config.defaultProvider).toBeNull();
    // Key names come from the schema, not the config-file aliases
    // (aiUrl/thinker/chatTimeoutSecs/healthCheckTimeoutSecs).
    expect(config.baseUrl).toBeNull();
    expect(config.thinkerFormat).toBe("[Thinking: {}]");
    expect(config.chatTimeout).toBe(600);
    expect(config.healthCheckTimeout).toBe(5);
    expect(config.providerHealthCheckIntervalSecs).toBe(30);
    expect(config.defaultModel).toBeNull();
    expect(config.extensionPaths).toEqual(["@extensions"]);
    expect(config.extensionAutoload).toBe(true);
    expect(config.extensions).toEqual([]);
    expect(config.showTokenUse).toBe(true);
  });

  it("merges extension defaults into config", () => {
    const config = getDefaultConfig([
      { key: "customExt", defaults: { enabled: true, timeout: 60 } },
    ]) as unknown as Record<string, unknown>;
    expect(config.customExt).toEqual({ enabled: true, timeout: 60 });
  });
});

describe("validateConfig", () => {
  it("returns valid for empty config", () => {
    const result = validateConfig({});
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("detects wrong type for string field", () => {
    const result = validateConfig({ defaultModel: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringMatching(/defaultModel.*expected string/)
    );
  });

  it("detects wrong type for number field", () => {
    const result = validateConfig({ chatTimeout: "not-a-number" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringMatching(/chatTimeout.*expected number/)
    );
  });

  it("detects wrong type for boolean field", () => {
    const result = validateConfig({ noLog: "yes" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringMatching(/noLog.*expected boolean/)
    );
  });

  it("detects wrong type for array field", () => {
    const result = validateConfig({ extensionPaths: "not-array" });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringMatching(/extensionPaths.*expected array/)
    );
  });

  it("skips undefined and null values", () => {
    const result = validateConfig({ defaultModel: undefined, hideTools: null });
    expect(result.valid).toBe(true);
  });

  it("validates extension schemas when provided", () => {
    const schema = {
      type: "object",
      properties: {
        timeout: { type: "number" },
      },
      required: ["timeout"],
    };
    const result = validateConfig(
      { myExt: {} },
      [{ key: "myExt", schema }],
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects below-minimum values on bounded core numeric keys", () => {
    const result = validateConfig({ maxIterations: -1, contextLimit: -5 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.stringMatching(/maxIterations.*less than minimum/));
    expect(result.errors).toContainEqual(expect.stringMatching(/contextLimit.*less than minimum/));
    // Boundary: 1 iteration is legal; 0 tool calls is the "no tools" posture
    expect(validateConfig({ maxIterations: 1 }).valid).toBe(true);
    expect(validateConfig({ maxToolCallsPerIteration: 0 }).valid).toBe(true);
  });

  it("bashTool and coreTools schemas bound their numeric ceilings", () => {
    const extSchemas = [
      { key: "bashTool", schema: bashToolManifest.configSchema.bashTool },
      { key: "coreTools", schema: coreToolsManifest.configSchema.coreTools },
    ];
    // bashTimeoutMs 0 would arm a ~1ms kill timer via Math.max(1, ...): nonsense
    expect(validateConfig({ bashTool: { bashTimeoutMs: 0 } }, extSchemas).valid).toBe(false);
    // maxTimeoutMs 0 is the documented falsy "no cap"; 0 lines = suppress all
    expect(validateConfig({ bashTool: { maxTimeoutMs: 0, maxToolOutputLines: 0 } }, extSchemas).valid).toBe(true);
    // Negative result ceilings would slice-wrap and silently disable the limit
    expect(validateConfig({ coreTools: { grepMaxResults: -1 } }, extSchemas).valid).toBe(false);
    expect(
      validateConfig(
        { coreTools: { readToolLimit: 0, findMaxResults: 0, maxEditInputSize: 0, maxImageSize: 0, maxToolOutputLines: 0 } },
        extSchemas,
      ).valid,
    ).toBe(true);
  });
});
describe("failOnInvalidConfig", () => {

  it("throws ConfigError when config is invalid", () => {
    const result = { valid: false, errors: ["error1", "error2"] };
    expect(() => failOnInvalidConfig(result)).toThrow();
  });
});

describe("loadConfig", () => {
  it("loads config from explicit path", async () => {
    const { fileURLToPath } = await import("node:url");
    const configPath = path.join(fileURLToPath(import.meta.url), "../../../examples/minimal-config/config/defaults.json");
    const config = await loadConfig(configPath);
    expect(config.defaultModel).toBeDefined();
    expect(config.defaultModel).not.toBe("");
    expect(config.defaultModel).not.toBeNull();
  });

  it("throws on invalid JSON", async () => {
    const tmpFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-config-test-")), "defaults.json");
    try {
      fs.writeFileSync(tmpFile, "{ invalid json }");
      await expect(loadConfig(tmpFile)).rejects.toThrow();
    } finally {
      try { fs.rmSync(path.dirname(tmpFile), { recursive: true, force: true }); } catch {}
    }
  });
});
