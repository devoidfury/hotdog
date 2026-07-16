// WebUI server — UI over HTTP with WebSockets.

import { serveStaticFile } from "../../utils/index.ts";
import { createWsServer } from "../websocket/server.ts";
import { createAuthMiddleware } from "../websocket/auth.ts";
import { logger } from "../../core/logger.ts";
import { CoreContext, getExtensionConfig } from "../../core/extensions/types.ts";

import webuiFrontend from "./ui/index.html";

// ── Types ───────────────────────────────────────────────────────────────────

interface WebuiConfig {
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
    throw new Error(
      "No API key configured. Set webui.apiKey in config or HOTDOG_WEBUI_API_KEY env var.",
    );
  }

  const webuiConfig = getExtensionConfig<WebuiConfig>(core, "webui");
  const maxAgeSecs = webuiConfig.maxAgeSecs;
  if (!maxAgeSecs) {
    throw new Error("missing required webui.maxAgeSecs configuration");
  }

  const authMiddleware = createAuthMiddleware({
    validateApiKey: async (key: string) => key === apiKey,
    tokenTtlMin: sessionTokenTtlMin,
  });

  // Create WebSocket server handler
  const wsConfig = core.config?.websocket as Record<string, unknown> | undefined;
  const wsServer = createWsServer(core, {
    auth: authMiddleware,
    sessionTimeoutMin: wsConfig?.sessionTimeoutMin as number | undefined,
    questionTimeoutSecs: wsConfig?.questionTimeoutSecs as number | undefined,
    questionStrategy: wsConfig?.questionStrategy as string | undefined,
  });

  // Start cleanup loops
  authMiddleware.startCleanup();
  wsServer.startCleanupLoop();

  // Start the server
  let server = Bun.serve({
    port,
    hostname: host,
    routes: {
      "/": webuiFrontend,

      // GET /verify — validate auth token
      "/verify": async function (req) {
        const url = new URL(req.url);
        const token = url.searchParams.get("token");
        const valid = token ? authMiddleware.validateToken(token) : false;
        return valid
          ? Response.json({ valid })
          : Response.json({ valid }, { status: 401 });
      },

      // GET /ws — handle authenticated WebSocket upgrade
      "/ws": async function (req) {
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
        const upgraded = server.upgrade(req, { data: { token, url: req.url } as unknown as undefined });
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
        const wsData = ws.data as unknown as { url?: string };
        const { url } = wsData;
        wsServer.onUpgrade(
          { url: url || "", headers: { host: "localhost" } },
          ws as unknown as WebSocket,
        );
      },
      message(ws, data) {
        wsServer.onMessage(ws as unknown as WebSocket, data);
      },
      close(ws) {
        wsServer.onClose(ws as unknown as WebSocket);
      },
    },
  });

  logger.info(`WebUI server listening on http://${host}:${port}`);

  return { server, wsServer, authMiddleware };
}
