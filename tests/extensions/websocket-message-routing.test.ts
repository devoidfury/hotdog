// Unit tests for message-routing.ts -- the per-type handlers are driven
// through routeMessage directly (a stub registry, a mock socket) instead of
// the full server, targeting the async error closures the server tests never
// reach: create/fork/listLogs/viewLog/loadLog failures, the AUTH fallback
// paths, plus the profiles handlers. Filesystem faults are real: a chmod-000
// session log rejects readFile (EACCES) exactly as a broken disk would.
//
// Known-uncachable: the deleteSessionLog .catch (session-log swallows every
// unlink error into `false`, so that closure is dead code by construction).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

function stubRegistry(overrides: Record<string, unknown> = {}): any {
  return {
    get: () => undefined,
    list: () => [],
    size: 0,
    create: async () => ({ sessionId: "new-1", agent: makeWsMockAgent() }),
    createChannel: () => ({}),
    removeChannel: () => {},
    registerConnection: () => {},
    removePendingAuth: () => {},
    sendTaskSnapshot: () => {},
    broadcast: () => {},
    broadcastExcept: () => {},
    listProfiles: () => [{ name: "default" }],
    switchProfile: async () => ({ success: true }),
    touch: () => {},
    incrementUserMessageCount: () => {},
    rename: () => {},
    delete: () => {},
    getSessionManager: () => ({
      isSessionRunning: () => false,
      getBus: () => undefined,
      enqueue: () => {},
      interrupt: () => {},
    }),
    getTaskManager: () => null,
    sttEnabled: false,
    toolExecLabel: "inline",
    sttTarget: null,
    ...overrides,
  } as unknown as any;
}

const authStub = { validateToken: (token: string) => token === "good" } as unknown as AuthMiddleware;
const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;
const coreStub = { completion: undefined } as unknown as CoreContext;

/** Let fire-and-forget .then/.catch chains settle. */
async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function send(
  msg: Record<string, unknown>,
  registry: any = stubRegistry(),
  auth: AuthMiddleware | undefined = undefined,
  ws = createWsMockWs(),
): Promise<{ ws: typeof ws; messages: Array<Record<string, unknown>> }> {
  await routeMessage(ws, msg as any, registry, auth, bridgeStub, coreStub);
  await flush();
  return { ws, messages: ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>) };
}

// ── Sessions/logs fixture dir (real files, real faults) ─────────────────────

const TMP = mkdtempSync(join(tmpdir(), "hotdog-ws-routing-"));
const VIEW_LOG_ID = "view-img-log";
const BROKEN_LOG_ID = "unreadable-log";

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = TMP;
  writeFileSync(
    join(TMP, `${VIEW_LOG_ID}.jsonl`),
    [
      JSON.stringify({
        ts: "2026-10-20T00:00:00Z",
        session_id: VIEW_LOG_ID,
        source: "input",
        content: "with an image",
        images: [{ mimeType: "image/png", data: "aGVsbG8=" }],
      }),
      JSON.stringify({
        ts: "2026-10-20T00:00:01Z",
        session_id: VIEW_LOG_ID,
        source: "llm",
        content: "reply, no image",
      }),
    ].join("\n") + "\n",
  );
  writeFileSync(join(TMP, `${BROKEN_LOG_ID}.jsonl`), '{"unreachable": true}\n');
  chmodSync(join(TMP, `${BROKEN_LOG_ID}.jsonl`), 0o000);
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try { chmodSync(join(TMP, `${BROKEN_LOG_ID}.jsonl`), 0o644); } catch {}
  rmSync(TMP, { recursive: true, force: true });
});

describe("routeMessage: profiles handlers", () => {
  it("LIST_PROFILES answers with the registry's profiles", async () => {
    const { messages } = await send({ type: C2S.LIST_PROFILES });
    expect(messages).toEqual([{ type: S2C.PROFILES, profiles: [{ name: "default" }] }]);
  });

  it("SWITCH_PROFILE reports success", async () => {
    const { messages } = await send({ type: C2S.SWITCH_PROFILE, sessionId: "s1", profileName: "coder" });
    expect(messages).toEqual([
      { type: S2C.PROFILE_SWITCHED, sessionId: "s1", profile: "coder", success: true },
    ]);
  });

  it("SWITCH_PROFILE failure carries the reason, or the generic one", async () => {
    const withReason = await send(
      { type: C2S.SWITCH_PROFILE, sessionId: "s1", profileName: "ghost" },
      stubRegistry({ switchProfile: async () => ({ success: false, error: "no such profile" }) }),
    );
    expect(withReason.messages).toEqual([{ type: S2C.ERROR, message: "no such profile" }]);

    const withoutReason = await send(
      { type: C2S.SWITCH_PROFILE, sessionId: "s1", profileName: "ghost" },
      stubRegistry({ switchProfile: async () => ({ success: false }) }),
    );
    expect(withoutReason.messages).toEqual([{ type: S2C.ERROR, message: "Profile switch failed" }]);
  });
});

