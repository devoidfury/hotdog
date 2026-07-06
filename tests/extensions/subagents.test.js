// Tests for subagents tools — DelegateTaskTool, TaskStatusTool, etc.

import { describe, it, expect } from "bun:test";
import {
  SubagentTool,
  DelegateTaskTool,
  TaskStatusTool,
  TaskFollowupTool,
  TaskInterruptTool,
  PlanStatusTool,
  CompleteTaskTool,
  WaitTool,
  SUBAGENT_TOOL_NAMES,
  SUBAGENT_TOOL_CONSTRUCTORS,
} from "../../src/extensions/subagents/subagents.js";

describe("SubagentTool base class", () => {
  it("creates with options object", () => {
    const tool = new SubagentTool({ sessionCore: {}, taskManager: {} });
    expect(tool._sessionCore).toBeDefined();
    expect(tool._taskManager).toBeDefined();
  });

  it("creates with null options", () => {
    const tool = new SubagentTool(null);
    expect(tool._sessionCore).toBeNull();
    expect(tool._taskManager).toBeNull();
  });

  it("creates with no backend", () => {
    const tool = new SubagentTool({});
    const result = tool._ensureBackend();
    expect(result).toBe("Error: Task manager not available");
  });

  it("resolves sessionCore backend", () => {
    const mockSessionCore = { spawnTask: async () => ({}) };
    const tool = new SubagentTool({ sessionCore: mockSessionCore });
    const backend = tool._resolveBackend();
    expect(backend.type).toBe("sessionCore");
    expect(backend.value).toBe(mockSessionCore);
  });

  it("resolves taskManager backend", () => {
    const mockTaskManager = { spawnTask: async () => ({}) };
    const tool = new SubagentTool({ taskManager: mockTaskManager });
    const backend = tool._resolveBackend();
    expect(backend.type).toBe("taskManager");
    expect(backend.value).toBe(mockTaskManager);
  });

  it("returns none when no backend available", () => {
    const tool = new SubagentTool({});
    const backend = tool._resolveBackend();
    expect(backend.type).toBe("none");
    expect(backend.value).toBeNull();
  });

  it("sessionCore takes precedence over taskManager", () => {
    const tool = new SubagentTool({ sessionCore: {}, taskManager: {} });
    const backend = tool._resolveBackend();
    expect(backend.type).toBe("sessionCore");
  });

  it("callDisplay returns formatted string", () => {
    const tool = new SubagentTool({});
    const display = tool.callDisplay(JSON.stringify({ task_id: "task-1" }));
    expect(display).toContain("SubagentTool");
    expect(display).toContain("task-1");
  });

  it("callDisplay handles missing task_id", () => {
    const tool = new SubagentTool({});
    const display = tool.callDisplay(JSON.stringify({}));
    expect(display).toContain("?");
  });
});

describe("DelegateTaskTool", () => {
  function createMockBackend() {
    return {
      spawnTask: async (taskId, desc, opts) => ({ taskId }),
    };
  }

  it("has correct tool name", () => {
    expect(DelegateTaskTool.TOOL_NAME).toBe("delegate_task");
  });

  it("returns error when task_id is missing", async () => {
    const tool = new DelegateTaskTool({});
    const result = await tool.execute(JSON.stringify({ description: "test" }));
    expect(result.error).toContain("task_id and description are required");
  });

  it("returns error when description is missing", async () => {
    const tool = new DelegateTaskTool({});
    const result = await tool.execute(JSON.stringify({ task_id: "t1" }));
    expect(result.error).toContain("task_id and description are required");
  });

  it("returns error when no backend available", async () => {
    const tool = new DelegateTaskTool({});
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1", description: "test" }),
    );
    expect(result.error).toContain("Task manager not available");
  });

  it("delegates task successfully", async () => {
    const mockBackend = createMockBackend();
    const tool = new DelegateTaskTool({ taskManager: mockBackend });
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1", description: "Build feature" }),
    );
    expect(result.output).toContain("Task t1 delegated");
    expect(result.metadata.get("task_id")).toBe("t1");
  });

  it("passes worker_model option", async () => {
    let capturedOpts = null;
    const mockBackend = {
      spawnTask: async (taskId, desc, opts) => {
        capturedOpts = opts;
        return { taskId };
      },
    };
    const tool = new DelegateTaskTool({ taskManager: mockBackend });
    await tool.execute(
      JSON.stringify({
        task_id: "t1",
        description: "test",
        worker_model: "custom-model",
      }),
    );
    expect(capturedOpts.workerModel).toBe("custom-model");
  });

  it("passes profile option", async () => {
    let capturedOpts = null;
    const mockBackend = {
      spawnTask: async (taskId, desc, opts) => {
        capturedOpts = opts;
        return { taskId };
      },
    };
    const tool = new DelegateTaskTool({ taskManager: mockBackend });
    await tool.execute(
      JSON.stringify({
        task_id: "t1",
        description: "test",
        profile: "fixer",
      }),
    );
    expect(capturedOpts.profile).toBe("fixer");
  });

  it("toToolDef returns correct definition", () => {
    const tool = new DelegateTaskTool({});
    const def = tool.toToolDef();
    expect(def.function.name).toBe("delegate_task");
    expect(def.function.description).toContain("Spawn a background task agent");
    expect(def.function.parameters.required).toContain("task_id");
    expect(def.function.parameters.required).toContain("description");
  });

  it("callDisplay formats correctly", () => {
    const tool = new DelegateTaskTool({});
    const display = tool.callDisplay(
      JSON.stringify({
        task_id: "t1",
        description: "Build the new feature for v2.0 release",
      }),
    );
    expect(display).toContain("t1");
  });
});

