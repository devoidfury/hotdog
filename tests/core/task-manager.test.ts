// Tests for TaskManager -- manages background task agents.

import { describe, it, expect } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { TaskManager, TaskHandle, TASK_STATUS } from "@core/session/task-manager.ts";
import { contentToText } from "@core/context/message.ts";
import { createHooks } from "@core/hooks.ts";
import { initializeLogger, resetLoggerForTesting, type LogEvent } from "@utils/logger.ts";
import { LlmError } from "@core/error.ts";

/** The harness structure a task result is delivered as. */
function resultParts(taskId: string, result: string) {
  return [
    { type: "text", text: `[Task ${taskId} completed]\n` },
    { type: "untrusted", text: result },
  ];
}

// Poll until a condition holds (fails loudly on timeout) instead of a
// fixed sleep, which is racy under parallel test load.
async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(r => setTimeout(r, 1));
  }
}

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
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 100,
      taskProfile: "default",
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

  describe("sendFollowUp (steering only)", () => {
    // Fake task agent whose run hangs until released, keeping the task RUNNING.
    function makeHangingAgent(extra: Record<string, unknown> = {}) {
      let releaseRun!: () => void;
      const agent = {
        run: () => new Promise<void>((resolve) => { releaseRun = resolve; }),
        notifyCompletion: () => {},
        ...extra,
      };
      return { agent, releaseRun: () => releaseRun() };
    }

    function managerFor(agent: Record<string, unknown>) {
      return new TaskManager({
        buildAgent: async () => agent as any,
        modelRegistry: {} as any,
        config: {} as any,
        maxIterations: 100,
        taskProfile: "default",
      });
    }

    it("steers the running task agent via its steering queue", async () => {
      const steered: string[] = [];
      const added: unknown[] = [];
      const { agent, releaseRun } = makeHangingAgent({
        steer: (m: string) => steered.push(m),
        addMessage: (m: unknown) => added.push(m),
      });
      const manager = managerFor(agent);

      await manager.spawnTask("task-1", "Do it");
      // #launch builds the agent asynchronously after admission; wait for it.
      await settle(() => manager._test_tasks.get("task-1")!.agent !== null, "agent build");
      expect(manager.sendFollowUp("task-1", "steer me")).toBe(true);
      expect(steered).toEqual(["steer me"]);
      // No direct context append -- that could land between an
      // assistant(tool_calls) message and its tool results.
      expect(added).toHaveLength(0);

      releaseRun();
      await settle(() => manager.taskStatus("task-1") === TASK_STATUS.COMPLETED, "completion");
    });

    it("returns false when the agent cannot be steered (no addMessage back door)", async () => {
      const added: unknown[] = [];
      const { agent, releaseRun } = makeHangingAgent({
        addMessage: (m: unknown) => added.push(m),
      });
      const manager = managerFor(agent);

      await manager.spawnTask("task-1", "Do it");
      await settle(() => manager._test_tasks.get("task-1")!.agent !== null, "agent build");
      expect(manager.sendFollowUp("task-1", "back door")).toBe(false);
      expect(added).toHaveLength(0);

      releaseRun();
      await settle(() => manager.taskStatus("task-1") === TASK_STATUS.COMPLETED, "completion");
    });
  });

  describe("spawnTask", () => {
    it("creates a task handle", async () => {
      const buildAgent = async (_config: Record<string, unknown>) => ({
        context: [],
        run: async () => "Task result",
        notifyCompletion: () => {},
      } as any);

      const manager = new TaskManager({
        buildAgent,
        modelRegistry: { default: "test-model" } as any,
        config: { profilesPath: "./config/profiles" } as any,
        maxIterations: 100,
        taskProfile: "default",
      });

      const handle = await manager.spawnTask("task-1", "Do something");
      expect(handle.taskId).toBe("task-1");
      expect([TASK_STATUS.RUNNING, TASK_STATUS.COMPLETED]).toContain(handle.status as typeof TASK_STATUS.RUNNING | typeof TASK_STATUS.COMPLETED);
    });

    it("refuses to reuse a live task id", async () => {
      let release!: () => void;
      const buildAgent = async (_config: Record<string, unknown>) => ({
        context: [],
        run: () => new Promise<string>((resolve) => { release = () => resolve("done"); }),
        notifyCompletion: () => {},
      } as any);

      const manager = new TaskManager({
        buildAgent,
        modelRegistry: { default: "test-model" } as any,
        config: {} as any,
        maxIterations: 100,
        taskProfile: "default",
      });

      const first = await manager.spawnTask("dup", "first");
      let msg = "";
      try {
        await manager.spawnTask("dup", "second");
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg).toContain("task id already in use");
      // The first task is untouched by the refused collision.
      expect(manager.taskStatus("dup")).toBe(TASK_STATUS.RUNNING);
      release();
      await first.done;
    });

    it("refuses a concurrent same-id spawn during the planning window (C-M2)", async () => {
      let release!: () => void;
      const builds: string[] = [];
      const buildAgent = async (config: Record<string, unknown>) => {
        builds.push(String(config.model));
        return {
          context: [],
          run: () => new Promise<string>((resolve) => { release = () => resolve("done"); }),
          notifyCompletion: () => {},
        } as any;
      };

      const manager = new TaskManager({
        buildAgent,
        modelRegistry: { default: "test-model" } as any,
        config: {} as any,
        maxIterations: 100,
        taskProfile: "default",
      });

      // The second spawn starts while the first is still awaiting its profile
      // load / model plan. Before the synchronous reservation, both calls
      // passed the collision check and the second's registration silently
      // replaced the first registry entry, orphaning the first task.
      const first = manager.spawnTask("dup", "first");
      const second = manager.spawnTask("dup", "second");
      await expect(second).rejects.toThrow(/task id already in use/);
      const handle = await first;
      expect(handle.status).toBe(TASK_STATUS.RUNNING);
      expect(manager.taskStatus("dup")).toBe(TASK_STATUS.RUNNING);
      await settle(() => builds.length === 1, "first task builds");
      release();
      const completion = await handle.done;
      expect(completion.status).toBe(TASK_STATUS.COMPLETED);
      // The losing spawn launched nothing.
      expect(builds).toHaveLength(1);
    });

    it("allows reusing a terminal task id (long-lived managers)", async () => {
      const buildAgent = async (_config: Record<string, unknown>) => ({
        context: [],
        run: async () => ({ type: "completion", content: "r" }),
        notifyCompletion: () => {},
      } as any);

      const manager = new TaskManager({
        buildAgent,
        modelRegistry: { default: "test-model" } as any,
        config: {} as any,
        maxIterations: 100,
        taskProfile: "default",
      });

      const first = await manager.spawnTask("reuse", "one");
      await first.done;
      const second = await manager.spawnTask("reuse", "two");
      expect(second.taskId).toBe("reuse");
      await second.done;
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
        modelRegistry: { default: "default-model" } as any,
        config: { profilesPath: "./config/profiles" } as any,
        maxIterations: 100,
        taskProfile: "default",
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
        modelRegistry: { default: "test-model" } as any,
        config: { profilesPath: "./config/profiles", customKey: "customValue" } as any,
        maxIterations: 100,
        taskProfile: "default",
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

      // Complete one task; wait for the manager to observe it
      resolveRun1!();
      await settle(() => manager.activeTasks().length === 1, "task-1 completion");

      expect(manager.activeTasks()).toEqual(["task-2"]);
      expect(manager.taskCounts()).toEqual([1, 2]);
      expect(manager.progressMessage()).toBe("1 task running");

      // Complete second task
      resolveRun2!();
      await settle(() => manager.activeTasks().length === 0, "task-2 completion");

      expect(manager.activeTasks()).toEqual([]);
      expect(manager.taskCounts()).toBeNull();
      expect(manager.progressMessage()).toBeNull();
    });
  });

  describe("interruptTasksForSession", () => {
    // Agent whose run() stays pending until its abortSignal fires --
    // #driveTurn assigns agent.abortSignal before calling run(), so the mock
    // reads it off `this` at call time.
    const hangingBuildAgent = async () =>
      ({
        abortSignal: null as AbortSignal | null,
        run: function (this: { abortSignal: AbortSignal }) {
          return new Promise((_resolve: (v?: unknown) => void, reject: (e: Error) => void) => {
            if (this.abortSignal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            this.abortSignal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
        notifyCompletion: () => {},
      }) as any;

    it("aborts only RUNNING tasks owned by the session and returns the count", async () => {
      const manager = createManager({ buildAgent: hangingBuildAgent });

      await manager.spawnTask("t-a1", "work", { managerAgent: { sessionId: "sess-a" } });
      await manager.spawnTask("t-a2", "work", { managerAgent: { sessionId: "sess-a" } });
      await manager.spawnTask("t-b1", "work", { managerAgent: { sessionId: "sess-b" } });
      await manager.spawnTask("t-0", "work"); // no delegating session

      expect(manager.activeTasks()).toEqual(["t-a1", "t-a2", "t-b1", "t-0"]);
      expect(manager.interruptTasksForSession("sess-a")).toBe(2);

      await settle(() => manager.taskStatus("t-a1") === TASK_STATUS.CANCELLED, "t-a1 -> CANCELLED");
      await settle(() => manager.taskStatus("t-a2") === TASK_STATUS.CANCELLED, "t-a2 -> CANCELLED");
      // Other sessions' tasks and null-sessionId tasks are untouched.
      expect(manager.taskStatus("t-b1")).toBe(TASK_STATUS.RUNNING);
      expect(manager.taskStatus("t-0")).toBe(TASK_STATUS.RUNNING);

      // Clean up the survivors so no run promises stay pending.
      manager.interruptTask("t-b1");
      manager.interruptTask("t-0");
      await settle(() => manager.activeTasks().length === 0, "survivor cleanup");
    });

    it("returns 0 for unknown sessions and leaves non-running tasks alone", async () => {
      const manager = createManager({
        buildAgent: async () =>
          ({ run: async () => ({ type: "completion", content: "done" }), notifyCompletion: () => {} } as any),
      });
      await manager.spawnTask("t-a", "work", { managerAgent: { sessionId: "sess-a" } });
      await settle(() => manager.taskStatus("t-a") === TASK_STATUS.COMPLETED, "t-a -> COMPLETED");

      expect(manager.interruptTasksForSession("no-such-session")).toBe(0);
      // The task is completed, so nothing for the cascade to abort.
      expect(manager.interruptTasksForSession("sess-a")).toBe(0);
    });
  });

  describe("task failure reporting", () => {
    // Capture logger.error output via the "log" hook (no mock.module).
    function captureLoggedErrors(): string[] {
      resetLoggerForTesting();
      const hooks = createHooks();
      const lines: string[] = [];
      hooks.on("log", (data) => {
        const ev = data as LogEvent;
        if (ev.level === "error") lines.push(ev.message);
      });
      initializeLogger({ hooks, minLevel: "error", target: "none" });
      return lines;
    }

    function managerWithRun(run: () => Promise<unknown>, onResult: (r: string) => void) {
      return createManager({
        buildAgent: async () =>
          ({ run, notifyCompletion: (r: string) => onResult(r) }) as any,
      });
    }

    it("logs unexpected failures with a stack; model gets the message only", async () => {
      const logged = captureLoggedErrors();
      try {
        let delivered = "";
        const manager = managerWithRun(
          async () => { throw new Error("null deref bug"); },
          (r) => { delivered = r; },
        );
        await manager.spawnTask("t-boom", "work");
        await settle(() => manager.taskStatus("t-boom") === TASK_STATUS.FAILED, "t-boom -> FAILED");

        // The delegating model's result is message-only -- no stack.
        expect(delivered).toBe("Task failed: null deref bug");
        const line = logged.find((m) => m.includes("t-boom"));
        expect(line).toBeDefined();
        expect(line).toContain("null deref bug");
        // formatError() appends the full stack for unexpected errors.
        expect(/\n\s+at\s/.test(line!)).toBe(true);
      } finally {
        resetLoggerForTesting();
      }
    });

    it("logs expected failures message-only (no stack)", async () => {
      const logged = captureLoggedErrors();
      try {
        let delivered = "";
        const manager = managerWithRun(
          async () => { throw LlmError.Api("HTTP 400 bad input", 400); },
          (r) => { delivered = r; },
        );
        await manager.spawnTask("t-api", "work");
        await settle(() => manager.taskStatus("t-api") === TASK_STATUS.FAILED, "t-api -> FAILED");

        expect(delivered).toBe("Task failed: HTTP 400 bad input");
        const line = logged.find((m) => m.includes("t-api"));
        expect(line).toBeDefined();
        expect(line).toContain("HTTP 400 bad input");
        expect(/\n\s+at\s/.test(line!)).toBe(false);
      } finally {
        resetLoggerForTesting();
      }
    });

    it("logs nothing for cancellations", async () => {
      const logged = captureLoggedErrors();
      try {
        let delivered = "";
        const manager = managerWithRun(
          async () => { throw LlmError.Cancelled("user cancelled"); },
          (r) => { delivered = r; },
        );
        await manager.spawnTask("t-cancel", "work");
        await settle(() => manager.taskStatus("t-cancel") === TASK_STATUS.CANCELLED, "t-cancel -> CANCELLED");

        expect(delivered).toBe("Task aborted");
        expect(logged.length).toBe(0);
      } finally {
        resetLoggerForTesting();
      }
    });
  });

  describe("deliverTaskCompletion", () => {
    it("enqueues result via the delegating session's bus without also adding to context", () => {
      const enqueued: any[] = [];
      const added: any[] = [];
      const manager = createManager();
      manager.setSessionManager({
        getAgent: () => ({
          addMessage(msg: any) { added.push(msg); },
        }) as any,
        getBus: () => ({ enqueue: (msg: any) => enqueued.push(msg) }) as any,
      } as any);

      manager.deliverTaskCompletion("task-1", "Result text", { sessionId: "sess-a" });

      // Exactly one injection: the bus path only. The bus run loop appends
      // the enqueued content to the manager's context via agent.run(), so a
      // direct addMessage() here as well would double it.
      expect(enqueued).toHaveLength(1);
      const enqueuedText = contentToText(enqueued[0]);
      expect(enqueuedText).toContain("Task task-1 completed");
      expect(enqueuedText).toContain("Result text");
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

      manager.deliverTaskCompletion("task-1", "Result text");

      expect(managerContext).toHaveLength(1);
      expect(managerContext[0].role).toBe("harness");
      // Trusted framing around the raw (unescaped) model result.
      expect(managerContext[0].content).toEqual(resultParts("task-1", "Result text"));
    });

    it("enqueues results with harness provenance (bus path)", () => {
      const enqueued: Array<{ content: any; source?: string }> = [];
      const manager = createManager();
      manager.setSessionManager({
        getAgent: () => null,
        getBus: () => ({
          enqueue: (content: any, opts?: { source?: string }) =>
            enqueued.push({ content, source: opts?.source }),
        }),
      } as any);

      manager.deliverTaskCompletion("task-1", "Result text", { sessionId: "sess-a" });

      expect(enqueued).toHaveLength(1);
      // Harness structure: trusted framing + raw result in an untrusted
      // part (stored raw on disk, mangled only at the wire).
      expect(enqueued[0]!.content).toEqual(resultParts("task-1", "Result text"));
      expect(enqueued[0]!.source).toBe("harness");
    });

    it("tags the no-bus fallback message with harness provenance", () => {
      const added: any[] = [];
      const manager = createManager();
      manager.setSessionManager({
        getAgent: () => ({ addMessage(msg: any) { added.push(msg); } }) as any,
      });

      manager.deliverTaskCompletion("task-1", "Result text");

      expect(added).toHaveLength(1);
      expect(added[0].role).toBe("harness");
      expect(added[0].source).toBe("harness");
      expect(added[0].content).toEqual(resultParts("task-1", "Result text"));
    });

    it("handles missing session manager and bus gracefully", () => {
      const manager = createManager();
      expect(() => manager.deliverTaskCompletion("task-1", "result")).not.toThrow();
    });

    it("routes result to the spawning agent's session bus", () => {
      const enqueued: Record<string, Array<Array<Record<string, unknown>>>> = {
        "sess-a": [],
        "sess-b": [],
      };
      const manager = createManager();
      manager.setSessionManager({
        getAgent: () => null,
        getBus: (sessionId: string) =>
          sessionId in enqueued
            ? { enqueue: (m: any) => enqueued[sessionId]!.push(m) }
            : undefined,
      } as any);

      manager.deliverTaskCompletion("task-1", "Result text", { sessionId: "sess-a" });

      expect(enqueued["sess-a"]).toHaveLength(1);
      const routed = contentToText(enqueued["sess-a"]![0]);
      expect(routed).toContain("Task task-1 completed");
      expect(routed).toContain("Result text");
      expect(enqueued["sess-b"]).toHaveLength(0);
    });

    it("drops the result when the delivery session has no bus (deleted session / non-session delegator)", () => {
      const added: unknown[] = [];
      const manager = createManager();
      manager.setSessionManager({
        getAgent: () => ({ addMessage(msg: any) { added.push(msg); } }) as any,
        getBus: () => undefined, // e.g. a deleted session or a task agent with no session entry
      } as any);

      manager.deliverTaskCompletion("task-1", "Result text", { sessionId: "no-such-session" });

      // Misdelivery to an unrelated session is worse than dropping the result.
      expect(added).toHaveLength(0);
    });

    it("appends directly when the session manager exposes no getBus", () => {
      const added: unknown[] = [];
      const manager = createManager();
      manager.setSessionManager({
        getAgent: () => ({ addMessage(msg: any) { added.push(msg); } }) as any,
      } as any);

      manager.deliverTaskCompletion("task-1", "Result text", { sessionId: "sess-a" });

      expect(added).toHaveLength(1);
    });

    it("spawnTask delivers completion to the managerAgent's session bus", async () => {
      const enqueued: Record<string, Array<Array<Record<string, unknown>>>> = {
        "sess-a": [],
        "sess-b": [],
      };
      // Mirrors the real Agent: notifyCompletion() delegates to sink.onTaskComplete.
      let sink: any;
      const buildAgent = async (config: any) => {
        sink = config.sink;
        return {
          run: async () => ({ type: "completion", content: "task done" }),
          notifyCompletion: (result: string) => sink?.onTaskComplete?.(result),
        };
      };

      const manager = new TaskManager({
        buildAgent: buildAgent as any,
        modelRegistry: { default: "test-model" } as any,
        config: { profilesPath: "./config/profiles" } as any,
        maxIterations: 100,
        taskProfile: "default",
      });
      manager.setSessionManager({
        getAgent: () => null,
        getBus: (sessionId: string) =>
          sessionId in enqueued
            ? { enqueue: (m: any) => enqueued[sessionId]!.push(m) }
            : undefined,
      } as any);

      await manager.spawnTask("task-1", "Do it", { managerAgent: { sessionId: "sess-a" } });
      // runTask is fire-and-forget; give it a tick to settle.
      await new Promise((r) => setTimeout(r, 10));

      expect(enqueued["sess-a"]).toHaveLength(1);
      const delivered = contentToText(enqueued["sess-a"]![0]);
      expect(delivered).toContain("Task task-1 completed");
      expect(delivered).toContain("task done");
      expect(enqueued["sess-b"]).toHaveLength(0);
    });
  });
});

describe("task registry release", () => {
  function makeManager(buildAgent: (config: Record<string, unknown>) => Promise<any>) {
    return new TaskManager({
      buildAgent: buildAgent as any,
      modelRegistry: { default: "test-model" } as any,
      config: { profilesPath: "./config/profiles" } as any,
      maxIterations: 100,
      taskProfile: "default",
    });
  }

  it("releases the agent reference when a task completes", async () => {
    const manager = makeManager(async () => ({
      run: async () => ({ type: "completion", content: "done" }),
      notifyCompletion: () => {},
    }));
    await manager.spawnTask("task-1", "Do it");
    await settle(() => manager.taskStatus("task-1") === TASK_STATUS.COMPLETED, "completion");
    // The slim entry survives (status stays queryable) but the Agent -- and
    // with it the task's full message context -- is no longer pinned.
    expect(manager._test_tasks.get("task-1")!.agent).toBeNull();
    expect(manager.taskStatus("task-1")).toBe(TASK_STATUS.COMPLETED);
    expect(manager.sendFollowUp("task-1", "late message")).toBe(false);
  });

  it("fires session:end through the finished agent's own hooks", async () => {
    const ended: Array<{ hook: string; sessionId: string }> = [];
    const agent = {
      sessionId: "task-agent-9",
      hooks: {
        notifyHooks: (hook: string, data: { sessionId: string }) => {
          ended.push({ hook, sessionId: data.sessionId });
          return Promise.resolve();
        },
      },
      run: async () => ({ type: "completion", content: "done" }),
      notifyCompletion: () => {},
    };
    const manager = makeManager(async () => agent);
    await manager.spawnTask("task-1", "Do it");
    await settle(() => ended.length > 0, "session:end");
    expect(ended).toEqual([{ hook: "session:end", sessionId: "task-agent-9" }]);
  });

  it("interrupt during the build window still fires session:end on the discarded agent", async () => {
    const ended: Array<{ hook: string; sessionId: string }> = [];
    let runs = 0;
    let finishBuild!: () => void;
    const built = new Promise<void>((resolve) => (finishBuild = resolve));
    const manager = makeManager(async () => {
      await built; // hold the build open while the task is interrupted
      return {
        sessionId: "task-agent-11",
        hooks: {
          notifyHooks: (hook: string, data: { sessionId: string }) => {
            ended.push({ hook, sessionId: data.sessionId });
            return Promise.resolve();
          },
        },
        run: async () => {
          runs++;
          return { type: "completion", content: "never" };
        },
        notifyCompletion: () => {},
      };
    });
    const handle = await manager.spawnTask("task-1", "Do it");
    expect(manager.taskStatus("task-1")).toBe(TASK_STATUS.RUNNING); // started, still building
    expect(manager.interruptTask("task-1")).toBe(true); // aborts the never-run agent
    finishBuild();
    const completion = await handle.done;
    expect(completion.status).toBe(TASK_STATUS.CANCELLED);
    expect(runs).toBe(0); // the turn never ran
    expect(ended).toEqual([{ hook: "session:end", sessionId: "task-agent-11" }]);
  });

  it("releases the agent reference when a task fails", async () => {
    const manager = makeManager(async () => ({
      run: async () => {
        throw new Error("boom");
      },
      notifyCompletion: () => {},
    }));
    await manager.spawnTask("task-1", "Do it");
    await settle(() => manager.taskStatus("task-1") === TASK_STATUS.FAILED, "failure");
    expect(manager._test_tasks.get("task-1")!.agent).toBeNull();
  });

  it("releases the agent reference when a task is interrupted", async () => {
    const manager = makeManager(async () => {
      const agent: any = { notifyCompletion: () => {} };
      agent.run = () =>
        new Promise((_resolve, reject) => {
          // TaskManager assigns agent.abortSignal before invoking run().
          agent.abortSignal.addEventListener("abort", () =>
            reject(LlmError.Cancelled("aborted")),
          );
        });
      return agent;
    });
    const handle = await manager.spawnTask("task-1", "Do it");
    handle.interrupt();
    await settle(() => manager.taskStatus("task-1") === TASK_STATUS.CANCELLED, "cancellation");
    expect(manager._test_tasks.get("task-1")!.agent).toBeNull();
  });

  it("keeps a running task's agent until it settles", async () => {
    let release!: () => void;
    const manager = makeManager(async () => ({
      run: () => new Promise<void>((resolve) => { release = resolve; }),
      notifyCompletion: () => {},
    }));
    await manager.spawnTask("task-1", "Do it");
    // Yield a tick so #runTask enters agent.run, then check liveness.
    await new Promise((r) => setTimeout(r, 5));
    expect(manager._test_tasks.get("task-1")!.agent).not.toBeNull();
    release();
    await settle(() => manager.taskStatus("task-1") === TASK_STATUS.COMPLETED, "completion");
    expect(manager._test_tasks.get("task-1")!.agent).toBeNull();
  });
});

describe("provider lanes (capacity lite)", () => {
  // Poll until a condition holds (fails loudly on timeout).
  async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  function makeLanedManager(
    opts: { lanes?: number; failBuild?: () => boolean; providers?: Array<Record<string, unknown>> } = {},
  ) {
    const runs: Array<{ model: string; release: () => void }> = [];
    let builds = 0;
    const manager = new TaskManager({
      buildAgent: async (cfg) => {
        builds++;
        if (opts.failBuild?.()) throw new Error("boom");
        let release!: () => void;
        runs.push({
          model: String((cfg as Record<string, unknown>).model ?? ""),
          release: () => release(),
        });
        return {
          run: () => new Promise<void>((resolve) => { release = resolve; }),
          notifyCompletion: () => {},
        } as never;
      },
      modelRegistry: {} as never,
      config: { providers: opts.providers ?? [] } as never,
      maxIterations: 100,
      taskProfile: "default",
      lanesPerProvider: opts.lanes,
    });
    return { manager, runs, buildCount: () => builds };
  }

  const spawn = (m: TaskManager, id: string, model: string, extra = {}) =>
    m.spawnTask(id, "do it", { workerModel: model, ...extra } as never);

  it("cap 1: second same-provider task queues and starts on release", async () => {
    const { manager, runs, buildCount } = makeLanedManager({ lanes: 1 });
    await spawn(manager, "t1", "p1/m");
    await settle(() => manager.taskStatus("t1") === TASK_STATUS.RUNNING && runs.length === 1, "t1 running");

    await spawn(manager, "t2", "p1/m");
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.QUEUED);
    expect(buildCount()).toBe(1); // queued tasks do not even build

    runs[0]!.release();
    await settle(() => manager.taskStatus("t1") === TASK_STATUS.COMPLETED, "t1 done");
    await settle(() => manager.taskStatus("t2") === TASK_STATUS.RUNNING, "t2 admitted");
  });

  it("cap 1: different providers run concurrently", async () => {
    const { manager, runs } = makeLanedManager({ lanes: 1 });
    await spawn(manager, "t1", "p1/m");
    await spawn(manager, "t2", "p2/m");
    await settle(() => runs.length === 2, "both started");
    expect(manager.taskStatus("t1")).toBe(TASK_STATUS.RUNNING);
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.RUNNING);
    runs.forEach((r) => r.release());
  });

  it("cap 2: third task queues behind two", async () => {
    const { manager, runs } = makeLanedManager({ lanes: 2 });
    await spawn(manager, "t1", "p1/m");
    await spawn(manager, "t2", "p1/m");
    await spawn(manager, "t3", "p1/m");
    await settle(() => runs.length === 2, "two running");
    expect(manager.taskStatus("t3")).toBe(TASK_STATUS.QUEUED);
    runs[0]!.release();
    await settle(() => manager.taskStatus("t3") === TASK_STATUS.RUNNING, "t3 admitted");
    runs[1]!.release();
  });

  it("provider taskLanes raises that lane only; others keep the global cap", async () => {
    const { manager, runs } = makeLanedManager({
      lanes: 1,
      providers: [{ name: "p1", taskLanes: 2 }],
    });
    await spawn(manager, "t1", "p1/a");
    await spawn(manager, "t2", "p1/b");
    await settle(() => runs.length === 2, "p1 runs two");
    await spawn(manager, "t3", "p1/c");
    expect(manager.taskStatus("t3")).toBe(TASK_STATUS.QUEUED);
    await spawn(manager, "t4", "p2/a");
    await settle(() => manager.taskStatus("t4") === TASK_STATUS.RUNNING, "p2 runs its own");
    await spawn(manager, "t5", "p2/b");
    expect(manager.taskStatus("t5")).toBe(TASK_STATUS.QUEUED); // p2 stays cap 1
    runs.forEach((r) => r.release());
  });

  it("provider taskLanes caps a lane while the global is unlimited", async () => {
    const { manager, runs } = makeLanedManager({
      providers: [{ name: "p1", taskLanes: 1 }],
    });
    await spawn(manager, "t1", "p1/a");
    await spawn(manager, "t2", "p1/b");
    await settle(() => runs.length === 1, "t1 running");
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.QUEUED);
    runs[0]!.release();
    await settle(() => manager.taskStatus("t2") === TASK_STATUS.RUNNING, "t2 admitted");
  });

  it("provider taskLanes below 1 means unlimited on that lane", async () => {
    const { manager, runs } = makeLanedManager({
      lanes: 1,
      providers: [{ name: "p1", taskLanes: 0 }],
    });
    await spawn(manager, "t1", "p1/a");
    await spawn(manager, "t2", "p1/b");
    await spawn(manager, "t3", "p1/c");
    await settle(() => runs.length === 3, "all three run");
    runs.forEach((r) => r.release());
  });

  it("bare model names ignore provider taskLanes (no def for the shared lane)", async () => {
    const { manager, runs } = makeLanedManager({
      lanes: 1,
      providers: [{ name: "p1", taskLanes: 5 }],
    });
    await spawn(manager, "t1", "model-x");
    await spawn(manager, "t2", "model-x");
    await settle(() => manager.taskStatus("t1") === TASK_STATUS.RUNNING, "t1 running");
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.QUEUED);
    runs[0]!.release();
  });

  it("no cap configured: unlimited regardless of provider", async () => {
    const { manager, runs } = makeLanedManager();
    for (let i = 0; i < 3; i++) await spawn(manager, `t${i}`, "p1/m");
    await settle(() => runs.length === 3, "all started");
    runs.forEach((r) => r.release());
  });

  it("bare model names share one conservative lane", async () => {
    const { manager, runs } = makeLanedManager({ lanes: 1 });
    await spawn(manager, "t1", "model-a");
    await spawn(manager, "t2", "model-b");
    await settle(() => runs.length === 1, "t1 running");
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.QUEUED);
    runs[0]!.release();
  });

  it("interrupting a queued task cancels it; it never starts", async () => {
    const { manager, runs, buildCount } = makeLanedManager({ lanes: 1 });
    await spawn(manager, "t1", "p1/m");
    await settle(() => runs.length === 1, "t1 running");
    const h2 = await spawn(manager, "t2", "p1/m");
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.QUEUED);

    expect(h2.interrupt()).toBe(true);
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.CANCELLED);

    runs[0]!.release();
    await settle(() => manager.taskStatus("t1") === TASK_STATUS.COMPLETED, "t1 done");
    await new Promise((r) => setTimeout(r, 10));
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.CANCELLED);
    expect(buildCount()).toBe(1);
  });

  it("interruptTask and interruptTasksForSession also cancel queued", async () => {
    const { manager, runs } = makeLanedManager({ lanes: 1 });
    await spawn(manager, "t1", "p1/m", { managerAgent: { sessionId: "s1" } });
    await settle(() => runs.length === 1, "t1 running");
    await spawn(manager, "t2", "p1/m", { managerAgent: { sessionId: "s1" } });
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.QUEUED);

    expect(manager.interruptTasksForSession("s1")).toBe(2);
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.CANCELLED);
    runs[0]!.release();
  });

  it("sendFollowUp on a queued task returns false", async () => {
    const { manager, runs } = makeLanedManager({ lanes: 1 });
    await spawn(manager, "t1", "p1/m");
    await settle(() => runs.length === 1, "t1 running");
    await spawn(manager, "t2", "p1/m");
    expect(manager.sendFollowUp("t2", "hello?")).toBe(false);
    runs[0]!.release();
  });

  it("progressMessage reports running and queued", async () => {
    const { manager, runs } = makeLanedManager({ lanes: 1 });
    await spawn(manager, "t1", "p1/m");
    await settle(() => runs.length === 1, "t1 running");
    await spawn(manager, "t2", "p1/m");
    expect(manager.progressMessage()).toBe("1 task running, 1 queued");
    runs[0]!.release();
  });

  it("build failure becomes a failed task, not a spawnTask rejection", async () => {
    let boom = true;
    const { manager } = makeLanedManager({ failBuild: () => boom });
    const handle = await spawn(manager, "t1", "p1/m");
    expect(handle.taskId).toBe("t1"); // resolved, did not throw
    await settle(() => manager.taskStatus("t1") === TASK_STATUS.FAILED, "failed status");
    boom = false;
  });

  it("a throwing consumer onTurn becomes a failed task, not an unhandled rejection", async () => {
    // The fire-and-forget #launch must swallow residual consumer faults:
    // an unhandled rejection would kill the process (there is no global
    // handler), and a dangled entry would hang `done` and pin its lane.
    const { manager, runs } = makeLanedManager();
    const handle = await spawn(manager, "t1", "p1/m", {
      onTurn: () => {
        throw new Error("consumer boom");
      },
    });
    runs[0]!.release();
    const completion = await handle.done;
    expect(completion.status).toBe("failed");
    expect(manager.taskStatus("t1")).toBe(TASK_STATUS.FAILED);
  });
});

