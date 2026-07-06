import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.js";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.js";
import { createSubcommandRegistry } from "../../src/core/extensions/registries.js";
import { mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

function createMockCore(config = {}) {
  const hooks = new HookSystem();
  const toolRegistry = new ToolRegistry();
  const cliSubcommandRegistry = createSubcommandRegistry();

  const resolved = {
    baseUrl: "http://localhost:8080",
    apiKey: "test-key",
    model: "test-model",
    stream: false,
    chatTimeout: 30,
    profileName: "default",
    profile: {},
    hideTools: false,
    hideThinking: false,
    showTokenUse: false,
    role: "",
    profileBody: "",
    activeProvider: null,
    configDir: join(homedir(), ".config", "hotdog"),
    ...config.resolved,
  };

  return {
    hooks,
    toolRegistry,
    cliSubcommandRegistry,
    config: {
      theme: "dark",
      maxIterations: 100,
      skillsPath: join(homedir(), ".hotdog", "skills"),
      ...config.coreConfig,
    },
    resolved,
    modelRegistry: config.modelRegistry || {},
    extensions: {
      has: () => false,
      load: async () => null,
      cleanup: async () => {},
    },
    buildConfig:
      config.buildConfig ||
      (async () => ({
        resolved,
        modelRegistry: config.modelRegistry || {},
        providers: config.providers || [],
      })),
  };
}

describe("Info CLI - printInfoText branches", () => {
  it("shows whitelist tools when profile has whitelistTools", async () => {
    const core = createMockCore({
      resolved: {
        profileName: "test",
        profile: { whitelistTools: ["read", "write"] },
      },
    });
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: false,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("Whitelist Tools:");
      expect(capturedOutput).toContain("read");
      expect(capturedOutput).toContain("write");
    } finally {
      console.log = originalLog;
    }
  });

  it("shows blacklist tools when profile has blacklistTools", async () => {
    const core = createMockCore({
      resolved: {
        profileName: "test",
        profile: { blacklistTools: ["bash", "fetch"] },
      },
    });
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: false,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("Blacklist Tools:");
      expect(capturedOutput).toContain("bash");
      expect(capturedOutput).toContain("fetch");
    } finally {
      console.log = originalLog;
    }
  });

  it("shows providers when configured", async () => {
    const core = createMockCore({
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
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: false,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("Providers:");
      expect(capturedOutput).toContain("test-provider");
      expect(capturedOutput).toContain("(active)");
      expect(capturedOutput).toContain("model-1");
      expect(capturedOutput).toContain("Active Provider:");
    } finally {
      console.log = originalLog;
    }
  });

  it("shows MCP servers when configured", async () => {
    // Create a temp config file with MCP servers
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
      const core = createMockCore();
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("info");
      const cli = {
        wantsJson: false,
        colors: false,
        theme: "dark",
        config: configPath,
        skillsPath: null,
        configDir: null,
        config_debug: false,
      };

      let capturedOutput = "";
      const originalLog = console.log;
      console.log = (msg) => {
        capturedOutput += msg + "\n";
      };

      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        expect(capturedOutput).toContain("MCP Servers:");
        expect(capturedOutput).toContain("server-http");
        expect(capturedOutput).toContain("HTTP");
        expect(capturedOutput).toContain("enabled");
        expect(capturedOutput).toContain("server-stdio");
        expect(capturedOutput).toContain("stdio");
        expect(capturedOutput).toContain("disabled");
      } finally {
        console.log = originalLog;
      }
    } finally {
      try {
        rmSync(configPath);
        rmSync(tmpDir);
      } catch {}
    }
  });

  it("shows connectivity unreachable when ping fails", async () => {
    // Create a core with a buildConfig that returns a client that fails ping
    const core = createMockCore({
      buildConfig: async () => ({
        resolved: {
          baseUrl: "http://nonexistent.invalid:99999",
          apiKey: "test-key",
          model: "test-model",
          stream: false,
          chatTimeout: 1,
          profileName: "default",
          profile: {},
          activeProvider: null,
          configDir: join(homedir(), ".config", "hotdog"),
        },
        modelRegistry: {},
        providers: [],
      }),
    });

    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: false,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("Connectivity:");
      expect(capturedOutput).toContain("unreachable");
    } finally {
      console.log = originalLog;
    }
  });
});

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
      const core = createMockCore();
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("info");
      const cli = {
        wantsJson: true,
        colors: false,
        theme: "dark",
        config: configPath,
        skillsPath: null,
        configDir: null,
        config_debug: false,
      };

      let capturedOutput = "";
      const originalLog = console.log;
      console.log = (msg) => {
        capturedOutput += msg + "\n";
      };

      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);

        const parsed = JSON.parse(capturedOutput.trim());
        expect(parsed.mcp_servers).toBeDefined();
        expect(parsed.mcp_servers.length).toBe(1);
        expect(parsed.mcp_servers[0].name).toBe("test-server");
        expect(parsed.mcp_servers[0].enabled).toBe(true);
      } finally {
        console.log = originalLog;
      }
    } finally {
      try {
        rmSync(configPath);
        rmSync(tmpDir);
      } catch {}
    }
  });

  it("includes connectivity error in JSON output", async () => {
    const core = createMockCore({
      buildConfig: async () => ({
        resolved: {
          baseUrl: "http://nonexistent.invalid:99999",
          apiKey: "test-key",
          model: "test-model",
          stream: false,
          chatTimeout: 1,
          profileName: "default",
          profile: {},
          activeProvider: null,
          configDir: join(homedir(), ".config", "hotdog"),
        },
        modelRegistry: {},
        providers: [],
      }),
    });

    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: true,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: false,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed.connectivity.reachable).toBe(false);
      expect(parsed.connectivity.error).not.toBeNull();
    } finally {
      console.log = originalLog;
    }
  });

  it("includes profile whitelist and blacklist in JSON", async () => {
    const core = createMockCore({
      resolved: {
        profileName: "test",
        profile: {
          whitelistTools: ["read", "write"],
          blacklistTools: ["bash"],
        },
      },
    });
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: true,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: false,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed.config.profile_whitelist).toEqual(["read", "write"]);
      expect(parsed.config.profile_blacklist).toEqual(["bash"]);
    } finally {
      console.log = originalLog;
    }
  });

  it("includes providers in JSON output", async () => {
    const core = createMockCore({
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
    });
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: true,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: false,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(capturedOutput.trim());
      expect(parsed.providers.configured.length).toBe(1);
      expect(parsed.providers.configured[0].name).toBe("test-provider");
      expect(parsed.providers.active).toBe("test-provider");
    } finally {
      console.log = originalLog;
    }
  });

  it("includes model tags in JSON output", async () => {
    const core = createMockCore({
      modelRegistry: {
        "test-model": { tags: ["fast", "coding"], provider: "test" },
      },
    });
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: true,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: false,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);

      const parsed = JSON.parse(capturedOutput.trim());
      const model = parsed.models.find((m) => m.name === "test-model");
      expect(model).toBeDefined();
      expect(model.tags).toContain("fast");
      expect(model.tags).toContain("coding");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("Info CLI - config_debug", () => {
  it("runs config_debug when cli.config_debug is true", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: true,
      profile: null,
      provider: null,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("=== Config Resolution Debug ===");
      expect(capturedOutput).toContain("Profile:");
      expect(capturedOutput).toContain("Provider:");
      expect(capturedOutput).toContain("=== Non-Declarative Values ===");
      expect(capturedOutput).toContain("=== Config File Sources ===");
      expect(capturedOutput).toContain("=== Extension Config ===");
    } finally {
      console.log = originalLog;
    }
  });

  it("config_debug shows extension config when present", async () => {
    const core = createMockCore({
      coreConfig: {
        customExtensionKey: "customValue",
      },
    });
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: true,
      profile: null,
      provider: null,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("=== Extension Config ===");
    } finally {
      console.log = originalLog;
    }
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
      const core = createMockCore({
        providers: [
          {
            name: "test-provider",
            url: "http://test:8080",
            models: [{ name: "m1", provider: "test-provider" }],
          },
        ],
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("info");
      const cli = {
        wantsJson: false,
        colors: false,
        theme: "dark",
        config: configPath,
        skillsPath: null,
        configDir: null,
        config_debug: true,
        profile: null,
        provider: null,
      };

      let capturedOutput = "";
      const originalLog = console.log;
      console.log = (msg) => {
        capturedOutput += msg + "\n";
      };

      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        expect(capturedOutput).toContain("test-provider");
      } finally {
        console.log = originalLog;
      }
    } finally {
      try {
        rmSync(configPath);
        rmSync(tmpDir);
      } catch {}
    }
  });

  it("config_debug shows config file content when exists", async () => {
    // Create a temporary config file
    const tmpDir = join(homedir(), ".config", "hotdog-test-debug");
    mkdirSync(tmpDir, { recursive: true });
    const configPath = join(tmpDir, "defaults.json");
    writeFileSync(configPath, JSON.stringify({ defaultModel: "test-model" }));

    try {
      const core = createMockCore({
        resolved: {
          configDir: tmpDir,
        },
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("info");
      const cli = {
        wantsJson: false,
        colors: false,
        theme: "dark",
        config: null,
        skillsPath: null,
        configDir: tmpDir,
        config_debug: true,
        profile: null,
        provider: null,
      };

      let capturedOutput = "";
      const originalLog = console.log;
      console.log = (msg) => {
        capturedOutput += msg + "\n";
      };

      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        expect(capturedOutput).toContain("EXISTS");
      } finally {
        console.log = originalLog;
      }
    } finally {
      try {
        rmSync(configPath);
        rmSync(tmpDir);
      } catch {}
    }
  });

  it("config_debug shows config file not found when absent", async () => {
    const tmpDir = join(homedir(), ".config", "hotdog-test-debug-absent");
    // Don't create the dir

    try {
      const core = createMockCore({
        resolved: {
          configDir: tmpDir,
        },
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("info");
      const cli = {
        wantsJson: false,
        colors: false,
        theme: "dark",
        config: null,
        skillsPath: null,
        configDir: tmpDir,
        config_debug: true,
        profile: null,
        provider: null,
      };

      let capturedOutput = "";
      const originalLog = console.log;
      console.log = (msg) => {
        capturedOutput += msg + "\n";
      };

      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        expect(capturedOutput).toContain("not found");
      } finally {
        console.log = originalLog;
      }
    } finally {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch {}
    }
  });
});

