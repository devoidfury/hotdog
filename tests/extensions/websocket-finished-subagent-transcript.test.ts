// Reload-symptom suite (run 20261113-0701, item 1): a SETTLED subagent viewed
// by a FRESH client must replay its FULL transcript from the worker's durable
// session log -- the capped in-memory buffer is only the LIVE-task authority.
// Doctrine: a finished subagent is a finished session (a viewed subagent
// behaves like any other session view), so the log is the authority exactly
// when the buffer's caps (300-item ring / whole-task eviction / reset trim)
// could otherwise silently shorten history.
//
// Pins along the seam:
//  - unsettled tasks: the buffer, byte-identically (existing suites own the
//    live frames; this pins the reply shape too);
//  - one authority per state: a settled reply is the LOG fold alone (never
//    log + buffer -- the client has a single render path and must not
//    double-render);
//  - missing / garbage log: degrade to the buffer, never to silence;
//  - the session gate owns the whole reply (a foreign socket gets [] and the
//    log is never read);
//  - additive wire fields: agentSessionId / agentLogPath / runDir.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { MAX_TASK_ACTIVITY_HISTORY_ITEMS } from "@extensions/websocket/constants.ts";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import type { AgentLike } from "@core/session/index.ts";
import { createWsMockCore, createWsMockWs } from "../mocks/websocket.ts";

type MockWs = ReturnType<typeof createWsMockWs>;
type WsServer = ReturnType<typeof createWsServer>;

function messages(ws: MockWs): any[] {
  return ws.messages.map((m) => JSON.parse(m));
}

async function settle(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

// Isolated sessions dir for the whole file (HOTDOG_SESSIONS_DIR wins over
// HOTDOG_DATA_DIR in @core/session/session-log.ts, and readSessionEntries
// re-reads it per call). The REAL writer (session-log extension hooks fire on
// the worker agent too) lands here in a real server; the tests hand-write the
// exact entry shapes it produces.
let sessionsDir = "";
const prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;

beforeAll(async () => {
  sessionsDir = await mkdtemp(join(tmpdir(), "wsfx-settled-"));
  process.env.HOTDOG_SESSIONS_DIR = sessionsDir;
});
afterAll(async () => {
  if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
  else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
  await rm(sessionsDir, { recursive: true, force: true });
});

/** Write <sessionsDir>/<workerId>.jsonl with session-log-shaped entries. */
async function writeWorkerLog(workerId: string, entries: Array<Record<string, unknown>>): Promise<void> {
  const lines = entries.map((e) =>
    JSON.stringify({ ts: "2026-11-13T00:00:00.000Z", session_id: workerId, v: 2, ...e }),
  );
  await writeFile(join(sessionsDir, `${workerId}.jsonl`), lines.join("\n") + "\n");
}

// A fresh worker id per server: the log written by one test must never be
// mistaken for the durable record of another test's task.
let workerSeq = 0;
const nextWorker = (): string => `wsfx-worker-${++workerSeq}`;

// buildAgent: task agents (sink present) stream `script` (or park forever
// when holdGate is set) under the given worker id; parent agents get fresh
// ids so the sockets attach to real session ids.
function makeServer(opts: {
  worker: string;
  script: OutputEvent[];
  holdGate?: Promise<void>;
}): WsServer {
  const core = createWsMockCore();
  let sessionSeq = 0;
  const buildAgent = async (cfg: Record<string, unknown>) => {
    const sink = cfg.sink as { emit: (e: unknown) => void } | undefined;
    const agent: any = {
      sessionId: sink ? opts.worker : `sess-${++sessionSeq}`,
      model: "test-model",
      run: async () => {
        for (const ev of opts.script) sink?.emit(ev);
        if (opts.holdGate) await opts.holdGate;
        return { type: "completion", content: "done" };
      },
      notifyCompletion: () => {},
    };
    if (!sink) {
      agent.getMessages = () => [];
      agent.hooks = {
        notifyHooks: () => {},
        runHookPipeline: async () => undefined,
        registerHook: () => {},
        unregisterHook: () => {},
      };
      agent.serialize = () => ({});
      agent.applyProfile = () => {};
      agent.cancel = () => {};
      agent.resetCancel = () => {};
      agent.executeCommand = async () => null;
      agent.addMessage = () => {};
      agent.clearContext = async () => {};
      agent.profileName = "default";
      agent.modelRegistry = {};
      agent.sink = null;
      agent.enqueueCallback = null;
      agent.toolWhitelist = null;
      agent.profileBody = undefined;
    }
    return agent as AgentLike;
  };
  return createWsServer(core, { buildAgent: buildAgent as never });
}

function openSocket(wsServer: WsServer): MockWs {
  const ws = createWsMockWs();
  wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
  return ws;
}

async function attachedSessionId(ws: MockWs): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const created = messages(ws).find((m) => m.type === S2C.SESSION_CREATED);
    if (created) return created.sessionId as string;
    if (Date.now() > deadline) throw new Error("socket never attached");
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Send taskActivityRequest and wait for the (possibly log-backed, hence
 *  async per the route settle contract) reply to land. */
async function requestHistory(ws: MockWs, taskId: string): Promise<void> {
  wsServer!.onMessage(ws, JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST, taskId }));
  await settle(
    () => messages(ws).some((m) => m.type === S2C.TASK_ACTIVITY_HISTORY && m.taskId === taskId),
    `history reply for ${taskId}`,
  );
}

