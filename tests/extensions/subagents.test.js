// Tests for subagents extension and SubagentTool base class.
import { describe, it, expect, mock } from "bun:test";
import { create } from "../../src/extensions/subagents/index.js";
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

describe("subagents create", () => {
  it("returns null when taskManager not provided", () => {
    const core = { hooks: {}, config: {} };
    const result = create(core, {});
    expect(result).toBeNull();
  });

  it("returns null when profile is not a manager", () => {
    const core = {
      hooks: {},
      config: { profile: { manager: false } },
    };
    const result = create(core, { taskManager: {} });
    expect(result).toBeNull();
  });

  it("returns extension when profile is manager and taskManager provided", () => {
    const hooks = {};
    const core = {
      hooks,
      config: { profile: { manager: true } },
    };
    const taskManager = {};
    const result = create(core, { taskManager });
    expect(result).not.toBeNull();
    expect(result.hooks).toBeDefined();
    expect(result.SUBAGENT_TOOL_NAMES).toEqual(SUBAGENT_TOOL_NAMES);
  });

  it("mounts taskManager and sessionCore on tool context", async () => {
    const toolCtx = {
      set: mock(() => {}),
    };
    const core = {
      hooks: {},
      config: { profile: { manager: true } },
    };
    const taskManager = { id: "tm" };
    const sessionCore = { id: "sc" };
    const result = create(core, { taskManager, sessionCore });
    await result.hooks["agent:toolContext"]({ toolCtx });
    expect(toolCtx.set).toHaveBeenCalledWith("taskManager", taskManager);
    expect(toolCtx.set).toHaveBeenCalledWith("sessionCore", sessionCore);
  });

  it("mounts null sessionCore when not provided", async () => {
    const toolCtx = {
      set: mock(() => {}),
    };
    const core = {
      hooks: {},
      config: { profile: { manager: true } },
    };
    const result = create(core, { taskManager: {} });
    await result.hooks["agent:toolContext"]({ toolCtx });
    expect(toolCtx.set).toHaveBeenCalledWith("sessionCore", null);
  });

  it("registers all subagent tools", async () => {
    const registered = [];
    const registry = {
      register: mock((name, tool) => registered.push(name)),
    };
    const core = {
      hooks: {},
      config: { profile: { manager: true } },
    };
    const result = create(core, { taskManager: {} });
    await result.hooks["tools:register"](registry);
    expect(registered).toEqual(SUBAGENT_TOOL_NAMES);
  });
});

describe("SUBAGENT_TOOL_NAMES and CONSTRUCTORS", () => {
  it("has correct tool names", () => {
    expect(SUBAGENT_TOOL_NAMES).toContain("delegate_task");
    expect(SUBAGENT_TOOL_NAMES).toContain("task_status");
    expect(SUBAGENT_TOOL_NAMES).toContain("task_followup");
    expect(SUBAGENT_TOOL_NAMES).toContain("task_interrupt");
    expect(SUBAGENT_TOOL_NAMES).toContain("plan_status");
    expect(SUBAGENT_TOOL_NAMES).toContain("complete_task");
    expect(SUBAGENT_TOOL_NAMES).toContain("wait");
  });

  it("has constructor for each tool name", () => {
    for (const name of SUBAGENT_TOOL_NAMES) {
      expect(SUBAGENT_TOOL_CONSTRUCTORS[name]).toBeDefined();
    }
  });
});

