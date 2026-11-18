// B1 worker-row foundation pins: rows born with a birth kind, worker rows
// invisible to the interactive projection (list/size/attach fallback), the
// registerWorker/releaseWorker mechanics, the sweep guards (R2: a
// watched-by-nobody RUNNING worker is the NORMAL state; released worker rows
// sweep free of the hot window), and the server-side terminal release
// (releaseWorker + bridge.dropSession -- the #inputs leak-gone proof).
// House doctrine: no mock.module -- real registries, real bridges, real
// TaskManagers, mock agents/sockets only.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { createWsServer } from "@extensions/websocket/server.ts";
import { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import { attachToMostRecentSession } from "@extensions/websocket/attach.ts";
import type { HotdogServerSocket } from "@extensions/websocket/socket.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { WorkerSessionStartedInfo } from "@core/session/task-types.ts";
import { TASK_STATUS } from "@core/session/task-types.ts";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import { LlmError } from "@core/error.ts";
import {
  createWsMockCore,
  createWsMockAgentFactory,
  createWsMockWs,
  makeWsMockAgent,
} from "../mocks/websocket.ts";
import { TMP_PARENT } from "../helpers.ts";

// Isolated sessions dir: registerWorker seeds the writer-side record count
// off the sessions dir, and create() writes logs -- keep it out of the real
// data dir.
const SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-sessions-worker-rows-"));

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

/** Poll until fn() returns truthy; fails loudly on timeout. */
async function poll<T>(fn: () => T | null | undefined, what: string, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function lastMessage(ws: MockWs): any {
  return JSON.parse(ws.messages[ws.messages.length - 1]!);
}

/** A worker-row registration info, with the ACCESSOR posture the real seam
 *  carries: getAgent() reads a live holder, not a captured handle. */
function makeWorkerInfo(overrides: Partial<WorkerSessionStartedInfo> = {}) {
  const sid = overrides.workerSid ?? "worker-sid-1";
  const agent = makeWsMockAgent({ sessionId: sid, model: "prov/worker-model" });
  let live: AgentLike | null = agent;
  const info: WorkerSessionStartedInfo = {
    taskId: "run1:step2#1",
    workerSid: sid,
    managerSid: "manager-sid-1",
    profile: "task",
    getAgent: () => live,
    ...overrides,
  };
  return {
    info,
    agent,
    /** Simulates the finalizeTurn release (entry.agent = null). */
    releaseAgent: () => {
      live = null;
    },
  };
}

// ── Row birth, projection, and the live-session oracle ─────────────────────

describe("worker row birth and interactive-only projection", () => {
  let registry: SessionRegistry;

  afterEach(() => {
    registry?.stopCleanupLoop();
  });

  it("registerWorker creates a book row with the D4 linkage as DISTINCT ids", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { sessionId: interactiveId } = await registry.create();
    const { info } = makeWorkerInfo();
    registry.registerWorker(info);

    const row = registry._test_metadata.get("worker-sid-1")!;
    expect(row).toBeDefined();
    expect(row.kind).toBe("worker");
    // Three distinct ids, never conflated: the row key IS the worker sid
    // (entry.agentSessionId); taskId is the TaskManager spawn id;
    // parentSessionId is the delegating manager's session.
    expect(row.taskId).toBe("run1:step2#1");
    expect(row.parentSessionId).toBe("manager-sid-1");
    expect(row.parentSessionId).not.toBe("run1:step2#1");
    expect(row.profile).toBe("task");
    expect(row.model).toBe("prov/worker-model");
    expect(row.connectedClients).toBe(0);
    expect(typeof row.createdAt).toBe("number");
    expect(row.workerTerminal).toBeFalsy();
    // Interactive rows never write the attribute: absent reads interactive,
    // so every pre-B1 path is byte-identical.
    expect(registry._test_metadata.get(interactiveId)!.kind).toBeUndefined();
  });

  it("list() and size are interactive-only; no worker row ever enters the payload", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { sessionId: interactiveId } = await registry.create();
    registry.registerWorker(makeWorkerInfo().info);

    const rows = registry.list();
    expect(rows.map((r) => r.id)).toEqual([interactiveId]);
    // No wire shape change either: the payload rows carry no kind field.
    for (const r of rows) {
      expect("kind" in r).toBe(false);
      expect("taskId" in r).toBe(false);
    }
    expect(registry.size).toBe(1);

    // Workers only: the projection (and with it the attach fallback gate)
    // reads as an empty book.
    const bare = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    bare.registerWorker(makeWorkerInfo({ workerSid: "worker-only" }).info);
    expect(bare.list()).toEqual([]);
    expect(bare.size).toBe(0);
    bare.stopCleanupLoop();
  });

  it("get() stays the live-agent oracle: getBus(workerSid) is undefined after registerWorker", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    registry.registerWorker(makeWorkerInfo().info);
    const manager = registry.getSessionManager();
    // Book-only: NO registration with the private SessionManager -- no bus,
    // no run loop. The manager-side oracle keeps telling the truth.
    expect(manager.getBus("worker-sid-1")).toBeUndefined();
    expect(manager.getAgentBySessionId("worker-sid-1")).toBeUndefined();
    // get() (every handler gate rides it) keeps refusing the worker sid with
    // the pre-B1 posture; the raw row accessor sees it.
    expect(registry.get("worker-sid-1")).toBeNull();
    expect(registry.getRow("worker-sid-1")?.kind).toBe("worker");
  });

  it("attachToMostRecentSession can never land a user on a worker row", async () => {
    registry = new SessionRegistry({
      buildAgent: createWsMockAgentFactory(),
      // sessionCreatedPayload reads the plane posture per attach; the mock
      // host stands in for a resolved bag.
      toolExecResolved: { toolExec: "inline", execFence: "probe" },
    });
    const bridge = new WebSocketQuestionBridge({
      getPolicy: () => ({ strategy: "wait", timeoutSecs: 300 }),
      hasChannels: (sid) => registry.hasChannels(sid),
      interrupt: () => {},
    });

    // Only a worker row in the book: the fallback creates a fresh
    // interactive session instead (registry.size reads 0).
    const ws = createWsMockWs();
    await attachToMostRecentSession(ws as unknown as HotdogServerSocket, registry, bridge);
    expect(ws.activeSessionId).toBeTruthy();
    expect(ws.activeSessionId).not.toBe("worker-sid-1");
    expect(registry.getRow(ws.activeSessionId!)?.kind).toBeUndefined();

    // A worker row NEWER than the interactive one still cannot win: the
    // most-recent scan reads list(), which excludes it.
    const { sessionId: interactiveId } = await registry.create();
    // Pin the clocks apart: attachToMostRecentSession scans with a strict
    // `>`, so a same-millisecond tie with the session the empty-book attach
    // just created would keep the map-order first row. The asserted identity
    // must not ride the clock.
    registry._test_metadata.get(interactiveId)!.lastActivityAt = Date.now() + 1_000;
    registry.registerWorker(makeWorkerInfo({ workerSid: "worker-newer" }).info);
    registry._test_metadata.get("worker-newer")!.lastActivityAt = Date.now() + 10_000;
    const ws2 = createWsMockWs();
    await attachToMostRecentSession(ws2 as unknown as HotdogServerSocket, registry, bridge);
    expect(ws2.activeSessionId).toBe(interactiveId);
    expect(registry.getRow(ws2.activeSessionId!)?.kind).toBeUndefined();
    bridge.clear();
    registry.stopCleanupLoop();
  });
});

