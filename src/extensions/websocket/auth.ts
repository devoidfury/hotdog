// Authentication middleware for WebSocket connections.
// Session tokens with TTL; validateApiKey is injected so the webui
// extension can supply its own API key source.

import crypto from "node:crypto";

// ── Login rate limiting ─────────────────────────────────────────────────────
// Per-IP: once an IP has accumulated RATE_LIMIT_MAX_FAILURES consecutive
// failed attempts it is locked out. Each further failure (observed after a
// lockout expires) doubles the next lockout, capped. A successful login
// resets the counter for that IP. Blocked (429) attempts do not count.

const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_BASE_LOCKOUT_MS = 1_000;
const RATE_LIMIT_MAX_LOCKOUT_MS = 15 * 60_000;
const RATE_LIMIT_ENTRY_TTL_MS = 24 * 60 * 60_000;

interface RateLimitEntry {
  failures: number;
  lastFailedAt: number;
}

interface SessionEntry {
  createdAt: number;
  expiresAt: number;
}

export function lockoutRemainingMs(
  entry: RateLimitEntry,
  now: number,
): number {
  if (entry.failures < RATE_LIMIT_MAX_FAILURES) return 0;
  const excess = entry.failures - (RATE_LIMIT_MAX_FAILURES - 1); // 1 at the threshold
  const lockout = Math.min(
    RATE_LIMIT_BASE_LOCKOUT_MS * 2 ** (excess - 1),
    RATE_LIMIT_MAX_LOCKOUT_MS,
  );
  return Math.max(0, entry.lastFailedAt + lockout - now);
}

/**
 * Resolve the client IP for rate limiting.
 * Bun.serve populates req.ip with the peer address. Behind a reverse proxy
 * the first x-forwarded-for entry is used (client-controllable without a
 * trusted proxy, so treat this as a best-effort throttle, not a barrier).
 */
function clientIp(req: Request): string {
  const ip = (req as Request & { ip?: string }).ip;
  if (ip) return ip;
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const first = xff.split(",")[0]?.trim();
    if (first) return first;
  }
  return "unknown";
}

/**
 * Constant-time API key comparison.
 * Both keys are hashed first so the comparison never leaks key length.
 */
export function apiKeyEquals(provided: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(provided).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
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

export function createAuthMiddleware({
  validateApiKey,
  tokenTtlMin = 1440,
}: AuthMiddlewareOptions): AuthMiddleware {
  const sessions = new Map<string, SessionEntry>();
  const rateLimits = new Map<string, RateLimitEntry>();
  let cleanupInterval: ReturnType<typeof setInterval> | null = null;

  function recordFailure(ip: string, now: number): void {
    const entry = rateLimits.get(ip) || { failures: 0, lastFailedAt: now };
    entry.failures++;
    entry.lastFailedAt = now;
    rateLimits.set(ip, entry);
  }

  /** POST /login — expects JSON { apiKey }; returns { token } (401 on bad key, 429 when rate-limited). */
  async function loginHandler(req: Request): Promise<Response> {
    const ip = clientIp(req);
    const now = Date.now();

    const entry = rateLimits.get(ip);
    if (entry) {
      const remaining = lockoutRemainingMs(entry, now);
      if (remaining > 0) {
        return Response.json(
          { error: "Too many failed login attempts. Try again later." },
          {
            status: 429,
            headers: { "Retry-After": String(Math.ceil(remaining / 1000)) },
          },
        );
      }
    }

    let response: Response;
    try {
      const body = (await req.json()) as { apiKey?: string };
      const apiKey = body?.apiKey || "";

      if (!apiKey || typeof apiKey !== "string") {
        response = Response.json({ error: "API key required" }, { status: 401 });
      } else {
        const valid = await validateApiKey(apiKey);
        if (!valid) {
          response = Response.json({ error: "Invalid API key" }, { status: 401 });
        } else {
          const token = crypto.randomUUID();
          sessions.set(token, {
            createdAt: now,
            expiresAt: now + tokenTtlMin * 60 * 1000,
          });
          response = Response.json({ token });
        }
      }
    } catch {
      response = Response.json({ error: "Invalid request body" }, { status: 400 });
    }

    if (response.status >= 400) {
      recordFailure(ip, now);
    } else {
      rateLimits.delete(ip);
    }
    return response;
  }

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

  function cleanup(): void {
    const now = Date.now();
    for (const [token, session] of sessions) {
      if (now > session.expiresAt) {
        sessions.delete(token);
      }
    }
    for (const [ip, entry] of rateLimits) {
      if (now - entry.lastFailedAt > RATE_LIMIT_ENTRY_TTL_MS) {
        rateLimits.delete(ip);
      }
    }
  }

  function startCleanup(): void {
    if (cleanupInterval) return;
    cleanupInterval = setInterval(cleanup, 60_000);
  }

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
