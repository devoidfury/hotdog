import { createWsServer, type CreateWsServerOptions } from "../websocket/server.ts";
import { canonEqual, registerConfigApplyHook } from "@core/config/apply-hooks.ts";
import { registerConfigAuditSurface } from "@core/config/audit.ts";
import { Message } from "@core/context/message.ts";
import { S2C } from "../websocket/protocol.ts";
import { wsMaxPayloadBytes } from "../websocket/constants.ts";
import { uploadLimits } from "@core/config/upload-limits.ts";
import { assertTrustedProxy, apiKeyEquals, createAuthRef, type AuthRef } from "../websocket/auth.ts";
import { upgradeOriginAllowed, isLoopbackHost } from "../websocket/origin.ts";
import { DDG_SOLVE_SERVICE } from "../web-search/index.ts";
import { isSafeSessionId, sessionPath } from "@core/session/session-log.ts";
import { logger } from "@utils/logger.ts";
import { CoreContext } from "@core/extensions/types.ts";

import { ExtensionError, formatError } from "@core/error.ts";
import { ProfileManager, type ProfileDef } from "@core/config/index.ts";
import { BunRequest } from "bun";

// special bun import that transpiles and serves all linked assets,
// see https://bun.com/docs/bundler/loaders.md
import webuiFrontend from "./ui/index.html";

interface WebuiWsData {
  url: string;
}

// Transport frame cap for upgraded sockets: wsMaxPayloadBytes() is derived
// from the resolved uploadLimits.maxImageSize ceiling (root config; legacy
// fileAttachment alias) -- the same value the upload path enforces (single
// source, see websocket/constants.ts). The bound is applied below on the
// `websocket:` handler because Bun's root-level maxPayloadLength is ignored
// in 1.4.2.

export interface WebuiConfig {
  port?: number;
  host?: string;
  apiKey?: string | null;
  sessionTokenTtlMin?: number;
  /** Reverse proxy IP/CIDR whose x-forwarded-for the login throttle may believe. "" = off. */
  trustedProxy?: string;
}

/** What a rebind answers: the port the listener holds afterwards, plus the
 *  refusal reason when it could not move (and the old listener came back). */
export interface WebuiRebindResult {
  ok: boolean;
  port: number;
  error?: string;
}

/** How long the deferred rebind waits after the write's reply has been handed
 *  to the socket, so the reply is on the wire before a forced close. Two event
 *  loop turns is more than a frame write needs; the panel reconnecting on the
 *  new port arrives a moment later, which is what its "expect a brief drop"
 *  notice already promised. */
const REBIND_FLUSH_GRACE_MS = 25;

interface WebuiServerResult {
  /** The listener in force. A rebind REPLACES it, so read it through the getter. */
  readonly server: ReturnType<typeof Bun.serve>;
  readonly wsServer: ReturnType<typeof createWsServer>;
  /** The auth facade: every consumer resolves the CURRENT policy per request,
   *  so a rebuild reaches the routes, the websocket AUTH chain and the upgrade
   *  check at once (see ../websocket/auth.ts, AuthRef). */
  readonly authMiddleware: AuthRef;
  /**
   * Move the listener to the port the config store holds right now, rebuilding
   * the transport frame cap from the live uploadLimits on the way (the cap has
   * no setter: it is fixed when Bun builds the handler, so a rebind is the
   * moment every serve-time posture gets recomputed).
   *
   * The old listener is closed, not drained: a port move IS a brief drop, and
   * the caller only schedules this AFTER the write's reply has been written to
   * the socket (the reply-first ordering the webui.port row documents).
   *
   * A failed bind re-listens the port it came from: leaving the panel dark
   * because a new port was refused is worse than the old posture, and the
   * refusal is what the caller reports.
   */
  rebind(): Promise<WebuiRebindResult>;
  /** Stop the listener and release everything this host registered process
   *  wide (live-config hooks, the audit surface, the auth sweep). Idempotent. */
  dispose(): void;
}