// ── registerWorker / releaseWorker mechanics ───────────────────────────────

describe("registerWorker / releaseWorker mechanics", () => {
  let registry: SessionRegistry;

  afterEach(() => {
    registry?.stopCleanupLoop();
  });

  it("registerWorker is idempotent on a double event (the row is never replaced)", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { info } = makeWorkerInfo();
    registry.registerWorker(info);
    const row = registry._test_metadata.get("worker-sid-1")!;
    row.ctxUsed = 7; // mutate: a re-registration must not clobber the row
    const sizeBefore = registry._test_metadata.size;
    registry.registerWorker(info);
    expect(registry._test_metadata.size).toBe(sizeBefore);
    expect(registry._test_metadata.get("worker-sid-1")).toBe(row);
    expect(row.ctxUsed).toBe(7);
  });

  it("releaseWorker on an unknown sid is a no-op (interactive rows too)", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { sessionId } = await registry.create();
    registry.releaseWorker("never-registered");
    expect(registry._test_metadata.get("never-registered")).toBeUndefined();

    // An interactive row is not a worker: releasing must not mark or kill it.
    registry.releaseWorker(sessionId);
    const meta = registry._test_metadata.get(sessionId)!;
    expect(meta.workerTerminal).toBeUndefined();
    expect(registry.get(sessionId)).not.toBeNull();
  });

  it("releaseWorker marks the row terminal and nulls the accessor (channels are NOT force-closed)", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { info, agent } = makeWorkerInfo();
    registry.registerWorker(info);
    const row = registry._test_metadata.get("worker-sid-1")!;
    // The accessor reads the LIVE entry while the task runs.
    expect(row.getAgent!()).toBe(agent);

    registry.releaseWorker("worker-sid-1");
    expect(row.workerTerminal).toBe(true);
    expect(row.getAgent).toBeNull();
    // The row itself stays in the book (frames stop; no yank) -- reclaim is
    // the idle sweep's job. Repeated release stays a no-op.
    expect(registry._test_metadata.get("worker-sid-1")).toBe(row);
    registry.releaseWorker("worker-sid-1");
    expect(registry._test_metadata.get("worker-sid-1")).toBe(row);
  });

  it("release reclaims the manager's event-handler key; a re-registered worker subscribes cleanly", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const manager = registry.getSessionManager();
    registry.registerWorker(makeWorkerInfo().info);
    const emitUsage = (tokens: number) =>
      manager.emitToChannels("worker-sid-1", {
        type: OUTPUT_EVENT.TOKEN_USAGE,
        totalTokens: tokens,
        contextWindow: 4096,
      } as unknown as OutputEvent);
    emitUsage(111);
    expect(registry._test_metadata.get("worker-sid-1")!.ctxUsed).toBe(111);

    // Release unsubscribes the mirror; the empty set reclaims its
    // #eventHandlers key (emitToChannels reads absent like empty: inert,
    // no throw).
    registry.releaseWorker("worker-sid-1");
    emitUsage(222);
    expect(registry._test_metadata.get("worker-sid-1")!.ctxUsed).toBe(111);

    // Sweep the released row, then a worker event for the SAME sid: the
    // re-registration recreates the manager's handler set and the fresh
    // row's mirror works byte-clean (no dead key blocking the resubscribe).
    registry._test_metadata.get("worker-sid-1")!.lastActivityAt = Date.now() - 100 * 60 * 1000;
    registry._test_cleanupIdleSessions();
    expect(registry._test_metadata.get("worker-sid-1")).toBeUndefined();
    registry.registerWorker(makeWorkerInfo().info);
    const fresh = registry._test_metadata.get("worker-sid-1")!;
    expect(fresh.kind).toBe("worker");
    expect(fresh.workerTerminal).toBeFalsy();
    emitUsage(333);
    expect(fresh.ctxUsed).toBe(333);
  });

  it("the stored accessor goes null when the entry's agent is nulled (finalizeTurn order)", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { info, agent, releaseAgent } = makeWorkerInfo();
    registry.registerWorker(info);
    const row = registry._test_metadata.get("worker-sid-1")!;
    expect(row.getAgent!()).toBe(agent);
    // finalizeTurn nulls entry.agent (task-execution.ts) BEFORE any terminal
    // observer release lands: the accessor reads null from that moment -- the
    // log becomes the only transcript source (the TaskEntry contract).
    releaseAgent();
    expect(row.getAgent!()).toBeNull();
  });

  it("worker rows refuse the handler-facing mutations exactly like unknown ids", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    registry.registerWorker(makeWorkerInfo().info);
    expect(registry.delete("worker-sid-1")).toBe(false);
    expect(registry.rename("worker-sid-1", "hijack")).toBe(false);
    expect(registry.setQuestionPending("worker-sid-1", true)).toBe(false);
    await expect(registry.fork("worker-sid-1", { cut: { kind: "head" } })).rejects.toThrow(
      "Cannot fork unknown session",
    );
    await expect(registry.switchProfile({ sessionId: "worker-sid-1", profileName: "x" })).resolves.toEqual({
      success: false,
      error: "Session not found",
    });
    // The row is untouched by all of the above.
    const row = registry._test_metadata.get("worker-sid-1")!;
    expect(row.title).toBeNull();
    expect(row.questionPending).toBeUndefined();
    expect(row.workerTerminal).toBeUndefined();
  });
});

