// WebUI server — Bun.serve() with HTTP routing and WebSocket upgrade.
// Owned by the webui extension. Uses createWsServer() from the websocket extension.

import path from "node:path";
import { createWsServer } from "../websocket/server.js";
import { createAuthMiddleware } from "../websocket/auth.js";

// ── Static file serving ─────────────────────────────────────────────────────

/**
 * MIME types for static file serving.
 */
const MIME_TYPES = {
  ".html": "text/html",
  ".css": "text/css",
  ".js": "application/javascript",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

/**
 * Serve a static file from the UI directory.
 */
async function serveStaticFile(urlPath, documentRoot) {
  // Normalize path — resolve to documentRoot, prevent directory traversal
  const relPath = urlPath === "/" ? "/index.html" : urlPath;
  const safePath = relPath.split("?").shift().split("#").shift();
  const decoded = decodeURIComponent(safePath);

  // Simple guard — only allow paths within documentRoot
  const resolved = path.resolve(documentRoot, decoded);
  if (!resolved.startsWith(path.resolve(documentRoot))) {
    return new Response("Forbidden", { status: 403 });
  }

  const ext = decoded.match(/\.([a-z0-9]+)$/i);
  const contentType = ext
    ? MIME_TYPES[ext[0]] || "application/octet-stream"
    : "text/html";

  try {
    const file = Bun.file(documentRoot + decoded);
    const exists = await file.exists();
    if (!exists) {
      return new Response("Not found", { status: 404 });
    }
    return new Response(file, {
      headers: { "Content-Type": contentType },
    });
  } catch {
    return new Response("Internal error", { status: 500 });
  }
}

// ── Server Factory ───────────────────────────────────────────────────────────

/**
 * Create and start the webui server.
 * Owns Bun.serve(). Uses websocket extension for WS handling and auth.
 *
 * @param {Object} core - The core object
 * @param {Object} config - Webui-specific config
 * @param {string} uiDir - Path to UI static files directory
 * @returns {Promise<Object>} { server, wsServer, authMiddleware }
 */
export async function createWebuiServer(core, config, uiDir) {
  const {
    port = 3000,
    host = "0.0.0.0",
    apiKey = null,
    sessionTokenTtlMin = 1440,
  } = config;

  // Resolve API key from config or env
  const resolvedApiKey = apiKey || process.env.HOTDOG_WEBUI_API_KEY || null;
  if (!resolvedApiKey) {
    throw new Error(
      "No API key configured. Set webui.apiKey in config or HOTDOG_WEBUI_API_KEY env var.",
    );
  }

  const authMiddleware = createAuthMiddleware({
    validateApiKey: async (key) => key === resolvedApiKey,
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

  // ── Bun.serve ────────────────────────────────────────────────────────────

  const server = Bun.serve({
    port,
    hostname: host,

    async fetch(req, server) {
      const url = new URL(req.url);
      const method = req.method;

      // ── Route: POST /login ──────────────────────────────────────────
      if (method === "POST" && url.pathname === "/login") {
        return authMiddleware.loginHandler(req);
      }

      // ── Route: GET /verify ───────────────────────────────────────────
      if (method === "GET" && url.pathname === "/verify") {
        const token = url.searchParams.get("token");
        const valid = token ? authMiddleware.validateToken(token) : false;
        if (valid) {
          return new Response(JSON.stringify({ valid: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ valid: false }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }

      // ── Route: WS upgrade ───────────────────────────────────────────
      if (url.pathname === "/ws") {
        // Check auth token from query param
        const token = url.searchParams.get("token");
        if (authMiddleware && token) {
          if (!authMiddleware.validateToken(token)) {
            return new Response(JSON.stringify({ error: "Invalid token" }), {
              status: 401,
              headers: { "Content-Type": "application/json" },
            });
          }
        } else if (authMiddleware && !token) {
          return new Response(
            JSON.stringify({
              error: "Token required. Use ?token= in WebSocket URL",
            }),
            { status: 401, headers: { "Content-Type": "application/json" } },
          );
        }

        // Upgrade to WebSocket — pass token via ws.data
        const upgraded = server.upgrade(req, {
          data: { token, url: req.url },
        });
        if (!upgraded) {
          return new Response("Upgrade failed", { status: 400 });
        }
        // Return undefined — Bun.serve handles the rest via websocket handlers
        return;
      }

      // ── Route: Static files ──────────────────────────────────────────
      return serveStaticFile(url.pathname, uiDir);
    },

    // WebSocket handlers
    websocket: {
      open(ws) {
        // ws.data contains { token, url } from the upgrade
        // Create a session for this connection via wsServer
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

  console.log(`WebUI server listening on http://${host}:${port}`);

  return { server, wsServer, authMiddleware };
}
