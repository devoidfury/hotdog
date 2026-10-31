// Authentication middleware for WebSocket connections.
// Session tokens with TTL; validateApiKey is injected so the webui
// extension can supply its own API key source.

import crypto from "node:crypto";
import { logger } from "@utils/logger.ts";
import { ExtensionError } from "@core/error.ts";

// ── Login rate limiting ─────────────────────────────────────────────────────
// Per-IP barrier: after RATE_LIMIT_MAX_FAILURES consecutive failed attempts
// the IP is locked out for a 60 s base that doubles per further counted
// failure, capped at 15 min. Blocked (429) attempts count too: they slide
// lastFailedAt, so active probing extends the lockout and escalates the
// ladder toward the lifetime cap. Once an IP racks up
// RATE_LIMIT_LIFETIME_CAP_FAILURES counted attempts inside the entry TTL it
// stays locked until the entry ages out (24 h without a counted attempt).
// A successful login resets the entry. The sliding lastFailedAt keeps
// actively-probed entries alive against cleanup(); idle ones age out.

const RATE_LIMIT_MAX_FAILURES = 5;
const RATE_LIMIT_BASE_LOCKOUT_MS = 60_000;
const RATE_LIMIT_MAX_LOCKOUT_MS = 15 * 60_000;
const RATE_LIMIT_ENTRY_TTL_MS = 24 * 60 * 60_000;
const RATE_LIMIT_LIFETIME_CAP_FAILURES = 100;
// The login body is { apiKey }; anything bigger is not a login.
const MAX_LOGIN_BODY_BYTES = 8192;

interface RateLimitEntry {
  failures: number;
  lastFailedAt: number;
}

interface SessionEntry {
  createdAt: number;
  expiresAt: number;
}

function lockoutRemainingMs(
  entry: RateLimitEntry,
  now: number,
): number {
  if (entry.failures < RATE_LIMIT_MAX_FAILURES) return 0;
  if (entry.failures >= RATE_LIMIT_LIFETIME_CAP_FAILURES) {
    // Lifetime cap reached: locked until the entry ages out past its TTL.
    return Math.max(0, entry.lastFailedAt + RATE_LIMIT_ENTRY_TTL_MS - now);
  }
  const excess = entry.failures - (RATE_LIMIT_MAX_FAILURES - 1); // 1 at the threshold
  const lockout = Math.min(
    RATE_LIMIT_BASE_LOCKOUT_MS * 2 ** (excess - 1),
    RATE_LIMIT_MAX_LOCKOUT_MS,
  );
  return Math.max(0, entry.lastFailedAt + lockout - now);
}

// ── Client identity resolution (webui.trustedProxy, H-11) ─────────────────
// The throttle keys on the string resolveClientIp returns, so that
// resolution is a security decision: behind a reverse proxy req.ip is the
// proxy and every user shares one bucket (one probing client escalates the
// lockout ladder for everyone); trusting x-forwarded-for unconditionally
// makes the key spoofable. The trustedProxy knob (resolved by the webui
// server from webui.trustedProxy; empty = off) states which direct peer may
// be believed.

/** A parsed webui.trustedProxy value: an IP (=/32 or /128) or a CIDR. */
export interface TrustedProxy {
  matches(ip: string): boolean;
}

/**
 * Textual IPv4/IPv6 address → network-order bytes (4 or 16). IPv4-mapped
 * IPv6 (::ffff:a.b.c.d) normalizes to 4 bytes so both spellings of one v4
 * address compare equal. Ceilings, stated honestly: zone ids (fe80::1%eth0)
 * are rejected, and a dotted quad inside an IPv6 literal is only expanded in
 * trailing position. Unparseable input returns null; this never throws.
 */