describe("pinned spawn (resolver integration)", () => {
  async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  const cfgEntry = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    temperature: null,
    contextLimit: 131072,
    tags: [],
    ...over,
  });

  function makeResolvedManager(over: Record<string, unknown> = {}) {
    const built: Array<Record<string, unknown>> = [];
    const manager = new TaskManager({
      buildAgent: async (cfg) => {
        built.push(cfg);
        // Run hangs forever; tests interrupt tasks explicitly.
        return {
          run: () => new Promise<void>(() => {}),
          notifyCompletion: () => {},
        } as never;
      },
      modelRegistry: {
        "p1/heavy": cfgEntry("p1/heavy", { contextLimit: 262144, maxToolDifficulty: 4, capabilities: { toolCalling: true } }),
        "p1/light": cfgEntry("p1/light"),
        "p2/mid": cfgEntry("p2/mid", { contextLimit: 262144, maxToolDifficulty: 3 }),
      } as never,
      config: {} as never,
      maxIterations: 100,
      taskProfile: "default",
      runningPeek: async (provider: string) =>
        provider === "p2" ? new Set(["mid"]) : new Set<string>(),
      ...over,
    });
    return { manager, built };
  }

  it("pin locks the resolved registry key into the agent config", async () => {
    const { manager, built } = makeResolvedManager();
    await manager.spawnTask("t1", "do it", { pin: { model: "mid", provider: "p2" } } as never);
    expect(built[0]!.model).toBe("p2/mid");
    expect(manager.taskLane("t1")).toEqual({ model: "p2/mid", provider: "p2" });
    manager.interruptTask("t1");
  });

  it("invalid pin rejects spawnTask before the task is registered", async () => {
    const { manager, built } = makeResolvedManager();
    await expect(manager.spawnTask("t1", "do it", { pin: { model: "ghost" } } as never)).rejects
      .toThrow(/not in the model catalog/);
    expect(built).toHaveLength(0);
    expect(manager.taskStatus("t1")).toBeNull();
  });

  it("requirements prefer the loaded model via the injected peek", async () => {
    const { manager, built } = makeResolvedManager();
    // p1/heavy has higher difficulty, but p2 has "mid" loaded. A
    // requirements spawn is a multi-candidate plan: placement (warm peek ->
    // start) completes asynchronously after spawnTask returns.
    await manager.spawnTask("t1", "do it", { requires: { ctx: 200000 } } as never);
    await settle(() => built.length > 0, "t1 placed & built");
    expect(built[0]!.model).toBe("p2/mid");
    manager.interruptTask("t1");
  });

  it("unsatisfiable requirements reject spawnTask", async () => {
    const { manager } = makeResolvedManager();
    await expect(
      manager.spawnTask("t1", "do it", { requires: { vision: true } } as never),
    ).rejects.toThrow(/no catalog model satisfies/);
    expect(manager.taskStatus("t1")).toBeNull();
  });

  it("interrupting a planning reservation cancels without launching", async () => {
    // Gate the peek so the plan is observably still awaiting while the id is
    // already reserved (the spawnTask planning window, C-M2).
    let peekGate!: () => void;
    const gate = new Promise<void>((r) => (peekGate = r));
    const { manager, built } = makeResolvedManager({
      runningPeek: async () => {
        await gate;
        return new Set<string>();
      },
    });
    const spawned = manager.spawnTask("slow", "x", { requires: { ctx: 200000 } } as never);
    // Registered synchronously as a QUEUED reservation; #admit must skip it.
    expect(manager.taskStatus("slow")).toBe(TASK_STATUS.QUEUED);
    expect(built).toHaveLength(0);
    expect(manager.interruptTask("slow")).toBe(true);
    expect(manager.taskStatus("slow")).toBe(TASK_STATUS.CANCELLED);
    peekGate();
    const handle = await spawned;
    expect(handle.status).toBe(TASK_STATUS.CANCELLED);
    expect((await handle.done).status).toBe(TASK_STATUS.CANCELLED);
    // The continuation saw the terminal state: nothing was ever built.
    expect(built).toHaveLength(0);
  });

  it("legacy workerModel path bypasses the resolver (unvalidated)", async () => {
    const { manager, built } = makeResolvedManager();
    await manager.spawnTask("t1", "do it", { workerModel: "whatever/not-here" } as never);
    expect(built[0]!.model).toBe("whatever/not-here");
    manager.interruptTask("t1");
  });

  it("queued tasks hold their admitted lane", async () => {
    const { manager, built } = makeResolvedManager({ lanesPerProvider: 1 });
    await manager.spawnTask("t1", "a", { pin: { model: "p1/heavy" } } as never);
    await settle(() => built.length === 1, "t1 built");
    await manager.spawnTask("t2", "b", { pin: { model: "p1/light" } } as never);
    expect(manager.taskStatus("t2")).toBe("queued");
    expect(manager.taskLane("t2")).toEqual({ model: "p1/light", provider: "p1" });
    manager.interruptTask("t1");
    manager.interruptTask("t2");
  });
});

