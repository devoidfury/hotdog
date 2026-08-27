// Extended tests for config/index.js — normalizeConfigKeys, buildAgentConfig, buildConfig.

import { describe, it, expect } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  normalizeConfigKeys,
  buildAgentConfig,
  buildConfig,
} from "../../src/core/config/index.ts";
import type { DefaultConfig } from "../../src/core/config/index.ts";
import type { CoreConfig, CoreConfigWithExtensions } from "../../src/core/config/schema-loader.ts";
import { ConfigError } from "../../src/core/error.ts";

describe("normalizeConfigKeys", () => {
  it("converts snake_case keys to camelCase", () => {
    const result = normalizeConfigKeys({
      default_model: "gpt-4",
      hide_tools: true,
      chat_timeout_secs: 30,
    }) as Record<string, unknown>;
    expect(result.defaultModel).toBe("gpt-4");
    expect(result.hideTools).toBe(true);
    expect(result.chatTimeoutSecs).toBe(30);
  });

  it("handles nested objects, arrays, and primitives", () => {
    const result = normalizeConfigKeys({
      simple_key: "value",
      nested_key: { inner_key: "inner" },
      array_key: [{ item_key: "item" }, "string", 42],
      level_one: { level_two: { level_three_key: "deep" } },
    }) as Record<string, unknown>;

    expect(result.simpleKey).toBe("value");
    expect((result.nestedKey as Record<string, unknown>).innerKey).toBe("inner");
    expect((result.arrayKey as Record<string, unknown>[])[0]!.itemKey).toBe("item");
    expect((result.arrayKey as unknown[])[1]).toBe("string");
    expect((result.arrayKey as unknown[])[2]).toBe(42);
    expect(((result.levelOne as Record<string, unknown>).levelTwo as Record<string, unknown>).levelThreeKey).toBe("deep");
  });

  it("returns primitives unchanged", () => {
    expect(normalizeConfigKeys("string")).toBe("string");
    expect(normalizeConfigKeys(42)).toBe(42);
    expect(normalizeConfigKeys(true)).toBe(true);
    expect(normalizeConfigKeys(null)).toBeNull();
    expect(normalizeConfigKeys(undefined)).toBeUndefined();
  });

  it("handles empty object and arrays", () => {
    expect(normalizeConfigKeys({})).toEqual({});
    expect(normalizeConfigKeys([])).toEqual([]);
  });
});

describe("buildAgentConfig", () => {
  const baseOpts = {
    cli: {},
    config: { providers: [], defaultModel: "test-model", hideTools: true, profilesPath: "./config/profiles" } as CoreConfigWithExtensions,
    configDir: "/tmp/test-config",
    providers: [],
    defaultModel: "qwen3.5-0.8b",
    profilesPath: "/tmp/test-config/profiles",
  };

  it("resolves basic config with all expected fields", async () => {
    const result = await buildAgentConfig(baseOpts);
    expect(result.model).toBe("test-model");
    expect(result.configDir).toBe("/tmp/test-config");
    expect(result.profileName).toBe("default");
    expect(typeof result.systemPromptTemplate).toBe("string");
    expect(result.systemPromptTemplate.length).toBeGreaterThan(0);
    expect(typeof result.profiles).toBe("object");
    expect(result.profiles).not.toBeNull();
    expect(typeof result.modelRegistry).toBe("object");
    expect(result.modelRegistry).not.toBeNull();
  });

  it("resolves model from CLI override", async () => {
    const result = await buildAgentConfig({ ...baseOpts, cli: { model: "cli-model" }, config: { ...baseOpts.config, defaultModel: "config-model" }, defaultModel: "default-model" });
    expect(result.model).toBe("cli-model");
  });

  it("resolves model from provider default", async () => {
    const provider = { name: "test-provider", models: [{ name: "provider-model" }] };
    const result = await buildAgentConfig({
      ...baseOpts,
      cli: { provider: "test-provider" },
      config: { ...baseOpts.config, providers: [provider], defaultModel: "config-model" },
      providers: [provider],
      defaultModel: "default-model",
    });
    expect(result.activeProvider).toBe("test-provider");
  });

  it("resolves profile from config", async () => {
    const result = await buildAgentConfig({ ...baseOpts, config: { ...baseOpts.config, profile: "fixer" } });
    expect(result.profileName).toBe("fixer");
  });

  it("CLI profile overrides config profile", async () => {
    const result = await buildAgentConfig({
      ...baseOpts,
      cli: { profile: "explorer" },
      config: { ...baseOpts.config, profileName: "fixer" },
    });
    expect(result.profileName).toBe("explorer");
  });

  it("resolves hideTools and hideThinking from config", async () => {
    const result = await buildAgentConfig({
      ...baseOpts,
      config: { ...baseOpts.config, hideTools: false, hideThinking: true },
    });
    expect(result.hideTools).toBe(false);
    expect(result.hideThinking).toBe(true);
  });
});

