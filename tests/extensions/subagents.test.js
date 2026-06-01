import { describe, it, expect } from "bun:test";
import {
  create as createSubagentsExtension,
  SUBAGENT_TOOL_NAMES,
  SUBAGENT_TOOL_CONSTRUCTORS,
  DelegateTaskTool,
  TaskStatusTool,
  TaskFollowupTool,
  TaskInterruptTool,
  PlanStatusTool,
  CompleteTaskTool,
  WaitTool,
} from "../../extensions/subagents/index.js";
import { HOOKS } from "../../src/hooks.js";

describe("SUBAGENT_TOOL_NAMES", () => {
  it("contains all expected subagent tools", () => {
    const expected = [
      "delegate_task",
      "task_status",
      "task_followup",
      "task_interrupt",
      "plan_status",
      "complete_task",
      "wait",
    ];
    expect(SUBAGENT_TOOL_NAMES).toEqual(expected);
  });
});

describe("SUBAGENT_TOOL_CONSTRUCTORS", () => {
  it("has constructors for all subagent tools", () => {
    for (const toolName of SUBAGENT_TOOL_NAMES) {
      expect(SUBAGENT_TOOL_CONSTRUCTORS[toolName]).toBeDefined();
      expect(typeof SUBAGENT_TOOL_CONSTRUCTORS[toolName]).toBe("function");
    }
  });
});

describe("createSubagentsExtension", () => {
  it("returns null when taskManager is not provided", () => {
    const ext = createSubagentsExtension({});
    expect(ext).toBeNull();
  });

  it("returns null when manager flag is not set on profile", () => {
    const mockManager = { id: "test-manager" };
    const mockCore = { config: { profile: { manager: false } } };
    const ext = createSubagentsExtension(mockCore, { taskManager: mockManager });
    expect(ext).toBeNull();
  });

  it("returns extension when taskManager provided and profile is a manager", () => {
    const mockManager = { id: "test-manager" };
    const mockCore = { config: { profile: { manager: true } } };
    const ext = createSubagentsExtension(mockCore, { taskManager: mockManager });
    expect(ext).not.toBeNull();
    expect(ext.hooks).toBeDefined();
    expect(ext.SUBAGENT_TOOL_NAMES).toEqual(SUBAGENT_TOOL_NAMES);
  });

  it("returns null when core.config.profile is missing", () => {
    const mockManager = { id: "test-manager" };
    const mockCore = { config: {} };
    const ext = createSubagentsExtension(mockCore, { taskManager: mockManager });
    expect(ext).toBeNull();
  });

  it("registers hooks for tool context and tools registration", () => {
    const mockManager = { id: "test-manager" };
    const mockCore = { config: { profile: { manager: true } } };
    const ext = createSubagentsExtension(mockCore, { taskManager: mockManager });
    expect(ext.hooks[HOOKS.AGENT_TOOL_CONTEXT]).toBeDefined();
    expect(ext.hooks[HOOKS.TOOLS_REGISTER]).toBeDefined();
  });
});

describe("SubagentTool classes", () => {
  it("exports all subagent tool classes", () => {
    expect(DelegateTaskTool).toBeDefined();
    expect(TaskStatusTool).toBeDefined();
    expect(TaskFollowupTool).toBeDefined();
    expect(TaskInterruptTool).toBeDefined();
    expect(PlanStatusTool).toBeDefined();
    expect(CompleteTaskTool).toBeDefined();
    expect(WaitTool).toBeDefined();
  });

  it("creates DelegateTaskTool with options", () => {
    const mockManager = { id: "test-manager" };
    const tool = new DelegateTaskTool({ taskManager: mockManager });
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe("function");
    expect(typeof tool.toToolDef).toBe("function");
  });

  it("creates TaskStatusTool with options", () => {
    const mockManager = { id: "test-manager" };
    const tool = new TaskStatusTool({ taskManager: mockManager });
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates TaskFollowupTool with options", () => {
    const mockManager = { id: "test-manager" };
    const tool = new TaskFollowupTool({ taskManager: mockManager });
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates TaskInterruptTool with options", () => {
    const mockManager = { id: "test-manager" };
    const tool = new TaskInterruptTool({ taskManager: mockManager });
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates PlanStatusTool with options", () => {
    const mockManager = { id: "test-manager" };
    const tool = new PlanStatusTool({ taskManager: mockManager });
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates CompleteTaskTool with options", () => {
    const mockManager = { id: "test-manager" };
    const tool = new CompleteTaskTool({ taskManager: mockManager });
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });

  it("creates WaitTool with options", () => {
    const mockManager = { id: "test-manager" };
    const tool = new WaitTool({ taskManager: mockManager });
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe("function");
  });
});

describe("SubagentTool base class", () => {
  it("handles null options", () => {
    const mockManager = { id: "test-manager" };
    const tool = new DelegateTaskTool(null);
    expect(tool).toBeDefined();
  });

  it("handles undefined options", () => {
    const mockManager = { id: "test-manager" };
    const tool = new DelegateTaskTool(undefined);
    expect(tool).toBeDefined();
  });

  it("handles empty options object", () => {
    const mockManager = { id: "test-manager" };
    const tool = new DelegateTaskTool({});
    expect(tool).toBeDefined();
  });

  it("handles options with sessionCore and taskManager", () => {
    const mockManager = { id: "test-manager" };
    const mockSessionCore = { id: "test-session" };
    const tool = new DelegateTaskTool({
      sessionCore: mockSessionCore,
      taskManager: mockManager,
    });
    expect(tool).toBeDefined();
  });
});

describe("Tool execution - error cases", () => {
  it("DelegateTaskTool returns error for missing task_id", async () => {
    const mockManager = { id: "test-manager" };
    const tool = new DelegateTaskTool({ taskManager: mockManager });
    const result = await tool.execute("not json");
    expect(result.error).toContain("task_id and description are required");
  });

  it("TaskStatusTool returns error for missing task_id", async () => {
    const mockManager = { id: "test-manager" };
    const tool = new TaskStatusTool({ taskManager: mockManager });
    const result = await tool.execute("not json");
    expect(result.error).toContain("task_id is required");
  });

  it("TaskFollowupTool returns error for missing task_id", async () => {
    const mockManager = { id: "test-manager" };
    const tool = new TaskFollowupTool({ taskManager: mockManager });
    const result = await tool.execute("not json");
    expect(result.error).toContain("task_id and message are required");
  });

  it("TaskInterruptTool returns error for missing task_id", async () => {
    const mockManager = { id: "test-manager" };
    const tool = new TaskInterruptTool({ taskManager: mockManager });
    const result = await tool.execute("not json");
    expect(result.error).toContain("task_id is required");
  });

  it("CompleteTaskTool returns error for missing task_id", async () => {
    const mockManager = { id: "test-manager" };
    const tool = new CompleteTaskTool({ taskManager: mockManager });
    const result = await tool.execute("not json");
    expect(result.error).toContain("task_id is required");
  });
});
