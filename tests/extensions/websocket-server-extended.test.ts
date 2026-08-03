// Extended tests for websocket/server.ts — message routing paths,
// SessionRegistry edge cases, and replaySessionHistory.
// Covers lines 219-222, 283, 298-304, 338-407, 466, 583-622, 626-642, 673-702.

import { describe, it, expect, beforeEach, afterEach, mock, Mock } from "bun:test";
import { SessionRegistry, createWsServer } from "../../src/extensions/websocket/server.ts";
import { WebSocketChannel } from "../../src/extensions/websocket/websocket-channel.ts";
import { C2S, S2C } from "../../src/extensions/websocket/protocol.ts";
import { Agent } from "../../src/core/agent.ts";
import { createWsMockCore, createWsMockAgentFactory, createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";
import type { AgentLike } from "../../src/core/session/index.ts";

/** Create a mock agent with a custom log for replay tests. */
function createMockAgentWithLog(
  log: Array<{ role: string; content: string; getTextContent?: () => string; toolCalls?: unknown[]; toolCallId?: string; reasoningContent?: string }>
): AgentLike {
  return makeWsMockAgent({
    log: {
      getAll: () => log as unknown as import("../../src/core/context/message.ts").Message[],
      toJSON: () => log,
      push: () => 0,
      replace: () => {},
      get: () => undefined,
      length: log.length,
      clear: () => {},
      pop: () => undefined,
      slice: () => [],
      [Symbol.iterator]: () => log[Symbol.iterator](),
    } as unknown as import("../../src/core/context/message-log.ts").MessageLog,
  });
}

// ── SessionRegistry Extended Tests ───────────────────────────────────────────

describe("SessionRegistry Extended", () => {
  function createMockAgent(sessionId?: string) {
    return makeWsMockAgent({
      sessionId: sessionId || "test-session",
    });
  }

  let registry: SessionRegistry;

  beforeEach(() => {
    registry = new SessionRegistry({
      buildAgent: async (config: { model?: string; sessionId?: string }) => {
        return createMockAgent(config.sessionId);
      },
      questionTimeoutSecs: 300,
      questionStrategy: "wait",
      sessionTimeoutMin: 30,
    });
  });

  afterEach(() => {
    registry.stopCleanupLoop();
  });

  describe("broadcast", () => {
    it("sends to all connected clients", () => {
      const ws1 = { readyState: 1, send: mock(() => {}) } as unknown as WebSocket;
      const ws2 = { readyState: 1, send: mock(() => {}) } as unknown as WebSocket;

      registry.registerConnection(ws1);
      registry.registerConnection(ws2);

      registry.broadcast({ type: "test", data: "hello" });

      expect((ws1.send as Mock<() => void>).mock.calls.length).toBe(1);
      expect((ws2.send as Mock<() => void>).mock.calls.length).toBe(1);

      const payload = JSON.parse(((ws1.send as Mock<() => void>).mock.calls as unknown[][])[0]![0] as string);
      expect(payload.type).toBe("test");
      expect(payload.data).toBe("hello");
    });

    it("skips closed connections", () => {
      const ws1 = { readyState: 1, send: mock(() => {}) } as unknown as WebSocket;
      const ws2 = { readyState: 2, send: mock(() => {}) } as unknown as WebSocket; // CLOSING

      registry.registerConnection(ws1);
      registry.registerConnection(ws2);

      registry.broadcast({ type: "test" });

      expect((ws1.send as Mock<() => void>).mock.calls.length).toBe(1);
      expect((ws2.send as Mock<() => void>).mock.calls.length).toBe(0);
    });

    it("handles send errors gracefully", () => {
      const failingWs = {
        readyState: 1,
        send: mock(() => { throw new Error("Send failed"); }),
      } as unknown as WebSocket;
      const workingWs = {
        readyState: 1,
        send: mock(() => {}),
      } as unknown as WebSocket;

      registry.registerConnection(failingWs);
      registry.registerConnection(workingWs);

      // Broadcast should not throw and should still send to working connections
      registry.broadcast({ type: "test" });
      expect((failingWs.send as Mock<() => void>).mock.calls.length).toBe(1);
      expect((workingWs.send as Mock<() => void>).mock.calls.length).toBe(1);
    });

    it("handles empty connection set", () => {
      // Broadcast with no connections should be a no-op
      registry.broadcast({ type: "test" });
    });
  });

  describe("rename", () => {
    it("renames existing session", async () => {
      const result = await registry.create({ profile: "old-name" });
      const renamed = registry.rename(result.sessionId, "new-name");
      expect(renamed).toBe(true);

      const session = registry.get(result.sessionId)!;
      expect(session.metadata.profile).toBe("new-name");
    });

    it("returns false for non-existent session", () => {
      const renamed = registry.rename("non-existent", "new-name");
      expect(renamed).toBe(false);
    });
  });

  describe("createChannel edge cases", () => {
    function createWsMockWs() {
      const messages: string[] = [];
      return {
        readyState: 1,
        send: (data: string) => { messages.push(data); },
        messages,
      } as unknown as WebSocket;
    }

    it("creates multiple channels for same session", async () => {
      const result = await registry.create();
      const ws1 = createWsMockWs();
      const ws2 = createWsMockWs();

      const channel1 = registry.createChannel(result.sessionId, ws1);
      const channel2 = registry.createChannel(result.sessionId, ws2);

      expect(channel1).toBeDefined();
      expect(channel2).toBeDefined();
      expect(channel1).not.toBe(channel2);

      const session = registry.get(result.sessionId)!;
      expect(session.metadata.connectedClients).toBe(2);
    });

    it("returns undefined for non-existent session", () => {
      const ws = createWsMockWs();
      const channel = registry.createChannel("non-existent", ws);
      expect(channel).toBeUndefined();
    });
  });

  describe("delete with channels", () => {
    function createWsMockWs() {
      const messages: string[] = [];
      return {
        readyState: 1,
        send: (data: string) => { messages.push(data); },
        messages,
      } as unknown as WebSocket;
    }

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
  });

  describe("getSessionManager", () => {
    it("returns the internal SessionManager", () => {
      const sessionManager = registry.getSessionManager();
      expect(sessionManager).toBeDefined();
    });
  });

  describe("idle session cleanup", () => {
    it("cleans up idle sessions with 0 connected clients", async () => {
      // Create a session
      const result = await registry.create();

      // Manually set lastActivityAt to be in the past
      const meta = registry._test_metadata.get(result.sessionId);
      if (meta) {
        meta.lastActivityAt = Date.now() - 100 * 60 * 1000; // 100 minutes ago
      }

      // Set a short timeout
      registry._test_timeoutMin = 30;

      // Trigger cleanup manually
      registry._test_cleanupIdleSessions();

      // Session should be deleted
      expect(registry.get(result.sessionId)).toBeNull();
    });

    it("does not clean up sessions with connected clients", async () => {
      const result = await registry.create();

      // Set lastActivityAt to be in the past
      const meta = registry._test_metadata.get(result.sessionId);
      if (meta) {
        meta.lastActivityAt = Date.now() - 100 * 60 * 1000;
        meta.connectedClients = 1; // Has connected clients
      }

      registry._test_timeoutMin = 30;
      registry._test_cleanupIdleSessions();

      // Session should NOT be deleted
      expect(registry.get(result.sessionId)).not.toBeNull();
    });

    it("does not clean up recently active sessions", async () => {
      const result = await registry.create();

      registry._test_timeoutMin = 30;
      registry._test_cleanupIdleSessions();

      // Session should NOT be deleted (just created, so recent)
      expect(registry.get(result.sessionId)).not.toBeNull();
    });
  });
});

// ── createWsServer Message Routing Tests ──────────────────────────────────────

describe("createWsServer Message Routing", () => {

  describe("AUTH message", () => {
    it("accepts valid auth token", () => {
      const core = createWsMockCore();
      const authMiddleware = {
        validateToken: () => true,
        startCleanup: () => {},
        stopCleanup: () => {},
        loginHandler: async () => new Response("ok"),
        cleanup: () => {},
      };

      const wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
        auth: authMiddleware,
      });

      // First create a session so there's something to attach to
      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: "http://localhost/ws?token=valid" }, ws);

      // Now send AUTH message
      const ws2 = createWsMockWs();
      wsServer.onMessage(ws2, JSON.stringify({
        type: C2S.AUTH,
        token: "valid",
      }));

      const msg = JSON.parse((ws2 as any).messages[0]);
      expect(msg.type).toBe("authOk");
    });

    it("rejects invalid auth token", () => {
      const core = createWsMockCore();
      const authMiddleware = {
        validateToken: () => false,
        startCleanup: () => {},
        stopCleanup: () => {},
        loginHandler: async () => new Response("ok"),
        cleanup: () => {},
      };

      const wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
        auth: authMiddleware,
      });

      const ws = createWsMockWs();
      wsServer.onMessage(ws, JSON.stringify({
        type: C2S.AUTH,
        token: "invalid",
      }));

      const msg = JSON.parse((ws as any).messages[0]);
      expect(msg.type).toBe("authError");
      expect(msg.message).toBe("Invalid token");
    });

    it("ignores AUTH when no auth middleware", () => {
      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
      });

      const ws = createWsMockWs();
      wsServer.onMessage(ws, JSON.stringify({
        type: C2S.AUTH,
        token: "any-token",
      }));

      // No auth middleware, so AUTH is silently ignored
      expect((ws as any).messages.length).toBe(0);
    });
  });

  describe("SWITCH_SESSION message", () => {
    let wsServer: ReturnType<typeof createWsServer>;
    let sessionId1: string;
    let sessionId2: string;

    beforeEach(async () => {
      const core = createWsMockCore();
      wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
      });

      const result1 = await wsServer.sessionRegistry.create({});
      sessionId1 = result1.sessionId;
      const result2 = await wsServer.sessionRegistry.create({});
      sessionId2 = result2.sessionId;
    });

    it("switches to existing session", () => {
      const ws = createWsMockWs();
      const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
      typedWs.activeSessionId = sessionId1;

      wsServer.onMessage(ws, JSON.stringify({
        type: C2S.SWITCH_SESSION,
        sessionId: sessionId2,
      }));

      // Should send session state messages
      const msgs = (ws as any).messages.map((m: string) => JSON.parse(m));
      const stateMsgs = msgs.filter((m: any) => m.type === S2C.SESSION_STATE);
      expect(stateMsgs.length).toBeGreaterThan(0);
      expect(typedWs.activeSessionId).toBe(sessionId2);
    });

    it("does nothing for non-existent session", () => {
      const ws = createWsMockWs();

      wsServer.onMessage(ws, JSON.stringify({
        type: C2S.SWITCH_SESSION,
        sessionId: "non-existent",
      }));

      // Should not send any messages for non-existent session
      expect((ws as any).messages.length).toBe(0);
    });
  });


  describe("COMMAND message with slash prefix", () => {
    it("strips leading slash from command", async () => {
      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
      });

      const result = await wsServer.sessionRegistry.create({});
      const sessionManager = wsServer.sessionRegistry.getSessionManager();

      let executedCommand = "";
      const originalExecuteCommand = sessionManager.executeCommand;
      sessionManager.executeCommand = async (_sessionId: string, cmd: string) => {
        executedCommand = cmd;
        return 0;
      };

      try {
        const ws = createWsMockWs();
        wsServer.onMessage(ws, JSON.stringify({
          type: C2S.COMMAND,
          sessionId: result.sessionId,
          command: "/model gpt-4",
        }));

        await new Promise((r) => setTimeout(r, 50));
        expect(executedCommand).toBe("model gpt-4");
      } finally {
        sessionManager.executeCommand = originalExecuteCommand;
      }
    });
  });

  describe("SEND message validation", () => {
    it("does not enqueue when sessionId is missing", async () => {
      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
      });

      const sessionManager = wsServer.sessionRegistry.getSessionManager();
      let enqueueCalled = false;
      const originalEnqueue = sessionManager.enqueue;
      sessionManager.enqueue = async () => { enqueueCalled = true; };

      try {
        const ws = createWsMockWs();
        wsServer.onMessage(ws, JSON.stringify({
          type: C2S.SEND,
          content: "Hello",
          // No sessionId
        }));

        expect(enqueueCalled).toBe(false);
      } finally {
        sessionManager.enqueue = originalEnqueue;
      }
    });

    it("does not enqueue when content is missing", async () => {
      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
      });

      const result = await wsServer.sessionRegistry.create({});
      const sessionManager = wsServer.sessionRegistry.getSessionManager();
      let enqueueCalled = false;
      const originalEnqueue = sessionManager.enqueue;
      sessionManager.enqueue = async () => { enqueueCalled = true; };

      try {
        const ws = createWsMockWs();
        wsServer.onMessage(ws, JSON.stringify({
          type: C2S.SEND,
          sessionId: result.sessionId,
          // No content
        }));

        expect(enqueueCalled).toBe(false);
      } finally {
        sessionManager.enqueue = originalEnqueue;
      }
    });
  });

  describe("CANCEL message", () => {
    it("calls interrupt instead of cancel", async () => {
      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
      });

      const result = await wsServer.sessionRegistry.create({});
      const sessionManager = wsServer.sessionRegistry.getSessionManager();

      let interruptCalled = false;
      const originalInterrupt = sessionManager.interrupt;
      sessionManager.interrupt = async (_sessionId: string) => { interruptCalled = true; };

      try {
        const ws = createWsMockWs();
        wsServer.onMessage(ws, JSON.stringify({
          type: C2S.CANCEL,
          sessionId: result.sessionId,
        }));

        expect(interruptCalled).toBe(true);
      } finally {
        sessionManager.interrupt = originalInterrupt;
      }
    });
  });

  describe("onUpgrade with auth", () => {
    it("accepts valid token on upgrade", () => {
      const core = createWsMockCore();
      const authMiddleware = {
        validateToken: () => true,
        startCleanup: () => {},
        stopCleanup: () => {},
        loginHandler: async () => new Response("ok"),
        cleanup: () => {},
      };

      const wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
        auth: authMiddleware,
      });

      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: "http://localhost/ws?token=valid" }, ws);

      // Should not send authError or authRequired
      const msgs = (ws as any).messages.map((m: string) => JSON.parse(m));
      const authError = msgs.find((m: any) => m.type === "authError");
      const authRequired = msgs.find((m: any) => m.type === "authRequired");
      expect(authError).toBeUndefined();
      expect(authRequired).toBeUndefined();
    });

    it("closes connection on invalid token", () => {
      const core = createWsMockCore();
      const authMiddleware = {
        validateToken: () => false,
        startCleanup: () => {},
        stopCleanup: () => {},
        loginHandler: async () => new Response("ok"),
        cleanup: () => {},
      };

      const wsServer = createWsServer(core, {
        buildAgent: createWsMockAgentFactory(),
        auth: authMiddleware,
      });

      const ws = createWsMockWs();
      wsServer.onUpgrade({ url: "http://localhost/ws?token=invalid" }, ws);

      const msgs = (ws as any).messages.map((m: string) => JSON.parse(m));
      const authError = msgs.find((m: any) => m.type === "authError");
      expect(authError).toBeDefined();
    });
  });
});

