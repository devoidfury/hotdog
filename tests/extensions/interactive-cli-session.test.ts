// Tests for ui-interactive-cli/index.ts — runInteractiveSession function.
// Covers the main uncovered function (lines 279-519).

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HOOKS } from "../../src/core/hooks.ts";
import { HookSystem } from "../../src/core/hooks.ts";
import { createCompletionService } from "../../src/core/completion.ts";
import { LlmClient } from "../../src/core/llm-client/client.ts";

/** Poll a condition until true (deterministic replacement for fixed sleeps). */
async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
}

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
      createLlmClient: ((overrides?: Record<string, unknown>) =>
        new LlmClient({ baseUrl: "http://localhost:8000", apiKey: "test-key", stream: true,
          chatTimeoutSecs: 30, maxRetries: 3, ...overrides })) as any,
      completion: createCompletionService(),
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
        getTaskManager: () => null,
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
      await waitFor(() => createOpts !== null);

      expect(createOpts).not.toBeNull();
      expect(createOpts!.initialConfig).toBeDefined();
      expect(createOpts!.taskConfig).toBeDefined();
      expect(createOpts!.taskConfig.maxIterations).toBe(100);
      expect(createOpts!.taskConfig.taskProfile).toBe("task-default");

      // Clean up - resolve the bus
      if (busResolve) (busResolve as () => void)();
      try { await sessionPromise; } catch { /* ignore */ }
    } finally {
      (SessionManager as any).create = originalCreate;
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
      getTaskManager: () => null,
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

      await waitFor(() => inputCreated);
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
    let rlCreated = false;
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-model-change",
      getAgent: () => ({ sessionId: "test-session-model-change" }),
      getBus: () => mockBus,
      getTaskManager: () => null,
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
        createReadline: () => { rlCreated = true; return mockRl; },
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });

      // Wait until readline exists, so the MODEL_CHANGE hook is registered.
      await waitFor(() => rlCreated);

      // Trigger model change
      core.hooks.notifyHooks(HOOKS.MODEL_CHANGE, { newModel: "new-model" });
      await waitFor(() => lastPrompt === "(new-model)> ");

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

    // The initial prompt fires during setup, so count calls: TURN_END must
    // produce a second prompt.
    let promptCount = 0;
    const mockBus = {
      run: async () => new Promise<void>((resolve) => { (mockBus as any)._resolve = resolve; }),
      runUntilCancelled: async () => {},
      cancel: () => {},
    };

    (SessionManager as any).create = async () => ({
      sessionId: () => "test-session-turn-end",
      getAgent: () => ({ sessionId: "test-session-turn-end" }),
      getBus: () => mockBus,
      getTaskManager: () => null,
      enqueue: () => {},
      executeCommand: async () => 0,
      onSessionEvents: () => () => {},
    });

    const mockRl = {
      on: () => mockRl,
      prompt: function () { promptCount++; return mockRl; },
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

      // Wait for the initial prompt from setup, then turn end.
      await waitFor(() => promptCount >= 1);
      core.hooks.notifyHooks(HOOKS.TURN_END, { stopped: true });
      await waitFor(() => promptCount >= 2);

      expect(promptCount).toBeGreaterThanOrEqual(2);

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
      getTaskManager: () => null,
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

      await waitFor(() => customRlUsed);
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
      getTaskManager: () => null,
      enqueue: () => {},
      executeCommand: async () => 0,
      onSessionEvents: () => () => {},
    });

    let rlOptions: any = null;
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
        createReadline: (opts: any) => { rlOptions = opts; return mockRl; },
        onClose: () => {},
        onSIGINT: () => {},
        setupInput: () => {},
      });

      await waitFor(() => rlOptions !== null);

      // Shell mode wires a shell completer into readline and registers a
      // shell completion handler on the completion service.
      expect(typeof rlOptions.completer).toBe("function");
      expect(core.completion.handlerCount()).toBeGreaterThan(0);

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
        getTaskManager: () => null,
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

      await waitFor(() => capturedBuildAgent !== null);
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