// ── Idle sweep vs worker rows ──────────────────────────────────────────────

describe("idle sweep guards (R2 posture: client metrics are interactive-only)", () => {
  let registry: SessionRegistry;

  afterEach(() => {
    registry?.stopCleanupLoop();
  });

  const stale = (id: string, minutes = 100) => {
    const meta = registry._test_metadata.get(id)!;
    meta.lastActivityAt = Date.now() - minutes * 60 * 1000;
  };

  it("NEVER reclaims a non-terminal worker row with zero clients, and worker rows never consume a hot slot", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    // Four stale interactive rows: the three most recently active stay hot,
    // the oldest goes cold -- byte-identical interactive policy. A stale
    // RUNNING (never released) worker with zero clients -- the NORMAL state
    // of an unwatched worker -- must survive, and must not push an
    // interactive row out of the hot window by occupying a slot.
    const created: string[] = [];
    for (let i = 0; i < 4; i++) {
      const r = await registry.create();
      stale(r.sessionId, 100 + i); // i=0 most recent
      created.push(r.sessionId);
    }
    registry.registerWorker(makeWorkerInfo().info);
    stale("worker-sid-1");
    expect(registry._test_metadata.get("worker-sid-1")!.connectedClients).toBe(0);

    registry._test_cleanupIdleSessions();

    expect(registry._test_metadata.get("worker-sid-1")).toBeDefined(); // RUNNING worker survives
    expect(registry.get(created[0]!)).not.toBeNull();
    expect(registry.get(created[1]!)).not.toBeNull();
    expect(registry.get(created[2]!)).not.toBeNull();
    expect(registry.get(created[3]!)).toBeNull(); // the 4th interactive goes cold
  });

  it("sweeps released worker rows with zero clients -- WITHOUT the hot-window exemption", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    for (let i = 0; i < 4; i++) {
      registry.registerWorker(makeWorkerInfo({ workerSid: `worker-${i}` }).info);
    }
    for (let i = 0; i < 4; i++) {
      registry.releaseWorker(`worker-${i}`);
      stale(`worker-${i}`, 100 + i);
    }
    registry._test_cleanupIdleSessions();
    // MAX_HOT_IDLE_SESSIONS is 3 -- an exemption would keep one alive. A
    // settled worker returns only through cold-log Continue-adoption.
    for (let i = 0; i < 4; i++) {
      expect(registry._test_metadata.get(`worker-${i}`)).toBeUndefined();
    }
  });

  it("skips a released worker row that still holds a channel (no yank)", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    registry.registerWorker(makeWorkerInfo().info);
    registry.releaseWorker("worker-sid-1");
    stale("worker-sid-1");
    registry._test_metadata.get("worker-sid-1")!.connectedClients = 1; // watcher mid-read
    registry._test_cleanupIdleSessions();
    expect(registry._test_metadata.get("worker-sid-1")).toBeDefined();
  });
});