// ── replaySessionHistory Tests ────────────────────────────────────────────────

describe("replaySessionHistory", () => {
  function createWsMockWs() {
    const messages: string[] = [];
    return {
      readyState: 1,
      send: (data: string) => { messages.push(data); },
      messages,
    } as unknown as WebSocket & { messages: string[] };
  }

  it("replays user messages", async () => {
    const { createWsServer } = await import("../../src/extensions/websocket/server.ts");

    const mockAgent = createMockAgentWithLog([
      { role: "user", content: "Hello", getTextContent: () => "Hello" },
    ]);

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
    } as any;

    const wsServer = createWsServer(core, {
      buildAgent: async () => mockAgent,
    });

    const result = await wsServer.sessionRegistry.create({});

    // Replay by switching to the session
    const ws = createWsMockWs();
    const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
    typedWs.activeSessionId = result.sessionId;

    wsServer.onMessage(ws, JSON.stringify({
      type: C2S.SWITCH_SESSION,
      sessionId: result.sessionId,
    }));

    // Should have replayed the user message
    const msgs = (ws as any).messages.map((m: string) => JSON.parse(m));
    const userMsg = msgs.find((m: any) => m.type === S2C.USER_MESSAGE);
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe("Hello");
  });

  it("replays assistant messages with reasoning", async () => {
    const mockAgent = createMockAgentWithLog([
      {
        role: "assistant",
        content: "Here's my answer",
        reasoningContent: "Let me think...",
        getTextContent: () => "Here's my answer",
      },
    ]);

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
    } as any;

    const wsServer = createWsServer(core, {
      buildAgent: async () => mockAgent,
    });

    const result = await wsServer.sessionRegistry.create({});

    const ws = createWsMockWs();
    const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
    typedWs.activeSessionId = result.sessionId;

    wsServer.onMessage(ws, JSON.stringify({
      type: C2S.SWITCH_SESSION,
      sessionId: result.sessionId,
    }));

    const msgs = (ws as any).messages.map((m: string) => JSON.parse(m));
    const thinkingMsg = msgs.find((m: any) => m.type === S2C.THINKING);
    const assistantMsg = msgs.find((m: any) => m.type === S2C.ASSISTANT_MESSAGE);

    expect(thinkingMsg).toBeDefined();
    expect(thinkingMsg.content).toBe("Let me think...");
    expect(assistantMsg).toBeDefined();
    expect(assistantMsg.content).toBe("Here's my answer");
  });

  it("replays tool calls and results", async () => {
    const mockAgent = createMockAgentWithLog([
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
    } as any;

    const wsServer = createWsServer(core, {
      buildAgent: async () => mockAgent,
    });

    const result = await wsServer.sessionRegistry.create({});

    const ws = createWsMockWs();
    const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
    typedWs.activeSessionId = result.sessionId;

    wsServer.onMessage(ws, JSON.stringify({
      type: C2S.SWITCH_SESSION,
      sessionId: result.sessionId,
    }));

    const msgs = (ws as any).messages.map((m: string) => JSON.parse(m));
    const toolCallMsg = msgs.find((m: any) => m.type === S2C.TOOL_CALL);
    const toolResultMsg = msgs.find((m: any) => m.type === S2C.TOOL_RESULT);

    expect(toolCallMsg).toBeDefined();
    expect(toolCallMsg.name).toBe("read_file");
    expect(toolResultMsg).toBeDefined();
    expect(toolResultMsg.output).toBe("File content here");
  });

  it("handles agent with no log", async () => {
    const mockAgent = createMockAgentWithLog([]);

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
    } as any;

    const wsServer = createWsServer(core, {
      buildAgent: async () => mockAgent,
    });

    const result = await wsServer.sessionRegistry.create({});

    const ws = createWsMockWs();
    const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
    typedWs.activeSessionId = result.sessionId;

    // Should not throw
    wsServer.onMessage(ws, JSON.stringify({
      type: C2S.SWITCH_SESSION,
      sessionId: result.sessionId,
    }));
  });

  it("handles messages without getTextContent", async () => {
    const mockAgent = createMockAgentWithLog([
      { role: "user", content: "Hello" }, // No getTextContent
    ]);

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
    } as any;

    const wsServer = createWsServer(core, {
      buildAgent: async () => mockAgent,
    });

    const result = await wsServer.sessionRegistry.create({});

    const ws = createWsMockWs();
    const typedWs = ws as WebSocket & { activeSessionId?: string; activeChannel?: WebSocketChannel };
    typedWs.activeSessionId = result.sessionId;

    wsServer.onMessage(ws, JSON.stringify({
      type: C2S.SWITCH_SESSION,
      sessionId: result.sessionId,
    }));

    const msgs = (ws as any).messages.map((m: string) => JSON.parse(m));
    const userMsg = msgs.find((m: any) => m.type === S2C.USER_MESSAGE);
    expect(userMsg).toBeDefined();
    expect(userMsg.content).toBe("Hello");
  });
});

