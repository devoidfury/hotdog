// WebSocket Server Extension
// Provides the core WebSocket backend for agent session management.
// Exports both create(core) for the extension loader and the full API
// for the webui extension to import directly.

// ── Extension API exports ───────────────────────────────────────────────────
// These are imported directly by the webui extension as JS module dependencies.

export { createWsServer } from "./server.js";
export { createAuthMiddleware } from "./auth.js";
export { SessionRegistry } from "./server.js";
export { FanoutSink, WebSocketOutputSink, BackgroundSink } from "./sinks.js";
export { C2S, S2C } from "./protocol.js";

// ── Extension Factory (for extension loader) ────────────────────────────────

/**
 * Create the websocket extension.
 * Config defaults are registered automatically from extension.json configSchema.
 *
 * @param {Object} core - The core object with hooks, config, etc.
 * @returns {Object} Extension instance
 */
export function create(core) {
  // No hooks needed — config is handled by extension.json schema,
  // and this extension doesn't register CLI subcommands or tools.
  return {};
}
