// Tests for WebSocket server — SessionRegistry, message routing, auth gate,
// cold log operations, history replay, and question tool integration.
// (Merged from websocket-server.test.ts + websocket-server-extended.test.ts.)

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, mock, Mock } from "bun:test";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { createWsServer } from "@extensions/websocket/server.ts";
import { dismissResumedQuestions, seedResumedQuestions } from "@extensions/websocket/resume.ts";
import type { HotdogServerSocket } from "@extensions/websocket/socket.ts";
import { syncSessionFromLog, indexSessionProfile, getSessionRow } from "@core/session/session-index.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { LlmError } from "@core/error.ts";
import { MessageLog } from "@core/context/message-log.ts";
import type { AgentLike } from "@core/session/index.ts";
import { TASK_STATUS } from "@core/session/task-types.ts";
import { createWsMockCore, createWsMockAgentFactory, createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";
import { createFixture, simpleTool } from "../helpers.ts";
import { Message } from "@core/context/message.ts";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { create as createSessionLogExt } from "@extensions/session-log/index.ts";
import os from "node:os";
import { join } from "node:path";
import { createRoleMappingRegistry } from "@core/extensions/role-mapping.ts";
import { HOOKS } from "@core/hooks.ts";
import { createCompletionService } from "@core/completion.ts";
import { create } from "@extensions/websocket/index.ts";
import { systemFirstRoleMapping, developerRoleMapping } from "@extensions/role-mapping-default/index.ts";

const testRoleReg = createRoleMappingRegistry();
testRoleReg.register(systemFirstRoleMapping);
testRoleReg.register(developerRoleMapping);


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

/** Poll until the attach's cursor report (sessionState key=cursor) arrives. */
async function waitForCursor(ws: MockWs): Promise<void> {
  const start = Date.now();
  for (;;) {
    const found = ws.messages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && m.type === S2C.SESSION_STATE && m.key === "cursor");
    if (found) return;
    if (Date.now() - start > 2000) throw new Error("Timed out waiting for cursor report");
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Poll until a message matching the predicate arrives. */
async function waitForMessageOf(ws: MockWs, pred: (m: any) => boolean, opts: { timeoutMs?: number } = {}): Promise<any> {
  const { timeoutMs = 2000 } = opts;
  const start = Date.now();
  for (;;) {
    const found = ws.messages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && pred(m));
    if (found) return found;
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for matching message");
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

  it("gates session turns through the injected turnLanes coordinator", async () => {
    // Regression: the ws registry's SessionManager is built without
    // taskConfig, so turnLanes must be handed through explicitly -- without
    // it, two live webui sessions double up requests on one provider lane.
    const acquires: string[] = [];
    let releaseCalls = 0;
    let runStarted = false;
    let finishRun!: () => void;
    const agent = {
      sessionId: "lane-sess",
      model: "prov/m1",
      hooks: { runHookPipeline: async (_n: string, data: unknown) => data },
      run: () => {
        runStarted = true;
        return new Promise<void>((r) => {
          finishRun = r;
        });
      },
      resetCancel: () => {},
      cancel: () => {},
    };
    const reg = new SessionRegistry({
      buildAgent: async () => agent as unknown as AgentLike,
      turnLanes: {
        acquireTurn: async (model: string) => {
          acquires.push(model);
          return async () => {
            releaseCalls++;
          };
        },
      },
    });
    try {
      const { sessionId } = await reg.create();
      expect(sessionId).toBe("lane-sess");
      reg.getSessionManager().getBus(sessionId)!.enqueue("hello");

      const deadline = Date.now() + 2000;
      const settle = async (fn: () => boolean, what: string) => {
        while (!fn()) {
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
          await new Promise((r) => setTimeout(r, 5));
        }
      };
      await settle(() => acquires.length === 1 && runStarted, "lane acquire then gated run");
      expect(acquires).toEqual(["prov/m1"]);
      finishRun();
      await settle(() => releaseCalls === 1, "lane released when the turn settles");
    } finally {
      reg.stopCleanupLoop();
    }
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

  it("fires SESSION_END on the agent's hooks so extensions reclaim on delete", async () => {
    // The registry's SessionManager owns a private hook system (createHooks),
    // so deleteSession's own notice never reaches extensions. The registry
    // must re-fire the end on the agent's (shared) hooks -- that is where
    // the session-log reclaim and the tool-exec pool reaper are registered.
    const notified: Array<[string, unknown]> = [];
    const agentHooks = {
      notifyHooks: (name: string, data: unknown) => {
        notified.push([name, data]);
      },
      on: () => () => {},
    };
    const reg = new SessionRegistry({
      buildAgent: async (config: { sessionId?: string }) =>
        makeWsMockAgent({ sessionId: config.sessionId || "ws-end-1", hooks: agentHooks as never }),
    });
    try {
      const { sessionId } = await reg.create();
      expect(notified).toEqual([]);

      expect(reg.delete(sessionId)).toBe(true);
      expect(notified).toEqual([[HOOKS.SESSION_END, { sessionId }]]);
    } finally {
      reg.stopCleanupLoop();
    }
  });

  describe("switchProfile", () => {
    it("applies the full profile (model, whitelist, blacklist) and preserves context", async () => {
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
            body: "coder body",
            model: "prov/new-model",
            whitelistTools: ["alpha"],
            blacklistTools: [],
            manager: false,
          },
        },
      });
      const { sessionId } = await wsRegistry.create({});

      const result = await wsRegistry.switchProfile({ sessionId, profileName: "coder" });
      expect(result.success).toBe(true);

      expect(agent.profileName).toBe("coder");
      expect(agent.profileBody).toBe("coder body");
      expect(agent.model).toBe("prov/new-model");
      expect(wsRegistry.get(sessionId)!.metadata.model).toBe("prov/new-model");
      expect(wsRegistry.get(sessionId)!.metadata.profile).toBe("coder");
      expect(agent.contextLimit).toBe(64000);
      expect(agent.toolWhitelist).toEqual(["alpha"]);
      // Switching never clears the message log (applyProfile only rebuilds the
      // system prompt / tool defs; /clear stays the explicit wipe).
      expect(agent.context.log.getAll()).toHaveLength(1);
      // The whitelist restricts the tools advertised from the next turn on.
      const names = (await agent.getToolDefs()).map((d) => d.function.name);
      expect(names).toEqual(["alpha"]);
    });

    it("switches without confirmation even after user messages, and keeps the count", async () => {
      const { agent } = createFixture({});
      const wsRegistry = new SessionRegistry({
        buildAgent: async () => agent,
        profiles: { coder: { body: "", model: null, whitelistTools: null, blacklistTools: [], manager: false } },
      });
      const { sessionId } = await wsRegistry.create({});
      wsRegistry.incrementUserMessageCount(sessionId);

      const result = await wsRegistry.switchProfile({ sessionId, profileName: "coder" });
      expect(result.success).toBe(true);
      expect(agent.profileName).toBe("coder");
      // The switch is non-destructive, so the message count stays honest.
      expect(wsRegistry.get(sessionId)!.metadata.userMessageCount).toBe(1);
    });

    it("errors on unknown profiles and unknown sessions", async () => {
      const { sessionId } = await registry.create();
      const unknownProfile = await registry.switchProfile({ sessionId, profileName: "ghost" });
      expect(unknownProfile.error).toBe('Profile "ghost" not found');
      const unknownSession = await registry.switchProfile({ sessionId: "nope", profileName: "default" });
      expect(unknownSession.error).toBe("Session not found");
    });

    it("keeps an explicit title when switching profile", async () => {
      registry = new SessionRegistry({
        buildAgent: createWsMockAgentFactory(),
        profiles: {
          coder: { body: "", model: null, whitelistTools: null, blacklistTools: [], manager: false },
        },
      });
      const { sessionId } = await registry.create({});
      registry.rename(sessionId, "keep me");

      const result = await registry.switchProfile({ sessionId, profileName: "coder" });
      expect(result.success).toBe(true);

      const meta = registry.get(sessionId)!.metadata;
      expect(meta.profile).toBe("coder");
      expect(meta.title).toBe("keep me");
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

  it("rename sets the session title and leaves the profile untouched", async () => {
    const result = await registry.create({ profile: "old-name" });
    expect(registry.rename(result.sessionId, "new-name")).toBe(true);
    const meta = registry.get(result.sessionId)!.metadata;
    expect(meta.title).toBe("new-name");
    expect(meta.profile).toBe("old-name");
  });

  it("returns false when renaming non-existent session", () => {
    expect(registry.rename("non-existent", "new-profile")).toBe(false);
  });

  it("new sessions have no title and list() exposes it", async () => {
    const { sessionId } = await registry.create({ profile: "coder" });
    expect(registry.get(sessionId)!.metadata.title).toBeNull();
    expect(registry.list()[0]!.title).toBeNull();
    expect(registry.list()[0]!.profile).toBe("coder");

    registry.rename(sessionId, "my session");
    const listed = registry.list()[0]!;
    expect(listed.title).toBe("my session");
    expect(listed.profile).toBe("coder");
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

  describe("fork", () => {
    it("registers UI metadata for the fork and lists both sessions", async () => {
      const { sessionId } = await registry.create({ profile: "coder" });

      const { sessionId: forkId } = await registry.fork(sessionId, { turnsBack: 0 });

      expect(forkId).not.toBe(sessionId);
      const forked = registry.get(forkId)!;
      expect(forked).toBeDefined();
      expect(forked.metadata.profile).toBe("coder");
      expect(forked.metadata.title).toBeNull();
      expect(forked.metadata.connectedClients).toBe(0);
      expect(registry.list()).toHaveLength(2);
      // Source survives.
      expect(registry.get(sessionId)).toBeDefined();
    });

    it("rejects an unknown source session", async () => {
      await expect(registry.fork("nope", { turnsBack: 0 })).rejects.toThrow(
        "Cannot fork unknown session",
      );
    });

    it("rejects while the source session is running", async () => {
      const { sessionId } = await registry.create();
      registry.getSessionManager().getBus(sessionId)!.isRunning = true;
      await expect(registry.fork(sessionId, { turnsBack: 1 })).rejects.toThrow(
        "while the session is running",
      );
    });
  });

  it("keeps the last 3 idle sessions hot past the timeout, colds the rest", async () => {
    // Five sessions, all stale (100 min old) and client-free: the three most
    // recently active stay hot; the two oldest go cold (deleted in-memory,
    // logs untouched).
    const created: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await registry.create();
      registry._test_metadata.get(r.sessionId)!.lastActivityAt =
        Date.now() - (100 + i) * 60 * 1000; // i=0 is the most recent
      created.push(r.sessionId);
    }
    registry._test_cleanupIdleSessions();

    expect(registry.get(created[0]!)).not.toBeNull();
    expect(registry.get(created[1]!)).not.toBeNull();
    expect(registry.get(created[2]!)).not.toBeNull();
    expect(registry.get(created[3]!)).toBeNull();
    expect(registry.get(created[4]!)).toBeNull();
  });

  it("keeps a lone stale session hot (the grace covers <= 3 idle sessions)", async () => {
    const result = await registry.create();
    const meta = registry._test_metadata.get(result.sessionId);
    if (meta) meta.lastActivityAt = Date.now() - 100 * 60 * 1000; // 100 minutes ago
    registry._test_cleanupIdleSessions();

    expect(registry.get(result.sessionId)).not.toBeNull();
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

  it("handles SEND with steering by passing the steering flag to the session", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    const enqueued: Array<{ sid: string; content: string; opts?: { steering?: boolean } }> = [];
    const sessionManager = wsServer.sessionRegistry.getSessionManager();
    const originalEnqueue = sessionManager.enqueue;
    sessionManager.enqueue = (sid: string, content: string, opts?: { steering?: boolean }) => {
      enqueued.push({ sid, content, opts });
    };

    try {
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.SEND, sessionId, content: "Steer!", steering: true }));
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.SEND, sessionId, content: "Normal" }));
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.SEND, content: "Steer!", steering: true }));
      // Only fully-addressed messages are enqueued; steering is a flag on send.
      expect(enqueued).toEqual([
        { sid: sessionId, content: "Steer!", opts: { steering: true } },
        { sid: sessionId, content: "Normal", opts: undefined },
      ]);
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

  it("intercepts COMMAND /fork: announces sessionCreated and re-targets the socket", async () => {
    const ws = await connectWithSession();
    const sourceId = (ws as unknown as HotdogServerSocket).activeSessionId!;
    const sendCount = ws.messages.length;

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.COMMAND, sessionId: sourceId, command: "/fork 1 branch prompt" }),
    );

    const created = await waitForMessage(ws, S2C.SESSION_CREATED, { after: sendCount });
    expect(created.sessionId).not.toBe(sourceId);
    // The requesting socket now talks to the fork.
    expect((ws as unknown as HotdogServerSocket).activeSessionId).toBe(created.sessionId);
    expect((ws as unknown as HotdogServerSocket).activeChannel).toBeDefined();
    // The registry knows the fork (sidebar will list it).
    expect(wsServer.sessionRegistry.get(created.sessionId)).toBeDefined();
    // The fork's attach closes the client's cursor bookkeeping like every
    // other attach path: a cursor report for the fork (0 -- the replay came
    // from memory, so no log coordinate can be claimed).
    const cursor = await waitForMessageOf(
      ws,
      (m: any) =>
        m.type === S2C.SESSION_STATE &&
        m.key === "cursor" &&
        m.sessionId === created.sessionId,
    );
    expect(cursor.value).toBe(0);
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

  it("handles RENAME_SESSION message by setting the title", async () => {
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.RENAME_SESSION, sessionId, newName: "renamed" }));

    const meta = wsServer.sessionRegistry._test_metadata.get(sessionId!);
    expect(meta!.title).toBe("renamed");
    // The rename must not clobber the profile.
    expect(meta!.profile).toBe("default");
  });

  it("handles SWITCH_SESSION message and reports the title", async () => {
    const ws = await connectWithSession();

    const second = await wsServer.sessionRegistry.create({});
    wsServer.sessionRegistry.rename(second.sessionId, "second one");

    await wsServer.onMessage(ws, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: second.sessionId }));

    const all = ws.messages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter(Boolean) as any[];
    // The attach's state reports land for the new session; a session-scoped
    // task snapshot closes out the switch.
    const states = all.filter(
      (m) => m.type === S2C.SESSION_STATE && m.sessionId === second.sessionId,
    );
    expect(states.length).toBeGreaterThan(0);
    const snapshot = all[all.length - 1];
    expect(snapshot.type).toBe(S2C.TASK_LIST);
    expect(snapshot.tasks).toEqual([]);
    expect((ws as unknown as HotdogServerSocket).activeSessionId).toBe(second.sessionId);

    // The attach's sessionCreated carries the title (the old switch sent a
    // sessionState title key instead).
    const created = all.find(
      (m) => m.type === S2C.SESSION_CREATED && m.sessionId === second.sessionId,
    );
    expect(created).toBeDefined();
    expect(created.title).toBe("second one");
  });

  it("sends a null title in the SWITCH_SESSION attach when the session is untitled", async () => {
    const ws = await connectWithSession();

    const second = await wsServer.sessionRegistry.create({});

    await wsServer.onMessage(ws, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: second.sessionId }));

    const created = ws.messages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .find((m) => m && m.type === S2C.SESSION_CREATED && m.sessionId === second.sessionId);
    expect(created).toBeDefined();
    expect(created!.title).toBeNull();
  });

  it("answers SWITCH_SESSION to a non-existent session with an error", async () => {
    const ws = await connectWithSession();

    await wsServer.onMessage(ws, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: "non-existent" }));

    const err = await waitForMessage(ws, S2C.ERROR);
    expect(err.message).toBe("Session not found");
  });

  it("SWITCH_SESSION to the already-attached session re-attaches (log-view exit)", async () => {
    // The webui's "back to the live session" click sends switchSession with
    // the id the socket is already on: the server must answer with a full
    // re-attach burst (the client rebuilds its transcript from it), never
    // treat the same-id switch as a no-op.
    const ws = await connectWithSession();
    const sessionId = (ws as unknown as HotdogServerSocket).activeSessionId!;

    ws.messages.length = 0;
    await wsServer.onMessage(ws, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId }));

    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(created.sessionId).toBe(sessionId);
    // Full replay, not a delta: the client cleared its log-view transcript.
    expect(created.replayDelta).toBeUndefined();
    expect(messageTypes(ws)).not.toContain(S2C.ERROR);
    expect((ws as unknown as HotdogServerSocket).activeSessionId).toBe(sessionId);
  });

  it("attaches to most recent session when multiple exist", async () => {
    const ws1 = await connectWithSession();
    const firstSessionId = (ws1 as unknown as HotdogServerSocket).activeSessionId!;

    // Create a second session and make it strictly more recent than the
    // first (most-recent selection is by lastActivityAt).
    const second = await wsServer.sessionRegistry.create({});
    wsServer.sessionRegistry._test_metadata.get(second.sessionId)!.lastActivityAt =
      wsServer.sessionRegistry._test_metadata.get(firstSessionId)!.lastActivityAt + 1000;
    wsServer.sessionRegistry.rename(second.sessionId, "the second one");
    expect(wsServer.sessionRegistry.list()).toHaveLength(2);
    wsServer.onClose(ws1);

    const ws2 = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws2);

    // Should attach to the second (most recent) session, not the first.
    const attached = await waitForMessage(ws2, S2C.SESSION_CREATED);
    expect(attached.sessionId).toBe(second.sessionId);
    expect((ws2 as unknown as HotdogServerSocket).activeSessionId).toBe(second.sessionId);
    // The existing session's title survives a reconnect.
    expect(attached.title).toBe("the second one");
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

  it("responds to LOAD_LOG by resuming the log under its own session id", async () => {
    writeFixtureLog(FIXTURE_LOG_ID);
    // The loaded history is replayed into the resumed agent, so it needs a
    // real MessageLog and a working addMessage to replay from. The agent must
    // adopt the log's own id (identity-preserving resume).
    const log = new MessageLog();
    wsServer = createWsServer(createWsMockCore(), {
      buildAgent: async (cfg) =>
        makeWsMockAgent({
          sessionId: cfg.sessionId || "test",
          getMessages: () => log.getAll(),
          addMessage: (msg: any) => { log.push(msg as any); },
        }),
    });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LOAD_LOG, logId: FIXTURE_LOG_ID }));
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    // Identity preserved: the resumed session IS the log's id (no fork to a
    // new one), and it is live in the registry.
    expect(created.sessionId).toBe(FIXTURE_LOG_ID);
    expect(wsServer.sessionRegistry.get(FIXTURE_LOG_ID)).not.toBeNull();

    // The loaded history is replayed as user/assistant messages.
    const userMsg = await waitForMessage(ws, S2C.USER_MESSAGE);
    expect(userMsg.content).toBe("loaded input");
    const assistantMsg = await waitForMessage(ws, S2C.ASSISTANT_MESSAGE);
    expect(assistantMsg.content).toBe("loaded reply");
    // And it landed in the session's context, not just on the wire.
    expect(log.length).toBe(2);
  });

  it("responds to LOAD_LOG with a fallback error for a missing log", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LOAD_LOG, logId: "non-existent-log" }));
    const err = await waitForMessage(ws, S2C.ERROR);
    expect(err.message).toContain("no log found");
    // The socket is not stranded: the fallback attach opens a session.
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(typeof created.sessionId).toBe("string");
  });

  it("LOAD_LOG restores the profile from the index row into build config, metadata, and SESSION_CREATED", async () => {
    writeFixtureLog(FIXTURE_LOG_ID);
    await syncSessionFromLog(FIXTURE_LOG_ID);
    await indexSessionProfile(FIXTURE_LOG_ID, "coder");

    const log = new MessageLog();
    let builtProfileName: string | undefined;
    wsServer = createWsServer(createWsMockCore(), {
      profiles: {
        coder: { body: "coder body", model: null, whitelistTools: null, blacklistTools: [], manager: false },
      },
      buildAgent: async (cfg) => {
        builtProfileName = cfg.profileName;
        return makeWsMockAgent({
          sessionId: cfg.sessionId || "test",
          profileName: cfg.profileName,
          getMessages: () => log.getAll(),
          addMessage: (msg: any) => { log.push(msg as any); },
        });
      },
    });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LOAD_LOG, logId: FIXTURE_LOG_ID }));
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    // The row's profile must reach the agent build (registry.create takes
    // `profile`, NOT `profileName` -- the key that silently defaulted every
    // cold resume).
    expect(builtProfileName).toBe("coder");
    expect(created.profile).toBe("coder");
    expect(wsServer.sessionRegistry.get(created.sessionId)!.metadata.profile).toBe("coder");
  });

  it("LOAD_LOG overlays a log profile the index row has not mirrored", async () => {
    const logId = `${FIXTURE_LOG_ID}-overlay`;
    const lines = [
      JSON.stringify({ ts: "2024-01-01T00:00:00Z", session_id: logId, source: "session_start", content: "", profile: "coder" }),
      JSON.stringify({ ts: "2024-01-01T00:00:01Z", session_id: logId, source: "input", content: "hi" }),
    ];
    writeFileSync(join(SESSIONS_DIR, `${logId}.jsonl`), lines.join("\n") + "\n");
    // Row exists but carries no profile -- replay must supply it, including
    // the registry metadata (not just the agent).
    await syncSessionFromLog(logId);

    const log = new MessageLog();
    wsServer = createWsServer(createWsMockCore(), {
      profiles: {
        coder: { body: "coder body", model: null, whitelistTools: null, blacklistTools: [], manager: false },
      },
      buildAgent: async (cfg) => {
        const agent = makeWsMockAgent({
          sessionId: cfg.sessionId || "test",
          profileName: cfg.profileName,
          getMessages: () => log.getAll(),
          addMessage: (msg: any) => { log.push(msg as any); },
        });
        agent.applyProfile = (name: string) => { agent.profileName = name; };
        return agent;
      },
    });
    ws = createWsMockWs();

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LOAD_LOG, logId }));
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(created.profile).toBe("coder");
    expect(wsServer.sessionRegistry.get(created.sessionId)!.metadata.profile).toBe("coder");
    // The replayed user message is counted in the resumed metadata.
    expect(wsServer.sessionRegistry.get(created.sessionId)!.metadata.userMessageCount).toBe(1);
  });
});