describe("parked tasks & completion promise (workflow engine seam)", () => {
  // Fake agent whose turns are scripted; records every prompt it receives.
  function makeTurnAgent(turns: Array<() => Promise<unknown>>) {
    const prompts: string[] = [];
    const turnResults: unknown[] = [];
    let i = 0;
    let notifyCompletion: ((r: string) => void) | undefined;
    const agent = {
      run: async (prompt: string) => {
        prompts.push(prompt);
        const next = turns[Math.min(i, turns.length - 1)]!;
        i++;
        const r = await next();
        turnResults.push(r);
        return r;
      },
      notifyCompletion: (r: string) => notifyCompletion?.(r),
    };
    return {
      agent,
      prompts,
      setNotify: (fn: (r: string) => void) => {
        notifyCompletion = fn;
      },
    };
  }

  function parkedOnTurn(): { onTurn: (t: unknown) => void; results: unknown[]; next: () => Promise<unknown> } {
    const results: unknown[] = [];
    const waiters: Array<(t: unknown) => void> = [];
    return {
      onTurn: (t: unknown) => {
        results.push(t);
        waiters.shift()?.(t);
      },
      results,
      next: () =>
        results.length > 0
          ? Promise.resolve(results[results.length - 1])
          : new Promise((resolve) => waiters.push(resolve)),
    };
  }

  it("done resolves with final status and result (non-parked)", async () => {
    const manager = new TaskManager({
      buildAgent: async () => makeTurnAgent([async () => ({ type: "completion", content: "all done" })]).agent as any,
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
    });
    const handle = await manager.spawnTask("t1", "work");
    expect(await handle.done).toEqual({ status: TASK_STATUS.COMPLETED, result: "all done" });
  });

  it("interruptTask settles done for queued and running tasks", async () => {
    const manager = new TaskManager({
      buildAgent: async () => {
        const agent: any = { notifyCompletion: () => {} };
        agent.run = () =>
          new Promise((_resolve, reject) => {
            agent.abortSignal.addEventListener("abort", () => reject(LlmError.Cancelled("aborted")));
          });
        return agent;
      },
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
      lanesPerProvider: 1,
    });
    const h1 = await manager.spawnTask("t1", "work", { workerModel: "p/m" });
    const h2 = await manager.spawnTask("t2", "work", { workerModel: "p/m" });
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.QUEUED);

    manager.interruptTask("t2");
    expect(await h2.done).toEqual({ status: TASK_STATUS.CANCELLED, result: "Task aborted" });

    h1.interrupt(); // handle interrupt routes through the same settle path
    expect((await h1.done).status).toBe(TASK_STATUS.CANCELLED);
  });

  it("build failure settles done as FAILED", async () => {
    const manager = new TaskManager({
      buildAgent: async () => {
        throw new Error("no profile");
      },
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
    });
    const handle = await manager.spawnTask("t1", "work");
    const completion = await handle.done;
    expect(completion.status).toBe(TASK_STATUS.FAILED);
    expect(completion.result).toContain("no profile");
  });

  it("build failure fires onTurn failed for a parked task (engine gate cannot hang)", async () => {
    const gate = parkedOnTurn();
    const manager = new TaskManager({
      buildAgent: async () => {
        throw new Error("no profile");
      },
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
    });
    const handle = await manager.spawnTask("t1", "work", { park: true, onTurn: gate.onTurn });
    const completion = await handle.done;
    expect(completion.status).toBe(TASK_STATUS.FAILED);
    expect(gate.results).toEqual([{ status: "failed", result: expect.stringContaining("no profile") }]);
  });

  it("interrupting a parked QUEUED task fires onTurn cancelled", async () => {
    const gate = parkedOnTurn();
    let releaseT1!: () => void;
    let builds = 0;
    const manager = new TaskManager({
      buildAgent: async () => {
        builds++;
        if (builds === 1) {
          return {
            run: () =>
              new Promise((resolve) => {
                releaseT1 = () => resolve({ type: "completion", content: "t1 done" });
              }),
            notifyCompletion: () => {},
          } as any;
        }
        return makeTurnAgent([async () => ({ type: "completion", content: "never runs" })]).agent as any;
      },
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
      lanesPerProvider: 1,
    });
    await manager.spawnTask("t1", "work", { workerModel: "p/m" });
    const h2 = await manager.spawnTask("t2", "work", {
      workerModel: "p/m",
      park: true,
      onTurn: gate.onTurn,
    });
    expect(manager.taskStatus("t2")).toBe(TASK_STATUS.QUEUED);

    expect(manager.interruptTask("t2")).toBe(true);
    expect(await h2.done).toEqual({ status: TASK_STATUS.CANCELLED, result: "Task aborted" });
    expect(gate.results).toEqual([{ status: "cancelled", result: "Task aborted" }]);
    releaseT1();
  });

  it("interrupting a parked-idle task delivers exactly one synthesized cancelled onTurn", async () => {
    const gate = parkedOnTurn();
    const manager = new TaskManager({
      buildAgent: async () =>
        makeTurnAgent([async () => ({ type: "completion", content: "out" })]).agent as any,
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
    });
    const handle = await manager.spawnTask("t1", "work", { park: true, onTurn: gate.onTurn });
    await gate.next(); // first (completed) turn delivered; now parked-idle
    expect(gate.results).toHaveLength(1);

    manager.interruptTask("t1");
    expect((await handle.done).status).toBe(TASK_STATUS.CANCELLED);
    expect(gate.results).toHaveLength(2);
    expect(gate.results[1]).toEqual({ status: "cancelled", result: "Task aborted" });
  });

  it("parked idle yields its lane; completeTask still finalizes, warm turn re-acquires", async () => {
    const gate = parkedOnTurn();
    let releaseT2!: () => void;
    let builds = 0;
    const manager = new TaskManager({
      buildAgent: async () => {
        builds++;
        if (builds === 1) {
          return makeTurnAgent([
            async () => ({ type: "completion", content: "out1" }),
            async () => ({ type: "completion", content: "warm" }),
          ]).agent as any;
        }
        return {
          run: () =>
            new Promise((resolve) => {
              releaseT2 = () => resolve({ type: "completion", content: "t2 done" });
            }),
          notifyCompletion: () => {},
        } as any;
      },
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
      lanesPerProvider: 1,
    });
    const h1 = await manager.spawnTask("t1", "work", { workerModel: "p/m", park: true, onTurn: gate.onTurn });
    await gate.next();
    expect(manager.taskStatus("t1")).toBe(TASK_STATUS.RUNNING); // parked, not completed

    // An idle parked session generates no model traffic: the lane is yielded.
    const h2 = await manager.spawnTask("t2", "work", { workerModel: "p/m" });
    await settle(() => manager.taskStatus("t2") === TASK_STATUS.RUNNING, "t2 admits behind parked-idle t1");

    // A warm turn on the parked task queues behind the now-running t2.
    const warmP = manager.taskTurn("t1", "retry critique");
    await new Promise((r) => setTimeout(r, 10));
    const entry = manager._test_tasks.get("t1") as unknown as { turnPending: boolean };
    expect(entry.turnPending).toBe(true);

    releaseT2();
    expect((await h2.done).status).toBe(TASK_STATUS.COMPLETED);
    expect(await warmP).toEqual({ status: "completed", result: "warm" });
    expect(manager.taskStatus("t1")).toBe(TASK_STATUS.RUNNING); // parked again after warm turn
    expect(manager.completeTask("t1")).toBe(true);
    expect((await h1.done).status).toBe(TASK_STATUS.COMPLETED);
    h2.interrupt();
  });

  it("two warm waiters on one cap-1 lane are granted FIFO, never mutually stuck", async () => {
    // Regression: #admit counted other pending waiters as lane occupancy, so
    // each waiter saw the next one as the blocker and neither was ever
    // granted once the running task finished -- both warm retries hung and
    // any workflow relying on them deadlocked until cancel.
    let builds = 0;
    let releaseT2!: () => void;
    const turnResults: string[] = []; // onTurn fires synchronously at turn end: proves order
    const wrapTurn = (id: string, gate: ReturnType<typeof parkedOnTurn>) => (t: unknown) => {
      turnResults.push(`${id}:${(t as { result?: string }).result ?? "?"}`);
      gate.onTurn(t);
    };
    const manager = new TaskManager({
      buildAgent: async () => {
        builds++;
        if (builds <= 2) {
          const n = builds;
          return makeTurnAgent([
            async () => ({ type: "completion", content: `out${n}` }),
            async () => ({ type: "completion", content: `warm${n}` }),
          ]).agent as any;
        }
        return {
          run: () =>
            new Promise((resolve) => {
              releaseT2 = () => resolve({ type: "completion", content: "t2 done" });
            }),
          notifyCompletion: () => {},
        } as any;
      },
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
      lanesPerProvider: 1,
    });

    const g1 = parkedOnTurn();
    const h1 = await manager.spawnTask("t1", "work", {
      workerModel: "p/m",
      park: true,
      onTurn: wrapTurn("t1", g1),
    });
    await g1.next(); // parked-idle, lane yielded
    const g4 = parkedOnTurn();
    const h4 = await manager.spawnTask("t4", "work", {
      workerModel: "p/m",
      park: true,
      onTurn: wrapTurn("t4", g4),
    });
    await g4.next(); // parked-idle too

    const h2 = await manager.spawnTask("t2", "work", { workerModel: "p/m" });
    await settle(() => manager.taskStatus("t2") === TASK_STATUS.RUNNING, "t2 admits");

    let warmSettled = 0;
    const warm1 = manager.taskTurn("t1", "retry").then((t) => {
      warmSettled++;
      return t;
    });
    await new Promise((r) => setTimeout(r, 10));
    const warm4 = manager.taskTurn("t4", "retry").then((t) => {
      warmSettled++;
      return t;
    });
    await new Promise((r) => setTimeout(r, 10));
    const e1 = manager._test_tasks.get("t1") as unknown as { turnPending: boolean };
    const e4 = manager._test_tasks.get("t4") as unknown as { turnPending: boolean };
    expect(e1.turnPending).toBe(true);
    expect(e4.turnPending).toBe(true);

    releaseT2();
    expect((await h2.done).status).toBe(TASK_STATUS.COMPLETED);

    // The admit scan at t2's terminal transition faces two pending waiters:
    // both must run (no mutual deadlock), one at a time, insertion order.
    await settle(() => warmSettled === 2, "both warm turns granted and completed");
    expect(turnResults).toEqual(["t1:out1", "t4:out2", "t1:warm1", "t4:warm2"]);
    expect((await warm1).status).toBe("completed");
    expect((await warm4).status).toBe("completed");

    manager.completeTask("t1");
    manager.completeTask("t4");
    await h1.done;
    await h4.done;
  });

  it("taskTurn runs a warm follow-up on the same session", async () => {
    const scripted = makeTurnAgent([
      async () => ({ type: "completion", content: "v1" }),
      async () => ({ type: "completion", content: "v2" }),
    ]);
    const gate = parkedOnTurn();
    const manager = new TaskManager({
      buildAgent: async () => scripted.agent as any,
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
    });
    await manager.spawnTask("t1", "first prompt", { park: true, onTurn: gate.onTurn });
    await gate.next();

    const turn = await manager.taskTurn("t1", "retry critique");
    expect(turn).toEqual({ status: "completed", result: "v2" });
    expect(scripted.prompts).toEqual(["first prompt", "retry critique"]);
    expect(manager.taskStatus("t1")).toBe(TASK_STATUS.RUNNING); // still parked after turn 2
    expect(manager.completeTask("t1")).toBe(true);
  });

  it("interruptTask terminates a parked-idle task and settles done", async () => {
    const gate = parkedOnTurn();
    let builds = 0;
    const manager = new TaskManager({
      buildAgent: async () => {
        builds++;
        if (builds === 1) return makeTurnAgent([async () => ({ type: "completion", content: "out" })]).agent as any;
        const agent: any = { notifyCompletion: () => {} };
        agent.run = () =>
          new Promise((_resolve, reject) => {
            (agent.abortSignal as AbortSignal).addEventListener("abort", () =>
              reject(LlmError.Cancelled("aborted")),
            );
          });
        return agent;
      },
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
      lanesPerProvider: 1,
    });
    const h1 = await manager.spawnTask("t1", "work", { workerModel: "p/m", park: true, onTurn: gate.onTurn });
    await gate.next();

    manager.interruptTask("t1");
    expect((await h1.done).status).toBe(TASK_STATUS.CANCELLED);

    // The second task runs on the yielded lane; cancelling it settles done too.
    const h2 = await manager.spawnTask("t2", "work", { workerModel: "p/m" });
    await settle(() => manager.taskStatus("t2") === TASK_STATUS.RUNNING, "t2 running");
    manager.interruptTask("t2");
    expect((await h2.done).status).toBe(TASK_STATUS.CANCELLED);
  });

  it("completeTask during an in-flight turn releases after the turn ends", async () => {
    let release!: () => void;
    const gate = parkedOnTurn();
    const manager = new TaskManager({
      buildAgent: async () =>
        ({
          run: () => new Promise((resolve) => { release = () => resolve({ type: "completion", content: "late" }); }),
          notifyCompletion: () => {},
        }) as any,
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
    });
    const handle = await manager.spawnTask("t1", "work", { park: true, onTurn: gate.onTurn });
    await settle(() => manager._test_tasks.get("t1")!.agent !== null, "agent build");
    expect(manager.completeTask("t1")).toBe(true);
    // Still running: the in-flight turn gets its chance to finish first.
    expect(manager.taskStatus("t1")).toBe(TASK_STATUS.RUNNING);
    release();
    expect((await handle.done).status).toBe(TASK_STATUS.COMPLETED);
    expect(gate.results).toHaveLength(1);
  });

  it("a failing turn ends a parked task as FAILED and fires onTurn", async () => {
    const gate = parkedOnTurn();
    const manager = new TaskManager({
      buildAgent: async () =>
        ({
          run: async () => {
            throw new Error("agent exploded");
          },
          notifyCompletion: () => {},
        }) as any,
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
    });
    const handle = await manager.spawnTask("t1", "work", { park: true, onTurn: gate.onTurn });
    const completion = await handle.done;
    expect(completion.status).toBe(TASK_STATUS.FAILED);
    expect(gate.results).toEqual([{ status: "failed", result: "Task failed: agent exploded" }]);
  });

  it("taskTurn throws for unparked, terminal or busy tasks", async () => {
    let release!: () => void;
    const manager = new TaskManager({
      buildAgent: async () =>
        ({
          run: () => new Promise((resolve) => { release = () => resolve({ type: "completion", content: "x" }); }),
          notifyCompletion: () => {},
        }) as any,
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
    });
    await expect(manager.taskTurn("nope", "hi")).rejects.toThrow("not ready");
    const handle = await manager.spawnTask("t1", "work"); // non-parked
    expect(manager.completeTask("t1")).toBe(false); // non-parked refuses completion too
    await settle(() => manager._test_tasks.get("t1")!.agent !== null, "agent build");
    // Busy mid-turn: parked would reject too; here the task is not parked.
    expect(manager.sendFollowUp("t1", "steer")).toBe(false); // no steer() on the fake
    release();
    await settle(() => manager.taskStatus("t1") === TASK_STATUS.COMPLETED, "completion");
    await expect(manager.taskTurn("t1", "hi")).rejects.toThrow("not ready");
    handle.interrupt();
  });

  it("park suppresses bus delivery of results", async () => {
    const added: unknown[] = [];
    const sessionManager = { getAgent: () => ({ addMessage: (m: unknown) => added.push(m) }) as any };
    const mk = () =>
      new TaskManager({
        // Mirrors the real Agent: notifyCompletion delegates to sink.onTaskComplete.
        buildAgent: async (cfg) => {
          const scripted = makeTurnAgent([async () => ({ type: "completion", content: "r" })]);
          scripted.setNotify((r) => (cfg.sink as { onTaskComplete: (r: string) => void }).onTaskComplete(r));
          return scripted.agent as any;
        },
        modelRegistry: {} as any,
        config: {} as any,
        maxIterations: 10,
        taskProfile: "default",
        sessionManager,
      });

    const plain = mk();
    await plain.spawnTask("t1", "work");
    await settle(() => plain.taskStatus("t1") === TASK_STATUS.COMPLETED, "plain completion");
    expect(added).toHaveLength(1); // existing behavior preserved

    const parkedMgr = mk();
    const gate = parkedOnTurn();
    const h = await parkedMgr.spawnTask("t1", "work", { park: true, onTurn: gate.onTurn });
    await gate.next();
    parkedMgr.completeTask("t1");
    await h.done;
    expect(added).toHaveLength(1); // nothing new delivered
  });

  it("sendFollowUp works mid-turn but not while parked-idle", async () => {
    let release!: () => void;
    const steered: string[] = [];
    const gate = parkedOnTurn();
    const manager = new TaskManager({
      buildAgent: async () =>
        ({
          run: () => new Promise((resolve) => { release = () => resolve({ type: "completion", content: "x" }); }),
          notifyCompletion: () => {},
          steer: (m: string) => steered.push(m),
        }) as any,
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
    });
    const handle = await manager.spawnTask("t1", "work", { park: true, onTurn: gate.onTurn });
    await settle(() => manager._test_tasks.get("t1")!.agent !== null && manager._test_tasks.has("t1"), "run start");
    // inRun becomes true in the same tick agent is assigned and run is entered
    await new Promise((r) => setTimeout(r, 2));
    expect(manager.sendFollowUp("t1", "mid-turn steer")).toBe(true);
    release();
    await gate.next();
    // parked-idle: no steering queue is draining; steer must not be accepted.
    expect(manager.sendFollowUp("t1", "stranded")).toBe(false);
    expect(steered).toEqual(["mid-turn steer"]);
    manager.completeTask("t1");
    await handle.done;
  });
});

