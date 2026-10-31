// Tests for websocket/auth.ts — authentication middleware for WebSocket connections.

import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  createAuthMiddleware,
  apiKeyEquals,
  parseTrustedProxy,
  resolveClientIp,
  type TrustedProxy,
} from "@extensions/websocket/auth.ts";
import { logger } from "@utils/logger.ts";

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

// ── Client identity resolution (webui.trustedProxy, H-11) ──────────────────
// The login throttle keys on resolveClientIp's output; these tests pin the
// resolution table, the parse rules, and the shared-bucket fix itself.

/** Login request with a controlled direct peer (Bun's req.ip) and x-forwarded-for. */
function identityReq(opts: { peer?: string; xff?: string; key?: string }): Request {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (opts.xff !== undefined) headers["x-forwarded-for"] = opts.xff;
  const req = new Request("http://localhost/login", {
    method: "POST",
    body: JSON.stringify({ apiKey: opts.key ?? "wrong-key" }),
    headers,
  });
  // Bun leaves req.ip undefined on constructed Requests; shadow it so the
  // "direct socket peer" side of the resolution rule is testable.
  if (opts.peer !== undefined) Object.defineProperty(req, "ip", { value: opts.peer });
  return req;
}

function mustParse(value: string): TrustedProxy {
  const p = parseTrustedProxy(value);
  if (!p) throw new Error(`parseTrustedProxy rejected ${JSON.stringify(value)} in test setup`);
  return p;
}

describe("resolveClientIp (trustedProxy resolution table)", () => {
  const v4net = mustParse("10.0.0.0/8");
  const v6net = mustParse("2001:db8::/32");

  const cases: Array<{
    name: string;
    opts: { peer?: string; xff?: string };
    trusted: TrustedProxy | null;
    expected: string;
  }> = [
    // trustedProxy unset: legacy semantics, preserved byte-for-byte.
    { name: "unset: peer only", opts: { peer: "198.51.100.9" }, trusted: null, expected: "198.51.100.9" },
    { name: "unset: peer wins over XFF", opts: { peer: "198.51.100.9", xff: "203.0.113.7" }, trusted: null, expected: "198.51.100.9" },
    { name: "unset: no peer -> first XFF entry (legacy, attacker-controlled; pinned honestly)", opts: { xff: "203.0.113.7, 198.51.100.4" }, trusted: null, expected: "203.0.113.7" },
    { name: "unset: no peer, no XFF -> unknown", opts: {}, trusted: null, expected: "unknown" },
    // trustedProxy set, direct peer inside the range.
    { name: "set: trusted peer, single hop", opts: { peer: "10.0.0.1", xff: "203.0.113.7" }, trusted: v4net, expected: "203.0.113.7" },
    { name: "set: multi-hop, trusted intermediates skipped right-to-left", opts: { peer: "10.0.0.1", xff: "203.0.113.7, 10.2.3.4, 10.5.6.7" }, trusted: v4net, expected: "203.0.113.7" },
    { name: "set: every hop trusted -> leftmost entry", opts: { peer: "10.0.0.1", xff: "10.9.9.9, 10.8.8.8" }, trusted: v4net, expected: "10.9.9.9" },
    { name: "set: trusted peer, no XFF -> peer", opts: { peer: "10.0.0.1" }, trusted: v4net, expected: "10.0.0.1" },
    // trustedProxy set, direct peer OUTSIDE the range: XFF is untrusted noise.
    { name: "set: untrusted peer -> XFF ignored, bucket = req.ip", opts: { peer: "198.51.100.2", xff: "203.0.113.7" }, trusted: v4net, expected: "198.51.100.2" },
    { name: "set: no req.ip -> XFF never believed", opts: { xff: "203.0.113.7" }, trusted: v4net, expected: "unknown" },
    // trustedProxy set, malformed XFF: never throws, deterministic.
    { name: "set: empty segments skipped", opts: { peer: "10.0.0.1", xff: "203.0.113.7, , 10.0.0.2" }, trusted: v4net, expected: "203.0.113.7" },
    { name: "set: trailing comma", opts: { peer: "10.0.0.1", xff: "203.0.113.7," }, trusted: v4net, expected: "203.0.113.7" },
    { name: "set: junk token never matches the range, kept verbatim as key", opts: { peer: "10.0.0.1", xff: "junk, 10.0.0.2" }, trusted: v4net, expected: "junk" },
    { name: "set: whitespace-only XFF -> peer", opts: { peer: "10.0.0.1", xff: "  " }, trusted: v4net, expected: "10.0.0.1" },
    // IPv6.
    { name: "set v6: trusted v6 peer resolves the client hop", opts: { peer: "2001:db8:dead::1", xff: "203.0.113.5" }, trusted: v6net, expected: "203.0.113.5" },
    { name: "set v4-in-v6: ::ffff-mapped peer matches a v4 CIDR", opts: { peer: "::ffff:10.0.0.1", xff: "203.0.113.5" }, trusted: v4net, expected: "203.0.113.5" },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(resolveClientIp(identityReq(c.opts), c.trusted)).toBe(c.expected);
    });
  }
});

