// Tests for WebSocket server — session management and message routing.
import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SessionRegistry, createWsServer, type HotdogServerSocket } from "../../src/extensions/websocket/server.ts";
import { WebSocketChannel } from "../../src/extensions/websocket/websocket-channel.ts";
import { createWsMockCore, createWsMockAgentFactory, createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

type MockWs = ReturnType<typeof createWsMockWs>;

// ── SessionRegistry Tests ───────────────────────────────────────────────────

describe("SessionRegistry", () => {
  let registry: SessionRegistry;

  afterEach(() => {
    registry?.stopCleanupLoop();
  });

  it("creates session with agent-provided sessionId", async () => {
    const buildAgent = async () => makeWsMockAgent({ sessionId: "agent-session-123" });
    registry = new SessionRegistry({ buildAgent });
    const result = await registry.create();
    expect(result.sessionId).toBe("agent-session-123");
  });

  it("creates session with fallback proposed sessionId when agent has no sessionId", async () => {
    const buildAgent = async (config: { sessionId?: string }) =>
      makeWsMockAgent({ sessionId: config.sessionId || "fallback-session" });
    registry = new SessionRegistry({ buildAgent });
    const result = await registry.create();
    expect(result.sessionId).toBeDefined();
    expect(typeof result.sessionId).toBe("string");
  });

  it("returns null for non-existent session", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    expect(registry.get("non-existent")).toBeNull();
  });

  it("lists all sessions", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { sessionId } = await registry.create();

    const sessions = registry.list();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(sessionId);
  });

  it("deletes session and cleans up channels", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { sessionId } = await registry.create();

    // Create a mock channel
    const mockWs = createWsMockWs() as unknown as HotdogServerSocket;
    const channel = registry.createChannel(sessionId, mockWs);

    // Verify channel was created
    expect(channel).toBeDefined();

    // Delete the session
    const result = registry.delete(sessionId);
    expect(result).toBe(true);

    // Verify session is gone
    expect(registry.get(sessionId)).toBeNull();
    expect(registry.list()).toHaveLength(0);
  });

  it("returns false when deleting non-existent session", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    expect(registry.delete("non-existent")).toBe(false);
  });

  it("renames session profile", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { sessionId } = await registry.create();

    expect(registry.rename(sessionId, "new-profile")).toBe(true);
    expect(registry._test_metadata.get(sessionId)!.profile).toBe("new-profile");
  });

  it("returns false when renaming non-existent session", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    expect(registry.rename("non-existent", "new-profile")).toBe(false);
  });

  it("touches session to update lastActivityAt", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { sessionId } = await registry.create();

    const meta = registry._test_metadata.get(sessionId)!;
    const before = meta.lastActivityAt;
    await new Promise((r) => setTimeout(r, 10));
    registry.touch(sessionId);
    expect(registry._test_metadata.get(sessionId)!.lastActivityAt).toBeGreaterThan(before);
  });

  it("starts and stops cleanup loop", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    registry.startCleanupLoop(10);
    expect(registry._test_timeoutMin).toBe(10);
    registry.stopCleanupLoop();
  });

  it("cleans up idle sessions", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { sessionId } = await registry.create();

    // Set metadata to be very old
    const meta = registry._test_metadata.get(sessionId)!;
    meta.lastActivityAt = Date.now() - 1000 * 60 * 60; // 1 hour ago
    meta.connectedClients = 0;

    // Set timeout to 1 minute
    registry._test_timeoutMin = 1;
    registry._test_cleanupIdleSessions();

    expect(registry.get(sessionId)).toBeNull();
  });

  it("does not clean up sessions with connected clients", async () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });
    const { sessionId } = await registry.create();

    // Set metadata to be very old but with connected clients
    const meta = registry._test_metadata.get(sessionId)!;
    meta.lastActivityAt = Date.now() - 1000 * 60 * 60;
    meta.connectedClients = 1;

    registry._test_timeoutMin = 1;
    registry._test_cleanupIdleSessions();

    expect(registry.get(sessionId)).not.toBeNull();
  });

  it("broadcasts to all connections", () => {
    registry = new SessionRegistry({ buildAgent: createWsMockAgentFactory() });

    const ws1 = createWsMockWs() as unknown as HotdogServerSocket;
    const ws2 = createWsMockWs() as unknown as HotdogServerSocket;
    registry.registerConnection(ws1);
    registry.registerConnection(ws2);

    registry.broadcast({ type: "test", data: "hello" });

    expect((ws1 as MockWs).messages).toContain(JSON.stringify({ type: "test", data: "hello" }));
    expect((ws2 as MockWs).messages).toContain(JSON.stringify({ type: "test", data: "hello" }));
  });
});

// ── createWsServer Tests ────────────────────────────────────────────────────