function historyReply(ws: MockWs, taskId: string): any[] {
  const replies = messages(ws).filter(
    (m) => m.type === S2C.TASK_ACTIVITY_HISTORY && m.taskId === taskId,
  );
  expect(replies).toHaveLength(1);
  return replies[0].activity;
}

let wsServer: WsServer | null = null;
afterEach(() => {
  wsServer?.stopCleanupLoop();
  wsServer = null;
});

describe("settled subagent transcript replays from the durable session log", () => {
  it("RED (reload symptom): settled task + fresh client gets the FULL transcript, not the ring-truncated buffer", async () => {
    // More streamed deltas than the buffer ring holds: today's reply comes
    // from the buffer and SILENTLY drops the head -- after a browser reload
    // the finished task's transcript starts mid-sentence. The durable log
    // holds the whole conversation, so the fixed reply must too.
    const N = MAX_TASK_ACTIVITY_HISTORY_ITEMS + 2;
    const WORKER = nextWorker();
    const script: OutputEvent[] = Array.from(
      { length: N },
      (_, i) => ({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: `d${i} ` } as OutputEvent),
    );
    wsServer = makeServer({ worker: WORKER, script });
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);

    const tm = wsServer.sessionRegistry.getTaskManager()!;
    const handle = await tm.spawnTask("task-1", "long run", {
      managerAgent: { sessionId: sid },
    });
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 2000))]);
    expect(tm.listTasks().find((t) => t.taskId === "task-1")?.status).toBe("completed");

    // The log the real writer holds for this worker: prompt + tool round +
    // the FULL streamed head. (Bookkeeping entries in between: the fold
    // must skip them.)
    await writeWorkerLog(WORKER, [
      { source: "session_start", content: "", model: "test-model", profile: null },
      { source: "input", role: "user", content: "the delegated prompt" },
      {
        source: "llm",
        role: "assistant",
        content: script.map((e) => (e as { content: string }).content).join(""),
        reasoning_content: null,
        tool_calls: [{ id: "c1", function: { name: "bash", arguments: '{"command":"ls"}' } }],
      },
      { source: "tool_started", content: { tool: "bash", call_id: "c1" } },
      { source: "tool_result", role: "tool", tool_call_id: "c1", tool_name: "bash", content: "one file" },
      { source: "llm", role: "assistant", content: "FINAL ANSWER", reasoning_content: "done thinking", tool_calls: null },
      { source: "turn_end", content: { status: "completed" } },
    ]);

    // Reload: a fresh socket attaches to the SAME session and opens the task.
    const ws2 = openSocket(wsServer);
    expect(await attachedSessionId(ws2)).toBe(sid);
    await requestHistory(ws2, "task-1");

    const activity = historyReply(ws2, "task-1");
    // Full transcript: the ring-dropped head (d0), the tool round, the final
    // answer + its reasoning -- in relay order, bookkeeping skipped, and the
    // prompt NOT repainted (the activity grammar has no user lane).
    const kinds = activity.map((a: any) => a.kind);
    expect(kinds).toEqual(["text", "tool_call", "tool_result", "reasoning", "text"]);
    expect(activity[0].content).toContain("d0");
    expect(activity[0].content).toContain(`d${N - 1}`);
    expect(activity[1]).toEqual({ kind: "tool_call", name: "bash", args: '{"command":"ls"}' });
    expect(activity[2]).toEqual({ kind: "tool_result", name: "bash", output: "one file" });
    expect(activity[3].content).toBe("done thinking");
    expect(activity[4].content).toBe("FINAL ANSWER");
    // ONE authority, no double render: exactly five items -- the buffer's
    // ring content is NOT appended to the log fold.
    expect(activity).toHaveLength(5);
  });

  it("settled task with NO log degrades to the buffer, never to silence", async () => {
    const WORKER = nextWorker(); // deliberately NO log file for this one
    const script: OutputEvent[] = [
      { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "buffered head " },
      { type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: "ls", toolCallId: "c1" },
    ];
    wsServer = makeServer({ worker: WORKER, script });
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);
    const tm = wsServer.sessionRegistry.getTaskManager()!;
    const handle = await tm.spawnTask("task-1", "no log", { managerAgent: { sessionId: sid } });
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 2000))]);
    // ...and no <WORKER>.jsonl exists: rotated away / session-log disabled.

    const ws2 = openSocket(wsServer);
    await attachedSessionId(ws2);
    await requestHistory(ws2, "task-1");
    const activity = historyReply(ws2, "task-1");
    // Honest buffer bytes (the same items the live relay carried), never [].
    expect(activity).toEqual([
      { kind: "text", content: "buffered head " },
      { kind: "tool_call", name: "bash", args: "ls", argsSummary: "ls" },
    ]);
  });

  it("settled task with a GARBAGE log falls back to the buffer", async () => {
    const WORKER = nextWorker();
    const script: OutputEvent[] = [
      { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "tail survives" },
    ];
    wsServer = makeServer({ worker: WORKER, script });
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);
    const tm = wsServer.sessionRegistry.getTaskManager()!;
    const handle = await tm.spawnTask("task-1", "rotated", { managerAgent: { sessionId: sid } });
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 2000))]);
    await writeFile(join(sessionsDir, `${WORKER}.jsonl`), "not json\n{broken\n");

    const ws2 = openSocket(wsServer);
    await attachedSessionId(ws2);
    await requestHistory(ws2, "task-1");
    expect(historyReply(ws2, "task-1")).toEqual([{ kind: "text", content: "tail survives" }]);
  });

  it("unsettled (live) task keeps the in-memory buffer -- the log is NOT consulted", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const WORKER = nextWorker();
    wsServer = makeServer({
      worker: WORKER,
      script: [{ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "live-only" } as OutputEvent],
      holdGate: gate,
    });
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);
    const tm = wsServer.sessionRegistry.getTaskManager()!;
    const handle = await tm.spawnTask("task-1", "running", { managerAgent: { sessionId: sid } });
    await settle(() => messages(ws1).some((m) => m.type === S2C.TASK_ACTIVITY), "live frame");

    // A log EXISTS (the writer already records the live turn) with content
    // the buffer does not: a live reply must still be the buffer, so the two
    // authorities can never interleave.
    await writeWorkerLog(WORKER, [
      { source: "llm", role: "assistant", content: "LOG MUST NOT APPEAR LIVE", tool_calls: null },
    ]);

    const ws2 = openSocket(wsServer);
    await attachedSessionId(ws2);
    await requestHistory(ws2, "task-1");
    const activity = historyReply(ws2, "task-1");
    expect(activity).toEqual([{ kind: "text", content: "live-only" }]);
    release();
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 2000))]);
  });

  it("cross-session task ids get an empty history and the log is never opened (gate first)", async () => {
    const WORKER = nextWorker();
    wsServer = makeServer({ worker: WORKER, script: [{ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "secret" } as OutputEvent] });
    const ws1 = openSocket(wsServer);
    await attachedSessionId(ws1);
    const tm = wsServer.sessionRegistry.getTaskManager()!;
    await tm.spawnTask("task-x", "elsewhere", { managerAgent: { sessionId: "somewhere-else" } });
    await writeWorkerLog(WORKER, [
      { source: "llm", role: "assistant", content: "MUST NOT LEAK", tool_calls: null },
    ]);
    const ws2 = openSocket(wsServer);
    await attachedSessionId(ws2);
    // (ws2 attaches to the session ws1 created; task-x's delegator is a
    // foreign id, so the gate must refuse before the log is ever opened.)
    await requestHistory(ws2, "task-x");
    expect(historyReply(ws2, "task-x")).toEqual([]);
  });

  it("additive wire fields: agentSessionId rides the snapshot + updates; agentLogPath is the absolute log path; runDir only for engine spawns", async () => {
    const WORKER = nextWorker();
    wsServer = makeServer({ worker: WORKER, script: [{ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "x" } as OutputEvent] });
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);
    const tm = wsServer.sessionRegistry.getTaskManager()!;
    const handle = await tm.spawnTask("task-1", "wire", {
      managerAgent: { sessionId: sid },
      runDir: "/tmp/wsfx-run",
    } as never);
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 2000))]);

    const ws2 = openSocket(wsServer);
    await attachedSessionId(ws2);
    const list = messages(ws2).find((m) => m.type === S2C.TASK_LIST);
    expect(list).toBeTruthy();
    const t = list.tasks.find((x: any) => x.taskId === "task-1");
    expect(t.agentSessionId).toBe(WORKER);
    expect(t.agentLogPath).toBe(join(sessionsDir, `${WORKER}.jsonl`));
    expect(t.runDir).toBe("/tmp/wsfx-run");
    // Live frames carry the same fields (the relay maps through taskWire too).
    const update = messages(ws1).filter((m) => m.type === S2C.TASK_UPDATE).at(-1)!;
    expect(update.task.agentSessionId).toBe(WORKER);
    expect(update.task.agentLogPath).toBe(join(sessionsDir, `${WORKER}.jsonl`));

    // A spawn WITHOUT a run dir rides no runDir key at all (absence is the
    // non-workflow discriminator the Reveal menu item hinges on).
    const handle2 = await tm.spawnTask("task-plain", "delegate style", {
      managerAgent: { sessionId: sid },
    });
    await Promise.race([handle2.done, new Promise((r) => setTimeout(r, 2000))]);
    const ws3 = openSocket(wsServer);
    await attachedSessionId(ws3);
    const list3 = messages(ws3).filter((m) => m.type === S2C.TASK_LIST).at(-1)!;
    const plain = list3.tasks.find((x: any) => x.taskId === "task-plain");
    expect("runDir" in plain).toBe(false);
    expect(plain.agentSessionId).toBe(WORKER);
  });
});
