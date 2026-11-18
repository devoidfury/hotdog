// Failed-attach re-verification pins (owner ruling 2026-11-18).
// The browser-observed "Error: Session not found" on a running subagent's
// live row was client/server version skew (the field daemon predated the B3
// worker-attach branch). These pins re-run the exact field reproduction over
// the WS protocol against the COMMITTED stack: attach to a RUNNING worker
// session (registry row kind worker) through both client entry points --
// the sidebar switch (C2S switchSession) and the reconnect identity (upgrade
// ?session=<workerSid>) -- including a worker mid-task_followup (a held
// question answered through the manager lane, task still RUNNING). Any
// S2C.ERROR frame on the watcher is the failure the field saw; the attach
// must produce the sessionCreated burst instead. Doctrine: no mock.module.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { TASK_STATUS } from "@core/session/task-types.ts";
import pkg from "@package.json" with { type: "json" };
import { LlmError } from "@core/error.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { TaskManager } from "@core/session/task-manager.ts";
import {
  createWsMockCore,
  createWsMockWs,
  makeWsMockAgent,
} from "../mocks/websocket.ts";
import { TMP_PARENT } from "../helpers.ts";

const SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-sessions-attach-reverify-"));

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try {
    rmSync(SESSIONS_DIR, { recursive: true, force: true });
  } catch {}
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

function frames(ws: MockWs): any[] {
  return ws.messages.map((m) => JSON.parse(m));
}

function byType(ws: MockWs, type: string): any[] {
  return frames(ws).filter((m) => m.type === type);
}

interface Harness {
  wsServer: ReturnType<typeof createWsServer>;
  ws: MockWs;
  mgrSid: string;
  tm: TaskManager;
  taskId: string;
  workerSid: string;
  send: (ws: MockWs, msg: Record<string, unknown>) => void;
  askWorker: (workerAgent: AgentLike) => Promise<Record<string, unknown>>;
  releaseWorkerAgent: () => void;
}

async function makeHarness(): Promise<Harness> {
  const core = createWsMockCore();
  const workerSid = `reverify-worker-${Math.random().toString(36).slice(2, 8)}`;
  const releaseBox: { release?: () => void } = {};
  const buildAgent = async (config: { model?: string; sessionId?: string }): Promise<AgentLike> => {
    if (config.sessionId) {
      return makeWsMockAgent({ sessionId: config.sessionId, model: config.model || "test-model" });
    }
    const worker = makeWsMockAgent({
      sessionId: workerSid,
      model: config.model || "test-model",
      abortSignal: null,
      run: () =>
        new Promise<never>((res, rej) => {
          releaseBox.release = () => res(undefined as never);
          (worker as unknown as { abortSignal: AbortSignal }).abortSignal.addEventListener(
            "abort",
            () => rej(LlmError.Cancelled("aborted")),
            { once: true },
          );
        }),
    });
    return worker;
  };
  const wsServer = createWsServer(core, { buildAgent: buildAgent as never });
  const ws = createWsMockWs();
  wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
  await poll(() => ws.messages.some((m) => JSON.parse(m).type === S2C.SESSION_CREATED), "manager attach");
  const mgrSid = (ws as unknown as any).activeSessionId as string;
  const tm = wsServer.sessionRegistry.getTaskManager()!;
  const taskId = `reverify-task-${Math.random().toString(36).slice(2, 8)}`;
  await tm.spawnTask(taskId, "work", {
    workerModel: "test-model",
    managerAgent: { sessionId: mgrSid },
  } as never);
  await poll(() => tm._test_tasks.get(taskId)!.agent, "worker agent build");
  await poll(() => wsServer.sessionRegistry.getRow(workerSid), "worker row");

  function inputForAgent(agent: AgentLike): any {
    const handlers = core._registeredHooks["agent:toolContext"];
    const store: Record<string, unknown> = {};
    handlers[0]!({
      toolCtx: { get: (k: string) => store[k], set: (k: string, v: unknown) => { store[k] = v; } },
      toolName: "question",
      agent,
    });
    return store["input"];
  }

  return {
    wsServer,
    ws,
    mgrSid,
    tm,
    taskId,
    workerSid,
    send: (sock, msg) => wsServer.onMessage(sock, JSON.stringify(msg)),
    askWorker: async (workerAgent) => inputForAgent(workerAgent).collectAnswers([{ key: "q", prompt: "Q?" }]),
    releaseWorkerAgent: () => releaseBox.release?.(),
  };
}

