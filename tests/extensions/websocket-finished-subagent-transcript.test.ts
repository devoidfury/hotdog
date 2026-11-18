// B4 rewrite (zero-buffer doctrine). A FINISHED subagent is a finished
// session: its transcript authority is the worker's durable session log,
// opened through the STANDARD windowed viewLog the cold browse rides -- the
// fold, the ring, and the settled/live split are deleted. This file owns the
// surviving pins:
//  - a settled transcript = the windowed viewLog of the worker's log: the
//    full conversation rides, with NONE of the retired fold's caps (the log
//    carries MORE -- that was the fold's own parity argument; the one-off
//    fold-vs-viewLog acceptance in the run dir replayed the table);
//  - the ticker row names that log honestly (agentSessionId / agentLogPath
//    ride the taskWire rows, durable or not);
//  - an unknown log id refuses honestly (error frame, never silence-with-
//    data nor a fabricated transcript).

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
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
// re-reads it per call). The tests hand-write the exact entry shapes the
// REAL writer produces.
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

let workerSeq = 0;
const nextWorker = (): string => `wsfx-worker-${++workerSeq}`;

// buildAgent: task agents (sink present) run under the given worker id;
// parent agents get fresh ids so the sockets attach to real session ids.
function makeServer(worker: string): WsServer {
  const core = createWsMockCore();
  let sessionSeq = 0;
  const buildAgent = async (cfg: Record<string, unknown>) => {
    const sink = cfg.sink as { emit: (e: unknown) => void } | undefined;
    const agent: any = {
      sessionId: sink ? worker : `sess-${++sessionSeq}`,
      model: "test-model",
      run: async () => {
        sink?.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "working" } satisfies OutputEvent);
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

let wsServer: WsServer | null = null;
afterEach(() => {
  wsServer?.stopCleanupLoop();
  wsServer = null;
});

describe("settled transcript = windowed viewLog of the worker's durable log", () => {
  it("the viewLog of a settled worker carries the WHOLE transcript, caps and all", async () => {
    const worker = nextWorker();
    // The old fold capped every text at 4000 chars ("...[truncated]"); the
    // log-first authority ships the entry whole. A human steer (origin
    // "user") rides the log the same way.
    const big = "Z".repeat(6500);
    await writeWorkerLog(worker, [
      { source: "session_start", content: "", model: "m", profile: null },
      { source: "input", role: "user", content: "the delegated prompt" },
      { source: "llm", role: "assistant", content: "first answer", reasoning_content: "thinking 1", tool_calls: [{ id: "c1", function: { name: "bash", arguments: '{"command":"ls"}' } }] },
      { source: "tool_result", role: "tool", tool_call_id: "c1", tool_name: "bash", content: "file list" },
      { source: "input", role: "user", content: "a human steer", origin: "user" },
      { source: "llm", role: "assistant", content: big, reasoning_content: null, tool_calls: null },
      { source: "turn_end", content: { status: "completed" } },
    ]);

    wsServer = makeServer(worker);
    const ws = openSocket(wsServer);
    await attachedSessionId(ws);
    ws.messages.length = 0;

    // The settled row's Open lands HERE (subagents.tsx openTargetFor -> the
    // standard cold-log machinery). viewLog by worker id -- no session gate:
    // search deep-links and lineage rows must keep opening worker logs.
    wsServer.onMessage(ws, JSON.stringify({ type: C2S.VIEW_LOG, logId: worker }));
    await settle(() => messages(ws).some((m) => m.type === S2C.LOG_VIEWED), "logViewed");

    const viewed = messages(ws).find((m) => m.type === S2C.LOG_VIEWED);
    expect(viewed.logId).toBe(worker);
    // Small log: everything ships, none of the additive window fields ride
    // (the byte-identical pre-window wire shape).
    expect(viewed.hasOlder).toBeUndefined();
    expect(viewed.oldestIndex).toBeUndefined();
    const content = JSON.stringify(viewed.entries);
    expect(content).toContain("the delegated prompt");
    expect(content).toContain("a human steer");
    expect(content).toContain("file list");
    // THE zero-buffer pin: the fat entry arrives WHOLE -- the retired fold's
    // 4000-char ceiling cannot shorten a transcript anymore.
    expect(content).toContain(big);
    expect(content).not.toContain("[truncated]");
  });

  it("the ticker row names the worker's session and log path", async () => {
    const worker = nextWorker();
    wsServer = makeServer(worker);
    const ws = openSocket(wsServer);
    const sid = await attachedSessionId(ws);
    ws.messages.length = 0;

    const tm = wsServer.sessionRegistry.getTaskManager();
    const handle = await tm!.spawnTask("task-keys", "named row", {
      managerAgent: { sessionId: sid },
    });
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 1000))]);

    const updates = messages(ws).filter((m) => m.type === S2C.TASK_UPDATE);
    expect(updates.length).toBeGreaterThan(0);
    const settled = updates[updates.length - 1];
    // Open routes on these: live -> switchSession(agentSessionId), settled
    // -> viewLog(agentSessionId). A delegate task carries no runDir.
    expect(settled.task.taskId).toBe("task-keys");
    expect(settled.task.agentSessionId).toBe(worker);
    expect(String(settled.task.agentLogPath ?? "")).toBe(join(sessionsDir, `${worker}.jsonl`));
    expect(settled.task.runDir).toBeUndefined();
  });

  it("an unknown worker log refuses honestly (never silence, never fabrication)", async () => {
    wsServer = makeServer(nextWorker());
    const ws = openSocket(wsServer);
    await attachedSessionId(ws);
    ws.messages.length = 0;

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.VIEW_LOG, logId: "never-ran" }));
    await settle(() => messages(ws).some((m) => m.type === S2C.ERROR), "error reply");

    const errs = messages(ws).filter((m) => m.type === S2C.ERROR);
    expect(errs.length).toBe(1);
    expect(typeof errs[0].message).toBe("string");
    expect(errs[0].message.length).toBeGreaterThan(0);
    expect(messages(ws).some((m) => m.type === S2C.LOG_VIEWED)).toBe(false);
  });
});
