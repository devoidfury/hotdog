// Tests for WebSocket server — SessionRegistry, message routing, auth gate,
// cold log operations, history replay, and question tool integration.
// (Merged from websocket-server.test.ts + websocket-server-extended.test.ts.)

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, mock, Mock } from "bun:test";
import { SessionRegistry, createWsServer, type HotdogServerSocket } from "../../src/extensions/websocket/server.ts";
import { C2S, S2C } from "../../src/extensions/websocket/protocol.ts";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import { MessageLog } from "../../src/core/context/message-log.ts";
import type { AgentLike } from "../../src/core/session/index.ts";
import { createWsMockCore, createWsMockAgentFactory, createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";
import { createFixture, simpleTool } from "../helpers.ts";
import { Message } from "../../src/core/context/message.ts";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";

type MockWs = ReturnType<typeof createWsMockWs>;

// Isolated sessions dir for cold-log tests (listLogs/viewLog/loadLog/deleteLog).
const SESSIONS_DIR = mkdtempSync(join(os.tmpdir(), "hotdog-sessions-ws-"));
const FIXTURE_LOG_ID = "ws-fixture-log";

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try { rmSync(SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

/** Write a fixture session log (one user input, one assistant reply). */
function writeFixtureLog(logId: string) {
  const lines = [
    JSON.stringify({ ts: "2024-01-01T00:00:00Z", session_id: logId, source: "input", content: "loaded input" }),
    JSON.stringify({ ts: "2024-01-01T00:00:01Z", session_id: logId, source: "llm", content: "loaded reply" }),
  ];
  writeFileSync(join(SESSIONS_DIR, `${logId}.jsonl`), lines.join("\n") + "\n");
}

/**
 * Poll the mock socket until a message of the given type arrives.
 * Replaces fixed sleeps: deterministic on completion, fails loudly on timeout.
 * `after` limits the scan to messages sent after a given index.
 */
async function waitForMessage(ws: MockWs, type: string, opts: { timeoutMs?: number; after?: number } = {}): Promise<any> {
  const { timeoutMs = 2000, after = 0 } = opts;
  const start = Date.now();
  for (;;) {
    const found = ws.messages.slice(after)
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && m.type === type);
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${type} message`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function lastMessage(ws: MockWs): any {
  return JSON.parse(ws.messages[ws.messages.length - 1]!);
}

function messageTypes(ws: MockWs): string[] {
  return ws.messages
    .filter((m) => m && m !== "undefined")
    .map((m) => {
      try { return JSON.parse(m).type; } catch { return null; }
    })
    .filter(Boolean);
}

// ── SessionRegistry Tests ───────────────────────────────────────────────────

describe("SessionRegistry", () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry({
      buildAgent: createWsMockAgentFactory(),
      questionTimeoutSecs: 300,
      questionStrategy: "wait",
      sessionTimeoutMin: 30,
    });
  });

  afterEach(() => {
    registry.stopCleanupLoop();
  });

  it("creates session with agent-provided sessionId", async () => {
    const buildAgent = async () => makeWsMockAgent({ sessionId: "agent-session-123" });
    registry = new SessionRegistry({ buildAgent });
    const result = await registry.create();
    expect(result.sessionId).toBe("agent-session-123");
  });

  it("uses the proposed sessionId when the agent has none of its own", async () => {
    let proposed: string | undefined;
    const buildAgent = async (config: { sessionId?: string }) => {
      proposed = config.sessionId;
      const agent = makeWsMockAgent();
      (agent as any).sessionId = undefined; // agent declines to pick its own id
      return agent;
    };
    registry = new SessionRegistry({ buildAgent });
    const result = await registry.create();
    expect(result.sessionId).toBe(proposed!);
    expect(registry.get(result.sessionId)).toBeDefined();
  });

  it("returns null for non-existent session", () => {
    expect(registry.get("non-existent")).toBeNull();
  });

  it("lists all sessions", async () => {
    const { sessionId } = await registry.create();

    const sessions = registry.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(sessionId);
  });

  it("deletes session and removes it from the registry", async () => {
    const { sessionId } = await registry.create();

    const result = registry.delete(sessionId);
    expect(result).toBe(true);
    expect(registry.get(sessionId)).toBeNull();
    expect(registry.list()).toHaveLength(0);
  });

  describe("switchProfile", () => {
    it("applies the full profile (role, model, whitelist, blacklist) and clears context", async () => {
      const { agent, toolRegistry } = createFixture({
        model: "prov/old-model",
        modelRegistry: {
          "prov/old-model": { name: "old-model", contextLimit: 128000 },
          "prov/new-model": { name: "new-model", contextLimit: 64000 },
        },
      });
      toolRegistry.register("alpha", simpleTool("alpha"));
      toolRegistry.register("beta", simpleTool("beta"));
      agent.addMessage(new Message({ role: "user", content: "hello" }));

      const wsRegistry = new SessionRegistry({
        buildAgent: async () => agent,
        profiles: {
          coder: {
            role: "Coder role",
            body: "",
            model: "prov/new-model",
            whitelistTools: ["alpha"],
            blacklistTools: [],
          },
        },
      });
      const { sessionId } = await wsRegistry.create({});

      const result = await wsRegistry.switchProfile({ sessionId, profileName: "coder" });
      expect(result.success).toBe(true);

      expect(agent.profileName).toBe("coder");
      expect(agent.role).toBe("Coder role");
      expect(agent.model).toBe("prov/new-model");
      expect(wsRegistry.get(sessionId)!.metadata.model).toBe("prov/new-model");
      expect(agent.contextLimit).toBe(64000);
      expect(agent.toolWhitelist).toEqual(["alpha"]);
      // The UI confirmation exists for this wipe.
      expect(agent.context.log.getAll()).toHaveLength(0);
      // The whitelist restricts the tools advertised from the next turn on.
      const names = (await agent.getToolDefs()).map((d) => d.function.name);
      expect(names).toEqual(["alpha"]);
    });

    it("requires confirmation after a user message, and force overrides it", async () => {
      const { agent } = createFixture({});
      const wsRegistry = new SessionRegistry({
        buildAgent: async () => agent,
        profiles: { coder: { role: "R", body: "", model: null, whitelistTools: null, blacklistTools: [] } },
      });
      const { sessionId } = await wsRegistry.create({});
      wsRegistry.incrementUserMessageCount(sessionId);

      const guarded = await wsRegistry.switchProfile({ sessionId, profileName: "coder" });
      expect(guarded).toEqual({ success: false, requiresConfirmation: true });
      expect(agent.profileName).toBe("test"); // untouched

      const forced = await wsRegistry.switchProfile({ sessionId, profileName: "coder", force: true });
      expect(forced).toEqual({ success: true, requiresConfirmation: false });
      expect(agent.profileName).toBe("coder");
    });

    it("errors on unknown profiles and unknown sessions", async () => {
      const { sessionId } = await registry.create();
      const unknownProfile = await registry.switchProfile({ sessionId, profileName: "ghost" });
      expect(unknownProfile.error).toBe('Profile "ghost" not found');
      const unknownSession = await registry.switchProfile({ sessionId: "nope", profileName: "default" });
      expect(unknownSession.error).toBe("Session not found");
    });
  });

  it("returns false when deleting non-existent session", () => {
    expect(registry.delete("non-existent")).toBe(false);
  });

  it("closes channels when deleting session", async () => {
    const result = await registry.create();
    const ws = createWsMockWs();
    const channel = registry.createChannel(result.sessionId, ws)!;

    const closeMock = mock(() => {});
    (channel as any).close = closeMock;

    registry.delete(result.sessionId);

    expect(closeMock).toHaveBeenCalled();
    expect(registry.size).toBe(0);
  });

  it("renames session profile", async () => {
    const result = await registry.create({ profile: "old-name" });
    expect(registry.rename(result.sessionId, "new-name")).toBe(true);
    expect(registry.get(result.sessionId)!.metadata.profile).toBe("new-name");
  });

  it("returns false when renaming non-existent session", () => {
    expect(registry.rename("non-existent", "new-profile")).toBe(false);
  });

  it("touches session to update lastActivityAt", async () => {
    const { sessionId } = await registry.create();

    const meta = registry._test_metadata.get(sessionId)!;
    meta.lastActivityAt = Date.now() - 10000;
    const before = meta.lastActivityAt;
    registry.touch(sessionId);
    expect(registry._test_metadata.get(sessionId)!.lastActivityAt).toBeGreaterThan(before);
  });

  it("creates multiple channels for the same session", async () => {
    const result = await registry.create();
    const channel1 = registry.createChannel(result.sessionId, createWsMockWs());
    const channel2 = registry.createChannel(result.sessionId, createWsMockWs());

    expect(channel1).toBeDefined();
    expect(channel2).toBeDefined();
    expect(channel1).not.toBe(channel2);
    expect(registry.get(result.sessionId)!.metadata.connectedClients).toBe(2);
  });

  it("createChannel returns undefined for non-existent session", () => {
    expect(registry.createChannel("non-existent", createWsMockWs())).toBeUndefined();
  });

  it("cleans up idle sessions with 0 connected clients", async () => {
    const result = await registry.create();
    const meta = registry._test_metadata.get(result.sessionId);
    if (meta) meta.lastActivityAt = Date.now() - 100 * 60 * 1000; // 100 minutes ago
    registry._test_cleanupIdleSessions();

    expect(registry.get(result.sessionId)).toBeNull();
  });

  it("does not clean up sessions with connected clients", async () => {
    const result = await registry.create();
    const meta = registry._test_metadata.get(result.sessionId);
    if (meta) {
      meta.lastActivityAt = Date.now() - 100 * 60 * 1000;
      meta.connectedClients = 1;
    }
    registry._test_cleanupIdleSessions();

    expect(registry.get(result.sessionId)).not.toBeNull();
  });

  it("does not clean up recently active sessions", async () => {
    const result = await registry.create();
    registry._test_cleanupIdleSessions();

    expect(registry.get(result.sessionId)).not.toBeNull();
  });

  it("broadcasts to all open connections and skips closed ones", () => {
    const ws1 = { readyState: 1, send: mock(() => {}) } as unknown as HotdogServerSocket;
    const ws2 = { readyState: 1, send: mock(() => {}) } as unknown as HotdogServerSocket;
    const closed = { readyState: 2, send: mock(() => {}) } as unknown as HotdogServerSocket;

    registry.registerConnection(ws1);
    registry.registerConnection(ws2);
    registry.registerConnection(closed);

    registry.broadcast({ type: "test", data: "hello" });

    expect((ws1.send as unknown as Mock<() => void>).mock.calls.length).toBe(1);
    expect((ws2.send as unknown as Mock<() => void>).mock.calls.length).toBe(1);
    expect((closed.send as unknown as Mock<() => void>).mock.calls.length).toBe(0);

    const payload = JSON.parse(((ws1.send as unknown as Mock<() => void>).mock.calls as unknown[][])[0]![0] as string);
    expect(payload.type).toBe("test");
    expect(payload.data).toBe("hello");
  });

  it("handles broadcast send errors gracefully", () => {
    const failingWs = {
      readyState: 1,
      send: mock(() => { throw new Error("Send failed"); }),
    } as unknown as HotdogServerSocket;
    const workingWs = { readyState: 1, send: mock(() => {}) } as unknown as HotdogServerSocket;

    registry.registerConnection(failingWs);
    registry.registerConnection(workingWs);

    // Broadcast should not throw and should still send to working connections
    expect(() => registry.broadcast({ type: "test" })).not.toThrow();
    expect((workingWs.send as unknown as Mock<() => void>).mock.calls.length).toBe(1);
  });
});

// ── createWsServer Tests ────────────────────────────────────────────────────

describe("createWsServer", () => {
  let wsServer: ReturnType<typeof createWsServer>;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
  });

  /** Create a server, open a connection, and wait for the auto-created session. */
  async function connectWithSession(opts: Parameters<typeof createWsServer>[1] = { buildAgent: createWsMockAgentFactory() }): Promise<MockWs> {
    const core = createWsMockCore();
    wsServer = createWsServer(core, opts);

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await waitForMessage(ws, S2C.SESSION_CREATED);
    return ws;
  }

  it("handles CREATE_SESSION message", async () => {
    const ws = await connectWithSession();
    const firstSessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;
    const before = ws.messages.length;

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.CREATE_SESSION, profile: "test-profile", model: "custom-model" }));

    // A second sessionCreated (the first was the auto-attached one); the
    // switch to it is reflected on the socket and it is a new session.
    const created = await waitForMessage(ws, S2C.SESSION_CREATED, { after: before });
    expect(created.sessionId).not.toBe(firstSessionId);
    expect((ws as unknown as HotdogServerSocket).activeSessionId).toBe(created.sessionId);
    expect(created.profile).toBeDefined();
    expect(created.currentModel).toBeDefined();
  });

  it("handles DELETE_SESSION message", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.DELETE_SESSION, sessionId }));

    const deleted = lastMessage(ws);
    expect(deleted.type).toBe(S2C.SESSION_DELETED);
    expect(deleted.sessionId).toBe(sessionId);
  });

  it("handles LIST_SESSIONS message", async () => {
    const ws = await connectWithSession();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LIST_SESSIONS }));

    const msg = lastMessage(ws);
    expect(msg.type).toBe(S2C.SESSIONS);
    expect(Array.isArray(msg.sessions)).toBe(true);
    expect(msg.sessions.map((s: { id: string }) => s.id)).toContain((ws as unknown as HotdogServerSocket).activeSessionId);
  });

  it("handles SEND message by enqueuing content on the session", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    const enqueued: Array<[string, string]> = [];
    const sessionManager = wsServer.sessionRegistry.getSessionManager();
    const originalEnqueue = sessionManager.enqueue;
    sessionManager.enqueue = async (sid: string, content: string) => { enqueued.push([sid, content]); };

    try {
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.SEND, sessionId, content: "Hello!" }));
      await new Promise((r) => setTimeout(r, 10));
      expect(enqueued).toEqual([[sessionId, "Hello!"]]);
    } finally {
      sessionManager.enqueue = originalEnqueue;
    }
  });

  it("does not enqueue SEND when sessionId or content is missing", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    const sessionManager = wsServer.sessionRegistry.getSessionManager();
    let enqueueCalled = false;
    const originalEnqueue = sessionManager.enqueue;
    sessionManager.enqueue = async () => { enqueueCalled = true; };

    try {
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.SEND, content: "Hello" }));
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.SEND, sessionId }));
      await new Promise((r) => setTimeout(r, 10));
      expect(enqueueCalled).toBe(false);
    } finally {
      sessionManager.enqueue = originalEnqueue;
    }
  });

  it("handles CANCEL message by interrupting the session", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    const sessionManager = wsServer.sessionRegistry.getSessionManager();
    const originalInterrupt = sessionManager.interrupt;
    const interrupted: string[] = [];
    sessionManager.interrupt = ((sid: string) => { interrupted.push(sid); });

    try {
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.CANCEL, sessionId }));
      expect(interrupted).toEqual([sessionId]);
    } finally {
      sessionManager.interrupt = originalInterrupt;
    }
  });

  it("handles COMMAND message, stripping the leading slash", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    const sessionManager = wsServer.sessionRegistry.getSessionManager();
    let executedCommand = "";
    const originalExecuteCommand = sessionManager.executeCommand;
    sessionManager.executeCommand = async (_sessionId: string, cmd: string) => {
      executedCommand = cmd;
      return 0;
    };

    try {
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.COMMAND, sessionId, command: "/model gpt-4" }));
      await new Promise((r) => setTimeout(r, 10));
      expect(executedCommand).toBe("model gpt-4");
    } finally {
      sessionManager.executeCommand = originalExecuteCommand;
    }
  });

  it("handles QUESTION_ANSWER message (no pending question → error)", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    await wsServer.onMessage(ws, JSON.stringify({
      type: C2S.QUESTION_ANSWER,
      sessionId,
      answers: { q1: "answer1" },
    }));

    const msg = lastMessage(ws);
    expect(msg.type).toBe(S2C.ERROR);
    expect(msg.message).toContain("No pending question");
  });

  it("handles unknown message type", async () => {
    const ws = await connectWithSession();

    wsServer.onMessage(ws, JSON.stringify({ type: "unknownType" }));

    const msg = lastMessage(ws);
    expect(msg.type).toBe(S2C.ERROR);
    expect(msg.message).toContain("Unknown message type");
  });

  it("handles invalid JSON", async () => {
    const ws = await connectWithSession();

    wsServer.onMessage(ws, "not valid json");

    const msg = lastMessage(ws);
    expect(msg.type).toBe(S2C.ERROR);
    expect(msg.message).toBe("Invalid JSON");
  });

  it("handles message without type", async () => {
    const ws = await connectWithSession();

    wsServer.onMessage(ws, JSON.stringify({ data: "hello" }));

    const msg = lastMessage(ws);
    expect(msg.type).toBe(S2C.ERROR);
    expect(msg.message).toBe("Message type required");
  });

  it("closes connection on close handler and removes channel", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    const meta = wsServer.sessionRegistry._test_metadata.get(sessionId!);
    expect(meta!.connectedClients).toBeGreaterThan(0);

    wsServer.onClose(ws);

    const metaAfter = wsServer.sessionRegistry._test_metadata.get(sessionId!);
    expect(metaAfter!.connectedClients).toBe(0);
  });

  it("handles RENAME_SESSION message", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.RENAME_SESSION, sessionId, newName: "renamed" }));

    const meta = wsServer.sessionRegistry._test_metadata.get(sessionId!);
    expect(meta!.profile).toBe("renamed");
  });

  it("handles SWITCH_SESSION message", async () => {
    const ws = await connectWithSession();

    const second = await wsServer.sessionRegistry.create({});

    await wsServer.onMessage(ws, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: second.sessionId }));

    const msg = lastMessage(ws);
    expect(msg.type).toBe(S2C.SESSION_STATE);
    expect(msg.sessionId).toBe(second.sessionId);
    expect((ws as unknown as HotdogServerSocket).activeSessionId).toBe(second.sessionId);
  });

  it("does nothing for SWITCH_SESSION to a non-existent session", async () => {
    const ws = await connectWithSession();
    const countBefore = ws.messages.length;

    await wsServer.onMessage(ws, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: "non-existent" }));

    expect(ws.messages.length).toBe(countBefore);
  });

  it("attaches to most recent session when multiple exist", async () => {
    const ws1 = await connectWithSession();
    const firstSessionId = (ws1 as unknown as HotdogServerSocket).activeSessionId!;

    // Create a second session and make it strictly more recent than the
    // first (most-recent selection is by lastActivityAt).
    const second = await wsServer.sessionRegistry.create({});
    wsServer.sessionRegistry._test_metadata.get(second.sessionId)!.lastActivityAt =
      wsServer.sessionRegistry._test_metadata.get(firstSessionId)!.lastActivityAt + 1000;
    expect(wsServer.sessionRegistry.list()).toHaveLength(2);
    wsServer.onClose(ws1);

    const ws2 = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws2);

    // Should attach to the second (most recent) session, not the first.
    const attached = await waitForMessage(ws2, S2C.SESSION_CREATED);
    expect(attached.sessionId).toBe(second.sessionId);
    expect((ws2 as unknown as HotdogServerSocket).activeSessionId).toBe(second.sessionId);
  });

  it("createAndAttachSession reports buildAgent errors", async () => {
    const failingBuildAgent = async () => {
      throw new Error("Build agent failed");
    };
    wsServer = createWsServer(createWsMockCore(), { buildAgent: failingBuildAgent });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    const err = await waitForMessage(ws, S2C.ERROR);
    expect(err.message).toContain("Build agent failed");
  });
});

// ── Cold log operations ─────────────────────────────────────────────────────

describe("createWsServer - cold log operations", () => {
  let wsServer: ReturnType<typeof createWsServer>;
  let ws: MockWs;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
    try { rmSync(join(SESSIONS_DIR, `${FIXTURE_LOG_ID}.jsonl`), { force: true }); } catch {}
  });

  it("responds to LIST_LOGS with cold (non-live) session logs only", async () => {
    writeFixtureLog(FIXTURE_LOG_ID);
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
    ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    const liveSessionId = (await waitForMessage(ws, S2C.SESSION_CREATED)).sessionId;

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LIST_LOGS }));
    const listed = await waitForMessage(ws, S2C.LOGS_LISTED);
    const logIds = listed.logs.map((l: { id: string }) => l.id);
    expect(logIds).toContain(FIXTURE_LOG_ID);
    // The live session must not appear in the cold log listing.
    expect(logIds).not.toContain(liveSessionId);
  });

  it("responds to VIEW_LOG with the log entries", async () => {
    writeFixtureLog(FIXTURE_LOG_ID);
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.VIEW_LOG, logId: FIXTURE_LOG_ID }));
    const viewed = await waitForMessage(ws, S2C.LOG_VIEWED);
    expect(viewed.logId).toBe(FIXTURE_LOG_ID);
    expect(viewed.entries.map((e: { content: string }) => e.content)).toEqual(["loaded input", "loaded reply"]);
  });

  it("VIEW_LOG with missing logId is ignored", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.VIEW_LOG }));
    await new Promise((r) => setTimeout(r, 10));
    expect(ws.messages.length).toBe(0);
  });

  it("responds to DELETE_LOG for an existing log", async () => {
    writeFixtureLog(FIXTURE_LOG_ID);
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.DELETE_LOG, logId: FIXTURE_LOG_ID }));
    const deleted = await waitForMessage(ws, S2C.LOG_DELETED);
    expect(deleted.logId).toBe(FIXTURE_LOG_ID);
    expect(existsSync(join(SESSIONS_DIR, `${FIXTURE_LOG_ID}.jsonl`))).toBe(false);
  });

  it("responds to DELETE_LOG with an error for a missing log", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.DELETE_LOG, logId: "non-existent-log" }));
    const err = await waitForMessage(ws, S2C.ERROR);
    expect(err.message).toContain("not found");
  });

  it("responds to LOAD_LOG by creating a session and replaying the log", async () => {
    writeFixtureLog(FIXTURE_LOG_ID);
    // The loaded history is replayed into the new session's log, so the agent
    // needs a real MessageLog and a working addMessage to replay from.
    const log = new MessageLog();
    wsServer = createWsServer(createWsMockCore(), {
      buildAgent: async () =>
        makeWsMockAgent({
          getMessages: () => log.getAll(),
          addMessage: (msg: any) => { log.push(msg as any); },
        }),
    });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LOAD_LOG, logId: FIXTURE_LOG_ID }));
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(typeof created.sessionId).toBe("string");

    // The loaded history is replayed as user/assistant messages.
    const userMsg = await waitForMessage(ws, S2C.USER_MESSAGE);
    expect(userMsg.content).toBe("loaded input");
    const assistantMsg = await waitForMessage(ws, S2C.ASSISTANT_MESSAGE);
    expect(assistantMsg.content).toBe("loaded reply");
    // And it landed in the session's context, not just on the wire.
    expect(log.length).toBe(2);
  });

  it("responds to LOAD_LOG with an error for a missing log", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LOAD_LOG, logId: "non-existent-log" }));
    const err = await waitForMessage(ws, S2C.ERROR);
    expect(err.message).toContain("No entries found");
  });
});

// ── Auth ────────────────────────────────────────────────────────────────────

describe("createWsServer - auth", () => {
  let wsServer: ReturnType<typeof createWsServer>;

  function authCore() {
    return {
      validateToken: (token: string) => token === "valid-token",
    } as never;
  }

  afterEach(() => {
    wsServer?.stopCleanupLoop();
  });

  it("attaches a session when the upgrade URL carries a valid token", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws?token=valid-token", headers: { host: "localhost" } }, ws);
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(typeof created.sessionId).toBe("string");
  });

  it("sends authRequired when auth is configured but no token is provided", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    expect(lastMessage(ws).type).toBe(S2C.AUTH_REQUIRED);
  });

  it("sends authError and closes the connection on an invalid upgrade token", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws?token=invalid-token", headers: { host: "localhost" } }, ws);

    expect(lastMessage(ws).type).toBe(S2C.AUTH_ERROR);
    expect((ws.close as Mock<() => void>).mock.calls.length).toBeGreaterThan(0);
  });

  it("authenticates via protocol AUTH and opens a session", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH, token: "valid-token" }));

    // waitForMessage rejects on timeout, so both awaits are the assertion:
    // the AUTH reply arrives and a session gets opened.
    await waitForMessage(ws, "authOk");
    await waitForMessage(ws, S2C.SESSION_CREATED);
  });

  it("rejects protocol AUTH with an invalid token", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH, token: "invalid-token" }));
    const err = await waitForMessage(ws, S2C.AUTH_ERROR);
    expect(err.message).toBe("Invalid token");
  });

  it("ignores AUTH when no auth middleware is configured", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs();
    wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH, token: "any-token" }));
    await new Promise((r) => setTimeout(r, 10));
    expect(ws.messages.length).toBe(0);
  });

  it("gates non-AUTH messages until a token is validated", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    // Non-AUTH message before auth must be gated, not routed.
    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LIST_SESSIONS }));
    await new Promise((r) => setTimeout(r, 10));

    const types = messageTypes(ws);
    expect(types).toContain(S2C.AUTH_ERROR);
    expect(types).not.toContain(S2C.SESSIONS);
    expect(types).not.toContain(S2C.SESSION_CREATED);
  });

  it("allows messages after successful protocol AUTH", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH, token: "valid-token" }));
    await waitForMessage(ws, "authOk");

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LIST_SESSIONS }));
    await waitForMessage(ws, S2C.SESSIONS);
  });

  it("keeps gating non-AUTH messages after a failed protocol AUTH", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH, token: "bad-token" }));
    await waitForMessage(ws, S2C.AUTH_ERROR);

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.CREATE_SESSION }));
    await new Promise((r) => setTimeout(r, 10));

    const types = messageTypes(ws);
    // authError from the failed AUTH, then authError from the gate.
    expect(types.filter((t) => t === S2C.AUTH_ERROR).length).toBeGreaterThanOrEqual(2);
    expect(types).not.toContain(S2C.SESSION_CREATED);
  });

  it("excludes unauthenticated sockets from broadcasts until AUTH succeeds", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    // ws1 authenticates at upgrade; ws2 stays unauthenticated (AUTH_REQUIRED).
    const ws1 = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws?token=valid-token", headers: { host: "localhost" } }, ws1);
    await waitForMessage(ws1, S2C.SESSION_CREATED); // upgrade attach (direct send, index 0)

    const ws2 = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws2);
    expect(lastMessage(ws2).type).toBe(S2C.AUTH_REQUIRED);

    // ws1's CREATE_SESSION fans out to registered sockets via broadcast.
    // ws1 receives direct send (index 1) + its own broadcast copy (index 2);
    // waiting for the copy at index 2 proves the broadcast was dispatched.
    wsServer.onMessage(ws1, JSON.stringify({ type: C2S.CREATE_SESSION }));
    await waitForMessage(ws1, S2C.SESSION_CREATED, { after: 2 });
    // The broadcast must NOT have reached the unauthenticated ws2.
    expect(messageTypes(ws2)).toEqual([S2C.AUTH_REQUIRED]);

    // After protocol AUTH, ws2 joins the broadcast group.
    wsServer.onMessage(ws2, JSON.stringify({ type: C2S.AUTH, token: "valid-token" }));
    await waitForMessage(ws2, "authOk");
    // AUTH success attaches ws2 to the most recent session (direct send).
    await waitForMessage(ws2, S2C.SESSION_CREATED);
    const afterIdx = ws2.messages.length;

    // A broadcast from another client must now reach ws2.
    wsServer.onMessage(ws1, JSON.stringify({ type: C2S.CREATE_SESSION }));
    await waitForMessage(ws2, S2C.SESSION_CREATED, { after: afterIdx });
  });
});

// ── replaySessionHistory Tests ───────────────────────────────────────────────

describe("replaySessionHistory", () => {
  /** Create a server core whose agent has a custom message log. */
  function createReplayServer(mockAgent: AgentLike) {
    const core = {
      hooks: { notifyHooks: () => {}, notifyHooksAsync: async () => {} },
      config: {},
      resolved: {
        baseUrl: "http://localhost:8000",
        apiKey: "test-key",
        model: "test-model",
        stream: true,
        chatTimeout: 30,
        maxRetries: 3,
        maxIterations: 100,
        hideTools: false,
        hideThinking: true,
        showTokenUse: true,
        profileName: "default",
        modelRegistry: {},
      },
      toolRegistry: { getAll: () => [], get: () => null, register: () => {} },
      extensions: { cleanup: async () => {} },
      createLlmClient: (overrides?: Record<string, unknown>) =>
        new LlmClient({ baseUrl: "http://localhost:8000", apiKey: "test-key", stream: true,
          chatTimeoutSecs: 30, maxRetries: 3, ...overrides }),
    } as any;

    const wsServer = createWsServer(core, { buildAgent: async () => mockAgent });
    const ws = createWsMockWs();
    return { wsServer, ws };
  }

  function agentWithLog(log: any[]): AgentLike {
    return makeWsMockAgent({ getMessages: () => log });
  }

  /** Switch the mock socket to the freshly created session, triggering replay. */
  async function switchToCreatedSession(wsServer: ReturnType<typeof createWsServer>, ws: MockWs) {
    const result = await wsServer.sessionRegistry.create({});
    (ws as unknown as HotdogServerSocket).activeSessionId = result.sessionId;
    await wsServer.onMessage(ws, JSON.stringify({
      type: C2S.SWITCH_SESSION,
      sessionId: result.sessionId,
    }));
    return result;
  }

  it("replays user messages", async () => {
    const mockAgent = agentWithLog([
      { role: "user", content: "Hello", getTextContent: () => "Hello" },
    ]);
    const { wsServer, ws } = createReplayServer(mockAgent);

    await switchToCreatedSession(wsServer, ws);

    const msgs = ws.messages.map((m) => JSON.parse(m));
    const userMsg = msgs.find((m: any) => m.type === S2C.USER_MESSAGE);
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe("Hello");
  });

  it("replays assistant messages with reasoning", async () => {
    const mockAgent = agentWithLog([
      {
        role: "assistant",
        content: "Here's my answer",
        reasoningContent: "Let me think...",
        getTextContent: () => "Here's my answer",
      },
    ]);
    const { wsServer, ws } = createReplayServer(mockAgent);

    await switchToCreatedSession(wsServer, ws);

    const msgs = ws.messages.map((m) => JSON.parse(m));
    const thinkingMsg = msgs.find((m: any) => m.type === S2C.THINKING);
    const assistantMsg = msgs.find((m: any) => m.type === S2C.ASSISTANT_MESSAGE);

    expect(thinkingMsg).toBeDefined();
    expect(thinkingMsg.content).toBe("Let me think...");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe("Here's my answer");
  });

  it("replays tool calls and results", async () => {
    const mockAgent = agentWithLog([
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "call_123", function: { name: "read_file", arguments: '{"path":"test.txt"}' } },
        ],
        getTextContent: () => "",
      },
      {
        role: "tool",
        content: "File content here",
        toolCallId: "call_123",
      },
    ]);
    const { wsServer, ws } = createReplayServer(mockAgent);

    await switchToCreatedSession(wsServer, ws);

    const msgs = ws.messages.map((m) => JSON.parse(m));
    const toolCallMsg = msgs.find((m: any) => m.type === S2C.TOOL_CALL);
    const toolResultMsg = msgs.find((m: any) => m.type === S2C.TOOL_RESULT);

    expect(toolCallMsg).toBeDefined();
    expect(toolCallMsg.name).toBe("read_file");
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.output).toBe("File content here");
  });

  it("replays messages without getTextContent via the content field", async () => {
    const mockAgent = agentWithLog([
      { role: "user", content: "Hello" }, // No getTextContent
    ]);
    const { wsServer, ws } = createReplayServer(mockAgent);

    await switchToCreatedSession(wsServer, ws);

    const msgs = ws.messages.map((m) => JSON.parse(m));
    const userMsg = msgs.find((m: any) => m.type === S2C.USER_MESSAGE);
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe("Hello");
  });
});

// ── Question tool integration ───────────────────────────────────────────────

describe("question tool integration (bridge)", () => {
  let core: any;
  let wsServer: ReturnType<typeof createWsServer>;
  let ws: MockWs;
  let sessionId: string;

  beforeEach(async () => {
    core = createWsMockCore();
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      questionStrategy: "wait",
      questionTimeoutSecs: 300,
    });

    ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await waitForMessage(ws, S2C.SESSION_CREATED);
    sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;
  });

  afterEach(() => {
    wsServer.stopCleanupLoop();
  });

  /**
   * Simulate the tool executor firing AGENT_TOOL_CONTEXT for a question
   * tool call and return the collectAnswers() promise it starts.
   */
  function startQuestion(): Promise<Record<string, unknown>> {
    const handlers = core._registeredHooks["agent:toolContext"];
    expect(handlers).toHaveLength(1);
    const store: Record<string, unknown> = {};
    const toolCtx = {
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => {
        store[k] = v;
      },
    };
    const agent = wsServer.sessionRegistry.get(sessionId)!.agent;
    handlers[0]!({ toolCtx, toolName: "question", agent });
    const input = store["input"] as {
      collectAnswers: (qs: Array<Record<string, unknown>>) => Promise<Record<string, unknown>>;
      isInteractive: () => boolean;
    };
    expect(input).toBeDefined();
    expect(input.isInteractive()).toBe(true);
    return input.collectAnswers([{ key: "q1", prompt: "What?" }]);
  }

  it("does not set input for non-question tools", () => {
    const handlers = core._registeredHooks["agent:toolContext"];
    const store: Record<string, unknown> = {};
    const toolCtx = {
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => {
        store[k] = v;
      },
    };
    handlers[0]!({ toolCtx, toolName: "bash", agent: { sessionId: "s1" } });
    expect(store["input"]).toBeUndefined();
  });

  it("resolves a pending question via questionAnswer and broadcasts questionAnswered", async () => {
    const p = startQuestion();

    await wsServer.onMessage(
      ws,
      JSON.stringify({
        type: C2S.QUESTION_ANSWER,
        sessionId,
        answers: { q1: "Ada" },
      }),
    );

    await expect(p).resolves.toEqual({ q1: "Ada" });

    const msgs = ws.messages.map((m) => JSON.parse(m));
    expect(
      msgs.some(
        (m) =>
          m.type === "questionAnswered" &&
          m.sessionId === sessionId &&
          m.answers.q1 === "Ada",
      ),
    ).toBe(true);
  });

  it("ignores malformed answers (non-object) and keeps the question pending", async () => {
    const p = startQuestion();

    for (const bad of [[1, 2], "text", null]) {
      await wsServer.onMessage(
        ws,
        JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId, answers: bad }),
      );
    }
    // Still pending: only a real object may resolve it.
    await wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId, answers: { q1: "Ada" } }),
    );
    await expect(p).resolves.toEqual({ q1: "Ada" });
  });

  it("answers a question twice; the second answer errors", async () => {
    const p = startQuestion();
    await wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId, answers: { q1: "a" } }),
    );
    await expect(p).resolves.toEqual({ q1: "a" });

    await wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId, answers: { q1: "b" } }),
    );
    const msg = lastMessage(ws);
    expect(msg.type).toBe(S2C.ERROR);
  });

  it("interrupt (cancel) resolves the pending question with defaults", async () => {
    const p = startQuestion();

    await wsServer.onMessage(ws, JSON.stringify({ type: C2S.CANCEL, sessionId }));

    await expect(p).resolves.toEqual({ q1: "" });
  });

  it("deleting the session cancels its pending question", async () => {
    const p = startQuestion();

    await wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.DELETE_SESSION, sessionId }),
    );

    await expect(p).resolves.toEqual({ q1: "" });
  });

  it("per-session strategy: default resolves with defaults after timeout", async () => {
    // Override the session's policy BEFORE the question starts (policy is
    // read at collect time).
    const meta = wsServer.sessionRegistry._test_metadata.get(sessionId)!;
    meta.questionStrategy = "default";
    meta.questionTimeoutSecs = 0.05;

    const p = startQuestion();
    await expect(p).resolves.toEqual({ q1: "" });
  });

  it("per-session strategy: cancel interrupts the session after timeout", async () => {
    const meta = wsServer.sessionRegistry._test_metadata.get(sessionId)!;
    meta.questionStrategy = "cancel";
    meta.questionTimeoutSecs = 0.05;

    const p = startQuestion();
    await expect(p).resolves.toEqual({ q1: "" });
    // The session manager's interrupt was called; no crash, session intact.
    expect(wsServer.sessionRegistry.get(sessionId)).not.toBeNull();
  });
});
