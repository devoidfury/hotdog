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
