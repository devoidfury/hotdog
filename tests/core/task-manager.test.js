// Tests for TaskManager — manages background task agents.

import { describe, it, expect } from "bun:test";
import { TaskManager, TaskHandle, TASK_STATUS } from "../../src/core/session/task-manager.js";
import { AgentSink } from "../../src/core/session/agent-sink.js";

describe("TASK_STATUS", () => {
  it("has all expected status values", () => {
    expect(TASK_STATUS.RUNNING).toBe("running");
    expect(TASK_STATUS.COMPLETED).toBe("completed");
    expect(TASK_STATUS.FAILED).toBe("failed");
    expect(TASK_STATUS.CANCELLED).toBe("cancelled");
  });
});

describe("TaskHandle", () => {
  it("creates with taskId", () => {
    const statusRef = { value: TASK_STATUS.RUNNING };
    const abortController = new AbortController();
    const handle = new TaskHandle("task-1", statusRef, abortController);

    expect(handle.taskId).toBe("task-1");
    expect(handle.status).toBe(TASK_STATUS.RUNNING);
  });

  it("interrupt() aborts when running", () => {
    const statusRef = { value: TASK_STATUS.RUNNING };
    const abortController = new AbortController();
    const handle = new TaskHandle("task-1", statusRef, abortController);

    const result = handle.interrupt();
    expect(result).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
  });

  it("interrupt() returns false when not running", () => {
    const statusRef = { value: TASK_STATUS.COMPLETED };
    const abortController = new AbortController();
    const handle = new TaskHandle("task-1", statusRef, abortController);

    const result = handle.interrupt();
    expect(result).toBe(false);
    expect(abortController.signal.aborted).toBe(false);
  });
});

