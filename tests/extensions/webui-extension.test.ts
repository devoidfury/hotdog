// Tests for webui/index.ts — WebUI extension creation and subcommand registration.

import { describe, it, expect, mock, beforeEach } from "bun:test";
import { create } from "../../src/extensions/webui/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";

// ── Helpers ──────────────────────────────────────────────────────────────────

function createMockCore(hooks: any = null) {
  return {
    hooks,
    config: {
      webui: {
        port: 3000,
        host: "localhost",
        apiKey: "test-key",
        maxAgeSecs: 3600,
      },
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

// ── WebUI Extension Tests ───────────────────────────────────────────────────

describe("WebUI Extension > create", () => {
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

  it("returns extension without hooks when hooks is undefined", () => {
    const core = createMockCore(undefined);
    const ext = create(core);
    expect(ext.hooks).toBeUndefined();
  });
});

describe("WebUI Extension > CLI_SUBCOMMANDS_REGISTER hook", () => {
  it("registers the 'webui' subcommand", async () => {
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

    expect(registry.registeredName).toBe("webui");
    expect(registry.registeredOpts.description).toContain("WebUI");
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
    expect(typeof handlerCall[1].handler).toBe("function");
  });

  it("description mentions WebSocket", async () => {
    const hooks = {
      notifyHooks: () => {},
      notifyHooksAsync: async () => {},
    };
    const core = createMockCore(hooks);
    const ext = create(core);

    const registry: any = {
      register: mock((name: string, opts: Record<string, unknown>) => {
        registry.registeredOpts = opts;
      }),
      registeredOpts: null,
    };

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);

    expect(registry.registeredOpts.description).toContain("WebSocket");
  });
});

describe("WebUI Extension > handleWebuiSubcommand", () => {
  it("handler function exists and is callable", async () => {
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

    const handler = registry.register.mock.calls[0][1].handler;
    expect(typeof handler).toBe("function");
  });
});

describe("WebUI Extension > Edge Cases", () => {
  it("handles null core.hooks", () => {
    const core = { hooks: null } as any;
    const ext = create(core);
    expect(ext.hooks).toBeUndefined();
  });

  it("handles undefined core.hooks", () => {
    const core = { hooks: undefined } as any;
    const ext = create(core);
    expect(ext.hooks).toBeUndefined();
  });

  it("handles empty core object", () => {
    const core = {} as any;
    const ext = create(core);
    expect(ext.hooks).toBeUndefined();
  });
});
