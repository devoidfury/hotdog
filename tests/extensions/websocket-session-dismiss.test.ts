// Dismissing an idle live webui session: same teardown as Delete (registry.
// delete machinery) but the log FILE and the row's pin survive, and the id
// demotes into the cold Recent Logs list on the wire immediately (the
// requester gets SESSION_DELETED + refreshed SESSIONS/LOGS_LISTED broadcasts
// like every other attached tab). Harness idioms follow
// websocket-pin-store.test.ts (routeMessage over a real SessionRegistry,
// temp HOTDOG_SESSIONS_DIR) and websocket-session-delete-tasks.test.ts
// (createWsServer for the delegated-task interrupt leg).

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { TMP_PARENT } from "../mocks/io.ts";
import { join } from "node:path";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { createWsServer } from "@extensions/websocket/server.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { closePinStore, getPinnedIds, isPinned, setPinned } from "@extensions/websocket/pin-store.ts";
import { closeSessionIndex, getSessionRow, syncSessionFromLog } from "@core/session/session-index.ts";
import { TASK_STATUS } from "@core/session/task-types.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createWsMockCore, createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

const authStub = undefined as unknown as AuthMiddleware;
const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;
const coreStub = { completion: undefined } as unknown as CoreContext;

const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-session-dismiss-"));
let prevSessionsDir: string | undefined;

beforeAll(() => {
  prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
  process.env.HOTDOG_SESSIONS_DIR = TMP;
  closePinStore();
});

afterAll(() => {
  closePinStore();
  closeSessionIndex();
  if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
  else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
  rmSync(TMP, { recursive: true, force: true });
});

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeRegistry(agent: AgentLike): SessionRegistry {
  return new SessionRegistry({ buildAgent: async () => agent });
}

/** Fixture log in the exact shape the session-log extension produces; the
 *  mock core loads no extensions, so the test writes what a real session's
 *  teardown would have left on disk. */
function writeLog(logId: string): void {
  writeFileSync(
    join(TMP, `${logId}.jsonl`),
    JSON.stringify({ ts: "2026-10-20T00:00:00.000Z", session_id: logId, source: "input", content: "hi" }) + "\n",
  );
}

