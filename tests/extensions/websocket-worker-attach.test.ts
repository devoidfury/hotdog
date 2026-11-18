// B3 observer-attach pins (design (d) "optional-observer attach" + (b)
// "Live output" + (e)-B3): the zero-watcher live-tail gate (R2 "zero
// watchers pays nothing", spy-pinned), the session-grammar tail for a
// mid-run watcher (incl. S2C.QUESTION, structurally impossible on the
// relay), the full kind-aware refusal table, scope isolation both ways,
// additive sessionCreated (kind:"subagent" + parentSessionId, omitted on
// interactive), the task-inRun `working` source, and null-tolerant
// released-agent attaches. Doctrine: no mock.module -- real servers, real
// TaskManagers, real bridges; mock agents/sockets only.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { unansweredReason } from "@core/context/input.ts";
import { LlmError } from "@core/error.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { TaskManager } from "@core/session/task-manager.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import { TASK_STATUS } from "@core/session/task-types.ts";
import {
  createWsMockCore,
  createWsMockWs,
  makeWsMockAgent,
} from "../mocks/websocket.ts";
import { TMP_PARENT } from "../helpers.ts";

const SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-sessions-worker-attach-"));

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
type WsServer = ReturnType<typeof createWsServer>;

async function poll<T>(fn: () => T | null | undefined, what: string, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function frames(ws: MockWs): any[] {
  return ws.messages.map((m) => JSON.parse(m));
}

function byType(ws: MockWs, type: string): any[] {
  return frames(ws).filter((m) => m.type === type);
}

/** Frames on a socket carrying the WORKER's session scope. */
function workerScoped(ws: MockWs, workerSid: string): any[] {
  return frames(ws).filter((m) => m.sessionId === workerSid);
}

interface Harness {
  core: any;
  wsServer: WsServer;
  reg: WsServer["sessionRegistry"];
  ws: MockWs;
  mgrSid: string;
  tm: TaskManager;
  taskId: string;
  workerSid: string;
  /** The task agent's REAL sink (spawn forwarding): events emitted here
   *  reach the observer exactly as a live worker's OutputEvents do. */
  emit: (event: unknown) => void;
  releaseWorkerAgent: () => void;
  // onMessage is typed void on the server surface; at runtime it returns the
  // routing promise, so `await h.send(...)` waits for the handler (B2 idiom).
  send: (ws: MockWs, msg: Record<string, unknown>) => void;
  /** Ask a worker question through the server's real bridge seam (B2 idiom). */
  askWorker: (workerAgent: AgentLike) => Promise<Record<string, unknown>>;
}

async function makeHarness(
  opts: { questionStrategy?: string; questionTimeoutSecs?: number } = {},
): Promise<Harness> {
  const core = createWsMockCore();
  const workerSid = `worker-attach-${Math.random().toString(36).slice(2, 8)}`;
  const releaseBox: { release?: () => void } = {};
  const sinkBox: { emit?: (event: unknown) => void } = {};
  const buildAgent = async (config: { model?: string; sessionId?: string; sink?: { emit: (event: unknown) => void } }): Promise<AgentLike> => {
    if (config.sessionId) {
      return makeWsMockAgent({ sessionId: config.sessionId, model: config.model || "test-model" });
    }
    sinkBox.emit = config.sink?.emit?.bind(config.sink);
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
  const wsServer = createWsServer(core, {
    buildAgent: buildAgent as never,
    ...(opts.questionStrategy !== undefined ? { questionStrategy: opts.questionStrategy } : {}),
    ...(opts.questionTimeoutSecs !== undefined
      ? { questionTimeoutSecs: opts.questionTimeoutSecs }
      : {}),
  });
  const ws = createWsMockWs();
  wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
  await poll(() => ws.messages.some((m) => JSON.parse(m).type === S2C.SESSION_CREATED), "manager attach");
  const mgrSid = (ws as unknown as any).activeSessionId as string;
  const tm = wsServer.sessionRegistry.getTaskManager()!;
  const taskId = `task-${Math.random().toString(36).slice(2, 8)}`;
  await tm.spawnTask(taskId, "work", {
    workerModel: "test-model",
    managerAgent: { sessionId: mgrSid },
  } as never);
  await poll(() => tm._test_tasks.get(taskId)!.agent, "worker agent build");
  // B1 seam: the worker row is born at the recordAgentSession site.
  await poll(() => wsServer.sessionRegistry.getRow(workerSid), "worker row");

  function inputForAgent(agent: AgentLike): any {
    const handlers = core._registeredHooks["agent:toolContext"];
    expect(handlers).toHaveLength(1);
    const store: Record<string, unknown> = {};
    handlers[0]!({ toolCtx: { get: (k: string) => store[k], set: (k: string, v: unknown) => { store[k] = v; } }, toolName: "question", agent });
    return store["input"];
  }

  return {
    core,
    wsServer,
    reg: wsServer.sessionRegistry,
    ws,
    mgrSid,
    tm,
    taskId,
    workerSid,
    emit: (event) => sinkBox.emit?.(event),
    releaseWorkerAgent: () => releaseBox.release?.(),
    send: (sock, msg) => wsServer.onMessage(sock, JSON.stringify(msg)),
    askWorker: async (workerAgent) => inputForAgent(workerAgent).collectAnswers([{ key: "q", prompt: "Q?" }]),
  };
}

function cleanup(h: Harness) {
  h.wsServer.stopTaskManager();
  h.wsServer.stopCleanupLoop();
}

/** Attach a second socket (upgrades onto the manager) and switch it to the
 *  worker sid -- the mid-run watcher. */
async function watchWorker(h: Harness): Promise<MockWs> {
  const w = createWsMockWs();
  h.wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, w);
  await poll(() => w.messages.some((m) => JSON.parse(m).type === S2C.SESSION_CREATED), "watcher attach");
  await h.send(w, { type: C2S.SWITCH_SESSION, sessionId: h.workerSid });
  return w;
}

// ── R2: the zero-watcher gate ────────────────────────────────────────────────

describe("live-tail producer: zero watchers pays nothing (R2)", () => {
  it("emits nothing and maps nothing unwatched; maps + delivers while watched; stops on detach", async () => {
    const h = await makeHarness();
    try {
      // A second connected socket, attached to the MANAGER (never to the
      // worker): the relay's manager-scoped buffering is B4's cost and is
      // NOT counted here -- only worker-scoped frames.
      const mgrWatcher = createWsMockWs();
      h.wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, mgrWatcher);
      await poll(() => mgrWatcher.messages.some((m) => JSON.parse(m).type === S2C.SESSION_CREATED), "attach");

      // Spies on the facade seam the producer uses (instance patches, no
      // mock.module): the gate must run for every event, publish must not
      // run at all with zero channels. Mapping happens strictly between
      // them (code order gate -> map -> publish).
      let gateCalls = 0;
      let publishCalls = 0;
      const origCount = h.reg.channelCount.bind(h.reg);
      const origPublish = h.reg.publish.bind(h.reg);
      (h.reg as any).channelCount = (sid: string) => {
        if (sid === h.workerSid) gateCalls++;
        return origCount(sid);
      };
      (h.reg as any).publish = (sid: string, frame: Record<string, unknown>) => {
        if (sid === h.workerSid) publishCalls++;
        return origPublish(sid, frame);
      };

      const events = [
        { type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: '{"command":"ls"}', toolCallId: "call-1" },
        { type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", content: "ok", toolCallId: "call-1" },
        { type: OUTPUT_EVENT.QUESTION, questions: [{ key: "q", prompt: "Q?" }] },
        { type: OUTPUT_EVENT.USER_MESSAGE, content: "steered" },
      ];
      for (const ev of events) h.emit(ev);
      await sleep(20);

      expect(gateCalls).toBe(events.length); // gate ran per event
      expect(publishCalls).toBe(0); // zero watchers: no mapping, no delivery
      expect(workerScoped(h.ws, h.workerSid).length).toBe(0);
      expect(workerScoped(mgrWatcher, h.workerSid).length).toBe(0);

      // The mid-run watcher pays attention: frames now flow worker-scoped.
      const w = await watchWorker(h);
      const publishAfterAttach = publishCalls;
      for (const ev of events) h.emit(ev);
      await sleep(20);
      expect(publishCalls).toBe(publishAfterAttach + events.length);
      const wf = workerScoped(w, h.workerSid);
      const toolCall = wf.find((m) => m.type === S2C.TOOL_CALL);
      expect(toolCall?.toolCallId).toBe("call-1");
      expect(wf.find((m) => m.type === S2C.TOOL_RESULT)?.toolCallId).toBe("call-1");
      expect(wf.find((m) => m.type === S2C.QUESTION)?.questions[0].key).toBe("q");
      expect(wf.find((m) => m.type === S2C.USER_MESSAGE)?.content).toBe("steered");
      // The manager watchers still carry ZERO worker-scoped frames.
      expect(workerScoped(h.ws, h.workerSid).length).toBe(0);
      expect(workerScoped(mgrWatcher, h.workerSid).length).toBe(0);

      // Detach: mapping + delivery stop again.
      h.wsServer.onClose(w);
      const publishAfterDetach = publishCalls;
      for (const ev of events) h.emit(ev);
      await sleep(20);
      expect(publishCalls).toBe(publishAfterDetach);

      // connectedClients accounting rode the raw row: back to zero.
      expect(h.reg.getRow(h.workerSid)!.connectedClients).toBe(0);
    } finally {
      cleanup(h);
    }
  });
});

// ── The attach burst: replay half ridden wholesale + additive sessionCreated ──

describe("worker attach: windowed replay, cursor, working, subagent fields", () => {
  it("full replay rides the windowed seam; sessionCreated carries kind/parentSessionId; working = task inRun; delta reconnect keeps the transcript", async () => {
    const h = await makeHarness();
    try {
      // A long durable log (10 conversation pairs > the 6-message window).
      const lines: string[] = [];
      for (let i = 0; i < 10; i++) {
        lines.push(JSON.stringify({ ts: `2024-01-01T00:00:0${i}Z`, session_id: h.workerSid, source: "input", content: `in ${i}` }));
        lines.push(JSON.stringify({ ts: `2024-01-01T00:01:0${i}Z`, session_id: h.workerSid, source: "llm", content: `out ${i}` }));
      }
      writeFileSync(join(SESSIONS_DIR, `${h.workerSid}.jsonl`), lines.join("\n") + "\n");

      const w = await watchWorker(h);
      const created = byType(w, S2C.SESSION_CREATED).find((m) => m.sessionId === h.workerSid);
      expect(created.kind).toBe("subagent");
      expect(created.parentSessionId).toBe(h.mgrSid);
      // Window trio on a long log: older history pages through C2S loadOlder.
      expect(created.hasOlder).toBe(true);
      expect(created.oldestIndex).toBeGreaterThan(0);
      expect(created.epochToken).toBeGreaterThanOrEqual(0);
      // The tail of the window replays as session-grammar transcript frames.
      const transcript = byType(w, S2C.ASSISTANT_MESSAGE).filter((m) => m.sessionId === h.workerSid);
      expect(transcript.length).toBeGreaterThan(0);
      expect(transcript.some((m) => JSON.stringify(m.content).includes("out 9"))).toBe(true);
      expect(transcript.some((m) => JSON.stringify(m.content).includes("out 0"))).toBe(false);
      // `working`: the worker task is RUNNING with its turn in flight (the
      // mock run hangs); the task's inRun is the worker-row source.
      const working = byType(w, S2C.SESSION_STATE).filter((m) => m.sessionId === h.workerSid && m.key === "working");
      expect(working.some((m) => m.value === true)).toBe(true);
      const cursor = byType(w, S2C.SESSION_STATE).find((m) => m.sessionId === h.workerSid && m.key === "cursor");
      expect(cursor?.value).toBe(20);

      // Delta reconnect at the full-log cursor: the exact tail, no transcript
      // replay (replayDelta suppresses the clear), and NO window fields.
      const w2 = createWsMockWs();
      h.wsServer.onUpgrade(
        { url: `/ws?session=${h.workerSid}&cursor=20`, headers: { host: "localhost" } },
        w2,
      );
      const created2 = await poll(
        () => byType(w2, S2C.SESSION_CREATED).find((m) => m.sessionId === h.workerSid),
        "delta attach",
      );
      expect(created2.replayDelta).toBe(true);
      expect(created2.hasOlder).toBeUndefined();
      expect(byType(w2, S2C.ASSISTANT_MESSAGE).filter((m) => m.sessionId === h.workerSid).length).toBe(0);
      // The delta reconnect rode the worker row through attachResumedSession
      // too: subagent fields present.
      expect(created2.kind).toBe("subagent");

      // Parked / not-in-flight -> working false: release the run, keep the
      // row (task still RUNNING is false once completed -> attach refused
      // upstream), so probe the working source directly.
      h.releaseWorkerAgent();
      await poll(() => (h.tm.taskStatus(h.taskId) === TASK_STATUS.COMPLETED ? 1 : null), "worker completes");
      expect(h.tm.taskWorkingForAgentSession(h.workerSid)).toBeNull();
      expect(h.tm.taskWorkingForAgentSession("no-such-sid")).toBeNull();
    } finally {
      cleanup(h);
    }
  });
});

// ── The refusal table ────────────────────────────────────────────────────────

describe("kind-aware refusal table: honest errors, no state moved", () => {
  it("send/cancel/delete/dismiss/rename/setPinned/switchProfile/command(+fork) all refuse", async () => {
    const h = await makeHarness();
    try {
      const row = () => h.reg.getRow(h.workerSid)!;
      const before = {
        title: row().title,
        lastActivityAt: row().lastActivityAt,
        clients: row().connectedClients,
      };
      // Let any spawn-time frames settle, then snapshot the frame count.
      await sleep(20);
      const n = h.ws.messages.length;

      const cases: Array<[Record<string, unknown>, string]> = [
        [{ type: C2S.SEND, sessionId: h.workerSid, content: "turn" }, "steered with a follow-up"],
        [{ type: C2S.CANCEL, sessionId: h.workerSid }, "interrupt_task"],
        [{ type: C2S.DELETE_SESSION, sessionId: h.workerSid }, "not deleted"],
        [{ type: C2S.DISMISS_SESSION, sessionId: h.workerSid }, "not dismissed"],
        [{ type: C2S.RENAME_SESSION, sessionId: h.workerSid, newName: "x" }, "cannot be renamed"],
        [{ type: C2S.SET_PINNED, sessionId: h.workerSid, pinned: true }, "Worker sessions cannot be pinned."],
        [{ type: C2S.SWITCH_PROFILE, sessionId: h.workerSid, profileName: "default" }, "cannot switch profiles"],
        [{ type: C2S.COMMAND, sessionId: h.workerSid, command: "/clear" }, "text follow-ups only"],
        [{ type: C2S.COMMAND, sessionId: h.workerSid, command: "/fork" }, "no manager entry to fork"],
      ];
      for (const [msg, needle] of cases) {
        await h.send(h.ws, msg);
        const errs = frames(h.ws).slice(n).filter((m) => m.type === S2C.ERROR);
        const hit = errs.at(-1);
        expect(hit?.message, `refusal for ${msg.type}`)
          .toContain(needle);
      }

      // No state moved: no SESSION_DELETED / SESSIONS / PROFILE_SWITCHED
      // frames, row untouched (touch stayed behind the command gate too).
      const after = frames(h.ws).slice(n);
      expect(after.some((m) => m.type === S2C.SESSION_DELETED)).toBe(false);
      expect(after.some((m) => m.type === S2C.SESSIONS)).toBe(false);
      expect(after.some((m) => m.type === S2C.PROFILE_SWITCHED)).toBe(false);
      expect(row().title).toBe(before.title);
      expect(row().lastActivityAt).toBe(before.lastActivityAt);
      expect(row().connectedClients).toBe(before.clients);

      // The interactive row is UNTOUCHED by the table: a real send still
      // enqueues (no refusal frame).
      const n2 = h.ws.messages.length;
      await h.send(h.ws, { type: C2S.SEND, sessionId: h.mgrSid, content: "real turn" });
      expect(frames(h.ws).slice(n2).some((m) => m.type === S2C.ERROR && String(m.message).includes("follow-up"))).toBe(false);
    } finally {
      cleanup(h);
    }
  });

  it("refused cancel keeps a HELD worker question held and unmarked; the manager answer lane still answers it", async () => {
    const h = await makeHarness();
    try {
      const worker = h.tm._test_tasks.get(h.taskId)!.agent!;
      const pending = h.askWorker(worker);
      let settled: Record<string, unknown> | null = null;
      void pending.then((a) => {
        settled = a;
      });
      await sleep(30);
      expect(settled).toBeNull();

      await h.send(h.ws, { type: C2S.CANCEL, sessionId: h.workerSid });
      const errs = frames(h.ws).filter((m) => m.type === S2C.ERROR);
      expect(errs.at(-1)?.message).toContain("interrupt_task");

      // The B2 gap stays closed: no unmarked resolution -- the pending
      // survives the refused cancel (the plain bridge.cancel never ran).
      await sleep(50);
      expect(settled).toBeNull();

      // The manager lane still answers, with a REAL answer (no unanswered
      // marker: this is not a release).
      expect(h.tm.sendFollowUp(h.taskId, "the real answer")).toBe(true);
      const answer = await pending;
      expect(answer).toEqual({ q: "the real answer" });
      expect(unansweredReason(answer)).toBeNull();
      // No QUESTION_ANSWERED broadcast fired for the worker sid.
      expect(frames(h.ws).some((m) => m.type === S2C.QUESTION_ANSWERED)).toBe(false);

      h.releaseWorkerAgent();
      await poll(() => (h.tm.taskStatus(h.taskId) === TASK_STATUS.COMPLETED ? 1 : null), "done");
    } finally {
      cleanup(h);
    }
  });
});

// ── Scope isolation + auth gate ──────────────────────────────────────────────

describe("frame isolation both ways + unauth refusal (gate untouched)", () => {
  it("worker-scoped frames never reach the manager watcher, task frames never reach the worker watcher", async () => {
    const h = await makeHarness();
    try {
      const w = await watchWorker(h);
      h.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "worker says hi" });
      await sleep(20);
      expect(frames(h.ws).some((m) => m.sessionId === h.workerSid)).toBe(false);
      // Task-control frames (manager-scoped) do NOT cross to the worker watcher.
      const wf = frames(w);
      expect(wf.some((m) => m.type === S2C.TASK_UPDATE && m.task?.taskId === h.taskId)).toBe(false);
      // Manager watcher DOES see the task traffic (scope alive on that side).
      expect(byType(h.ws, S2C.TASK_UPDATE).some((m) => m.task?.taskId === h.taskId)).toBe(true);
    } finally {
      cleanup(h);
    }
  });

  it("interactive sessionCreated payloads carry neither kind nor parentSessionId", async () => {
    const h = await makeHarness();
    try {
      const created = byType(h.ws, S2C.SESSION_CREATED).at(-1);
      expect(created.sessionId).toBe(h.mgrSid);
      expect("kind" in created).toBe(false);
      expect("parentSessionId" in created).toBe(false);
    } finally {
      cleanup(h);
    }
  });

  it("unauth socket: switchSession to a worker sid hits the unchanged auth gate", async () => {
    const core = createWsMockCore();
    const auth = { validateToken: () => false } as unknown as AuthMiddleware;
    const wsServer = createWsServer(core, {
      buildAgent: async (config: { model?: string; sessionId?: string }) =>
        makeWsMockAgent({ sessionId: config.sessionId || "test", model: "test-model" }),
      auth,
    });
    const w = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, w);
    expect(frames(w).some((m) => m.type === S2C.AUTH_REQUIRED)).toBe(true);
    await wsServer.onMessage(w, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: "worker-any" }));
    const gate = frames(w).find((m) => m.type === S2C.AUTH_ERROR && m.code === "auth_required");
    expect(gate).toBeDefined();
    expect((w as unknown as any).activeSessionId).toBeUndefined();
    wsServer.stopTaskManager();
    wsServer.stopCleanupLoop();
  });
});

