import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { createMockCore } from "../helpers.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

// ── Shared helper to reduce boilerplate ─────────────────────────────────────

/**
 * Creates an info CLI extension, registers it, and returns a runner that
 * captures console.log output.
 *
 * Usage:
 *   const runner = await infoCliRunner(coreConfig, { wantsJson: true });
 *   const output = await runner("info", cliOverrides);
 *   // or
 *   const output = await runner("profiles", cliOverrides);
 */
async function infoCliRunner(coreConfig = {}, defaultCli = {}) {
  const core = createMockCore(coreConfig) as unknown as CoreContext;
  const { create } = await import("../../src/extensions/ui-info-cli/index.ts");
  const ext = create(core);
  await (ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER] as (registry: unknown) => void)(core.cliSubcommandRegistry);

  const baseCli = {
    wantsJson: false,
    colors: false,
    theme: "dark",
    config: null,
    skillsPath: null,
    configDir: null,
    config_debug: false,
    profile: null,
    provider: null,
    ...defaultCli,
  };

  return async (subcommand: string, cliOverrides = {}) => {
    const def = core.cliSubcommandRegistry.get(subcommand)!;
    const cli = { ...baseCli, ...cliOverrides };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      capturedOutput += args.join(" ") + "\n";
    };

    try {
      const exitCode = await def.handler!(cli, core);
      return { exitCode, output: capturedOutput };
    } finally {
      console.log = originalLog;
    }
  };
}

// ── printInfoText branches ──────────────────────────────────────────────────

describe("Info CLI - printInfoText branches", () => {
  it("shows whitelist tools when profile has whitelistTools", async () => {
    const run = await infoCliRunner({
      resolved: {
        profileName: "test",
        profile: { whitelistTools: ["read", "overwrite"] },
      },
    });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);
    expect(output).toContain("Whitelist Tools:");
    expect(output).toContain("read");
    expect(output).toContain("overwrite");
  });

  it("shows blacklist tools when profile has blacklistTools", async () => {
    const run = await infoCliRunner({
      resolved: {
        profileName: "test",
        profile: { blacklistTools: ["bash", "fetch"] },
      },
    });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);
    expect(output).toContain("Blacklist Tools:");
    expect(output).toContain("bash");
    expect(output).toContain("fetch");
  });

  it("shows providers when configured", async () => {
    const run = await infoCliRunner({
      providers: [
        {
          name: "test-provider",
          url: "http://test-provider:8080",
          models: [
            { name: "model-1", provider: "test-provider" },
            { name: "model-2", provider: "test-provider" },
          ],
        },
      ],
      resolved: {
        activeProvider: "test-provider",
      },
    });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);
    expect(output).toContain("Providers:");
    expect(output).toContain("test-provider");
    expect(output).toContain("(active)");
    expect(output).toContain("model-1");
    expect(output).toContain("Active Provider:");
  });

  it("shows MCP servers when configured", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-mcp-"));
    const configPath = join(tmpDir, "defaults.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: [
          { name: "server-http", url: "http://localhost:3000", enabled: true },
          { name: "server-stdio", command: "uvicorn", enabled: false },
        ],
      }),
    );

    try {
      const run = await infoCliRunner({}, { config: configPath });
      const { exitCode, output } = await run("info");
      expect(exitCode).toBe(0);
      expect(output).toContain("MCP Servers:");
      expect(output).toContain("server-http");
      expect(output).toContain("HTTP");
      expect(output).toContain("enabled");
      expect(output).toContain("server-stdio");
      expect(output).toContain("stdio");
      expect(output).toContain("disabled");
    } finally {
      try { rmSync(configPath); rmSync(tmpDir); } catch {}
    }
  });

  it("shows connectivity unreachable when ping fails", async () => {
    const run = await infoCliRunner({
      buildConfig: async () => ({
        resolved: {
          baseUrl: "http://nonexistent.invalid:99999",
          apiKey: "test-key",
          model: "test-model",
          stream: false,
          chatTimeout: 1,
          maxRetries: 3,
          profileName: "default",
          profile: {},
          activeProvider: null,
          configDir: join(homedir(), ".config", "hotdog"),
        },
        modelRegistry: {},
        providers: [],
      }),
    });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);
    expect(output).toContain("Connectivity:");
    expect(output).toContain("unreachable");
  });
});

// ── printInfoJson branches ──────────────────────────────────────────────────

