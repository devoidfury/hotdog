// Extended tests for config/index.js — normalizeConfigKeys, buildAgentConfig, buildConfig.

import { describe, it, expect } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  normalizeConfigKeys,
  buildAgentConfig,
  buildConfig,
} from "../../src/core/config/index.js";

describe("normalizeConfigKeys", () => {
  it("converts snake_case keys to camelCase", () => {
    const obj = {
      default_model: "gpt-4",
      hide_tools: true,
      chat_timeout_secs: 30,
    };
    const result = normalizeConfigKeys(obj);
    expect(result.defaultModel).toBe("gpt-4");
    expect(result.hideTools).toBe(true);
    expect(result.chatTimeoutSecs).toBe(30);
  });

  it("recursively normalizes nested objects", () => {
    const obj = {
      mcp_servers: [
        {
          server_name: "my-server",
          command_path: "/usr/bin/mcp",
        },
      ],
      profile_settings: {
        hide_thinking: true,
        max_iterations: 100,
      },
    };
    const result = normalizeConfigKeys(obj);
    expect(result.mcpServers[0].serverName).toBe("my-server");
    expect(result.mcpServers[0].commandPath).toBe("/usr/bin/mcp");
    expect(result.profileSettings.hideThinking).toBe(true);
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
    const result = normalizeConfigKeys(arr);
    expect(result[0].snakeCase).toBe("value");
    expect(result[0].anotherKey).toBeUndefined();
    expect(result[1].anotherKey).toBe(123);
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
    const result = normalizeConfigKeys(obj);
    expect(result.levelOne.levelTwo.levelThreeKey).toBe("deep");
  });

  it("handles arrays of primitives", () => {
    const arr = [1, "two", true];
    const result = normalizeConfigKeys(arr);
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
    const result = normalizeConfigKeys(obj);
    expect(result.simpleKey).toBe("value");
    expect(result.nestedKey.innerKey).toBe("inner");
    expect(result.arrayKey[0].itemKey).toBe("item");
    expect(result.arrayKey[1]).toBe("plain_string");
    expect(result.arrayKey[2]).toBe(42);
  });
});

describe("buildAgentConfig", () => {
  it("resolves basic config with minimal options", async () => {
    const result = await buildAgentConfig({
      cli: {},
      config: {
        providers: [],
        defaultModel: "test-model",
        hideTools: true,
        profilesPath: "./config/profiles",
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "qwen3.5-0.8b",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.model).toBeDefined();
    expect(result.configDir).toBe("/tmp/test-config");
  });

  it("resolves model from CLI override", async () => {
    const result = await buildAgentConfig({
      cli: { model: "cli-model" },
      config: {
        providers: [],
        defaultModel: "config-model",
        hideTools: true,
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "default-model",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.model).toBe("cli-model");
  });

  it("resolves model from provider default", async () => {
    const provider = {
      name: "test-provider",
      models: [{ name: "provider-model" }],
    };
    const result = await buildAgentConfig({
      cli: { provider: "test-provider" },
      config: {
        providers: [provider],
        defaultModel: "config-model",
        hideTools: true,
      },
      configDir: "/tmp/test-config",
      providers: [provider],
      defaultModel: "default-model",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.activeProvider).toBe("test-provider");
  });

  it("resolves with default profile when none specified", async () => {
    const result = await buildAgentConfig({
      cli: {},
      config: {
        providers: [],
        defaultModel: "test-model",
        hideTools: true,
        profilesPath: "./config/profiles",
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "qwen3.5-0.8b",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.profileName).toBeDefined();
  });

  it("resolves profile from config", async () => {
    const result = await buildAgentConfig({
      cli: {},
      config: {
        providers: [],
        defaultModel: "test-model",
        hideTools: true,
        profile: "fixer",
        profilesPath: "./config/profiles",
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "qwen3.5-0.8b",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.profileName).toBe("fixer");
  });

  it("resolves profile from CLI override", async () => {
    const result = await buildAgentConfig({
      cli: { profile: "explorer" },
      config: {
        providers: [],
        defaultModel: "test-model",
        hideTools: true,
        profile: "fixer",
        profilesPath: "./config/profiles",
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "qwen3.5-0.8b",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.profileName).toBe("explorer");
  });

  it("includes systemPromptTemplate in result", async () => {
    const result = await buildAgentConfig({
      cli: {},
      config: {
        providers: [],
        defaultModel: "test-model",
        hideTools: true,
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "qwen3.5-0.8b",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.systemPromptTemplate).toBeDefined();
  });

  it("includes profiles in result", async () => {
    const result = await buildAgentConfig({
      cli: {},
      config: {
        providers: [],
        defaultModel: "test-model",
        hideTools: true,
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "qwen3.5-0.8b",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.profiles).toBeDefined();
  });

  it("includes modelRegistry in result", async () => {
    const result = await buildAgentConfig({
      cli: {},
      config: {
        providers: [],
        defaultModel: "test-model",
        hideTools: true,
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "qwen3.5-0.8b",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.modelRegistry).toBeDefined();
  });

  it("resolves hideTools from config", async () => {
    const result = await buildAgentConfig({
      cli: {},
      config: {
        providers: [],
        defaultModel: "test-model",
        hideTools: false,
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "qwen3.5-0.8b",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.hideTools).toBe(false);
  });

  it("resolves hideThinking from config", async () => {
    const result = await buildAgentConfig({
      cli: {},
      config: {
        providers: [],
        defaultModel: "test-model",
        hideTools: true,
        hideThinking: true,
      },
      configDir: "/tmp/test-config",
      providers: [],
      defaultModel: "qwen3.5-0.8b",
      profilesPath: "/tmp/test-config/profiles",
    });

    expect(result.hideThinking).toBe(true);
  });

  it("buildConfig resolves config directory", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hotdog-config-test-'));
    try {
      // Create minimal config files
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

  it("buildConfig handles missing config dir gracefully", async () => {
    const result = await buildConfig({ configDir: '/nonexistent/path' });
    expect(result.resolved).toBeDefined();
    expect(result.modelRegistry).toBeDefined();
  });

  it("buildConfig merges profile from file", async () => {
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
