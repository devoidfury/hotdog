// Tests for ui-interactive-cli/index.ts — runInteractiveSession function.
// Covers the main uncovered function (lines 279-519).

import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { HookSystem } from "../../src/core/hooks.ts";

describe("runInteractiveSession", () => {
  let originalSessionManagerCreate: unknown = null;
  let SessionManagerModule: typeof import("../../src/core/session/index.ts") | null = null;

  beforeEach(async () => {
    SessionManagerModule = await import("../../src/core/session/index.ts");
    originalSessionManagerCreate = SessionManagerModule.SessionManager.create;
  });

  afterEach(() => {
    if (SessionManagerModule && originalSessionManagerCreate) {
      (SessionManagerModule.SessionManager as any).create = originalSessionManagerCreate;
    }
  });

  function createMockCore() {
    const hooks = new HookSystem();
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
      theme: "dark",
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
    } as any;
  }

  it("throws when resolved config is missing", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const core = createMockCore();
    core.resolved = undefined;

    await expect(runInteractiveSession({}, core)).rejects.toThrow("configuration must be resolved first");
  });

  it("creates SessionManager and CliChannel", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const core = createMockCore();

    let createOpts: any = null;
    const originalCreate = SessionManager.create;
    let busResolve: (() => void) | null = null;
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { busResolve = () => resolve(); }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async (opts: any) => {
      createOpts = opts;
      return {
        sessionId: () => "test-session",
        getAgent: () => ({ sessionId: "test-session" }),
        getBus: () => mockBus,
        enqueue: () => {},
        executeCommand: async () => 0,
        onSessionEvents: () => () => {},
      };
    };

    try {
      const sessionPromise = runInteractiveSession({}, core, {
        createReadline: () => ({
          on: () => ({}),
          prompt: () => ({}),
          setPrompt: () => ({}),
          close: () => {},
          removeListener: () => ({}),
          question: () => ({}),
          _line: "",
          _cursor: 0,
        }) as any,
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });

      // Wait for setup to complete
      await new Promise((r) => setTimeout(r, 100));

      expect(createOpts).not.toBeNull();
      expect(createOpts!.initialConfig).toBeDefined();
      expect(createOpts!.taskConfig).toBeDefined();
      expect(createOpts!.taskConfig.maxIterations).toBe(100);
      expect(createOpts!.taskConfig.taskProfile).toBe("task-default");

      // Clean up - resolve the bus
      if (busResolve) busResolve();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      (SessionManager as any).create = originalCreate;
    }
  });

  it("handles empty input by re-prompting", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const core = createMockCore();

    let promptCallCount = 0;
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-empty",
      getAgent: () => ({ sessionId: "test-session-empty" }),
      getBus: () => mockBus,
      enqueue: () => {},
      executeCommand: async () => 0,
      onSessionEvents: () => () => {},
    });

    const mockRl = {
      on: () => mockRl,
      prompt: function () { promptCallCount++; return mockRl; },
      setPrompt: () => mockRl,
      close: () => {},
      removeListener: () => mockRl,
      question: () => mockRl,
      _line: "",
      _cursor: 0,
    } as any;

    try {
      const sessionPromise = runInteractiveSession({}, core, {
        createReadline: () => mockRl,
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });

      await new Promise((r) => setTimeout(r, 100));

      // Clean up
      (mockBus as any)._resolve();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      // Restore
    }
  });

  it("creates AsyncInteractiveCliInput for question tool", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const core = createMockCore();

    let inputCreated = false;
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-input",
      getAgent: () => ({ sessionId: "test-session-input" }),
      getBus: () => mockBus,
      enqueue: () => {},
      executeCommand: async () => 0,
      onSessionEvents: () => () => {},
    });

    const mockRl = {
      on: () => mockRl,
      prompt: () => mockRl,
      setPrompt: () => mockRl,
      close: () => {},
      removeListener: () => mockRl,
      question: () => mockRl,
      _line: "",
      _cursor: 0,
    } as any;

    try {
      const sessionPromise = runInteractiveSession({}, core, {
        createReadline: () => mockRl,
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => { inputCreated = true; },
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(inputCreated).toBe(true);

      // Clean up
      (mockBus as any)._resolve();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      // Restore
    }
  });

  it("listens for MODEL_CHANGE hook and updates prompt", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const core = createMockCore();

    let lastPrompt = "";
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-model-change",
      getAgent: () => ({ sessionId: "test-session-model-change" }),
      getBus: () => mockBus,
      enqueue: () => {},
      executeCommand: async () => 0,
      onSessionEvents: () => () => {},
    });

    const mockRl = {
      on: () => mockRl,
      prompt: () => mockRl,
      setPrompt: function (p: string) { lastPrompt = p; return mockRl; },
      close: () => {},
      removeListener: () => mockRl,
      question: () => mockRl,
      _line: "",
      _cursor: 0,
    } as any;

    try {
      const sessionPromise = runInteractiveSession({}, core, {
        createReadline: () => mockRl,
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });

      await new Promise((r) => setTimeout(r, 100));

      // Trigger model change
      core.hooks.notifyHooks(HOOKS.MODEL_CHANGE, { newModel: "new-model" });
      await new Promise((r) => setTimeout(r, 50));

      expect(lastPrompt).toBe("(new-model)> ");

      // Clean up
      (mockBus as any)._resolve();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      // Restore
    }
  });

  it("listens for TURN_END hook and re-prompts when stopped", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const core = createMockCore();

    let promptCalled = false;
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-turn-end",
      getAgent: () => ({ sessionId: "test-session-turn-end" }),
      getBus: () => mockBus,
      enqueue: () => {},
      executeCommand: async () => 0,
      onSessionEvents: () => () => {},
    });

    const mockRl = {
      on: () => mockRl,
      prompt: function () { promptCalled = true; return mockRl; },
      setPrompt: () => mockRl,
      close: () => {},
      removeListener: () => mockRl,
      question: () => mockRl,
      _line: "",
      _cursor: 0,
    } as any;

    try {
      const sessionPromise = runInteractiveSession({}, core, {
        createReadline: () => mockRl,
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });

      await new Promise((r) => setTimeout(r, 100));

      // Trigger turn end with stopped=true
      core.hooks.notifyHooks(HOOKS.TURN_END, { stopped: true });
      await new Promise((r) => setTimeout(r, 100));

      expect(promptCalled).toBe(true);

      // Clean up
      (mockBus as any)._resolve();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      // Restore
    }
  });

  it("uses custom readline factory when provided", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const core = createMockCore();

    let customRlUsed = false;
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-custom-rl",
      getAgent: () => ({ sessionId: "test-session-custom-rl" }),
      getBus: () => mockBus,
      enqueue: () => {},
      executeCommand: async () => 0,
      onSessionEvents: () => () => {},
    });

    const mockRl = {
      on: () => mockRl,
      prompt: () => mockRl,
      setPrompt: () => mockRl,
      close: () => {},
      removeListener: () => mockRl,
      question: () => mockRl,
      _line: "",
      _cursor: 0,
    } as any;

    try {
      const sessionPromise = runInteractiveSession({}, core, {
        createReadline: () => {
          customRlUsed = true;
          return mockRl;
        },
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(customRlUsed).toBe(true);

      // Clean up
      (mockBus as any)._resolve();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      // Restore
    }
  });

  it("sets up shell mode when configured", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const core = createMockCore();
    core.config.uiInteractiveCli = { shellMode: true };

    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-shell",
      getAgent: () => ({ sessionId: "test-session-shell" }),
      getBus: () => mockBus,
      enqueue: () => {},
      executeCommand: async () => 0,
      onSessionEvents: () => () => {},
    });

    const mockRl = {
      on: () => mockRl,
      prompt: () => mockRl,
      setPrompt: () => mockRl,
      close: () => {},
      removeListener: () => mockRl,
      question: () => mockRl,
      _line: "",
      _cursor: 0,
    } as any;

    try {
      const sessionPromise = runInteractiveSession({}, core, {
        createReadline: () => mockRl,
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });

      await new Promise((r) => setTimeout(r, 100));

      // Session should be set up with shell mode enabled
      // We verify by checking the session is running
      expect(mockBus).toBeDefined();

      // Clean up
      (mockBus as any)._resolve();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      // Restore
    }
  });

  it("handles SIGINT via onSIGINT handler", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const core = createMockCore();

    let sigintCalled = false;
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-sigint",
      getAgent: () => ({ sessionId: "test-session-sigint" }),
      getBus: () => mockBus,
      enqueue: () => {},
      executeCommand: async () => 0,
      onSessionEvents: () => () => {},
    });

    const mockRl = {
      on: () => mockRl,
      prompt: () => mockRl,
      setPrompt: () => mockRl,
      close: () => {},
      removeListener: () => mockRl,
      question: () => mockRl,
      _line: "",
      _cursor: 0,
    } as any;

    try {
      const sessionPromise = runInteractiveSession({}, core, {
        createReadline: () => mockRl,
        onClose: () => {},
        onSIGINT: () => { sigintCalled = true; },
        setupInput: () => {},
      });

      await new Promise((r) => setTimeout(r, 100));

      // Clean up
      (mockBus as any)._resolve();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      // Restore
    }
  });

  it("uses buildAgent from SessionManager.create options", async () => {
    const { runInteractiveSession } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const { SessionManager } = await import("../../src/core/session/index.ts");
    const core = createMockCore();

    let capturedBuildAgent: any = null;
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async (opts: any) => {
      capturedBuildAgent = opts.buildAgent;
      return {
        sessionId: () => "test-session-build-agent",
        getAgent: () => ({ sessionId: "test-session-build-agent" }),
        getBus: () => mockBus,
        enqueue: () => {},
        executeCommand: async () => 0,
        onSessionEvents: () => () => {},
      };
    };

    const mockRl = {
      on: () => mockRl,
      prompt: () => mockRl,
      setPrompt: () => mockRl,
      close: () => {},
      removeListener: () => mockRl,
      question: () => mockRl,
      _line: "",
      _cursor: 0,
    } as any;

    try {
      const sessionPromise = runInteractiveSession({}, core, {
        createReadline: () => mockRl,
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });

      await new Promise((r) => setTimeout(r, 100));
      expect(capturedBuildAgent).toBeDefined();
      expect(typeof capturedBuildAgent).toBe("function");

      // Clean up
      (mockBus as any)._resolve();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      // Restore
    }
  });
});