// ── Released rows: null-tolerant accessor, terminal attach refusal ───────────

describe("worker rows without a live agent", () => {
  it("live row with a null getAgent(): attaches for replay honestly, resolvers undefined, working false", async () => {
    const h = await makeHarness();
    try {
      const fakeSid = "worker-attach-released";
      h.reg.registerWorker({
        taskId: "t-fake",
        workerSid: fakeSid,
        managerSid: h.mgrSid,
        profile: "task",
        getAgent: () => null,
      });
      const w = createWsMockWs();
      h.wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, w);
      await poll(() => w.messages.some((m) => JSON.parse(m).type === S2C.SESSION_CREATED), "attach");
      await h.send(w, { type: C2S.SWITCH_SESSION, sessionId: fakeSid });
      const created = byType(w, S2C.SESSION_CREATED).find((m) => m.sessionId === fakeSid);
      expect(created.kind).toBe("subagent");
      expect(created.parentSessionId).toBe(h.mgrSid);
      expect(created.profile).toBe("task");
      // No throw: the partial flush is skipped (null agent), working false
      // (no RUNNING task owns the sid), the cursor frame still lands.
      const states = byType(w, S2C.SESSION_STATE).filter((m) => m.sessionId === fakeSid);
      expect(states.some((m) => m.key === "working" && m.value === false)).toBe(true);
      expect(states.some((m) => m.key === "cursor")).toBe(true);

      // Terminal (releaseWorker): the live check refuses; switchSession
      // answers the honest not-found error, no channel is created.
      h.reg.releaseWorker(fakeSid);
      const n = w.messages.length;
      await h.send(w, { type: C2S.SWITCH_SESSION, sessionId: fakeSid });
      expect(frames(w).slice(n).some((m) => m.type === S2C.ERROR && String(m.message).includes("not found"))).toBe(true);
    } finally {
      cleanup(h);
    }
  });

  it("a watcher present never changes worker question arming (B2 wait posture, N5 pin)", async () => {
    const h = await makeHarness({ questionStrategy: "default", questionTimeoutSecs: 0.02 });
    try {
      const w = await watchWorker(h);
      expect(h.reg.hasChannels(h.workerSid)).toBe(true);
      const worker = h.tm._test_tasks.get(h.taskId)!.agent!;
      const pending = h.askWorker(worker);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      // Past the tiny 20ms timer x5: still waiting -- hasChannels flipped
      // nothing about the posture.
      await sleep(120);
      expect(settled).toBe(false);
      expect(h.tm.sendFollowUp(h.taskId, "answer")).toBe(true);
      expect(await pending).toEqual({ q: "answer" });
      h.releaseWorkerAgent();
      await poll(() => (h.tm.taskStatus(h.taskId) === TASK_STATUS.COMPLETED ? 1 : null), "done");
      void w;
    } finally {
      cleanup(h);
    }
  });
});