describe("Info CLI - printInfoJson branches", () => {
  it("includes mcp_servers in JSON output", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-mcp-json-"));
    const configPath = join(tmpDir, "defaults.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: [
          { name: "test-server", url: "http://localhost:3000", enabled: true },
        ],
      }),
    );

    try {
      const run = await infoCliRunner({}, { wantsJson: true, config: configPath });
      const { exitCode, output } = await run("info");
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(output.trim());
      expect(parsed.mcp_servers).toBeDefined();
      expect(parsed.mcp_servers.length).toBe(1);
      expect(parsed.mcp_servers[0].name).toBe("test-server");
      expect(parsed.mcp_servers[0].enabled).toBe(true);
    } finally {
      try { rmSync(configPath); rmSync(tmpDir); } catch {}
    }
  });

  it("includes connectivity error in JSON output", async () => {
    const run = await infoCliRunner({
      buildConfig: async () => ({
        resolved: {
          baseUrl: "http://nonexistent.invalid:99999",
          apiKey: "test-key",
          model: "test-model",
          stream: false,
          chatTimeout: 1,
          maxRetries: 3,
          profileName: "default",
          profile: {},
          activeProvider: null,
          configDir: join(homedir(), ".config", "hotdog"),
        },
        modelRegistry: {},
        providers: [],
      }),
    }, { wantsJson: true });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output.trim());
    expect(parsed.connectivity.reachable).toBe(false);
    expect(parsed.connectivity.error).not.toBeNull();
  });

  it("includes profile whitelist and blacklist in JSON", async () => {
    const run = await infoCliRunner({
      resolved: {
        profileName: "test",
        profile: {
          whitelistTools: ["read", "overwrite"],
          blacklistTools: ["bash"],
        },
      },
    }, { wantsJson: true });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output.trim());
    expect(parsed.config.profile_whitelist).toEqual(["read", "overwrite"]);
    expect(parsed.config.profile_blacklist).toEqual(["bash"]);
  });

  it("includes providers in JSON output", async () => {
    const run = await infoCliRunner({
      providers: [
        {
          name: "test-provider",
          url: "http://test-provider:8080",
          models: [{ name: "model-1", provider: "test-provider" }],
        },
      ],
      resolved: {
        activeProvider: "test-provider",
      },
    }, { wantsJson: true });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output.trim());
    expect(parsed.providers.configured.length).toBe(1);
    expect(parsed.providers.configured[0].name).toBe("test-provider");
    expect(parsed.providers.active).toBe("test-provider");
  });

  it("includes model tags in JSON output", async () => {
    const run = await infoCliRunner({
      modelRegistry: {
        "test-model": { tags: ["fast", "coding"], provider: "test" },
      },
    }, { wantsJson: true });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);

    const parsed = JSON.parse(output.trim());
    const model = parsed.models.find((m: { name: string }) => m.name === "test-model");
    expect(model).toBeDefined();
    expect(model.tags).toContain("fast");
    expect(model.tags).toContain("coding");
  });
});

// ── config_debug ────────────────────────────────────────────────────────────

