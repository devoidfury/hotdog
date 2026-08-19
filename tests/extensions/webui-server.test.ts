// Tests for webui/server.ts — WebUI server creation and configuration.

import { describe, it, expect, afterEach } from "bun:test";
import { createWebuiServer } from "../../src/extensions/webui/server.ts";
import { logger } from "../../src/core/logger.ts";

function createMockCore(config: Record<string, unknown> = {}) {
  return {
    hooks: {
      notifyHooks: () => {},
      notifyHooksAsync: async () => {},
    },
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
    resolved: {
      baseUrl: "http://localhost:8000",
      apiKey: "test-key",
      model: "test-model",
      stream: true,
      chatTimeout: 30,
      maxRetries: 3,
      maxIterations: 100,
      maxToolCallsPerIteration: 10,
      toolRetryDelay: 1,
      contextLimit: 128000,
      hideTools: false,
      hideThinking: true,
      showTokenUse: true,
      profileName: "default",
      profilesPath: "./config/profiles",
      modelRegistry: {},
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

describe("createWebuiServer", () => {
  describe("validation", () => {
    it("throws when no API key is configured", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 3000 }, "/tmp/ui"),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when apiKey is empty string", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: "" }, "/tmp/ui"),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when apiKey is null", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: null }, "/tmp/ui"),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when apiKey is undefined", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: undefined }, "/tmp/ui"),
      ).rejects.toThrow("No API key configured");
    });

    it("throws when maxAgeSecs is missing from webui config", async () => {
      const core = createMockCore({ webui: {} });
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: "test-key" }, "/tmp/ui"),
      ).rejects.toThrow("missing required webui.maxAgeSecs");
    });

    it("throws when maxAgeSecs is 0", async () => {
      const core = createMockCore({ webui: { maxAgeSecs: 0 } });
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: "test-key" }, "/tmp/ui"),
      ).rejects.toThrow("missing required webui.maxAgeSecs");
    });

    it("throws when maxAgeSecs is null", async () => {
      const core = createMockCore({ webui: { maxAgeSecs: null } });
      await expect(
        createWebuiServer(core, { port: 3000, apiKey: "test-key" }, "/tmp/ui"),
      ).rejects.toThrow("missing required webui.maxAgeSecs");
    });
  });

  describe("server creation", () => {
    it("passes config validation with valid settings", async () => {
      const core = createMockCore();
      try {
        await createWebuiServer(core, {
          port: 3000,
          host: "localhost",
          apiKey: "test-key",
          sessionTokenTtlMin: 60,
        }, "/tmp/ui");
      } catch (e: unknown) {
        // Expected to fail at Bun.serve, not at config validation
        const message = (e as Error).message;
        expect(message).not.toContain("No API key configured");
        expect(message).not.toContain("missing required webui.maxAgeSecs");
      }
    });

    it("respects custom webui.maxAgeSecs", async () => {
      const core = createMockCore({ webui: { maxAgeSecs: 7200 } });
      try {
        await createWebuiServer(core, { port: 3000, apiKey: "test-key" }, "/tmp/ui");
      } catch (e: unknown) {
        const message = (e as Error).message;
        expect(message).not.toContain("missing required webui.maxAgeSecs");
      }
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
      }, "/tmp/ui");
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
        }, "/tmp/ui");
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
        }, "/tmp/ui");
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
      }, "/tmp/ui");

      server = result.server;
      wsServer = result.wsServer;
      baseUrl = `http://127.0.0.1:${server.port}`;
      return result;
    }

    it("serves frontend at /", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("html");
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
      const result = await startServer();

      // First get a token
      const loginRes = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-secret" }),
      });
      const { token } = await loginRes.json();

      // Verify the token
      const verifyRes = await fetch(`${baseUrl}/verify?token=${token}`);
      expect(verifyRes.status).toBe(200);
      const data = await verifyRes.json();
      expect(data.valid).toBe(true);
    });

    it("GET /verify with invalid token returns 401", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/verify?token=invalid-token`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.valid).toBe(false);
    });

    it("GET /verify without token returns 401", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/verify`);
      expect(res.status).toBe(401);
    });

    it("GET /ws without token returns 401", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/ws`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("Token required");
    });

    it("GET /ws with invalid token returns 401", async () => {
      await startServer();
      const res = await fetch(`${baseUrl}/ws?token=invalid-token`);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.error).toContain("Invalid token");
    });

    it("WebSocket upgrade succeeds with valid token", async () => {
      const result = await startServer();

      // Get a valid token
      const loginRes = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-secret" }),
      });
      const { token } = await loginRes.json();

      // Connect via WebSocket
      const wsUrl = `${baseUrl.replace("http", "ws")}/ws?token=${token}`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve) => {
        ws.onopen = () => {
          resolve();
        };
        ws.onerror = () => {
          throw new Error("WebSocket connection failed");
        };
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);
      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it("WebSocket message handler forwards messages to wsServer", async () => {
      const result = await startServer();

      // Get a valid token
      const loginRes = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-secret" }),
      });
      const { token } = await loginRes.json();

      // Connect via WebSocket
      const wsUrl = `${baseUrl.replace("http", "ws")}/ws?token=${token}`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket connection failed"));
      });

      // Send a valid JSON message (LIST_SESSIONS)
      const received: string[] = [];
      ws.onmessage = (event) => {
        received.push(event.data as string);
      };

      ws.send(JSON.stringify({ type: "listSessions" }));

      // Wait for response
      await new Promise((r) => setTimeout(r, 200));

      // The message handler should have forwarded the message
      // and we should get a response (sessions list or error)
      expect(received.length).toBeGreaterThan(0);

      ws.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it("WebSocket close handler cleans up connection", async () => {
      const result = await startServer();

      // Get a valid token
      const loginRes = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-secret" }),
      });
      const { token } = await loginRes.json();

      // Connect via WebSocket
      const wsUrl = `${baseUrl.replace("http", "ws")}/ws?token=${token}`;
      const ws = new WebSocket(wsUrl);

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error("WebSocket connection failed"));
      });

      expect(ws.readyState).toBe(WebSocket.OPEN);

      // Close the connection
      ws.close();

      // Wait for close to complete
      await new Promise<void>((resolve) => {
        ws.onclose = () => resolve();
      });

      expect(ws.readyState).toBe(WebSocket.CLOSED);
    });

    it("GET /ws upgrade failure returns 400", async () => {
      await startServer();

      // Get a valid token
      const loginRes = await fetch(`${baseUrl}/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: "test-secret" }),
      });
      const { token } = await loginRes.json();

      // Send a non-WebSocket upgrade request (regular HTTP GET) to /ws with token
      // This should fail to upgrade and return 400
      const res = await fetch(`${baseUrl}/ws?token=${token}`, {
        headers: { "Upgrade": "not-websocket" },
      });

      // Either upgrade fails (400) or Bun handles it differently
      // The key is that the upgrade failure path is exercised
      expect([400, 426]).toContain(res.status);
    });
  });
});