function parseMessages(ws: { messages: string[] }): Array<Record<string, unknown>> {
  return ws.messages
    .map((m) => {
      try {
        return JSON.parse(m) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((m): m is Record<string, unknown> => m !== null);
}

async function dismiss(
  registry: SessionRegistry,
  sessionId: unknown,
): Promise<{ ws: ReturnType<typeof createWsMockWs>; messages: Array<Record<string, unknown>> }> {
  const ws = createWsMockWs();
  // The requester is a registered connection like every production socket:
  // the sidebar broadcasts (not just the direct SESSION_DELETED) must reach it.
  registry.registerConnection(ws);
  await routeMessage(
    ws,
    { type: C2S.DISMISS_SESSION, sessionId } as never,
    registry,
    authStub,
    bridgeStub,
    coreStub,
  );
  await flush();
  return { ws, messages: parseMessages(ws) };
}

describe("dismissSession: demote an idle session to Recent Logs", () => {
  it("removes the live row, keeps the log file, and re-lands the id via LOGS_LISTED in every tab", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "dismiss-live" }));
    await registry.create({ profile: "manager" });
    writeLog("dismiss-live");

    const peer = createWsMockWs();
    registry.registerConnection(peer);

    const { messages } = await dismiss(registry, "dismiss-live");

    // Live half: gone from the registry, SESSION_DELETED on the requester.
    expect(registry.get("dismiss-live")).toBeNull();
    expect(messages.some((m) => m.type === S2C.SESSION_DELETED && m.sessionId === "dismiss-live")).toBe(true);
    // The log survives (this is not Delete).
    expect(existsSync(join(TMP, "dismiss-live.jsonl"))).toBe(true);
    // Demotion on the wire, in order: the refreshed SESSIONS no longer lists
    // the id, and the LOGS_LISTED payload carries it as a cold row.
    const sessionsFrames = messages.filter((m) => m.type === S2C.SESSIONS);
    expect(sessionsFrames.length).toBeGreaterThan(0);
    const liveIds = (sessionsFrames[sessionsFrames.length - 1]!.sessions as Array<{ id: string }>).map((r) => r.id);
    expect(liveIds).not.toContain("dismiss-live");
    const logsFrames = messages.filter((m) => m.type === S2C.LOGS_LISTED);
    expect(logsFrames.length).toBeGreaterThan(0);
    const cold = (logsFrames[logsFrames.length - 1]!.logs as Array<Record<string, unknown>>).find(
      (l) => l.id === "dismiss-live",
    );
    expect(cold).toBeDefined();
    expect(cold!.messageCount).toBe(1);
    const deletedAt = messages.findIndex((m) => m.type === S2C.SESSION_DELETED);
    const listedAt = messages.findIndex((m) => m.type === S2C.LOGS_LISTED);
    expect(deletedAt).toBeLessThan(listedAt);

    // The peer tab sees the same demotion without asking (broadcasts).
    const peerMsgs = parseMessages(peer);
    expect(peerMsgs.some((m) => m.type === S2C.SESSION_DELETED && m.sessionId === "dismiss-live")).toBe(true);
    const peerLogs = peerMsgs.filter((m) => m.type === S2C.LOGS_LISTED).pop()!;
    expect((peerLogs.logs as Array<Record<string, unknown>>).some((l) => l.id === "dismiss-live")).toBe(true);
  });

  it("the pin on the dismissed id survives; Delete prunes it (the contrast)", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "dismiss-pinned" }));
    await registry.create({ profile: "manager" });
    writeLog("dismiss-pinned");
    setPinned("dismiss-pinned", true);

    const { messages } = await dismiss(registry, "dismiss-pinned");

    expect(isPinned("dismiss-pinned")).toBe(true);
    closePinStore();
    expect(getPinnedIds().has("dismiss-pinned")).toBe(true);
    // The demoted cold row arrives already pin-marked.
    const logsFrames = messages.filter((m) => m.type === S2C.LOGS_LISTED);
    const cold = (logsFrames[logsFrames.length - 1]!.logs as Array<Record<string, unknown>>).find(
      (l) => l.id === "dismiss-pinned",
    );
    expect(cold!.pinned).toBe(true);

    // Contrast: the sibling Delete prunes the same kind of pin.
    const reg2 = makeRegistry(makeWsMockAgent({ sessionId: "delete-pinned" }));
    await reg2.create({ profile: "manager" });
    setPinned("delete-pinned", true);
    await routeMessage(
      createWsMockWs(),
      { type: C2S.DELETE_SESSION, sessionId: "delete-pinned" } as never,
      reg2,
      authStub,
      bridgeStub,
      coreStub,
    );
    await flush();
    expect(isPinned("delete-pinned")).toBe(false);
  });

  it("the session index row is intact after teardown; the cold row renders with its state", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "dismiss-indexed" }));
    await registry.create({ profile: "manager" });
    writeLog("dismiss-indexed");
    // Seed the index the way the session-log extension would for a live run.
    const rowBefore = await syncSessionFromLog("dismiss-indexed");
    expect(rowBefore).not.toBeNull();

    const { messages } = await dismiss(registry, "dismiss-indexed");

    // registry.delete's teardown (bus cancel, SESSION_END re-fire) must not
    // have touched the index row the cold sidebar row enriches from.
    const rowAfter = getSessionRow("dismiss-indexed");
    expect(rowAfter).not.toBeNull();
    expect(rowAfter!.state).toBe(rowBefore!.state);
    const logsFrames = messages.filter((m) => m.type === S2C.LOGS_LISTED);
    const cold = (logsFrames[logsFrames.length - 1]!.logs as Array<Record<string, unknown>>).find(
      (l) => l.id === "dismiss-indexed",
    );
    expect(cold!.state).toBe(rowBefore!.state);
  });

  it("malformed ids are dropped: no frames, no teardown", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "dismiss-keeper" }));
    await registry.create({ profile: "manager" });

    for (const bad of ["../escape", "", "has/slash", 42, null, undefined]) {
      const { messages } = await dismiss(registry, bad);
      expect(messages).toEqual([]);
    }
    expect(registry.get("dismiss-keeper")).not.toBeNull();
    registry.delete("dismiss-keeper");
  });

  it("an unknown but well-formed id is a no-op: no frames, nothing torn down", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "dismiss-other" }));
    await registry.create({ profile: "manager" });

    const { messages } = await dismiss(registry, "never-lived");
    expect(messages).toEqual([]);
    expect(registry.list().map((s) => s.id)).toEqual(["dismiss-other"]);
    registry.delete("dismiss-other");
  });

  it("busy guard: a running session refuses; the session stays alive and dismissable once idle", async () => {
    const registry = makeRegistry(makeWsMockAgent({ sessionId: "dismiss-busy" }));
    await registry.create({ profile: "manager" });
    writeLog("dismiss-busy");
    // The same server-side truth the attach path reports as "working".
    registry.getSessionManager().getBus("dismiss-busy")!.isRunning = true;

    const { messages } = await dismiss(registry, "dismiss-busy");

    // Honest refusal, nothing partial: ERROR only, row still live.
    expect(messages.length).toBe(1);
    expect(messages[0]!.type).toBe(S2C.ERROR);
    expect(String(messages[0]!.message)).toContain("running");
    expect(messages.some((m) => m.type === S2C.SESSION_DELETED)).toBe(false);
    expect(registry.get("dismiss-busy")).not.toBeNull();

    // The refusal is not sticky: idle again -> dismiss proceeds.
    registry.getSessionManager().getBus("dismiss-busy")!.isRunning = false;
    const again = await dismiss(registry, "dismiss-busy");
    expect(registry.get("dismiss-busy")).toBeNull();
    expect(again.messages.some((m) => m.type === S2C.SESSION_DELETED)).toBe(true);
  });
});