/**
 * Attach Bun's direct socket peer address to a login request as `req.ip`
 * -- the field the login throttle resolves its key from (websocket/auth.ts,
 * resolveClientIp).
 *
 * Version-specific reality, verified on the pinned bun 1.4.2: serve
 * requests carry NO peer address of their own -- `req.ip` is never
 * populated and `proxy: true` is a silent no-op (the 1.4 Rust rewrite
 * dropped the Zig-era forwarded-header/PROXY-protocol mode; bun-types
 * 1.4.3 declares neither). `server.requestIP(req)` is the only peer
 * primitive, and unlike `x-forwarded-for` it cannot be spoofed by the
 * client. This is a shim at the login route, not a server-wide
 * forwarded-header mode.
 *
 * Guarded: an existing `req.ip` is never overwritten, so a future Bun
 * that populates it natively wins automatically.
 */
export function attachSocketPeerIp(
  req: Request,
  peer: string | null | undefined,
): void {
  const keyed = req as Request & { ip?: string };
  if (keyed.ip === undefined && peer) keyed.ip = peer;
}

/** Did a write under the webui root actually move the auth policy? The hook
 *  match is root-granular, so a webui.port write lands in the "webui" hook
 *  rows too; without this guard a port change would rebuild the middleware (and
 *  an idle-flag reset would warn the operator twice about the same proxy). */
function authBlockMoved(current: WebuiConfig, candidate: WebuiConfig): boolean {
  return describeAuthSwap(current, candidate).length > 0;
}

/**
 * The secret-free audit summary of an auth swap, one clause per moved field.
 * Nothing here echoes a value the file treats as sensitive: the credential is
 * reported as replaced/set, and webui.trustedProxy -- an address the throttle
 * trusts, which is worth knowing the moment it changes -- is likewise reported
 * as changed without its bytes. The TTL is a duration, not a secret, so it
 * prints. Callers treat an empty array as "nothing this row owns moved".
 */
function describeAuthSwap(current: WebuiConfig, candidate: WebuiConfig): string[] {
  const moved: string[] = [];
  if (!canonEqual(current.apiKey, candidate.apiKey)) {
    moved.push("login credential replaced (value not shown)");
  }
  if (!canonEqual(current.sessionTokenTtlMin, candidate.sessionTokenTtlMin)) {
    const ttl = candidate.sessionTokenTtlMin ?? 1440;
    moved.push(`session token TTL now ${ttl} min (stamped on the next issuance; tokens already issued keep their expiry)`);
  }
  if (!canonEqual(current.trustedProxy, candidate.trustedProxy)) {
    const set = typeof candidate.trustedProxy === "string" && candidate.trustedProxy.trim() !== "";
    moved.push(set ? "trustedProxy changed (value not shown)" : "trustedProxy cleared: x-forwarded-for is no longer believed");
  }
  return moved;
}