// ── Server wiring: birth at the seam, terminal release, the #inputs leak ───

describe("server wiring: register at the seam, release + dropSession at terminal", () => {
  let core: any;
  let wsServer: ReturnType<typeof createWsServer>;

  afterEach(() => {
    wsServer?.stopTaskManager();
    wsServer?.stopCleanupLoop();
  });

  /** Drive the server's AGENT_TOOL_CONTEXT seam for one agent; returns the
   *  QuestionInput the bridge handed out (identity: the bridge's #inputs
   *  entry for that session). */
  function inputForAgent(agent: AgentLike): {
    input: { collectAnswers: (qs: Array<Record<string, unknown>>) => Promise<Record<string, unknown>> };
  } {
    const handlers = core._registeredHooks["agent:toolContext"];
    expect(handlers).toHaveLength(1);
    const store: Record<string, unknown> = {};
    const toolCtx = {
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => {
        store[k] = v;
      },
    };
    handlers[0]!({ toolCtx, toolName: "question", agent });
    const input = store["input"] as any;
    expect(input).toBeDefined();
    return { input };
  }

  it("worker row is born on spawn, released at terminal, and the bridge #inputs entry is dropped (leak-gone)", async () => {
    core = createWsMockCore();
    // Task workers (no sessionId in their config) hang until the abort
    // signal fires, like a live in-flight turn. User sessions get the usual
    // mock agent.
    const buildAgent = async (config: { model?: string; sessionId?: string }): Promise<AgentLike> => {
      if (config.sessionId) {
        return makeWsMockAgent({ sessionId: config.sessionId, model: config.model || "test-model" });
      }
      const worker = makeWsMockAgent({
        sessionId: "worker-live-1",
        model: config.model || "test-model",
        abortSignal: null,
        run: () =>
          new Promise<never>((_res, rej) => {
            (worker as unknown as { abortSignal: AbortSignal }).abortSignal.addEventListener(
              "abort",
              () => rej(LlmError.Cancelled("aborted")),
              { once: true },
            );
          }),
      });
      return worker;
    };

    wsServer = createWsServer(core, { buildAgent, questionStrategy: "wait", questionTimeoutSecs: 300 });
    const registry = wsServer.sessionRegistry;

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await poll(
      () => ws.messages.some((m) => JSON.parse(m).type === S2C.SESSION_CREATED),
      "session created",
    );
    const mgrSid = (ws as unknown as HotdogServerSocket).activeSessionId!;

    const tm = registry.getTaskManager()!;
    await tm.spawnTask("task-live", "work", {
      workerModel: "test-model",
      managerAgent: { sessionId: mgrSid },
    });
    const workerAgent = await poll(() => tm._test_tasks.get("task-live")!.agent, "worker agent build");
    // BIRTH: the onWorkerSessionStarted seam registered the row (before the
    // first turn -- the task is still RUNNING and in its turn here).
    const row = await poll(() => registry._test_metadata.get("worker-live-1"), "worker row birth");
    expect(row.kind).toBe("worker");
    expect(row.taskId).toBe("task-live");
    expect(row.parentSessionId).toBe(mgrSid);
    expect(row.getAgent!()).toBe(workerAgent); // the live accessor holds the agent
    // The interactive projection never sees it...
    expect(registry.list().map((r) => r.id)).toEqual([mgrSid]);
    // ...and the private manager has no bus for it.
    expect(registry.getSessionManager().getBus("worker-live-1")).toBeUndefined();

    // The worker blocks in a question through the real bridge seam.
    const inputBefore = inputForAgent(workerAgent!).input;
    const beforeCount = ws.messages.length;
    let workerAnswer: Record<string, unknown> | null = null;
    inputBefore
      .collectAnswers([{ key: "q", prompt: "Q?" }])
      .then((a) => {
        workerAnswer = a;
      });
    // Badge hygiene: the flip onto a hidden row must not add a SESSIONS
    // broadcast frame (worker badges are B2's nested task-row posture).
    expect(ws.messages.slice(beforeCount).some((m) => JSON.parse(m).type === S2C.SESSIONS)).toBe(false);

    // Kill the worker: terminal event -> releaseWorker + bridge.dropSession.
    expect(tm.interruptTask("task-live")).toBe(true);
    await poll(() => {
      const s = tm.taskStatus("task-live");
      return s === TASK_STATUS.CANCELLED ? s : null;
    }, "cancellation");

    // Release: terminal-marked, accessor nulled, row kept until the sweep.
    await poll(() => (row.workerTerminal ? true : null), "worker row release");
    expect(row.getAgent).toBeNull();
    // The pending settles as a cancel (dropSession cancels before deleting).
    const settledAnswer = await poll(() => workerAnswer, "worker pending settle");
    expect(settledAnswer).toEqual({ q: "" });
    // LEAK-GONE: dropSession deleted the bridge's #inputs entry for the
    // worker sid. Proof without a new seam: the next inputFor for that sid
    // must come back as a FRESH object (the stale entry no longer in the map).
    const inputAfter = inputForAgent(workerAgent!).input;
    expect(inputAfter).not.toBe(inputBefore);

    // The interactive session is untouched by the whole worker lifecycle.
    expect(registry.get(mgrSid)).not.toBeNull();
    expect(registry.list().map((r) => r.id)).toEqual([mgrSid]);
  });

  it("interactive question flow answers exactly as today with a worker row in the book", async () => {
    core = createWsMockCore();
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      questionStrategy: "wait",
      questionTimeoutSecs: 300,
    });
    const registry = wsServer.sessionRegistry;

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await poll(() => (ws as unknown as HotdogServerSocket).activeSessionId, "session attach");
    const mgrSid = (ws as unknown as HotdogServerSocket).activeSessionId!;

    // A worker row exists in the book while the interactive flow runs.
    registry.registerWorker(makeWorkerInfo({ workerSid: "worker-interloper" }).info);

    const mgrAgent = registry.get(mgrSid)!.agent;
    const { input } = inputForAgent(mgrAgent);
    let answer: Record<string, unknown> | null = null;
    input.collectAnswers([{ key: "mq", prompt: "M?" }]).then((a) => {
      answer = a;
    });
    await wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId: mgrSid, answers: { mq: "real answer" } }),
    );
    expect(lastMessage(ws).type).toBe(S2C.QUESTION_ANSWERED);
    const settled = await poll(() => answer, "interactive answer lands");
    expect(settled).toEqual({ mq: "real answer" });
    // The badge flipped on the interactive row only.
    expect(registry._test_metadata.get(mgrSid)!.questionPending).toBe(false);
  });
});
