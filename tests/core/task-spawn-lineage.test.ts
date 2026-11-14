// Durable subagent lineage over the restart sidecar (SpawnLog.lineage +
// TaskManager.lineageTasks): boot reconstruction of the webui sidebar feed.
// The tests write sidecar files directly (a previous lifetime's exact bytes,
// including pre-agent-line records) and read them through a fresh lifetime's
// view. Honesty pins: open records stay OPEN (the caller renders them
// interrupted, never running), terminal records carry their recorded outcome
// through, the agent line is the manager->worker join, and a co-resident
// live pid still owns its open record.

import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { SpawnLog } from "@core/session/spawn-log.ts";
import { TaskManager } from "@core/session/task-manager.ts";

const tmpDirs: string[] = [];
function freshDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "spawn-lineage-"));
  tmpDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function writeSidecar(lines: Array<Record<string, unknown>>): string {
  const path = join(freshDir(), "task-spawns.jsonl");
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

async function settle(fn: () => Promise<boolean> | boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 2));
  }
}

describe("SpawnLog.lineage", () => {
  it("open records stay open; terminal records carry their recorded outcome; the agent line joins the worker", async () => {
    const path = writeSidecar([
      { t: "2026-11-13T10:00:00.000Z", ev: "spawn", id: "t-done", desc: "shipped", session: "mgr-a", pid: 111, host: "box" },
      { t: "2026-11-13T10:00:02.000Z", ev: "agent", id: "t-done", agent: "worker-key-1" },
      { t: "2026-11-13T10:12:00.000Z", ev: "end", id: "t-done", outcome: "completed" },
      { t: "2026-11-13T10:05:00.000Z", ev: "spawn", id: "t-open", desc: "half a job", session: "mgr-a", pid: 112, host: "box" },
    ]);
    const log = new SpawnLog(path, () => false); // every writer pid dead: a fresh lifetime
    const recs = await log.lineage();
    expect(recs.map((r) => r.taskId)).toEqual(["t-done", "t-open"]); // spawn order

    const done = recs[0]!;
    expect(done.description).toBe("shipped");
    expect(done.sessionId).toBe("mgr-a");
    expect(done.agentSessionId).toBe("worker-key-1"); // the durable manager->worker join
    expect(done.outcome).toBe("completed");
    expect(done.endedAt).toBe(Date.parse("2026-11-13T10:12:00.000Z"));
    expect(done.spawnedAt).toBe(Date.parse("2026-11-13T10:00:00.000Z"));
    expect(typeof done.observedAt).toBe("number");

    // Open record: nothing is invented -- outcome/endedAt stay null (the
    // caller's honest state is "interrupted"), agent unrecorded joins stay null.
    const open = recs[1]!;
    expect(open.outcome).toBeNull();
    expect(open.endedAt).toBeNull();
    expect(open.agentSessionId).toBeNull(); // pre-agent-line record: no transcript key
    expect(open.spawnedAt).toBe(Date.parse("2026-11-13T10:05:00.000Z"));
  });

  it("a pid alive ON THIS HOST still owns its open record (no false interrupted); closed records survive regardless", async () => {
    const path = writeSidecar([
      { t: "2026-11-13T10:00:00.000Z", ev: "spawn", id: "t-mine", desc: "running elsewhere", session: "mgr-a", pid: 777, host: hostname() },
      { t: "2026-11-13T10:01:00.000Z", ev: "spawn", id: "t-theirs-done", desc: "closed", session: "mgr-a", pid: 778, host: hostname() },
      { t: "2026-11-13T10:02:00.000Z", ev: "end", id: "t-theirs-done", outcome: "cancelled" },
    ]);
    // The same file, but pid 777 answers alive on this host name: its OPEN
    // record belongs to a live process, so it leaves the lineage view. The
    // CLOSED record survives regardless of pid liveness (a durable fact).
    const alive = await new SpawnLog(path, (pid) => pid === 777).lineage();
    expect(alive.map((r) => r.taskId)).toEqual(["t-theirs-done"]);
    // Foreign-host records cannot be liveness-checked: reported, mirroring
    // the orphan stance -- even when every local pid would answer alive.
    const foreignHost = writeSidecar([
      { t: "2026-11-13T10:00:00.000Z", ev: "spawn", id: "t-remote", desc: "another box", session: "mgr-a", pid: 1, host: "not-this-box" },
    ]);
    const remote = await new SpawnLog(foreignHost, () => true).lineage();
    expect(remote.map((r) => r.taskId)).toEqual(["t-remote"]);
  });

  it("the LAST line per id decides (reused ids reset); stray agent/end lines stay inert; torn lines skip", async () => {
    const path = join(freshDir(), "task-spawns.jsonl");
    writeFileSync(
      path,
      `{"ev":"spawn","id":"r1","desc":"first life","session":"m1","pid":9,"host":"h"}\n` +
        `{"ev":"end","id":"r1","outcome":"completed"}\n` +
        `{"ev":"spawn","id":"r1","desc":"second life","session":"m2","pid":9,"host":"h"}\n` +
        `{"ev":"agent","id":"ghost","agent":"no-such-task"}\n` +
        `{"ev":"end","id":"never-spawned","outcome":"completed"}\n` +
        `{"ev":"agent","id":"r1","agent":"worker-r1"}\n` +
        `this line is not json`,
    );
    const recs = await new SpawnLog(path, () => false).lineage();
    expect(recs).toHaveLength(1);
    const r1 = recs[0]!;
    expect(r1.description).toBe("second life"); // the re-spawn replaced the record
    expect(r1.sessionId).toBe("m2");
    expect(r1.outcome).toBeNull(); // the old end line does not close the new life
    expect(r1.agentSessionId).toBe("worker-r1"); // the post-re-spawn agent line joined it
  });

  it("engine (parked) spawns ride the lineage: run dir parsed, open rows included", async () => {
    const path = writeSidecar([
      { t: "2026-11-13T10:00:00.000Z", ev: "spawn", id: "run:n#1", desc: "node work", session: "mgr-w", parked: true, run: "/runs/abc", pid: 111, host: "box" },
      { t: "2026-11-13T10:00:01.000Z", ev: "agent", id: "run:n#1", agent: "worker-n" },
      // OPEN parked record, dead writer: the sidebar's interrupted row. (The
      // ORPHAN view skips it -- pinned in task-spawn-log.test.ts.)
      { t: "2026-11-13T10:05:00.000Z", ev: "spawn", id: "run:n#2", desc: "mid-run death", session: "mgr-w", parked: true, run: "/runs/abc", pid: 112, host: "box" },
    ]);
    const recs = await new SpawnLog(path, () => false).lineage();
    expect(recs.map((r) => r.taskId)).toEqual(["run:n#1", "run:n#2"]);
    expect(recs[0]!.runDir).toBe("/runs/abc");
    expect(recs[0]!.agentSessionId).toBe("worker-n");
    expect(recs[0]!.outcome).toBeNull(); // never ended: the caller renders interrupted
    expect(recs[1]!.runDir).toBe("/runs/abc");
    expect(recs[1]!.outcome).toBeNull();
  });

  it("no sidecar file reads as an empty lineage", async () => {
    const path = join(freshDir(), "absent.jsonl");
    expect(await new SpawnLog(path, () => false).lineage()).toEqual([]);
  });
});