// ── Delegated tasks: the shared registry.delete teardown path ──────────────
// The per-session task interrupt lives in registry.delete (pinned wholesale
// by websocket-session-delete-tasks.test.ts); this leg only pins that the
// dismiss handler routes through it -- so a dismissed session's delegates
// stop burning tokens with nobody to receive results.

/** Session agents inert; task agents (built with a sink) hang until their
 *  abortSignal fires -- the delete-tasks harness idiom, trimmed. */
function idleTaskBuildAgent(): (cfg: Record<string, unknown>) => Promise<AgentLike> {
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
    return makeWsMockAgent({ sessionId: `dismiss-task-${++sessionSeq}` });
  };
}

describe("dismissSession interrupts the dismissed session's delegated tasks", () => {
  let wsServer: ReturnType<typeof createWsServer> | null = null;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
    wsServer = null;
  });

  async function openAttachedSocket(): Promise<{ ws: ReturnType<typeof createWsMockWs>; sessionId: string }> {
    const ws = createWsMockWs();
    wsServer!.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    const deadline = Date.now() + 2000;
    for (;;) {
      const created = parseMessages(ws).find((m) => m?.type === S2C.SESSION_CREATED);
      if (created) return { ws, sessionId: created.sessionId as string };
      if (Date.now() > deadline) throw new Error("socket never attached");
      await new Promise((r) => setTimeout(r, 1));
    }
  }

  async function settle(pred: () => boolean, what: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  it("a dismissed session's running task is interrupted and the live row demotes", async () => {
    wsServer = createWsServer(createWsMockCore(), {
      buildAgent: idleTaskBuildAgent() as never,
    });
    const { ws, sessionId } = await openAttachedSocket();
    const taskManager = wsServer.sessionRegistry.getTaskManager();
    expect(taskManager).not.toBeNull();

    await taskManager!.spawnTask("t-dismiss", "work", { managerAgent: { sessionId } });
    expect(taskManager!.taskStatus("t-dismiss")).toBe(TASK_STATUS.RUNNING);

    void wsServer.onMessage(ws, JSON.stringify({ type: C2S.DISMISS_SESSION, sessionId }));
    expect(parseMessages(ws).some((m) => m?.type === S2C.SESSION_DELETED)).toBe(true);
    expect(wsServer.sessionRegistry.get(sessionId)).toBeNull();

    await settle(
      () => taskManager!.taskStatus("t-dismiss") === TASK_STATUS.CANCELLED,
      "dismissed session's task -> cancelled",
    );
  });
});
