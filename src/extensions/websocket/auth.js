// Authentication middleware for WebSocket connections.
// Session token store with configurable TTL.
// The auth middleware is parameterized by a validateApiKey function,
// allowing the webui extension to supply its API key source.

import crypto from "node:crypto";

/**
 * Create an authentication middleware instance.
 *
 * @param {Object} options
 * @param {Function} options.validateApiKey - Async function(apiKey) => boolean
 * @param {number} options.tokenTtlMin - Token time-to-live in minutes (default: 1440 / 24h)
 * @returns {Object} Auth middleware with loginHandler, validateToken, cleanup
 */
export function createAuthMiddleware({ validateApiKey, tokenTtlMin = 1440 }) {
  const sessions = new Map(); // token → { createdAt, expiresAt }

  // Cleanup interval handle
  let cleanupInterval = null;

  /**
   * POST /login handler.
   * Expects JSON body: { apiKey: "..." }
   * Returns { token } on success, 401 on failure.
   */
  async function loginHandler(req) {
    try {
      const body = await req.json();
      const apiKey = body?.apiKey || "";

      if (!apiKey || typeof apiKey !== "string") {
        return Response.json({ error: "API key required" }, { status: 401 });
      }

      const valid = await validateApiKey(apiKey);
      if (!valid) {
        return Response.json({ error: "Invalid API key" }, { status: 401 });
      }

      // Generate session token
      const token = crypto.randomUUID();
      const now = Date.now();
      sessions.set(token, {
        createdAt: now,
        expiresAt: now + tokenTtlMin * 60 * 1000,
      });

      return Response.json({ token });
    } catch {
      return Response.json({ error: "Invalid request body" }, { status: 400 });
    }
  }

  /**
   * Validate a session token.
   * @param {string} token
   * @returns {boolean} true if token exists and is not expired
   */
  function validateToken(token) {
    if (!token || typeof token !== "string") return false;
    const session = sessions.get(token);
    if (!session) return false;
    if (Date.now() > session.expiresAt) {
      sessions.delete(token);
      return false;
    }
    return true;
  }

  /**
   * Remove expired tokens from the store.
   */
  function cleanup() {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (now > session.expiresAt) {
        sessions.delete(token);
      }
    }
  }

  /**
   * Start periodic cleanup (runs every minute).
   */
  function startCleanup() {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(cleanup, 60_000);
  }

  /**
   * Stop periodic cleanup.
   */
  function stopCleanup() {
    if (cleanupInterval) {
      clearInterval(cleanupInterval);
      cleanupInterval = null;
    }
  }

  return {
    loginHandler,
    validateToken,
    cleanup,
    startCleanup,
    stopCleanup,
  };
}
