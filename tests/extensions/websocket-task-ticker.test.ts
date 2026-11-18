// Subagent ticker session scoping (B4 rewrite of the ring's suite). The
// replay duties moved: a settled transcript is a windowed viewLog of the
// worker's durable log (pinned in websocket-finished-subagent-transcript),
// and the live tail rides the worker's own session channels (pinned in
// websocket-worker-attach). What this file owns is the TICKER's scoping:
// task updates and snapshots reach only sockets whose active session owns
// the task, orphan tasks stay off the wire, and the retired relay grammar
// is provably dead -- no taskActivity frame is ever produced, and the
// taskActivityRequest route answers with the generic unknown-type error.

import { describe, it, expect, afterEach } from "bun:test";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import type { AgentLike } from "@core/session/index.ts";
import {
  createWsMockCore,
  createWsMockWs,
} from "../mocks/websocket.ts";

type MockWs = ReturnType<typeof createWsMockWs>;
type WsServer = ReturnType<typeof createWsServer>;

function messages(ws: MockWs): any[] {
  return ws.messages.map((m) => JSON.parse(m));
}

// buildAgent whose task run streams the given event script through the sink
// (default: text + reasoning + a tool call). Parent (non-sink) agents get
// unique session ids so scoping can be tested against the ids the sockets
// actually attach to.
const DEFAULT_TASK_SCRIPT: OutputEvent[] = [
  { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "working" },
  { type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "hmm" },
  { type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: "ls", toolCallId: "c1" },
];

function makeServer(streamEvents?: OutputEvent[]): WsServer {
  const core = createWsMockCore();
  let sessionSeq = 0;
  const buildAgent = async (cfg: Record<string, unknown>) => {
    const sink = cfg.sink as { emit: (e: unknown) => void } | undefined;
    const agent: any = {
      sessionId: sink ? `task-agent-${sessionSeq}` : `sess-${++sessionSeq}`,
      model: "test-model",
      run: async () => {
        for (const ev of streamEvents ?? DEFAULT_TASK_SCRIPT) sink?.emit(ev);
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

/** Wait for the async attach to land; returns the sessionCreated id.
 * Generous deadline: the attach is in-memory, so the only way it misses is
 * event-loop starvation under `bun test --parallel` on loaded runners. */
async function attachedSessionId(ws: MockWs): Promise<string> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const created = messages(ws).find((m) => m.type === S2C.SESSION_CREATED);
    if (created) return created.sessionId as string;
    if (Date.now() > deadline) throw new Error("socket never attached");
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function settle(pred: () => boolean, what: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("subagent ticker session scoping", () => {
  let wsServer: WsServer | null = null;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
    wsServer = null;
  });

  it("routes task updates only to sockets watching the owning session", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);

    // A second socket on the same session (attach-to-most-recent).
    const ws2 = openSocket(wsServer);
    const sid2 = await attachedSessionId(ws2);
    expect(sid2).toBe(sid);

    // A third socket moved onto its own fresh session.
    const ws3 = openSocket(wsServer);
    await attachedSessionId(ws3);
    wsServer.onMessage(ws3, JSON.stringify({ type: C2S.CREATE_SESSION }));
    await settle(
      () => messages(ws3).filter((m) => m.type === S2C.SESSION_CREATED).length >= 2,
      "ws3 second sessionCreated",
    );
    ws3.messages.length = 0;

    const tm = wsServer.sessionRegistry.getTaskManager();
    expect(tm).toBeTruthy();
    await tm!.spawnTask("task-1", "child of A", { managerAgent: { sessionId: sid } });
    await settle(
      () => messages(ws1).some((m) => m.type === S2C.TASK_UPDATE),
      "task update on ws1",
    );

    const updates1 = messages(ws1).filter((m) => m.type === S2C.TASK_UPDATE);
    expect(updates1.length).toBeGreaterThan(0);
    expect(updates1[0].task.sessionId).toBe(sid);
    expect(messages(ws2).some((m) => m.type === S2C.TASK_UPDATE)).toBe(true);
    expect(ws3.messages.length).toBe(0);
  });

  it("retired relay grammar is dead: no taskActivity frame is ever produced", async () => {
    // B4 deleted the relay branch: the observer feeds the ticker (TASK_UPDATE)
    // and the worker-scoped live tail ONLY. A streaming task must yield zero
    // taskActivity frames on the manager socket.
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);
    ws1.messages.length = 0;

    const tm = wsServer.sessionRegistry.getTaskManager();
    const handle = await tm!.spawnTask("task-1", "stream at me", {
      managerAgent: { sessionId: sid },
    });
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 1000))]);
    await new Promise((r) => setTimeout(r, 10));

    expect(messages(ws1).filter((m) => String(m.type).startsWith("taskActivity"))).toEqual([]);
    expect(messages(ws1).some((m) => m.type === S2C.TASK_UPDATE)).toBe(true);
  });

  it("keeps orphan tasks (no parent session) off the wire entirely", async () => {
    wsServer = makeServer();
    const ws = openSocket(wsServer);
    await attachedSessionId(ws);
    ws.messages.length = 0;

    const tm = wsServer.sessionRegistry.getTaskManager();
    await tm!.spawnTask("task-orphan", "no parent");
    // Give any stray broadcast a chance to land.
    await new Promise((r) => setTimeout(r, 10));

    expect(messages(ws).filter((m) => String(m.type).startsWith("task"))).toEqual([]);
  });

  it("snapshots are scoped to the socket's session on attach", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);

    const tm = wsServer.sessionRegistry.getTaskManager();
    await tm!.spawnTask("task-1", "child of A", { managerAgent: { sessionId: sid } });

    // New socket attaches to the most-recent session (A) and gets only A's tasks.
    const ws2 = openSocket(wsServer);
    const sid2 = await attachedSessionId(ws2);
    const list = messages(ws2).find((m) => m.type === S2C.TASK_LIST);
    expect(list).toBeTruthy();
    expect(list.tasks.map((t: any) => t.taskId)).toEqual(["task-1"]);
    expect(list.tasks.every((t: any) => t.sessionId === sid2)).toBe(true);
  });

  it("re-sends the scoped snapshot when the socket attaches elsewhere and back", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    const sidA = await attachedSessionId(ws1);

    const tm = wsServer.sessionRegistry.getTaskManager();
    await tm!.spawnTask("task-1", "child of A", { managerAgent: { sessionId: sidA } });

    // Same socket creates a fresh session B (attaches to it): empty snapshot.
    ws1.messages.length = 0;
    wsServer.onMessage(ws1, JSON.stringify({ type: C2S.CREATE_SESSION }));
    await settle(
      () => messages(ws1).some((m) => m.type === S2C.TASK_LIST),
      "scoped snapshot after createSession",
    );
    let lists = messages(ws1).filter((m) => m.type === S2C.TASK_LIST);
    expect(lists[lists.length - 1].tasks).toEqual([]);

    // Switch back to A: the snapshot re-scopes and task-1 returns.
    ws1.messages.length = 0;
    wsServer.onMessage(ws1, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: sidA }));
    await settle(
      () => messages(ws1).some((m) => m.type === S2C.TASK_LIST),
      "scoped snapshot after switchSession",
    );
    lists = messages(ws1).filter((m) => m.type === S2C.TASK_LIST);
    const last = lists[lists.length - 1];
    expect(last.tasks.map((t: any) => t.taskId)).toEqual(["task-1"]);
    expect(last.tasks[0].sessionId).toBe(sidA);
  });
});