describe("SubagentTool", () => {
  it("accepts options object with taskManager and sessionCore", () => {
    const tm = { id: "tm" };
    const sc = { id: "sc" };
    const tool = new SubagentTool({ taskManager: tm, sessionCore: sc });
    expect(tool._taskManager).toBe(tm);
    expect(tool._sessionCore).toBe(sc);
  });

  it("accepts options with only taskManager", () => {
    const tm = { id: "tm" };
    const tool = new SubagentTool({ taskManager: tm });
    expect(tool._taskManager).toBe(tm);
    expect(tool._sessionCore).toBeNull();
  });

  it("defaults to null when options missing", () => {
    const tool = new SubagentTool({});
    expect(tool._taskManager).toBeNull();
    expect(tool._sessionCore).toBeNull();
  });

  it("_resolveBackend returns sessionCore when available", () => {
    const tool = new SubagentTool({ sessionCore: { id: "sc" } });
    const backend = tool._resolveBackend();
    expect(backend.type).toBe("sessionCore");
    expect(backend.value.id).toBe("sc");
  });

  it("_resolveBackend returns taskManager when no sessionCore", () => {
    const tool = new SubagentTool({ taskManager: { id: "tm" } });
    const backend = tool._resolveBackend();
    expect(backend.type).toBe("taskManager");
    expect(backend.value.id).toBe("tm");
  });

  it("_resolveBackend returns none when both null", () => {
    const tool = new SubagentTool({});
    const backend = tool._resolveBackend();
    expect(backend.type).toBe("none");
    expect(backend.value).toBeNull();
  });

  it("_ensureBackend returns error string when no backend", () => {
    const tool = new SubagentTool({});
    const result = tool._ensureBackend();
    expect(typeof result).toBe("string");
    expect(result).toContain("Task manager not available");
  });

  it("_ensureBackend returns backend when available", () => {
    const tool = new SubagentTool({ taskManager: { id: "tm" } });
    const result = tool._ensureBackend();
    expect(result.type).toBe("taskManager");
  });

  it("callDisplay returns default format", () => {
    const tool = new SubagentTool({});
    const display = tool.callDisplay('{"task_id": "t1"}');
    expect(display).toContain("SubagentTool");
  });
});

describe("DelegateTaskTool", () => {
  it("has correct tool name constant", () => {
    expect(DelegateTaskTool.TOOL_NAME).toBe("delegate_task");
  });

  it("toToolDef returns correct structure", () => {
    const tool = new DelegateTaskTool({ taskManager: null, sessionCore: null });
    const def = tool.toToolDef();
    expect(def.function.name).toBe("delegate_task");
    expect(def.function.description).toContain("delegate");
    expect(def.function.parameters.properties.task_id).toBeDefined();
    expect(def.function.parameters.required).toContain("task_id");
  });

  it("returns error when no backend available", async () => {
    const tool = new DelegateTaskTool({ taskManager: null, sessionCore: null });
    const result = await tool.execute('{"task_id": "t1", "description": "test"}');
    expect(result.success).toBe(false);
  });

  it("requires task_id and description", async () => {
    const tool = new DelegateTaskTool({ taskManager: null, sessionCore: null });
    const result = await tool.execute('{}');
    expect(result.success).toBe(false);
    expect(result.error).toContain("required");
  });
});

describe("TaskStatusTool", () => {
  it("has correct registered name", () => {
    expect(TaskStatusTool.TOOL_NAME).toBe("task_status");
  });

  it("returns error when taskManager not available", async () => {
    const tool = new TaskStatusTool({ taskManager: null, sessionCore: null });
    const result = await tool.execute('{"task_id": "t1"}');
    expect(result.success).toBe(false);
    expect(result.error).toContain("not available");
  });
});

describe("TaskFollowupTool", () => {
  it("has correct registered name", () => {
    expect(TaskFollowupTool.TOOL_NAME).toBe("task_followup");
  });
});

describe("TaskInterruptTool", () => {
  it("has correct registered name", () => {
    expect(TaskInterruptTool.TOOL_NAME).toBe("task_interrupt");
  });
});

describe("PlanStatusTool", () => {
  it("has correct registered name", () => {
    expect(PlanStatusTool.TOOL_NAME).toBe("plan_status");
  });
});

describe("CompleteTaskTool", () => {
  it("has correct registered name", () => {
    expect(CompleteTaskTool.TOOL_NAME).toBe("complete_task");
  });
});

