// The manager revive: attaching a restart-adopted worker row loads the
// attested manager's cold log as a live row WITHOUT running it: zero LLM
// calls, no resume_attempt record, no continuation kick. A manual Continue
// completes the withheld resume; an auto reconnect does not. A manager
// holding a resumed question refuses the load and stays a cold row.
//
// Doctrine: no mock.module. The shipped WS server (createWsServer) over a
// run-counting buildAgent; the sidecar-attested TaskManager rides
// registry.setTaskManager (createWsServer's own seam); a fixture notifyHooks
// writer writes the resume_attempt record the quiet load must NOT produce.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { hostname } from "node:os";
import { TMP_PARENT } from "../mocks/io.ts";
import { TaskManager } from "@core/session/task-manager.ts";
import { closeSessionIndex } from "@core/session/session-index.ts";
import { createWsServer } from "@extensions/websocket/server.ts";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { S2C } from "@extensions/websocket/protocol.ts";
import { HOOKS } from "@core/hooks.ts";
import { closePinStore } from "@extensions/websocket/pin-store.ts";
import { createWsMockCore, createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

const SPAWN = Date.parse("2026-11-15T10:00:00.000Z");

const SESSIONS = mkdtempSync(join(TMP_PARENT, "hotdog-quiet-mgr-"));
const SIDECARS = mkdtempSync(join(TMP_PARENT, "hotdog-quiet-mgr-sidecars-"));

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS;
  closeSessionIndex();
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  closeSessionIndex();
  closePinStore();
  try { rmSync(SESSIONS, { recursive: true, force: true }); } catch {}
  try { rmSync(SIDECARS, { recursive: true, force: true }); } catch {}
});

type MockWs = ReturnType<typeof createWsMockWs>;