function parseIpBytes(text: string): Uint8Array | null {
  const t = text.trim();
  if (!t) return null;

  if (!t.includes(":")) {
    const parts = t.split(".");
    if (parts.length !== 4) return null;
    const v4 = new Uint8Array(4);
    for (let i = 0; i < 4; i++) {
      const p = parts[i]!;
      if (!/^\d{1,3}$/.test(p)) return null;
      const n = Number(p);
      if (n > 255) return null;
      v4[i] = n;
    }
    return v4;
  }

  // IPv6: at most one "::" elision.
  const elision = t.indexOf("::");
  if (elision !== -1 && t.indexOf("::", elision + 1) !== -1) return null;
  const head = parseIpv6Groups(elision === -1 ? t : t.slice(0, elision));
  if (head === null) return null;
  // Empty tail is legal; null from parseIpv6Groups means malformed.
  const tail = elision === -1 ? [] : parseIpv6Groups(t.slice(elision + 2));
  if (tail === null) return null;
  // No elision: exactly 8 groups. With elision: "::" must stand for at
  // least one zero group, so head + tail ≤ 7.
  if (elision === -1 ? head.length !== 8 : head.length + tail.length > 7) return null;

  const bytes = new Uint8Array(16);
  const put = (groups: number[], atEnd: boolean) => {
    const base = atEnd ? 16 - groups.length * 2 : 0;
    groups.forEach((g, i) => {
      bytes[base + i * 2] = g >> 8;
      bytes[base + i * 2 + 1] = g & 0xff;
    });
  };
  put(head, false);
  put(tail, true); // empty tail (no elision) is a no-op

  if (
    bytes.subarray(0, 10).every((b) => b === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return bytes.slice(12); // v4-mapped → plain v4
  }
  return bytes;
}

/** 1–8 hex groups (1–4 digits each); a trailing dotted quad counts as two groups. */
function parseIpv6Groups(text: string): number[] | null {
  if (text === "") return [];
  const parts = text.split(":");
  const out: number[] = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.includes(".")) {
      if (i !== parts.length - 1) return null;
      const v4 = parseIpBytes(p);
      if (v4 === null) return null;
      out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
    } else {
      if (!/^[0-9a-fA-F]{1,4}$/.test(p)) return null;
      out.push(parseInt(p, 16));
    }
  }
  return out;
}

/**
 * Parse a webui.trustedProxy value: a bare IP (treated as /32 for v4, /128
 * for v6) or "addr/prefix" (0–32 for v4, 0–128 for v6; host bits in the
 * network part are ignored). Returns null when malformed; callers that must
 * not accept silence (extension init) turn null into a config error
 * themselves. A v4-mapped network (::ffff:10.0.0.0/8) normalizes to plain
 * v4, so prefixes above /32 are malformed.
 */
export function parseTrustedProxy(value: string): TrustedProxy | null {
  const v = value.trim();
  if (!v) return null;
  const slash = v.indexOf("/");
  const net = parseIpBytes(slash === -1 ? v : v.slice(0, slash));
  if (net === null) return null;
  const bits = net.length * 8;
  let prefix = bits;
  if (slash !== -1) {
    const p = v.slice(slash + 1);
    if (!/^\d{1,3}$/.test(p)) return null;
    prefix = Number(p);
    if (prefix > bits) return null;
  }
  return {
    matches(ip: string): boolean {
      const probe = parseIpBytes(ip);
      if (probe === null || probe.length !== net.length) return false;
      let remaining = prefix;
      for (let i = 0; i < net.length && remaining > 0; i++) {
        const mask = remaining >= 8 ? 0xff : (0xff << (8 - remaining)) & 0xff;
        if ((probe[i]! & mask) !== (net[i]! & mask)) return false;
        remaining -= Math.min(8, remaining);
      }
      return true;
    },
  };
}

/**
 * Resolve the login-throttle key for a request.
 *
 * - trustedProxy unset (legacy semantics, preserved for the no-proxy case):
 *   req.ip when present, else the first x-forwarded-for entry, else "unknown".
 * - set, and the direct peer (req.ip) matches the trusted range: scan
 *   x-forwarded-for right-to-left and return the first entry outside the
 *   range (intermediate trusted hops are skipped); if every entry is
 *   trusted, the leftmost; with no header, the peer itself.
 * - set but the peer does not match (or req.ip is unavailable):
 *   x-forwarded-for is untrusted noise and ignored entirely -- per-attempt
 *   XFF rotation collapses onto the one real-peer bucket. Misconfiguring in
 *   this direction fails safe (shared bucket, never spoof-driven bypass).
 *
 * Unparseable entries never match the range and are returned verbatim as
 * keys: deterministic, and a junk token cannot masquerade as a trusted hop.
 */
