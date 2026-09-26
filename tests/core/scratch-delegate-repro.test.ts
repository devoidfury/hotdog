// SCRATCH repro: delegate_task shape — manager session turn spawns a task on
// the SAME provider lane (cap 1), ends its turn, task must start, complete,
// and wake the manager. Mirrors the user report: task never starts.
import { describe, it, expect } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MessageBus } from "@core/session/message-bus.ts";
import { createTurnLanes } from "@core/session/turn-lanes.ts";
import { TaskManager } from "@core/session/task-manager.ts";

async function settle(fn: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("delegate repro (single provider, cap 1)", () => {
  it("task starts after manager release, completion wakes manager", async () => {
    const lanesDir = await mkdtemp(join(tmpdir(), "lanes-delegate-"));
    let workerStarted = 0;
    let workerFinish!: () => void;
    const workerGate = new Promise<void>((r) => (workerFinish = r));

    const tasks = new TaskManager({
      buildAgent: async (config: Record<string, unknown>) => {
        workerStarted++;
        const sink = config.sink as { onTaskComplete: (r: string) => void };
        return {
          run: async () => {
            await workerGate;
            return { type: "completion", content: "worker done" };
          },
          notifyCompletion: (r: string) => sink.onTaskComplete(r),
          hooks: undefined,
        } as never;
      },
      modelRegistry: { "pA/m": {}, default: "pA/m" } as never,
      config: { providers: [{ name: "pA" }] } as never,
      maxIterations: 5,
      taskProfile: "default",
      lanesPerProvider: 1,
      lanesDir,
      lanesRetryMs: 25,
      runningPeek: async () => new Set<string>(),
    });

    const lanes = createTurnLanes({
      lanesDir,
      lanesPerProvider: 1,
      providerDefs: [{ name: "pA" }],
      lanesRetryMs: 25,
    });

    let turnCount = 0;
    let spawnError: unknown = null;
    let taskDone: string | null = null;
    const gates: Array<() => void> = [];
    const agent: any = {
      sessionId: "mgr",
      model: "pA/m",
      hooks: { runHookPipeline: async (_n: string, d: unknown) => d },
      run: async () => {
        turnCount++;
        if (turnCount === 1) {
          try {
            const h = await tasks.spawnTask("t1", "do work", {
              managerAgent: { sessionId: "mgr" },
            });
            h.done.then((c) => (taskDone = c.status));
          } catch (e) {
            spawnError = e;
          }
        }
        await new Promise<void>((res) => gates.push(res));
        return { type: "completion", content: `manager turn ${turnCount}` };
      },
      resetCancel: () => {},
      cancel: () => {},
    };
    const finishTurn = () => gates.shift!()();

    const bus = new MessageBus({
      sessionManager: { getAgent: () => agent },
      sink: { emit: () => {} },
      lanes,
    });
    tasks.setSessionManager({
      getAgent: () => agent,
      getBus: (sid: string) => (sid === "mgr" ? bus : undefined),
    });

    void bus.run();
    bus.enqueue("delegate this");

    await settle(() => turnCount === 1, "manager turn 1");
    expect(spawnError).toBeNull();
    // Task QUEUED: the manager holds the only pA slot while its turn runs.
    await new Promise((r) => setTimeout(r, 100));
    expect(workerStarted).toBe(0);
    expect(tasks.taskStatus("t1")).toBe("queued");

    // Manager ends turn -> pA frees -> worker starts (no LLM request yet).
    finishTurn();
    try {
      await settle(() => workerStarted === 1, "worker agent built / task starts");
    } catch (e) {
      const tree = [];
      for (const lane of await readdir(lanesDir)) {
        for (const f of await readdir(join(lanesDir, lane))) {
          tree.push(`${lane}/${f}: ${await Bun.file(join(lanesDir, lane, f)).text().catch(() => "?")}`);
        }
      }
      console.error("LEDGER:", tree.join(" | "), "STATUS:", tasks.taskStatus("t1"), "counts:", tasks.progressMessage());
      throw e;
    }
    expect(tasks.taskStatus("t1")).toBe("running");

    // Worker finishes -> result delivered -> manager wakes.
    workerFinish();
    await settle(() => taskDone === "completed", "task settles");
    await settle(() => turnCount === 2, "manager wakes on task result");

    bus.cancel();
    await rm(lanesDir, { recursive: true, force: true });
  }, 15000);
});
