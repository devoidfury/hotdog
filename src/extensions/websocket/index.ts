import type { CoreContext, ExtensionInstance } from "../../core/extensions/types.ts";

// Re-exported so the webui extension can import these directly.
export { createWsServer } from "./server.ts";
export type { WsServer } from "./server.ts";
export { createAuthMiddleware } from "./auth.ts";
export type { AuthMiddleware } from "./auth.ts";
export { SessionRegistry } from "./server.ts";
export { WebSocketChannel } from "./websocket-channel.ts";
export type { WebSocketChannelOptions } from "./websocket-channel.ts";
export { C2S, S2C } from "./protocol.ts";
export type { C2SType, S2CType, C2SMessage, S2CMessage } from "./protocol.ts";

// Config defaults come from extension.json configSchema; no hooks needed.
export function create(_core: CoreContext): ExtensionInstance {
  return {};
}
