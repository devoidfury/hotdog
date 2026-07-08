// WebUI server — UI over HTTP with WebSockets.

import { serveStaticFile } from "../../utils/index.js";
import { createWsServer } from "../websocket/server.js";
import { createAuthMiddleware } from "../websocket/auth.js";
import { logger } from "../../core/logger.js";

/**
 * Create and start the webui server.
 *
 * @param {Object} core - The core object
 * @param {Object} config - Webui-specific config
 * @param {string} uiDir - Path to UI static files directory
 * @returns {Promise<Object>} { server, wsServer, authMiddleware }
 */
export async function createWebuiServer(core, config, uiDir) {
  const { port, host, apiKey, sessionTokenTtlMin } = config;

  if (!apiKey) {
    throw new Error(
      "No API key configured. Set webui.apiKey in config or HOTDOG_WEBUI_API_KEY env var.",
    );
  }

  const maxAgeSecs = core.config?.webui?.maxAgeSecs;
  if (!maxAgeSecs)
    throw new Error("missing required webui.maxAgeSecs configuration");

  const authMiddleware = createAuthMiddleware({
    validateApiKey: async (key) => key === apiKey,
    tokenTtlMin: sessionTokenTtlMin,
  });

  // Create WebSocket server handler
  const wsServer = createWsServer(core, {
    auth: authMiddleware,
    sessionTimeoutMin: core.config?.websocket?.sessionTimeoutMin,
    questionTimeoutSecs: core.config?.websocket?.questionTimeoutSecs,
    questionStrategy: core.config?.websocket?.questionStrategy,
  });

  // Start cleanup loops
  authMiddleware.startCleanup();
  wsServer.startCleanupLoop();

  const fetchHandler = async (req) => {
    const url = new URL(req.url);
    const pathname = url.pathname;

    // POST /login — authenticate and return session token
    if (req.method === "POST" && pathname === "/login") {
      const loginResp = await authMiddleware.loginHandler(req);
      return loginResp;
    }

    // GET /verify — validate auth token
    if (req.method === "GET" && pathname === "/verify") {
      const token = url.searchParams.get("token");
      const valid = token ? authMiddleware.validateToken(token) : false;
      return valid
        ? Response.json({ valid })
        : Response.json({ valid }, { status: 401 });
    }

    // GET /ws — handle authenticated WebSocket upgrade
    if (req.method === "GET" && pathname === "/ws") {
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
      const upgraded = server.upgrade(req, { data: { token, url: req.url } });
      if (!upgraded) {
        return Response.json({ error: "Upgrade failed" }, { status: 400 });
      }
      return;
    }

    // Everything else — serve static files
    const staticResp = serveStaticFile(uiDir, maxAgeSecs, pathname);
    if (staticResp) {
      return staticResp;
    }

    return new Response("Not found", { status: 404 });
  };

  // ── Start the server ───────────────────────────────────────────────────

  const server = Bun.serve({
    port,
    hostname: host,
    fetch: fetchHandler,
    // WebSocket handlers
    websocket: {
      open(ws) {
        const { url } = ws.data;
        wsServer.onUpgrade({ url, headers: { host: "localhost" } }, ws);
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
