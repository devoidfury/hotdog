// WebUI server — UI over HTTP with WebSockets.

import { createHttpApp, serveStatic } from "../../utils/index.js";
import { createWsServer } from "../websocket/server.js";
import { createAuthMiddleware } from "../websocket/auth.js";

/**
 * Create and start the webui server.
 * Uses websocket extension for WS handling and auth.
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

  const authMiddleware = createAuthMiddleware({
    validateApiKey: async (key) => key === apiKey,
    tokenTtlMin: sessionTokenTtlMin,
  });

  // Create WebSocket server handler
  const wsServer = createWsServer(core, {
    auth: authMiddleware,
    sessionTimeoutMin: core.config?.websocket?.sessionTimeoutMin || 30,
    questionTimeoutSecs: core.config?.websocket?.questionTimeoutSecs || 300,
    questionStrategy: core.config?.websocket?.questionStrategy || "wait",
  });

  // Start cleanup loops
  authMiddleware.startCleanup();
  wsServer.startCleanupLoop();

  const app = createHttpApp();

  // Start the server — app.listen() wraps Bun.serve({ fetch: app.handler, ... })
  const server = app.listen({
    port,
    hostname: host,
    // WebSocket handlers
    websocket: {
      open(ws) {
        const { url } = ws.data;
        const req = { url, headers: { host: "localhost" } };
        wsServer.onUpgrade(req, ws);
      },
      message(ws, data) {
        wsServer.onMessage(ws, data);
      },
      close(ws) {
        wsServer.onClose(ws);
      },
    },
  });

  // Custom 404
  app.setNotFoundHandler((req, res) => {
    res.statusCode = 404;
    res.end("Not found");
  });

  // POST /login — authenticate and return session token
  // Delegates to authMiddleware.loginHandler, then converts Bun Response
  // to the Express-like res helper.
  app.post("/login", async (req, res) => {
    // Reconstruct a Bun Request from the Express-like req for loginHandler
    const loginReq = new Request(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
    });
    const loginResp = await authMiddleware.loginHandler(loginReq);
    const text = await loginResp.text();
    res
      .status(loginResp.status)
      .setHeader(
        "Content-Type",
        loginResp.headers.get("Content-Type") || "application/json",
      )
      .send(text);
  });

  // GET /verify — validate auth token
  app.get("/verify", (req, res) => {
    const token = req.query.token;
    const valid = token ? authMiddleware.validateToken(token) : false;
    if (valid) {
      res.json({ valid: true });
    } else {
      res.status(401).json({ valid: false });
    }
  });

  // GET /ws - Handles authenticated websocket upgrade
  app.get("/ws", (req, res) => {
    const url = new URL(req.url);
    const token = url.searchParams.get("token");

    if (!token) {
      res.status(401).json({
        error: "Token required. Use ?token= in WebSocket URL",
      });
      return;
    }

    if (!authMiddleware.validateToken(token)) {
      res.status(401).json({ error: "Invalid token" });
      return;
    }

    const upgraded = server.upgrade(req.originalRequest, {
      data: { token, url: req.url },
    });
    if (!upgraded) {
      res.status(400).end("Upgrade failed");
    }
    // On success, Bun.serve handles the upgrade — no response to send.
  });

  // Static files — SPA mode with index.html fallback
  app.use(
    serveStatic({
      root: uiDir,
      indexHtmlFallback: true,
      maxAgeSecs: 3600,
    }),
  );

  console.log(`WebUI server listening on http://${host}:${port}`);

  return { server, wsServer, authMiddleware };
}