export async function createWebuiServer(
  core: CoreContext,
  config: WebuiConfig,
  // Host/test seam: an embedded host (or an integration test) can supply its
  // own agent factory instead of the resolved config's default one.
  options: Pick<CreateWsServerOptions, "buildAgent"> = {},
): Promise<WebuiServerResult> {
  const { port, host, apiKey, sessionTokenTtlMin, trustedProxy } = config;

  // The frame bound an upgraded socket gets, derived from the resolved image
  // ceiling the upload path enforces (see wsMaxPayloadBytes). A FUNCTION, on
  // purpose: Bun fixes maxPayloadLength when it builds the handler, so the
  // only way a changed uploadLimits.maxImageSize can reach the transport is to
  // recompute it every time a listener is built -- which is what a rebind does.
  const frameBound = (): number => wsMaxPayloadBytes(uploadLimits(core).maxImageSize);

  // The live webui block: the store's CURRENT generation when this host has a
  // store (the normal `hotdog webui` path), the boot bag otherwise (embedded
  // hosts and tests hand the server a plain config object). Every serve-time
  // posture a rebind recomputes reads through here, so the rebind honors the
  // file the transaction just published rather than the bytes booted with.
  const liveWebui = (): WebuiConfig => {
    const block = (core.configStore?.current().config as Record<string, unknown> | undefined)
      ?.webui as WebuiConfig | undefined;
    return block ?? config;
  };

  if (!apiKey) {
    throw ExtensionError.ConfigFailed(
      "webui",
      "No API key configured. Set webui.apiKey in config or HOTDOG_WEBUI_API_KEY env var.",
    );
  }

  // trustedProxy is validated when the policy is built: a malformed CIDR throws
  // ExtensionError.ConfigFailed and fails the boot, rather than silently
  // falling back to "trust nothing". At runtime the same throw, one level up in
  // the prepare hook, refuses the write instead (assertTrustedProxy is the one
  // home for both readings).
  const authRef = createAuthRef({
    validateApiKey: async (key: string) => apiKeyEquals(key, apiKey),
    tokenTtlMin: sessionTokenTtlMin,
    trustedProxy,
  });

  const wsConfig = core.config?.websocket as
    Record<string, unknown> | undefined;
  let profileManager = core.resolved?.profileManager;
  // Fallback: create ProfileManager if not available (for tests/backward compat)
  if (!profileManager && core.resolved?.profilesPath) {
    profileManager = await ProfileManager.create(
      core.resolved.profilesPath as string,
      (core.resolved?.profiles as Record<string, ProfileDef>) || {},
    );
  }
  if (!profileManager) {
    throw ExtensionError.ConfigFailed(
      "webui",
      "profileManager not available. Check your configuration.",
    );
  }

  const profiles = profileManager.getProfilesForSwitch();
  logger.info(
    `[webui] Profiles available: ${Object.keys(profiles).join(", ") || "none"}`,
  );

  const wsServer = createWsServer(core, {
    // The FACADE, not an instance: the websocket AUTH chain and the upgrade
    // check resolve the current policy per request through it.
    auth: authRef,
    buildAgent: options.buildAgent,
    sessionTimeoutMin: wsConfig?.sessionTimeoutMin as number | undefined,
    questionTimeoutSecs: wsConfig?.questionTimeoutSecs as number | undefined,
    questionStrategy: wsConfig?.questionStrategy as string | undefined,
    profiles,
  });

  // Default to loopback if no host is configured (Bun.serve would bind all
  // interfaces otherwise), and warn on non-loopback binds: the API key and
  // session tokens travel in cleartext over plain HTTP, so exposing the
  // WebUI beyond localhost puts a live agent behind a shared-key check only.
  // The warning also names the throttle consequence of proxying WITHOUT
  // webui.trustedProxy: one shared login bucket, and probing by any client
  // escalates the lockout ladder (up to the 24h cap) for every user.
  const effectiveHost = host ?? "127.0.0.1";
  if (!isLoopbackHost(effectiveHost)) {
    logger.warn(
      `[webui] binding to non-loopback host '${effectiveHost}' -- ` +
        "reachable from other machines over unencrypted HTTP. " +
        "Use a tunnel or a TLS reverse proxy for remote access. " +
        "Behind a reverse proxy, set webui.trustedProxy to the proxy's IP " +
        "or CIDR: without it every user shares one login throttle bucket " +
        "and one probing client escalates the lockout ladder (up to 24h) " +
        "for everyone.",
    );
  }

  // With trustedProxy set, say what the server actually trusts and where
  // the peer comes from, so the arrangement is readable in the startup
  // log (bun 1.4.2 has no forwarded-header server mode to name instead).
  if (trustedProxy && trustedProxy.trim() !== "") {
    logger.info(
      `[webui] trustedProxy '${trustedProxy}': login throttle trusts ` +
        "x-forwarded-for only from that peer; the direct socket peer is " +
        "read per request via Bun's server.requestIP() at the /login " +
        "route (bun 1.4.2 exposes no req.ip and proxy:true is a no-op). " +
        "The reverse proxy must be the only way to reach this port and " +
        "must set X-Forwarded-For itself (e.g. nginx `proxy_set_header " +
        "X-Forwarded-For $remote_addr`, replacing any client-supplied " +
        "header).",
    );
  }

  authRef.startCleanup();
  wsServer.startCleanupLoop();

  // ── Session log export ──────────────────────────────────────────────────
  // GET /export/<sessionId> streams the raw JSONL as an attachment. The
  // client triggers it with a hidden-anchor click (a plain navigation), so
  // the session token rides as ?token= -- validated with exactly the
  // authMiddleware.validateToken check /verify applies; an unauthenticated
  // or wrong-token caller gets 401 before any log byte is touched. The id
  // goes through the core session-path helper, which enforces the id format
  // and the sessions-dir containment (no re-implementation here).
  const exportSessionLog = async (req: Request): Promise<Response> => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const url = new URL(req.url);
    // Token-in-query is accepted ONLY because the webui binds loopback by
    // default: query strings outlive the request (browser history, any
    // proxy/access log between client and server). If the bind story ever
    // changes (non-loopback without a TLS-terminating proxy), revisit this
    // -- header-only auth or a POST-download; the startup warning alone is
    // not the mitigation. The check itself is the same validateToken /verify
    // applies, before any log byte is read.
    const token = url.searchParams.get("token") ?? req.headers.get("x-hotdog-token") ?? "";
    if (!authRef.validateToken(token)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 });
    }
    const rawSegment = url.pathname.slice("/export/".length);
    let sessionId: string;
    try {
      sessionId = decodeURIComponent(rawSegment);
    } catch {
      return Response.json({ error: "Invalid session id" }, { status: 400 });
    }
    if (!isSafeSessionId(sessionId)) {
      return Response.json({ error: "Invalid session id" }, { status: 400 });
    }
    // The helper re-validates and refuses anything resolving outside the
    // sessions dir; a throw here can only mean the id was hostile.
    let path: string;
    try {
      path = sessionPath(sessionId);
    } catch (err) {
      logger.warn(`[webui] export rejected session id: ${formatError(err)}`);
      return Response.json({ error: "Invalid session id" }, { status: 400 });
    }
    const file = Bun.file(path);
    if (!(await file.exists())) {
      return Response.json({ error: "Session log not found" }, { status: 404 });
    }
    // The id passed the SESSION_ID_RE gate, so it cannot quote-break the
    // filename or carry separators.
    return new Response(file, {
      headers: {
        "Content-Type": "application/x-ndjson",
        "Content-Disposition": `attachment; filename="${sessionId}.jsonl"`,
      },
    });
  };

  // Optional extension routes: web-search mounts its DDG captcha solve page
  // here so challenges are solvable over the webui's existing port (and its
  // existing firewall/VPN reach) instead of a second server. The service is
  // unauthenticated by design: access control is the per-challenge nonce.
  const solveService = core.services.has(DDG_SOLVE_SERVICE)
    ? (core.services.get(DDG_SOLVE_SERVICE) as
        | { routes: Record<string, (req: Request) => Response | Promise<Response>>; setBaseUrl(url: string): void }
        | undefined)
    : undefined;

  const serveOn = (servePort: number | undefined, bound: number) => Bun.serve<WebuiWsData>({
    port: servePort,
    hostname: effectiveHost,
    routes: {
      "/": webuiFrontend,
      ...(solveService?.routes ?? {}),

      // Raw JSONL log download for the sidebar's Export (see exportSessionLog).
      "/export/*": exportSessionLog,

      "/verify": async function (req: BunRequest) {
        const token = req.headers.get("x-hotdog-token");
        // Through the facade: a policy rebuilt after a config write is what the
        // NEXT /verify answers with, no restart and no re-wiring.
        const valid = token ? authRef.validateToken(token) : false;
        return valid
          ? Response.json({ valid })
          : Response.json({ valid }, { status: 401 });
      },

      "/ws": async function (req: BunRequest) {
        // Same-origin gate BEFORE the upgrade: browsers always send Origin on
        // a WS handshake, so a foreign or missing one is a cross-site (or
        // DNS-rebound) page reaching for a live agent -- refuse it with a
        // plain 403. Host-policy semantics: ../websocket/origin.ts.
        if (!upgradeOriginAllowed(req.headers.get("origin"), req.headers.get("host"), effectiveHost)) {
          logger.warn(
            `[webui] refused cross-origin WS upgrade: origin=${req.headers.get("origin") ?? "(none)"} host=${req.headers.get("host") ?? "(none)"}`,
          );
          return Response.json(
            { error: "Forbidden: WebSocket upgrades are restricted to same-origin requests" },
            { status: 403 },
          );
        }
        // No token check at upgrade: the socket opens unauthenticated and
        // the websocket extension gates all non-AUTH traffic until the
        // first AUTH message validates (onUpgrade in ../websocket/server.ts,
        // routeMessage in ../websocket/message-routing.ts).
        // listenerRef, not the captured construction-time server: after a
        // rebind the route closure belongs to the NEW listener anyway, but the
        // indirection keeps the upgrade pointed at whatever is serving.
        const upgraded = listenerRef.current!.upgrade(req, {
          data: { url: req.url } as WebuiWsData,
        });
        if (!upgraded) {
          return Response.json({ error: "Upgrade failed" }, { status: 400 });
        }
      },
    },

    fetch: async function fetchHandler(
      req: Request,
      server: Bun.Server<WebuiWsData>,
    ): Promise<Response | void> {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (req.method === "POST" && pathname === "/login") {
        // Give the throttle its key: bun 1.4.2 populates no req.ip on
        // serve requests, so read the direct socket address from the
        // server (see attachSocketPeerIp). Unconditional, not gated on
        // trustedProxy -- with the real peer known, the legacy
        // first-x-forwarded-for fallback can no longer be steered.
        attachSocketPeerIp(req, server.requestIP(req)?.address);
        const loginResp = await authRef.loginHandler(req);
        return loginResp;
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      // Frame bound for upgraded sockets, passed in so a rebind can hand Bun a
      // freshly derived one (no setter exists after construction).
      maxPayloadLength: bound,
      open(ws) {
        const { url } = ws.data;
        wsServer.onUpgrade(
          { url: url || "", headers: { host: "localhost" } },
          ws,
        );
      },
      message(ws, data) {
        wsServer.onMessage(ws, data);
      },
      close(ws) {
        wsServer.onClose(ws);
      },
    },
  });

  // The listener this host is serving right now. `listenerRef` exists because
  // the /ws route closure needs to call upgrade() on whatever is CURRENT, and
  // a rebind swaps the object underneath it.
  const listenerRef: { current: ReturnType<typeof serveOn> | null } = { current: null };
  let disposed = false;

  const bind = (servePort: number | undefined, bound: number) => {
    const served = serveOn(servePort, bound);
    listenerRef.current = served;
    logger.info(`WebUI server listening on http://${effectiveHost}:${served.port}`);
    solveService?.setBaseUrl(`http://${effectiveHost}:${served.port}`);
    return served;
  };

  const firstPort = port ?? liveWebui().port;
  bind(firstPort, frameBound());

  // ── Live-config surface + hooks (only this serving host registers them) ───
  // The audit surface: every trust-change notice gets a durable line on each
  // live session's transcript (the session log is the audit trail a later reader
  // follows) and a systemMessage push so an open panel repaints now. Live
  // sessions are the right audience for every row this host can write: a new
  // endpoint, credential, throttle, gate rule or port changes what that
  // session does NEXT, and a change nobody in the room can see is exactly the
  // silent trust change the log line alone does not cover. Failures are per
  // session and loud: one dead agent must not swallow the others' notice, and
  // a sink that throws entirely is logged by the primitive itself.
  let auditSurfaceUnregister: (() => void) | null = registerConfigAuditSurface((text) => {
    const registry = wsServer.sessionRegistry;
    const notice = `[config-live] ${text}`;
    for (const row of registry.list()) {
      const sid = row.id;
      try {
        const session = registry.get(sid);
        session?.agent?.addMessage(
          new Message({
            role: "harness",
            source: "harness",
            content: [{ type: "system-notice", text: notice }],
          }),
        );
        registry.broadcastScoped(sid, { type: S2C.SYSTEM_MESSAGE, sessionId: sid, content: notice });
      } catch (e: unknown) {
        logger.error(
          `[webui] config-live surface notice failed for session ${sid}: ${formatError(e)} -- logged, not swallowed`,
        );
      }
    }
  });

  // The unregister closures live in one array so dispose() drains them all;
  // registration happens HERE, at serve time, so a process that never served
  // the webui has no webui hook and answers a webui write honestly.
  const liveHookUnregisters: Array<() => void> = [];
  // The deferred rebind, so a shutdown between the reply and the move cancels
  // the move rather than binding a listener nobody owns any more.
  let rebindTimer: ReturnType<typeof setTimeout> | null = null;

  // webui.port: the rebind, ordered reply-first (see the deferral below).
  liveHookUnregisters.push(
    registerConfigApplyHook({
      keyPath: "webui.port",
      phase: "apply",
      handle: (ctx, previous, next) => {
        if (canonEqual(previous, next)) return; // sibling write under the same root
        // Reply first, move second. This hook runs INSIDE the write
        // transaction, which is before the handler's reply is ever composed, so
        // the move is deferred past the reply's own turn: the panel gets
        // {applied: "rebind", "expect a brief drop"} and only then loses the
        // socket it read that on. A microtask would not achieve it -- the reply
        // is written in a continuation of the same await chain, so the deferral
        // has to outlive the current turn, and REBIND_FLUSH_GRACE_MS is what
        // keeps the forced close from discarding a frame still in the buffer.
        // The outcome of the move lands on the audit log either way; a refusal
        // also decorates the store's degraded list, which is what the next
        // snapshot's row renders.
        rebindTimer = setTimeout(() => {
          void (async () => {
            const outcome = await rebind();
            if (outcome.ok) {
              ctx.notice(
                `webui.port: listening on ${outcome.port} now (was ${previous}); the frame cap was recomputed from the live upload limits, connected sockets dropped and reconnect on the new port`,
              );
            } else {
              // The reply already promised a move that did not happen, and the
              // socket that could correct it is the one in question -- so the
              // durable truth rides the generation: this is what the NEXT
              // snapshot's row renders. Every failure decorates it, including
              // the recovery case (the store now holds a port the listener is
              // NOT on, which is precisely the mismatch a reader must see).
              try {
                ctx.store.reportDegraded({
                  keyPath: "webui.port",
                  why: `${outcome.error ?? "rebind failed"} -- the store holds port ${String(next)}, the listener does not`,
                });
              } catch (e: unknown) {
                logger.error(`[webui] reportDegraded failed: ${formatError(e)}`);
              }
              ctx.notice(
                `webui.port: REBIND DID NOT LAND -- ${outcome.error ?? "no reason given"}; the store holds the new port, the listener does not${outcome.port ? ` (still answering on ${outcome.port})` : ""}`,
              );
            }
          })();
        }, REBIND_FLUSH_GRACE_MS);
      },
    }),
  );

  // The auth trio (webui.apiKey / sessionTokenTtlMin / webui.trustedProxy)
  // shares ONE hook keyPath: the middleware instance is one object, so one
  // prepare+apply pair reads the whole candidate block instead of three rows
  // rebuilding over each other. PREPARE validates the candidate exactly the way
  // boot does -- a blank key and a malformed CIDR refuse the swap here rather
  // than at the next start, and the running middleware stays in service.
  liveHookUnregisters.push(
    registerConfigApplyHook({
      keyPath: "webui",
      phase: "prepare",
      handle: (_ctx, previous, next) => {
        const candidate = (next ?? {}) as WebuiConfig;
        const current = (previous ?? {}) as WebuiConfig;
        if (!authBlockMoved(current, candidate)) return; // port/host-only write
        const key = candidate.apiKey;
        if (key === null || key === undefined || (typeof key === "string" && key.trim() === "")) {
          // Boot refuses to serve without a key; a runtime write must not put
          // the running server into the state boot would have refused.
          throw new Error(
            "webui.apiKey is empty: refusing to drop the credential of a running server (set a new key, or unset the key and restart)",
          );
        }
        // Same message boot prints for the same mistake; the reply carries it
        // verbatim while the old middleware keeps serving.
        assertTrustedProxy(candidate.trustedProxy);
        const ttl = candidate.sessionTokenTtlMin;
        if (ttl !== undefined && (!Number.isFinite(ttl) || ttl <= 0)) {
          throw new Error(`invalid webui.sessionTokenTtlMin ${JSON.stringify(ttl)}`);
        }
      },
    }),
  );

  liveHookUnregisters.push(
    registerConfigApplyHook({
      keyPath: "webui",
      phase: "apply",
      handle: (ctx, previous, next) => {
        const candidate = (next ?? {}) as WebuiConfig;
        const current = (previous ?? {}) as WebuiConfig;
        const moved = describeAuthSwap(current, candidate);
        if (moved.length === 0) return;
        // The swap: new POLICY over the SAME sessions, throttle buckets,
        // xff-once-flag and sweep timer. Tokens issued before this moment keep
        // the expiry they were stamped with; issuance from here uses the new
        // TTL; the new key is what the next login compares against; the new
        // proxy is what the next throttle key resolves through.
        authRef.swap({
          validateApiKey: async (key: string) => apiKeyEquals(key, candidate.apiKey as string),
          tokenTtlMin: candidate.sessionTokenTtlMin,
          trustedProxy: candidate.trustedProxy,
        });
        ctx.notice(
          `webui: ${moved.join("; ")}${ctx.actor ? ` (written by session ${ctx.actor})` : ""} -- auth middleware rebuilt over the carried sessions and throttle state`,
        );
      },
    }),
  );


  async function rebind(): Promise<WebuiRebindResult> {
    if (disposed) return { ok: false, port: 0, error: "the webui server is stopped" };
    const block = liveWebui();
    const wanted = block.port;
    const from = Number(listenerRef.current?.port ?? firstPort ?? 0);
    // A port the server cannot move to: port 0 means "any free port" at boot
    // and is not a live-rebind target, and a non-number is a bag this host
    // never resolved. Both answer honestly instead of closing a working socket.
    if (typeof wanted !== "number" || !Number.isInteger(wanted) || wanted <= 0) {
      return {
        ok: false,
        port: from,
        error: `webui.port ${JSON.stringify(wanted)} is not a rebindable port (a fresh listener needs a concrete port; port 0 stays restart-bound)`,
      };
    }
    if (wanted === from) return { ok: true, port: from };

    const bound = frameBound();
    // Drop the old listener FIRST: holding both while the new one binds would
    // let two servers answer the same Origin/host policy at once, and a failed
    // bind below puts the old port back on.
    try {
      listenerRef.current?.stop(true);
    } catch (e: unknown) {
      logger.error(`[webui] closing the listener on port ${from} failed: ${formatError(e)}`);
    }
    listenerRef.current = null;

    try {
      bind(wanted, bound);
      return { ok: true, port: wanted };
    } catch (e: unknown) {
      const why = formatError(e);
      // Recovery: the port the operator asked for is refused (taken, or
      // outside the bindable range). The old listener is the safer posture, so
      // it comes back and the refusal is what gets reported.
      try {
        bind(from, frameBound());
        return { ok: false, port: from, error: `${why}; the listener is back on port ${from}` };
      } catch (recoverErr: unknown) {
        return {
          ok: false,
          port: 0,
          error: `${why}; the old port could not be re-listened either (${formatError(recoverErr)}) -- restart the server`,
        };
      }
    }
  }

  function dispose(): void {
    if (disposed) return;
    disposed = true;
    // Everything this host put into process-wide registries leaves here: the
    // hooks (a stopped server must not answer a later write with a rebind that
    // cannot happen), the audit surface (a dead registry must not be the sink),
    // and the auth sweep timer.
    if (rebindTimer !== null) {
      clearTimeout(rebindTimer);
      rebindTimer = null;
    }
    for (const unregister of liveHookUnregisters.splice(0)) unregister();
    const stopSurface = auditSurfaceUnregister;
    auditSurfaceUnregister = null;
    stopSurface?.();
    try {
      listenerRef.current?.stop(true);
    } catch (e: unknown) {
      logger.error(`[webui] closing the listener at shutdown failed: ${formatError(e)}`);
    }
    listenerRef.current = null;
    authRef.stopCleanup();
  }

  return {
    get server() {
      return listenerRef.current!;
    },
    wsServer,
    authMiddleware: authRef,
    rebind,
    dispose,
  };
}
