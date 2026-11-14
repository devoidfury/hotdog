// Subagent lineage on the wire after a restart: taskLineageWire (the honest
// row grammar for sidecar-rebuilt tasks), sendTaskSnapshot (the boot-rebuilt
// feed rides the existing TASK_LIST frame: live rows first, durable rows
// trail), and coldLogsPayload (the additive `subagents` field on cold
// manager rows -- omitted outright when the sidecar attests none).
//
// Honesty pins: an OPEN sidecar record reads "interrupted" (never running);
// a closed one carries its recorded outcome through untouched; the clock is
// frozen sidecar wall time (startedAt null, turnStartedAt null, inRun false);
// the worker join (agentSessionId -> agentLogPath) rides only when recorded.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname, tmpdir } from "node:os";
import { TMP_PARENT } from "../mocks/io.ts";
import { taskLineageWire } from "@extensions/websocket/wire-messages.ts";
import { coldLogsPayload } from "@extensions/websocket/handlers-logs.ts";
import { MAX_SUBAGENT_LINEAGE_ROWS } from "@extensions/websocket/constants.ts";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { S2C } from "@extensions/websocket/protocol.ts";
import { type LineageRecord } from "@core/session/spawn-log.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import { createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

const SPAWN = Date.parse("2026-11-13T10:00:00.000Z");
const END = Date.parse("2026-11-13T10:12:30.000Z");

function rec(over: Partial<LineageRecord> & { taskId: string }): LineageRecord {
  return {
    description: "do the thing",
    sessionId: "mgr-1",
    agentSessionId: null,
    spawnedAt: SPAWN,
    endedAt: null,
    outcome: null,
    runDir: null,
    observedAt: END,
    ...over,
  };
}

// ── taskLineageWire: the row grammar ────────────────────────────────────────

describe("taskLineageWire", () => {
  let prevSessionsDir: string | undefined;
  beforeAll(() => {
    prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
    process.env.HOTDOG_SESSIONS_DIR = "/tmp/hotdog-lineage-logs";
  });
  afterAll(() => {
    if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
  });

  it("an open record reads interrupted, never running, with a frozen clock", () => {
    const row = taskLineageWire(rec({ taskId: "t-open" })) as Record<string, unknown>;
    expect(row.status).toBe("interrupted");
    expect(row.durable).toBe(true);
    expect(row.startedAt).toBeNull(); // unattested
    expect(row.endedAt).toBeNull();
    expect(row.inRun).toBe(false);
    expect(row.turnStartedAt).toBeNull(); // never ticks
    expect(row.createdAt).toBe(SPAWN);
    // Elapsed = spawn -> observation (the attested upper bound on its death).
    expect(row.activeMs).toBe(END - SPAWN);
    // No worker key: neither the id nor a path rides (menu items stay hidden).
    expect("agentSessionId" in row).toBe(false);
    expect("agentLogPath" in row).toBe(false);
  });

  it("a closed record carries its recorded outcome through; the clock is spawn->end", () => {
    const row = taskLineageWire(
      rec({ taskId: "run:step#1", outcome: "completed", endedAt: END, agentSessionId: "worker-9" }),
    ) as Record<string, unknown>;
    expect(row.status).toBe("completed");
    expect(row.endedAt).toBe(END);
    expect(row.activeMs).toBe(END - SPAWN);
    expect(row.agentSessionId).toBe("worker-9");
    // The taskWire gate reused: absolute path of the worker's own log.
    expect(row.agentLogPath).toBe(join("/tmp/hotdog-lineage-logs", "worker-9.jsonl"));
    // An end line that lost its outcome stays un-upgraded (unknown glyph).
    expect(taskLineageWire(rec({ taskId: "x", outcome: "", endedAt: END })).status).toBe("");
  });

  it("an unattested spawn stamp yields createdAt 0 and no elapsed", () => {
    const row = taskLineageWire(rec({ taskId: "ancient", spawnedAt: null })) as Record<string, unknown>;
    expect(row.createdAt).toBe(0);
    expect(row.activeMs).toBe(0);
    expect(row.status).toBe("interrupted");
  });

  it("an engine row keeps its run dir; delegate rows carry no runDir key", () => {
    const engineRow = taskLineageWire(
      rec({ taskId: "run:n#1", outcome: "completed", endedAt: END, runDir: "/runs/abc" }),
    ) as Record<string, unknown>;
    expect(engineRow.runDir).toBe("/runs/abc"); // Reveal stays honest: the journal dir outlived the run
    const bareRow = taskLineageWire(rec({ taskId: "t-plain" })) as Record<string, unknown>;
    expect("runDir" in bareRow).toBe(false); // no dir, no menu item
  });
});