describe("Info CLI - traceConfigResolution", () => {
  it("traces config resolution with default values", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: true,
      profile: null,
      provider: null,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      // Verify that layer trace markers appear
      expect(capturedOutput).toContain("Source:");
      expect(capturedOutput).toContain("Type:");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("Info CLI - show-prompt subcommand", () => {
  it("shows system prompt and returns 0", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("show-prompt");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      // Should output the system prompt
      expect(capturedOutput.length).toBeGreaterThan(0);
    } finally {
      console.log = originalLog;
    }
  });

  it("show-prompt with model registry", async () => {
    const core = createMockCore({
      modelRegistry: {
        "test-model": { tags: ["fast"], provider: "test" },
      },
    });
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("show-prompt");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
    } finally {
      console.log = originalLog;
    }
  });
});

describe("Info CLI - model tags in text output", () => {
  it("shows model tags in text output", async () => {
    const core = createMockCore({
      modelRegistry: {
        "test-model": { tags: ["fast", "coding"], provider: "test" },
        "empty-tags": { tags: [], provider: "test" },
        "no-tags": { provider: "test" },
      },
    });
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("info");
    const cli = {
      wantsJson: false,
      colors: false,
      theme: "dark",
      config: null,
      skillsPath: null,
      configDir: null,
      config_debug: false,
    };

    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (msg) => {
      capturedOutput += msg + "\n";
    };

    try {
      const exitCode = await def.handler(cli, core);
      expect(exitCode).toBe(0);
      expect(capturedOutput).toContain("fast, coding");
      expect(capturedOutput).toContain("no tags");
    } finally {
      console.log = originalLog;
    }
  });
});

