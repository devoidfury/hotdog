// Tests for subagents extension — create() function and integration.

import { describe, it, expect } from "bun:test";
import { create } from "../../src/extensions/subagents/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { createMockCore } from "../mocks/fixtures.ts";

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
  it("returns null when no taskManager is provided", () => {
    const core = createMockCore();
    const result = create(core);
    expect(result).toBeNull();
  });

  it("returns null when taskManager is provided but profile is not a manager", () => {
    const core = createMockCore({
      coreConfig: {
        profile: {},
      },
    });
    const result = create(core, { taskManager: makeMockTM() });
    expect(result).toBeNull();
  });

  it("returns null when profile.manager is false", () => {
    const core = createMockCore({
      coreConfig: {
        profile: { manager: false },
      },
    });
    const result = create(core, { taskManager: makeMockTM() });
    expect(result).toBeNull();
  });

  it("returns null when profile is undefined", () => {
    const core = createMockCore();
    // core.config.profile is undefined by default
    const result = create(core, { taskManager: makeMockTM() });
    expect(result).toBeNull();
  });

  it("returns extension instance when taskManager and manager profile are provided", () => {
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
      },
    });
    const result = create(core, { taskManager: makeMockTM() });
    expect(result).not.toBeNull();
    expect(result!.hooks).toBeDefined();
  });

  it("registers AGENT_TOOL_CONTEXT hook when created", () => {
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
      },
    });
    const result = create(core, { taskManager: makeMockTM() });
    expect(result!.hooks![HOOKS.AGENT_TOOL_CONTEXT]).toBeDefined();
  });

  it("registers TOOLS_REGISTER hook when created", () => {
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
      },
    });
    const result = create(core, { taskManager: makeMockTM() });
    expect(result!.hooks![HOOKS.TOOLS_REGISTER]).toBeDefined();
  });

  it("exposes SUBAGENT_TOOL_NAMES and SUBAGENT_TOOL_CONSTRUCTORS", () => {
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
      },
    });
    const result = create(core, { taskManager: makeMockTM() });
    expect(result!.SUBAGENT_TOOL_NAMES).toBeDefined();
    expect(result!.SUBAGENT_TOOL_CONSTRUCTORS).toBeDefined();
    expect(Array.isArray(result!.SUBAGENT_TOOL_NAMES)).toBe(true);
  });

  it("AGENT_TOOL_CONTEXT hook sets taskManager on toolCtx", async () => {
    const mockTM = makeMockTM();
    const mockSessionCore = { sessionId: "test-session" };
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
      },
    });
    const result = create(core, { taskManager: mockTM, sessionCore: mockSessionCore });

    const toolCtx: any = {
      _store: {} as Record<string, unknown>,
      set(key: string, value: unknown) { this._store[key] = value; },
      get(key: string) { return this._store[key]; },
    };

    await result!.hooks![HOOKS.AGENT_TOOL_CONTEXT]!({ toolCtx });
    expect(toolCtx.get("taskManager")).toBe(mockTM);
    expect(toolCtx.get("sessionCore")).toBe(mockSessionCore);
  });

  it("AGENT_TOOL_CONTEXT hook sets null sessionCore when not provided", async () => {
    const mockTM = makeMockTM();
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
      },
    });
    const result = create(core, { taskManager: mockTM });

    const toolCtx: any = {
      _store: {} as Record<string, unknown>,
      set(key: string, value: unknown) { this._store[key] = value; },
      get(key: string) { return this._store[key]; },
    };

    await result!.hooks![HOOKS.AGENT_TOOL_CONTEXT]!({ toolCtx });
    expect(toolCtx.get("sessionCore")).toBeNull();
  });

  it("TOOLS_REGISTER hook registers all subagent tools", async () => {
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
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
    expect(registered).toContain("complete_task");
    expect(registered).toContain("wait");
  });

  it("TOOLS_REGISTER hook handles tool creation errors gracefully", async () => {
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
      },
    });

    const result = create(core, { taskManager: makeMockTM() });

    const registered: string[] = [];
    const mockRegistry = {
      register(name: string, _tool: unknown) {
        registered.push(name);
      },
    };

    // Should not throw with normal input
    await result!.hooks![HOOKS.TOOLS_REGISTER]!(mockRegistry as any);
    expect(registered.length).toBeGreaterThan(0);
  });

  it("handles empty options object", () => {
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
      },
    });
    const result = create(core, {});
    expect(result).toBeNull(); // No taskManager
  });

  it("handles undefined options", () => {
    const core = createMockCore({
      coreConfig: {
        profile: { manager: true },
      },
    });
    const result = create(core, undefined as any);
    expect(result).toBeNull(); // No taskManager
  });
});
