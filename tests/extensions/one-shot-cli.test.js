import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.js";
import { ToolRegistry } from "../../src/core/extensions/tool-registry.js";
import { createSubcommandRegistry } from "../../src/core/extensions/registries.js";
import { join } from "node:path";
import { homedir } from "node:os";

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

describe("One-Shot Extension - CLI_ARGS_PARSED hook", () => {
  it("sets subcommand to 'prompt' when --prompt flag is present", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    const cli = { prompt: "test prompt" };
    ext.hooks[HOOKS.CLI_ARGS_PARSED]({ cli });

    expect(cli.subcommand).toBe("prompt");
  });

  it("does not set subcommand when --prompt flag is absent", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    const cli = { prompt: null };
    ext.hooks[HOOKS.CLI_ARGS_PARSED]({ cli });

    expect(cli.subcommand).toBeUndefined();
  });

  it("does not set subcommand when --prompt is empty string", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    const cli = { prompt: "" };
    ext.hooks[HOOKS.CLI_ARGS_PARSED]({ cli });

    expect(cli.subcommand).toBeUndefined();
  });

  it("sets subcommand when --prompt has whitespace", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    const cli = { prompt: "  hello  " };
    ext.hooks[HOOKS.CLI_ARGS_PARSED]({ cli });

    expect(cli.subcommand).toBe("prompt");
  });

  it("sets subcommand when --prompt is 0 (falsy but present)", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    const cli = { prompt: 0 };
    ext.hooks[HOOKS.CLI_ARGS_PARSED]({ cli });

    // 0 is falsy, so subcommand should not be set
    expect(cli.subcommand).toBeUndefined();
  });
});

describe("One-Shot Extension - prompt subcommand registration", () => {
  it("registers prompt subcommand via CLI_SUBCOMMANDS_REGISTER hook", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("prompt")).toBe(true);
    const def = core.cliSubcommandRegistry.get("prompt");
    expect(def.handler).toBeDefined();
    expect(typeof def.handler).toBe("function");
  });

  it("prompt subcommand has correct description", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("prompt");
    expect(def.description).toContain("One-shot");
    expect(def.description).toContain("single prompt");
  });
});

describe("One-Shot Extension - create function", () => {
  it("returns object with hooks when core.hooks exists", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create(core);

    expect(ext.hooks).toBeDefined();
    expect(ext.hooks[HOOKS.CLI_ARGS_PARSED]).toBeDefined();
    expect(ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();
  });

  it("returns object with undefined hooks when core.hooks is null", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.js");
    const ext = create({ hooks: null });

    expect(ext.hooks).toBeUndefined();
  });
});