async function poll<T>(fn: () => T | null | undefined, what: string, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function frames(ws: MockWs): Array<Record<string, unknown>> {
  return ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
}

// A closed conversation log (no open turn) unless `openTurn` appends the
// v2 turn_started without its end; `heldQuestion` ends the log on an
// unanswered question_asked instead.
function mkLog(
  id: string,
  opts: { openTurn?: boolean; heldQuestion?: boolean } = {},
): void {
  const lines: Array<Record<string, unknown>> = [
    { ts: new Date(SPAWN).toISOString(), session_id: id, source: "session_start", content: "", model: "m", profile: "default" },
    { ts: new Date(SPAWN + 1000).toISOString(), session_id: id, source: "input", content: `work on ${id}` },
    { ts: new Date(SPAWN + 2000).toISOString(), session_id: id, source: "llm", content: "done" },
  ];
  if (opts.heldQuestion) {
    lines.push({
      ts: new Date(SPAWN + 3000).toISOString(),
      session_id: id,
      source: "question_asked",
      tool_call_id: "tc-held",
      content: [{ key: "go", prompt: "Go?" }],
    });
  }
  if (opts.openTurn) {
    lines.push({ ts: new Date(SPAWN + 3000).toISOString(), session_id: id, source: "turn_started", content: "" });
  }
  writeFileSync(join(SESSIONS, `${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

interface Fixture {
  path: string;
  tm: TaskManager;
  wsServer: ReturnType<typeof createWsServer>;
  registry: SessionRegistry;
  runCalls: () => number;
  resumeAttemptsIn: (sid: string) => number;
  harnessAdds: () => Array<unknown>;
  fire: (hook: string, data: unknown) => void;
  upgrade: (url: string) => Promise<MockWs>;
  cleanup: () => void;
}

/** One fixture = one fresh-lifetime WS server over a sidecar attesting
 *  task:q<name> as manager->worker. Managers never attest as workers, so
 *  the adoption stamp no-ops on the quiet load by construction. */
function makeFixture(
  name: string,
  links: Array<{ taskId: string; mgr: string; worker: string }>,
  mgrOpts: Record<string, { openTurn?: boolean; heldQuestion?: boolean }> = {},
): Fixture {
  for (const l of links) {
    mkLog(l.mgr, mgrOpts[l.mgr] ?? {});
    mkLog(l.worker);
  }
  const lines: Array<Record<string, unknown>> = [];
  for (const l of links) {
    lines.push({ t: new Date(SPAWN).toISOString(), ev: "spawn", pid: 991, host: hostname(), id: l.taskId, desc: `job ${l.taskId}`, session: l.mgr });
    lines.push({ t: new Date(SPAWN + 1).toISOString(), ev: "agent", id: l.taskId, agent: l.worker });
  }
  const path = join(SIDECARS, `${name}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");

  let runCalls = 0;
  const hooks: Record<string, Array<(d: unknown) => unknown>> = {};
  const added: Array<{ sid: string; msg: unknown }> = [];
  const tm = new TaskManager({
    buildAgent: async () => ({ sessionId: "w", run: async () => undefined, notifyCompletion: () => {} }) as never,
    modelRegistry: {},
    config: {},
    maxIterations: 3,
    taskProfile: "default",
    spawnLogPath: path,
    spawnLogPidAlive: () => false,
  });
  const core = createWsMockCore();
  const wsServer = createWsServer(core, {
    buildAgent: async (config: { sessionId?: string }) => {
      const sid = config.sessionId || "fresh-q";
      return makeWsMockAgent({
        sessionId: sid,
        run: (async () => {
          runCalls++;
        }) as never,
        // The manual-Continue seam: a continuation calls continueRun(),
        // not run().
        continueRun: (async () => {
          runCalls++;
        }) as never,
        addMessage: (msg: { role?: string }) => {
          added.push({ sid, msg });
        },
        hooks: {
          notifyHooks: (hookName: string, payload: unknown) => {
            if (hookName === HOOKS.SESSION_RESUME_ATTEMPT) {
              const p = payload as { sessionId?: string; origin?: string };
              if (p?.sessionId) {
                appendFileSync(
                  join(SESSIONS, `${p.sessionId}.jsonl`),
                  JSON.stringify({
                    ts: new Date().toISOString(),
                    session_id: p.sessionId,
                    source: "resume_attempt",
                    content: { origin: p.origin },
                  }) + "\n",
                );
              }
            }
            return Promise.resolve(undefined);
          },
          runHookPipeline: async () => undefined,
          registerHook: () => {},
          unregisterHook: () => {},
          on: (hook: string, h: (d: unknown) => unknown) => {
            (hooks[hook] ||= []).push(h);
            return () => {};
          },
        } as never,
      });
    },
  } as never);
  const registry = wsServer.sessionRegistry;
  registry.setTaskManager(tm);
  tm.setSessionManager(registry.getSessionManager() as never);
  return {
    path,
    tm,
    wsServer,
    registry,
    runCalls: () => runCalls,
    resumeAttemptsIn: (sid) =>
      readFileSync(join(SESSIONS, `${sid}.jsonl`), "utf8")
        .split("\n")
        .filter((l) => l.includes('"resume_attempt"')).length,
    harnessAdds: () =>
      added.filter((a) => (a.msg as { role?: string }).role === "harness").map((a) => a.msg),
    fire: (hook, data) => {
      for (const h of [...(hooks[hook] ?? [])]) h(data);
    },
    upgrade: async (url: string) => {
      const ws = createWsMockWs();
      wsServer.onUpgrade({ url, headers: { host: "localhost" } }, ws);
      return ws;
    },
    cleanup: () => {
      wsServer.stopTaskManager();
      wsServer.stopCleanupLoop();
      tm.stop();
    },
  };
}

describe("quiet manager revive: attaching the worker loads the manager without a run", () => {
  it("the manager joins the live list (board and all) with zero LLM calls, no record, no kick", async () => {
    const f = makeFixture("basic", [{ taskId: "task:q1", mgr: "qm-mgr", worker: "qm-worker" }]);
    try {
      // A second tab on the wire: broadcasts reach hub-registered sockets,
      // so the frames themselves are asserted here.
      const observer = await f.upgrade("/ws");
      await poll(() => frames(observer).find((m) => m.type === S2C.SESSION_CREATED), "observer attach");

      // The reconnect: the tab's identity is the worker; the attested
      // manager revives quietly.
      const ws = await f.upgrade("/ws?session=qm-worker");
      await poll(
        () => frames(ws).find((m) => m.type === S2C.SESSION_CREATED && m.sessionId === "qm-worker"),
        "worker attach burst",
      );
      const workerRow = f.registry.getRow("qm-worker")!;
      expect(workerRow.kind).toBe("worker");
      expect(workerRow.adoptedWorker).toBe(true);
      const mgrRow = await poll(() => f.registry.getRow("qm-mgr"), "manager row appears");

      // The manager loads as an ORDINARY interactive row (never a worker,
      // never hidden), carrying its board through the liveness overlay.
      expect(mgrRow!.kind).toBeUndefined();
      expect(mgrRow!.quietLoaded).toBe(true);
      expect(mgrRow!.openTurnAtLoad).toBe(false);
      const live = f.registry.list();
      expect(live.map((s) => s.id)).toContain("qm-mgr");
      expect(live.map((s) => s.id)).not.toContain("qm-worker");
      const liveRow = live.find((s) => s.id === "qm-mgr")! as Record<string, unknown>;
      const card = ((liveRow.subagents ?? []) as Array<Record<string, unknown>>).find(
        (t) => t.taskId === "task:q1",
      );
      expect(card?.adoptedLive).toBe(true);
      expect(card?.status).toBe("running");

      // Zero-run oracle: nothing ran, the bus is parked empty, and the
      // manager's log gained no resume_attempt (the worker's gained one).
      expect(f.runCalls()).toBe(0);
      const sm = f.registry.getSessionManager();
      expect(sm.isSessionRunning("qm-mgr")).toBe(false);
      expect(sm.getBus("qm-mgr")?.queueItems.length).toBe(0);
      expect(f.resumeAttemptsIn("qm-mgr")).toBe(0);
      expect(f.resumeAttemptsIn("qm-worker")).toBe(1);

      // The other tabs see the row-transition grammar (cold row leaves
      // under a bumped watermark, then a plain SESSIONS re-list); the
      // requesting tab keeps its pane on the worker (no socket move).
      const removed = frames(observer).find(
        (m) => m.type === S2C.LOG_ROW_REMOVED && m.sessionId === "qm-mgr",
      );
      expect(removed).toBeDefined();
      expect(typeof removed!.gen).toBe("string");
      expect(
        frames(observer).some(
          (m) =>
            m.type === S2C.SESSIONS &&
            (m.sessions as Array<{ id: string }>).some((s) => s.id === "qm-mgr"),
        ),
      ).toBe(true);
      expect((ws as unknown as { activeSessionId: string }).activeSessionId).toBe("qm-worker");

      // The worker settle lands on the quiet manager as a context write.
      f.fire(HOOKS.TURN_END, {
        stopped: true,
        reason: "completion",
        agent: { sessionId: "qm-worker" },
      });
      const notes = await poll(() => {
        const n = f.harnessAdds();
        return n.length > 0 ? n : null;
      }, "adopted-settle notification");
      expect(notes).toHaveLength(1);
      const text = JSON.stringify(notes[0]);
      expect(text).toContain("task:q1");
      expect(text).toContain("restart-adopted");
      expect(text).toContain("run_id");
      expect(f.runCalls()).toBe(0); // a context write wakes nothing
      expect(sm.getBus("qm-mgr")?.queueItems.length).toBe(0);
    } finally {
      f.cleanup();
    }
  });

  it("a manager holding a resumed question refuses the load and stays cold", async () => {
    const f = makeFixture(
      "held",
      [{ taskId: "task:q2", mgr: "qh-mgr", worker: "qh-worker" }],
      { "qh-mgr": { heldQuestion: true } },
    );
    try {
      const observer = await f.upgrade("/ws");
      await poll(() => frames(observer).find((m) => m.type === S2C.SESSION_CREATED), "observer attach");
      const ws = await f.upgrade("/ws?session=qh-worker");
      await poll(
        () => frames(ws).find((m) => m.type === S2C.SESSION_CREATED && m.sessionId === "qh-worker"),
        "worker attach burst",
      );
      expect(f.registry.getRow("qh-worker")!.kind).toBe("worker"); // the worker attaches fine
      expect(f.registry.getRow("qh-mgr")).toBeNull(); // never revived without a client to answer
      expect(f.resumeAttemptsIn("qh-mgr")).toBe(0);
      expect(
        frames(observer).some((m) => m.type === S2C.LOG_ROW_REMOVED && m.sessionId === "qh-mgr"),
      ).toBe(false);
      expect((ws as unknown as { activeSessionId: string }).activeSessionId).toBe("qh-worker");
    } finally {
      f.cleanup();
    }
  });

  it("a manager already live in the book no-ops the revive", async () => {
    const f = makeFixture("already", [{ taskId: "task:q3", mgr: "ql-mgr", worker: "ql-worker" }]);
    try {
      // A spawn-born (or human-opened) manager: the load never fires.
      await f.registry.create({ sessionId: "ql-mgr" });
      const before = f.runCalls();
      const observer = await f.upgrade("/ws");
      await poll(() => frames(observer).find((m) => m.type === S2C.SESSION_CREATED), "observer attach");
      const ws = await f.upgrade("/ws?session=ql-worker");
      await poll(
        () => frames(ws).find((m) => m.type === S2C.SESSION_CREATED && m.sessionId === "ql-worker"),
        "worker attach burst",
      );
      const row = f.registry.getRow("ql-mgr")!;
      expect(row.quietLoaded).toBeUndefined(); // untouched, not re-stamped
      expect(f.runCalls()).toBe(before);
      expect(
        frames(observer).some((m) => m.type === S2C.LOG_ROW_REMOVED && m.sessionId === "ql-mgr"),
      ).toBe(false);
    } finally {
      f.cleanup();
    }
  });

  it("auto reconnect keeps the quiet row quiet; a manual Continue completes the resume", async () => {
    const f = makeFixture(
      "continue",
      [{ taskId: "task:q4", mgr: "qc-mgr", worker: "qc-worker" }],
      { "qc-mgr": { openTurn: true } },
    );
    try {
      const ws = await f.upgrade("/ws?session=qc-worker");
      await poll(
        () => frames(ws).find((m) => m.type === S2C.SESSION_CREATED && m.sessionId === "qc-worker"),
        "worker attach burst",
      );
      const row = await poll(() => f.registry.getRow("qc-mgr"), "manager row appears");
      expect(row!.quietLoaded).toBe(true);
      expect(row!.openTurnAtLoad).toBe(true); // the withheld continuation is on record
      expect(f.runCalls()).toBe(0);

      // Auto reconnect: a tab reload, not a human claim.
      const wsAuto = await f.upgrade("/ws?session=qc-mgr");
      await poll(
        () => frames(wsAuto).find((m) => m.type === S2C.SESSION_CREATED && m.sessionId === "qc-mgr"),
        "manager auto attach",
      );
      expect(row!.quietLoaded).toBe(true);
      expect(f.resumeAttemptsIn("qc-mgr")).toBe(0);
      expect(f.runCalls()).toBe(0);

      // Manual Continue (auto=false): the record lands, the continuation
      // runs, the flag clears.
      const { attachResumedSession } = await import("@extensions/websocket/attach.ts");
      const bridgeStub = {
        peek: () => null,
        cancel: () => {},
        answer: () => false,
        clear: () => {},
      } as never;
      const wsMan = createWsMockWs();
      await attachResumedSession(wsMan, f.registry, bridgeStub, "qc-mgr", 0, false);
      expect(row!.quietLoaded).toBe(false);
      expect(row!.openTurnAtLoad).toBeUndefined();
      await poll(
        () => (f.resumeAttemptsIn("qc-mgr") === 1 ? "one" : null),
        "manual resume_attempt record",
      );
      expect(readFileSync(join(SESSIONS, "qc-mgr.jsonl"), "utf8")).toContain('"origin":"manual"');
      await poll(() => (f.runCalls() === 1 ? "ran" : null), "the continuation turn runs");
    } finally {
      f.cleanup();
    }
  });
});
