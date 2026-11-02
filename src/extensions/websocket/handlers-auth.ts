// AUTH: token handshake and the post-auth attach chain.

import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { S2C } from "./protocol.ts";
import { attachResumedSession, attachToMostRecentSession, fallbackAttach } from "./attach.ts";
import { createAndAttachSession } from "./resume.ts";
import type { RouteContext } from "./route-types.ts";

export async function handleAuthMessage(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry, authMiddleware, bridge } = ctx;
  if (!authMiddleware) return;
  if (!msg.token) {
    // Malformed AUTH: answer instead of going silent, or the client
    // waits out the pending-auth timeout with no clue why.
    ws.send(
      JSON.stringify({ type: S2C.AUTH_ERROR, message: "AUTH message requires a token" }),
    );
    return;
  }
  if (!authMiddleware.validateToken(msg.token as string)) {
    ws.send(
      JSON.stringify({ type: S2C.AUTH_ERROR, message: "Invalid token" }),
    );
    return;
  }

  ws.authToken = msg.token as string;
  // Handshake complete: drop the pending-auth stamp now instead of
  // leaving the reaper to notice ws.authToken on its next sweep.
  registry.removePendingAuth(ws);
  // Authed sockets join the broadcast group (no-op if already
  // registered via a token upgrade).
  registry.registerConnection(ws);
  ws.send(JSON.stringify({ type: S2C.AUTH_OK }));
  // The task snapshot rides the attach paths below. A client that
  // remembers its session (upgrade ?session=...) gets it back
  // instead of the most recent one. attachStarted covers an
  // upgrade-site attach still in flight (activeSessionId is not set
  // until its first awaits settle).
  if (ws.activeSessionId || ws.attachStarted) return;
  ws.attachStarted = true;
  if (ws.resumeSessionId) {
    // Await the attach-or-fallback chain: routeMessage's promise
    // is the caller's settle signal for this message's replies,
    // and the attach reads real disk. Fire-and-forget made the
    // fallback burst (sessionCreated, cursor, error) unobservable
    // -- a starved runner resolved the handler before the EACCES
    // read even completed (the CI [authOk]-only flake).
    await attachResumedSession(
      ws,
      registry,
      bridge,
      ws.resumeSessionId,
      ws.resumeCursor ?? 0,
      true,
    ).catch((err: unknown) => {
      logger.error(`[websocket] resumed attach failed: ${formatError(err)}`);
      return fallbackAttach(ws, registry, bridge, "Session resume failed.");
    });
  } else if (registry.size > 0) {
    await attachToMostRecentSession(ws, registry, bridge).catch((err: unknown) => {
      logger.error(`[websocket] attach to most recent failed: ${formatError(err)}`);
    });
  } else {
    await createAndAttachSession(ws, registry);
  }
}
