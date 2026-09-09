// Tests for webui/server.ts — WebUI server creation and configuration.

import { describe, it, expect, afterEach } from "bun:test";
import { createWebuiServer } from "../../src/extensions/webui/server.ts";
import { logger } from "../../src/utils/logger.ts";
import { LlmClient } from "../../src/core/llm-client/client.ts";
import { createMockCore as createBaseMockCore } from "../test-helpers.ts";

function createMockCore(config: Record<string, unknown> = {}) {
  return createBaseMockCore({
    config: {
      websocket: {
        sessionTimeoutMin: 30,
        questionTimeoutSecs: 300,
        questionStrategy: "wait",
      },
      webui: {
        maxAgeSecs: 3600,
      },
      ...config,
    },
    // profilesPath makes createWebuiServer build a ProfileManager from the
    // repo's own profile directory (mirrors the real resolution chain).
    resolved: {
      profilesPath: "./config/profiles",
      maxToolCallsPerIteration: 10,
      toolRetryDelay: 1,
    },
    createLlmClient: ((overrides?: Record<string, unknown>) =>
        new LlmClient({ baseUrl: "http://localhost:8000", apiKey: "test-key", stream: true,
          chatTimeoutSecs: 30, maxRetries: 3, ...overrides })) as any,
  }) as any;
}