// ── cold-log adoption + usage-record corruption (owner repro) ───────────────
//
// Restart -> adopt a usage-bearing log -> browse old logs -> switch back to
// the live session: usage bubbles must come back one per call, in log order,
// stamped with the session's own id -- and the log file itself must not have
// grown a single usage row from the adoption replay (re-emit through
// OUTPUT_EVENT must be suppressed while restoring, like CONTEXT_MESSAGE).

/** Build a ws server whose mock agents carry the real agent's restore
 *  surface (isRestoring -> SESSION_RESTORE_ACTIVE, emitOutput ->
 *  OUTPUT_EVENT) wired into a real session-log extension. */
async function usageReproServer() {
  const core = createWsMockCore();
  const ext = (await createSessionLogExt(core as never)) as unknown as {
    hooks: Record<string, (p: unknown) => Promise<void>>;
  };
  const writes: Promise<unknown>[] = [];
  const server = createWsServer(core, {
    buildAgent: async (cfg: { sessionId?: string }) => {
      const log = new MessageLog();
      const agent: any = makeWsMockAgent({
        sessionId: cfg.sessionId || "test",
        getMessages: () => log.getAll(),
        addMessage: (msg: any) => { log.push(msg as any); },
      });
      const notify = (name: string, payload: unknown) => {
        const h = ext.hooks[name];
        if (h) writes.push(Promise.resolve(h(payload)));
      };
      agent.hooks = { notifyHooks: async (name: string, payload: unknown) => notify(name, payload) };
      agent.emitOutput = (type: string, data: Record<string, unknown>) =>
        notify(HOOKS.OUTPUT_EVENT, { type, data, agent });
      // Mirrors the real agent's setter: restoring flips the suppression flag.
      let restoring = false;
      Object.defineProperty(agent, "isRestoring", {
        configurable: true,
        get: () => restoring,
        set: (v: boolean) => {
          restoring = v;
          notify(HOOKS.SESSION_RESTORE_ACTIVE, { agent, isRestoring: v });
        },
      });
      return agent;
    },
  });
  return {
    server,
    /** Await every extension write dispatched so far (and any chained). */
    settle: async () => {
      while (writes.length) await Promise.all(writes.splice(0));
    },
  };
}