describe("Info CLI - config_debug", () => {
  it("runs config_debug when cli.config_debug is true", async () => {
    const run = await infoCliRunner({}, { config_debug: true });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);
    expect(output).toContain("=== Config Resolution Debug ===");
    expect(output).toContain("Profile:");
    expect(output).toContain("Provider:");
    expect(output).toContain("=== Non-Declarative Values ===");
    expect(output).toContain("=== Config File Sources ===");
    expect(output).toContain("=== Extension Config ===");
  });

  it("config_debug shows extension config when present", async () => {
    const run = await infoCliRunner({
      coreConfig: { customExtensionKey: "customValue" },
    }, { config_debug: true });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);
    expect(output).toContain("=== Extension Config ===");
  });

  it("config_debug with provider shows provider name", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-provider-"));
    const configPath = join(tmpDir, "defaults.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        defaultProvider: "test-provider",
        providers: [
          {
            name: "test-provider",
            url: "http://test:8080",
            models: [{ name: "m1", provider: "test-provider" }],
          },
        ],
      }),
    );

    try {
      const run = await infoCliRunner({
        providers: [
          {
            name: "test-provider",
            url: "http://test:8080",
            models: [{ name: "m1", provider: "test-provider" }],
          },
        ],
      }, { config: configPath, config_debug: true });
      const { exitCode, output } = await run("info");
      expect(exitCode).toBe(0);
      expect(output).toContain("test-provider");
    } finally {
      try { rmSync(configPath); rmSync(tmpDir); } catch {}
    }
  });

  it("config_debug shows config file content when exists", async () => {
    const tmpDir = join(homedir(), ".config", "hotdog-test-debug");
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, "defaults.json");
    writeFileSync(configPath, JSON.stringify({ defaultModel: "test-model" }));

    try {
      const run = await infoCliRunner({
        resolved: { configDir: tmpDir },
      }, { configDir: tmpDir, config_debug: true });
      const { exitCode, output } = await run("info");
      expect(exitCode).toBe(0);
      expect(output).toContain("EXISTS");
    } finally {
      try { rmSync(configPath); rmSync(tmpDir); } catch {}
    }
  });

  it("config_debug shows config file not found when absent", async () => {
    const tmpDir = join(homedir(), ".config", "hotdog-test-debug-absent");

    try {
      const run = await infoCliRunner({
        resolved: { configDir: tmpDir },
      }, { configDir: tmpDir, config_debug: true });
      const { exitCode, output } = await run("info");
      expect(exitCode).toBe(0);
      expect(output).toContain("not found");
    } finally {
      try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ── traceConfigResolution ───────────────────────────────────────────────────

describe("Info CLI - traceConfigResolution", () => {
  it("traces config resolution with default values", async () => {
    const run = await infoCliRunner({}, { config_debug: true });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);
    expect(output).toContain("Source:");
    expect(output).toContain("Type:");
  });
});

// ── show-prompt subcommand ──────────────────────────────────────────────────

describe("Info CLI - show-prompt subcommand", () => {
  it("shows system prompt and returns 0", async () => {
    const run = await infoCliRunner();
    const { exitCode, output } = await run("show-prompt");
    expect(exitCode).toBe(0);
    expect(output.length).toBeGreaterThan(0);
  });

  it("show-prompt with model registry", async () => {
    const run = await infoCliRunner({
      modelRegistry: {
        "test-model": { tags: ["fast"], provider: "test" },
      },
    });
    const { exitCode } = await run("show-prompt");
    expect(exitCode).toBe(0);
  });
});

// ── model tags in text output ───────────────────────────────────────────────

describe("Info CLI - model tags in text output", () => {
  it("shows model tags in text output", async () => {
    const run = await infoCliRunner({
      modelRegistry: {
        "test-model": { tags: ["fast", "coding"], provider: "test" },
        "empty-tags": { tags: [], provider: "test" },
        "no-tags": { provider: "test" },
      },
    });
    const { exitCode, output } = await run("info");
    expect(exitCode).toBe(0);
    expect(output).toContain("fast, coding");
    expect(output).toContain("no tags");
  });
});

// ── profiles subcommand ─────────────────────────────────────────────────────

describe("Info CLI - profiles subcommand", () => {
  it("registers the profiles subcommand", async () => {
    const run = await infoCliRunner();
    const core = createMockCore() as unknown as CoreContext;
    const { create } = await import("../../src/extensions/ui-info-cli/index.ts");
    const ext = create(core);
    await (ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER] as (registry: unknown) => void)(core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("profiles")!;
    expect(def).toBeDefined();
    expect(def.description).toBe("List all available profiles with their roles and tool restrictions");
  });

  it("shows no profiles when directory is empty", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-empty-"));
    try {
      const run = await infoCliRunner({
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "default", aspects: [] },
        }),
      });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      expect(output).toContain("No profiles configured.");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("lists profiles from file system", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-files-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "default.profile.md"),
      "---\nname: default\ndescription: Default profile\nrole: You are a helpful assistant.\n---\nBody content here.",
    );
    writeFileSync(
      join(profilesDir, "coder.profile.md"),
      "---\nname: coder\ndescription: Coding specialist\nrole: You are a coding expert.\nblacklist-tools: [browser]\nmanager: true\n---\nCoding body.",
    );

    try {
      const run = await infoCliRunner({
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "default", aspects: [] },
        }),
      });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      expect(output).toContain("=== Profiles (2) ===");
      expect(output).toContain("Profile: coder");
      expect(output).toContain("Profile: default");
      expect(output).toContain("← current");
      expect(output).toContain("Coding specialist");
      expect(output).toContain("You are a coding expert.");
      expect(output).toContain("Blacklisted tools: browser");
      expect(output).toContain("Manager: yes");
      expect(output).toContain("Body: 12 chars");
      expect(output).toContain("Source: file");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("merges file and config profiles", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-merge-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "test.profile.md"),
      "---\nname: test\ndescription: From file\nrole: File role\n---\nFile body.",
    );

    try {
      const run = await infoCliRunner({
        coreConfig: {
          profiles: {
            test: {
              description: "From config",
              model: "gpt-4",
              blacklist_tools: ["network"],
            },
          },
        },
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "test", aspects: [] },
        }),
      });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      expect(output).toContain("Profile: test");
      expect(output).toContain("← current");
      expect(output).toContain("From file");
      expect(output).toContain("Model: gpt-4");
      expect(output).toContain("Blacklisted tools: network");
      expect(output).toContain("Source: file + config");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("outputs JSON when wantsJson is true", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-json-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "worker.profile.md"),
      "---\nname: worker\ndescription: A worker profile\nrole: Do work.\nvisible-worker: true\n---\nWork body.",
    );

    try {
      const run = await infoCliRunner({
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "worker", aspects: ["guidelines"] },
        }),
      }, { wantsJson: true });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.trim());
      expect(parsed).toHaveLength(1);
      expect(parsed[0].name).toBe("worker");
      expect(parsed[0].current).toBe(true);
      expect(parsed[0].description).toBe("A worker profile");
      expect(parsed[0].role).toBe("Do work.");
      expect(parsed[0].subagent).toBe(true);
      expect(parsed[0].aspects).toEqual(["guidelines"]);
      expect(parsed[0].sources).toEqual(["file"]);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles non-existent profiles directory gracefully", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-noexist-"));

    try {
      const run = await infoCliRunner({
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "default", aspects: [] },
        }),
      });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      expect(output).toContain("No profiles configured.");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows visible-worker flag for profiles that have it", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-visible-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "switchable.profile.md"),
      "---\nname: switchable\nvisible-worker: true\n---\nBody.",
    );
    writeFileSync(
      join(profilesDir, "hidden.profile.md"),
      "---\nname: hidden\n---\nBody.",
    );

    try {
      const run = await infoCliRunner({
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "default", aspects: [] },
        }),
      });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      expect(output).toContain("Subagent: yes");
      const hiddenIdx = output.indexOf("Profile: hidden");
      const subagentIdx = output.indexOf("Subagent: yes");
      expect(hiddenIdx).toBeLessThan(subagentIdx);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows manager with available subagents", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-manager-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "boss.profile.md"),
      "---\nname: boss\nmanager: true\n---\nManage.",
    );
    writeFileSync(
      join(profilesDir, "worker1.profile.md"),
      "---\nname: worker1\nvisible-worker: true\n---\nWork1.",
    );
    writeFileSync(
      join(profilesDir, "worker2.profile.md"),
      "---\nname: worker2\nvisible-worker: true\n---\nWork2.",
    );

    try {
      const run = await infoCliRunner({
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "default", aspects: [] },
        }),
      });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      expect(output).toContain("Manager: yes (subagents:");
      expect(output).toContain("worker1");
      expect(output).toContain("worker2");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows manager with no subagents available", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-managernone-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "lonely.profile.md"),
      "---\nname: lonely\nmanager: true\n---\nAlone.",
    );

    try {
      const run = await infoCliRunner({
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "default", aspects: [] },
        }),
      });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      expect(output).toContain("Manager: yes (no subagents available)");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows relative profile file path from cwd", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-relpath-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "test.profile.md"),
      "---\nname: test\n---\nBody.",
    );

    try {
      const run = await infoCliRunner({
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "default", aspects: [] },
        }),
      });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      expect(output).toContain("Profile:");
      expect(output).toContain("profiles/test.profile.md");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes subagent and availableSubagents in JSON output", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profiles-json-sub-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "boss.profile.md"),
      "---\nname: boss\nmanager: true\n---\nManage.",
    );
    writeFileSync(
      join(profilesDir, "labeller.profile.md"),
      "---\nname: labeller\nvisible-worker: true\n---\nLabel.",
    );

    try {
      const run = await infoCliRunner({
        buildConfig: async () => ({
          resolved: { configDir: tmpDir, profileName: "default", aspects: [] },
        }),
      }, { wantsJson: true });
      const { exitCode, output } = await run("profiles");
      expect(exitCode).toBe(0);
      const parsed = JSON.parse(output.trim());
      const boss = parsed.find((p: { name: string }) => p.name === "boss");
      const labeller = parsed.find((p: { name: string }) => p.name === "labeller");
      expect(boss.manager).toBe(true);
      expect(boss.subagent).toBe(false);
      expect(boss.availableSubagents).toEqual(["labeller"]);
      expect(labeller.subagent).toBe(true);
      expect(labeller.availableSubagents).toBeNull();
      expect(boss.profileRelPath).toBeDefined();
      expect(boss.profileRelPath).toContain("boss.profile.md");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
