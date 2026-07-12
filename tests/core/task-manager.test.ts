// Tests for TaskManager -- manages background task agents.

import { describe, it, expect } from "bun:test";
import { TaskManager, TaskHandle, TASK_STATUS } from "../../src/core/session/task-manager.ts";

describe("TaskHandle", () => {
  it("creates with taskId and status", () => {
    const statusRef = { value: TASK_STATUS.RUNNING };
    const handle = new TaskHandle("task-1", statusRef, new AbortController());
    expect(handle.taskId).toBe("task-1");
    expect(handle.status).toBe(TASK_STATUS.RUNNING);
  });

  it("interrupt() aborts when running", () => {
    const statusRef = { value: TASK_STATUS.RUNNING };
    const abortController = new AbortController();
    const handle = new TaskHandle("task-1", statusRef, abortController);
    expect(handle.interrupt()).toBe(true);
    expect(abortController.signal.aborted).toBe(true);
  });

  it("interrupt() returns false when not running", () => {
    const statusRef = { value: TASK_STATUS.COMPLETED };
    const handle = new TaskHandle("task-1", statusRef, new AbortController());
    expect(handle.interrupt()).toBe(false);
  });
});

describe("TaskManager", () => {
  function createManager(options = {}) {
    return new TaskManager({
      buildAgent: () => ({}),
      llmClient: {},
      ...options,
    });
  }

  it("creates with defaults", () => {
    const manager = createManager();
    expect(manager.activeTasks()).toEqual([]);
    expect(manager.taskCounts()).toBeNull();
    expect(manager.progressMessage()).toBeNull();
  });

  describe("query methods with no tasks", () => {
    it("returns null for unknown task status", () => {
      expect(createManager().taskStatus("unknown")).toBeNull();
    });

    it("returns false for operations on unknown task", () => {
      const manager = createManager();
      expect(manager.sendFollowUp("unknown", "message")).toBe(false);
      expect(manager.interruptTask("unknown")).toBe(false);
    });
  });

  describe("spawnTask", () => {
    it("creates a task handle", async () => {
      const buildAgent = (config: Record<string, unknown>) => ({
        context: [],
        run: async (input: string) => "Task result",
        notifyCompletion: () => {},
      });

      const manager = new TaskManager({
        buildAgent,
        llmClient: {},
        modelRegistry: { default: "test-model" },
        config: { profilesPath: "./config/profiles" },
      });

      const handle = await manager.spawnTask("task-1", "Do something");
      expect(handle.taskId).toBe("task-1");
      expect([TASK_STATUS.RUNNING, TASK_STATUS.COMPLETED]).toContain(handle.status);
    });

    it("uses custom worker model when provided", async () => {
      let agentConfig: Record<string, unknown> | null = null;
      const buildAgent = (config: Record<string, unknown>) => {
        agentConfig = config;
        return {
          context: [],
          run: async () => "result",
          notifyCompletion: () => {},
        };
      };

      const manager = new TaskManager({
        buildAgent,
        llmClient: {},
        modelRegistry: { default: "default-model" },
        config: { profilesPath: "./config/profiles" },
      });

      await manager.spawnTask("task-1", "Do something", { workerModel: "custom-model" });
      expect(agentConfig?.model).toBe("custom-model");
    });
  });

  describe("_onTaskComplete", () => {
    it("appends result to manager context via session manager", () => {
      const managerContext = [];
      const manager = createManager();
      manager.setSessionManager({
        getAgent: () => ({
          context: managerContext,
          addMessage(msg) { managerContext.push(msg); },
        }),
      });

      manager._onTaskComplete("task-1", "Result text");

      expect(managerContext).toHaveLength(1);
      expect(managerContext[0].role).toBe("user");
      expect(managerContext[0].content).toContain("<system-notice>");
      expect(managerContext[0].content).toContain("Task task-1 completed");
    });

    it("enqueues message via bus", () => {
      const enqueued = [];
      const manager = createManager();
      manager.setBus({ enqueue: (msg) => enqueued.push(msg) });

      manager._onTaskComplete("task-2", "Result text");

      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toContain("Task task-2 completed");
    });

    it("handles missing session manager and bus gracefully", () => {
      const manager = createManager();
      expect(() => manager._onTaskComplete("task-1", "result")).not.toThrow();
    });
  });
});