/** Poll until the attach burst past `after` closes with a cursor report. */
async function waitForCursorAfter(ws: MockWs, after: number): Promise<void> {
  const start = Date.now();
  for (;;) {
    const found = ws.messages.slice(after)
      .some((m) => { try { const p = JSON.parse(m); return p.type === S2C.SESSION_STATE && p.key === "cursor"; } catch { return false; } });
    if (found) return;
    if (Date.now() - start > 2000) throw new Error("Timed out waiting for cursor report");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("usage records survive restart-resume + log detour + switch back", () => {
  const LOG_A = "usage-repro-a";
  const LOG_B = "usage-repro-b";
  let usageServer: ReturnType<typeof createWsServer> | null = null;
  let usageWs: MockWs;

  afterEach(() => {
    usageServer?.stopCleanupLoop();
    for (const id of [LOG_A, LOG_B]) {
      try { rmSync(join(SESSIONS_DIR, `${id}.jsonl`), { force: true }); } catch {}
    }
  });

  /** input, llm, usage(121), input, llm, usage(343) -- totals distinct. */
  function writeUsageLog(logId: string) {
    const line = (over: Record<string, unknown>) =>
      JSON.stringify({ ts: "2024-01-01T00:00:00Z", session_id: logId, source: "input", content: "", ...over });
    const usage = (n: number) => line({
      source: "token_usage",
      sessionPromptTokens: n - 10, sessionCompletionTokens: 10, sessionTotalTokens: n,
      promptTokens: n - 10, completionTokens: 10, totalTokens: n, cachedTokens: 0, contextWindow: 200000,
    });
    writeFileSync(join(SESSIONS_DIR, `${logId}.jsonl`), [
      line({ source: "input", content: "one" }),
      line({ source: "llm", content: "first" }),
      usage(121),
      line({ source: "input", content: "two" }),
      line({ source: "llm", content: "second" }),
      usage(343),
    ].join("\n") + "\n");
  }

  function usageRows(logId: string): number[] {
    return readFileSync(join(SESSIONS_DIR, `${logId}.jsonl`), "utf8")
      .split("\n").filter(Boolean).map((l) => JSON.parse(l))
      .filter((e) => e.source === "token_usage").map((e) => e.totalTokens);
  }

  it("adoption replays usage without re-appending it; switch-back is one bubble per call, in order, stamped with the log id", async () => {
    writeUsageLog(LOG_A);
    writeUsageLog(LOG_B);
    const { server, settle } = await usageReproServer();
    usageServer = server;
    usageWs = createWsMockWs();

    // Server restart: the log is resumed under its own id (same adoption
    // flow the reconnect auto-resume takes).
    server.onMessage(usageWs, JSON.stringify({ type: C2S.LOAD_LOG, logId: LOG_A }));
    const created = await waitForMessage(usageWs, S2C.SESSION_CREATED);
    expect(created.sessionId).toBe(LOG_A);
    await waitForCursor(usageWs);
    await settle();

    // The replay wrote NOTHING back: the log still carries exactly its two
    // original usage rows, in log order.
    expect(usageRows(LOG_A)).toEqual([121, 343]);

    // Old-log detour: viewing must be read-only on both files.
    const bytesA = readFileSync(join(SESSIONS_DIR, `${LOG_A}.jsonl`), "utf8");
    const bytesB = readFileSync(join(SESSIONS_DIR, `${LOG_B}.jsonl`), "utf8");
    server.onMessage(usageWs, JSON.stringify({ type: C2S.VIEW_LOG, logId: LOG_B }));
    await waitForMessage(usageWs, S2C.LOG_VIEWED);
    await settle();
    expect(readFileSync(join(SESSIONS_DIR, `${LOG_A}.jsonl`), "utf8")).toBe(bytesA);
    expect(readFileSync(join(SESSIONS_DIR, `${LOG_B}.jsonl`), "utf8")).toBe(bytesB);

    // Back to the live session: full replay, one TOKEN_USAGE per original
    // call, interleaved at log position, stamped with the session's own id.
    const n = usageWs.messages.length;
    server.onMessage(usageWs, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId: LOG_A }));
    await waitForCursorAfter(usageWs, n);
    const burst = usageWs.messages.slice(n).map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter(Boolean) as Array<Record<string, unknown>>;
    const conversation = burst
      .filter((m) => m.type === S2C.USER_MESSAGE || m.type === S2C.ASSISTANT_MESSAGE || m.type === S2C.TOKEN_USAGE)
      .map((m) => (m.type === S2C.TOKEN_USAGE ? `usage:${m.totalTokens}` : m.type));
    expect(conversation).toEqual([
      S2C.USER_MESSAGE,
      S2C.ASSISTANT_MESSAGE,
      "usage:121",
      S2C.USER_MESSAGE,
      S2C.ASSISTANT_MESSAGE,
      "usage:343",
    ]);
    const usageMsgs = burst.filter((m) => m.type === S2C.TOKEN_USAGE);
    expect(usageMsgs.every((m) => m.sessionId === LOG_A)).toBe(true);
  });

  it("viewing session A never writes to B and never re-keys B's index row", async () => {
    writeUsageLog(LOG_A);
    writeUsageLog(LOG_B);
    const { server, settle } = await usageReproServer();
    usageServer = server;
    usageWs = createWsMockWs();

    // B is indexed from its own log: its ctx mirror is 343/200000.
    await syncSessionFromLog(LOG_B);
    expect(getSessionRow(LOG_B)?.ctx_used).toBe(343);
    expect(getSessionRow(LOG_B)?.ctx_total).toBe(200000);

    // Live on A (adopted).
    server.onMessage(usageWs, JSON.stringify({ type: C2S.LOAD_LOG, logId: LOG_A }));
    await waitForMessage(usageWs, S2C.SESSION_CREATED);
    await waitForCursor(usageWs);
    await settle();

    // Browse A's own log through the cold viewer (activeLogId == live id).
    const bytesA = readFileSync(join(SESSIONS_DIR, `${LOG_A}.jsonl`), "utf8");
    const bytesB = readFileSync(join(SESSIONS_DIR, `${LOG_B}.jsonl`), "utf8");
    server.onMessage(usageWs, JSON.stringify({ type: C2S.VIEW_LOG, logId: LOG_A }));
    await waitForMessage(usageWs, S2C.LOG_VIEWED);
    await settle();

    // Zero writes anywhere, and B's mirrored ctx columns untouched.
    expect(readFileSync(join(SESSIONS_DIR, `${LOG_A}.jsonl`), "utf8")).toBe(bytesA);
    expect(readFileSync(join(SESSIONS_DIR, `${LOG_B}.jsonl`), "utf8")).toBe(bytesB);
    expect(getSessionRow(LOG_B)?.ctx_used).toBe(343);
    expect(getSessionRow(LOG_B)?.ctx_total).toBe(200000);
  });
});