describe("Info CLI - profile-list subcommand", () => {
  function captureLogs() {
    let capturedOutput = "";
    const originalLog = console.log;
    console.log = (...args) => {
      capturedOutput += args.join(" ") + "\n";
    };
    return { capturedOutput: () => capturedOutput, restore: () => { console.log = originalLog; } };
  }

  it("registers the profile-list subcommand", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-info-cli/index.js");
    const ext = create(core);
    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("profile-list");
    expect(def).toBeDefined();
    expect(def.description).toBe("List all available profiles with their roles and tool restrictions");
  });

  it("shows no profiles when directory is empty", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-empty-"));
    try {
      const core = createMockCore({
        buildConfig: async () => ({
          resolved: {
            configDir: tmpDir,
            profileName: "default",
            aspects: [],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = {
        wantsJson: false,
        profile: null,
        configDir: null,
      };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        expect(logs.capturedOutput()).toContain("No profiles configured.");
      } finally {
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("lists profiles from file system", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-files-"));
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
      const core = createMockCore({
        buildConfig: async () => ({
          resolved: {
            configDir: tmpDir,
            profileName: "default",
            aspects: [],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = {
        wantsJson: false,
        profile: null,
        configDir: null,
      };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        const output = logs.capturedOutput();
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
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("merges file and config profiles", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-merge-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "test.profile.md"),
      "---\nname: test\ndescription: From file\nrole: File role\n---\nFile body.",
    );

    try {
      const core = createMockCore({
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
          resolved: {
            configDir: tmpDir,
            profileName: "test",
            aspects: [],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = {
        wantsJson: false,
        profile: null,
        configDir: null,
      };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        const output = logs.capturedOutput();
        expect(output).toContain("Profile: test");
        expect(output).toContain("← current");
        // File description takes priority
        expect(output).toContain("From file");
        // Config model shows up
        expect(output).toContain("Model: gpt-4");
        // Config blacklist shows up
        expect(output).toContain("Blacklisted tools: network");
        // Source shows both
        expect(output).toContain("Source: file + config");
      } finally {
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("outputs JSON when wantsJson is true", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-json-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "worker.profile.md"),
      "---\nname: worker\ndescription: A worker profile\nrole: Do work.\nvisible-worker: true\n---\nWork body.",
    );

    try {
      const core = createMockCore({
        buildConfig: async () => ({
          resolved: {
            configDir: tmpDir,
            profileName: "worker",
            aspects: ["guidelines"],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = {
        wantsJson: true,
        profile: null,
        configDir: null,
      };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(logs.capturedOutput().trim());
        expect(parsed).toHaveLength(1);
        expect(parsed[0].name).toBe("worker");
        expect(parsed[0].current).toBe(true);
        expect(parsed[0].description).toBe("A worker profile");
        expect(parsed[0].role).toBe("Do work.");
        expect(parsed[0].subagent).toBe(true);
        expect(parsed[0].aspects).toEqual(["guidelines"]);
        expect(parsed[0].sources).toEqual(["file"]);
      } finally {
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("handles non-existent profiles directory gracefully", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-noexist-"));
    // Intentionally do NOT create a profiles subdirectory

    try {
      const core = createMockCore({
        buildConfig: async () => ({
          resolved: {
            configDir: tmpDir,
            profileName: "default",
            aspects: [],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = {
        wantsJson: false,
        profile: null,
        configDir: null,
      };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        expect(logs.capturedOutput()).toContain("No profiles configured.");
      } finally {
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows visible-worker flag for profiles that have it", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-visible-"));
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
      const core = createMockCore({
        buildConfig: async () => ({
          resolved: {
            configDir: tmpDir,
            profileName: "default",
            aspects: [],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = {
        wantsJson: false,
        profile: null,
        configDir: null,
      };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        const output = logs.capturedOutput();
        expect(output).toContain("Subagent: yes");
        // hidden profile should not have subagent line
        const hiddenIdx = output.indexOf("Profile: hidden");
        const subagentIdx = output.indexOf("Subagent: yes");
        expect(hiddenIdx).toBeLessThan(subagentIdx);
      } finally {
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows manager with available subagents", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-manager-"));
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
      const core = createMockCore({
        buildConfig: async () => ({
          resolved: {
            configDir: tmpDir,
            profileName: "default",
            aspects: [],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = { wantsJson: false, profile: null, configDir: null };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        const output = logs.capturedOutput();
        expect(output).toContain("Manager: yes (subagents: worker1, worker2)");
      } finally {
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows manager with no subagents available", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-managernone-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "lonely.profile.md"),
      "---\nname: lonely\nmanager: true\n---\nAlone.",
    );

    try {
      const core = createMockCore({
        buildConfig: async () => ({
          resolved: {
            configDir: tmpDir,
            profileName: "default",
            aspects: [],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = { wantsJson: false, profile: null, configDir: null };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        const output = logs.capturedOutput();
        expect(output).toContain("Manager: yes (no subagents available)");
      } finally {
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("shows relative profile file path from cwd", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-relpath-"));
    const profilesDir = join(tmpDir, "profiles");
    mkdirSync(profilesDir, { recursive: true });

    writeFileSync(
      join(profilesDir, "test.profile.md"),
      "---\nname: test\n---\nBody.",
    );

    try {
      const core = createMockCore({
        buildConfig: async () => ({
          resolved: {
            configDir: tmpDir,
            profileName: "default",
            aspects: [],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = { wantsJson: false, profile: null, configDir: null };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        const output = logs.capturedOutput();
        expect(output).toContain("Profile:");
        expect(output).toContain("profiles/test.profile.md");
      } finally {
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("includes subagent and availableSubagents in JSON output", async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "hotdog-test-profile-list-json-sub-"));
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
      const core = createMockCore({
        buildConfig: async () => ({
          resolved: {
            configDir: tmpDir,
            profileName: "default",
            aspects: [],
          },
        }),
      });
      const { create } = await import("../../src/extensions/ui-info-cli/index.js");
      const ext = create(core);
      await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

      const def = core.cliSubcommandRegistry.get("profile-list");
      const cli = { wantsJson: true, profile: null, configDir: null };

      const logs = captureLogs();
      try {
        const exitCode = await def.handler(cli, core);
        expect(exitCode).toBe(0);
        const parsed = JSON.parse(logs.capturedOutput().trim());
        const boss = parsed.find((p) => p.name === "boss");
        const labeller = parsed.find((p) => p.name === "labeller");
        expect(boss.manager).toBe(true);
        expect(boss.subagent).toBe(false);
        expect(boss.availableSubagents).toEqual(["labeller"]);
        expect(labeller.subagent).toBe(true);
        expect(labeller.availableSubagents).toBeNull();
        expect(boss.profileRelPath).toBeDefined();
        expect(boss.profileRelPath).toContain("boss.profile.md");
      } finally {
        logs.restore();
      }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
