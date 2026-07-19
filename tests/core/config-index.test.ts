// Tests for config/index.ts and config/defaults.ts.

import { describe, it, expect } from "bun:test";
import path from "node:path";
import {
  resolveConfigDir,
  mergeExtensionConfigDefaults,
  getDefaultConfig,
  loadConfig,
  validateConfig,
  failOnInvalidConfig,
} from "../../src/core/config/index.ts";
import {
  DEFAULT_PROFILES_SUBPATH,
  DEFAULT_CONFIG_FILENAME,
  DEFAULT_SYSTEM_PROMPT_FILENAME,
  DEFAULT_PROFILES_PATH,
  DEFAULT_PROMPTS_PATH,
  DEFAULT_SYSTEM_PROMPT_TEMPLATE,
} from "../../src/core/config/defaults.ts";

describe("resolveConfigDir", () => {
  it("returns CLI config-dir when provided", () => {
    expect(resolveConfigDir("/my/config")).toBe("/my/config");
  });

  it("resolves relative CLI path", () => {
    const result = resolveConfigDir("./config");
    expect(result).toBe(path.resolve("./config"));
  });

  it("falls back to /etc/hotdog or XDG when no CWD config exists", () => {
    // Personal config was moved to examples/devoidfury/config
    const saved = process.env.HOTDOG_CONFIG_DIR;
    delete process.env.HOTDOG_CONFIG_DIR;
    try {
      const result = resolveConfigDir();
      // Should fall back to /etc/hotdog or ~/.config/hotdog
      expect(result).toBeTruthy();
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
    expect(config.aiUrl).toBeNull();
    expect(config.defaultModel).toBe("qwen3.5-0.8b");
    expect(config.extensionPaths).toEqual(["builtins"]);
    expect(config.extensionAutoload).toBe(false);
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
});

describe("failOnInvalidConfig", () => {
  it("does not throw when config is valid", () => {
    expect(() => failOnInvalidConfig({ valid: true, errors: [] })).not.toThrow();
  });

  it("throws ConfigError when config is invalid", () => {
    const result = { valid: false, errors: ["error1", "error2"] };
    expect(() => failOnInvalidConfig(result)).toThrow();
  });
});

describe("loadConfig", () => {
  it("loads config from explicit path", async () => {
    const config = await loadConfig("./examples/devoidfury/config/defaults.json");
    expect(config).toBeDefined();
    expect(config.defaultModel).toBeDefined();
  });

  it("throws on invalid JSON", async () => {
    const { writeFileSync, unlinkSync } = await import("node:fs");
    const tmpFile = "/tmp/test-bad-config.json";
    try {
      writeFileSync(tmpFile, "{ invalid json }");
      await expect(loadConfig(tmpFile)).rejects.toThrow();
    } finally {
      try { unlinkSync(tmpFile); } catch {}
    }
  });
});

// ── Config Defaults ──────────────────────────────────────────────────────────

describe("config defaults — path constants", () => {
  it("has correct default subpaths", () => {
    expect(DEFAULT_PROFILES_SUBPATH).toBe("profiles");
    expect(DEFAULT_CONFIG_FILENAME).toBe("defaults.json");
    expect(DEFAULT_SYSTEM_PROMPT_FILENAME).toBe("system_prompt.md");
  });

  it("has correct default full paths", () => {
    expect(DEFAULT_PROFILES_PATH).toBe("./config/profiles");
    expect(DEFAULT_PROMPTS_PATH).toBe("./config/prompts");
  });
});

describe("DEFAULT_SYSTEM_PROMPT_TEMPLATE", () => {
  it("contains expected placeholders and loop syntax", () => {
    expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("{{ role }}");
    expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("{{ body }}");
    expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("{% for chunk in chunks %}");
    expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("{% endfor %}");
    expect(DEFAULT_SYSTEM_PROMPT_TEMPLATE).toContain("{{ chunk.content }}");
  });
});