// ── SIGTERM commit-point drain ───────────────────────────────────────────────

describe("drainSessions", () => {
  it("waits out the window, then interrupts turns that never settle", async () => {
    const registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    try {
      const { sessionId } = await registry.create();
      const manager = registry.getSessionManager();
      const bus = manager.getBus(sessionId)!;
      bus.isRunning = true; // a turn stuck mid-generation
      let cancelled = 0;
      const agent = manager.getAgentBySessionId(sessionId)!;
      // The unwind: interrupt() reaches agent.cancel(), which ends the turn.
      agent.cancel = () => {
        cancelled++;
        bus.isRunning = false;
      };

      const start = Date.now();
      await registry.drainSessions(120);

      expect(cancelled).toBe(1);
      expect(bus.isRunning).toBe(false);
      expect(Date.now() - start).toBeGreaterThanOrEqual(100); // waited the window
    } finally {
      registry.stopCleanupLoop();
    }
  });

  it("returns immediately when no session is running", async () => {
    const registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    try {
      const { sessionId } = await registry.create();
      const start = Date.now();
      await registry.drainSessions(500);
      expect(Date.now() - start).toBeLessThan(300);
      expect(registry.getSessionManager().isSessionRunning(sessionId)).toBe(false);
    } finally {
      registry.stopCleanupLoop();
    }
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
    await waitForMessage(ws, S2C.AUTH_OK);
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
    await waitForMessage(ws, S2C.AUTH_OK);

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
    await waitForMessage(ws2, S2C.AUTH_OK);
    // AUTH success attaches ws2 to the most recent session (direct send).
    await waitForMessage(ws2, S2C.SESSION_CREATED);
    const afterIdx = ws2.messages.length;

    // A broadcast from another client must now reach ws2.
    wsServer.onMessage(ws1, JSON.stringify({ type: C2S.CREATE_SESSION }));
    await waitForMessage(ws2, S2C.SESSION_CREATED, { after: afterIdx });
  });

  it("reaps pre-auth sockets that never authenticate", () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    const registry = wsServer.sessionRegistry;
    expect(registry._test_pendingAuth.size).toBe(1);

    const closeMock = ws.close as unknown as Mock<(code?: number, reason?: string) => void>;

    // Not yet expired: the sweep leaves it alone.
    registry._test_cleanupIdleSessions();
    expect(closeMock.mock.calls.length).toBe(0);
    expect(registry._test_pendingAuth.size).toBe(1);

    // Expired: closed with a policy code and dropped from the map.
    registry._test_pendingAuth.set(ws, Date.now() - 60_000);
    registry._test_cleanupIdleSessions();
    expect(closeMock.mock.calls[0]?.[0]).toBe(4001);
    expect(registry._test_pendingAuth.size).toBe(0);
  });

  it("does not reap a socket once it authenticates", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH, token: "valid-token" }));
    await waitForMessage(ws, S2C.AUTH_OK);

    const registry = wsServer.sessionRegistry;
    // The AUTH success path drops the stamp itself; no sweep needed.
    expect(registry._test_pendingAuth.size).toBe(0);
    // Even with a stale stamp an authenticated socket just leaves the map.
    registry._test_pendingAuth.set(ws, Date.now() - 60_000);
    registry._test_cleanupIdleSessions();
    expect((ws.close as Mock<() => void>).mock.calls.length).toBe(0);
    expect(registry._test_pendingAuth.size).toBe(0);
  });

  it("replies to a token-less AUTH instead of going silent", async () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH }));
    const err = await waitForMessage(ws, S2C.AUTH_ERROR);
    expect(err.message).toContain("token");
    // Not a close-worthy failure: the client may retry with a real token,
    // so the socket stays in the pending set until then.
    expect((ws.close as Mock<() => void>).mock.calls.length).toBe(0);
    expect(wsServer.sessionRegistry._test_pendingAuth.size).toBe(1);
  });

  it("removes pending-auth bookkeeping when the socket closes", () => {
    wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory(), auth: authCore() });

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    const registry = wsServer.sessionRegistry;
    expect(registry._test_pendingAuth.size).toBe(1);

    wsServer.onClose(ws);
    expect(registry._test_pendingAuth.size).toBe(0);
  });
});

// ── Log replay on attach (SWITCH_SESSION / reconnect) ───────────────────────

describe("log replay via SWITCH_SESSION", () => {
  const servers: Array<ReturnType<typeof createWsServer>> = [];
  const logs: string[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stopCleanupLoop();
    for (const p of logs.splice(0)) {
      try { rmSync(p, { force: true }); } catch {}
    }
  });

  /** Create a session, write a log for it, and switch the socket onto it. */
  async function switchWithLog(
    entries: Array<Record<string, unknown>>,
    buildAgent = createWsMockAgentFactory(),
  ): Promise<MockWs> {
    const wsServer = createWsServer(createWsMockCore(), { buildAgent });
    servers.push(wsServer);
    const ws = createWsMockWs();
    const { sessionId } = await wsServer.sessionRegistry.create({});
    const logPath = join(SESSIONS_DIR, `${sessionId}.jsonl`);
    writeFileSync(
      logPath,
      entries
        .map((e) => JSON.stringify({ ts: "2024-01-01T00:00:00Z", session_id: sessionId, ...e }))
        .join("\n") + "\n",
    );
    logs.push(logPath);
    (ws as unknown as HotdogServerSocket).activeSessionId = sessionId;
    await wsServer.onMessage(ws, JSON.stringify({ type: C2S.SWITCH_SESSION, sessionId }));
    return ws;
  }

  it("replays user messages", async () => {
    const ws = await switchWithLog([{ source: "input", content: "Hello" }]);
    const userMsg = ws.messages
      .map((m) => JSON.parse(m))
      .find((m: any) => m.type === S2C.USER_MESSAGE);
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe("Hello");
  });

  it("replays assistant messages with reasoning", async () => {
    const ws = await switchWithLog([
      { source: "llm", content: "Here's my answer", reasoning_content: "Let me think..." },
    ]);
    const msgs = ws.messages.map((m) => JSON.parse(m));
    const thinkingMsg = msgs.find((m: any) => m.type === S2C.THINKING);
    const assistantMsg = msgs.find((m: any) => m.type === S2C.ASSISTANT_MESSAGE);
    expect(thinkingMsg).toBeDefined();
    expect(thinkingMsg.content).toBe("Let me think...");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe("Here's my answer");
  });

  it("replays tool calls and results with names resolved from the epoch", async () => {
    const ws = await switchWithLog([
      {
        source: "llm",
        content: "",
        tool_calls: [
          { id: "call_123", type: "function", function: { name: "read_file", arguments: '{"path":"test.txt"}' } },
        ],
      },
      { source: "tool_result", tool_call_id: "call_123", content: "File content here" },
    ]);
    const msgs = ws.messages.map((m) => JSON.parse(m));
    const toolCallMsg = msgs.find((m: any) => m.type === S2C.TOOL_CALL);
    const toolResultMsg = msgs.find((m: any) => m.type === S2C.TOOL_RESULT);
    expect(toolCallMsg).toBeDefined();
    expect(toolCallMsg.name).toBe("read_file");
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.output).toBe("File content here");
    expect(toolResultMsg.name).toBe("read_file");
    // Call ids ride the wire so clients pair results to calls exactly.
    expect(toolCallMsg.toolCallId).toBe("call_123");
    expect(toolResultMsg.toolCallId).toBe("call_123");
  });


  it("never replays bookkeeping records as conversation", async () => {
    const ws = await switchWithLog([
      { source: "session_start", content: "", profile: "default", model: "m" },
      { source: "input", content: "hi" },
      { source: "tool_started", tool_call_id: "c1", tool_name: "bash", content: "{}" },
      { source: "resume_attempt", content: { origin: "manual" } },
      { source: "token_usage", content: "" },
      { source: "llm", content: "done" },
    ]);
    const msgs = ws.messages.map((m) => JSON.parse(m));
    const types = msgs.map((m: any) => m.type);
    expect(types.filter((t) => t === S2C.USER_MESSAGE)).toHaveLength(1);
    expect(types.filter((t) => t === S2C.ASSISTANT_MESSAGE)).toHaveLength(1);
    // Bookkeeping must not surface as any conversation message.
    expect(types).not.toContain(S2C.TOOL_CALL);
    expect(types).not.toContain(S2C.TOOL_RESULT);
  });

  it("reports the full log length as the client's replay cursor", async () => {
    const ws = await switchWithLog([
      { source: "input", content: "one" },
      { source: "llm", content: "two" },
    ]);
    // The cursor is a full-log coordinate (append-only; stable across
    // RESETs), not the epoch length. No RESET here, so the two agree.
    const cursor = ws.messages
      .map((m) => JSON.parse(m))
      .find((m: any) => m.type === S2C.SESSION_STATE && m.key === "cursor");
    expect(cursor).toBeDefined();
    expect(cursor.value).toBe(2);
  });
});

// ── Reconnect identity (?session=...&cursor=...) ────────────────────────────

