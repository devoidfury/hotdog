// WebUI server — UI over HTTP with WebSockets.

import { createWsServer, type HotdogServerSocket } from "../websocket/server.ts";
import { createAuthMiddleware } from "../websocket/auth.ts";
import { logger } from "../../core/logger.ts";
import {
  CoreContext,
  getExtensionConfig,
} from "../../core/extensions/types.ts";

import webuiFrontend from "./ui/index.html";
import { ExtensionError } from "../../core/error.ts";
import { ProfileManager, type ProfileDef } from "../../core/config/index.ts";
import { BunRequest } from "bun";

// ── Types ───────────────────────────────────────────────────────────────────

interface WebuiWsData {
  token: string;
  url: string;
}

export interface WebuiConfig {
  port?: number;
  host?: string;
  apiKey?: string | null;
  sessionTokenTtlMin?: number;
  maxAgeSecs?: number;
}

interface WebuiServerResult {
  server: ReturnType<typeof Bun.serve>;
  wsServer: ReturnType<typeof createWsServer>;
  authMiddleware: ReturnType<typeof createAuthMiddleware>;
}

/**
 * Create and start the webui server.
 */
export async function createWebuiServer(
  core: CoreContext,
  config: WebuiConfig,
  uiDir: string,
): Promise<WebuiServerResult> {
  const { port, host, apiKey, sessionTokenTtlMin } = config;

  if (!apiKey) {
    throw ExtensionError.ConfigFailed(
      "webui",
      "No API key configured. Set webui.apiKey in config or HOTDOG_WEBUI_API_KEY env var.",
    );
  }

  const webuiConfig = getExtensionConfig<WebuiConfig>(core, "webui");
  const maxAgeSecs = webuiConfig.maxAgeSecs;
  if (!maxAgeSecs) {
    throw ExtensionError.ConfigFailed(
      "webui",
      "missing required webui.maxAgeSecs configuration",
    );
  }

  const authMiddleware = createAuthMiddleware({
    validateApiKey: async (key: string) => key === apiKey,
    tokenTtlMin: sessionTokenTtlMin,
  });

  // Create WebSocket server handler
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
    sessionTimeoutMin: wsConfig?.sessionTimeoutMin as number | undefined,
    questionTimeoutSecs: wsConfig?.questionTimeoutSecs as number | undefined,
    questionStrategy: wsConfig?.questionStrategy as string | undefined,
    profiles,
  });

  // Start cleanup loops
  authMiddleware.startCleanup();
  wsServer.startCleanupLoop();

  // Start the server
  let server = Bun.serve<WebuiWsData>({
    port,
    hostname: host,
    routes: {
      "/": webuiFrontend,

      // GET /verify — validate auth token
      "/verify": async function (req: BunRequest) {
        const url = new URL(req.url);
        const token = url.searchParams.get("token");
        const valid = token ? authMiddleware.validateToken(token) : false;
        return valid
          ? Response.json({ valid })
          : Response.json({ valid }, { status: 401 });
      },

      // GET /ws — handle authenticated WebSocket upgrade
      "/ws": async function (req: BunRequest) {
        const url = new URL(req.url);
        const token = url.searchParams.get("token");
        if (!token) {
          return Response.json(
            { error: "Token required. Use ?token= in WebSocket URL" },
            { status: 401 },
          );
        }
        if (!authMiddleware.validateToken(token)) {
          return Response.json({ error: "Invalid token" }, { status: 401 });
        }
        // Try to upgrade — Bun.serve handles the rest
        const upgraded = server.upgrade(req, {
          data: { token, url: req.url } as WebuiWsData,
        });
        if (!upgraded) {
          return Response.json({ error: "Upgrade failed" }, { status: 400 });
        }
      },
    },

    fetch: async function fetchHandler(req: Request): Promise<Response | void> {
      const url = new URL(req.url);
      const pathname = url.pathname;

      // POST /login — authenticate and return session token
      if (req.method === "POST" && pathname === "/login") {
        const loginResp = await authMiddleware.loginHandler(req);
        return loginResp;
      }

      // Everything else — serve static files
      // const staticResp = serveStaticFile(uiDir, maxAgeSecs, pathname);
      // if (staticResp) {
      //   return staticResp;
      // }

      return new Response("Not found", { status: 404 });
    },

    // WebSocket handlers
    websocket: {
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

  logger.info(`WebUI server listening on http://${host}:${port}`);

  return { server, wsServer, authMiddleware };
}
