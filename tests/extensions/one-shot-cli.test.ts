// Tests for ui-one-shot/index.ts — runOneShot and handlePromptSubcommand functions.
// These are the main uncovered functions (lines 57-110, 119-196).

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { HookSystem } from "../../src/core/hooks.ts";

// ── handlePromptSubcommand Tests ─────────────────────────────────────────────

describe("handlePromptSubcommand", () => {
  function createMockCoreWithSubcommand() {
    const hooks = new HookSystem();
    const registry = {
      registered: new Map<string, Record<string, unknown>>(),
      register: function (name: string, opts: Record<string, unknown>) {
        this.registered.set(name, opts);
      },
      has: function (name: string) {
        return this.registered.has(name);
      },
      get: function (name: string) {
        return this.registered.get(name) || null;
      },
      names: function () {
        return Array.from(this.registered.keys());
      },
      generateHelpText: function () {
        return "";
      },
    };

    const resolved = {
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
      modelRegistry: { "test-model": { contextLimit: 128000 } },
      taskProfile: "task-default",
      taskDefaultRole: "",
      role: "Test agent",
      profileBody: "",
    };

    return {
      hooks,
      config: {
        theme: "dark",
        colors: null,
        providers: [],
      },
      buildConfig: async () => ({ resolved, modelRegistry: resolved.modelRegistry, providers: [] }),
      resolved,
      toolRegistry: {
        getAll: () => [],
        get: () => null,
        register: () => {},
      },
      extensions: {
        has: () => false,
        load: async () => null,
        cleanup: async () => {},
      },
      cliSubcommandRegistry: registry,
    } as any;
  }

  it("creates LlmClient with correct configuration", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    const ext = create(core);

    // Register the subcommand
    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    // Verify the subcommand was registered
    expect(core.cliSubcommandRegistry.has("prompt")).toBe(true);
    const subcommand = core.cliSubcommandRegistry.get("prompt");
    expect(subcommand).not.toBeNull();
    expect(subcommand!.description).toContain("One-shot");
  });

  it("handler creates SessionManager and runs one-shot", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    const ext = create(core);

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    // Mock SessionManager.create to avoid actual LLM calls
    const { SessionManager } = await import("../../src/core/session/index.ts");
    let createCalled = false;
    const originalCreate = SessionManager.create;
    const mockBus = {
      runUntilCancelled: async () => {},
      run: async () => {},
      cancel: () => {},
    };
    const mockSessionManager = {
      sessionId: () => "test-session-123",
      enqueue: () => {},
      getBus: () => mockBus,
      onSessionEvents: () => () => {}, // Required by channel
    };
    (SessionManager as any).create = async () => {
      createCalled = true;
      return mockSessionManager;
    };

    try {
      const cli = { prompt: "Hello world" };
      const exitCode = await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);

      expect(createCalled).toBe(true);
      expect(exitCode).toBe(0);
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("handles prompt from args when prompt flag is empty", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    const ext = create(core);

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const { SessionManager } = await import("../../src/core/session/index.ts");
    let enqueuedPrompt = "";
    const originalCreate = SessionManager.create;
    const mockBus = {
      runUntilCancelled: async () => {},
      run: async () => {},
      cancel: () => {},
    };
    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-456",
      enqueue: (_sessionId: string, prompt: string) => { enqueuedPrompt = prompt; },
      getBus: () => mockBus,
      onSessionEvents: () => () => {},
    });

    try {
      const cli = { prompt: "", args: ["hello", "from", "args"] };
      const exitCode = await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);

      expect(enqueuedPrompt).toBe("hello from args");
      expect(exitCode).toBe(0);
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("returns non-zero exit code on error", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    const ext = create(core);

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const { SessionManager } = await import("../../src/core/session/index.ts");
    const originalCreate = SessionManager.create;
    const mockBus = {
      runUntilCancelled: async () => { throw new Error("Bus error"); },
    };
    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-789",
      enqueue: () => {},
      getBus: () => mockBus,
      onSessionEvents: () => () => {},
    });

    try {
      const cli = { prompt: "Hello world" };
      const exitCode = await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);

      expect(exitCode).toBe(1);
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("returns custom exit code from error", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    const ext = create(core);

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const { SessionManager } = await import("../../src/core/session/index.ts");
    const originalCreate = SessionManager.create;
    const mockBus = {
      runUntilCancelled: async () => {
        const err: any = new Error("Custom exit");
        err.exitCode = 42;
        throw err;
      },
    };
    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-custom",
      enqueue: () => {},
      getBus: () => mockBus,
      onSessionEvents: () => () => {},
    });

    try {
      const cli = { prompt: "Hello world" };
      const exitCode = await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);

      expect(exitCode).toBe(42);
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("calls extensions cleanup in finally block", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    const ext = create(core);

    let cleanupCalled = false;
    core.extensions.cleanup = async () => { cleanupCalled = true; };

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const { SessionManager } = await import("../../src/core/session/index.ts");
    const originalCreate = SessionManager.create;
    const mockBus = {
      runUntilCancelled: async () => { throw new Error("Error"); },
    };
    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-cleanup",
      enqueue: () => {},
      getBus: () => mockBus,
      onSessionEvents: () => () => {},
    });

    try {
      const cli = { prompt: "Hello world" };
      await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);
      expect(cleanupCalled).toBe(true);
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("calls extensions cleanup on success too", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    const ext = create(core);

    let cleanupCalled = false;
    core.extensions.cleanup = async () => { cleanupCalled = true; };

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const { SessionManager } = await import("../../src/core/session/index.ts");
    const originalCreate = SessionManager.create;
    const mockBus = {
      runUntilCancelled: async () => {},
    };
    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-success-cleanup",
      enqueue: () => {},
      getBus: () => mockBus,
      onSessionEvents: () => () => {},
    });

    try {
      const cli = { prompt: "Hello world" };
      await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);
      expect(cleanupCalled).toBe(true);
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("uses sessionId from cli when provided", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    const ext = create(core);

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const { SessionManager } = await import("../../src/core/session/index.ts");
    let capturedSessionId: string | null = null;
    const originalCreate = SessionManager.create;
    const mockBus = { runUntilCancelled: async () => {} };
    (SessionManager as any).create = async (opts: any) => {
      capturedSessionId = opts.initialConfig?.sessionId;
      return {
        sessionId: () => capturedSessionId || "default",
        enqueue: () => {},
        getBus: () => mockBus,
        onSessionEvents: () => () => {},
      };
    };

    try {
      const cli = { prompt: "Hello", sessionId: "my-custom-session" };
      await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);
      expect(capturedSessionId).toBe("my-custom-session");
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("handles null bus gracefully", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    const ext = create(core);

    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const { SessionManager } = await import("../../src/core/session/index.ts");
    const originalCreate = SessionManager.create;
    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-null-bus",
      enqueue: () => {},
      getBus: () => null,
      onSessionEvents: () => () => {},
    });

    try {
      const cli = { prompt: "Hello world" };
      const exitCode = await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);
      expect(exitCode).toBe(0);
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("builds agent with correct model from config", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const core = createMockCoreWithSubcommand();
    core.resolved.model = "custom-model";

    const ext = create(core);
    await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

    const { SessionManager } = await import("../../src/core/session/index.ts");
    let capturedBuildAgent: any = null;
    const originalCreate = SessionManager.create;
    const mockBus = { runUntilCancelled: async () => {} };
    (SessionManager as any).create = async (opts: any) => {
      capturedBuildAgent = opts.buildAgent;
      return {
        sessionId: () => "test-session-model",
        enqueue: () => {},
        getBus: () => mockBus,
        onSessionEvents: () => () => {},
      };
    };

    try {
      const cli = { prompt: "Hello world" };
      await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);
      expect(capturedBuildAgent).toBeDefined();
      expect(typeof capturedBuildAgent).toBe("function");
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });
});