describe("reconnect attach with session id + cursor", () => {
  const servers: Array<ReturnType<typeof createWsServer>> = [];
  const logs: string[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stopCleanupLoop();
    for (const p of logs.splice(0)) {
      try { rmSync(p, { force: true }); } catch {}
    }
  });

  function writeLog(logId: string, contents: string[]): void {
    const logPath = join(SESSIONS_DIR, `${logId}.jsonl`);
    writeFileSync(
      logPath,
      contents
        .map((c, i) =>
          JSON.stringify({ ts: `2024-01-01T00:00:0${i}Z`, session_id: logId, source: "input", content: c }),
        )
        .join("\n") + "\n",
    );
    logs.push(logPath);
  }

  it("adopts a cold session under its own id and replays the full log", async () => {
    writeLog("reconnect-full", ["one", "two"]);
    const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
    servers.push(wsServer);
    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws?session=reconnect-full", headers: { host: "localhost" } }, ws);

    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(created.sessionId).toBe("reconnect-full");
    expect(wsServer.sessionRegistry.get("reconnect-full")).not.toBeNull();
    const users = ws.messages
      .map((m) => JSON.parse(m))
      .filter((m: any) => m.type === S2C.USER_MESSAGE)
      .map((m: any) => m.content);
    expect(users).toEqual(["one", "two"]);

    // Exactly one sessionCreated for the adopter: the adoption broadcast must
    // target other tabs only. A duplicate (arriving after the cursor report)
    // would make the client re-run its attach bookkeeping and clear the
    // just-replayed transcript.
    await waitForCursor(ws);
    const createdCount = ws.messages
      .map((m) => { try { return JSON.parse(m); } catch { return null; } })
      .filter((m) => m && m.type === S2C.SESSION_CREATED && m.sessionId === "reconnect-full")
      .length;
    expect(createdCount).toBe(1);
  });

  it("refreshes other tabs' sidebars on adoption without re-attaching them", async () => {
    writeLog("reconnect-broadcast", ["one"]);
    const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
    servers.push(wsServer);

    // A second tab attaches first (default attach on an empty registry).
    const other = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, other);
    await waitForMessage(other, S2C.SESSION_CREATED);

    // The adopting tab reconnects to the cold log.
    const adopter = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws?session=reconnect-broadcast", headers: { host: "localhost" } }, adopter);
    await waitForMessage(adopter, S2C.SESSION_CREATED);

    // The adoption reaches other tabs as a SIDEBAR REFRESH (sessions list),
    // never as a sessionCreated: that event is an attach command on the
    // client (re-targets the socket, saves the remembered id, clears the
    // transcript), so broadcasting it would yank a tab that is working on a
    // different session. Waiting for the refresh proves the adoption fully
    // completed, so both sockets' streams are settled for the counts below.
    const refresh = await waitForMessageOf(
      other,
      (m: any) => m.type === S2C.SESSIONS && m.sessions.some((s: any) => s.id === "reconnect-broadcast"),
    );
    expect(refresh.sessions.some((s: any) => s.id === "reconnect-broadcast")).toBe(true);

    const createdFor = (ws: MockWs, sessionId: string) =>
      ws.messages
        .map((m) => { try { return JSON.parse(m); } catch { return null; } })
        .filter((m) => m && m.type === S2C.SESSION_CREATED && m.sessionId === sessionId)
        .length;
    expect(createdFor(adopter, "reconnect-broadcast")).toBe(1); // attach only
    expect(createdFor(other, "reconnect-broadcast")).toBe(0); // no attach command
  });

  it("replays only the delta when the client sends a cursor", async () => {
    writeLog("reconnect-delta", ["one", "two", "three"]);
    const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
    servers.push(wsServer);
    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws?session=reconnect-delta&cursor=1", headers: { host: "localhost" } }, ws);

    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(created.sessionId).toBe("reconnect-delta");
    // The client's transcript already ends at entry 1: only the tail is sent,
    // and sessionCreated flags it as a delta (no client-side clear).
    expect(created.replayDelta).toBe(true);
    const users = ws.messages
      .map((m) => JSON.parse(m))
      .filter((m: any) => m.type === S2C.USER_MESSAGE)
      .map((m: any) => m.content);
    expect(users).toEqual(["two", "three"]);
    const cursor = ws.messages
      .map((m) => JSON.parse(m))
      .find((m: any) => m.type === S2C.SESSION_STATE && m.key === "cursor");
    expect(cursor.value).toBe(3);
  });

  it("reports cursor 0 when an in-flight partial stream is flushed", async () => {
    writeLog("reconnect-partial", ["one", "two"]);
    const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
    servers.push(wsServer);
    // A live session that owns that log, mid-generation. The attach must
    // flush the partial AND refuse to claim a delta cursor: the transcript
    // would then hold content the log lacks at that position, so a delta
    // could replay the finished response on top of the partial.
    await wsServer.sessionRegistry.create({ sessionId: "reconnect-partial" });
    const agent = wsServer.sessionRegistry.get("reconnect-partial")!.agent as {
      currentStreamingContent?: string;
    };
    agent.currentStreamingContent = "half of the response";

    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws?session=reconnect-partial", headers: { host: "localhost" } }, ws);

    const chunk = await waitForMessage(ws, S2C.STREAMING_CHUNK);
    expect(chunk.content).toBe("half of the response");
    const cursor = await waitForMessageOf(
      ws,
      (m: any) => m.type === S2C.SESSION_STATE && m.key === "cursor",
    );
    expect(cursor.value).toBe(0);
  });

  // The cursor lives in the FULL log's append-only coordinate space: a RESET
  // appends, it never moves an earlier entry. These fixtures exercise the
  // case an epoch-length cursor got wrong -- a RESET that shrank the epoch
  // below the client's cursor and regrew the log past it while the socket
  // was down. When the slice crosses the RESET the server takes a full
  // replay (the epoch) instead of a delta: the client's retained prefix may
  // no longer be the honest head of its transcript (a rewind re-appends its
  // kept messages below the marker, a clear/handoff invalidated it).
  describe("cursor coordinates survive a RESET", () => {
    /** Full log (8 entries): 3 conversation entries, a RESET, a compaction,
     *  then 3 more conversation entries. Epoch length is 4; the full log
     *  (8) is past the client's cursor of 3. */
    const FIXTURE: Array<Record<string, unknown>> = [
      { source: "input", content: "one" },
      {
        source: "llm",
        content: "thinking",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { source: "tool_result", tool_call_id: "c1", content: "ran" },
      { source: "reset", content: "" },
      { source: "compaction", content: [{ type: "text", text: "summary" }] },
      {
        source: "llm",
        content: "asking",
        tool_calls: [{ id: "c2", type: "function", function: { name: "read_file", arguments: "{}" } }],
      },
      { source: "tool_result", tool_call_id: "c2", content: "data" },
      { source: "llm", content: "four" },
    ];

    function writeFixture(logId: string): void {
      const logPath = join(SESSIONS_DIR, `${logId}.jsonl`);
      writeFileSync(
        logPath,
        FIXTURE.map((l, i) =>
          JSON.stringify({ ts: `2024-01-01T00:00:0${i}Z`, session_id: logId, ...l }),
        ).join("\n") + "\n",
      );
      logs.push(logPath);
    }

    it("a slice crossing a RESET takes a full replay (the epoch), reporting the full length", async () => {
      writeFixture("cursor-reset-delta");
      const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
      servers.push(wsServer);
      const ws = createWsMockWs();
      // The client attached clean at full position 3 (it holds one/thinking/
      // ran), went away, the RESET landed and the turn regrew the log. The
      // delta would cross the marker: the retained prefix is no longer the
      // honest head, so the epoch replaces it.
      wsServer.onUpgrade({ url: "/ws?session=cursor-reset-delta&cursor=3", headers: { host: "localhost" } }, ws);

      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      // No delta flag: the transcript is cleared and replayed from the epoch.
      expect(created.replayDelta).toBeUndefined();
      const msgs = ws.messages.map((m) => JSON.parse(m));
      // The epoch is exactly the post-RESET work: nothing the client already
      // holds (no "one"/"thinking"/"ran"), nothing missing.
      const users = msgs.filter((m: any) => m.type === S2C.USER_MESSAGE).map((m: any) => m.content);
      expect(users).toEqual([]);
      const assistants = msgs.filter((m: any) => m.type === S2C.ASSISTANT_MESSAGE).map((m: any) => m.content);
      expect(assistants).toEqual(["asking", "four"]);
      // The compaction entry is bookkeeping: never surfaces.
      const types = msgs.map((m: any) => m.type);
      expect(types).not.toContain(S2C.THINKING);
      // Tool-result names resolve across the RESET boundary (call c2's LLM
      // entry is in the same slice; the full log is the name space).
      const call = msgs.find((m: any) => m.type === S2C.TOOL_CALL);
      const result = msgs.find((m: any) => m.type === S2C.TOOL_RESULT);
      expect(call.name).toBe("read_file");
      expect(result.name).toBe("read_file");
      expect(result.output).toBe("data");
      // The new cursor is the FULL log length (8), not the epoch length (4):
      // the next delta continues from the append-only position.
      const cursor = msgs.find((m: any) => m.type === S2C.SESSION_STATE && m.key === "cursor");
      expect(cursor.value).toBe(8);
    });

    // A rewind (/undo, /rewind, /clear, handoff, baton) re-appends its kept
    // messages below the RESET -- unlike compaction, which writes no RESET
    // at all. The kept entries are copies of the tail the client already
    // holds, so a delta across the marker would duplicate them.
    const REWIND_FIXTURE: Array<Record<string, unknown>> = [
      { source: "input", content: "one" },
      {
        source: "llm",
        content: "thinking",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { source: "tool_result", tool_call_id: "c1", content: "ran" },
      { source: "reset", content: "" },
      // The kept messages, re-appended by the rewind handler (the undone
      // tail is above the marker, only in the full log).
      { source: "input", content: "one" },
      {
        source: "llm",
        content: "thinking",
        tool_calls: [{ id: "c1", type: "function", function: { name: "bash", arguments: "{}" } }],
      },
      { source: "tool_result", tool_call_id: "c1", content: "ran" },
    ];

    function writeRewindFixture(logId: string): void {
      const logPath = join(SESSIONS_DIR, `${logId}.jsonl`);
      writeFileSync(
        logPath,
        REWIND_FIXTURE.map((l, i) =>
          JSON.stringify({ ts: `2024-01-01T00:00:0${i}Z`, session_id: logId, ...l }),
        ).join("\n") + "\n",
      );
      logs.push(logPath);
    }

    it("a delta across a rewind RESET (kept messages re-appended) clamps to a full replay", async () => {
      writeRewindFixture("cursor-rewind");
      const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
      servers.push(wsServer);
      const ws = createWsMockWs();
      // The client attached clean at full position 3 (it holds one/thinking/
      // ran), went away, a rewind re-appended the kept tail. The delta past
      // the cursor would be the three re-appended copies: duplicates.
      wsServer.onUpgrade({ url: "/ws?session=cursor-rewind&cursor=3", headers: { host: "localhost" } }, ws);

      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      // No delta flag: the transcript is cleared and replayed from the epoch.
      expect(created.replayDelta).toBeUndefined();
      const msgs = ws.messages.map((m) => JSON.parse(m));
      // The epoch is exactly the kept messages: one copy each, nothing stale.
      const users = msgs.filter((m: any) => m.type === S2C.USER_MESSAGE).map((m: any) => m.content);
      expect(users).toEqual(["one"]);
      const assistants = msgs.filter((m: any) => m.type === S2C.ASSISTANT_MESSAGE).map((m: any) => m.content);
      expect(assistants).toEqual(["thinking"]);
      const result = msgs.find((m: any) => m.type === S2C.TOOL_RESULT);
      expect(result.output).toBe("ran");
      // The new cursor indexes the FULL log (7), so the next clean reconnect
      // deltas normally.
      const cursor = msgs.find((m: any) => m.type === S2C.SESSION_STATE && m.key === "cursor");
      expect(cursor.value).toBe(7);
    });

    it("a full replay after a RESET sends the epoch and reports the full length", async () => {
      writeFixture("cursor-reset-full");
      const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
      servers.push(wsServer);
      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: "/ws?session=cursor-reset-full", headers: { host: "localhost" } }, ws);

      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      expect(created.replayDelta).toBeUndefined();
      const msgs = ws.messages.map((m) => JSON.parse(m));
      // Full replay is the context's view: the EPOCH (post-RESET) only.
      const assistants = msgs.filter((m: any) => m.type === S2C.ASSISTANT_MESSAGE).map((m: any) => m.content);
      expect(assistants).toEqual(["asking", "four"]);
      const users = msgs.filter((m: any) => m.type === S2C.USER_MESSAGE);
      expect(users).toEqual([]);
      // But the cursor is the full length: it indexes the append-only log,
      // so the client can delta from it even though it never saw the head.
      const cursor = msgs.find((m: any) => m.type === S2C.SESSION_STATE && m.key === "cursor");
      expect(cursor.value).toBe(8);
    });

    it("a cursor beyond the full length (log shrank under it) clamps to a full replay", async () => {
      writeFixture("cursor-stale");
      const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
      servers.push(wsServer);
      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: "/ws?session=cursor-stale&cursor=99", headers: { host: "localhost" } }, ws);

      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      expect(created.replayDelta).toBeUndefined();
      const msgs = ws.messages.map((m) => JSON.parse(m));
      // Stale transcript discarded: the epoch is replayed in full.
      const assistants = msgs.filter((m: any) => m.type === S2C.ASSISTANT_MESSAGE).map((m: any) => m.content);
      expect(assistants).toEqual(["asking", "four"]);
      const cursor = msgs.find((m: any) => m.type === S2C.SESSION_STATE && m.key === "cursor");
      expect(cursor.value).toBe(8);
    });
  });

  it("falls back to a fresh session (with an error) when the saved id has no log", async () => {
    const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
    servers.push(wsServer);
    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws?session=never-was", headers: { host: "localhost" } }, ws);

    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(created.sessionId).not.toBe("never-was");
    const err = await waitForMessage(ws, S2C.ERROR);
    expect(err.message).toContain("no log found");
  });

  it("refuses an auto-resume at the livelock cap, with a parked explanation", async () => {
    // Five consecutive auto resume_attempts with no progress between them.
    const logId = "reconnect-parked";
    const lines = [
      JSON.stringify({ ts: "2024-01-01T00:00:00Z", session_id: logId, source: "input", content: "work" }),
    ];
    for (let i = 0; i < 5; i++) {
      lines.push(
        JSON.stringify({ ts: `2024-01-01T00:00:1${i}Z`, session_id: logId, source: "resume_attempt", content: { origin: "auto" } }),
      );
    }
    const logPath = join(SESSIONS_DIR, `${logId}.jsonl`);
    writeFileSync(logPath, lines.join("\n") + "\n");
    logs.push(logPath);

    const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
    servers.push(wsServer);
    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: `/ws?session=${logId}`, headers: { host: "localhost" } }, ws);

    const err = await waitForMessage(ws, S2C.ERROR);
    expect(err.message).toContain("parked");
    expect(err.message).toContain("5");
    // And the socket is not stranded: the fallback attach opened a session.
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(created.sessionId).not.toBe(logId);
  });

  it("manual resume (LOAD_LOG) bypasses the livelock cap", async () => {
    const logId = "reconnect-manual";
    const lines = [
      JSON.stringify({ ts: "2024-01-01T00:00:00Z", session_id: logId, source: "input", content: "work" }),
    ];
    for (let i = 0; i < 5; i++) {
      lines.push(
        JSON.stringify({ ts: `2024-01-01T00:00:1${i}Z`, session_id: logId, source: "resume_attempt", content: { origin: "auto" } }),
      );
    }
    const logPath = join(SESSIONS_DIR, `${logId}.jsonl`);
    writeFileSync(logPath, lines.join("\n") + "\n");
    logs.push(logPath);

    const wsServer = createWsServer(createWsMockCore(), { buildAgent: createWsMockAgentFactory() });
    servers.push(wsServer);
    const ws = createWsMockWs();
    wsServer.onMessage(ws, JSON.stringify({ type: C2S.LOAD_LOG, logId }));

    // User intent: an explicit resume is never capped or parked, even at the
    // cap. (Record writing is the session-log extension's job; the mock
    // hooks here swallow it, so no count assertion.)
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    expect(created.sessionId).toBe(logId);
    expect(wsServer.sessionRegistry.get(logId)).not.toBeNull();
  });

  // ── Open-turn auto-continuation (attachResumedSession tail) ────────────
  // A cold log whose last v2 turn is open enqueues exactly one continuation
  // turn on the session bus right after the adopter's cursor report. The
  // bus run loop consumes the queue item almost immediately, so the tests
  // observe it through a continueRun spy on the mock agent, never by
  // polling the queue.
  describe("open-turn auto-continuation", () => {
    function spyContinuation() {
      let continued = 0;
      const buildAgent = async (cfg: {
        model?: string;
        sessionId?: string;
        profileName?: string;
      }): Promise<AgentLike> =>
        makeWsMockAgent({
          sessionId: cfg.sessionId || "test",
          continueRun: () => {
            continued++;
            return Promise.resolve(undefined);
          },
        });
      return { buildAgent, count: () => continued };
    }

    /** Poll until count() reaches expected (the enqueue lands in a
     *  microtask after the cursor report, so never assert immediately). */
    async function waitForCount(count: () => number, expected: number): Promise<void> {
      const start = Date.now();
      for (;;) {
        if (count() === expected) return;
        if (Date.now() - start > 2000) {
          throw new Error(`expected continueRun x${expected}, got ${count()}`);
        }
        await new Promise((r) => setTimeout(r, 5));
      }
    }

    const line = (logId: string, over: Record<string, unknown>): string =>
      JSON.stringify({
        ts: "2024-01-01T00:00:00Z",
        session_id: logId,
        source: "input",
        content: "",
        ...over,
      });

    /** Write raw JSONL lines (turn/question/resume records, unlike the
     *  block's writeLog which stamps everything as user input). */
    function writeLines(logId: string, lines: string[]): void {
      const logPath = join(SESSIONS_DIR, `${logId}.jsonl`);
      writeFileSync(logPath, lines.join("\n") + "\n");
      logs.push(logPath);
    }

    it("auto-continues an open v2 turn on reconnect", async () => {
      const logId = "open-turn-auto";
      writeLines(logId, [
        line(logId, { source: "input", content: "work" }),
        line(logId, { source: "turn_started", v: 2, content: { kind: "input" } }),
      ]);
      const { buildAgent, count } = spyContinuation();
      const wsServer = createWsServer(createWsMockCore(), { buildAgent });
      servers.push(wsServer);
      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: `/ws?session=${logId}`, headers: { host: "localhost" } }, ws);

      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      expect(created.sessionId).toBe(logId);
      const users = ws.messages
        .map((m) => JSON.parse(m))
        .filter((m: any) => m.type === S2C.USER_MESSAGE)
        .map((m: any) => m.content);
      expect(users).toEqual(["work"]);
      // Enqueue fires right after the cursor lands: exactly once, a
      // double-enqueue is the bug this guards against.
      await waitForCursor(ws);
      await waitForCount(count, 1);
    });

    it("does not continue a closed v2 turn", async () => {
      const logId = "closed-turn";
      writeLines(logId, [
        line(logId, { source: "input", content: "work" }),
        line(logId, { source: "turn_started", v: 2, content: { kind: "input" } }),
        line(logId, { source: "llm", content: "done" }),
        line(logId, { source: "turn_end", v: 2, content: { status: "completed" } }),
      ]);
      const { buildAgent, count } = spyContinuation();
      const wsServer = createWsServer(createWsMockCore(), { buildAgent });
      servers.push(wsServer);
      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: `/ws?session=${logId}`, headers: { host: "localhost" } }, ws);

      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      expect(created.sessionId).toBe(logId);
      await waitForCursor(ws);
      // A (missing) enqueue would fire in a microtask right after the
      // cursor report; give it a beat before asserting absence.
      await new Promise((r) => setTimeout(r, 100));
      expect(count()).toBe(0);
    });

    it("never auto-resumes a v1 tail (no turn records)", async () => {
      const logId = "v1-tail";
      writeLines(logId, [
        line(logId, { source: "input", content: "work" }),
        // Pre-protocol shape: a dangling tool call, no turn lifecycle.
        line(logId, { source: "tool_started", content: "{}", tool_call_id: "c1" }),
      ]);
      const { buildAgent, count } = spyContinuation();
      const wsServer = createWsServer(createWsMockCore(), { buildAgent });
      servers.push(wsServer);
      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: `/ws?session=${logId}`, headers: { host: "localhost" } }, ws);

      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      expect(created.sessionId).toBe(logId);
      await waitForCursor(ws);
      await new Promise((r) => setTimeout(r, 100));
      expect(count()).toBe(0);
    });

    it("lets the held question win over the open turn; the answer drives the continuation", async () => {
      const logId = "held-question";
      writeLines(logId, [
        line(logId, { source: "input", content: "work" }),
        line(logId, { source: "turn_started", v: 2, content: { kind: "input" } }),
        line(logId, {
          source: "llm",
          content: "let me ask",
          tool_calls: [
            { id: "call_q", type: "function", function: { name: "question", arguments: "{}" } },
          ],
        }),
        line(logId, {
          source: "question_asked",
          tool_call_id: "call_q",
          content: [{ key: "mode", prompt: "Which mode?" }],
        }),
      ]);
      const { buildAgent, count } = spyContinuation();
      const wsServer = createWsServer(createWsMockCore(), { buildAgent });
      servers.push(wsServer);
      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: `/ws?session=${logId}`, headers: { host: "localhost" } }, ws);

      // The held question is re-presented to the adopter instead of a
      // continuation: a turn must not start on a dangling question call.
      const question = await waitForMessage(ws, S2C.QUESTION);
      expect(question.sessionId).toBe(logId);
      expect(question.questions[0].key).toBe("mode");
      await waitForCursor(ws);
      await new Promise((r) => setTimeout(r, 100));
      expect(count()).toBe(0);

      // Answering the held call enqueues the continuation instead.
      await wsServer.onMessage(
        ws,
        JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId: logId, answers: { mode: "a" } }),
      );
      await waitForCount(count, 1);
    });

    it("enqueues exactly once for concurrent adopters", async () => {
      const logId = "concurrent-adopt";
      writeLines(logId, [
        line(logId, { source: "input", content: "work" }),
        line(logId, { source: "turn_started", v: 2, content: { kind: "input" } }),
      ]);
      const { buildAgent, count } = spyContinuation();
      const wsServer = createWsServer(createWsMockCore(), { buildAgent });
      servers.push(wsServer);

      // Two tabs reconnect to the same cold log in one tick: both attach
      // flows start before either adoption completes, so pendingAdoptions
      // is what dedupes them.
      const ws1 = createWsMockWs();
      const ws2 = createWsMockWs();
      wsServer.onUpgrade({ url: `/ws?session=${logId}`, headers: { host: "localhost" } }, ws1);
      wsServer.onUpgrade({ url: `/ws?session=${logId}`, headers: { host: "localhost" } }, ws2);

      const created1 = await waitForMessage(ws1, S2C.SESSION_CREATED);
      const created2 = await waitForMessage(ws2, S2C.SESSION_CREATED);
      expect(created1.sessionId).toBe(logId);
      expect(created2.sessionId).toBe(logId);
      await waitForCount(count, 1);
    });

    it("does not continue a parked log with an open turn (fallback, never adopted)", async () => {
      const logId = "parked-open-turn";
      const lines = [
        line(logId, { source: "input", content: "work" }),
        line(logId, { source: "turn_started", v: 2, content: { kind: "input" } }),
      ];
      for (let i = 0; i < 5; i++) {
        lines.push(line(logId, { source: "resume_attempt", content: { origin: "auto" } }));
      }
      writeLines(logId, lines);
      const { buildAgent, count } = spyContinuation();
      const wsServer = createWsServer(createWsMockCore(), { buildAgent });
      servers.push(wsServer);
      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: `/ws?session=${logId}`, headers: { host: "localhost" } }, ws);

      const err = await waitForMessage(ws, S2C.ERROR);
      expect(err.message).toContain("parked");
      // The socket is not stranded: the fallback attach opened a session,
      // and the parked log was refused before adoption, never adopted.
      const created = await waitForMessage(ws, S2C.SESSION_CREATED);
      expect(created.sessionId).not.toBe(logId);
      expect(wsServer.sessionRegistry.get(logId)).toBeNull();
      await new Promise((r) => setTimeout(r, 100));
      expect(count()).toBe(0);
    });
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

  it("sets input for non-question tools too (approvals need the seam)", () => {
    const handlers = core._registeredHooks["agent:toolContext"];
    const store: Record<string, unknown> = {};
    const toolCtx = {
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => {
        store[k] = v;
      },
    };
    const agent = wsServer.sessionRegistry.get(sessionId)!.agent;
    handlers[0]!({ toolCtx, toolName: "bash", agent });
    const input = store["input"] as { isInteractive: () => boolean } | undefined;
    expect(input).toBeDefined();
    expect(input!.isInteractive()).toBe(true);
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

  it("replays the pending question to a reconnecting client (tab refresh)", async () => {
    const p = startQuestion();

    // Tab refresh: old socket closes, new one upgrades and auto-attaches
    // to the most recent session.
    wsServer.onClose(ws as unknown as HotdogServerSocket<unknown>);
    const ws2 = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws2);

    const created = await waitForMessage(ws2, S2C.SESSION_CREATED);
    expect(created.sessionId).toBe(sessionId);

    const question = await waitForMessage(ws2, S2C.QUESTION);
    expect(question.sessionId).toBe(sessionId);
    expect(question.questions[0].key).toBe("q1");
    // Card must render after the replayed history, not before it.
    const types = messageTypes(ws2);
    expect(types.lastIndexOf(S2C.QUESTION)).toBeGreaterThan(
      types.indexOf(S2C.SESSION_CREATED),
    );

    // The reconnected client can answer; the blocked tool call resolves.
    await wsServer.onMessage(
      ws2,
      JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId, answers: { q1: "Ada" } }),
    );
    await expect(p).resolves.toEqual({ q1: "Ada" });
  });

  it("attaching with no pending question sends no question message", async () => {
    wsServer.onClose(ws as unknown as HotdogServerSocket<unknown>);
    const ws2 = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws2);
    await waitForMessage(ws2, S2C.SESSION_CREATED);
    expect(messageTypes(ws2)).not.toContain(S2C.QUESTION);
  });
});

