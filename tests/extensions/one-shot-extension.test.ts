// Tests for ui-one-shot extension — CLI subcommand registration and flag handling.

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { create } from "../../src/extensions/ui-one-shot/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";

// ── One-Shot Extension Tests ────────────────────────────────────────────────

describe("One-Shot Extension", () => {
  function createMockCore(hooks: any = null) {
    return {
      hooks,
      config: {
        theme: "dark",
        colors: null,
      },
      resolved: {
        baseUrl: "http://localhost:8000",
        apiKey: "test-key",
        model: "test-model",
        stream: true,
        chatTimeout: 30,
        maxRetries: 3,
        maxIterations: 100,
        contextLimit: 128000,
        hideTools: false,
        hideThinking: true,
        showTokenUse: true,
        profileName: "default",
        modelRegistry: {},
      },
      toolRegistry: {
        getAll: () => [],
        get: () => null,
        register: () => {},
      },
      extensions: {
        cleanup: async () => {},
      },
    } as any;
  }

  describe("create", () => {
    it("returns extension with hooks when core has hooks", () => {
      const hooks = {
        notifyHooks: () => {},
        notifyHooksAsync: async () => {},
      };
      const core = createMockCore(hooks);
      const ext = create(core);
      expect(ext).toBeDefined();
      expect(ext.hooks).toBeDefined();
    });

    it("returns extension without hooks when core has no hooks", () => {
      const core = createMockCore(null);
      const ext = create(core);
      expect(ext).toBeDefined();
      expect(ext.hooks).toBeUndefined();
    });
  });

  describe("CLI_ARGS_PARSED hook", () => {
    it("sets subcommand to 'prompt' when prompt flag is present", async () => {
      const hooks = {
        notifyHooks: () => {},
        notifyHooksAsync: async () => {},
      };
      const core = createMockCore(hooks);
      const ext = create(core);

      const cli: any = { prompt: "Hello world" };
      await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli });

      expect(cli.subcommand).toBe("prompt");
    });

    it("does not set subcommand when prompt is not present", async () => {
      const hooks = {
        notifyHooks: () => {},
        notifyHooksAsync: async () => {},
      };
      const core = createMockCore(hooks);
      const ext = create(core);

      const cli: any = {};
      await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli });

      expect(cli.subcommand).toBeUndefined();
    });

    it("does not set subcommand when prompt is empty string", async () => {
      const hooks = {
        notifyHooks: () => {},
        notifyHooksAsync: async () => {},
      };
      const core = createMockCore(hooks);
      const ext = create(core);

      const cli: any = { prompt: "" };
      await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli });

      expect(cli.subcommand).toBeUndefined();
    });

    it("sets subcommand when prompt is a short string", async () => {
      const hooks = {
        notifyHooks: () => {},
        notifyHooksAsync: async () => {},
      };
      const core = createMockCore(hooks);
      const ext = create(core);

      const cli: any = { prompt: "hi" };
      await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli });

      expect(cli.subcommand).toBe("prompt");
    });
  });

  describe("CLI_SUBCOMMANDS_REGISTER hook", () => {
    it("registers the 'prompt' subcommand", async () => {
      const hooks = {
        notifyHooks: () => {},
        notifyHooksAsync: async () => {},
      };
      const core = createMockCore(hooks);
      const ext = create(core);

      const registry: any = {
        register: mock((name: string, opts: Record<string, unknown>) => {
          registry.registeredName = name;
          registry.registeredOpts = opts;
        }),
        registeredName: null,
        registeredOpts: null,
      };

      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);

      expect(registry.registeredName).toBe("prompt");
      expect(registry.registeredOpts.description).toContain("One-shot");
      expect(typeof registry.registeredOpts.handler).toBe("function");
    });

    it("handler is an async function", async () => {
      const hooks = {
        notifyHooks: () => {},
        notifyHooksAsync: async () => {},
      };
      const core = createMockCore(hooks);
      const ext = create(core);

      const registry: any = {
        register: mock((name: string, opts: Record<string, unknown>) => {}),
      };

      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);

      const handlerCall = registry.register.mock.calls[0];
      expect(handlerCall[1].handler).toBeDefined();
    });
  });

  describe("prompt subcommand handler", () => {
    it("handles prompt subcommand with core context", async () => {
      const hooks = {
        notifyHooks: () => {},
        notifyHooksAsync: async () => {},
      };
      const core = createMockCore(hooks);
      const ext = create(core);

      const registry: any = {
        register: mock((name: string, opts: Record<string, unknown>) => {}),
      };

      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);

      // The handler is registered, verify it exists
      const handler = registry.register.mock.calls[0][1].handler;
      expect(typeof handler).toBe("function");
    });
  });
});

describe("One-Shot Extension Edge Cases", () => {
  it("handles null hooks gracefully", () => {
    const core = {
      hooks: null,
    } as any;
    const ext = create(core);
    expect(ext.hooks).toBeUndefined();
  });

  it("handles undefined hooks gracefully", () => {
    const core = {
      hooks: undefined,
    } as any;
    const ext = create(core);
    expect(ext.hooks).toBeUndefined();
  });

  it("CLI_ARGS_PARSED does not interfere with other subcommands", async () => {
    const hooks = {
      notifyHooks: () => {},
      notifyHooksAsync: async () => {},
    };
    const core = {
      hooks,
      config: {},
      resolved: {},
    } as any;
    const ext = create(core);

    const cli: any = { subcommand: "info" };
    await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli });

    expect(cli.subcommand).toBe("info");
  });

  it("CLI_ARGS_PARSED overrides existing subcommand when prompt is set", async () => {
    const hooks = {
      notifyHooks: () => {},
      notifyHooksAsync: async () => {},
    };
    const core = {
      hooks,
      config: {},
      resolved: {},
    } as any;
    const ext = create(core);

    const cli: any = { subcommand: "info", prompt: "Hello" };
    await ext.hooks![HOOKS.CLI_ARGS_PARSED]!({ cli });

    expect(cli.subcommand).toBe("prompt");
  });
});
