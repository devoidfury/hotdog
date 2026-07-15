// Tests for websocket/auth.ts — authentication middleware for WebSocket connections.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { createAuthMiddleware } from "../../src/extensions/websocket/auth.ts";

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

        // Wait a moment for token to expire
        await new Promise((r) => setTimeout(r, 10));

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

        // Wait for expiration
        await new Promise((r) => setTimeout(r, 10));

        // Token should be invalid
        expect(shortLived.validateToken(data.token)).toBe(false);

        // Cleanup should remove it
        shortLived.cleanup();
        expect(shortLived.validateToken(data.token)).toBe(false);
      } finally {
        shortLived.stopCleanup();
      }
    });
  });

  describe("startCleanup / stopCleanup", () => {
    it("startCleanup starts periodic cleanup", () => {
      middleware.startCleanup();
      // Should not throw
      middleware.startCleanup(); // idempotent
      middleware.stopCleanup();
    });

    it("stopCleanup stops periodic cleanup", () => {
      middleware.startCleanup();
      middleware.stopCleanup();
      // Should not throw
      middleware.stopCleanup(); // idempotent
    });
  });
});
