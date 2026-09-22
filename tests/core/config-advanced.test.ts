// Extended tests for config/index.js — normalizeConfigKeys, buildAgentConfig, buildConfig.

import { describe, it, expect } from "bun:test";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import {
  normalizeConfigKeys,
  interpolateEnvVars,
  loadConfig,
  buildAgentConfig,
  buildConfig,
} from "@core/config/index.ts";
import type { CoreConfigWithExtensions } from "@core/config/schema-loader.ts";
import { ConfigError } from "@core/error.ts";
import { createHooks } from "@core/hooks.ts";
import { initializeLogger, resetLoggerForTesting, type LogEvent } from "@utils/logger.ts";

// ── interpolateEnvVars ($VAR in config files) ───────────────────────────────

describe("interpolateEnvVars", () => {
  it("resolves whole-string $VAR and ${VAR} from the env", () => {
    const env = { MY_TOKEN: "sekret" };
    const result = interpolateEnvVars(
      {
        apiKey: "$MY_TOKEN",
        url: "${MY_TOKEN}",
        partial: "http://x/$MY_TOKEN",
        literal: "cost $5",
        notVar: "$9LIVES",
        nested: { deep: ["$MY_TOKEN", 42, null] },
      },
      env,
    ) as Record<string, unknown>;
    expect(result.apiKey).toBe("sekret");
    expect(result.url).toBe("sekret");
    expect(result.partial).toBe("http://x/$MY_TOKEN");
    expect(result.literal).toBe("cost $5");
    expect(result.notVar).toBe("$9LIVES");
    const nested = result.nested as Record<string, unknown>;
    expect((nested.deep as unknown[])[0]).toBe("sekret");
    expect((nested.deep as unknown[])[1]).toBe(42);
    expect((nested.deep as unknown[])[2]).toBeNull();
  });

  it("warns and resolves unset variables to empty string", () => {
    expect(interpolateEnvVars({ apiKey: "$NOPE_MISSING" }, {})).toEqual({ apiKey: "" });
    expect(interpolateEnvVars({ url: "${NOPE_MISSING}" }, {})).toEqual({ url: "" });
    expect(() => interpolateEnvVars([{ a: "$NOPE_MISSING" }], {})).not.toThrow();
  });

  it("warns once per unset variable across repeated load passes", () => {
    // Capture logger output via the "log" hook (no mock.module).
    resetLoggerForTesting();
    const hooks = createHooks();
    const lines: string[] = [];
    hooks.on("log", (data) => {
      const ev = data as LogEvent;
      if (ev.level === "warn") lines.push(ev.message);
    });
    initializeLogger({ hooks, minLevel: "warn", target: "none" });
    try {
      expect(interpolateEnvVars({ apiKey: "$DEDUPE_TEST_MISSING" }, {})).toEqual({ apiKey: "" });
      expect(interpolateEnvVars({ apiKey: "$DEDUPE_TEST_MISSING" }, {})).toEqual({ apiKey: "" });
      expect(lines.filter((l) => l.includes("DEDUPE_TEST_MISSING"))).toHaveLength(1);
    } finally {
      resetLoggerForTesting();
    }
  });

  it("loadConfig interpolates config-file values from process.env", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-envvar-cfg-"));
    try {
      fs.writeFileSync(
        path.join(dir, "defaults.json"),
        JSON.stringify({ api_key: "$HOTDOG_TEST_INTERP", default_model: "m-$HOTDOG_TEST_INTERP" }),
      );
      process.env.HOTDOG_TEST_INTERP = "from-env";
      try {
        const cfg = await loadConfig(path.join(dir, "defaults.json"));
        expect(cfg.apiKey).toBe("from-env");
        // Not a whole-string reference -- left alone.
        expect(cfg.model).toBeUndefined();
      } finally {
        delete process.env.HOTDOG_TEST_INTERP;
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("loadConfig continues with an empty value for an unset variable", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-envvar-missing-"));
    try {
      fs.writeFileSync(
        path.join(dir, "defaults.json"),
        JSON.stringify({ api_key: "$HOTDOG_TEST_UNSET_VAR" }),
      );
      const cfg = await loadConfig(path.join(dir, "defaults.json"));
      expect(cfg.apiKey).toBe("");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

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

  it("leaves env-object property names untouched (env var names must not be mangled)", () => {
    const result = normalizeConfigKeys({
      bash_tool: { bash_timeout_ms: 100, env: { http_proxy: "http://p", aws_secret_key: "s" } },
      mcp_servers: [{ name: "s", env: { some_token: "t", "MY-FLAG": "f" } }],
    }) as Record<string, unknown>;

    expect((result.bashTool as Record<string, unknown>).bashTimeoutMs).toBe(100);
    const bashEnv = (result.bashTool as Record<string, unknown>).env as Record<string, unknown>;
    expect(bashEnv.http_proxy).toBe("http://p");
    expect(bashEnv.aws_secret_key).toBe("s");
    const mcpEnv = ((result.mcpServers as Record<string, unknown>[])[0]!.env) as Record<string, unknown>;
    expect(mcpEnv.some_token).toBe("t");
    expect(mcpEnv["MY-FLAG"]).toBe("f");
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

  it("resolves model from the HOTDOG_MODEL env var", async () => {
    // Regression: the env layers of the defaultModel schema must reach the
    // final resolved model, not just resolved.defaultModel.
    const original = process.env.HOTDOG_MODEL;
    process.env.HOTDOG_MODEL = "env-provider/env-model";
    try {
      const result = await buildAgentConfig({
        ...baseOpts,
        config: { ...baseOpts.config, defaultModel: "test-model" } as CoreConfigWithExtensions,
        defaultModel: null,
      });
      // The env layer sits above the config layer per the schema.
      expect(result.model).toBe("env-provider/env-model");
    } finally {
      if (original === undefined) delete process.env.HOTDOG_MODEL;
      else process.env.HOTDOG_MODEL = original;
    }
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
    // No model anywhere in the resolution chain: resolution stays null and
    // the hard error surfaces at agent construction, not here.
    expect(result.resolved.model).toBeNull();
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

  it("drops a workspace path that does not exist but keeps the rest", async () => {
    const result = await buildAgentConfig({
      ...baseOpts,
      config: {
        ...baseOpts.config,
        workspace: { paths: ["/definitely/not/a/real/path", "."] },
      },
    });
    expect(result.workspaceRoots).toEqual([process.cwd()]);
  });

  it("rejects a workspace.paths where no entry exists", async () => {
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

describe("buildAgentConfig — workspaceDeny", () => {
  const baseOpts = {
    cli: {},
    config: { providers: [], defaultModel: "test-model", hideTools: true, profilesPath: "./config/profiles" } as CoreConfigWithExtensions,
    configDir: "/tmp/test-config",
    providers: [],
    defaultModel: "qwen3.5-0.8b",
    profilesPath: "/tmp/test-config/profiles",
  };

  it("defaults to the built-in deny list", async () => {
    const result = await buildAgentConfig(baseOpts);
    expect(result.workspaceDeny).toEqual([
      ".ssh",
      ".config",
      ".git",
      ".aws",
      ".azure",
      ".docker",
      ".gnupg",
      ".kube",
      ".*profile",
      ".*rc",
      "*.local*",
      ".env*",
      "!.env.example",
    ]);
  });

  it("honors workspace.deny from the config file", async () => {
    const result = await buildAgentConfig({
      ...baseOpts,
      config: { ...baseOpts.config, workspace: { deny: [".ssh"] } },
    });
    expect(result.workspaceDeny).toEqual([".ssh"]);
  });

  it("resolves workspace.deny alongside workspace.paths", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hotdog-ws-deny-"));
    try {
      const result = await buildAgentConfig({
        ...baseOpts,
        config: {
          ...baseOpts.config,
          workspace: { paths: [dir], deny: [] },
        },
      });
      expect(result.workspaceRoots).toEqual([dir]);
      // Explicit empty array is an opt-out, not a fall-back to the default.
      expect(result.workspaceDeny).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