describe("WaitTool", () => {
  it("has correct registered name", () => {
    expect(WaitTool.TOOL_NAME).toBe("wait");
  });

  it("has description and input schema via toToolDef", () => {
    const tool = new WaitTool({ taskManager: null, sessionCore: null });
    const def = tool.toToolDef();
    expect(def.function.description).toBeDefined();
    expect(def.function.parameters).toBeDefined();
  });

  it("executes wait with no message", async () => {
    const tool = new WaitTool({ taskManager: null, sessionCore: null });
    const result = await tool.execute("{}");
    expect(result.success).toBe(true);
    expect(result.output).toContain("Waiting for user input");
  });

  it("executes wait with a message", async () => {
    const tool = new WaitTool({ taskManager: null, sessionCore: null });
    const result = await tool.execute('{"message": "All done"}');
    expect(result.success).toBe(true);
    expect(result.output).toContain("All done");
  });
});

describe("tool execute methods with backend", () => {
  function makeBackend() {
    const tasks = new Map();
    return {
      taskOrchestrator: {
        taskStatus(id) {
          return tasks.get(id) || null;
        },
        activeTasks() {
          return Array.from(tasks.keys());
        },
        followUp(id, msg) {
          return tasks.has(id);
        },
        interrupt(id) {
          tasks.set(id, "Cancelled");
          return true;
        },
      },
      spawnTask(id, desc, opts) {
        tasks.set(id, "Running");
        return { taskId: id };
      },
    };
  }

  describe("DelegateTaskTool.execute", () => {
    it("delegates task successfully", async () => {
      const backend = makeBackend();
      const tool = new DelegateTaskTool({ taskManager: backend });
      const result = await tool.execute(
        '{"task_id": "t1", "description": "do something"}',
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain("t1");
    });

    it("requires task_id and description", async () => {
      const tool = new DelegateTaskTool({ taskManager: null, sessionCore: null });
      const result = await tool.execute('{"task_id": "t1"}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });
  });

  describe("TaskStatusTool.execute", () => {
    it("returns status for existing task", async () => {
      const backend = makeBackend();
      backend.taskOrchestrator.taskStatus = (id) => {
        return id === "t1" ? "Running" : null;
      };
      const tool = new TaskStatusTool({ taskManager: backend });
      const result = await tool.execute('{"task_id": "t1"}');
      expect(result.success).toBe(true);
      expect(result.output).toContain("Running");
    });

    it("returns error for unknown task", async () => {
      const backend = makeBackend();
      backend.taskOrchestrator.taskStatus = () => null;
      const tool = new TaskStatusTool({ taskManager: backend });
      const result = await tool.execute('{"task_id": "unknown"}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("not found");
    });

    it("requires task_id", async () => {
      const tool = new TaskStatusTool({ taskManager: null, sessionCore: null });
      const result = await tool.execute('{}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });
  });

  describe("TaskFollowupTool.execute", () => {
    it("sends follow-up to running task", async () => {
      const backend = makeBackend();
      backend.spawnTask("t1", "test", {});
      const tool = new TaskFollowupTool({ taskManager: backend });
      const result = await tool.execute(
        '{"task_id": "t1", "message": "please hurry"}',
      );
      expect(result.success).toBe(true);
    });

    it("fails for unknown task", async () => {
      const backend = makeBackend();
      backend.taskOrchestrator.followUp = () => false;
      const tool = new TaskFollowupTool({ taskManager: backend });
      const result = await tool.execute(
        '{"task_id": "t1", "message": "please hurry"}',
      );
      expect(result.success).toBe(false);
    });

    it("requires task_id and message", async () => {
      const tool = new TaskFollowupTool({ taskManager: null, sessionCore: null });
      const result = await tool.execute('{"task_id": "t1"}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });
  });

  describe("TaskInterruptTool.execute", () => {
    it("interrupts a running task", async () => {
      const backend = makeBackend();
      const tool = new TaskInterruptTool({ taskManager: backend });
      const result = await tool.execute('{"task_id": "t1"}');
      expect(result.success).toBe(true);
      expect(result.output).toContain("interrupted");
    });

    it("requires task_id", async () => {
      const tool = new TaskInterruptTool({ taskManager: null, sessionCore: null });
      const result = await tool.execute('{}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });
  });

  describe("PlanStatusTool.execute", () => {
    it("shows all active tasks", async () => {
      const backend = makeBackend();
      backend.spawnTask("t1", "test1", {});
      backend.spawnTask("t2", "test2", {});
      const tool = new PlanStatusTool({ taskManager: backend });
      const result = await tool.execute('{}');
      expect(result.success).toBe(true);
      expect(result.output).toContain("Active tasks");
    });

    it("shows no active tasks", async () => {
      const backend = makeBackend();
      const tool = new PlanStatusTool({ taskManager: backend });
      const result = await tool.execute('{}');
      expect(result.success).toBe(true);
      expect(result.output).toContain("No active tasks");
    });

    it("shows status for specific task", async () => {
      const backend = makeBackend();
      backend.taskOrchestrator.taskStatus = (id) => {
        return id === "t1" ? "Running" : null;
      };
      const tool = new PlanStatusTool({ taskManager: backend });
      const result = await tool.execute('{"task_id": "t1"}');
      expect(result.success).toBe(true);
      expect(result.output).toContain("Running");
    });
  });

  describe("CompleteTaskTool.execute", () => {
    it("marks task as complete", async () => {
      const tool = new CompleteTaskTool({ taskManager: null, sessionCore: null });
      const result = await tool.execute('{"task_id": "t1"}');
      expect(result.success).toBe(true);
      expect(result.output).toContain("complete");
    });

    it("requires task_id", async () => {
      const tool = new CompleteTaskTool({ taskManager: null, sessionCore: null });
      const result = await tool.execute('{}');
      expect(result.success).toBe(false);
      expect(result.error).toContain("required");
    });
  });

  describe("callDisplay", () => {
    it("DelegateTaskTool shows task description", () => {
      const tool = new DelegateTaskTool({ taskManager: null, sessionCore: null });
      const display = tool.callDisplay(
        '{"task_id": "t1", "description": "fix bug"}',
      );
      expect(display).toContain("t1");
      expect(display).toContain("fix bug");
    });

    it("TaskStatusTool shows task_id", () => {
      const tool = new TaskStatusTool({ taskManager: null, sessionCore: null });
      const display = tool.callDisplay('{"task_id": "t1"}');
      expect(display).toContain("t1");
    });

    it("TaskFollowupTool shows task_id and message", () => {
      const tool = new TaskFollowupTool({ taskManager: null, sessionCore: null });
      const display = tool.callDisplay(
        '{"task_id": "t1", "message": "hurry up"}',
      );
      expect(display).toContain("t1");
      expect(display).toContain("hurry up");
    });

    it("TaskInterruptTool shows task_id", () => {
      const tool = new TaskInterruptTool({ taskManager: null, sessionCore: null });
      const display = tool.callDisplay('{"task_id": "t1"}');
      expect(display).toContain("t1");
    });

    it("PlanStatusTool shows all when no task_id", () => {
      const tool = new PlanStatusTool({ taskManager: null, sessionCore: null });
      const display = tool.callDisplay('{}');
      expect(display).toContain("all");
    });

    it("CompleteTaskTool shows task_id", () => {
      const tool = new CompleteTaskTool({ taskManager: null, sessionCore: null });
      const display = tool.callDisplay('{"task_id": "t1"}');
      expect(display).toContain("t1");
    });

    it("WaitTool shows message or no-op", () => {
      const tool = new WaitTool({ taskManager: null, sessionCore: null });
      expect(tool.callDisplay('{}')).toBe("wait(no-op)");
      expect(tool.callDisplay('{"message": "done"}')).toBe("wait(done)");
    });
  });
});