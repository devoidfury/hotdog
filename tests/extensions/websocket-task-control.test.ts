// Subagent task control over the websocket (C2S taskInterrupt/taskFollowup).
// The handlers are thin delegates onto the TaskManager primitives the
// task_interrupt / task_followup tools use -- these tests pin the delegation
// and the taskControl reply, not the control semantics (covered in
// tests/core/task-manager.test.ts).

import { describe, it, expect, afterEach } from "bun:test";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import type { TaskManager } from "@core/session/task-manager.ts";
import {
  createWsMockCore,
  createWsMockAgentFactory,
  createWsMockWs,
} from "../mocks/websocket.ts";

type MockWs = ReturnType<typeof createWsMockWs>;

function lastMessage(ws: MockWs): any {
  return JSON.parse(ws.messages[ws.messages.length - 1]!);
}

interface Call {
  method: "interruptTask" | "sendFollowUp";
  args: unknown[];
}

function makeServer(): ReturnType<typeof createWsServer> {
  const core = createWsMockCore();
  return createWsServer(core, { buildAgent: createWsMockAgentFactory() });
}

function stubTaskManager(
  wsServer: ReturnType<typeof createWsServer>,
  results: { interruptTask?: boolean; sendFollowUp?: boolean } = {},
): Call[] {
  const calls: Call[] = [];
  const stub = {
    interruptTask: (taskId: string) => {
      calls.push({ method: "interruptTask", args: [taskId] });
      return results.interruptTask ?? true;
    },
    sendFollowUp: (taskId: string, message: string) => {
      calls.push({ method: "sendFollowUp", args: [taskId, message] });
      return results.sendFollowUp ?? true;
    },
  };
  wsServer.sessionRegistry.setTaskManager(stub as unknown as TaskManager);
  return calls;
}

function openSocket(wsServer: ReturnType<typeof createWsServer>): MockWs {
  const ws = createWsMockWs();
  wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
  return ws;
}

describe("C2S taskInterrupt / taskFollowup", () => {
  let wsServer: ReturnType<typeof createWsServer> | null = null;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
    wsServer = null;
  });

  it("delegates taskInterrupt to TaskManager.interruptTask and replies ok", async () => {
    wsServer = makeServer();
    const ws = openSocket(wsServer);
    const calls = stubTaskManager(wsServer);

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.TASK_INTERRUPT, taskId: "task-1" }),
    );

    expect(calls).toEqual([{ method: "interruptTask", args: ["task-1"] }]);
    const reply = lastMessage(ws);
    expect(reply.type).toBe(S2C.TASK_CONTROL);
    expect(reply.taskId).toBe("task-1");
    expect(reply.action).toBe("interrupt");
    expect(reply.ok).toBe(true);
  });

  it("replies ok:false when the primitive declines (unknown/terminal task)", async () => {
    wsServer = makeServer();
    const ws = openSocket(wsServer);
    stubTaskManager(wsServer, { interruptTask: false });

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.TASK_INTERRUPT, taskId: "task-9" }),
    );

    const reply = lastMessage(ws);
    expect(reply.type).toBe(S2C.TASK_CONTROL);
    expect(reply.ok).toBe(false);
    expect(typeof reply.error).toBe("string");
  });

  it("delegates taskFollowup to TaskManager.sendFollowUp with the trimmed message", async () => {
    wsServer = makeServer();
    const ws = openSocket(wsServer);
    const calls = stubTaskManager(wsServer);

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.TASK_FOLLOWUP, taskId: "task-1", message: "  now focus on tests  " }),
    );

    expect(calls).toEqual([
      { method: "sendFollowUp", args: ["task-1", "now focus on tests"] },
    ]);
    const reply = lastMessage(ws);
    expect(reply.type).toBe(S2C.TASK_CONTROL);
    expect(reply.action).toBe("followup");
    expect(reply.ok).toBe(true);
  });

  it("replies ok:false when the task is not steerable", async () => {
    wsServer = makeServer();
    const ws = openSocket(wsServer);
    const calls = stubTaskManager(wsServer, { sendFollowUp: false });

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.TASK_FOLLOWUP, taskId: "task-1", message: "hello" }),
    );

    expect(calls).toEqual([{ method: "sendFollowUp", args: ["task-1", "hello"] }]);
    const reply = lastMessage(ws);
    expect(reply.ok).toBe(false);
    expect(typeof reply.error).toBe("string");
  });

  it("ignores underspecified requests (no taskId or empty message)", async () => {
    wsServer = makeServer();
    const ws = openSocket(wsServer);
    const calls = stubTaskManager(wsServer);
    const before = ws.messages.length;

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.TASK_INTERRUPT }));
    wsServer.onMessage(ws, JSON.stringify({ type: C2S.TASK_FOLLOWUP, taskId: "task-1" }));
    wsServer.onMessage(ws, JSON.stringify({ type: C2S.TASK_FOLLOWUP, taskId: "task-1", message: "   " }));

    expect(calls).toEqual([]);
    expect(ws.messages.length).toBe(before);
  });

  it("replies ok:false when no TaskManager is registered", async () => {
    wsServer = makeServer();
    const ws = openSocket(wsServer);
    wsServer.sessionRegistry.setTaskManager(null);

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.TASK_INTERRUPT, taskId: "task-1" }));

    const reply = lastMessage(ws);
    expect(reply.type).toBe(S2C.TASK_CONTROL);
    expect(reply.ok).toBe(false);
  });
});
