// Authentication middleware for WebSocket connections.
// Session token store with configurable TTL.
// The auth middleware is parameterized by a validateApiKey function,
// allowing the webui extension to supply its API key source.

import crypto from "node:crypto";

// ── Types ───────────────────────────────────────────────────────────────────

interface SessionEntry {
  createdAt: number;
  expiresAt: number;
}

interface AuthMiddlewareOptions {
  validateApiKey: (apiKey: string) => Promise<boolean>;
  tokenTtlMin?: number;
}

export interface AuthMiddleware {
  loginHandler: (req: Request) => Promise<Response>;
  validateToken: (token: string) => boolean;
  cleanup: () => void;
  startCleanup: () => void;
  stopCleanup: () => void;
}

/**
 * Create an authentication middleware instance.
 */
export function createAuthMiddleware({
  validateApiKey,
  tokenTtlMin = 1440,
}: AuthMiddlewareOptions): AuthMiddleware {
  const sessions = new Map<string, SessionEntry>(); // token → { createdAt, expiresAt }

  // Cleanup interval handle
  let cleanupInterval: ReturnType<typeof setInterval> | null = null;

  /**
   * POST /login handler.
   * Expects JSON body: { apiKey: "..." }
   * Returns { token } on success, 401 on failure.
   */
  async function loginHandler(req: Request): Promise<Response> {
    try {
      const body = (await req.json()) as { apiKey?: string };
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
   */
  function validateToken(token: string): boolean {
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
  function cleanup(): void {
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
  function startCleanup(): void {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(cleanup, 60_000);
  }

  /**
   * Stop periodic cleanup.
   */
  function stopCleanup(): void {
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