describe("TaskStatusTool", () => {
  function createMockBackend(status = "running") {
    return {
      taskStatus: (id) => status,
    };
  }

  it("has correct tool name", () => {
    expect(TaskStatusTool.TOOL_NAME).toBe("task_status");
  });

  it("returns error when task_id is missing", async () => {
    const tool = new TaskStatusTool({});
    const result = await tool.execute(JSON.stringify({}));
    expect(result.error).toContain("task_id is required");
  });

  it("returns error when no backend available", async () => {
    const tool = new TaskStatusTool({});
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(result.error).toContain("Task manager not available");
  });

  it("returns task status", async () => {
    const mockBackend = createMockBackend("running");
    const tool = new TaskStatusTool({ taskManager: mockBackend });
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(result.output).toContain("Task t1: running");
    expect(result.metadata.get("task_id")).toBe("t1");
    expect(result.metadata.get("status")).toBe("running");
  });

  it("returns error when task not found", async () => {
    const mockBackend = createMockBackend(null);
    const tool = new TaskStatusTool({ taskManager: mockBackend });
    const result = await tool.execute(
      JSON.stringify({ task_id: "nonexistent" }),
    );
    expect(result.error).toContain("not found");
  });

  it("toToolDef returns correct definition", () => {
    const tool = new TaskStatusTool({});
    const def = tool.toToolDef();
    expect(def.function.name).toBe("task_status");
    expect(def.function.description).toContain("DO NOT USE for polling");
  });

  it("callDisplay formats correctly", () => {
    const tool = new TaskStatusTool({});
    const display = tool.callDisplay(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(display).toBe("task_status(t1)");
  });
});

describe("TaskFollowupTool", () => {
  function createMockBackend(followUpOk = true) {
    return {
      sendFollowUp: (id, msg) => followUpOk,
    };
  }

  it("has correct tool name", () => {
    expect(TaskFollowupTool.TOOL_NAME).toBe("task_followup");
  });

  it("returns error when task_id is missing", async () => {
    const tool = new TaskFollowupTool({});
    const result = await tool.execute(
      JSON.stringify({ message: "hello" }),
    );
    expect(result.error).toContain("task_id and message are required");
  });

  it("returns error when message is missing", async () => {
    const tool = new TaskFollowupTool({});
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(result.error).toContain("task_id and message are required");
  });

  it("returns error when no backend available", async () => {
    const tool = new TaskFollowupTool({});
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1", message: "hello" }),
    );
    expect(result.error).toContain("Task manager not available");
  });

  it("sends follow-up successfully", async () => {
    const mockBackend = createMockBackend(true);
    const tool = new TaskFollowupTool({ taskManager: mockBackend });
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1", message: "Please hurry" }),
    );
    expect(result.output).toContain("Follow-up sent to task t1");
  });

  it("returns error when follow-up fails", async () => {
    const mockBackend = createMockBackend(false);
    const tool = new TaskFollowupTool({ taskManager: mockBackend });
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1", message: "hello" }),
    );
    expect(result.error).toContain("Failed to send follow-up");
  });

  it("toToolDef returns correct definition", () => {
    const tool = new TaskFollowupTool({});
    const def = tool.toToolDef();
    expect(def.function.name).toBe("task_followup");
    expect(def.function.parameters.required).toContain("task_id");
    expect(def.function.parameters.required).toContain("message");
  });

  it("callDisplay truncates long messages", () => {
    const tool = new TaskFollowupTool({});
    const display = tool.callDisplay(
      JSON.stringify({
        task_id: "t1",
        message: "This is a very long message that should be truncated in the display output",
      }),
    );
    expect(display).toContain("t1");
  });
});