describe("createWsServer", () => {
  let wsServer: ReturnType<typeof createWsServer>;

  afterEach(() => {
    wsServer.stopCleanupLoop();
  });

  it("handles CREATE_SESSION message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    await new Promise((r) => setTimeout(r, 10));

    // Send create session message
    wsServer.onMessage(ws, JSON.stringify({ type: "createSession", profile: "test-profile", model: "custom-model" }));

    await new Promise((r) => setTimeout(r, 10));

    // Check sessionCreated response
    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    expect(lastMsg.type).toBe("sessionCreated");
    expect(typeof lastMsg.sessionId).toBe("string");
  });

  it("handles DELETE_SESSION message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    // Wait for session to be created
    await new Promise((r) => setTimeout(r, 10));
    const sessionId = (ws as HotdogServerSocket).activeSessionId!;

    wsServer.onMessage(ws, JSON.stringify({ type: "deleteSession", sessionId }));

    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    expect(lastMsg.type).toBe("sessionDeleted");
    expect(lastMsg.sessionId).toBe(sessionId);
  });

  it("handles LIST_SESSIONS message", () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: "listSessions" }));

    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    expect(lastMsg.type).toBe("sessions");
    expect(Array.isArray(lastMsg.sessions)).toBe(true);
  });

  it("handles SEND message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    await new Promise((r) => setTimeout(r, 10));
    const sessionId = (ws as HotdogServerSocket).activeSessionId!;

    wsServer.onMessage(ws, JSON.stringify({ type: "send", sessionId, content: "Hello!" }));

    // Should not error and should touch the session
    const meta = wsServer.sessionRegistry._test_metadata.get(sessionId!);
    expect(meta).toBeDefined();
    expect(meta!.lastActivityAt).toBeGreaterThan(0);
  });

  it("handles CANCEL message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    await new Promise((r) => setTimeout(r, 10));
    const sessionId = (ws as HotdogServerSocket).activeSessionId!;

    wsServer.onMessage(ws, JSON.stringify({ type: "cancel", sessionId }));

    // Should not error
    expect(true).toBe(true);
  });

  it("handles COMMAND message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    await new Promise((r) => setTimeout(r, 10));
    const sessionId = (ws as HotdogServerSocket).activeSessionId!;

    // Test with leading slash
    wsServer.onMessage(ws, JSON.stringify({ type: "command", sessionId, command: "/help" }));

    const meta = wsServer.sessionRegistry._test_metadata.get(sessionId!);
    expect(meta).toBeDefined();
    expect(meta!.lastActivityAt).toBeGreaterThan(0);
  });

  it("handles QUESTION_ANSWER message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    await new Promise((r) => setTimeout(r, 10));
    const sessionId = (ws as HotdogServerSocket).activeSessionId!;

    wsServer.onMessage(ws, JSON.stringify({
      type: "questionAnswer",
      sessionId,
      answers: { q1: "answer1" },
    }));

    // Should not error
    expect(true).toBe(true);
  });

  it("handles unknown message type", () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: "unknownType" }));

    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    expect(lastMsg.type).toBe("error");
    expect(lastMsg.message).toContain("Unknown message type");
  });

  it("handles invalid JSON", () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, "not valid json");

    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    expect(lastMsg.type).toBe("error");
    expect(lastMsg.message).toBe("Invalid JSON");
  });

  it("handles message without type", () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ data: "hello" }));

    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    expect(lastMsg.type).toBe("error");
    expect(lastMsg.message).toBe("Message type required");
  });

  it("closes connection on close handler and removes channel", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    await new Promise((r) => setTimeout(r, 10));
    const sessionId = (ws as HotdogServerSocket).activeSessionId!;

    // Verify session exists with connected client
    const meta = wsServer.sessionRegistry._test_metadata.get(sessionId!);
    expect(meta!.connectedClients).toBeGreaterThan(0);

    // Close the connection
    wsServer.onClose(ws);

    // Verify client count decreased
    const metaAfter = wsServer.sessionRegistry._test_metadata.get(sessionId!);
    expect(metaAfter!.connectedClients).toBe(0);
  });

  it("handles RENAME_SESSION message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    await new Promise((r) => setTimeout(r, 10));
    const sessionId = (ws as HotdogServerSocket).activeSessionId!;

    wsServer.onMessage(ws, JSON.stringify({ type: "renameSession", sessionId, newName: "renamed" }));

    const meta = wsServer.sessionRegistry._test_metadata.get(sessionId!);
    expect(meta!.profile).toBe("renamed");
  });

  it("handles SWITCH_SESSION message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    await new Promise((r) => setTimeout(r, 10));
    const firstSessionId = (ws as HotdogServerSocket).activeSessionId!;

    // Create a second session
    wsServer.onMessage(ws, JSON.stringify({ type: "createSession" }));
    await new Promise((r) => setTimeout(r, 10));

    const sessions = wsServer.sessionRegistry.list();
    const secondSessionId = sessions.find((s) => s.id !== firstSessionId)?.id;

    if (secondSessionId) {
      wsServer.onMessage(ws, JSON.stringify({ type: "switchSession", sessionId: secondSessionId }));

      const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
      expect(lastMsg.type).toBe("sessionState");
      expect(lastMsg.sessionId).toBe(secondSessionId);
    }
  });
});