// ── COMPLETE message ─────────────────────────────────────────────────────

describe("createWsServer - COMPLETE", () => {
  let wsServer: ReturnType<typeof createWsServer>;

  afterEach(() => {
    wsServer?.stopCleanupLoop();
  });

  async function connectWithCompletion(
    register?: (completion: ReturnType<typeof createCompletionService>) => void,
  ): Promise<{ ws: MockWs; sessionId: string }> {
    const core = createWsMockCore();
    register?.(core.completion);
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
    const ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    const created = await waitForMessage(ws, S2C.SESSION_CREATED);
    return { ws, sessionId: created.sessionId };
  }

  it("returns completions with the replacement prefix", async () => {
    const { ws, sessionId } = await connectWithCompletion((completion) => {
      completion.register(
        (ctx) => ctx.line.slice(0, ctx.cursorPos).endsWith("@sr"),
        () => [{ value: "@src/core/" }],
        "test:paths",
      );
    });

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.COMPLETE, sessionId, requestId: 7, line: "review @sr", cursorPos: 10 }),
    );

    const msg = await waitForMessage(ws, S2C.COMPLETIONS);
    expect(msg.requestId).toBe(7);
    expect(msg.sessionId).toBe(sessionId);
    expect(msg.prefix).toBe("@sr");
    expect(msg.options).toEqual([{ value: "@src/core/", display: "@src/core/" }]);
  });

  it("parses slash command context and keeps the slash in the prefix", async () => {
    const { ws, sessionId } = await connectWithCompletion((completion) => {
      completion.register(
        (ctx) => ctx.command === "mo",
        () => [{ value: "/model", display: "/model" }],
        "test:cmds",
      );
    });

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.COMPLETE, sessionId, requestId: 1, line: "/mo", cursorPos: 3 }),
    );

    const msg = await waitForMessage(ws, S2C.COMPLETIONS);
    expect(msg.prefix).toBe("/mo");
    expect(msg.options).toEqual([{ value: "/model", display: "/model" }]);
  });

  it("does not answer for an unknown session", async () => {
    const { ws } = await connectWithCompletion();
    const before = ws.messages.length;

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.COMPLETE, sessionId: "no-such-session", line: "/mo", cursorPos: 3 }),
    );
    await new Promise((r) => setTimeout(r, 25));

    expect(ws.messages.length).toBe(before);
  });

  it("answers malformed input with empty options instead of crashing", async () => {
    const { ws, sessionId } = await connectWithCompletion();

    wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.COMPLETE, sessionId, requestId: 2, cursorPos: "bad" }),
    );

    const msg = await waitForMessage(ws, S2C.COMPLETIONS);
    expect(msg.requestId).toBe(2);
    expect(msg.prefix).toBe("");
    expect(msg.options).toEqual([]);
  });
});