describe("TaskInterruptTool", () => {
  function createMockBackend(interruptOk = true) {
    return {
      interruptTask: (id) => interruptOk,
    };
  }

  it("has correct tool name", () => {
    expect(TaskInterruptTool.TOOL_NAME).toBe("task_interrupt");
  });

  it("returns error when task_id is missing", async () => {
    const tool = new TaskInterruptTool({});
    const result = await tool.execute(JSON.stringify({}));
    expect(result.error).toContain("task_id is required");
  });

  it("returns error when no backend available", async () => {
    const tool = new TaskInterruptTool({});
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(result.error).toContain("Task manager not available");
  });

  it("interrupts task successfully", async () => {
    const mockBackend = createMockBackend(true);
    const tool = new TaskInterruptTool({ taskManager: mockBackend });
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(result.output).toContain("Task t1 interrupted");
  });

  it("returns error when interrupt fails", async () => {
    const mockBackend = createMockBackend(false);
    const tool = new TaskInterruptTool({ taskManager: mockBackend });
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(result.error).toContain("Failed to interrupt");
  });

  it("toToolDef returns correct definition", () => {
    const tool = new TaskInterruptTool({});
    const def = tool.toToolDef();
    expect(def.function.name).toBe("task_interrupt");
  });

  it("callDisplay formats correctly", () => {
    const tool = new TaskInterruptTool({});
    const display = tool.callDisplay(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(display).toBe("task_interrupt(t1)");
  });
});

describe("PlanStatusTool", () => {
  function createMockBackend(activeTaskIds = [], statuses = {}) {
    return {
      activeTasks: () => activeTaskIds,
      taskStatus: (id) => (id in statuses ? statuses[id] : null),
    };
  }

  it("has correct tool name", () => {
    expect(PlanStatusTool.TOOL_NAME).toBe("plan_status");
  });

  it("returns error when no backend available", async () => {
    const tool = new PlanStatusTool({});
    const result = await tool.execute(JSON.stringify({}));
    expect(result.error).toContain("Task manager not available");
  });

  it("returns specific task status when task_id provided", async () => {
    const mockBackend = createMockBackend(["t1"], { t1: "running" });
    const tool = new PlanStatusTool({ taskManager: mockBackend });
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(result.output).toContain("Task t1: running");
  });

  it("returns error for unknown task_id", async () => {
    const mockBackend = createMockBackend([], {});
    const tool = new PlanStatusTool({ taskManager: mockBackend });
    const result = await tool.execute(
      JSON.stringify({ task_id: "nonexistent" }),
    );
    expect(result.error).toContain("not found");
  });

  it("returns all active tasks when no task_id provided", async () => {
    const mockBackend = createMockBackend(
      ["t1", "t2"],
      { t1: "running", t2: "running" },
    );
    const tool = new PlanStatusTool({ taskManager: mockBackend });
    const result = await tool.execute(JSON.stringify({}));
    expect(result.output).toContain("Active tasks:");
    expect(result.output).toContain("t1");
    expect(result.output).toContain("t2");
  });

  it("returns no active tasks message", async () => {
    const mockBackend = createMockBackend([], {});
    const tool = new PlanStatusTool({ taskManager: mockBackend });
    const result = await tool.execute(JSON.stringify({}));
    expect(result.output).toContain("No active tasks");
    expect(result.metadata.get("active_task_count")).toBe("0");
  });

  it("toToolDef returns correct definition", () => {
    const tool = new PlanStatusTool({});
    const def = tool.toToolDef();
    expect(def.function.name).toBe("plan_status");
    expect(def.function.parameters.required).toEqual([]);
  });

  it("callDisplay shows 'all' when no task_id", () => {
    const tool = new PlanStatusTool({});
    const display = tool.callDisplay(JSON.stringify({}));
    expect(display).toContain("all");
  });

  it("callDisplay shows task_id when provided", () => {
    const tool = new PlanStatusTool({});
    const display = tool.callDisplay(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(display).toContain("t1");
  });
});

describe("CompleteTaskTool", () => {
  it("has correct tool name", () => {
    expect(CompleteTaskTool.TOOL_NAME).toBe("complete_task");
  });

  it("returns error when task_id is missing", async () => {
    const tool = new CompleteTaskTool({});
    const result = await tool.execute(JSON.stringify({}));
    expect(result.error).toContain("task_id is required");
  });

  it("marks task as complete", async () => {
    const tool = new CompleteTaskTool({});
    const result = await tool.execute(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(result.output).toContain("Task t1 marked as complete");
    expect(result.metadata.get("task_id")).toBe("t1");
  });

  it("toToolDef returns correct definition", () => {
    const tool = new CompleteTaskTool({});
    const def = tool.toToolDef();
    expect(def.function.name).toBe("complete_task");
    expect(def.function.parameters.required).toContain("task_id");
  });

  it("callDisplay formats correctly", () => {
    const tool = new CompleteTaskTool({});
    const display = tool.callDisplay(
      JSON.stringify({ task_id: "t1" }),
    );
    expect(display).toBe("complete_task(t1)");
  });
});

describe("WaitTool", () => {
  it("has correct tool name", () => {
    expect(WaitTool.TOOL_NAME).toBe("wait");
  });

  it("returns wait message without note when no message", async () => {
    const tool = new WaitTool({});
    const result = await tool.execute(JSON.stringify({}));
    expect(result.output).toContain("Waiting for user input");
    expect(result.output).not.toContain("Note:");
  });

  it("returns wait message with note when message provided", async () => {
    const tool = new WaitTool({});
    const result = await tool.execute(
      JSON.stringify({ message: "All tasks complete" }),
    );
    expect(result.output).toContain("Note: All tasks complete");
    expect(result.metadata.get("message")).toBe("All tasks complete");
  });

  it("toToolDef returns correct definition", () => {
    const tool = new WaitTool({});
    const def = tool.toToolDef();
    expect(def.function.name).toBe("wait");
    expect(def.function.parameters.required).toEqual([]);
  });

  it("callDisplay shows message", () => {
    const tool = new WaitTool({});
    const display = tool.callDisplay(
      JSON.stringify({ message: "done" }),
    );
    expect(display).toContain("done");
  });

  it("callDisplay shows 'no-op' when no message", () => {
    const tool = new WaitTool({});
    const display = tool.callDisplay(JSON.stringify({}));
    expect(display).toContain("no-op");
  });
});

describe("SUBAGENT_TOOL_NAMES", () => {
  it("contains all expected tool names", () => {
    expect(SUBAGENT_TOOL_NAMES).toContain("delegate_task");
    expect(SUBAGENT_TOOL_NAMES).toContain("task_status");
    expect(SUBAGENT_TOOL_NAMES).toContain("task_followup");
    expect(SUBAGENT_TOOL_NAMES).toContain("task_interrupt");
    expect(SUBAGENT_TOOL_NAMES).toContain("plan_status");
    expect(SUBAGENT_TOOL_NAMES).toContain("complete_task");
    expect(SUBAGENT_TOOL_NAMES).toContain("wait");
    expect(SUBAGENT_TOOL_NAMES.length).toBe(7);
  });
});

describe("SUBAGENT_TOOL_CONSTRUCTORS", () => {
  it("has constructor for each tool name", () => {
    for (const name of SUBAGENT_TOOL_NAMES) {
      expect(SUBAGENT_TOOL_CONSTRUCTORS[name]).toBeDefined();
    }
  });

  it("constructors create instances with correct tool names", () => {
    const opts = {};
    expect(SUBAGENT_TOOL_CONSTRUCTORS.delegate_task(opts).constructor.name).toBe("DelegateTaskTool");
    expect(SUBAGENT_TOOL_CONSTRUCTORS.task_status(opts).constructor.name).toBe("TaskStatusTool");
    expect(SUBAGENT_TOOL_CONSTRUCTORS.task_followup(opts).constructor.name).toBe("TaskFollowupTool");
    expect(SUBAGENT_TOOL_CONSTRUCTORS.task_interrupt(opts).constructor.name).toBe("TaskInterruptTool");
    expect(SUBAGENT_TOOL_CONSTRUCTORS.plan_status(opts).constructor.name).toBe("PlanStatusTool");
    expect(SUBAGENT_TOOL_CONSTRUCTORS.complete_task(opts).constructor.name).toBe("CompleteTaskTool");
    expect(SUBAGENT_TOOL_CONSTRUCTORS.wait(opts).constructor.name).toBe("WaitTool");
  });
});
