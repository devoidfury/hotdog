// Tests for websocket/auth.ts — authentication middleware for WebSocket connections.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  createAuthMiddleware,
  apiKeyEquals,
} from "@extensions/websocket/auth.ts";

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

  describe("login body size cap", () => {
    function capReq(headers: Record<string, string>, body: BodyInit): Request {
      return new Request("http://localhost/login", {
        method: "POST",
        body,
        headers: { "Content-Type": "application/json", ...headers },
      });
    }

    it("rejects oversize Content-Length with 413, reading nothing and recording nothing", async () => {
      let keyChecks = 0;
      const mw = createAuthMiddleware({
        validateApiKey: async (key) => {
          keyChecks++;
          return key === "valid-api-key";
        },
        tokenTtlMin: 1,
      });
      try {
        const body = JSON.stringify({ apiKey: "x".repeat(20_000) });
        const req = capReq({ "content-length": String(body.length), "x-forwarded-for": "10.1.0.1" }, body);
        // Bun keeps an explicitly-set content-length on constructed Requests.
        expect(req.headers.get("content-length")).toBe(String(body.length));

        const res = await mw.loginHandler(req);
        expect(res.status).toBe(413);
        expect(((await res.json()) as { error?: string }).error).toBe("Request body too large");
        expect(keyChecks).toBe(0);

        // No failure recorded: four more wrong keys then a valid login all
        // succeed (a recorded 413 would have made the valid attempt a 429).
        const wrong = () => capReq({ "x-forwarded-for": "10.1.0.1" }, JSON.stringify({ apiKey: "nope" }));
        for (let i = 0; i < 4; i++) {
          expect((await mw.loginHandler(wrong())).status).toBe(401);
        }
        expect(keyChecks).toBe(4);
        const ok = await mw.loginHandler(
          capReq({ "x-forwarded-for": "10.1.0.1" }, JSON.stringify({ apiKey: "valid-api-key" })),
        );
        expect(ok.status).toBe(200);
      } finally {
        mw.stopCleanup();
      }
    });

    it("rejects an oversize stream body (no Content-Length) via the text-length check", async () => {
      const payload = JSON.stringify({ apiKey: "x".repeat(20_000) });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(payload));
          c.close();
        },
      });
      const req = new Request("http://localhost/login", { method: "POST", body: stream });
      // Bun sets no content-length for stream bodies, so the guard that
      // fires here must be the post-read text-length check.
      expect(req.headers.get("content-length")).toBeNull();

      const res = await middleware.loginHandler(req);
      expect(res.status).toBe(413);
      expect(((await res.json()) as { error?: string }).error).toBe("Request body too large");
    });

    it("small-but-invalid JSON still draws 400, not 413", async () => {
      const res = await middleware.loginHandler(capReq({}, "not json"));
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toBe("Invalid request body");
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

    it("purges expired sessions that validateToken never inspected", async () => {
      // validateToken deletes expired entries as a side effect of checking
      // them, so the test above leaves cleanup() an empty map. Here the
      // stale entry stays in the map until cleanup() itself removes it,
      // and an unexpired entry must survive.
      const shortLived = createAuthMiddleware({
        validateApiKey: async (key) => key === "test",
        tokenTtlMin: 0,
      });
      const live = createAuthMiddleware({
        validateApiKey: async (key) => key === "test",
        tokenTtlMin: 1,
      });
      try {
        const login = () =>
          new Request("http://localhost/login", {
            method: "POST",
            body: JSON.stringify({ apiKey: "test" }),
            headers: { "Content-Type": "application/json" },
          });
        const stale = (await (await shortLived.loginHandler(login())).json()) as { token: string };
        const fresh = (await (await live.loginHandler(login())).json()) as { token: string };

        // Guarantee Date.now() has passed the zero-TTL token's expiry
        // without any validateToken() call removing it first.
        await new Promise((r) => setTimeout(r, 5));

        shortLived.cleanup();
        live.cleanup();

        expect(shortLived.validateToken(stale.token)).toBe(false);
        expect(live.validateToken(fresh.token)).toBe(true);
      } finally {
        shortLived.stopCleanup();
        live.stopCleanup();
      }
    });
  });

  describe("startCleanup / stopCleanup", () => {
    it("startCleanup is idempotent and stopCleanup clears the timer", () => {
      const setIntervalSpy = spyOn(globalThis, "setInterval");
      const clearIntervalSpy = spyOn(globalThis, "clearInterval");
      try {
        middleware.startCleanup();
        middleware.startCleanup(); // idempotent: must not start a second timer
        expect(setIntervalSpy).toHaveBeenCalledTimes(1);

        middleware.stopCleanup();
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

        middleware.stopCleanup(); // idempotent
        expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
      } finally {
        setIntervalSpy.mockRestore();
        clearIntervalSpy.mockRestore();
      }
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
    // First lockout is the 60 s base (ceil of what remains of it).
    expect(Number(retryAfter)).toBe(60);
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
      await failTimes(middleware, "10.0.0.5", 5); // 60 s lockout
      fake += 61_000; // wait out the lockout

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
      // 5 real failures → first lockout (60 s base).
      await failTimes(middleware, ip, 5);
      let res = await middleware.loginHandler(loginReq("wrong-key", ip));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBe(60);

      // The blocked attempt above counted (now 6 failures → 120 s ladder).
      // Wait it out, land a real 7th failure → next lockout is 240 s.
      fake += 120_001;
      expect((await middleware.loginHandler(loginReq("wrong-key", ip))).status).toBe(401);
      res = await middleware.loginHandler(loginReq("wrong-key", ip));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBe(240);
    } finally {
      spy.mockRestore();
    }
  });

  it("blocked 429 attempts count: probing slides the lockout and escalates the ladder", async () => {
    const ip = "10.0.0.8";
    const realNow = Date.now.bind(Date);
    let fake = realNow();
    const spy = spyOn(Date, "now").mockImplementation(() => fake);
    try {
      await failTimes(middleware, ip, 5); // locked 60 s from `fake`

      // Two probes at the same instant, both blocked; each counts.
      expect((await middleware.loginHandler(loginReq("valid-api-key", ip))).status).toBe(429); // → 6 failures
      const probe2 = await middleware.loginHandler(loginReq("valid-api-key", ip)); // → 7 failures
      expect(probe2.status).toBe(429);
      expect(Number(probe2.headers.get("Retry-After"))).toBe(120); // ladder at 6 failures

      // Past the original 60 s window the IP is STILL locked: the probes
      // slid lastFailedAt and pushed the ladder to 240 s from their stamp.
      fake += 60_001;
      const probe3 = await middleware.loginHandler(loginReq("valid-api-key", ip));
      expect(probe3.status).toBe(429);
      expect(Number(probe3.headers.get("Retry-After"))).toBe(180);

      // Stop probing, wait out the lockout probe3 left (480 s ladder from
      // its stamp). The next real failure is the 9th counted attempt and
      // the ladder has already hit the 15-min cap — with non-counting
      // blocked attempts it would be nowhere near this.
      fake += 480_001;
      expect((await middleware.loginHandler(loginReq("wrong-key", ip))).status).toBe(401);
      const res = await middleware.loginHandler(loginReq("wrong-key", ip));
      expect(res.status).toBe(429);
      expect(Number(res.headers.get("Retry-After"))).toBe(900);
    } finally {
      spy.mockRestore();
    }
  });

  it("lifetime cap: 100 counted failures lock the IP until the entry TTL expires", async () => {
    const ip = "10.0.0.9";
    const realNow = Date.now.bind(Date);
    let fake = realNow();
    const spy = spyOn(Date, "now").mockImplementation(() => fake);
    try {
      await failTimes(middleware, ip, 5);
      // Pure probing drives the counter to 100 with the clock frozen.
      for (let i = 0; i < 95; i++) {
        expect((await middleware.loginHandler(loginReq("valid-api-key", ip))).status).toBe(429);
      }
      const res = await middleware.loginHandler(loginReq("valid-api-key", ip));
      expect(res.status).toBe(429);
      // Lifetime cap engaged: Retry-After reflects the full remaining TTL.
      expect(Number(res.headers.get("Retry-After"))).toBe(86400);

      // After the TTL window the entry lets one attempt through, and a
      // successful login resets it: five later failures buy only the fresh
      // 60 s base, not another 86400 s lifetime lock.
      fake += 24 * 60 * 60_000;
      expect((await middleware.loginHandler(loginReq("valid-api-key", ip))).status).toBe(200);
      await failTimes(middleware, ip, 5);
      const reset = await middleware.loginHandler(loginReq("valid-api-key", ip));
      expect(reset.status).toBe(429);
      expect(Number(reset.headers.get("Retry-After"))).toBe(60);

      // cleanup() purges the entry past the entry TTL: the following wrong
      // key starts the counter at 1, so the next valid login succeeds (an
      // unpurged entry would be re-lifetimed by that failure → 429).
      fake += 24 * 60 * 60_000 + 1;
      middleware.cleanup();
      expect((await middleware.loginHandler(loginReq("wrong-key", ip))).status).toBe(401);
      expect((await middleware.loginHandler(loginReq("valid-api-key", ip))).status).toBe(200);
    } finally {
      spy.mockRestore();
    }
  });

  it("cleanup() drops rate-limit entries older than the 24h entry TTL", async () => {
    const realNow = Date.now.bind(Date);
    let fake = realNow();
    const spy = spyOn(Date, "now").mockImplementation(() => fake);
    try {
      const ip = "10.0.0.7";
      await failTimes(middleware, ip, 5); // entry: 5 consecutive failures at `fake`

      // Jump past both the 1s lockout and the 24h entry TTL, then clean.
      fake += 24 * 60 * 60_000 + 1_000;
      middleware.cleanup();

      // Entry purged: the next failure counts as the 1st, not the 6th, so
      // the following valid login succeeds. Without the purge the counter
      // would reach 6 and the valid attempt would draw a 429 lockout.
      expect((await middleware.loginHandler(loginReq("wrong-key", ip))).status).toBe(401);
      expect((await middleware.loginHandler(loginReq("valid-api-key", ip))).status).toBe(200);
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
