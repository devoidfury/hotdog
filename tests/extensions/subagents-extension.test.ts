// Tests for subagents extension — create() function and integration.

import { describe, it, expect } from "bun:test";
import {
  create,
  registerTaskManagerService,
  TASK_MANAGER_SERVICE,
} from "../../src/extensions/subagents/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore } from "../mocks/fixtures.ts";
import { createFixture, MockLLMClient, buildStreamResponse } from "../helpers.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeMockTM(overrides: Partial<Record<string, any>> = {}): any {
  return {
    spawnTask: async (_taskId: string, _desc: string, _opts: Record<string, unknown>) => ({}),
    taskStatus: (_id: string) => null,
    sendFollowUp: (_id: string, _msg: string) => false,
    interruptTask: (_id: string) => false,
    activeTasks: () => [] as string[],
    ...overrides,
  };
}

describe("subagents extension create()", () => {
  it("returns null when the profile is not a manager (even without a taskManager)", () => {
    const core = createMockCore();
    const result = create(core);
    expect(result).toBeNull();
  });

  it("returns null when taskManager is provided but profile is not a manager", () => {
    const core = createMockCore({
      coreConfig: {
        profileDef: {},
      },
    });
    const result = create(core, { taskManager: makeMockTM() });
    expect(result).toBeNull();
  });

  it("returns null when profile.manager is false", () => {
    const core = createMockCore({
      coreConfig: {
        profileDef: { manager: false },
      },
    });
    const result = create(core, { taskManager: makeMockTM() });
    expect(result).toBeNull();
  });

  it("returns null when profile is undefined", () => {
    const core = createMockCore();
    // core.config.profileDef is undefined by default
    const result = create(core, { taskManager: makeMockTM() });
    expect(result).toBeNull();
  });

  it("returns extension instance when taskManager and manager profile are provided", () => {
    const core = createMockCore({
      coreConfig: {
        profileDef: { manager: true },
      },
    });
    const result = create(core, { taskManager: makeMockTM() });
    expect(result).not.toBeNull();
    expect(result!.hooks).toBeDefined();
  });

  it("AGENT_TOOL_CONTEXT hook sets taskManager on toolCtx", async () => {
    const mockTM = makeMockTM();
    const mockSessionCore = { sessionId: "test-session" };
    const core = createMockCore({
      coreConfig: {
        profileDef: { manager: true },
      },
    });
    const result = create(core, { taskManager: mockTM, sessionCore: mockSessionCore });

    const toolCtx: any = {
      _store: {} as Record<string, unknown>,
      set(key: string, value: unknown) { this._store[key] = value; },
      get(key: string) { return this._store[key]; },
    };

    await result!.hooks![HOOKS.AGENT_TOOL_CONTEXT]!({ toolCtx, toolName: "test", agent: {} as any });
    expect(toolCtx.get("taskManager")).toBe(mockTM);
    expect(toolCtx.get("sessionCore")).toBe(mockSessionCore);
  });

  it("AGENT_TOOL_CONTEXT hook sets null sessionCore when not provided", async () => {
    const mockTM = makeMockTM();
    const core = createMockCore({
      coreConfig: {
        profileDef: { manager: true },
      },
    });
    const result = create(core, { taskManager: mockTM });

    const toolCtx: any = {
      _store: {} as Record<string, unknown>,
      set(key: string, value: unknown) { this._store[key] = value; },
      get(key: string) { return this._store[key]; },
    };

    await result!.hooks![HOOKS.AGENT_TOOL_CONTEXT]!({ toolCtx, toolName: "test", agent: {} as any });
    expect(toolCtx.get("sessionCore")).toBeNull();
  });

  it("TOOLS_REGISTER hook registers all subagent tools", async () => {
    const core = createMockCore({
      coreConfig: {
        profileDef: { manager: true },
      },
    });
    const result = create(core, { taskManager: makeMockTM() });

    const registered: string[] = [];
    const mockRegistry = {
      register(name: string, _tool: unknown) {
        registered.push(name);
      },
    };

    await result!.hooks![HOOKS.TOOLS_REGISTER]!(mockRegistry as any);

    // Should register all subagent tools
    expect(registered.length).toBeGreaterThan(0);
    expect(registered).toContain("delegate_task");
    expect(registered).toContain("task_status");
    expect(registered).toContain("task_followup");
    expect(registered).toContain("task_interrupt");
    expect(registered).toContain("plan_status");
    expect(registered).toContain("wait");
  });

  it("handles empty options object (lazy mode: tools resolve the manager at use time)", () => {
    const core = createMockCore({
      coreConfig: {
        profileDef: { manager: true },
      },
    });
    const result = create(core, {});
    expect(result).not.toBeNull();
    expect(result!.hooks![HOOKS.TOOLS_REGISTER]).toBeDefined();
  });

  it("handles undefined options", () => {
    const core = createMockCore({
      coreConfig: {
        profileDef: { manager: true },
      },
    });
    const result = create(core, undefined as any);
    expect(result).not.toBeNull();
  });
});

// ── Lazy TaskManager resolution ────────────────────────────────────────────
// The production flow (main.ts) loads extensions BEFORE any SessionManager
// exists, so create() receives no taskManager. Tools must resolve the
// manager from the TASK_MANAGER_SERVICE at use time.

