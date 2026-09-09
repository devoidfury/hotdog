// Tests for ui-one-shot/index.ts — one-shot prompt mode extension.
// Covers create(), hook handlers, handlePromptSubcommand(), and runOneShot().

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HOOKS } from "@core/hooks.ts";
import { HookSystem } from "@core/hooks.ts";
import { CliSubcommandRegistryLike, SubcommandDefinition } from "@core/extensions/registries.ts";
import { LlmClient } from "@core/llm-client/client.ts";

describe("ui-one-shot extension", () => {
  let originalSessionManagerCreate: unknown = null;
  let SessionManagerModule: typeof import("@core/session/index.ts") | null = null;

  beforeEach(async () => {
    SessionManagerModule = await import("@core/session/index.ts");
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
      maxToolCallsPerIteration: 10,
      toolRetryDelay: 1,
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
    } as any;
  }

  describe("create", () => {
    it("returns extension without hooks when core.hooks is undefined", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const core = { ...createMockCore(), hooks: undefined };

      const ext = create(core);
      expect(ext.hooks).toBeUndefined();
    });
  });

  // The `-p` flag must resolve to the "prompt" subcommand from static
  // metadata alone: main() bails before loading extensions when no
  // subcommand will run, so a hook-based mapping would strand `-p` (and did).
  describe("-p subcommand resolution from metadata", () => {
    const origArgv = process.argv;

    async function parseWith(args: string[]) {
      const { registerExtensionMetadata } = await import("@core/extensions/extensions.ts");
      const { ConfigRegistry } = await import("@core/extensions/config.ts");
      const { createSubcommandRegistry } = await import("@core/extensions/registries.ts");
      const { parseArgs } = await import("@core/cli.ts");

      const configRegistry = new ConfigRegistry();
      const subcommandRegistry = createSubcommandRegistry();
      await registerExtensionMetadata(
        { extensionPaths: ["@extensions"] } as any,
        configRegistry,
        subcommandRegistry,
      );
      process.argv = ["bun", "hotdog", ...args];
      try {
        return parseArgs(configRegistry, subcommandRegistry.names());
      } finally {
        process.argv = origArgv;
      }
    }

    it("maps -p to the prompt subcommand without loading extensions", async () => {
      const cli = await parseWith(["-p", "hello world"]);
      expect(cli.subcommand).toBe("prompt");
      expect(cli.prompt).toBe("hello world");
    });

    it("maps --prompt to the prompt subcommand", async () => {
      const cli = await parseWith(["--prompt", "hello world"]);
      expect(cli.subcommand).toBe("prompt");
      expect(cli.prompt).toBe("hello world");
    });

    it("leaves subcommand unset when no prompt flag is given", async () => {
      const cli = await parseWith([]);
      expect(cli.subcommand).toBeNull();
    });
  });

  describe("CLI_SUBCOMMANDS_REGISTER hook", () => {
    it("registers the 'prompt' subcommand", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const core = createMockCore();
      const ext = create(core);

      const registered: Record<string, unknown> = {};
      const registry: CliSubcommandRegistryLike = {
        register: (name: string, def: SubcommandDefinition) => {
          registered[name] = def;
        },
      };

      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!(registry);

      expect(registered).toHaveProperty("prompt");
      expect((registered.prompt as any).description).toContain("One-shot prompt mode");
      expect(typeof (registered.prompt as any).handler).toBe("function");
    });
  });

  describe("handlePromptSubcommand", () => {
    it("throws when resolved config is missing", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const core = createMockCore();
      core.resolved = undefined;
      const ext = create(core);

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      await expect((registry.prompt as any).handler({}, core)).rejects.toThrow();
    });

    it("creates SessionManager and runs one-shot with prompt", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      let createOpts: any = null;
      let enqueuedPrompt = "";
      const mockBus = {
        runUntilCancelled: async () => {},
      };

      (SessionManager as any).create = async (opts: any) => {
        createOpts = opts;
        return {
          sessionId: () => "oneshot-test-session",
          getAgent: () => ({ sessionId: "oneshot-test-session" }),
          getBus: () => mockBus,
          getTaskManager: () => null,
          enqueue: (_sessionId: string, prompt: string) => { enqueuedPrompt = prompt; },
          executeCommand: async () => 0,
          onSessionEvents: () => () => {},
        };
      };

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      let cleanupCalled = false;
      core.extensions.cleanup = async () => { cleanupCalled = true; };

      const exitCode = await (registry.prompt as any).handler({ prompt: "test prompt" }, core);

      expect(exitCode).toBe(0);
      expect(createOpts).not.toBeNull();
      expect(createOpts!.initialConfig).toBeDefined();
      expect(createOpts!.taskConfig).toBeDefined();
      expect(createOpts!.taskConfig.maxIterations).toBe(100);
      expect(createOpts!.taskConfig.taskProfile).toBe("task-default");
      expect(enqueuedPrompt).toBe("test prompt");
      expect(cleanupCalled).toBe(true);
    });

    it("handles null bus gracefully", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      (SessionManager as any).create = async () => ({
        sessionId: () => "null-bus-session",
        getAgent: () => ({ sessionId: "null-bus-session" }),
        getBus: () => null,
        getTaskManager: () => null,
        enqueue: () => {},
        executeCommand: async () => 0,
        onSessionEvents: () => () => {},
      });

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      const exitCode = await (registry.prompt as any).handler({ prompt: "test" }, core);

      expect(exitCode).toBe(0);
    });

    it("propagates SessionManager.create failures", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      (SessionManager as any).create = async () => {
        throw new Error("SessionManager creation failed");
      };

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      await expect(
        (registry.prompt as any).handler({ prompt: "test" }, core),
      ).rejects.toThrow("SessionManager creation failed");
    });

    it("enqueues an empty prompt when neither prompt nor args are given", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      let enqueuedPrompt = "";
      (SessionManager as any).create = async () => ({
        sessionId: () => "empty-prompt-session",
        getAgent: () => ({ sessionId: "empty-prompt-session" }),
        getBus: () => ({ runUntilCancelled: async () => {} }),
        getTaskManager: () => null,
        enqueue: (_sessionId: string, prompt: string) => { enqueuedPrompt = prompt; },
        executeCommand: async () => 0,
        onSessionEvents: () => () => {},
      });

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      await (registry.prompt as any).handler({ prompt: undefined, args: undefined }, core);

      expect(enqueuedPrompt).toBe("");
    });

    it("uses args joined as prompt when prompt is not provided", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      let enqueuedPrompt = "";
      const mockBus = {
        runUntilCancelled: async () => {},
      };

      (SessionManager as any).create = async () => ({
        sessionId: () => "oneshot-args-session",
        getAgent: () => ({ sessionId: "oneshot-args-session" }),
        getBus: () => mockBus,
        getTaskManager: () => null,
        enqueue: (_sessionId: string, prompt: string) => { enqueuedPrompt = prompt; },
        executeCommand: async () => 0,
        onSessionEvents: () => () => {},
      });

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      const exitCode = await (registry.prompt as any).handler({ args: ["hello", "world"] }, core);

      expect(exitCode).toBe(0);
      expect(enqueuedPrompt).toBe("hello world");
    });

    it("uses custom sessionId from cli", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      let createOpts: any = null;
      const mockBus = {
        runUntilCancelled: async () => {},
      };

      (SessionManager as any).create = async (opts: any) => {
        createOpts = opts;
        return {
          sessionId: () => "custom-session-id",
          getAgent: () => ({ sessionId: "custom-session-id" }),
          getBus: () => mockBus,
          getTaskManager: () => null,
          enqueue: () => {},
          executeCommand: async () => 0,
          onSessionEvents: () => () => {},
        };
      };

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      await (registry.prompt as any).handler({ prompt: "test", sessionId: "custom-session-id" }, core);

      expect(createOpts!.initialConfig.sessionId).toBe("custom-session-id");
    });

    it("returns non-zero exit code when bus.runUntilCancelled throws", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      const mockBus = {
        runUntilCancelled: async () => { throw new Error("bus error"); },
      };

      (SessionManager as any).create = async () => ({
        sessionId: () => "error-session",
        getAgent: () => ({ sessionId: "error-session" }),
        getBus: () => mockBus,
        getTaskManager: () => null,
        enqueue: () => {},
        executeCommand: async () => 0,
        onSessionEvents: () => () => {},
      });

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      const exitCode = await (registry.prompt as any).handler({ prompt: "test" }, core);

      expect(exitCode).toBe(1);
    });

    it("preserves custom exit code from error", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      const mockBus = {
        runUntilCancelled: async () => {
          const err = new Error("custom exit") as Error & { exitCode: number };
          err.exitCode = 42;
          throw err;
        },
      };

      (SessionManager as any).create = async () => ({
        sessionId: () => "custom-exit-session",
        getAgent: () => ({ sessionId: "custom-exit-session" }),
        getBus: () => mockBus,
        getTaskManager: () => null,
        enqueue: () => {},
        executeCommand: async () => 0,
        onSessionEvents: () => () => {},
      });

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      const exitCode = await (registry.prompt as any).handler({ prompt: "test" }, core);

      expect(exitCode).toBe(42);
    });

    it("calls extensions.cleanup in finally block", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      let cleanupCalled = false;
      core.extensions.cleanup = async () => { cleanupCalled = true; };

      const mockBus = {
        runUntilCancelled: async () => { throw new Error("error before cleanup"); },
      };

      (SessionManager as any).create = async () => ({
        sessionId: () => "cleanup-session",
        getAgent: () => ({ sessionId: "cleanup-session" }),
        getBus: () => mockBus,
        getTaskManager: () => null,
        enqueue: () => {},
        executeCommand: async () => 0,
        onSessionEvents: () => () => {},
      });

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      await (registry.prompt as any).handler({ prompt: "test" }, core);

      expect(cleanupCalled).toBe(true);
    });

    it("executes buildAgent callback with agent configuration", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      let buildAgentFn: any = null;
      const mockBus = {
        runUntilCancelled: async () => {},
      };

      (SessionManager as any).create = async (opts: any) => {
        buildAgentFn = opts.buildAgent;
        return {
          sessionId: () => "build-agent-execute-session",
          getAgent: () => ({ sessionId: "build-agent-execute-session" }),
          getBus: () => mockBus,
          getTaskManager: () => null,
          enqueue: () => {},
          executeCommand: async () => 0,
          onSessionEvents: () => () => {},
        };
      };

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      await (registry.prompt as any).handler({ prompt: "test" }, core);

      // Now invoke buildAgent to cover lines 128-160
      const agent = await buildAgentFn({ sessionId: "explicit-session-id" });

      expect(agent).toBeDefined();
      expect(agent.sessionId).toBe("explicit-session-id");
      expect(agent.model).toBe("test-model");
      expect(agent.maxIterations).toBe(100);
      expect(agent.contextLimit).toBe(128000);
    });

    it("buildAgent generates UUID when sessionId not provided", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      let buildAgentFn: any = null;
      const mockBus = {
        runUntilCancelled: async () => {},
      };

      (SessionManager as any).create = async (opts: any) => {
        buildAgentFn = opts.buildAgent;
        return {
          sessionId: () => "uuid-session",
          getAgent: () => ({ sessionId: "uuid-session" }),
          getBus: () => mockBus,
          getTaskManager: () => null,
          enqueue: () => {},
          executeCommand: async () => 0,
          onSessionEvents: () => () => {},
        };
      };

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      await (registry.prompt as any).handler({ prompt: "test" }, core);

      const agent = await buildAgentFn({});

      expect(agent).toBeDefined();
      // Should be a valid UUID format
      expect(agent.sessionId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    });

    it("buildAgent uses agentConfig overrides for model and maxIterations", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      let buildAgentFn: any = null;
      const mockBus = {
        runUntilCancelled: async () => {},
      };

      (SessionManager as any).create = async (opts: any) => {
        buildAgentFn = opts.buildAgent;
        return {
          sessionId: () => "override-session",
          getAgent: () => ({ sessionId: "override-session" }),
          getBus: () => mockBus,
          getTaskManager: () => null,
          enqueue: () => {},
          executeCommand: async () => 0,
          onSessionEvents: () => () => {},
        };
      };

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      await (registry.prompt as any).handler({ prompt: "test" }, core);

      const agent = await buildAgentFn({
        model: "override-model",
        maxIterations: 50,
      });

      expect(agent.model).toBe("override-model");
      expect(agent.maxIterations).toBe(50);
    });

    it("buildAgent fires COMMANDS_REGISTER hook", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      let commandsRegisterCalled = false;
      let hookData: any = null;
      core.hooks.on(HOOKS.COMMANDS_REGISTER, (data: any) => {
        commandsRegisterCalled = true;
        hookData = data;
      });

      let buildAgentFn: any = null;
      const mockBus = {
        runUntilCancelled: async () => {},
      };

      (SessionManager as any).create = async (opts: any) => {
        buildAgentFn = opts.buildAgent;
        return {
          sessionId: () => "commands-hook-session",
          getAgent: () => ({ sessionId: "commands-hook-session" }),
          getBus: () => mockBus,
          getTaskManager: () => null,
          enqueue: () => {},
          executeCommand: async () => 0,
          onSessionEvents: () => () => {},
        };
      };

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      await (registry.prompt as any).handler({ prompt: "test" }, core);

      const agent = await buildAgentFn({ sessionId: "hook-test-session" });

      expect(commandsRegisterCalled).toBe(true);
      expect(hookData.registry).toBe(agent.commandRegistry);
      expect(hookData.agent).toBe(agent);
    });

    it("uses custom colors and theme from cli", async () => {
      const { create } = await import("@extensions/ui-one-shot/index.ts");
      const { SessionManager } = await import("@core/session/index.ts");
      const core = createMockCore();
      const ext = create(core);

      const mockBus = {
        runUntilCancelled: async () => {},
      };

      (SessionManager as any).create = async () => ({
        sessionId: () => "theme-session",
        getAgent: () => ({ sessionId: "theme-session" }),
        getBus: () => mockBus,
        getTaskManager: () => null,
        enqueue: () => {},
        executeCommand: async () => 0,
        onSessionEvents: () => () => {},
      });

      const registry: Record<string, SubcommandDefinition> = {};
      await ext.hooks![HOOKS.CLI_SUBCOMMANDS_REGISTER]!({ register: (name: string, def: SubcommandDefinition) => { registry[name] = def; } } as CliSubcommandRegistryLike);

      // Should not throw with custom colors/theme
      const exitCode = await (registry.prompt as any).handler(
        { prompt: "test", colors: false, theme: "light" },
        core
      );

      expect(exitCode).toBe(0);
    });
  });
});