function cleanup(h: Harness) {
  h.wsServer.stopTaskManager();
  h.wsServer.stopCleanupLoop();
}

describe("Re-verification: a RUNNING worker session attaches", () => {
  it("sidebar switchSession to the running worker sid: sessionCreated burst, ZERO error frames", async () => {
    const h = await makeHarness();
    try {
      const row = h.wsServer.sessionRegistry.getRow(h.workerSid)!;
      expect(row.kind).toBe("worker");

      const w = createWsMockWs();
      h.wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, w);
      await poll(() => byType(w, S2C.SESSION_CREATED).length > 0, "watcher default attach");
      await h.send(w, { type: C2S.SWITCH_SESSION, sessionId: h.workerSid });

      const created = await poll(
        () => byType(w, S2C.SESSION_CREATED).find((m) => m.sessionId === h.workerSid),
        "worker sessionCreated",
      );
      expect(created.kind).toBe("subagent");
      // The burst completes (cursor report ends it) with NO error frame of
      // any kind -- the field failure was the bare "Session not found".
      await poll(
        () => byType(w, S2C.SESSION_STATE).find((m) => m.sessionId === h.workerSid && m.key === "cursor"),
        "cursor report",
      );
      expect(frames(w).filter((m) => m.type === S2C.ERROR)).toHaveLength(0);
    } finally {
      cleanup(h);
    }
  });

  it("task_followup mid-run: question answered via the manager lane, worker still RUNNING; fresh sockets still attach", async () => {
    const h = await makeHarness();
    try {
      const worker = h.tm._test_tasks.get(h.taskId)!.agent!;
      const pending = h.askWorker(worker);
      // The manager answers over its lane (task_followup's server-side path);
      // the task stays RUNNING with the run in flight.
      expect(h.tm.sendFollowUp(h.taskId, "the answer")).toBe(true);
      expect(await pending).toEqual({ q: "the answer" });
      expect(h.tm.taskWorkingForAgentSession(h.workerSid)).toBe(true);

      // Sidebar entry point (switchSession).
      const w = createWsMockWs();
      h.wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, w);
      await poll(() => byType(w, S2C.SESSION_CREATED).length > 0, "watcher default attach");
      await h.send(w, { type: C2S.SWITCH_SESSION, sessionId: h.workerSid });
      const created = await poll(
        () => byType(w, S2C.SESSION_CREATED).find((m) => m.sessionId === h.workerSid),
        "worker sessionCreated after followup",
      );
      expect(created.kind).toBe("subagent");
      expect(frames(w).filter((m) => m.type === S2C.ERROR)).toHaveLength(0);

      // Reconnect-identity entry point (upgrade ?session=).
      const w2 = createWsMockWs();
      h.wsServer.onUpgrade(
        { url: `/ws?session=${h.workerSid}`, headers: { host: "localhost" } },
        w2,
      );
      const created2 = await poll(
        () => byType(w2, S2C.SESSION_CREATED).find((m) => m.sessionId === h.workerSid),
        "worker attach via upgrade session param",
      );
      expect(created2.kind).toBe("subagent");
      expect(frames(w2).filter((m) => m.type === S2C.ERROR)).toHaveLength(0);

      // Release the hung mock run so cleanup leaves nothing dangling.
      h.releaseWorkerAgent();
      await poll(
        () => (h.tm.taskStatus(h.taskId) === TASK_STATUS.COMPLETED ? 1 : null),
        "worker run unwinds",
      );
    } finally {
      cleanup(h);
    }
  });
});

// ── The handshake carries the daemon's build stamp (additively) ──────────

describe("authOk version stamp (additive handshake field)", () => {
  it("a valid AUTH is answered with authOk carrying the daemon's package version", async () => {
    const core = createWsMockCore();
    const auth = { validateToken: (t: string) => t === "good" };
    const wsServer = createWsServer(core, {
      buildAgent: async (config: { model?: string; sessionId?: string }) =>
        makeWsMockAgent({ sessionId: config.sessionId || "test", model: "test-model" }),
      auth: auth as never,
    });
    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    expect(frames(ws).some((m) => m.type === S2C.AUTH_REQUIRED)).toBe(true);
    wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH, token: "good" }));
    const ok = await poll(() => frames(ws).find((m) => m.type === S2C.AUTH_OK) ?? null, "authOk");
    expect(ok.version).toBe(pkg.version);
    wsServer.stopTaskManager();
    wsServer.stopCleanupLoop();
  });
});
