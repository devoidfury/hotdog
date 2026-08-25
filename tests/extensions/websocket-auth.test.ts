// Tests for websocket/auth.ts — authentication middleware for WebSocket connections.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  createAuthMiddleware,
  apiKeyEquals,
} from "../../src/extensions/websocket/auth.ts";

/**
 * A zero-TTL token expires as soon as Date.now() advances past its issue
 * time. Poll until it actually does rather than relying on a fixed sleep.
 */
async function waitForExpiry(
  middleware: ReturnType<typeof createAuthMiddleware>,
  token: string,
  timeoutMs = 200,
): Promise<void> {
  const start = Date.now();
  while (middleware.validateToken(token)) {
    if (Date.now() - start > timeoutMs) throw new Error("token did not expire in time");
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe("createAuthMiddleware", () => {
  let middleware: ReturnType<typeof createAuthMiddleware>;

  beforeEach(() => {
    middleware = createAuthMiddleware({
      validateApiKey: async (key) => key === "valid-api-key",
      tokenTtlMin: 1, // 1 minute TTL for testing
    });
  });

  afterEach(() => {
    middleware.stopCleanup();
  });

  describe("loginHandler", () => {
    it("returns token on valid API key", async () => {
      const req = new Request("http://localhost/login", {
        method: "POST",
        body: JSON.stringify({ apiKey: "valid-api-key" }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await middleware.loginHandler(req);
      expect(response.status).toBe(200);

      const data = (await response.json()) as { token?: string };
      expect(data.token).toBeDefined();
      expect(typeof data.token).toBe("string");
    });

    it("returns 401 on invalid API key", async () => {
      const req = new Request("http://localhost/login", {
        method: "POST",
        body: JSON.stringify({ apiKey: "wrong-key" }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await middleware.loginHandler(req);
      expect(response.status).toBe(401);

      const data = (await response.json()) as { error?: string };
      expect(data.error).toBe("Invalid API key");
    });

    it("returns 401 when API key is missing", async () => {
      const req = new Request("http://localhost/login", {
        method: "POST",
        body: JSON.stringify({}),
        headers: { "Content-Type": "application/json" },
      });

      const response = await middleware.loginHandler(req);
      expect(response.status).toBe(401);

      const data = (await response.json()) as { error?: string };
      expect(data.error).toBe("API key required");
    });

    it("returns 401 when API key is empty string", async () => {
      const req = new Request("http://localhost/login", {
        method: "POST",
        body: JSON.stringify({ apiKey: "" }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await middleware.loginHandler(req);
      expect(response.status).toBe(401);
    });

    it("returns 400 on invalid request body", async () => {
      const req = new Request("http://localhost/login", {
        method: "POST",
        body: "not json",
        headers: { "Content-Type": "text/plain" },
      });

      const response = await middleware.loginHandler(req);
      expect(response.status).toBe(400);

      const data = (await response.json()) as { error?: string };
      expect(data.error).toBe("Invalid request body");
    });

    it("returns 401 when API key is not a string", async () => {
      const req = new Request("http://localhost/login", {
        method: "POST",
        body: JSON.stringify({ apiKey: 123 }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await middleware.loginHandler(req);
      expect(response.status).toBe(401);
    });
  });

  describe("validateToken", () => {
    it("validates a token returned from login", async () => {
      const req = new Request("http://localhost/login", {
        method: "POST",
        body: JSON.stringify({ apiKey: "valid-api-key" }),
        headers: { "Content-Type": "application/json" },
      });

      const response = await middleware.loginHandler(req);
      const data = (await response.json()) as { token: string };
      expect(middleware.validateToken(data.token)).toBe(true);
    });

    it("rejects an unknown token", () => {
      expect(middleware.validateToken("unknown-token")).toBe(false);
    });

    it("rejects empty string token", () => {
      expect(middleware.validateToken("")).toBe(false);
    });

    it("rejects non-string token", () => {
      expect(middleware.validateToken(123 as unknown as string)).toBe(false);
    });

    it("rejects expired token", async () => {
      // Create middleware with very short TTL
      const shortLived = createAuthMiddleware({
        validateApiKey: async (key) => key === "test",
        tokenTtlMin: 0, // expires immediately
      });

      try {
        const req = new Request("http://localhost/login", {
          method: "POST",
          body: JSON.stringify({ apiKey: "test" }),
          headers: { "Content-Type": "application/json" },
        });

        const response = await shortLived.loginHandler(req);
        const data = (await response.json()) as { token: string };

        // Wait for the zero-TTL token to actually expire
        await waitForExpiry(shortLived, data.token);

        expect(shortLived.validateToken(data.token)).toBe(false);
      } finally {
        shortLived.stopCleanup();
      }
    });
  });

  describe("cleanup", () => {
    it("removes expired tokens", async () => {
      // Create middleware with very short TTL
      const shortLived = createAuthMiddleware({
        validateApiKey: async (key) => key === "test",
        tokenTtlMin: 0,
      });

      try {
        const req = new Request("http://localhost/login", {
          method: "POST",
          body: JSON.stringify({ apiKey: "test" }),
          headers: { "Content-Type": "application/json" },
        });

        const response = await shortLived.loginHandler(req);
        const data = (await response.json()) as { token: string };

        // Wait for expiration, then let cleanup() remove the stale entry
        await waitForExpiry(shortLived, data.token);
        shortLived.cleanup();
        expect(shortLived.validateToken(data.token)).toBe(false);
      } finally {
        shortLived.stopCleanup();
      }
    });
  });

  describe("startCleanup / stopCleanup", () => {
    it("startCleanup is idempotent and stopCleanup cleans up", () => {
      middleware.startCleanup();
      middleware.startCleanup(); // idempotent, should not throw
      middleware.stopCleanup();
      middleware.stopCleanup(); // idempotent, should not throw
    });
  });
});

describe("login rate limiting", () => {
  let middleware: ReturnType<typeof createAuthMiddleware>;

  beforeEach(() => {
    middleware = createAuthMiddleware({
      validateApiKey: async (key) => key === "valid-api-key",
      tokenTtlMin: 1,
    });
  });

  afterEach(() => {
    middleware.stopCleanup();
  });

  function loginReq(key: string, ip: string): Request {
    return new Request("http://localhost/login", {
      method: "POST",
      body: JSON.stringify({ apiKey: key }),
      headers: {
        "Content-Type": "application/json",
        "x-forwarded-for": ip,
      },
    });
  }

  async function failTimes(mw: typeof middleware, ip: string, n: number): Promise<void> {
    for (let i = 0; i < n; i++) {
      const res = await mw.loginHandler(loginReq("wrong-key", ip));
      expect(res.status).toBe(401);
    }
  }

  it("returns 429 after 5 failures, even with a valid key", async () => {
    await failTimes(middleware, "10.0.0.1", 5);
    const res = await middleware.loginHandler(loginReq("valid-api-key", "10.0.0.1"));
    expect(res.status).toBe(429);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toBe("Too many failed login attempts. Try again later.");
  });

  it("includes a Retry-After header on 429", async () => {
    await failTimes(middleware, "10.0.0.2", 5);
    const res = await middleware.loginHandler(loginReq("valid-api-key", "10.0.0.2"));
    expect(res.status).toBe(429);
    const retryAfter = res.headers.get("Retry-After");
    expect(retryAfter).not.toBeNull();
    expect(Number(retryAfter)).toBeGreaterThanOrEqual(1);
  });

  it("tracks failures per IP", async () => {
    await failTimes(middleware, "10.0.0.3", 5);

    // Same IP is locked out...
    expect((await middleware.loginHandler(loginReq("valid-api-key", "10.0.0.3"))).status).toBe(429);

    // ...but a different IP can still log in.
    const res = await middleware.loginHandler(loginReq("valid-api-key", "10.0.0.4"));
    expect(res.status).toBe(200);
  });

  it("resets the failure counter on successful login", async () => {
    const realNow = Date.now.bind(Date);
    let fake = realNow();
    const spy = spyOn(Date, "now").mockImplementation(() => fake);
    try {
      await failTimes(middleware, "10.0.0.5", 5); // 1s lockout
      fake += 2_000; // wait out lockout

      // Successful login resets the counter...
      expect((await middleware.loginHandler(loginReq("valid-api-key", "10.0.0.5"))).status).toBe(200);

      // ...so a single later failure does NOT re-lock (would be the 6th
      // consecutive failure if the counter had not been reset).
      expect((await middleware.loginHandler(loginReq("wrong-key", "10.0.0.5"))).status).toBe(401);
      expect((await middleware.loginHandler(loginReq("valid-api-key", "10.0.0.5"))).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("lockout grows exponentially as failures keep landing past the threshold", async () => {
    const ip = "10.0.0.6";
    const realNow = Date.now.bind(Date);
    let fake = realNow();
    const spy = spyOn(Date, "now").mockImplementation(() => fake);
    try {
      // 5 real failures → first lockout (1s).
      await failTimes(middleware, ip, 5);
      let res = await middleware.loginHandler(loginReq("wrong-key", ip));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBe(1);

      // Blocked attempts don't count; wait out the 1s lockout, land a 6th
      // real failure → next lockout is 2s.
      fake += 2_000;
      expect((await middleware.loginHandler(loginReq("wrong-key", ip))).status).toBe(401);
      res = await middleware.loginHandler(loginReq("wrong-key", ip));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBe(2);

      // Wait out the 2s lockout, land a 7th real failure → next lockout 4s.
      fake += 3_000;
      expect((await middleware.loginHandler(loginReq("wrong-key", ip))).status).toBe(401);
      res = await middleware.loginHandler(loginReq("wrong-key", ip));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBe(4);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("apiKeyEquals", () => {
  it("returns true for identical keys", () => {
    expect(apiKeyEquals("secret-key", "secret-key")).toBe(true);
  });

  it("returns false for different keys", () => {
    expect(apiKeyEquals("secret-key", "other-key-")).toBe(false);
  });

  it("returns false when lengths differ", () => {
    expect(apiKeyEquals("short", "much-longer-key")).toBe(false);
    expect(apiKeyEquals("", "secret")).toBe(false);
  });
});