describe("parseTrustedProxy", () => {
  const matchCases: Array<[value: string, probes: Array<[ip: string, expected: boolean]>]> = [
    [
      "10.0.0.0/8",
      [
        ["10.0.0.1", true],
        ["10.255.255.255", true],
        ["9.255.255.255", false],
        ["11.0.0.0", false],
        ["junk", false],
        ["", false],
        ["2001:db8::1", false], // family mismatch is never a match
      ],
    ],
    ["10.0.0.1", [["10.0.0.1", true], ["10.0.0.2", false]]], // bare v4 = /32
    ["::1", [["::1", true], ["::2", false], ["0::1", true], ["0:0:0:0:0:0:0:1", true]]], // bare v6 = /128; elision arithmetic
    [
      "2001:db8::/32",
      [
        ["2001:0db8:0000:1::5", true],
        ["2001:db9::1", false],
        ["2001:d7ff:ffff::", false],
      ],
    ],
    [
      "0.0.0.0/0",
      [
        ["1.2.3.4", true],
        ["255.255.255.255", true],
        ["2001:db8::1", false], // /0 is family-scoped; v6 needs ::/0
      ],
    ],
    [
      "::ffff:10.0.0.0/8",
      [["10.1.1.1", true], ["::ffff:10.1.1.1", true], ["11.1.1.1", false]],
    ],
    [
      // full-form literals and embedded v4 with 6 hex groups (8 groups total)
      "0:0:0:0:0:0:0:1",
      [["::1", true], ["::2", false]],
    ],
    [
      "1:2:3:4:5:6:1.2.3.4",
      [
        ["1:2:3:4:5:6:1.2.3.4", true],
        ["::ffff:1.2.3.4", false], // not v4-mapped; distinct 16-byte address
        ["1:2:3:4:5:7:1.2.3.4", false],
      ],
    ],
  ];

  for (const [value, probes] of matchCases) {
    it(`matches probes against ${value}`, () => {
      const p = mustParse(value);
      for (const [ip, expected] of probes) {
        expect(`${ip} -> ${p.matches(ip)}`).toBe(`${ip} -> ${expected}`);
      }
    });
  }

  it("rejects malformed values (null), so init can fail loudly", () => {
    const bad = [
      "not-an-ip", "10.0.0.256", "10.0.0", "1.2.3.4.5", // bad addresses
      "10.0.0.0/33", "2001:db8::/129", "10.0.0.0/", "/8", "10.0.0.1/0x8", "10.0.0.1/8/8", // bad prefixes
      "2001:db8:::1", "1:2:3:4:5:6:7:8:9", "fe80::1%eth0", ":: 1", // bad v6 forms
    ];
    for (const v of bad) {
      expect(`${v} -> ${parseTrustedProxy(v) === null}`).toBe(`${v} -> true`);
    }
    expect(parseTrustedProxy("   ")).toBeNull(); // blank = off; handled by the caller, not an error
  });

  it("createAuthMiddleware rejects a malformed trustedProxy at init, accepts empty", () => {
    expect(() =>
      createAuthMiddleware({ validateApiKey: async () => false, trustedProxy: "10.0.0.0/33" }),
    ).toThrow(/webui\.trustedProxy/);
    expect(() =>
      createAuthMiddleware({ validateApiKey: async () => false, trustedProxy: "yesterday" }),
    ).toThrow(/yesterday/);
    // Empty/unset is OFF, not an error.
    const mw = createAuthMiddleware({ validateApiKey: async () => false, trustedProxy: "" });
    mw.stopCleanup();
  });
});

