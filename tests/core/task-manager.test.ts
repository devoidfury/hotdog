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

    it("tracks active tasks and provides task counts", async () => {
      let resolveRun1: () => void;
      let resolveRun2: () => void;
      const buildAgent = async () => ({
        context: [],
        run: async () => new Promise<void>((resolve) => {
          // Keep tasks running until explicitly resolved
          if (!resolveRun1) resolveRun1 = resolve;
          else resolveRun2 = resolve;
        }),
        notifyCompletion: () => {},
      } as any);

      const manager = new TaskManager({
        buildAgent,
        llmClient: {} as any,
        modelRegistry: { default: "test-model" } as any,
        config: { profilesPath: "./config/profiles", customKey: "customValue" } as any,
        hooks: {} as any,
        maxIterations: 100,
        taskProfile: "default",
        taskRole: "",
      });

      // Initially no tasks
      expect(manager.activeTasks()).toEqual([]);
      expect(manager.taskCounts()).toBeNull();
      expect(manager.progressMessage()).toBeNull();

      // Spawn two tasks
      await manager.spawnTask("task-1", "First task");
      await manager.spawnTask("task-2", "Second task");

      // Verify active tasks tracking
      expect(manager.activeTasks()).toEqual(["task-1", "task-2"]);
      expect(manager.taskCounts()).toEqual([2, 2]);
      expect(manager.progressMessage()).toBe("2 tasks running");

      // Verify config is accessible
      expect(manager.config).toHaveProperty("customKey", "customValue");

      // Complete one task
      resolveRun1!();
      await new Promise(r => setTimeout(r, 10));

      expect(manager.activeTasks()).toEqual(["task-2"]);
      expect(manager.taskCounts()).toEqual([1, 2]);
      expect(manager.progressMessage()).toBe("1 task running");

      // Complete second task
      resolveRun2!();
      await new Promise(r => setTimeout(r, 10));

      expect(manager.activeTasks()).toEqual([]);
      expect(manager.taskCounts()).toBeNull();
      expect(manager.progressMessage()).toBeNull();
    });
  });

  describe("_onTaskComplete", () => {
    it("enqueues result via bus without also adding to context", () => {
      const enqueued: any[] = [];
      const added: any[] = [];
      const manager = createManager();
      manager.setSessionManager({
        getAgent: () => ({
          addMessage(msg: any) { added.push(msg); },
        }) as any,
      });
      manager.setBus({ enqueue: (msg: any) => enqueued.push(msg) } as any);

      manager._onTaskComplete("task-1", "Result text");

      // Exactly one injection: the bus path only. The bus run loop appends
      // the enqueued text to the manager's context via agent.run(), so a
      // direct addMessage() here as well would double it.
      expect(enqueued).toHaveLength(1);
      expect(enqueued[0]).toContain("Task task-1 completed");
      expect(enqueued[0]).toContain("Result text");
      expect(added).toHaveLength(0);
    });

    it("falls back to direct context add when no bus is wired", () => {
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
      expect(managerContext[0].content).toBe("[Task task-1 completed]\nResult text");
    });

    it("handles missing session manager and bus gracefully", () => {
      const manager = createManager();
      expect(() => manager._onTaskComplete("task-1", "result")).not.toThrow();
    });
  });
});
