// Subagent feed session scoping + activity replay (C2S taskActivityRequest).
// The feed is scoped on the wire: task updates/activity reach only sockets
// whose active session owns the task, snapshots are per-session, and replay
// requests cannot cross sessions.

import { describe, it, expect, afterEach } from "bun:test";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
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

// buildAgent whose task run streams text + reasoning + a tool call through
// the sink. Parent (non-sink) agents get unique session ids so scoping can
// be tested against the ids the sockets actually attach to.
function makeServer(): WsServer {
  const core = createWsMockCore();
  let sessionSeq = 0;
  const buildAgent = async (cfg: Record<string, unknown>) => {
    const sink = cfg.sink as { emit: (e: unknown) => void } | undefined;
    const agent: any = {
      sessionId: sink ? `task-agent-${sessionSeq}` : `sess-${++sessionSeq}`,
      model: "test-model",
      run: async () => {
        sink?.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "working" });
        sink?.emit({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "hmm" });
        sink?.emit({
          type: OUTPUT_EVENT.TOOL_CALL,
          toolName: "bash",
          input: "ls",
          toolCallId: "c1",
        });
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

/** Wait for the async attach to land; returns the sessionCreated id. */
async function attachedSessionId(ws: MockWs): Promise<string> {
  const deadline = Date.now() + 2000;
  for (;;) {
    const created = messages(ws).find((m) => m.type === S2C.SESSION_CREATED);
    if (created) return created.sessionId as string;
    if (Date.now() > deadline) throw new Error("socket never attached");
    await new Promise((r) => setTimeout(r, 1));
  }
}

async function settle(pred: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("subagent feed session scoping", () => {
  let wsServer: WsServer | null = null;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
    wsServer = null;
  });

  it("routes task updates and activity only to sockets watching the owning session", async () => {
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
      () => messages(ws1).some((m) => m.type === S2C.TASK_ACTIVITY),
      "task activity on ws1",
    );

    const updates1 = messages(ws1).filter((m) => m.type === S2C.TASK_UPDATE);
    expect(updates1.length).toBeGreaterThan(0);
    expect(updates1[0].task.sessionId).toBe(sid);
    expect(messages(ws1).some((m) => m.type === S2C.TASK_ACTIVITY)).toBe(true);
    expect(messages(ws2).some((m) => m.type === S2C.TASK_ACTIVITY)).toBe(true);
    expect(ws3.messages.length).toBe(0);
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

  it("replays recorded activity only within the owning session", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    const sid = await attachedSessionId(ws1);
    const ws2 = openSocket(wsServer);
    await attachedSessionId(ws2);

    const tm = wsServer.sessionRegistry.getTaskManager();
    const handle = await tm!.spawnTask("task-1", "do it", {
      managerAgent: { sessionId: sid },
    });
    await Promise.race([handle.done, new Promise((r) => setTimeout(r, 1000))]);

    const before = ws2.messages.length;
    ws1.messages.length = 0;
    wsServer.onMessage(
      ws1,
      JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST, taskId: "task-1" }),
    );

    const replies = messages(ws1).filter((m) => m.type === S2C.TASK_ACTIVITY_HISTORY);
    expect(replies).toHaveLength(1);
    expect(replies[0].taskId).toBe("task-1");
    expect(replies[0].activity.map((a: any) => a.kind)).toEqual([
      "text",
      "reasoning",
      "tool_call",
    ]);
    expect(replies[0].activity[0].content).toBe("working");
    // The reply goes to the requester only.
    expect(ws2.messages.length).toBe(before);
  });

  it("refuses cross-session and unknown task replays with an empty history", async () => {
    wsServer = makeServer();
    const ws1 = openSocket(wsServer);
    await attachedSessionId(ws1);

    const tm = wsServer.sessionRegistry.getTaskManager();
    // Task owned by a DIFFERENT session id than ws1's.
    await tm!.spawnTask("task-other", "child of elsewhere", {
      managerAgent: { sessionId: "somewhere-else" },
    });

    ws1.messages.length = 0;
    wsServer.onMessage(
      ws1,
      JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST, taskId: "task-other" }),
    );
    wsServer.onMessage(
      ws1,
      JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST, taskId: "nope" }),
    );

    const replies = messages(ws1).filter((m) => m.type === S2C.TASK_ACTIVITY_HISTORY);
    expect(replies).toHaveLength(2);
    expect(replies[0].activity).toEqual([]);
    expect(replies[1].activity).toEqual([]);

    ws1.messages.length = 0;
    wsServer.onMessage(ws1, JSON.stringify({ type: C2S.TASK_ACTIVITY_REQUEST }));
    expect(ws1.messages.length).toBe(0);
  });
});