describe("buildConfig", () => {
  it("resolves config directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-config-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'defaults.json'), JSON.stringify({ providers: [], defaultModel: "test" }));
      fs.mkdirSync(path.join(tmpDir, 'profiles'));
      fs.writeFileSync(path.join(tmpDir, 'profiles', 'test.profile.md'), `---\nmodel: test\n---\nTest profile`);
      const result = await buildConfig({ configDir: tmpDir });
      expect(result.resolved).toBeDefined();
      expect(result.resolved.model).toBe('test');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles missing config dir gracefully", async () => {
    const result = await buildConfig({ configDir: '/nonexistent/path' });
    expect(result.resolved).not.toBeNull();
    expect(result.modelRegistry).not.toBeNull();
    expect(typeof result.resolved.model).toBe("string");
  });

  it("merges profile from file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-config-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'defaults.json'), JSON.stringify({ providers: [], defaultModel: "test" }));
      fs.mkdirSync(path.join(tmpDir, 'profiles'));
      fs.writeFileSync(path.join(tmpDir, 'profiles', 'fixer.profile.md'), `---\nrole: fixer\nwhitelistTools: [bash, read]\nmanager: true\n---\nFixer profile`);
      const result = await buildConfig({ configDir: tmpDir, profile: 'fixer' });
      expect(result.resolved.profileName).toBe('fixer');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("buildAgentConfig — workspaceRoots", () => {
  const baseOpts = {
    cli: {},
    config: { providers: [], defaultModel: "test-model", hideTools: true, profilesPath: "./config/profiles" } as CoreConfigWithExtensions,
    configDir: "/tmp/test-config",
    providers: [],
    defaultModel: "qwen3.5-0.8b",
    profilesPath: "/tmp/test-config/profiles",
  };

  it("defaults to the process CWD", async () => {
    const result = await buildAgentConfig(baseOpts);
    expect(result.workspaceRoots).toEqual([process.cwd()]);
  });

  it("honors workspace.paths from the config file", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-ws-roots-"));
    try {
      const result = await buildAgentConfig({
        ...baseOpts,
        config: { ...baseOpts.config, workspace: { paths: [".", dir] } },
      });
      expect(result.workspaceRoots).toEqual([process.cwd(), dir]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to legacy cwdBoundary when workspace.paths is absent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-legacy-boundary-"));
    try {
      const result = await buildAgentConfig({
        ...baseOpts,
        config: { ...baseOpts.config, cwdBoundary: dir },
      });
      expect(result.workspaceRoots).toEqual([dir]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falls back to legacy workspaceRoot when cwdBoundary is absent", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-legacy-root-"));
    try {
      const result = await buildAgentConfig({
        ...baseOpts,
        config: { ...baseOpts.config, workspaceRoot: dir },
      });
      expect(result.workspaceRoots).toEqual([dir]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("workspace.paths takes precedence over legacy keys", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-paths-wins-"));
    try {
      const result = await buildAgentConfig({
        ...baseOpts,
        config: {
          ...baseOpts.config,
          cwdBoundary: dir,
          workspaceRoot: dir,
          workspace: { paths: ["."] },
        },
      });
      expect(result.workspaceRoots).toEqual([process.cwd()]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a non-array workspace.paths", async () => {
    await expect(
      buildAgentConfig({
        ...baseOpts,
        config: { ...baseOpts.config, workspace: { paths: "/somewhere" } },
      }),
    ).rejects.toThrow(ConfigError);
  });

  it("rejects an explicit workspace path that does not exist", async () => {
    await expect(
      buildAgentConfig({
        ...baseOpts,
        config: {
          ...baseOpts.config,
          workspace: { paths: ["/definitely/not/a/real/path"] },
        },
      }),
    ).rejects.toThrow(ConfigError);
  });
});