// ── Extension create(): completion registration ────────────────────────────

describe("websocket extension create()", () => {
  it("registers slash-name completion and deduped command-arg completions", () => {
    const core = createWsMockCore();
    create(core);

    const handlers = core._registeredHooks[HOOKS.COMMANDS_REGISTER];
    expect(handlers?.length).toBe(1);
    // Slash-name completion is registered up front, before any agent build.
    expect(core.completion.handlerCount()).toBe(1);

    const registry = {
      all: () =>
        new Map<string, { completion?: () => [] }>([
          ["reasoning", { completion: () => [] }],
          ["nocmp", {}],
        ]),
    };
    handlers[0]!({ registry });
    expect(core.completion.handlerCount()).toBe(2);

    // A second COMMANDS_REGISTER (another session's agent build) adds nothing.
    handlers[0]!({ registry });
    expect(core.completion.handlerCount()).toBe(2);
  });
});

// ── resumed pending questions (seed chain + dismiss) ────────────────────────

describe("resumed pending questions (seedResumedQuestions / dismissResumedQuestions)", () => {
  type InjectCb = (answers: Record<string, unknown>, cancelled: boolean) => void;

  function fakeBridge() {
    const injected: Array<{ sessionId: string; questions: unknown; cb: InjectCb }> = [];
    const removed: string[] = [];
    const bridge = {
      inject: (sessionId: string, questions: unknown, cb: InjectCb) => {
        injected.push({ sessionId, questions, cb });
      },
      remove: (sessionId: string) => {
        removed.push(sessionId);
        return true;
      },
    } as unknown as WebSocketQuestionBridge;
    return { bridge, injected, removed };
  }

  function fakeAgent() {
    const added: Message[] = [];
    return { agent: { addMessage: (m: Message) => added.push(m) } as unknown as AgentLike, added };
  }

  function fakeRegistry(agent: AgentLike | null) {
    const broadcasts: Array<Record<string, unknown>> = [];
    const reg = {
      get: (_sid: string) => (agent ? { agent } : undefined),
      broadcast: (m: Record<string, unknown>) => broadcasts.push(m),
      getSessionManager: () => ({ getBus: () => undefined }),
    } as unknown as SessionRegistry;
    return { reg, broadcasts };
  }

  const pending = (sid: string) => [
    { toolCallId: `${sid}-q1`, questions: [{ key: "a", prompt: "A?" }] },
    { toolCallId: `${sid}-q2`, questions: [{ key: "b", prompt: "B?" }] },
  ];

  it("answer lands on the CURRENT agent, not the one captured at load", () => {
    // Regression: the inject callback used to close over the agent from log
    // load; a profile switch or /model before the answer wrote to a stale
    // instance. It must resolve the agent fresh from the registry.
    const sid = "resumed-fresh-agent";
    const { bridge, injected } = fakeBridge();
    const load = fakeAgent();
    const live = fakeAgent();
    // Seed with one registry shape whose get() returns the live agent (what
    // the registry reports after a swap), NOT the load-time instance.
    const { reg } = fakeRegistry(live.agent);

    seedResumedQuestions(bridge, reg, sid, [pending(sid)[0]!]);
    expect(injected).toHaveLength(1);
    injected[0]!.cb({ a: "yes" }, false);

    expect(load.added).toHaveLength(0);
    expect(live.added).toHaveLength(1);
    expect(live.added[0]!.toolCallId).toBe(`${sid}-q1`);
  });

  it("dismiss closes every held call honestly and tells the clients", () => {
    const sid = "resumed-dismiss";
    const { bridge, injected, removed } = fakeBridge();
    const { agent, added } = fakeAgent();
    const { reg, broadcasts } = fakeRegistry(agent);

    seedResumedQuestions(bridge, reg, sid, pending(sid));
    expect(injected).toHaveLength(1); // first question presented

    dismissResumedQuestions(bridge, reg, sid);

    // Both held calls answered with honest error results (wire-valid context).
    expect(added).toHaveLength(2);
    for (const m of added) {
      expect(m.toolCallId).toMatch(/-q[12]$/);
      const parts = m.content as Array<{ status: string; output: string }>;
      expect(parts[0]!.status).toBe("error");
      expect(parts[0]!.output).toContain("dismissed");
    }
    // The bridge entry is dropped WITHOUT resolving (no duplicate answer).
    expect(removed).toEqual([sid]);
    // Clients get the card-clearing signal: the same event the live answer
    // path broadcasts, flagged dismissed with empty answers.
    const cleared = broadcasts.find((b) => b.type === S2C.QUESTION_ANSWERED);
    expect(cleared).toBeDefined();
    expect(cleared!.dismissed).toBe(true);
    expect(cleared!.answers).toEqual({});

    // The stale inject callback must not write anything after the dismiss.
    const before = added.length;
    injected[0]!.cb({ a: "late" }, false);
    expect(added).toHaveLength(before);
  });

  it("answering the last held call clears the hold and queues a continuation", () => {
    const sid = "resumed-chain";
    const { bridge, injected } = fakeBridge();
    const { agent, added } = fakeAgent();
    let continued = 0;
    const reg = {
      get: (_sid: string) => ({ agent }),
      broadcast: () => {},
      getSessionManager: () => ({
        getBus: (_sid: string) => ({
          enqueue: (_c: string, opts?: { continuation?: boolean }) => {
            if (opts?.continuation) continued++;
          },
        }),
      }),
    } as unknown as SessionRegistry;

    seedResumedQuestions(bridge, reg, sid, pending(sid));
    injected[0]!.cb({ a: "1" }, false); // q1 answered, q2 chains
    expect(injected).toHaveLength(2);
    expect(added).toHaveLength(1);
    expect(continued).toBe(0);

    injected[1]!.cb({ b: "2" }, false); // q2 answered: continuation, no more holds
    expect(added).toHaveLength(2);
    expect(continued).toBe(1);

    // Hold is gone: a later dismiss is a no-op.
    dismissResumedQuestions(bridge, reg, sid);
    expect(added).toHaveLength(2);
  });
});