describe("createWsServer - additional coverage", () => {
  let wsServer: ReturnType<typeof createWsServer>;

  afterEach(() => {
    wsServer.stopCleanupLoop();
  });

  it("attaches to most recent session when multiple exist", async () => {
    const core = createWsMockCore();
    const mockAgentFactory = createWsMockAgentFactory();
    wsServer = createWsServer(core, { buildAgent: mockAgentFactory });

    // Create first session
    const ws1 = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws1);
    await new Promise((r) => setTimeout(r, 10));
    const firstSessionId = (ws1 as HotdogServerSocket).activeSessionId!;

    // Wait and create second session
    await new Promise((r) => setTimeout(r, 50));
    wsServer.onMessage(ws1, JSON.stringify({ type: "createSession" }));
    await new Promise((r) => setTimeout(r, 10));

    const sessions = wsServer.sessionRegistry.list();
    expect(sessions).toHaveLength(2);

    // Close first connection and create new one - should attach to most recent
    wsServer.onClose(ws1);

    const ws2 = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws2);
    await new Promise((r) => setTimeout(r, 10));

    const newActiveSessionId = (ws2 as HotdogServerSocket).activeSessionId!;
    // Should be attached to the second (most recent) session
    expect(newActiveSessionId).not.toBe(firstSessionId);
  });

  it("handles LIST_LOGS message without error", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await new Promise((r) => setTimeout(r, 20));

    // Should not throw
    wsServer.onMessage(ws, JSON.stringify({ type: "listLogs" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(true).toBe(true);
  });

  it("handles VIEW_LOG message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await new Promise((r) => setTimeout(r, 10));

    wsServer.onMessage(ws, JSON.stringify({ type: "viewLog", logId: "test-log-id" }));
    await new Promise((r) => setTimeout(r, 10));

    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    // Either logViewed or error if log doesn't exist
    expect(["logViewed", "error"].includes(lastMsg.type)).toBe(true);
  });

  it("handles DELETE_LOG message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await new Promise((r) => setTimeout(r, 10));

    wsServer.onMessage(ws, JSON.stringify({ type: "deleteLog", logId: "test-log-id" }));
    await new Promise((r) => setTimeout(r, 10));

    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    // Either logDeleted or error if log doesn't exist
    expect(["logDeleted", "error"].includes(lastMsg.type)).toBe(true);
  });

  it("handles AUTH message with valid token", async () => {
    const core = createWsMockCore();
    const mockAuth = {
      validateToken: (token: string) => token === "valid-token",
    };
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      auth: mockAuth as never,
    });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws?token=valid-token", headers: { host: "localhost" } }, ws);
    await new Promise((r) => setTimeout(r, 10));

    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    expect(lastMsg.type).toBe("sessionCreated");
  });

  it("sends authRequired when auth is configured but no token", () => {
    const core = createWsMockCore();
    const mockAuth = {
      validateToken: (token: string) => token === "valid-token",
    };
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      auth: mockAuth as never,
    });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    const firstMsg = JSON.parse((ws as MockWs).messages[0]!);
    expect(firstMsg.type).toBe("authRequired");
  });

  it("closes connection on invalid token at upgrade", () => {
    const core = createWsMockCore();
    const mockAuth = {
      validateToken: (token: string) => token === "valid-token",
    };
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      auth: mockAuth as never,
    });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws?token=invalid-token", headers: { host: "localhost" } }, ws);

    const firstMsg = JSON.parse((ws as MockWs).messages[0]!);
    expect(firstMsg.type).toBe("authError");
  });

  it("handles AUTH message in routeMessage with valid token", async () => {
    const core = createWsMockCore();
    const mockAuth = {
      validateToken: (token: string) => token === "valid-token",
    };
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      auth: mockAuth as never,
    });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    // Connect without token - gets authRequired, no session created
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    // Send auth message - should authenticate and create session
    wsServer.onMessage(ws, JSON.stringify({ type: "auth", token: "valid-token" }));
    await new Promise((r) => setTimeout(r, 50));

    // Check that authOk was sent
    const allTypes = (ws as MockWs).messages
      .filter((m) => m && m !== "undefined")
      .map((m) => {
        try { return JSON.parse(m).type; } catch { return null; }
      })
      .filter(Boolean);
    expect(allTypes).toContain("authOk");
  });

  it("handles AUTH message with invalid token", async () => {
    const core = createWsMockCore();
    const mockAuth = {
      validateToken: (token: string) => token === "valid-token",
    };
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      auth: mockAuth as never,
    });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: "auth", token: "invalid-token" }));
    await new Promise((r) => setTimeout(r, 20));

    const allTypes = (ws as MockWs).messages
      .filter((m) => m && m !== "undefined")
      .map((m) => {
        try { return JSON.parse(m).type; } catch { return null; }
      })
      .filter(Boolean);
    expect(allTypes).toContain("authError");
  });

  it("rejects non-AUTH messages when auth is enabled and no token is validated (auth gate)", async () => {
    const core = createWsMockCore();
    const mockAuth = {
      validateToken: (token: string) => token === "valid-token",
    };
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      auth: mockAuth as never,
    });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    // Connect without token -- socket stays open awaiting protocol AUTH.
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    // Non-AUTH message before auth must be gated, not routed.
    wsServer.onMessage(ws, JSON.stringify({ type: "listSessions" }));
    await new Promise((r) => setTimeout(r, 20));

    const types = (ws as MockWs).messages
      .filter((m) => m && m !== "undefined")
      .map((m) => {
        try { return JSON.parse(m).type; } catch { return null; }
      })
      .filter(Boolean);
    expect(types).toContain("authError");
    expect(types).not.toContain("sessions");
    expect(types).not.toContain("sessionCreated");
  });

  it("allows messages after successful protocol AUTH", async () => {
    const core = createWsMockCore();
    const mockAuth = {
      validateToken: (token: string) => token === "valid-token",
    };
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      auth: mockAuth as never,
    });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: "auth", token: "valid-token" }));
    await new Promise((r) => setTimeout(r, 50));

    wsServer.onMessage(ws, JSON.stringify({ type: "listSessions" }));
    await new Promise((r) => setTimeout(r, 20));

    const types = (ws as MockWs).messages
      .filter((m) => m && m !== "undefined")
      .map((m) => {
        try { return JSON.parse(m).type; } catch { return null; }
      })
      .filter(Boolean);
    expect(types).toContain("authOk");
    expect(types).toContain("sessions");
  });

  it("keeps gating non-AUTH messages after a failed protocol AUTH", async () => {
    const core = createWsMockCore();
    const mockAuth = {
      validateToken: (token: string) => token === "valid-token",
    };
    wsServer = createWsServer(core, {
      buildAgent: createWsMockAgentFactory(),
      auth: mockAuth as never,
    });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);

    wsServer.onMessage(ws, JSON.stringify({ type: "auth", token: "bad-token" }));
    await new Promise((r) => setTimeout(r, 20));

    wsServer.onMessage(ws, JSON.stringify({ type: "createSession" }));
    await new Promise((r) => setTimeout(r, 20));

    const types = (ws as MockWs).messages
      .filter((m) => m && m !== "undefined")
      .map((m) => {
        try { return JSON.parse(m).type; } catch { return null; }
      })
      .filter(Boolean);
    // authError from the failed AUTH, then authError from the gate.
    expect(types.filter((t) => t === "authError").length).toBeGreaterThanOrEqual(2);
    expect(types).not.toContain("sessionCreated");
  });

  it("createAndAttachSession handles error", async () => {
    const core = createWsMockCore();
    const failingBuildAgent = async () => {
      throw new Error("Build agent failed");
    };
    wsServer = createWsServer(core, { buildAgent: failingBuildAgent });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await new Promise((r) => setTimeout(r, 50));

    const errorMsg = (ws as MockWs).messages.find((m) => {
      try {
        const parsed = JSON.parse(m);
        return parsed.type === "error" && parsed.message?.includes("Build agent failed");
      } catch {
        return false;
      }
    });
    expect(errorMsg).toBeDefined();
  });

  it("handles LOAD_LOG message", async () => {
    const core = createWsMockCore();
    wsServer = createWsServer(core, { buildAgent: createWsMockAgentFactory() });

    const ws = createWsMockWs() as unknown as HotdogServerSocket;
    wsServer.onUpgrade({ url: "/ws", headers: { host: "localhost" } }, ws);
    await new Promise((r) => setTimeout(r, 10));

    wsServer.onMessage(ws, JSON.stringify({ type: "loadLog", logId: "test-log-id" }));
    await new Promise((r) => setTimeout(r, 10));

    const lastMsg = JSON.parse((ws as MockWs).messages[(ws as MockWs).messages.length - 1]!);
    // Either sessionCreated (if log loaded) or error if log doesn't exist
    expect(["sessionCreated", "error"].includes(lastMsg.type)).toBe(true);
  });
});
