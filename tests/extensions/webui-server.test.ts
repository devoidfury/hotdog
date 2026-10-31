// Tests for webui/server.ts — WebUI server creation and configuration.

import { describe, it, expect, afterEach } from "bun:test";
import net from "node:net";
import { createWebuiServer, attachSocketPeerIp } from "@extensions/webui/server.ts";
import { DDG_SOLVE_SERVICE } from "@extensions/web-search/index.ts";
import { ServiceRegistry } from "@core/extensions/service-registry.ts";
import { logger } from "@utils/logger.ts";
import { LlmClient } from "@core/llm-client/client.ts";
import { createMockCore as createBaseMockCore } from "../test-helpers.ts";
import { createRoleMappingRegistry } from "@core/extensions/role-mapping.ts";
import { systemFirstRoleMapping, developerRoleMapping } from "@extensions/role-mapping-default/index.ts";

const testRoleReg = createRoleMappingRegistry();
testRoleReg.register(systemFirstRoleMapping);
testRoleReg.register(developerRoleMapping);


function createMockCore(config: Record<string, unknown> = {}) {
  return createBaseMockCore({
    config: {
      websocket: {
        sessionTimeoutMin: 30,
        questionTimeoutSecs: 300,
        questionStrategy: "wait",
      },
      webui: {},
      ...config,
    },
    // profilesPath makes createWebuiServer build a ProfileManager from the
    // repo's own profile directory (mirrors the real resolution chain).
    // Root uploadLimits (schema defaults as plain literals) come from the
    // base fixture's resolved bag; the transport frame bound reads it there.
    resolved: {
      profilesPath: "./config/profiles",
      maxToolCallsPerIteration: 10,
      toolRetryDelay: 1,
    },
    createLlmClient: ((overrides?: Record<string, unknown>) =>
        new LlmClient({ roleMapping: "system-first", roleMappingRegistry: testRoleReg, baseUrl: "http://localhost:8000", apiKey: "test-key",
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

    it("throws when trustedProxy is malformed (loud at boot, not silently off)", async () => {
      const core = createMockCore();
      await expect(
        createWebuiServer(core, { port: 0, apiKey: "test-key", trustedProxy: "not-a-cidr" }),
      ).rejects.toThrow(/webui\.trustedProxy/);
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

    it("mounts extension solve routes and reports its base URL", async () => {
      // web-search's captcha solve routes ride the webui port; webui reports
      // the base URL back so challenge hints are reachable addresses.
      const core = createMockCore();
      const seenBaseUrls: string[] = [];
      const registry = new ServiceRegistry();
      registry.register(DDG_SOLVE_SERVICE as any, {
        routes: {
          "/solve/*": () => new Response("solved"),
          "/tiles/*": () => new Response("tiles"),
        },
        setBaseUrl: (u: string) => seenBaseUrls.push(u),
      } as any);
      (core as any).services = registry;
      const result = await createWebuiServer(core, {
        port: 0,
        host: "127.0.0.1",
        apiKey: "test-key",
        sessionTokenTtlMin: 60,
      });
      server = result.server;
      wsServer = result.wsServer;

      const resp = await fetch(`http://127.0.0.1:${result.server.port}/solve/deadbeef`);
      expect(resp.status).toBe(200);
      expect(await resp.text()).toBe("solved");
      expect(seenBaseUrls).toContain(`http://127.0.0.1:${result.server.port}`);
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
      // The warning must name the consequence and the knob, not just the
      // cleartext risk (H-11: shared throttle bucket / up-to-24h lockout
      // behind a proxy without webui.trustedProxy).
      expect(warnings.some((w) => w.includes("webui.trustedProxy"))).toBe(true);
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
      // Browsers always send Origin on a WS handshake and the server refuses
      // upgrades without one; the Bun client doesn't send it on its own, so
      // the honest same-origin value goes in explicitly. (Bun's WS client
      // accepts headers; the DOM-flavored global typing here doesn't know it.)
      const ws = new WebSocket(`${baseUrl.replace("http", "ws")}/ws`, {
        headers: { Origin: baseUrl },
      } as any);
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
      // Same-origin Origin keeps the origin gate out of this test's way.
      const res = await fetch(`${baseUrl}/ws`, {
        headers: { "Upgrade": "not-websocket", Origin: baseUrl },
      });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toBe("Upgrade failed");
    });

    it("GET /ws with a foreign Origin returns 403 before any upgrade", async () => {
      // Cross-site drive-by shape: the page's Origin is not the server's host.
      await startServer();
      const res = await fetch(`${baseUrl}/ws`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade", Origin: "http://evil.example" },
      });
      expect(res.status).toBe(403);
      const data = await res.json();
      expect(String(data.error)).toMatch(/same-origin/i);
    });

    it("GET /ws with no Origin returns 403 (fail closed)", async () => {
      // Browsers always send Origin on a WebSocket handshake; a handshake
      // without one is not a browser, and there are no non-browser WS
      // clients to accommodate. Bun's own WS client omits Origin -- this
      // pins that such a socket cannot reach the agent.
      await startServer();
      const res = await fetch(`${baseUrl}/ws`, {
        headers: { Upgrade: "websocket", Connection: "Upgrade" },
      });
      expect(res.status).toBe(403);
    });
  });
});

// ── Login peer attachment (bun 1.4.2 requestIP shim) ───────────────────────
// bun 1.4.2 populates no req.ip on serve requests and proxy:true is a
// no-op (Rust rewrite), so the webui reads the direct socket peer via
// server.requestIP() at the /login boundary and attaches it as req.ip.
// These tests pin the attachment helper and the end-to-end throttle
// identity over real HTTP; the middleware-level resolution tables live in
// websocket-auth.test.ts.

describe("attachSocketPeerIp", () => {
  it("attaches the socket peer as req.ip when req.ip is absent", () => {
    const req = new Request("http://127.0.0.1/login");
    attachSocketPeerIp(req, "127.0.0.1");
    expect((req as Request & { ip?: string }).ip).toBe("127.0.0.1");
  });

  it("never overwrites an existing req.ip (a future native Bun ip wins)", () => {
    const req = new Request("http://127.0.0.1/login");
    Object.defineProperty(req, "ip", { value: "203.0.113.9" });
    attachSocketPeerIp(req, "127.0.0.1");
    expect((req as Request & { ip?: string }).ip).toBe("203.0.113.9");
  });

  it("is a no-op when the peer address is unavailable", () => {
    const req = new Request("http://127.0.0.1/login");
    attachSocketPeerIp(req, null);
    expect((req as Request & { ip?: string }).ip).toBeUndefined();
  });
});

describe("login throttle identity over HTTP (requestIP shim)", () => {
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

  async function startLoopback(config: { trustedProxy?: string } = {}) {
    const result = await createWebuiServer(createMockCore(), {
      port: 0,
      host: "127.0.0.1",
      apiKey: "test-secret",
      sessionTokenTtlMin: 60,
      trustedProxy: config.trustedProxy,
    });
    server = result.server;
    wsServer = result.wsServer;
    return `http://127.0.0.1:${server.port}`;
  }

  function badLogin(baseUrl: string, xff?: string): Promise<Response> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (xff !== undefined) headers["x-forwarded-for"] = xff;
    return fetch(`${baseUrl}/login`, {
      method: "POST",
      headers,
      body: JSON.stringify({ apiKey: "wrong-key" }),
    });
  }

  it("knob unset: the bucket is the real socket peer; forged XFF cannot split or dodge it", async () => {
    const baseUrl = await startLoopback(); // trustedProxy unset
    // Five failures from rotating forged XFF values land in ONE peer
    // bucket (127.0.0.1): the socket peer outranks the header.
    for (const xff of ["203.0.113.1", "203.0.113.2", "203.0.113.3", "203.0.113.4", "203.0.113.5"]) {
      expect((await badLogin(baseUrl, xff)).status).toBe(401);
    }
    // The shared bucket is now locked: even a CORRECT key and no header
    // draws the 429 -- proof the key was the peer, not any XFF value.
    const locked = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "test-secret" }),
    });
    expect(locked.status).toBe(429);
  });

  it("trustedProxy set: distinct XFF clients get independent buckets over the wire", async () => {
    const baseUrl = await startLoopback({ trustedProxy: "127.0.0.1" });
    // Drive client .7 to the lockout...
    for (let i = 0; i < 5; i++) {
      expect((await badLogin(baseUrl, "203.0.113.7")).status).toBe(401);
    }
    expect((await badLogin(baseUrl, "203.0.113.7")).status).toBe(429);
    // ...client .8 is untouched...
    expect((await badLogin(baseUrl, "203.0.113.8")).status).toBe(401);
    // ...and the plain peer bucket (no XFF) is untouched too.
    const ok = await fetch(`${baseUrl}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ apiKey: "test-secret" }),
    });
    expect(ok.status).toBe(200);
    const { token } = (await ok.json()) as { token?: string };
    expect(typeof token).toBe("string");
  });

  it("trustedProxy set logs a startup INFO line naming requestIP", async () => {
    const infos: string[] = [];
    const loggerAny = logger as unknown as { info: (msg: string) => void };
    const origInfo = loggerAny.info;
    loggerAny.info = (msg) => infos.push(msg);
    try {
      await startLoopback({ trustedProxy: "10.0.0.0/8" });
    } finally {
      loggerAny.info = origInfo;
    }
    const line = infos.find((m) => m.includes("trustedProxy"));
    expect(line).toBeDefined();
    expect(line).toContain("10.0.0.0/8");
    expect(line).toContain("requestIP");
  });

  it("no INFO line when trustedProxy is unset", async () => {
    const infos: string[] = [];
    const loggerAny = logger as unknown as { info: (msg: string) => void };
    const origInfo = loggerAny.info;
    loggerAny.info = (msg) => infos.push(msg);
    try {
      await startLoopback();
    } finally {
      loggerAny.info = origInfo;
    }
    expect(infos.some((m) => m.includes("trustedProxy"))).toBe(false);
  });
});

describe("ws gate and Bun's forwarded-header inertness on a loopback bind", () => {
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

  /** Raw HTTP/1.1 upgrade handshake; resolves once headers are in. */
  function rawHandshake(
    port: number | undefined,
    headers: Record<string, string>,
  ): Promise<{ statusLine: string }> {
    return new Promise((resolve, reject) => {
      if (port === undefined) {
        reject(new Error("server has no TCP port"));
        return;
      }
      const sock = net.connect(port, "127.0.0.1", () => {
        const lines = [`GET /ws HTTP/1.1`, `Host: ${headers.host ?? `127.0.0.1:${port}`}`];
        if (headers.origin) lines.push(`Origin: ${headers.origin}`);
        lines.push(
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==", // RFC 6455 example key
          "Sec-WebSocket-Version: 13",
        );
        if (headers["x-forwarded-host"]) lines.push(`X-Forwarded-Host: ${headers["x-forwarded-host"]}`);
        if (headers["x-forwarded-for"]) lines.push(`X-Forwarded-For: ${headers["x-forwarded-for"]}`);
        sock.write(lines.join("\r\n") + "\r\n\r\n");
      });
      let out = "";
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve({ statusLine: out.split("\r\n")[0] ?? "" });
        sock.destroy();
      };
      sock.on("data", (d) => {
        out += d.toString();
        // Only the status line is under test; settle once headers end.
        if (out.includes("\r\n\r\n")) settle();
      });
      sock.on("error", reject);
      setTimeout(settle, 500);
    });
  }

  it("nginx-style Host/Origin names pass the gate on a 127.0.0.1 bind (101)", async () => {
    const result = await createWebuiServer(createMockCore(), {
      port: 0,
      host: "127.0.0.1",
      apiKey: "test-secret",
      sessionTokenTtlMin: 60,
      trustedProxy: "127.0.0.1",
    });
    server = result.server;
    wsServer = result.wsServer;
    // Exactly what the owner's nginx forwards (Host rewritten to
    // localhost, browser Origin kept): loopback names on a loopback bind
    // are allowed by the gate.
    const res = await rawHandshake(server.port, {
      host: "localhost",
      origin: "http://localhost:3001",
    });
    expect(res.statusLine).toContain("101");
  });

  it("X-Forwarded-Host is invisible to Bun 1.4.2: the gate still reads the literal Host (101 stays 101, 403 stays 403)", async () => {
    const result = await createWebuiServer(createMockCore(), {
      port: 0,
      host: "127.0.0.1",
      apiKey: "test-secret",
      sessionTokenTtlMin: 60,
    });
    server = result.server;
    wsServer = result.wsServer;
    // Bogus XFH alongside loopback Host/Origin: Bun 1.4.2 consumes no
    // forwarded headers, so the gate's view is unchanged and the upgrade
    // still passes.
    const good = await rawHandshake(server.port, {
      host: "localhost",
      origin: "http://localhost:3001",
      "x-forwarded-host": "attacker.example",
    });
    expect(good.statusLine).toContain("101");
    // And a foreign Host cannot be laundered back to 101 by XFH either.
    const bad = await rawHandshake(server.port, {
      host: "attacker.example",
      origin: "http://attacker.example",
      "x-forwarded-host": "localhost",
    });
    expect(bad.statusLine).toContain("403");
  });
});
