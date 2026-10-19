// Deleting a live webui/ws session must interrupt its delegate tasks. The
// ws host's registry SessionManager is built WITHOUT taskConfig (its
// TaskManager lives on the server and is published via setTaskManager), so
// the SessionManager-side cascade is a no-op here; the registry itself has
// to fire interruptTasksForSession on delete. Otherwise a deleted session's
// subagents keep running (and burning tokens) with nobody to receive the
// results.

import { describe, it, expect, afterEach } from "bun:test";
import { createWsServer } from "@extensions/websocket/server.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { TASK_STATUS } from "@core/session/task-manager.ts";
import type { AgentLike } from "@core/session/index.ts";
import {
  createWsMockCore,
  createWsMockWs,
} from "../mocks/websocket.ts";

type MockWs = ReturnType<typeof createWsMockWs>;
type WsServer = ReturnType<typeof createWsServer>;

// Session agents are inert; task agents (built with a sink) hang until their
// abortSignal fires -- #driveTurn assigns agent.abortSignal before run(), so
// the fake reads it off `this` at call time.
function hangingTaskBuildAgent(): (cfg: Record<string, unknown>) => Promise<AgentLike> {
  let sessionSeq = 0;
  return async (cfg: Record<string, unknown>) => {
    const sink = cfg.sink as { emit?: (e: unknown) => void } | undefined;
    if (sink) {
      return {
        abortSignal: null as AbortSignal | null,
        run: function (this: { abortSignal: AbortSignal }) {
          return new Promise((_resolve: (v?: unknown) => void, reject: (e: Error) => void) => {
            if (this.abortSignal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            this.abortSignal.addEventListener("abort", () => reject(new Error("aborted")));
          });
        },
        notifyCompletion: () => {},
      } as unknown as AgentLike;
    }
    const agent: any = {
      sessionId: `sess-${++sessionSeq}`,
      model: "test-model",
      run: async () => ({ type: "completion", content: "done" }),
      notifyCompletion: () => {},
      getMessages: () => [],
      hooks: {
        notifyHooks: () => {},
        runHookPipeline: async () => undefined,
        registerHook: () => {},
        unregisterHook: () => {},
      },
      serialize: () => ({}),
      applyProfile: () => {},
      cancel: () => {},
      resetCancel: () => {},
      executeCommand: async () => null,
      addMessage: () => {},
      clearContext: async () => {},
      profileName: "default",
      modelRegistry: {},
      sink: null,
      enqueueCallback: null,
      toolWhitelist: null,
      profileBody: undefined,
    };
    return agent as AgentLike;
  };
}

function messages(ws: MockWs): any[] {
  return ws.messages.map((m) => {
    try {
      return JSON.parse(m);
    } catch {
      return null;
    }
  });
}

async function settle(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("ws session delete interrupts delegate tasks", () => {
  let wsServer: WsServer | null = null;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
    wsServer = null;
  });

  async function openAttachedSocket(): Promise<{ ws: MockWs; sessionId: string }> {
    const ws = createWsMockWs();
    wsServer!.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    const deadline = Date.now() + 2000;
    for (;;) {
      const created = messages(ws).find((m) => m?.type === S2C.SESSION_CREATED);
      if (created) return { ws, sessionId: created.sessionId as string };
      if (Date.now() > deadline) throw new Error("socket never attached");
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  /** A second socket attaches to the most recent session; ask for its own. */
  async function createOwnSession(ws: MockWs, otherSessionId: string): Promise<string> {
    void wsServer!.onMessage(ws, JSON.stringify({ type: C2S.CREATE_SESSION }));
    const deadline = Date.now() + 2000;
    for (;;) {
      const created = messages(ws).find(
        (m) => m?.type === S2C.SESSION_CREATED && m.sessionId !== otherSessionId,
      );
      if (created) return created.sessionId as string;
      if (Date.now() > deadline) throw new Error("second session never created");
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  it("interrupts the deleted session's running task; other sessions survive", async () => {
    wsServer = createWsServer(createWsMockCore(), {
      buildAgent: hangingTaskBuildAgent() as never,
    });
    const { ws: wsA, sessionId: sidA } = await openAttachedSocket();
    const { ws: wsB } = await openAttachedSocket();
    const sidBOwn = await createOwnSession(wsB, sidA);
    expect(sidBOwn).not.toBe(sidA);

    const taskManager = wsServer.sessionRegistry.getTaskManager();
    expect(taskManager).not.toBeNull();

    await taskManager!.spawnTask("t-a", "work", { managerAgent: { sessionId: sidA } });
    await taskManager!.spawnTask("t-b", "work", { managerAgent: { sessionId: sidBOwn } });
    expect(taskManager!.taskStatus("t-a")).toBe(TASK_STATUS.RUNNING);
    expect(taskManager!.taskStatus("t-b")).toBe(TASK_STATUS.RUNNING);

    // The webui delete path: C2S deleteSession -> registry.delete().
    wsServer.onMessage(wsA, JSON.stringify({ type: C2S.DELETE_SESSION, sessionId: sidA }));
    expect(messages(wsA).some((m) => m?.type === S2C.SESSION_DELETED)).toBe(true);

    await settle(
      () => taskManager!.taskStatus("t-a") === TASK_STATUS.CANCELLED,
      "deleted session's task -> cancelled",
    );
    // Only the deleted session's tasks are interrupted.
    expect(taskManager!.taskStatus("t-b")).toBe(TASK_STATUS.RUNNING);

    // Clean up the survivor so no run promise stays pending.
    taskManager!.interruptTask("t-b");
    await settle(() => taskManager!.activeTasks().length === 0, "survivor cleanup");
  });

  it("deleting a session with no tasks is unaffected (no phantom interrupt)", async () => {
    wsServer = createWsServer(createWsMockCore(), {
      buildAgent: hangingTaskBuildAgent() as never,
    });
    const { ws, sessionId } = await openAttachedSocket();
    const taskManager = wsServer.sessionRegistry.getTaskManager();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.DELETE_SESSION, sessionId }));
    expect(messages(ws).some((m) => m?.type === S2C.SESSION_DELETED)).toBe(true);
    expect(taskManager!.listTasks()).toEqual([]);
  });
});
