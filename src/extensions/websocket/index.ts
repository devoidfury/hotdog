// WebSocket Server Extension
// Provides the core WebSocket backend for agent session management.
// Exports both create(core) for the extension loader and the full API
// for the webui extension to import directly.

import type { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";

// ── Extension API exports ───────────────────────────────────────────────────
// These are imported directly by the webui extension as JS module dependencies.

export { createWsServer } from "./server.ts";
export type { WsServer } from "./server.ts";
export { createAuthMiddleware } from "./auth.ts";
export type { AuthMiddleware } from "./auth.ts";
export { SessionRegistry } from "./server.ts";
export { WebSocketChannel } from "./websocket-channel.ts";
export type { WebSocketChannelOptions } from "./websocket-channel.ts";
export { C2S, S2C } from "./protocol.ts";
export type { C2SType, S2CType, C2SMessage, S2CMessage } from "./protocol.ts";

// ── Extension Factory (for extension loader) ────────────────────────────────

/**
 * Create the websocket extension.
 * Config defaults are registered automatically from extension.json configSchema.
 */
export function create(_core: CoreContext): ExtensionInstance {
  // No hooks needed — config is handled by extension.json schema,
  // and this extension doesn't register CLI subcommands or tools.
  return {};
}