describe("createWebuiServer", () => {
  describe("validation", () => {
    it("throws when no API key is configured", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 0 }),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when apiKey is empty string", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 0, apiKey: "" }),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when apiKey is null", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 0, apiKey: null }),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when apiKey is undefined", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 0, apiKey: undefined }),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when maxAgeSecs is missing from webui config", async () => {
      const core = createMockCore({ webui: {} });
      await expect(
        createWebuiServer(core, { port: 0, apiKey: "test-key" }),
      ).rejects.toThrow("missing required webui.maxAgeSecs");
    });

    it("throws when maxAgeSecs is 0", async () => {
      const core = createMockCore({ webui: { maxAgeSecs: 0 } });
      await expect(
        createWebuiServer(core, { port: 0, apiKey: "test-key" }),
      ).rejects.toThrow("missing required webui.maxAgeSecs");
    });

    it("throws when maxAgeSecs is null", async () => {
      const core = createMockCore({ webui: { maxAgeSecs: null } });
      await expect(
        createWebuiServer(core, { port: 0, apiKey: "test-key" }),
      ).rejects.toThrow("missing required webui.maxAgeSecs");
    });
  });

  describe("server creation", () => {
    let server: ReturnType<typeof Bun.serve> | null = null;
    let wsServer: { stopCleanupLoop: () => void } | null = null;

    afterEach(async () => {
      if (server) {
        server.stop(true);
        server = null;
      }
      if (wsServer) {
        wsServer.stopCleanupLoop();
        wsServer = null;
      }
    });

    it("creates a listening server with valid settings", async () => {
      const result = await createWebuiServer(createMockCore(), {
        port: 0,
        host: "127.0.0.1",
        apiKey: "test-key",
        sessionTokenTtlMin: 60,
      });
      server = result.server;
      wsServer = result.wsServer;
      expect(result.server.port).toBeGreaterThan(0);
    });

    it("accepts a custom webui.maxAgeSecs", async () => {
      const result = await createWebuiServer(createMockCore({ webui: { maxAgeSecs: 7200 } }), {
        port: 0,
        host: "127.0.0.1",
        apiKey: "test-key",
      });
      server = result.server;
      wsServer = result.wsServer;
      expect(result.server.port).toBeGreaterThan(0);
    });
  });

  describe("host binding", () => {
    let server: ReturnType<typeof Bun.serve> | null = null;
    let wsServer: { stopCleanupLoop: () => void } | null = null;

    afterEach(async () => {
      if (server) {
        server.stop(true);
        server = null;
      }
      if (wsServer) {
        wsServer.stopCleanupLoop();
        wsServer = null;
      }
    });

    /** Run fn with logger.warn captured; returns the captured messages. */
    async function withWarnCapture(fn: () => Promise<void>): Promise<string[]> {
      const warnings: string[] = [];
      const loggerAny = logger as unknown as { warn: (msg: string) => void };
      const origWarn = loggerAny.warn;
      loggerAny.warn = (msg) => warnings.push(msg);
      try {
        await fn();
        return warnings;
      } finally {
        loggerAny.warn = origWarn;
      }
    }

    it("binds to loopback when no host is configured", async () => {
      const core = createMockCore();
      const result = await createWebuiServer(core, {
        port: 0,
        apiKey: "test-key",
      });
      server = result.server;
      wsServer = result.wsServer;
      expect(result.server.hostname).toBe("127.0.0.1");
    });

    it("warns when binding a non-loopback host", async () => {
      const warnings = await withWarnCapture(async () => {
        const core = createMockCore();
        const result = await createWebuiServer(core, {
          port: 0,
          host: "0.0.0.0",
          apiKey: "test-key",
        });
        server = result.server;
        wsServer = result.wsServer;
        expect(result.server.hostname).toBe("0.0.0.0");
      });
      expect(warnings.some((w) => w.includes("non-loopback"))).toBe(true);
    });

    it("does not warn for loopback hosts", async () => {
      const warnings = await withWarnCapture(async () => {
        const core = createMockCore();
        const result = await createWebuiServer(core, {
          port: 0,
          host: "127.0.0.1",
          apiKey: "test-key",
        });
        server = result.server;
        wsServer = result.wsServer;
      });
      expect(warnings.some((w) => w.includes("non-loopback"))).toBe(false);
    });
  });

  describe("HTTP endpoints", () => {
    let server: ReturnType<typeof Bun.serve> | null = null;
    let wsServer: { stopCleanupLoop: () => void } | null = null;
    let baseUrl = "";

    afterEach(async () => {
      if (server) {
        server.stop(true);
        server = null;
      }
      if (wsServer) {
        wsServer.stopCleanupLoop();
        wsServer = null;
      }
    });

    async function startServer() {
      const core = createMockCore();
      const result = await createWebuiServer(core, {
        port: 0,
        host: "0.0.0.0",
        apiKey: "test-secret",
        sessionTokenTtlMin: 60,
      });

      server = result.server;
      wsServer = result.wsServer;
      baseUrl = `http://127.0.0.1:${server.port}`;
      return result;
    }

    /** Poll a received-message list until a predicate matches (deterministic on arrival, fails loudly on timeout). */
    async function waitForMessage(
      messages: Array<Record<string, unknown>>,
      predicate: (m: Record<string, unknown>) => boolean,
      timeoutMs = 2000,
    ): Promise<Record<string, unknown>> {
      const deadline = Date.now() + timeoutMs;
      let hit = messages.find(predicate);
      while (!hit && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
        hit = messages.find(predicate);
      }
      if (!hit) {
        throw new Error(
          `timed out waiting for message; got: ${JSON.stringify(messages)}`,
        );
      }
      return hit;
    }

    async function getToken(): Promise<string> {
      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-secret" }),
      });
      const { token } = await res.json();
      return token as string;
    }

    /** Open a socket against /ws (no URL token) with message capture wired up. */
    async function openWs(): Promise<{
      ws: WebSocket;
      waitFor: (
        predicate: (m: Record<string, unknown>) => boolean,
      ) => Promise<Record<string, unknown>>;
    }> {
      const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`);
      const received: Array<Record<string, unknown>> = [];
      ws.onmessage = (event) => {
        received.push(JSON.parse(event.data as string));
      };
      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket connection failed"));
      });
      return { ws, waitFor: (predicate) => waitForMessage(received, predicate) };
    }

    it("serves frontend at /", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const text = await res.text();
      // Prove the real frontend page is served, not just any HTML body.
      expect(text).toContain("<title>hotdog WebUI</title>");
    });

    it("returns 404 for unknown paths", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/unknown-path`);
      expect(res.status).toBe(404);
    });

    it("POST /login with valid API key returns token", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-secret" }),
      });
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.token).toBeDefined();
      expect(typeof data.token).toBe("string");
    });

    it("POST /login with invalid API key returns 401", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "wrong-key" }),
      });
      expect(res.status).toBe(401);
    });

    it("GET /verify with valid token returns { valid: true }", async () => {
      await startServer();

      // First get a token
      const loginRes = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-secret" }),
      });
      const { token } = await loginRes.json();

      // Verify the token
      const verifyRes = await fetch(`${baseUrl}/verify`, {
        headers: { "x-hotdog-token": token },
      });
      expect(verifyRes.status).toBe(200);
      const data = await verifyRes.json();
      expect(data.valid).toBe(true);
    });

    it("GET /verify with invalid token returns 401", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/verify`, {
        headers: { "x-hotdog-token": "invalid-token" },
      });
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });

    it("GET /verify without token returns 401", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/verify`);
      expect(res.status).toBe(401);
    });

    it("WebSocket upgrade succeeds without URL token and requires AUTH message", async () => {
      await startServer();
      const token = await getToken();

      // Connect via WebSocket with no token in the URL.
      const { ws, waitFor } = await openWs();

      // The server must ask for auth instead of rejecting the upgrade.
      await waitFor((m) => m.type === "authRequired");

      // An invalid token is rejected over the protocol, not at upgrade.
      ws.send(JSON.stringify({ type: "auth", token: "invalid-token" }));
      await waitFor((m) => m.type === "authError");

      // A valid token completes the handshake.
      ws.send(JSON.stringify({ type: "auth", token }));
      await waitFor((m) => m.type === "authOk");

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
    });

    it("WebSocket rejects non-AUTH messages before authentication", async () => {
      await startServer();

      const { ws, waitFor } = await openWs();
      await waitFor((m) => m.type === "authRequired");

      // Gated: the socket has no validated token yet.
      ws.send(JSON.stringify({ type: "listSessions" }));
      await waitFor((m) => m.type === "authError" && m.code === "auth_required");

      ws.close();
    });

    it("WebSocket message handler forwards messages to wsServer", async () => {
      await startServer();
      const token = await getToken();

      // Connect via WebSocket (no URL token) and authenticate via AUTH
      const { ws, waitFor } = await openWs();
      ws.send(JSON.stringify({ type: "auth", token }));
      await waitFor((m) => m.type === "authOk");

      // LIST_SESSIONS must come back as a sessions list; accepting any
      // "error" here would let a broken forward pass.
      ws.send(JSON.stringify({ type: "listSessions" }));
      const sessionsMsg = await waitFor((m) => m.type === "sessions");
      expect(Array.isArray(sessionsMsg.sessions)).toBe(true);

      ws.close();
    });

    it("WebSocket close handler cleans up connection", async () => {
      await startServer();

      // Close bookkeeping is token-agnostic; no AUTH needed for this one.
      const { ws } = await openWs();
      expect(ws.readyState).toBe(WebSocket.OPEN);

      // Close the connection and wait for close to complete
      ws.close();
      await new Promise<void>((resolve) => {
        ws.onclose = () => resolve();
      });

      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });

    it("GET /ws upgrade failure returns 400", async () => {
      await startServer();

      // A non-WebSocket GET to /ws fails Bun's upgrade and the app answers
      // with its own 400 "Upgrade failed" response (server.ts, not Bun).
      const res = await fetch(`${baseUrl}/ws`, {
        headers: { "Upgrade": "not-websocket" },
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Upgrade failed");
    });
  });
});