describe("routeMessage: async error closures", () => {
  it("CREATE_SESSION surfaces an agent-factory failure as ERROR", async () => {
    const { messages } = await send(
      { type: C2S.CREATE_SESSION },
      stubRegistry({ create: async () => { throw new Error("agent factory exploded"); } }),
    );
    expect(messages).toEqual([{ type: S2C.ERROR, message: "agent factory exploded" }]);
  });

  it("/fork failure surfaces as ERROR instead of stranding the socket", async () => {
    const { messages } = await send(
      { type: C2S.COMMAND, sessionId: "s1", command: "/fork 2 continue please" },
      stubRegistry({ fork: async () => { throw new Error("fork source session gone"); } }),
    );
    expect(messages).toEqual([{ type: S2C.ERROR, message: "fork source session gone" }]);
  });

  it("LIST_LOGS surfaces a directory read failure as ERROR", async () => {
    // Point the sessions dir at a regular file: readdir rejects (ENOTDIR).
    const fileAsDir = join(TMP, "not-a-dir");
    writeFileSync(fileAsDir, "x\n");
    const prev = process.env.HOTDOG_SESSIONS_DIR;
    process.env.HOTDOG_SESSIONS_DIR = fileAsDir;
    try {
      const { messages } = await send({ type: C2S.LIST_LOGS });
      expect(messages).toHaveLength(1);
      expect(messages[0]!.type).toBe(S2C.ERROR);
    } finally {
      process.env.HOTDOG_SESSIONS_DIR = prev;
    }
  });

  it("VIEW_LOG returns entries, capping images and passing image-free entries through", async () => {
    const { messages } = await send({ type: C2S.VIEW_LOG, logId: VIEW_LOG_ID });
    expect(messages).toHaveLength(1);
    const viewed = messages[0]!;
    expect(viewed.type).toBe(S2C.LOG_VIEWED);
    expect(viewed.logId).toBe(VIEW_LOG_ID);
    const entries = viewed.entries as Array<Record<string, unknown>>;
    expect(entries).toHaveLength(2);
    expect(entries[0]!.images).toEqual([{ mimeType: "image/png", data: "aGVsbG8=" }]);
    expect(entries[1]!.images).toBeUndefined();
    expect(entries[1]!.content).toBe("reply, no image");
  });

  it("VIEW_LOG surfaces an unreadable log as ERROR", async () => {
    const { messages } = await send({ type: C2S.VIEW_LOG, logId: BROKEN_LOG_ID });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe(S2C.ERROR);
  });

  it("LOAD_LOG surfaces a failed cold-resume attach as ERROR", async () => {
    // The log exists (sessionPath resolves) but is unreadable: the live
    // attach's log read rejects, and the handler's catch answers in-band.
    const { messages } = await send(
      { type: C2S.LOAD_LOG, logId: BROKEN_LOG_ID },
      stubRegistry({ get: () => ({ agent: makeWsMockAgent() }) }),
    );
    expect(messages).toHaveLength(1);
    expect(messages[0]!.type).toBe(S2C.ERROR);
  });

  it("DELETE_LOG reports missing logs instead of failing silently", async () => {
    const { messages } = await send({ type: C2S.DELETE_LOG, logId: "log-never-written" });
    expect(messages).toEqual([{ type: S2C.ERROR, message: "Log log-never-written not found" }]);
  });

  it("DELETE_LOG confirms deletion and broadcasts it", async () => {
    const gone = join(TMP, "delete-me.jsonl");
    writeFileSync(gone, "{}\n");
    const reg = stubRegistry();
    const broadcasted: unknown[] = [];
    reg.broadcast = (m: unknown) => { broadcasted.push(m); };
    const { messages } = await send({ type: C2S.DELETE_LOG, logId: "delete-me" }, reg);
    expect(messages).toEqual([{ type: S2C.LOG_DELETED, logId: "delete-me" }]);
    expect(broadcasted).toEqual([{ type: S2C.LOG_DELETED, logId: "delete-me" }]);
  });
});

describe("routeMessage: AUTH attach fallbacks", () => {
  function authMsg() {
    return { type: C2S.AUTH, token: "good" };
  }

  it("resume attach failure falls back to a fresh session with the reason", async () => {
    // Live session whose log read rejects: attachResumedSession rejects, the
    // AUTH catch logs it and fallbackAttaches; with no other sessions that
    // means a fresh create, then the honest error after the attach burst.
    const reg = stubRegistry({ get: () => ({ agent: makeWsMockAgent() }) });
    const ws = createWsMockWs();
    ws.resumeSessionId = BROKEN_LOG_ID;
    const { messages } = await send(authMsg(), reg, authStub, ws);

    expect(messages.map((m) => m.type)).toEqual([
      S2C.AUTH_OK,
      S2C.SESSION_CREATED,
      S2C.SESSION_STATE,
      S2C.ERROR,
    ]);
    expect(messages[3]!.message).toBe("Session resume failed.");
  });

  it("most-recent attach failure is logged and leaves the socket silent", async () => {
    // size > 0 routes the post-AUTH attach to the most-recent session, but
    // list() throws: the .catch closure must consume the rejection (an
    // unhandled one fails the test run) without pretending to attach.
    let listCalls = 0;
    const reg = stubRegistry();
    reg.list = () => {
      listCalls++;
      throw new Error("index exploded");
    };
    Object.defineProperty(reg, "size", { get: () => (listCalls === 0 ? 1 : 0) });
    const { ws, messages } = await send(authMsg(), reg, authStub);

    expect(listCalls).toBe(1);
    expect(ws.attachStarted).toBe(true);
    expect(messages.map((m) => m.type)).toEqual([S2C.AUTH_OK]);
  });

  it("AUTH registers the socket and clears pending-auth on a valid token", async () => {
    let registered = false;
    let pendingCleared = false;
    const reg = stubRegistry();
    reg.registerConnection = () => { registered = true; };
    reg.removePendingAuth = () => { pendingCleared = true; };
    const { messages } = await send(authMsg(), reg, authStub);
    expect(registered).toBe(true);
    expect(pendingCleared).toBe(true);
    expect(messages.map((m) => m.type)).toEqual([S2C.AUTH_OK, S2C.SESSION_CREATED, S2C.SESSION_STATE]);
  });
});
