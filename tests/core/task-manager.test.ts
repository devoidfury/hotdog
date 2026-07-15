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
      buildAgent: async () => ({} as any),
      llmClient: {} as any,
      modelRegistry: {} as any,
      config: {} as any,
      hooks: {} as any,
      maxIterations: 100,
      taskProfile: "default",
      taskRole: "",
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
      const buildAgent = async (config: Record<string, unknown>) => ({
        context: [],
        run: async (input: string) => "Task result",
        notifyCompletion: () => {},
      } as any);

      const manager = new TaskManager({
        buildAgent,
        llmClient: {} as any,
        modelRegistry: { default: "test-model" } as any,
        config: { profilesPath: "./config/profiles" } as any,
        hooks: {} as any,
        maxIterations: 100,
        taskProfile: "default",
        taskRole: "",
      });

      const handle = await manager.spawnTask("task-1", "Do something");
      expect(handle.taskId).toBe("task-1");
      expect([TASK_STATUS.RUNNING, TASK_STATUS.COMPLETED]).toContain(handle.status as typeof TASK_STATUS.RUNNING | typeof TASK_STATUS.COMPLETED);
    });

    it("uses custom worker model when provided", async () => {
      let agentConfig: Record<string, unknown> | null = null;
      const buildAgent = async (config: Record<string, unknown>) => {
        agentConfig = config;
        return {
          context: [],
          run: async () => "result",
          notifyCompletion: () => {},
        } as any;
      };

      const manager = new TaskManager({
        buildAgent,
        llmClient: {} as any,
        modelRegistry: { default: "default-model" } as any,
        config: { profilesPath: "./config/profiles" } as any,
        hooks: {} as any,
        maxIterations: 100,
        taskProfile: "default",
        taskRole: "",
      });

      await manager.spawnTask("task-1", "Do something", { workerModel: "custom-model" });
      expect((agentConfig as any)?.model).toBe("custom-model");
    });
  });

  describe("_onTaskComplete", () => {
    it("appends result to manager context via session manager", () => {
      const managerContext: any[] = [];
      const manager = createManager();
      manager.setSessionManager({
        getAgent: () => ({
          context: managerContext,
          addMessage(msg: any) { managerContext.push(msg); },
        }) as any,
      });

      manager._onTaskComplete("task-1", "Result text");

      expect(managerContext).toHaveLength(1);
      expect(managerContext[0].role).toBe("user");
      expect(managerContext[0].content).toContain("<system-notice>");
      expect(managerContext[0].content).toContain("Task task-1 completed");
    });

    it("enqueues message via bus", () => {
      const enqueued: any[] = [];
      const manager = createManager();
      manager.setBus({ enqueue: (msg: any) => enqueued.push(msg) } as any);

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
