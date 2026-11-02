// Shared types for the C2S message handlers. The auth gate and dispatch map
// live in message-routing.ts; each handler owns one family of message types.
//
// Settle contract: routeMessage's returned promise is the caller's signal
// that a message's replies have settled. Handlers that do real I/O (log
// reads, attaches, completion requests) must await and return their work;
// handlers that were fire-and-forget in the original switch stay
// fire-and-forget (no return of the floating promise).

import type { CoreContext } from "@core/extensions/types.ts";
import type { AuthMiddleware } from "./auth.ts";
import type { HotdogServerSocket } from "./socket.ts";
import type { WebSocketQuestionBridge } from "./question-input.ts";
import type { SessionRegistry } from "./session-registry.ts";
import type { C2SMessage } from "./protocol.ts";

export interface RouteContext {
  ws: HotdogServerSocket<unknown>;
  msg: C2SMessage;
  registry: SessionRegistry;
  authMiddleware: AuthMiddleware | undefined;
  bridge: WebSocketQuestionBridge;
  core: CoreContext;
}

export type MessageHandler = (ctx: RouteContext) => Promise<void> | void;
