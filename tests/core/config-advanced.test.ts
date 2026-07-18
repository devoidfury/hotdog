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
import type { CoreConfig } from "../../src/core/config/schema-loader.ts";

describe("normalizeConfigKeys", () => {
  it("converts snake_case keys to camelCase", () => {
    const obj = {
      default_model: "gpt-4",
      hide_tools: true,
      chat_timeout_secs: 30,
    };
    const result = normalizeConfigKeys(obj) as CoreConfig;
    expect(result.defaultModel).toBe("gpt-4");
    expect(result.hideTools).toBe(true);
    expect(result.chatTimeoutSecs).toBe(30);
  });

  it("recursively normalizes nested objects", () => {
    const obj = {
      custom_servers: [
        {
          server_name: "my-server",
          command_path: "/usr/bin/server",
        },
      ],
      profile_settings: {
        hide_thinking: true,
        max_iterations: 100,
      },
    };
    const result = normalizeConfigKeys(obj) as CoreConfig;
    expect((result.customServers as Record<string, unknown>[])[0]!.serverName).toBe("my-server");
    expect((result.customServers as Record<string, unknown>[])[0]!.commandPath).toBe("/usr/bin/server");
    expect((result.profileSettings as Record<string, unknown>).hideThinking).toBe(true);
  });

  it("returns primitives unchanged", () => {
    expect(normalizeConfigKeys("string")).toBe("string");
    expect(normalizeConfigKeys(42)).toBe(42);
    expect(normalizeConfigKeys(true)).toBe(true);
    expect(normalizeConfigKeys(null)).toBeNull();
    expect(normalizeConfigKeys(undefined)).toBeUndefined();
  });

  it("returns arrays with normalized items", () => {
    const arr = [{ snake_case: "value" }, { another_key: 123 }];
    const result = normalizeConfigKeys(arr) as Record<string, unknown>[];
    expect(result[0]!.snakeCase).toBe("value");
    expect(result[0]!.anotherKey).toBeUndefined();
    expect(result[1]!.anotherKey).toBe(123);
  });

  it("handles empty object", () => {
    expect(normalizeConfigKeys({})).toEqual({});
  });

  it("handles deeply nested objects (3+ levels)", () => {
    const obj = {
      level_one: {
        level_two: {
          level_three_key: "deep",
        },
      },
    };
    const result = normalizeConfigKeys(obj) as CoreConfig;
    expect(((result.levelOne as Record<string, unknown>).levelTwo as Record<string, unknown>).levelThreeKey).toBe("deep");
  });

  it("handles arrays of primitives", () => {
    const arr = [1, "two", true];
    const result = normalizeConfigKeys(arr) as unknown[];
    expect(result).toEqual([1, "two", true]);
  });

  it("handles mixed nested structures", () => {
    const obj = {
      simple_key: "value",
      nested_key: {
        inner_key: "inner",
      },
      array_key: [
        { item_key: "item" },
        "plain_string",
        42,
      ],
    };
    const result = normalizeConfigKeys(obj) as CoreConfig;
    expect(result.simpleKey).toBe("value");
    expect((result.nestedKey as Record<string, unknown>).innerKey).toBe("inner");
    expect((result.arrayKey as Record<string, unknown>[])[0]!.itemKey).toBe("item");
    expect((result.arrayKey as unknown[])[1]).toBe("plain_string");
    expect((result.arrayKey as unknown[])[2]).toBe(42);
  });
});

describe("buildAgentConfig", () => {
  const baseOpts = {
    cli: {},
    config: { providers: [], defaultModel: "test-model", hideTools: true, profilesPath: "./config/profiles" },
    configDir: "/tmp/test-config",
    providers: [],
    defaultModel: "qwen3.5-0.8b",
    profilesPath: "/tmp/test-config/profiles",
  };

  it("resolves basic config with all expected fields", async () => {
    const result = await buildAgentConfig(baseOpts) as CoreConfig;
    expect(result.model).toBeDefined();
    expect(result.configDir).toBe("/tmp/test-config");
    expect(result.profileName).toBeDefined();
    expect(result.systemPromptTemplate).toBeDefined();
    expect(result.profiles).toBeDefined();
    expect(result.modelRegistry).toBeDefined();
  });

  it("resolves model from CLI override", async () => {
    const result = await buildAgentConfig({ ...baseOpts, cli: { model: "cli-model" }, config: { ...baseOpts.config, defaultModel: "config-model" }, defaultModel: "default-model" }) as CoreConfig;
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
    }) as CoreConfig;
    expect(result.activeProvider).toBe("test-provider");
  });

  it("resolves profile from config", async () => {
    const result = await buildAgentConfig({ ...baseOpts, config: { ...baseOpts.config, profile: "fixer" as unknown as CoreConfig["profile"] } }) as CoreConfig;
    expect(result.profileName).toBe("fixer");
  });

  it("CLI profile overrides config profile", async () => {
    const result = await buildAgentConfig({
      ...baseOpts,
      cli: { profile: "explorer" },
      config: { ...baseOpts.config, profile: "fixer" as unknown as CoreConfig["profile"] },
    }) as CoreConfig;
    expect(result.profileName).toBe("explorer");
  });

  it("resolves hideTools and hideThinking from config", async () => {
    const result = await buildAgentConfig({
      ...baseOpts,
      config: { ...baseOpts.config, hideTools: false, hideThinking: true },
    }) as CoreConfig;
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
    expect(result.resolved).toBeDefined();
    expect(result.modelRegistry).toBeDefined();
  });

  it("merges profile from file", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-config-test-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'defaults.json'), JSON.stringify({ providers: [], defaultModel: "test" }));
      fs.mkdirSync(path.join(tmpDir, 'profiles'));
      fs.writeFileSync(path.join(tmpDir, 'profiles', 'fixer.profile.md'), `---\nrole: fixer\nwhitelistTools: [bash, read]\nmanager: true\n---\nFixer profile`);
      const result = await buildConfig({ configDir: tmpDir, profile: 'fixer' }) as CoreConfig;
      expect((result.resolved as CoreConfig).profileName).toBe('fixer');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