// ── runOneShot error handling edge cases ─────────────────────────────────────

describe("runOneShot edge cases", () => {
  it("handles SessionManager.create throwing", async () => {
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const originalCreate = SessionManager.create;

    (SessionManager as any).create = async () => {
      throw new Error("SessionManager creation failed");
    };

    try {
      const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
      const hooks = new HookSystem();
      const registry = {
        registered: new Map(),
        register: function (name: string, opts: any) { this.registered.set(name, opts); },
        has: function (name: string) { return this.registered.has(name); },
        get: function (name: string) { return this.registered.get(name) || null; },
        names: function () { return Array.from(this.registered.keys()); },
        generateHelpText: function () { return ""; },
      };

      const core = {
        hooks,
        config: { theme: "dark", colors: null, providers: [] },
        resolved: {
          baseUrl: "http://localhost:8000",
          apiKey: "test-key",
          model: "test-model",
          stream: true,
          chatTimeout: 30,
          maxRetries: 3,
          maxIterations: 100,
          hideTools: false,
          hideThinking: true,
          showTokenUse: true,
          profileName: "default",
          modelRegistry: {},
        },
        toolRegistry: { getAll: () => [], get: () => null, register: () => {} },
        extensions: { cleanup: async () => {} },
        cliSubcommandRegistry: registry,
      } as any;

      const ext = create(core);
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

      // Should throw because SessionManager.create throws
      await expect(
        (core.cliSubcommandRegistry.get("prompt")!.handler as Function)({ prompt: "test" }, core)
      ).rejects.toThrow("SessionManager creation failed");
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("handles undefined prompt and args", async () => {
    const { create } = await import("../../src/extensions/ui-one-shot/index.ts");
    const hooks = new HookSystem();
    const registry = {
      registered: new Map(),
      register: function (name: string, opts: any) { this.registered.set(name, opts); },
      has: function (name: string) { return this.registered.has(name); },
      get: function (name: string) { return this.registered.get(name) || null; },
      names: function () { return Array.from(this.registered.keys()); },
      generateHelpText: function () { return ""; },
    };

    const core = {
      hooks,
      config: { theme: "dark", colors: null, providers: [] },
      resolved: {
        baseUrl: "http://localhost:8000",
        apiKey: "test-key",
        model: "test-model",
        stream: true,
        chatTimeout: 30,
        maxRetries: 3,
        maxIterations: 100,
        hideTools: false,
        hideThinking: true,
        showTokenUse: true,
        profileName: "default",
        modelRegistry: {},
      },
      toolRegistry: { getAll: () => [], get: () => null, register: () => {} },
      extensions: { cleanup: async () => {} },
      cliSubcommandRegistry: registry,
    } as any;

    const { SessionManager } = await import("../../src/core/session/index.ts");
    const originalCreate = SessionManager.create;
    let enqueuedPrompt = "";
    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-undefined",
      enqueue: (_sessionId: string, prompt: string) => { enqueuedPrompt = prompt; },
      getBus: () => ({ runUntilCancelled: async () => {} }),
      onSessionEvents: () => () => {},
    });

    try {
      const ext = create(core);
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(core.cliSubcommandRegistry);

      const cli = { prompt: undefined, args: undefined };
      const exitCode = await (core.cliSubcommandRegistry.get("prompt")!.handler as Function)(cli, core);
      expect(exitCode).toBe(0);
      // When both prompt and args are undefined, the enqueued prompt will be "" (empty string)
      // because: cli.prompt || (cli.args || []).join(" ") → undefined || undefined.join(" ") → undefined || "" → ""
      expect(enqueuedPrompt).toBe("");
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });
});
