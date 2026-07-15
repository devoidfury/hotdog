// Tests for interactive CLI session internals — hooks, wiring, and exports.
// Other areas covered elsewhere:
//   - Extension creation: interactive-cli.test.ts
//   - parseCommand: commands.test.ts
//   - AsyncInteractiveCliInput: interactive-cli-input.test.ts
//   - handleSlashCommand: interactive-cli-extended.test.ts
//   - AgentSink: core/agent-sink.test.ts
//   - CliOutputSink: core/cli-output-sink.test.ts
//   - format helpers: core/cli-output.test.ts

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HookSystem, HOOKS } from "../../src/core/hooks.ts";
import { MessageBus } from "../../src/core/session/message-bus.ts";
import { TaskManager } from "../../src/core/session/task-manager.ts";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import { MarkerMangler } from "../../src/core/marker-mangler.ts";
import { CliOutputSink } from "../../src/utils/cli/cli.ts";
import { ColorPalette } from "../../src/utils/cli/colors.ts";

// ── Model Change Hook ────────────────────────────────────────────────────────

describe("Interactive CLI - model change hook", () => {
  it("model change hook updates readline prompt", () => {
    const hooks = new HookSystem();
    let lastPrompt: string | null = null;

    const mockRl = {
      setPrompt: (prompt: string) => {
        lastPrompt = prompt;
      },
    };

    hooks.on(HOOKS.MODEL_CHANGE, (data: unknown) => {
      mockRl.setPrompt(`(${(data as { newModel: string }).newModel})> `);
    });

    hooks.notifyHooks(HOOKS.MODEL_CHANGE, {
      agent: {},
      oldModel: "old-model",
      newModel: "new-model",
    });

    expect(lastPrompt!).toBe("(new-model)> ");
  });

  it("model change hook handles multiple changes", () => {
    const hooks = new HookSystem();
    const prompts: string[] = [];

    const mockRl = {
      setPrompt: (prompt: string) => {
        prompts.push(prompt);
      },
    };

    hooks.on(HOOKS.MODEL_CHANGE, (data: unknown) => {
      mockRl.setPrompt(`(${(data as { newModel: string }).newModel})> `);
    });

    hooks.notifyHooks(HOOKS.MODEL_CHANGE, { agent: {}, oldModel: "model-1", newModel: "model-2" });
    hooks.notifyHooks(HOOKS.MODEL_CHANGE, { agent: {}, oldModel: "model-2", newModel: "model-3" });

    expect(prompts).toEqual(["(model-2)> ", "(model-3)> "]);
  });
});

// ── Turn End Hook ────────────────────────────────────────────────────────────

describe("Interactive CLI - turn end hook", () => {
  it("turn end hook re-prompts when stopped", async () => {
    const hooks = new HookSystem();
    let promptCalled = false;

    const mockRl = {
      prompt: () => { promptCalled = true; },
    };

    hooks.on(HOOKS.TURN_END, (data: unknown) => {
      if ((data as { stopped: boolean }).stopped) {
        setImmediate(() => mockRl.prompt());
      }
    });

    hooks.notifyHooks(HOOKS.TURN_END, {
      turnIndex: 1, message: "Hello", toolResults: [], stopped: true, agent: {},
    });

    expect(promptCalled).toBe(false);
    await new Promise((resolve) => setImmediate(resolve));
    expect(promptCalled).toBe(true);
  });

  it("turn end hook does not re-prompt when not stopped", async () => {
    const hooks = new HookSystem();
    let promptCalled = false;

    const mockRl = {
      prompt: () => { promptCalled = true; },
    };

    hooks.on(HOOKS.TURN_END, (data: unknown) => {
      if ((data as { stopped: boolean }).stopped) {
        setImmediate(() => mockRl.prompt());
      }
    });

    hooks.notifyHooks(HOOKS.TURN_END, {
      turnIndex: 1, message: "", toolResults: [{ toolName: "read" }], stopped: false, agent: {},
    });

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(promptCalled).toBe(false);
  });
});

// ── Component Wiring ─────────────────────────────────────────────────────────

describe("Interactive CLI - message bus creation", () => {
  it("message bus is created with sessionManager and sink", () => {
    const mockSessionManager = {
      getAgent: () => undefined,
    };
    const mockSink = { emit: () => {} };

    const bus = new MessageBus({ sessionManager: mockSessionManager, sink: mockSink });

    expect(bus).toBeDefined();
    expect(bus.sessionManager).toBe(mockSessionManager);
  });

  it("taskManager setBus is called", () => {
    const taskManager = new TaskManager({
      buildAgent: async () => ({} as any),
      llmClient: {} as any,
      modelRegistry: {} as any,
      config: {} as any,
      hooks: new HookSystem(),
      maxIterations: 100,
      taskProfile: "default",
      taskRole: "",
    });

    const mockBus = { enqueue: () => {} };
    taskManager.setBus(mockBus);
    expect(taskManager).toBeDefined();
  });
});

describe("Interactive CLI - output sink creation", () => {
  it("CliOutputSink is created with correct options", () => {
    const palette = ColorPalette.default();
    const sink = new CliOutputSink({
      toolFormat: "  → {} {}",
      toolOutputFmt: "----\n{}\n----",
      palette,
      thinkerFormat: "[Thinking: {}]",
      hideTools: false,
      hideThinking: false,
    });

    expect(sink).toBeDefined();
    expect(sink.palette).toBe(palette);
    expect(sink.thinkerFormat).toBe("[Thinking: {}]");
    expect(sink.toolFormat).toBe("  → {} {}");
    expect(sink.toolOutputFmt).toBe("----\n{}\n----");
    expect(sink.hideTools).toBe(false);
    expect(sink.hideThinking).toBe(false);
  });

  it("CliOutputSink resolves palette from theme", async () => {
    const palette = await CliOutputSink.resolve(true, "dark", null);
    expect(palette).toBeDefined();
  });
});

describe("Interactive CLI - LLM client creation", () => {
  it("LlmClient is created with correct options", () => {
    const llmClient = new LlmClient({
      baseUrl: "http://localhost:8080",
      apiKey: "test-key",
      stream: false,
      chatTimeoutSecs: 30,
      maxRetries: 3,
      providers: [],
      markerMangler: new MarkerMangler(),
    });

    expect(llmClient).toBeDefined();
    expect(llmClient.baseUrl).toBe("http://localhost:8080");
    expect(llmClient.apiKey).toBe("test-key");
    expect(llmClient.stream).toBe(false);
    expect(llmClient.chatTimeoutSecs).toBe(30);
  });
});

// ── Module Exports ───────────────────────────────────────────────────────────

describe("Interactive CLI - module exports", () => {
  it("exports all expected functions", async () => {
    const mod = await import("../../src/extensions/ui-interactive-cli/index.ts");
    for (const name of ["runInteractiveSession", "handleSlashCommand", "create", "AsyncInteractiveCliInput"]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