describe("TaskManager", () => {
  describe("constructor", () => {
    it("creates with defaults", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      expect(manager).toBeDefined();
    });

    it("accepts custom maxIterations", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
        maxIterations: 500,
      });
      expect(manager._maxIterations).toBe(500);
    });
  });

  describe("setSessionManager", () => {
    it("stores the session manager", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      const sessionManager = { getAgent: () => ({ context: [] }) };
      manager.setSessionManager(sessionManager);
      expect(manager._sessionManager).toBe(sessionManager);
    });
  });

  describe("setBus", () => {
    it("stores the message bus", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      const bus = { enqueue: () => {} };
      manager.setBus(bus);
      expect(manager._bus).toBe(bus);
    });
  });

  describe("taskStatus", () => {
    it("returns null for unknown task", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      expect(manager.taskStatus("unknown")).toBeNull();
    });
  });

  describe("sendFollowUp", () => {
    it("returns false for unknown task", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      expect(manager.sendFollowUp("unknown", "message")).toBe(false);
    });

    it("returns false for non-running task", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      // Manually add a completed task
      manager._tasks.set("task-1", {
        statusRef: { value: TASK_STATUS.COMPLETED },
        agent: {},
      });
      expect(manager.sendFollowUp("task-1", "message")).toBe(false);
    });
  });

  describe("interruptTask", () => {
    it("returns false for unknown task", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      expect(manager.interruptTask("unknown")).toBe(false);
    });
  });

  describe("activeTasks", () => {
    it("returns empty array when no tasks", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      expect(manager.activeTasks()).toEqual([]);
    });

    it("returns only running tasks", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      manager._tasks.set("running-1", {
        statusRef: { value: TASK_STATUS.RUNNING },
        agent: {},
      });
      manager._tasks.set("completed-1", {
        statusRef: { value: TASK_STATUS.COMPLETED },
        agent: {},
      });
      manager._tasks.set("running-2", {
        statusRef: { value: TASK_STATUS.RUNNING },
        agent: {},
      });

      const active = manager.activeTasks();
      expect(active).toContain("running-1");
      expect(active).toContain("running-2");
      expect(active).not.toContain("completed-1");
      expect(active).toHaveLength(2);
    });
  });

  describe("taskCounts", () => {
    it("returns null when no active tasks", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      expect(manager.taskCounts()).toBeNull();
    });

    it("returns [active, total] when tasks are running", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      manager._tasks.set("running-1", {
        statusRef: { value: TASK_STATUS.RUNNING },
        agent: {},
      });
      manager._tasks.set("completed-1", {
        statusRef: { value: TASK_STATUS.COMPLETED },
        agent: {},
      });

      const counts = manager.taskCounts();
      expect(counts).toEqual([1, 2]);
    });
  });

  describe("progressMessage", () => {
    it("returns null when no active tasks", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      expect(manager.progressMessage()).toBeNull();
    });

    it("returns singular message for 1 task", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      manager._tasks.set("task-1", {
        statusRef: { value: TASK_STATUS.RUNNING },
        agent: {},
      });

      expect(manager.progressMessage()).toBe("1 task running");
    });

    it("returns plural message for multiple tasks", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      manager._tasks.set("task-1", {
        statusRef: { value: TASK_STATUS.RUNNING },
        agent: {},
      });
      manager._tasks.set("task-2", {
        statusRef: { value: TASK_STATUS.RUNNING },
        agent: {},
      });

      expect(manager.progressMessage()).toBe("2 tasks running");
    });
  });

  describe("spawnTask", () => {
    it("creates a task handle", async () => {
      let builtAgent = null;
      const buildAgent = (config) => {
        builtAgent = {
          _abortSignal: null,
          _followQueue: [],
          context: [],
          run: async (input) => "Task result",
          _notifyCompletion: () => {},
        };
        return builtAgent;
      };

      const manager = new TaskManager({
        buildAgent,
        llmClient: {},
        modelRegistry: { default: "test-model" },
        config: { profilesPath: "./config/profiles" },
      });

      const handle = await manager.spawnTask("task-1", "Do something");

      expect(handle.taskId).toBe("task-1");
      // Task may complete immediately since mock agent returns synchronously
      expect([TASK_STATUS.RUNNING, TASK_STATUS.COMPLETED]).toContain(handle.status);
    });

    it("passes abort signal to agent", async () => {
      let capturedSignal = null;
      const buildAgent = (config) => ({
        _abortSignal: null,
        _followQueue: [],
        context: [],
        run: async (input) => {
          return "Task result";
        },
        _notifyCompletion: () => {},
      });

      const manager = new TaskManager({
        buildAgent,
        llmClient: {},
        modelRegistry: { default: "test-model" },
        config: { profilesPath: "./config/profiles" },
      });

      const handle = await manager.spawnTask("task-1", "Do something");

      // Task should eventually complete
      // Give it a moment to finish
      await new Promise((r) => setTimeout(r, 50));
    });

    it("uses custom worker model when provided", async () => {
      let agentConfig = null;
      const buildAgent = (config) => {
        agentConfig = config;
        return {
          _abortSignal: null,
          _followQueue: [],
          context: [],
          run: async () => "result",
          _notifyCompletion: () => {},
        };
      };

      const manager = new TaskManager({
        buildAgent,
        llmClient: {},
        modelRegistry: { default: "default-model" },
        config: { profilesPath: "./config/profiles" },
      });

      await manager.spawnTask("task-1", "Do something", {
        workerModel: "custom-model",
      });

      expect(agentConfig.model).toBe("custom-model");
    });

    it("uses custom profile when provided", async () => {
      let agentConfig = null;
      const buildAgent = (config) => {
        agentConfig = config;
        return {
          _abortSignal: null,
          _followQueue: [],
          context: [],
          run: async () => "result",
          _notifyCompletion: () => {},
        };
      };

      const manager = new TaskManager({
        buildAgent,
        llmClient: {},
        modelRegistry: { default: "default-model" },
        config: { profilesPath: "./config/profiles" },
      });

      await manager.spawnTask("task-1", "Do something", {
        profile: "default",
      });

      expect(agentConfig).toBeDefined();
    });
  });

  describe("_onTaskComplete", () => {
    it("appends result to manager context via session manager", () => {
      const managerContext = [];
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      manager.setSessionManager({
        getAgent: () => ({ context: managerContext }),
      });

      manager._onTaskComplete("task-1", "Result text");

      expect(managerContext).toHaveLength(1);
      expect(managerContext[0].role).toBe("system");
      expect(managerContext[0].content).toContain("Task task-1 completed");
    });

    it("enqueues message via bus", () => {
      const enqueued = [];
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      manager.setBus({ enqueue: (msg) => enqueued.push(msg) });

      manager._onTaskComplete("task-2", "Result text");

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toContain("Task task-2 completed");
    });

    it("handles missing session manager gracefully", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });

      expect(() => manager._onTaskComplete("task-1", "result")).not.toThrow();
    });

    it("handles missing bus gracefully", () => {
      const manager = new TaskManager({
        buildAgent: () => ({}),
        llmClient: {},
      });
      manager.setSessionManager({
        getAgent: () => ({ context: [] }),
      });

      expect(() => manager._onTaskComplete("task-1", "result")).not.toThrow();
    });
  });
});
