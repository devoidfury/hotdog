// Tests for websocket/server.ts — SessionRegistry and createWsServer.

import { describe, it, expect, beforeEach, afterEach, mock } from "bun:test";
import { SessionRegistry, createWsServer } from "../../src/extensions/websocket/server.ts";
import { WebSocketChannel } from "../../src/extensions/websocket/websocket-channel.ts";
import { OUTPUT_EVENT } from "../../src/core/context/output.ts";
import { C2S, S2C } from "../../src/extensions/websocket/protocol.ts";

// ── SessionRegistry Tests ───────────────────────────────────────────────────

describe("SessionRegistry", () => {
  let registry: SessionRegistry;
  let mockAgent: any;

  beforeEach(() => {
    mockAgent = {
      sessionId: "test-session",
      model: "test-model",
      profileName: "default",
      modelRegistry: { "test-model": {} },
      log: [],
      sink: null,
      cancel: mock(() => {}),
      resetCancel: mock(() => {}),
      run: mock(async () => {}),
      executeCommand: mock(async () => ({})),
      serialize: () => ({}),
      deserialize: () => {},
    };

    registry = new SessionRegistry({
      buildAgent: async (config: { model?: string; sessionId?: string }) => {
        // Use the passed sessionId so the agent can be found by it
        return { ...mockAgent, sessionId: config.sessionId || "test-session" };
      },
      questionTimeoutSecs: 300,
      questionStrategy: "wait",
      sessionTimeoutMin: 30,
    });
  });

  afterEach(() => {
    registry.stopCleanupLoop();
  });

  describe("create", () => {
    it("creates a new session with unique ID", async () => {
      const result = await registry.create({ profile: "test", model: "gpt-4" });
      expect(result.sessionId).toBeDefined();
      expect(typeof result.sessionId).toBe("string");
      expect(result.agent).toHaveProperty("model", "test-model");
    });

    it("creates a session with default options", async () => {
      const result = await registry.create();
      expect(result.sessionId).toBeDefined();
    });

    it("tracks session size", async () => {
      expect(registry.size).toBe(0);
      await registry.create();
      expect(registry.size).toBe(1);
      await registry.create();
      expect(registry.size).toBe(2);
    });
  });

  describe("get", () => {
    it("returns null for non-existent session", () => {
      expect(registry.get("non-existent")).toBeNull();
    });

    it("returns session by ID", async () => {
      const result = await registry.create();
      const session = registry.get(result.sessionId);
      expect(session).not.toBeNull();
      expect(session!.agent).toHaveProperty("model", "test-model");
    });
  });

  describe("list", () => {
    it("returns empty array when no sessions", () => {
      expect(registry.list()).toEqual([]);
    });

    it("returns session metadata", async () => {
      await registry.create({ profile: "test" });
      await registry.create({ profile: "other" });

      const sessions = registry.list();
      expect(sessions).toHaveLength(2);
      expect(sessions[0]).toHaveProperty("id");
      expect(sessions[0]).toHaveProperty("profile");
      expect(sessions[0]).toHaveProperty("model");
      expect(sessions[0]).toHaveProperty("createdAt");
      expect(sessions[0]).toHaveProperty("lastActivityAt");
      expect(sessions[0]).toHaveProperty("connectedClients");
    });

    it("returns correct connectedClients count", async () => {
      const result = await registry.create();
      const sessions = registry.list();
      expect(sessions[0]!.connectedClients).toBe(0);
    });
  });

  describe("delete", () => {
    it("deletes existing session", async () => {
      const result = await registry.create();
      const deleted = registry.delete(result.sessionId);
      expect(deleted).toBe(true);
      expect(registry.size).toBe(0);
    });

    it("returns false for non-existent session", () => {
      const deleted = registry.delete("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("createChannel", () => {
    function createMockWs() {
      const messages: string[] = [];
      return {
        readyState: 1,
        send: (data: string) => { messages.push(data); },
        messages,
      } as unknown as WebSocket;
    }

    it("returns undefined for non-existent session", () => {
      const ws = createMockWs() as unknown as WebSocket;
      const channel = registry.createChannel("non-existent", ws);
      expect(channel).toBeUndefined();
    });

    it("creates WebSocketChannel for session", async () => {
      const result = await registry.create();
      const ws = createMockWs() as unknown as WebSocket;
      const channel = registry.createChannel(result.sessionId, ws);
      expect(channel).toBeDefined();
      expect(channel).toBeInstanceOf(WebSocketChannel);
    });

    it("increments connectedClients count", async () => {
      const result = await registry.create();
      const ws = createMockWs() as unknown as WebSocket;
      registry.createChannel(result.sessionId, ws);
      const session = registry.get(result.sessionId)!;
      expect(session.metadata.connectedClients).toBe(1);
    });

    it("updates lastActivityAt", async () => {
      const result = await registry.create();
      const session = registry.get(result.sessionId)!;
      const before = session.metadata.lastActivityAt;
      await new Promise((r) => setTimeout(r, 10));
      const ws = createMockWs() as unknown as WebSocket;
      registry.createChannel(result.sessionId, ws);
      expect(session.metadata.lastActivityAt).toBeGreaterThan(before);
    });
  });

  describe("removeChannel", () => {
    function createMockWs() {
      const messages: string[] = [];
      return {
        readyState: 1,
        send: (data: string) => { messages.push(data); },
        messages,
      } as unknown as WebSocket;
    }

    it("decrements connectedClients count", async () => {
      const result = await registry.create();
      const ws = createMockWs() as unknown as WebSocket;
      const channel = registry.createChannel(result.sessionId, ws)!;
      registry.removeChannel(result.sessionId, channel);
      const session = registry.get(result.sessionId)!;
      expect(session.metadata.connectedClients).toBe(0);
    });

    it("does not decrement below zero", async () => {
      const result = await registry.create();
      const ws = createMockWs() as unknown as WebSocket;
      const channel = registry.createChannel(result.sessionId, ws)!;
      registry.removeChannel(result.sessionId, channel);
      registry.removeChannel(result.sessionId, channel);
      const session = registry.get(result.sessionId)!;
      expect(session.metadata.connectedClients).toBe(0);
    });
  });

  describe("touch", () => {
    it("updates lastActivityAt for existing session", async () => {
      const result = await registry.create();
      const session = registry.get(result.sessionId)!;
      const before = session.metadata.lastActivityAt;
      await new Promise((r) => setTimeout(r, 10));
      registry.touch(result.sessionId);
      expect(session.metadata.lastActivityAt).toBeGreaterThan(before);
    });

    it("does nothing for non-existent session", () => {
      registry.touch("non-existent");
    });
  });

  describe("cleanup", () => {
    it("startCleanupLoop starts interval", () => {
      registry.startCleanupLoop(30);
      registry.startCleanupLoop(30);
    });

    it("stopCleanupLoop stops interval", () => {
      registry.startCleanupLoop(30);
      registry.stopCleanupLoop();
      registry.stopCleanupLoop();
    });

    it("delete removes session from registry", async () => {
      const result = await registry.create();
      expect(registry.size).toBe(1);
      registry.delete(result.sessionId);
      expect(registry.size).toBe(0);
    });
  });
});

// ── createWsServer Tests ────────────────────────────────────────────────────

describe("createWsServer", () => {
  function createMockCore() {
    return {
      hooks: {
        notifyHooks: () => {},
        notifyHooksAsync: async () => {},
      },
      config: {},
      resolved: {
        baseUrl: "http://localhost:8000",
        apiKey: "test-key",
        model: "test-model",
        stream: true,
        chatTimeout: 30,
        maxRetries: 3,
        maxIterations: 100,
        contextLimit: 128000,
        hideTools: false,
        hideThinking: true,
        showTokenUse: true,
        profileName: "default",
        modelRegistry: { "test-model": {} },
      },
      toolRegistry: {
        getAll: () => [],
        get: () => null,
        register: () => {},
      },
      extensions: {
        cleanup: async () => {},
      },
    } as any;
  }

  function createMockAgentFactory(): (config: { model?: string; sessionId?: string }) => Promise<any> {
    return async (config: { model?: string; sessionId?: string }) => {
      return {
        sessionId: config.sessionId || "test",
        model: "test-model",
        profileName: "default",
        modelRegistry: { "test-model": {} },
        log: [],
        sink: null,
        cancel: () => {},
        resetCancel: () => {},
        run: async () => {},
        executeCommand: async () => ({}),
        serialize: () => ({}),
        deserialize: () => {},
      };
    };
  }

  function createMockWs() {
    const messages: string[] = [];
    return {
      readyState: 1,
      send: (data: string) => { messages.push(data); },
      messages,
      close: mock(() => {}),
    } as unknown as WebSocket & { messages: string[] };
  }

  describe("onMessage", () => {
    it("sends error for invalid JSON", () => {
      const core = createMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: createMockAgentFactory(),
      });

      const ws = createMockWs();
      wsServer.onMessage(ws, "not valid json");

      const msg = JSON.parse((ws as any).messages[0]);
      expect(msg.type).toBe("error");
      expect(msg.message).toBe("Invalid JSON");
    });

    it("sends error for missing type", () => {
      const core = createMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: createMockAgentFactory(),
      });

      const ws = createMockWs();
      wsServer.onMessage(ws, JSON.stringify({ foo: "bar" }));

      const msg = JSON.parse((ws as any).messages[0]);
      expect(msg.type).toBe("error");
      expect(msg.message).toBe("Message type required");
    });

    it("sends error for unknown message type", () => {
      const core = createMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: createMockAgentFactory(),
      });

      const ws = createMockWs();
      wsServer.onMessage(ws, JSON.stringify({ type: "unknown_type" }));

      const msg = JSON.parse((ws as any).messages[0]);
      expect(msg.type).toBe("error");
      expect(msg.message).toContain("Unknown message type");
    });
  });

  describe("onUpgrade with auth", () => {
    it("sends authRequired when no token and auth is enabled", () => {
      const core = createMockCore();
      const authMiddleware = {
        validateToken: () => true,
        startCleanup: () => {},
        stopCleanup: () => {},
        loginHandler: async () => new Response("ok"),
        cleanup: () => {},
      };

      const wsServer = createWsServer(core, {
        buildAgent: createMockAgentFactory(),
        auth: authMiddleware,
      });

      const ws = createMockWs();
      wsServer.onUpgrade({ url: "http://localhost/ws" }, ws);

      const msg = JSON.parse((ws as any).messages[0]);
      expect(msg.type).toBe("authRequired");
    });

    it("rejects invalid token on upgrade", () => {
      const core = createMockCore();
      const authMiddleware = {
        validateToken: () => false,
        startCleanup: () => {},
        stopCleanup: () => {},
        loginHandler: async () => new Response("ok"),
        cleanup: () => {},
      };

      const wsServer = createWsServer(core, {
        buildAgent: createMockAgentFactory(),
        auth: authMiddleware,
      });

      const ws = createMockWs();
      wsServer.onUpgrade({ url: "http://localhost/ws?token=invalid" }, ws);

      const msg = JSON.parse((ws as any).messages[0]);
      expect(msg.type).toBe("authError");
    });
  });

  describe("onClose", () => {
    it("removes channel from session", () => {
      const core = createMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: createMockAgentFactory(),
      });

      const ws = createMockWs();
      const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
      typedWs.activeSessionId = "test-session";
      // onClose should not throw even with a mock channel
      wsServer.onClose(ws);
    });

    it("does nothing when no active session", () => {
      const core = createMockCore();
      const wsServer = createWsServer(core);

      const ws = createMockWs();
      wsServer.onClose(ws);
    });
  });

  describe("session management messages", () => {
    let core: any;
    let wsServer: ReturnType<typeof createWsServer>;
    let sessionId: string;

    beforeEach(async () => {
      core = createMockCore();
      wsServer = createWsServer(core, {
        buildAgent: createMockAgentFactory(),
      });

      // Create a session directly via the registry
      const result = await wsServer.sessionRegistry.create({});
      sessionId = result.sessionId;
    });

    it("handles LIST_SESSIONS message", () => {
      const ws = createMockWs();
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.LIST_SESSIONS }));

      const msg = JSON.parse((ws as any).messages[0]);
      expect(msg.type).toBe("sessions");
      expect(msg.sessions).toBeDefined();
      expect(Array.isArray(msg.sessions)).toBe(true);
      expect(msg.sessions.length).toBe(1);
    });

    it("handles CREATE_SESSION message", async () => {
      const ws = createMockWs();
      wsServer.onMessage(ws, JSON.stringify({
        type: C2S.CREATE_SESSION,
        profile: "test-profile",
        model: "gpt-4",
      }));

      await new Promise((r) => setTimeout(r, 100));

      const msg = JSON.parse((ws as any).messages[0]);
      expect(msg.type).toBe("sessionCreated");
      expect(msg.sessionId).toBeDefined();
    });

    it("handles DELETE_SESSION message", () => {
      const ws = createMockWs();
      expect(wsServer.sessionRegistry.get(sessionId)).not.toBeNull();

      wsServer.onMessage(ws, JSON.stringify({
        type: C2S.DELETE_SESSION,
        sessionId,
      }));

      // Verify the session was deleted
      expect(wsServer.sessionRegistry.get(sessionId)).toBeNull();
    });

    it("handles CANCEL message", () => {
      const ws = createMockWs();
      wsServer.onMessage(ws, JSON.stringify({
        type: C2S.CANCEL,
        sessionId,
      }));

      // Should not throw
      expect(true).toBe(true);
    });

    it("handles COMMAND message", () => {
      const ws = createMockWs();
      wsServer.onMessage(ws, JSON.stringify({
        type: C2S.COMMAND,
        sessionId,
        command: "/model",
      }));

      // Should not throw
      expect(true).toBe(true);
    });

    it("handles SEND message", () => {
      const ws = createMockWs();
      wsServer.onMessage(ws, JSON.stringify({
        type: C2S.SEND,
        sessionId,
        content: "Hello, world!",
      }));

      // Should not throw
      expect(true).toBe(true);
    });
  });

  describe("cleanup loops", () => {
    it("startCleanupLoop starts the registry cleanup", () => {
      const core = createMockCore();
      const wsServer = createWsServer(core);
      wsServer.startCleanupLoop();
    });

    it("stopCleanupLoop stops the registry cleanup", () => {
      const core = createMockCore();
      const wsServer = createWsServer(core);
      wsServer.startCleanupLoop();
      wsServer.stopCleanupLoop();
    });
  });

  describe("sessionRegistry access", () => {
    it("exposes sessionRegistry", () => {
      const core = createMockCore();
      const wsServer = createWsServer(core);
      expect(wsServer.sessionRegistry).toBeDefined();
      expect(wsServer.sessionRegistry).toBeInstanceOf(SessionRegistry);
    });
  });
});
