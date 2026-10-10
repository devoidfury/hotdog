// TaskManager observer stream: spawn/status/activity observation used by the
// websocket/webui subagents relay.

import { describe, it, expect } from "bun:test";
import {
  TaskManager,
  TASK_STATUS,
  type TaskObserverEvent,
} from "@core/session/task-manager.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";

type Sink = { emit: (event: unknown) => void; onTaskComplete: (result: string) => void };

function makeManager(
  observer: (ev: TaskObserverEvent) => void,
  extra: { runImpl?: (sink: Sink) => Promise<unknown> } = {},
) {
  const manager = new TaskManager({
    buildAgent: async (cfg: Record<string, unknown>) => {
      const sink = cfg.sink as Sink;
      return {
        run: () =>
          extra.runImpl
            ? extra.runImpl(sink)
            : Promise.resolve({ type: "completion", content: "done" }),
        notifyCompletion: () => {},
      } as never;
    },
    modelRegistry: {} as never,
    config: {} as never,
    maxIterations: 10,
    taskProfile: "default",
  });
  manager.setObserver(observer);
  return manager;
}

async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("TaskManager observer", () => {
  it("emits spawn + status transitions with timestamps", async () => {
    const events: TaskObserverEvent[] = [];
    const manager = makeManager((ev) => events.push(ev));

    const handle = await manager.spawnTask(
      "task-1",
      "Build  the\nthing   with flattened newlines",
    );
    // Spawn announcement lands first (an unlimited lane may already have
    // flipped the entry to RUNNING synchronously inside #admit).
    expect(events[0]!.kind).toBe("task");
    expect(events[0]!.kind === "task" && events[0]!.task.status).toBe(TASK_STATUS.QUEUED);
    expect(events[0]).toEqual({
      kind: "task",
      task: expect.objectContaining({
        taskId: "task-1",
        description: "Build the thing with flattened newlines",
        status: TASK_STATUS.QUEUED,
        startedAt: null,
        endedAt: null,
      }),
    });

    const completion = await handle.done;
    expect(completion.status).toBe(TASK_STATUS.COMPLETED);

    const statuses = events
      .filter((e) => e.kind === "task")
      .map((e) => (e.kind === "task" ? e.task.status : "?"));
    expect(statuses).toEqual([
      TASK_STATUS.QUEUED,
      TASK_STATUS.RUNNING,
      TASK_STATUS.COMPLETED,
    ]);
    const last = events[events.length - 1]!;
    expect(last.kind).toBe("task");
    expect(last.kind === "task" && last.task.startedAt).toBeTruthy();
    expect(last.kind === "task" && last.task.endedAt).toBeTruthy();
  });

  it("truncates long descriptions", async () => {
    const events: TaskObserverEvent[] = [];
    const manager = makeManager((ev) => events.push(ev));
    await manager.spawnTask("task-1", "x".repeat(500));
    const first = events.find((e) => e.kind === "task");
    expect(first?.kind === "task" && first.task.description.length).toBe(140);
  });

  it("forwards task-agent output as activity events tagged with the task id", async () => {
    const events: TaskObserverEvent[] = [];
    const manager = makeManager((ev) => events.push(ev), {
      runImpl: async (sink) => {
        sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "working" });
        sink.emit({
          type: OUTPUT_EVENT.TOOL_CALL,
          toolName: "bash",
          input: "ls",
          toolCallId: "c1",
        });
        sink.emit({
          type: OUTPUT_EVENT.TOOL_RESULT,
          toolName: "bash",
          input: "ls",
          content: "afile",
          toolCallId: "c1",
        });
        return { type: "completion", content: "done" };
      },
    });

    const handle = await manager.spawnTask("task-2", "do it");
    await handle.done;

    const activity = events.filter((e) => e.kind === "activity");
    expect(activity).toHaveLength(3);
    for (const ev of activity) {
      expect(ev.kind === "activity" && ev.taskId).toBe("task-2");
    }
    expect(activity[0]!.kind === "activity" && activity[0]!.event.type).toBe(
      OUTPUT_EVENT.STREAMING_CHUNK,
    );
    expect(activity[1]!.kind === "activity" && activity[1]!.event.type).toBe(
      OUTPUT_EVENT.TOOL_CALL,
    );
    expect(activity[2]!.kind === "activity" && activity[2]!.event.type).toBe(
      OUTPUT_EVENT.TOOL_RESULT,
    );
  });

  it("reports FAILED with an ended terminal event when the run throws", async () => {
    const events: TaskObserverEvent[] = [];
    const manager = makeManager((ev) => events.push(ev), {
      runImpl: async () => {
        throw new Error("boom");
      },
    });
    const handle = await manager.spawnTask("task-3", "doomed");
    const completion = await handle.done;
    expect(completion.status).toBe(TASK_STATUS.FAILED);
    const terminal = events[events.length - 1]!;
    expect(terminal.kind).toBe("task");
    expect(terminal.kind === "task" && terminal.task.status).toBe(TASK_STATUS.FAILED);
    expect(terminal.kind === "task" && terminal.task.endedAt).toBeTruthy();
  });

  it("reports sessionId on task snapshots (delegating session, null without a parent)", async () => {
    const events: TaskObserverEvent[] = [];
    const manager = makeManager((ev) => events.push(ev));
    await manager.spawnTask("task-1", "child of s-1", {
      managerAgent: { sessionId: "s-1" },
    });
    await manager.spawnTask("task-2", "orphan");
    const infos = Object.fromEntries(
      manager.listTasks().map((t) => [t.taskId, t.sessionId]),
    );
    expect(infos["task-1"]).toBe("s-1");
    expect(infos["task-2"]).toBeNull();
    const spawned = events.filter((e) => e.kind === "task");
    expect(spawned[0]!.kind === "task" && spawned[0]!.task.sessionId).toBe("s-1");
  });

  it("listTasks keeps terminal tasks with their metadata for late snapshots", async () => {
    const manager = makeManager(() => {});
    const handle = await manager.spawnTask("task-1", "one");
    await handle.done;
    await manager.spawnTask("task-2", "two");
    await settle(() => manager.taskStatus("task-2") === TASK_STATUS.RUNNING, "task-2 run");

    const list = manager.listTasks();
    expect(list.map((t) => t.taskId).sort()).toEqual(["task-1", "task-2"]);
    const done = list.find((t) => t.taskId === "task-1")!;
    expect(done.status).toBe(TASK_STATUS.COMPLETED);
    expect(done.description).toBe("one");
    expect(done.endedAt).toBeTruthy();
  });
});