describe("placement fanout (cross-provider)", () => {
  async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!fn()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  const cfgEntry = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    temperature: null,
    contextLimit: 131072,
    tags: [],
    ...over,
  });

  // Two nodes carry "qwen"; "other" is the spare member on a third. The
  // default model is the qualified n1/qwen -- the user-flagship scenario:
  // delegate twice with no model given, expect both nodes used.
  function makeFanoutManager(over: Record<string, unknown> = {}) {
    const built: Array<Record<string, unknown>> = [];
    const manager = new TaskManager({
      buildAgent: async (cfg) => {
        built.push(cfg);
        const agent = {
          abortSignal: null as AbortSignal | null,
          run: () =>
            new Promise<never>((_res, rej) => {
              agent.abortSignal!.addEventListener("abort", () =>
                rej(LlmError.Cancelled("aborted")),
              );
            }),
          notifyCompletion: () => {},
        };
        return agent as never;
      },
      modelRegistry: {
        "n1/qwen": cfgEntry("n1/qwen"),
        "n2/qwen": cfgEntry("n2/qwen"),
        "n3/other": cfgEntry("n3/other"),
        default: "n1/qwen",
      } as never,
      config: { modelGroups: { mid: ["qwen", "n3/other"] } } as never,
      maxIterations: 100,
      taskProfile: "default",
      lanesPerProvider: 1,
      runningPeek: async () => new Set<string>(),
      ...over,
    });
    return { manager, built };
  }

  it("two default-model delegates land on different providers, both running", async () => {
    const { manager, built } = makeFanoutManager();
    await manager.spawnTask("t1", "a", {} as never);
    await manager.spawnTask("t2", "b", {} as never);
    await settle(() => built.length === 2, "both placed");
    expect(manager.taskStatus("t1")).toBe("running");
    expect(manager.taskStatus("t2")).toBe("running");
    expect(new Set([manager.taskLane("t1")!.provider, manager.taskLane("t2")!.provider])).toEqual(
      new Set(["n1", "n2"]),
    );
    manager.interruptTask("t1");
    manager.interruptTask("t2");
  });

  it("prefers the warm node when both lanes are free", async () => {
    const { manager, built } = makeFanoutManager({
      runningPeek: async (p: string) => (p === "n2" ? new Set(["qwen"]) : new Set<string>()),
    });
    await manager.spawnTask("t1", "a", {} as never);
    await settle(() => built.length === 1, "placed");
    expect(built[0]!.model).toBe("n2/qwen");
    expect(manager.taskLane("t1")).toEqual({ model: "n2/qwen", provider: "n2" });
    manager.interruptTask("t1");
  });

  it("queues when every copy is busy (no silent downgrade) and shows the intent", async () => {
    const { manager, built } = makeFanoutManager();
    await manager.spawnTask("t1", "a", {} as never);
    await manager.spawnTask("t2", "b", {} as never);
    await settle(() => built.length === 2, "qwen fleet busy");
    await manager.spawnTask("t3", "c", {} as never);
    expect(manager.taskStatus("t3")).toBe("queued");
    const lane3 = manager.taskLane("t3")!;
    expect(lane3.provider).toBeNull();
    expect(lane3.model).toBe("n1/qwen"); // the intent, not a placement
    manager.interruptTask("t1");
    await settle(() => built.length === 3, "t3 placed on release");
    expect(manager.taskLane("t3")!.provider).not.toBeNull();
    manager.interruptTask("t2");
    manager.interruptTask("t3");
  });

  it("provider taskLanes makes an already-busy copy eligible for a third task", async () => {
    const { manager, built } = makeFanoutManager({
      config: {
        modelGroups: {},
        providers: [{ name: "n1", taskLanes: 2 }],
      },
    });
    await manager.spawnTask("t1", "a", {} as never);
    await manager.spawnTask("t2", "b", {} as never);
    await settle(() => built.length === 2, "two placed on the raised-cap fleet");
    await manager.spawnTask("t3", "c", {} as never);
    // Under the global cap of 1 t3 would queue (both copies hold a task);
    // n1's raised cap leaves a free slot, so it places instead.
    await settle(() => built.length === 3, "t3 placed, never queued");
    expect(manager.taskLane("t3")!.provider).not.toBeNull();
    manager.interruptTask("t1");
    manager.interruptTask("t2");
    manager.interruptTask("t3");
  });

  it("group delegates degrade to a free member when the preferred model is saturated", async () => {
    const { manager, built } = makeFanoutManager();
    await manager.spawnTask("t1", "a", {} as never);
    await manager.spawnTask("t2", "b", {} as never);
    await settle(() => built.length === 2, "qwen fleet busy");
    await manager.spawnTask("t3", "c", { group: "mid" } as never);
    await settle(() => built.length === 3, "group task ran the spare member");
    expect(built[2]!.model).toBe("n3/other");
    manager.interruptTask("t1");
    manager.interruptTask("t2");
    manager.interruptTask("t3");
  });

  it("strict pin waits on its provider instead of using a copy", async () => {
    const { manager, built } = makeFanoutManager();
    await manager.spawnTask("t1", "a", { pin: { model: "n1/qwen" } } as never);
    await settle(() => built.length === 1, "t1 built");
    await manager.spawnTask("t2", "b", { pin: { model: "qwen" } } as never);
    expect(manager.taskStatus("t2")).toBe("queued");
    expect(manager.taskLane("t2")).toEqual({ model: "n1/qwen", provider: "n1" });
    manager.interruptTask("t1");
    manager.interruptTask("t2");
  });

  it("noSpread providers never receive implicit fanout", async () => {
    const { manager, built } = makeFanoutManager({
      config: {
        modelGroups: { mid: ["qwen", "n3/other"] },
        providers: [{ name: "n2", noSpread: true }],
      },
    });
    await manager.spawnTask("t1", "a", {} as never);
    await settle(() => built.length === 1, "t1 built");
    expect(built[0]!.model).toBe("n1/qwen");
    await manager.spawnTask("t2", "b", {} as never);
    expect(manager.taskStatus("t2")).toBe("queued"); // n2 is off-limits implicitly
    manager.interruptTask("t1");
    await settle(() => built.length === 2, "t2 starts when n1 frees");
    expect(built[1]!.model).toBe("n1/qwen");
    manager.interruptTask("t2");
  });

  it("cancelling mid-placement releases the reservation", async () => {
    const slowPeek = async () => {
      await new Promise((r) => setTimeout(r, 50));
      return new Set<string>();
    };
    const { manager } = makeFanoutManager({ runningPeek: slowPeek });
    await manager.spawnTask("t1", "a", {} as never);
    expect(manager.taskStatus("t1")).toBe("queued"); // mid-placement
    manager.interruptTask("t1");
    expect(manager.taskStatus("t1")).toBe("cancelled");
    await manager.spawnTask("t2", "b", {} as never);
    await settle(
      () => manager.taskStatus("t2") === "running",
      "t2 places despite the dead reservation",
    );
    manager.interruptTask("t2");
  });
});