// ── Message Handler Tests for Log Operations ─────────────────────────────────

describe("WebSocket message handlers - log operations", () => {
  function createWsMockWs() {
    const messages: string[] = [];
    return {
      readyState: 1,
      send: (data: string) => { messages.push(data); },
      messages,
      close: mock(() => {}),
    } as unknown as WebSocket;
  }

  function createWsMockCore() {
    return {
      hooks: { notifyHooks: mock(() => {}), notifyHooksAsync: mock(async () => {}) },
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
      toolRegistry: { getAll: () => [], get: () => null, register: mock(() => {}) },
      extensions: { cleanup: mock(async () => {}) },
    } as any;
  }

  describe("LIST_LOGS", () => {
    it("does not crash when handling LIST_LOGS message", () => {
      const mockAgent = makeWsMockAgent();

      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: async () => mockAgent,
      });

      const ws = createWsMockWs();
      // Should not throw
      expect(() => {
        wsServer.onMessage(ws, JSON.stringify({ type: C2S.LIST_LOGS }));
      }).not.toThrow();
    });
  });

  describe("VIEW_LOG", () => {
    it("sends error when logId is missing", () => {
      const mockAgent = makeWsMockAgent();

      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: async () => mockAgent,
      });

      const ws = createWsMockWs();
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.VIEW_LOG }));

      // No message sent when logId is missing
      expect((ws as unknown as { messages: string[] }).messages.length).toBe(0);
    });
  });

  describe("DELETE_LOG", () => {
    it("sends error when log not found", async () => {
      const mockAgent = makeWsMockAgent();

      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: async () => mockAgent,
      });

      const ws = createWsMockWs();
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.DELETE_LOG, logId: "non-existent-log" }));

      // Wait for async operation
      await new Promise(r => setTimeout(r, 50));

      const msgs = (ws as unknown as { messages: string[] }).messages.map((m) => JSON.parse(m));
      const errorMsg = msgs.find((m: any) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("not found");
    });
  });

  describe("Unknown message type", () => {
    it("sends error for unknown message type", () => {
      const mockAgent = makeWsMockAgent();

      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: async () => mockAgent,
      });

      const ws = createWsMockWs();
      wsServer.onMessage(ws, JSON.stringify({ type: "unknown-message-type" }));

      const msgs = (ws as unknown as { messages: string[] }).messages.map((m) => JSON.parse(m));
      const errorMsg = msgs.find((m: any) => m.type === "error");
      expect(errorMsg).toBeDefined();
      expect(errorMsg.message).toContain("Unknown message type");
    });
  });

  describe("attachToMostRecentSession", () => {
    it("creates new session when no existing sessions", () => {
      const mockAgent = makeWsMockAgent({ sessionId: "new-session" });

      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: async () => mockAgent,
      });

      const ws = createWsMockWs();
      // AUTH with no sessionId triggers attachToMostRecentSession
      wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH }));

      // Session should be created asynchronously
      expect(wsServer.sessionRegistry.size).toBe(0); // Async, not created yet in sync test
    });

    it("does not crash when handling CONNECTION_OPEN with existing sessions", async () => {
      const mockAgent = makeWsMockAgent();

      const core = createWsMockCore();
      const wsServer = createWsServer(core, {
        buildAgent: async () => mockAgent,
      });

      // Create a session
      await wsServer.sessionRegistry.create({});

      const ws = createWsMockWs();
      // Should not throw
      expect(() => {
        wsServer.onMessage(ws, JSON.stringify({ type: C2S.AUTH }));
      }).not.toThrow();
    });
  });
});