export function resolveClientIp(
  req: Request,
  trusted: TrustedProxy | null,
): string {
  const peer = (req as Request & { ip?: string }).ip;
  const xff = req.headers.get("x-forwarded-for");
  if (!trusted) {
    if (peer) return peer;
    const first = xff?.split(",")[0]?.trim();
    if (first) return first;
    return "unknown";
  }
  if (!peer || !trusted.matches(peer)) return peer || "unknown";
  if (!xff) return peer;
  const hops = xff
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h !== "");
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trusted.matches(hops[i]!)) return hops[i]!;
  }
  return hops.length > 0 ? hops[0]! : peer;
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
  /** Resolved webui.trustedProxy: an IP or CIDR, or ""/unset to disable. */
  trustedProxy?: string;
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
  trustedProxy,
}: AuthMiddlewareOptions): AuthMiddleware {
  // A malformed trustedProxy fails loudly at init: silently falling back to
  // "trust nothing" would leave the operator thinking the proxy is believed.
  let trusted: TrustedProxy | null = null;
  if (trustedProxy && trustedProxy.trim() !== "") {
    trusted = parseTrustedProxy(trustedProxy);
    if (!trusted) {
      throw ExtensionError.ConfigFailed(
        "webui",
        `Invalid webui.trustedProxy "${trustedProxy}": expected an IP address ` +
          `or CIDR (e.g. "203.0.113.10" or "10.0.0.0/8").`,
      );
    }
  }

  // One proxy-looking header is enough to tell the operator the throttle is
  // mis-keyed; repeating it per request would turn a probe into a log flood.
  let xffWarned = false;
  function warnXffWithoutTrustedProxy(): void {
    if (xffWarned) return;
    xffWarned = true;
    logger.warn(
      "[auth] x-forwarded-for received but webui.trustedProxy is unset -- " +
        "the login throttle keys on the direct peer: behind a reverse proxy " +
        "every user shares one bucket, so a single probing client escalates " +
        "the lockout ladder (up to the 24h cap) for all of them. The header " +
        "is ignored unless the socket peer is unknown. " +
        "Set webui.trustedProxy to the proxy's IP or CIDR. (warned once)",
    );
  }

  const sessions = new Map<string, SessionEntry>();
  const rateLimits = new Map<string, RateLimitEntry>();
  let cleanupInterval: ReturnType<typeof setInterval> | null = null;

  function recordFailure(ip: string, now: number): void {
    const entry = rateLimits.get(ip) || { failures: 0, lastFailedAt: now };
    entry.failures++;
    entry.lastFailedAt = now;
    rateLimits.set(ip, entry);
  }

  /** POST /login — expects JSON { apiKey }; returns { token } (401 on bad key, 413 on oversize body, 429 when rate-limited). */
  async function loginHandler(req: Request): Promise<Response> {
    const hasXff = req.headers.get("x-forwarded-for") !== null;
    if (hasXff && !trusted) warnXffWithoutTrustedProxy();
    const ip = resolveClientIp(req, trusted);
    const now = Date.now();

    const entry = rateLimits.get(ip);
    if (entry) {
      const remaining = lockoutRemainingMs(entry, now);
      if (remaining > 0) {
        // Blocked attempts still count: probing slides the lockout end and
        // escalates the ladder toward the lifetime cap.
        entry.failures++;
        entry.lastFailedAt = now;
        return Response.json(
          { error: "Too many failed login attempts. Try again later." },
          {
            status: 429,
            headers: { "Retry-After": String(Math.ceil(remaining / 1000)) },
          },
        );
      }
    }

    // Reject oversize bodies before reading them (an oversize request is
    // not an auth failure, so it neither records nor resets anything).
    const declared = Number(req.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_LOGIN_BODY_BYTES) {
      return Response.json({ error: "Request body too large" }, { status: 413 });
    }

    let response: Response;
    try {
      const text = await req.text();
      // Chunked bodies arrive without a content-length; catch them here.
      if (text.length > MAX_LOGIN_BODY_BYTES) {
        return Response.json({ error: "Request body too large" }, { status: 413 });
      }
      const body = JSON.parse(text) as { apiKey?: string };
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