// ── Terminal task cleanup: stale pending questions ─────────────────────────
// A worker killed while blocked in a question leaves its bridge pending
// behind. The terminal observer event must cancel it under the WORKER's
// session (where the pending is registered) -- not the delegating session,
// which may carry its own live question that a wrong-keyed cancel would
// resolve with defaults and swallow the user's answer.

describe("terminal task cleanup (stale pending questions)", () => {
  let core: any;
  let wsServer: ReturnType<typeof createWsServer>;
  let ws: MockWs;

  afterEach(() => {
    wsServer.stopTaskManager();
    wsServer.stopCleanupLoop();
  });

  /** Poll until fn() is truthy; fails loudly on timeout. */
  async function poll<T>(fn: () => T | null | undefined, what: string, timeoutMs = 2000): Promise<T> {
    const start = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - start > timeoutMs) throw new Error(`Timed out waiting for ${what}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  /** Drive the server's AGENT_TOOL_CONTEXT seam for one agent and start a live question collect. */
  function startQuestionFor(agent: AgentLike, questions: Array<Record<string, unknown>>): Promise<Record<string, unknown>> {
    const handlers = core._registeredHooks["agent:toolContext"];
    expect(handlers).toHaveLength(1);
    const store: Record<string, unknown> = {};
    const toolCtx = {
      get: (k: string) => store[k],
      set: (k: string, v: unknown) => { store[k] = v; },
    };
    handlers[0]!({ toolCtx, toolName: "question", agent });
    const input = store["input"] as {
      collectAnswers: (qs: Array<Record<string, unknown>>) => Promise<Record<string, unknown>>;
    };
    expect(input).toBeDefined();
    return input.collectAnswers(questions);
  }

  it("cancels the worker's stale pending, leaves the delegating session's own question alone", async () => {
    core = createWsMockCore();
    // Task workers (no sessionId in their config) hang until the task's
    // abort signal fires, like a live in-flight turn. User sessions get the
    // usual mock agent.
    const buildAgent = async (config: { model?: string; sessionId?: string }): Promise<AgentLike> => {
      if (config.sessionId) {
        return makeWsMockAgent({ sessionId: config.sessionId, model: config.model || "test-model" });
      }
      const worker = makeWsMockAgent({
        sessionId: "worker-stale",
        model: config.model || "test-model",
        abortSignal: null,
        run: () =>
          new Promise<never>((_res, rej) => {
            (worker as unknown as { abortSignal: AbortSignal }).abortSignal.addEventListener(
              "abort",
              () => rej(LlmError.Cancelled("aborted")),
              { once: true },
            );
          }),
      });
      return worker;
    };

    wsServer = createWsServer(core, {
      buildAgent,
      questionStrategy: "wait",
      questionTimeoutSecs: 300,
    });

    ws = createWsMockWs();
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await waitForMessage(ws, S2C.SESSION_CREATED);
    const mgrSid = (ws as unknown as HotdogServerSocket).activeSessionId!;

    const tm = wsServer.sessionRegistry.getTaskManager()!;
    await tm.spawnTask("task-stale", "work", { workerModel: "test-model" });
    const workerAgent = await poll(
      () => tm._test_tasks.get("task-stale")!.agent,
      "worker agent build",
    );

    // The worker blocks in a question; the delegating session simultaneously
    // has its own live question pending (e.g. the manager asked the user
    // something while the task ran).
    let workerAnswer: Record<string, unknown> | null = null;
    const workerPending = startQuestionFor(workerAgent!, [{ key: "q", prompt: "Q?" }]);
    workerPending.then((a) => { workerAnswer = a; });
    let mgrAnswer: Record<string, unknown> | null = null;
    const mgrAgent = wsServer.sessionRegistry.get(mgrSid)!.agent;
    const mgrPending = startQuestionFor(mgrAgent, [{ key: "mq", prompt: "M?" }]);
    mgrPending.then((a) => { mgrAnswer = a; });

    // Kill the worker mid-question.
    expect(tm.interruptTask("task-stale")).toBe(true);
    await poll(
      () => {
        const s = tm.taskStatus("task-stale");
        return s === TASK_STATUS.CANCELLED ? s : null;
      },
      "cancellation",
    );

    // The stale worker pending settles as a cancel (defaults: no live turn
    // is left to consume a real answer). Poll with a deadline: a cleanup
    // keyed on the wrong session never settles this promise at all.
    const settled = await poll(() => workerAnswer, "worker pending settle");
    expect(settled).toEqual({ q: "" });

    // The delegating session's own question survived the terminal event:
    // answering it still lands. (A wrong-keyed cancel would have resolved it
    // with defaults already, and this answer would hit "No pending question".)
    await wsServer.onMessage(
      ws,
      JSON.stringify({ type: C2S.QUESTION_ANSWER, sessionId: mgrSid, answers: { mq: "still alive" } }),
    );
    expect(lastMessage(ws).type).toBe(S2C.QUESTION_ANSWERED);
    const mgrSettled = await poll(() => mgrAnswer, "manager pending answer");
    expect(mgrSettled).toEqual({ mq: "still alive" });
  });
});

// ── Tool-exec posture strip ───────────────────────────────────────

describe("tool-exec posture on sessionCreated", () => {
  let server: ReturnType<typeof createWsServer> | null = null;

  afterEach(() => {
    server?.stopCleanupLoop();
    server = null;
  });

  async function attach(resolved: Record<string, unknown> = {}): Promise<any> {
    const core = createWsMockCore();
    Object.assign(core.resolved, resolved);
    server = createWsServer(core, { buildAgent: createWsMockAgentFactory() });
    const ws = createWsMockWs();
    server.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    return waitForMessage(ws, S2C.SESSION_CREATED);
  }

  it("advertises the posture on the same payload as sttEnabled (no new channel)", async () => {
    // The mock core resolves to inline (no opt-in), and says so.
    expect((await attach()).toolExec).toBe("inline (unfenced)");
    expect((await attach({ toolExec: "worker", execFence: "off" })).toolExec).toBe(
      "worker (fence: off)",
    );
    // Probe policy reports the probe outcome -- jail or honest failure, never silence.
    expect((await attach({ toolExec: "worker", execFence: "probe" })).toolExec).toMatch(
      /^worker \(fence: (bwrap|none -- probe failed)\)$/,
    );
  });

  it("SessionRegistry labels the posture from resolved values only", () => {
    const buildAgent = async () => makeWsMockAgent({});
    const plain = new SessionRegistry({ buildAgent, toolExecResolved: { toolExec: "inline", execFence: "probe" } });
    const off = new SessionRegistry({ buildAgent, toolExecResolved: { toolExec: "worker", execFence: "off" } });
    const probe = new SessionRegistry({ buildAgent, toolExecResolved: { toolExec: "worker", execFence: "probe" } });
    expect(plain.toolExecLabel).toBe("inline (unfenced)");
    expect(off.toolExecLabel).toBe("worker (fence: off)");
    expect(probe.toolExecLabel).toMatch(/^worker \(fence: (bwrap|none -- probe failed)\)$/);
    plain.stopCleanupLoop();
    off.stopCleanupLoop();
    probe.stopCleanupLoop();
  });
});