describe("TaskManager.lineageTasks", () => {
  /** Manager with a real-ish worker (carries a sessionId, so the agent line lands). */
  function managerWithSidecar(spawnLogPath: string | null, opts: { pidAlive?: (pid: number) => boolean } = {}) {
    const agent = {
      sessionId: "worker-live-1",
      run: async () => ({ type: "completion", content: "all done" }),
      notifyCompletion: () => {},
    };
    const manager = new TaskManager({
      buildAgent: async () => agent as never,
      modelRegistry: {},
      config: {},
      maxIterations: 3,
      taskProfile: "default",
      spawnLogPath,
      spawnLogPidAlive: opts.pidAlive ?? (() => false),
    });
    return manager;
  }

  it("a completed task this lifetime ran is deduped out of the lineage view", async () => {
    const path = join(freshDir(), "task-spawns.jsonl");
    const manager = managerWithSidecar(path);
    const handle = await manager.spawnTask("t1", "Build the widget", {
      managerAgent: { sessionId: "mgr-1" },
    });
    await handle.done;
    await settle(async () => {
      const recs = await new SpawnLog(path, () => false).lineage();
      return recs.some((r) => r.taskId === "t1" && r.outcome === "completed");
    }, "t1 sidecar end line");
    // Same lifetime: #tasks answers t1 live, so the rebuilt feed stays silent
    // on it (a live card would otherwise render the same task twice).
    expect(await manager.lineageTasks()).toEqual([]);
    manager.stop();
  });

  it("unset spawnLogPath yields an empty lineage view", async () => {
    const manager = managerWithSidecar(null);
    expect(await manager.lineageTasks()).toEqual([]);
    manager.stop();
  });

  it("records from a past lifetime read back: open stays open, terminal carries through", async () => {
    const path = writeSidecar([
      { t: "2026-11-13T10:00:00.000Z", ev: "spawn", id: "old-done", desc: "shipped", session: "mgr-1", pid: 1, host: "h" },
      { t: "2026-11-13T10:00:01.000Z", ev: "agent", id: "old-done", agent: "worker-old" },
      { t: "2026-11-13T10:09:00.000Z", ev: "end", id: "old-done", outcome: "failed" },
      { t: "2026-11-13T10:05:00.000Z", ev: "spawn", id: "old-open", desc: "mid-run death", session: "mgr-1", pid: 2, host: "h" },
    ]);
    // Brand-new manager over the old sidecar: the boot view of the feed.
    const manager = managerWithSidecar(path);
    const recs = await manager.lineageTasks();
    expect(recs.map((r) => `${r.taskId}:${r.outcome ?? "open"}`)).toEqual([
      "old-done:failed",
      "old-open:open",
    ]);
    expect(recs[0]!.agentSessionId).toBe("worker-old");
    manager.stop();
  });
});