// ── sendTaskSnapshot: the boot-rebuilt live feed ────────────────────────────

describe("sendTaskSnapshot: rebuilt lineage on the live row", () => {
  it("boot with records present: running-record becomes interrupted, terminal carries through; sessions without lineage yield nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-snap-"));
    try {
      const spawnLogPath = join(dir, "task-spawns.jsonl");
      writeFileSync(
        spawnLogPath,
        [
          { t: new Date(SPAWN).toISOString(), ev: "spawn", id: "run:a#1", desc: "shipped", session: "mgr-1", pid: 777, host: hostname() },
          { t: new Date(SPAWN + 2000).toISOString(), ev: "agent", id: "run:a#1", agent: "worker-a" },
          { t: new Date(END).toISOString(), ev: "end", id: "run:a#1", outcome: "completed" },
          { t: new Date(SPAWN + 60_000).toISOString(), ev: "spawn", id: "run:b#2", desc: "mid-run death", session: "mgr-1", pid: 778, host: hostname() },
          { t: new Date(SPAWN).toISOString(), ev: "spawn", id: "other:c", desc: "foreign manager", session: "mgr-2", pid: 779, host: hostname() },
        ]
          .map((l) => JSON.stringify(l))
          .join("\n") + "\n",
      );
      // A fresh lifetime over the old sidecar (all recorded pids dead).
      const tm = new TaskManager({
        buildAgent: async () => ({ sessionId: "w", run: async () => undefined, notifyCompletion: () => {} }) as never,
        modelRegistry: {},
        config: {},
        maxIterations: 3,
        taskProfile: "default",
        spawnLogPath,
        spawnLogPidAlive: () => false,
      });
      const registry = new SessionRegistry({ buildAgent: async () => makeWsMockAgent({}) });
      registry.setTaskManager(tm);

      const ws = createWsMockWs();
      ws.activeSessionId = "mgr-1";
      await registry.sendTaskSnapshot(ws);
      const frame = JSON.parse(ws.messages[ws.messages.length - 1]!) as {
        type: string;
        tasks: Array<Record<string, unknown>>;
      };
      expect(frame.type).toBe(S2C.TASK_LIST);
      // mgr-2's rows never cross into mgr-1's snapshot.
      expect(frame.tasks.map((t) => t.taskId)).toEqual(["run:a#1", "run:b#2"]);
      const done = frame.tasks[0]!;
      expect(done.status).toBe("completed"); // the recorded outcome rides through
      expect(done.durable).toBe(true);
      expect(done.agentSessionId).toBe("worker-a");
      const interrupted = frame.tasks[1]!;
      expect(interrupted.status).toBe("interrupted"); // open record, dead writer
      expect(interrupted.inRun).toBe(false);
      expect(interrupted.turnStartedAt).toBeNull();

      // A session with no lineage yields nothing (no rows, empty frame).
      const ws2 = createWsMockWs();
      ws2.activeSessionId = "mgr-3";
      await registry.sendTaskSnapshot(ws2);
      const frame2 = JSON.parse(ws2.messages[0]!) as { type: string; tasks: unknown[] };
      expect(frame2.type).toBe(S2C.TASK_LIST);
      expect(frame2.tasks).toEqual([]);
      tm.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a task this lifetime runs answers once: the live row, no durable twin", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-dedup-"));
    try {
      const spawnLogPath = join(dir, "task-spawns.jsonl");
      const agent = {
        sessionId: "worker-d",
        run: () => new Promise<never>(() => {}), // hang until interrupted
        notifyCompletion: () => {},
      };
      const tm = new TaskManager({
        buildAgent: async () => agent as never,
        modelRegistry: {},
        config: {},
        maxIterations: 3,
        taskProfile: "default",
        spawnLogPath,
        spawnLogPidAlive: () => false,
      });
      await tm.spawnTask("t-live", "still running", { managerAgent: { sessionId: "mgr-1" } });
      // The duplicate case needs BOTH views live: the sidecar spawn line has
      // landed AND the registry tracks the task. (Fire-and-forget write.)
      const deadline = Date.now() + 2000;
      for (;;) {
        let text = "";
        try {
          text = readFileSync(spawnLogPath, "utf8");
        } catch {}
        if (text.includes('"t-live"')) break;
        if (Date.now() > deadline) throw new Error("timed out waiting for the t-live spawn line");
        await new Promise((r) => setTimeout(r, 2));
      }
      const registry = new SessionRegistry({ buildAgent: async () => makeWsMockAgent({}) });
      registry.setTaskManager(tm);
      const ws = createWsMockWs();
      ws.activeSessionId = "mgr-1";
      await registry.sendTaskSnapshot(ws);
      const frame = JSON.parse(ws.messages[ws.messages.length - 1]!) as {
        tasks: Array<Record<string, unknown>>;
      };
      expect(frame.tasks.map((t) => t.taskId)).toEqual(["t-live"]);
      // The live row: taskWire grammar, no durable flag.
      expect(frame.tasks[0]!.durable).toBeUndefined();
      tm.stop();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── coldLogsPayload: the nested `subagents` field on cold rows ──────────────

describe("coldLogsPayload: cold-row lineage", () => {
  const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-cold-lineage-"));
  const SIDECAR_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-cold-lineage-sidecar-"));
  const SPAWNS = join(SIDECAR_DIR, "task-spawns.jsonl");
  let prevSessionsDir: string | undefined;

  beforeAll(() => {
    prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
    process.env.HOTDOG_SESSIONS_DIR = TMP;
    const mk = (id: string) =>
      writeFileSync(
        join(TMP, `${id}.jsonl`),
        JSON.stringify({ ts: "2026-11-13T00:00:00.000Z", session_id: id, source: "input", content: "hi" }) + "\n",
      );
    mk("cold-mgr"); // delegated two tasks in a past lifetime
    mk("plain-cold"); // never delegated: no lineage
    mk("worker-a"); // the worker's own log (it stays a plain row too)
    const at = (ms: number) => new Date(ms).toISOString();
    const lines = [
      { t: at(SPAWN), ev: "spawn", id: "run:one#1", desc: "task run:one#1", session: "cold-mgr", pid: 777, host: hostname() },
      { t: at(SPAWN + 1000), ev: "agent", id: "run:one#1", agent: "worker-a" },
      { t: at(END), ev: "end", id: "run:one#1", outcome: "completed" },
      { t: at(SPAWN + 30_000), ev: "spawn", id: "run:two#2", desc: "task run:two#2", session: "cold-mgr", pid: 778, host: hostname() },
      // A manager whose log is gone: rows exist, no cold row to nest under.
      { t: at(SPAWN), ev: "spawn", id: "orphan:mgr", desc: "homeless", session: "deleted-mgr", pid: 779, host: hostname() },
      // Null-parent spawn: no card, never rides anywhere.
      { t: at(SPAWN), ev: "spawn", id: "noparent:1", desc: "engine orphan", session: null, pid: 780, host: hostname() },
    ];
    writeFileSync(SPAWNS, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  });
  afterAll(() => {
    if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
    else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
    rmSync(TMP, { recursive: true, force: true });
    rmSync(SIDECAR_DIR, { recursive: true, force: true });
  });

  function manager(): TaskManager {
    return new TaskManager({
      buildAgent: async () => ({ sessionId: "w", run: async () => undefined, notifyCompletion: () => {} }) as never,
      modelRegistry: {},
      config: {},
      maxIterations: 3,
      taskProfile: "default",
      spawnLogPath: SPAWNS,
      spawnLogPidAlive: () => false, // a fresh lifetime over the old sidecar
    });
  }

  it("the cold manager row carries its nested lineage; rows without lineage carry no field", async () => {
    const registry = new SessionRegistry({ buildAgent: async () => makeWsMockAgent({}) });
    registry.setTaskManager(manager());
    const rows = await coldLogsPayload(registry);

    const mgr = rows.find((r) => r.id === "cold-mgr")!;
    const subs = mgr.subagents as Array<Record<string, unknown>>;
    expect(subs.map((s) => s.taskId)).toEqual(["run:one#1", "run:two#2"]); // spawn order
    expect(subs[0]!.status).toBe("completed"); // the recorded outcome rides through
    expect(subs[0]!.agentSessionId).toBe("worker-a");
    expect(subs[0]!.durable).toBe(true);
    expect(subs[1]!.status).toBe("interrupted"); // open sidecar record
    expect(subs[1]!.inRun).toBe(false);
    expect("agentSessionId" in subs[1]!).toBe(false); // no join recorded, no field

    // No lineage -> NO field at all: "no subagents" is byte-identical to the
    // old payload, and the client renders no section.
    expect("subagents" in rows.find((r) => r.id === "plain-cold")!).toBe(false);
    expect("subagents" in rows.find((r) => r.id === "worker-a")!).toBe(false);
    // The deleted manager's rows have no cold row to ride on; the null-parent
    // spawn never appears on any row.
    expect(rows.find((r) => r.id === "deleted-mgr")).toBeUndefined();
    expect(rows.some((r) => JSON.stringify(r).includes("noparent:1"))).toBe(false);
  });

  it("without a TaskManager the payload keeps its exact old shape", async () => {
    const registry = new SessionRegistry({ buildAgent: async () => makeWsMockAgent({}) });
    const rows = await coldLogsPayload(registry);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect("subagents" in row).toBe(false);
  });

  it("the per-manager wire bound keeps the newest rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lineage-cap-"));
    try {
      const path = join(dir, "task-spawns.jsonl");
      const total = MAX_SUBAGENT_LINEAGE_ROWS + 5;
      const lines: string[] = [];
      for (let i = 0; i < total; i++) {
        lines.push(
          JSON.stringify({
            t: new Date(SPAWN + i * 1000).toISOString(),
            ev: "spawn",
            id: `cap#${i}`,
            desc: `job ${i}`,
            session: "cold-mgr",
            pid: 1,
            host: "not-this-box",
          }),
        );
      }
      writeFileSync(path, lines.join("\n") + "\n");
      const registry = new SessionRegistry({ buildAgent: async () => makeWsMockAgent({}) });
      registry.setTaskManager(
        new TaskManager({
          buildAgent: async () => ({ sessionId: "w", run: async () => undefined, notifyCompletion: () => {} }) as never,
          modelRegistry: {},
          config: {},
          maxIterations: 3,
          taskProfile: "default",
          spawnLogPath: path,
          spawnLogPidAlive: () => false,
        }),
      );
      const rows = await coldLogsPayload(registry);
      const subs = rows.find((r) => r.id === "cold-mgr")!.subagents as Array<Record<string, unknown>>;
      expect(subs).toHaveLength(MAX_SUBAGENT_LINEAGE_ROWS);
      // Spawn order, oldest age out first: the five oldest are gone.
      expect(subs[0]!.taskId).toBe("cap#5");
      expect(subs[subs.length - 1]!.taskId).toBe(`cap#${total - 1}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