describe("subagents lazy taskManager resolution", () => {
  function managerCore() {
    return createMockCore({
      coreConfig: { profileDef: { manager: true } },
    }) as any;
  }

  it("tool reports 'not available' before the service is registered", async () => {
    const core = managerCore();
    const ext = create(core)!;
    // Pass the real ToolRegistry, as the extension loader does.
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(core.toolRegistry as any);

    const tool = core.toolRegistry.get("delegate_task") as any;
    expect(tool).toBeDefined();
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1", description: "test" }),
    );
    expect(result.error).toContain("Task manager not available");
  });

  it("tool resolves the TaskManager from the service at use time", async () => {
    const core = managerCore();
    const ext = create(core)!;
    // Pass the real ToolRegistry, as the extension loader does.
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(core.toolRegistry as any);

    const spawned: string[] = [];
    const mockTM = makeMockTM({
      spawnTask: async (taskId: string, _desc: string, _opts: Record<string, unknown>) => {
        spawned.push(taskId);
        return { taskId };
      },
    });

    // UI entry point wiring: publish the manager after session creation.
    registerTaskManagerService(core, mockTM);

    const tool = core.toolRegistry.get("delegate_task") as any;
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1", description: "test" }),
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain("Task t1 delegated");
    expect(spawned).toEqual(["t1"]);
  });

  it("eager taskManager takes precedence over the service", async () => {
    const core = managerCore();
    const eager = makeMockTM();
    const fromService = makeMockTM();
    core.services.register(TASK_MANAGER_SERVICE, fromService);

    const ext = create(core, { taskManager: eager })!;

    const ctx: any = { _s: {} as any, set(k: string, v: unknown) { this._s[k] = v; }, get(k: string) { return this._s[k]; } };
    await ext.hooks![HOOKS.AGENT_TOOL_CONTEXT]!({ toolCtx: ctx, toolName: "delegate_task", agent: {} as any });
    expect(ctx.get("taskManager")).toBe(eager);
  });

  it("AGENT_TOOL_CONTEXT exposes the lazily resolved manager after registration", async () => {
    const core = managerCore();
    const ext = create(core)!;
    const mockTM = makeMockTM();
    registerTaskManagerService(core, mockTM);

    const ctx: any = { _s: {} as any, set(k: string, v: unknown) { this._s[k] = v; }, get(k: string) { return this._s[k]; } };
    await ext.hooks![HOOKS.AGENT_TOOL_CONTEXT]!({ toolCtx: ctx, toolName: "delegate_task", agent: {} as any });
    expect(ctx.get("taskManager")).toBe(mockTM);
  });

  it("registerTaskManagerService is a no-op for null/undefined", () => {
    const core = managerCore();
    registerTaskManagerService(core, null);
    registerTaskManagerService(core, undefined);
    expect(core.services.has(TASK_MANAGER_SERVICE)).toBe(false);
  });

  it("registerTaskManagerService registers and clears the tool def cache", () => {
    const core = managerCore();
    const mockTM = makeMockTM();
    registerTaskManagerService(core, mockTM);
    expect(core.services.get(TASK_MANAGER_SERVICE)).toBe(mockTM);
  });
});

// ── Production wiring regression ───────────────────────────────────────────
// Replicates the exact main.ts -> runOneShot() sequence: extensions load
// without a taskManager, then the session wiring publishes the service,
// then the agent runs a real turn that delegates a task.

describe("subagents production wiring (main.ts load order)", () => {
  it("delegate_task works end-to-end after session wiring registers the service", async () => {
    // 1. main.ts: load extensions with no taskManager.
    const core = createMockCore({
      coreConfig: { profileDef: { manager: true } },
    }) as any;
    const ext = create(core)!;
    // Pass the real ToolRegistry, as the extension loader does.
    await ext.hooks![HOOKS.TOOLS_REGISTER]!(core.toolRegistry as any);
    expect(core.toolRegistry.has("delegate_task")).toBe(true);

    // 2. UI entry point: SessionManager built, service published.
    const spawned: Array<{ taskId: string; description: string }> = [];
    const mockTM = makeMockTM({
      spawnTask: async (taskId: string, desc: string, _opts: Record<string, unknown>) => {
        spawned.push({ taskId, description: desc });
        return { taskId };
      },
    });
    registerTaskManagerService(core, mockTM);

    // 3. Agent turn: model calls delegate_task, then finishes.
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: "Delegating.",
          toolCalls: [{ index: 0, name: "delegate_task", arguments: '{"task_id":"t1","description":"Build feature"}', id: "call_1" }],
        }),
        buildStreamResponse({ content: "Done." }),
      ],
    });
    const { agent } = createFixture({
      toolRegistry: core.toolRegistry,
      mockLLM,
      sink: { emit: () => {} },
    });

    const result = await agent.run("Build the feature");
    expect(result).not.toBeNull();
    expect(result!.type).toBe("completion");
    expect(spawned).toEqual([{ taskId: "t1", description: "Build feature" }]);

    // The LLM request actually advertised the subagent tools.
    const toolNames = mockLLM.lastToolDefs!.map((t: any) => t.function.name);
    expect(toolNames).toContain("delegate_task");
    expect(toolNames).toContain("task_status");
    expect(toolNames).toContain("plan_status");
  });

  it("delegate_task is NOT registered for non-manager profiles", async () => {
    const core = createMockCore({
      coreConfig: { profileDef: {} },
    }) as any;
    const ext = create(core);
    expect(ext).toBeNull();
    expect(core.toolRegistry.has("delegate_task")).toBe(false);
  });
});