describe("cross-process lane ledger (two TaskManagers, one lanesDir)", () => {
  async function freshLanesDir(): Promise<string> {
    const { mkdtemp } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    return mkdtemp(join(tmpdir(), "task-lanes-"));
  }

  async function slotCount(lanesDir: string, lane: string): Promise<number> {
    try {
      const names = await readdir(join(lanesDir, lane));
      return names.filter((n) => n.startsWith("slot-")).length;
    } catch {
      return 0;
    }
  }

  async function settleCount(
    get: () => Promise<number>,
    want: number,
    what: string,
    timeoutMs = 2000,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await get()) === want) return;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Agent whose turns resolve only when the test says so. */
  function gatedAgent() {
    const gates: Array<{ resolve: (v: unknown) => void }> = [];
    const agent: any = {
      run: () => new Promise((resolve) => gates.push({ resolve })),
      notifyCompletion: () => {},
    };
    return {
      agent,
      finishTurn: (content: string) =>
        gates.shift()!.resolve({ type: "completion", content }),
      pending: () => gates.length,
    };
  }

  it("a foreign manager's task blocks the lane; it starts when the slot frees", async () => {
    const lanesDir = await freshLanesDir();
    const aG = gatedAgent();
    const bG = gatedAgent();
    const mgrOpts = (build: () => any) => ({
      buildAgent: async () => build(),
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
      lanesPerProvider: 1,
      lanesDir,
      lanesRetryMs: 25,
    });
    const mA = new TaskManager(mgrOpts(() => aG.agent));
    const mB = new TaskManager(mgrOpts(() => bG.agent));

    const hA = await mA.spawnTask("a1", "work", { workerModel: "prov/ma" } as never);
    await settle(() => mA.taskStatus("a1") === "running", "a1 runs");
    expect(await slotCount(lanesDir, "prov")).toBe(1);

    await mB.spawnTask("b1", "work", { workerModel: "prov/mb" } as never);
    // Let any first acquire pass complete; b1 cannot start while a1 holds the slot.
    await new Promise((r) => setTimeout(r, 80));
    expect(mB.taskStatus("b1")).toBe("queued");
    expect(await slotCount(lanesDir, "prov")).toBe(1);

    aG.finishTurn("done A");
    await hA.done;
    await settle(() => mB.taskStatus("b1") === "running", "b1 starts once the slot frees");
    bG.finishTurn("done B");
    await settle(() => mB.taskStatus("b1") === "completed", "b1 completes");
    await settleCount(() => slotCount(lanesDir, "prov"), 0, "all slots released");
    await import("node:fs/promises").then((fs) => fs.rm(lanesDir, { recursive: true, force: true }));
  });

  it("a parked task yields its cross-process slot between turns and takes it back for a warm turn", async () => {
    const lanesDir = await freshLanesDir();
    const { rm } = await import("node:fs/promises");
    const aGate: unknown[] = [];
    const waiters: Array<(t: unknown) => void> = [];
    const onTurn = (t: unknown) => {
      aGate.push(t);
      waiters.shift()?.(t);
    };
    const aG = gatedAgent();
    const bG = gatedAgent();
    const mgrOpts = (build: () => any) => ({
      buildAgent: async () => build(),
      modelRegistry: {} as any,
      config: {} as any,
      maxIterations: 10,
      taskProfile: "default",
      lanesPerProvider: 1,
      lanesDir,
      lanesRetryMs: 25,
    });
    const mA = new TaskManager(mgrOpts(() => aG.agent));
    const mB = new TaskManager(mgrOpts(() => bG.agent));

    await mA.spawnTask("a1", "first", {
      park: true,
      onTurn,
      workerModel: "prov/ma",
    } as never);
    await settle(() => mA.taskStatus("a1") === "running", "a1 runs");
    await settleCount(() => slotCount(lanesDir, "prov"), 1, "a1 holds the slot in-flight");

    aG.finishTurn("v1"); // parked-idle now
    await new Promise((r) => waiters.push(r));
    await settleCount(() => slotCount(lanesDir, "prov"), 0, "parked-idle released the slot");

    await mB.spawnTask("b1", "work", { workerModel: "prov/mb" } as never);
    await settle(() => mB.taskStatus("b1") === "running", "b1 took the yielded slot");

    const warm = mA.taskTurn("a1", "retry");
    await new Promise((r) => setTimeout(r, 80)); // b1 still holds the lane
    expect(aGate.length).toBe(1); // warm turn has not run yet

    bG.finishTurn("done B");
    await settle(() => mB.taskStatus("b1") === "completed", "b1 completes and frees the slot");
    await settle(() => aG.pending() === 1, "warm turn starts once the slot frees");
    aG.finishTurn("v2");
    const turn = await warm;
    expect(turn).toEqual({ status: "completed", result: "v2" });
    mA.completeTask("a1");
    await settleCount(() => slotCount(lanesDir, "prov"), 0, "all slots released");
    await rm(lanesDir, { recursive: true, force: true });
  });
});
