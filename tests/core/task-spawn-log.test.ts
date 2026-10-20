// Restart sidecar for delegate_task records (spawn-log): spawn/terminal lines,
// orphan enumeration across a simulated process restart, plan_status /
// task_status surfacing, and the never-break-execution rule for write failures.

import { describe, it, expect, afterAll } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TaskManager } from "@core/session/task-manager.ts";
import { PlanStatusTool, TaskStatusTool } from "@extensions/subagents/subagents.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-log-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

async function settle(fn: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

function agentOf(behavior: "done" | "hang" | "throw") {
  let release!: () => void;
  const hang = new Promise<void>((res) => {
    release = res;
  });
  const agent = {
    run: async () => {
      if (behavior === "hang") {
        await hang;
        // Released after an interrupt: behave like a real aborted agent and
        // reject; the manager sees the aborted signal -> cancelled outcome.
        throw new Error("run released");
      }
      if (behavior === "throw") throw new Error("worker exploded");
      return { type: "completion", content: "all done" };
    },
    notifyCompletion: () => {},
  };
  return { agent, release };
}

/**
 * TaskManager with a sidecar; `pidAlive` defaults to "every recorded pid is
 * dead", simulating a fresh process lifetime over an existing sidecar.
 */
function managerWithSidecar(
  spawnLogPath: string | null,
  opts: { behavior?: "done" | "hang" | "throw"; pidAlive?: (pid: number) => boolean } = {},
) {
  const { agent, release } = agentOf(opts.behavior ?? "done");
  const manager = new TaskManager({
    buildAgent: async () => agent as never,
    modelRegistry: {},
    config: {},
    maxIterations: 3,
    taskProfile: "default",
    spawnLogPath,
    spawnLogPidAlive: opts.pidAlive ?? (() => false),
  });
  return { manager, release };
}

function readLines(path: string): Array<Record<string, unknown>> {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("spawn sidecar records", () => {
  it("a completed spawn writes a spawn line and a terminal line", async () => {
    const path = join(freshDir(), "task-spawns.jsonl");
    const { manager } = managerWithSidecar(path);
    const handle = await manager.spawnTask("t1", "Build the widget", {
      managerAgent: { sessionId: "session-9" },
    });
    const completion = await handle.done;
    expect(completion.status).toBe("completed");

    // Appends are fire-and-forget: wait for both lines to land.
    await settle(() => existsSync(path) && readLines(path).length >= 2, "both sidecar lines");
    const lines = readLines(path);
    expect(lines.length).toBe(2);
    const [spawn, end] = lines as [Record<string, unknown>, Record<string, unknown>];
    expect(spawn.ev).toBe("spawn");
    expect(spawn.id).toBe("t1");
    expect(spawn.desc).toBe("Build the widget");
    expect(spawn.session).toBe("session-9");
    expect(spawn.pid).toBe(process.pid);
    expect(typeof spawn.host).toBe("string");
    expect(typeof spawn.t).toBe("string");
    expect(end.ev).toBe("end");
    expect(end.id).toBe("t1");
    expect(end.outcome).toBe("completed");
  });

  it("an interrupted spawn records cancelled; a throwing worker records failed", async () => {
    const path = join(freshDir(), "task-spawns.jsonl");
    const { manager, release } = managerWithSidecar(path, { behavior: "hang" });
    await manager.spawnTask("t2", "Long thing");
    await settle(() => manager.taskStatus("t2") === "running", "t2 running");
    manager.interruptTask("t2");
    release(); // the agent run settles; the aborted turn finalizes as cancelled
    await settle(() => existsSync(path) && readLines(path).some((l) => l.ev === "end"), "end line");

    const boom = managerWithSidecar(path, { behavior: "throw" });
    const handle = await boom.manager.spawnTask("t3", "Doomed thing");
    const completion = await handle.done;
    expect(completion.status).toBe("failed");
    await settle(() => readLines(path).some((l) => l.ev === "end" && l.id === "t3"), "t3 end line");

    const ends = readLines(path).filter((l) => l.ev === "end");
    expect(ends.map((l) => `${l.id}:${l.outcome}`).sort()).toEqual(["t2:cancelled", "t3:failed"]);
  });

  it("parked (workflow-engine) spawns are never recorded", async () => {
    const path = join(freshDir(), "task-spawns.jsonl");
    const { manager } = managerWithSidecar(path);
    await manager.spawnTask("p1", "parked node work", { park: true });
    await settle(() => manager.taskStatus("p1") === "running", "p1 running");
    manager.interruptTask("p1");
    await settle(() => manager.taskStatus("p1") === "cancelled", "p1 cancelled");
    await new Promise((r) => setTimeout(r, 20)); // give any stray fire-and-forget write a chance
    expect(existsSync(path)).toBe(false);
  });

  it("unset spawnLogPath disables the sidecar entirely", async () => {
    const root = freshDir();
    const { manager } = managerWithSidecar(null);
    const handle = await manager.spawnTask("t3", "no sidecar");
    await handle.done;
    expect(existsSync(join(root, "task-spawns.jsonl"))).toBe(false);
    expect(await manager.orphanedTasks()).toEqual([]);
  });

  it("a broken sidecar path (mkdir fails) never breaks task spawn or completion", async () => {
    const root = freshDir();
    writeFileSync(join(root, "blocker"), "a file where a dir must be");
    const path = join(root, "blocker", "task-spawns.jsonl"); // mkdir ENOTDIR
    const { manager } = managerWithSidecar(path);
    const handle = await manager.spawnTask("t4", "survives broken sidecar");
    const completion = await handle.done; // fire-and-forget writes must not stall or throw
    expect(completion.status).toBe("completed");
    expect(manager.taskStatus("t4")).toBe("completed");
  });
});

describe("restart orphans", () => {
  it("a fresh TaskManager over the same sidecar enumerates never-ended tasks (simulated restart)", async () => {
    const path = join(freshDir(), "task-spawns.jsonl");
    // Previous lifetime: t-open never ended, t-settled completed.
    const first = managerWithSidecar(path, { behavior: "hang" });
    await first.manager.spawnTask("t-open", "Half a job", { managerAgent: { sessionId: "s1" } });
    await settle(() => first.manager.taskStatus("t-open") === "running", "t-open running");
    const settled = managerWithSidecar(path);
    const h = await settled.manager.spawnTask("t-settled", "Finished job");
    await h.done;
    // Fire-and-forget appends must have landed before the "restart" reads.
    await settle(
      () => existsSync(path) && readLines(path).some((l) => l.ev === "end" && l.id === "t-settled"),
      "t-settled end line",
    );

    await settle(
      () => existsSync(path) && readLines(path).some((l) => l.ev === "spawn" && l.id === "t-open"),
      "t-open spawn line",
    );

    // Simulated restart: brand-new manager, same sidecar, all pids dead.
    const restarted = managerWithSidecar(path);
    const orphans = await restarted.manager.orphanedTasks();
    expect(orphans.length).toBe(1);
    expect(orphans[0]!.taskId).toBe("t-open");
    expect(orphans[0]!.description).toBe("Half a job");
    expect(orphans[0]!.sessionId).toBe("s1");
    expect(typeof orphans[0]!.spawnedAt).toBe("number");

    // plan_status surfaces the section; task_status answers honestly.
    const plan = await new PlanStatusTool({ taskManager: restarted.manager }).execute({});
    expect(plan.output).toContain("No active tasks");
    expect(plan.output).toContain("interrupted by restart:");
    expect(plan.output).toContain("t-open -- Half a job");
    const st = await new TaskStatusTool({ taskManager: restarted.manager }).execute({
      task_id: "t-open",
    });
    expect(st.error).toBeNull();
    expect(st.output).toContain("t-open: interrupted by process restart");
    // A settled id is NOT an orphan: unknown, as before.
    expect(
      (await new TaskStatusTool({ taskManager: restarted.manager }).execute({ task_id: "t-settled" })).error,
    ).toContain("not found");
  });

  it("a spawn with no timestamp still enumerates (age unknown)", async () => {
    const path = join(freshDir(), "task-spawns.jsonl");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({ ev: "spawn", id: "ancient", desc: "no stamp", session: null })}\n`,
    );
    const { manager } = managerWithSidecar(path);
    const orphans = await manager.orphanedTasks();
    expect(orphans.map((o) => o.taskId)).toEqual(["ancient"]);
    expect(orphans[0]!.spawnedAt).toBeNull();
  });

  it("empty or fully-settled sidecars leave plan_status output byte-identical", async () => {
    // No sidecar file at all.
    const emptyPath = join(freshDir(), "task-spawns.jsonl");
    const empty = managerWithSidecar(emptyPath);
    const r1 = await new PlanStatusTool({ taskManager: empty.manager }).execute({});
    expect(r1.output).toBe("No active tasks");

    // Fully settled sidecar.
    const settledPath = join(freshDir(), "task-spawns.jsonl");
    const settled = managerWithSidecar(settledPath);
    const h = await settled.manager.spawnTask("done-1", "did it");
    await h.done;
    await settle(
      () => existsSync(settledPath) && readLines(settledPath).some((l) => l.ev === "end"),
      "settled end line",
    );
    const restarted = managerWithSidecar(settledPath);
    const r2 = await new PlanStatusTool({ taskManager: restarted.manager }).execute({});
    expect(r2.output).toBe("No active tasks");
    expect(await restarted.manager.orphanedTasks()).toEqual([]);
  });

  it("live pids on this host are not orphans (co-resident process, no false alarm)", async () => {
    const path = join(freshDir(), "task-spawns.jsonl");
    const { manager } = managerWithSidecar(path, { behavior: "hang" });
    await manager.spawnTask("t5", "still running elsewhere");
    await settle(() => manager.taskStatus("t5") === "running", "t5 running");
    await settle(
      () => existsSync(path) && readLines(path).some((l) => l.ev === "spawn" && l.id === "t5"),
      "t5 spawn line",
    );
    // Same records, but this time recorded pids are treated as ALIVE.
    const watcher = managerWithSidecar(path, { pidAlive: () => true });
    expect(await watcher.manager.orphanedTasks()).toEqual([]);
    // Sanity: the very same file with dead pids DOES enumerate the open task.
    const deadWatcher = managerWithSidecar(path);
    expect((await deadWatcher.manager.orphanedTasks()).map((o) => o.taskId)).toEqual(["t5"]);
  });

  it("torn and foreign lines in the sidecar are skipped, never fatal", async () => {
    const path = join(freshDir(), "task-spawns.jsonl");
    writeFileSync(
      path,
      `this line is not json\n` +
        `{"ev":"spawn","id":"ok","desc":"fine","session":null,"pid":999999,"host":"x"}\n` +
        `{"ev":"mystery","id":"ignored"}\n` +
        `{"ev":"spawn","id":"torn","desc":"never finis`,
    );
    const { manager } = managerWithSidecar(path);
    const orphans = await manager.orphanedTasks();
    expect(orphans.length).toBe(1); // the torn spawn line is skipped
    expect(orphans[0]!.taskId).toBe("ok");
  });
});