describe("xff-without-trustedProxy warning", () => {
  function makeMw(trustedProxy?: string) {
    return createAuthMiddleware({
      validateApiKey: async (k) => k === "valid-api-key",
      tokenTtlMin: 1,
      trustedProxy,
    });
  }

  async function withWarnCapture(fn: () => Promise<void>): Promise<string[]> {
    const warnings: string[] = [];
    const loggerAny = logger as unknown as { warn: (msg: string) => void };
    const orig = loggerAny.warn;
    loggerAny.warn = (msg) => warnings.push(msg);
    try {
      await fn();
      return warnings;
    } finally {
      loggerAny.warn = orig;
    }
  }

  it("fires once across many proxied requests, never per request", async () => {
    const mw = makeMw(); // knob unset
    const warnings = await withWarnCapture(async () => {
      for (let i = 0; i < 3; i++) {
        await mw.loginHandler(identityReq({ peer: "198.51.100.2", xff: "203.0.113.7" }));
      }
      // A request without XFF adds nothing.
      await mw.loginHandler(identityReq({ peer: "198.51.100.2" }));
    });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("x-forwarded-for");
    expect(warnings[0]).toContain("webui.trustedProxy");
    mw.stopCleanup();
  });

  it("does not fire when trustedProxy is set", async () => {
    const mw = makeMw("198.51.100.0/24");
    const warnings = await withWarnCapture(async () => {
      await mw.loginHandler(identityReq({ peer: "198.51.100.2", xff: "203.0.113.7" }));
    });
    expect(warnings.length).toBe(0);
    mw.stopCleanup();
  });
});

describe("login throttle identity: shared-bucket fix (H-11)", () => {
  function makeMw(trustedProxy?: string) {
    return createAuthMiddleware({
      validateApiKey: async (k) => k === "valid-api-key",
      tokenTtlMin: 1,
      trustedProxy,
    });
  }

  async function failFive(mw: ReturnType<typeof makeMw>, peer: string, xff: string) {
    for (let i = 0; i < 5; i++) {
      expect((await mw.loginHandler(identityReq({ peer, xff }))).status).toBe(401);
    }
  }

  it("without the knob all proxied users share one bucket: A's probing locks out B", async () => {
    const mw = makeMw(); // legacy behavior, pinned as the failure mode
    try {
      await failFive(mw, "198.51.100.2", "203.0.113.7"); // A probes from behind the proxy
      // Innocent B arrives from the same proxy with the RIGHT key: the
      // bucket is the proxy IP, so B gets the 429 meant for A.
      const victim = await mw.loginHandler(
        identityReq({ peer: "198.51.100.2", xff: "203.0.113.8", key: "valid-api-key" }),
      );
      expect(victim.status).toBe(429);
    } finally {
      mw.stopCleanup();
    }
  });

  it("with the knob distinct XFF clients get independent buckets", async () => {
    const mw = makeMw("198.51.100.0/24");
    try {
      await failFive(mw, "198.51.100.2", "203.0.113.7"); // A is now locked...
      expect(
        (await mw.loginHandler(identityReq({ peer: "198.51.100.2", xff: "203.0.113.7", key: "valid-api-key" }))).status,
      ).toBe(429);
      // ...and B logs straight through: bucket = its own resolved client IP.
      expect(
        (await mw.loginHandler(identityReq({ peer: "198.51.100.2", xff: "203.0.113.8", key: "valid-api-key" }))).status,
      ).toBe(200);
    } finally {
      mw.stopCleanup();
    }
  });

  it("with the knob but an untrusted peer, per-attempt XFF rotation cannot dodge the lockout", async () => {
    const mw = makeMw("10.0.0.0/8");
    try {
      // Peer is outside the trusted range, so XFF is noise: every attempt
      // whatever it claims lands in the single real-peer bucket.
      for (let i = 0; i < 5; i++) {
        expect((await mw.loginHandler(identityReq({ peer: "198.51.100.9", xff: `203.0.113.${i}` }))).status).toBe(401);
      }
      expect(
        (await mw.loginHandler(identityReq({ peer: "198.51.100.9", xff: "203.0.113.250", key: "valid-api-key" }))).status,
      ).toBe(429);
    } finally {
      mw.stopCleanup();
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
