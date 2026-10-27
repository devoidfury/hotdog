import { createWsServer, type CreateWsServerOptions } from "../websocket/server.ts";
import { wsMaxPayloadBytes } from "../websocket/constants.ts";
import { uploadLimits } from "../websocket/message-routing.ts";
import { createAuthMiddleware, apiKeyEquals } from "../websocket/auth.ts";
import { upgradeOriginAllowed, isLoopbackHost } from "../websocket/origin.ts";
import { DDG_SOLVE_SERVICE } from "../web-search/index.ts";
import { logger } from "@utils/logger.ts";
import { CoreContext } from "@core/extensions/types.ts";

import { ExtensionError } from "@core/error.ts";
import { ProfileManager, type ProfileDef } from "@core/config/index.ts";
import { BunRequest } from "bun";

// special bun import that transpiles and serves all linked assets,
// see https://bun.com/docs/bundler/loaders.md
import webuiFrontend from "./ui/index.html";

interface WebuiWsData {
  url: string;
}

// Transport frame cap for upgraded sockets: wsMaxPayloadBytes() is derived
// from the resolved fileAttachment.maxImageSize ceiling -- the same value the
// upload path enforces (single source, see websocket/constants.ts). The bound
// is applied below on the `websocket:` handler because Bun's root-level
// maxPayloadLength is ignored in 1.4.2.

export interface WebuiConfig {
  port?: number;
  host?: string;
  apiKey?: string | null;
  sessionTokenTtlMin?: number;
}

interface WebuiServerResult {
  server: ReturnType<typeof Bun.serve>;
  wsServer: ReturnType<typeof createWsServer>;
  authMiddleware: ReturnType<typeof createAuthMiddleware>;
}

export async function createWebuiServer(
  core: CoreContext,
  config: WebuiConfig,
  // Host/test seam: an embedded host (or an integration test) can supply its
  // own agent factory instead of the resolved config's default one.
  options: Pick<CreateWsServerOptions, "buildAgent"> = {},
): Promise<WebuiServerResult> {
  const { port, host, apiKey, sessionTokenTtlMin } = config;

  // Frame bound for upgraded sockets, from the same resolved image ceiling
  // the upload path enforces (see wsMaxPayloadBytes).
  const frameBound = wsMaxPayloadBytes(uploadLimits(core).maxImageSize);

  if (!apiKey) {
    throw ExtensionError.ConfigFailed(
      "webui",
      "No API key configured. Set webui.apiKey in config or HOTDOG_WEBUI_API_KEY env var.",
    );
  }

  const authMiddleware = createAuthMiddleware({
    validateApiKey: async (key: string) => apiKeyEquals(key, apiKey),
    tokenTtlMin: sessionTokenTtlMin,
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
    auth: authMiddleware,
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
  const effectiveHost = host ?? "127.0.0.1";
  if (!isLoopbackHost(effectiveHost)) {
    logger.warn(
      `[webui] binding to non-loopback host '${effectiveHost}' -- ` +
        "reachable from other machines over unencrypted HTTP. " +
        "Use a tunnel or a TLS reverse proxy for remote access.",
    );
  }

  authMiddleware.startCleanup();
  wsServer.startCleanupLoop();

  // Optional extension routes: web-search mounts its DDG captcha solve page
  // here so challenges are solvable over the webui's existing port (and its
  // existing firewall/VPN reach) instead of a second server. The service is
  // unauthenticated by design: access control is the per-challenge nonce.
  const solveService = core.services.has(DDG_SOLVE_SERVICE)
    ? (core.services.get(DDG_SOLVE_SERVICE) as
        | { routes: Record<string, (req: Request) => Response | Promise<Response>>; setBaseUrl(url: string): void }
        | undefined)
    : undefined;

  let server = Bun.serve<WebuiWsData>({
    port,
    hostname: effectiveHost,
    routes: {
      "/": webuiFrontend,
      ...(solveService?.routes ?? {}),

      "/verify": async function (req: BunRequest) {
        const token = req.headers.get("x-hotdog-token");
        const valid = token ? authMiddleware.validateToken(token) : false;
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
        const upgraded = server.upgrade(req, {
          data: { url: req.url } as WebuiWsData,
        });
        if (!upgraded) {
          return Response.json({ error: "Upgrade failed" }, { status: 400 });
        }
      },
    },

    fetch: async function fetchHandler(req: Request): Promise<Response | void> {
      const url = new URL(req.url);
      const pathname = url.pathname;

      if (req.method === "POST" && pathname === "/login") {
        const loginResp = await authMiddleware.loginHandler(req);
        return loginResp;
      }

      return new Response("Not found", { status: 404 });
    },

    websocket: {
      // Frame bound for upgraded sockets (see wsMaxPayloadBytes).
      maxPayloadLength: frameBound,
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

  logger.info(`WebUI server listening on http://${effectiveHost}:${server.port}`);
  solveService?.setBaseUrl(`http://${effectiveHost}:${server.port}`);

  return { server, wsServer, authMiddleware };
}
