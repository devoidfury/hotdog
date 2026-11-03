// Session lifecycle + listing frames: create, delete, rename, list,
// profiles, the sidebar's manual switch, and the server-persisted pin flip.

import { isSafeSessionId } from "@core/session/session-log.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { S2C, errorFrame } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { sessionCreatedPayload } from "./session-created.ts";
import { attachLiveSession } from "./attach.ts";
import { dropPinned, setPinned } from "./pin-store.ts";
import { coldLogsPayload } from "./handlers-logs.ts";
import type { RouteContext } from "./route-types.ts";

export function handleCreateSession(ctx: RouteContext): void {
  const { ws, msg, registry } = ctx;
  if (ws.activeSessionId && ws.activeChannel) {
    registry.removeChannel(ws.activeSessionId, ws.activeChannel);
  }
  registry
    .create({
      profile: msg.profile as string | undefined,
      model: msg.model as string | undefined,
      questionStrategy: msg.questionStrategy as string | undefined,
      questionTimeoutSecs: msg.questionTimeoutSecs as number | undefined,
    })
    .then(({ sessionId }) => {
      const channel = registry.createChannel(sessionId, ws);
      ws.activeSessionId = sessionId;
      ws.activeChannel = channel;

      const sessionCreatedMsg = sessionCreatedPayload(registry, sessionId);
      SessionRegistry.sendSafe(ws, sessionCreatedMsg);
      registry.broadcast(sessionCreatedMsg);
      registry.sendTaskSnapshot(ws);
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}

export function handleDeleteSession(ctx: RouteContext): void {
  const { ws, msg, registry } = ctx;
  if (!msg.sessionId) return;
  // Stale-prune server-side: the pin dies with the session (dropped
  // unconditionally -- even if the live agent vanished a moment ago, the id
  // may still ride the cold-log list, and a deleted row must not keep it).
  dropPinned(msg.sessionId as string);
  registry.delete(msg.sessionId as string);
  const sessionDeletedMsg = {
    type: S2C.SESSION_DELETED,
    sessionId: msg.sessionId,
  };
  ws.send(JSON.stringify(sessionDeletedMsg));
  registry.broadcast(sessionDeletedMsg);
}

/**
 * Flip a row's server-persisted pin (live session OR cold log id; pins
 * span both sidebar sections). No per-socket ack: the sidebar-refresh
 * broadcasts below reach the requester too, and the client reconciles its
 * optimistic flip against them.
 */
export async function handleSetPinned(ctx: RouteContext): Promise<void> {
  const { msg, registry } = ctx;
  const sessionId = msg.sessionId;
  const pinned = msg.pinned;
  // Malformed frames are dropped like the other sidebar messages; the id
  // carries the core session-id gate (it reaches the filesystem store).
  if (typeof sessionId !== "string" || !isSafeSessionId(sessionId) || typeof pinned !== "boolean") {
    return;
  }
  setPinned(sessionId, pinned);
  // The sidebar-refresh broadcast idiom (attach.ts): every tab rehydrates
  // its pin marks from the payload flags. Live rows first (cheap and sync),
  // then the cold half -- one directory scan whose payload is shared by all
  // sockets, so a pin on a Recent Logs row lifts there in every tab too.
  registry.broadcast({ type: S2C.SESSIONS, sessions: registry.list() });
  // Awaited per the settle contract. A failed scan must not fail the pin
  // (it is already persisted): note it and let the next listLogs recover.
  await coldLogsPayload(registry)
    .then((logs) => registry.broadcast({ type: S2C.LOGS_LISTED, logs }))
    .catch((err: unknown) => {
      logger.error(`[websocket] setPinned logs refresh failed: ${formatError(err)}`);
    });
}

export function handleRenameSession(ctx: RouteContext): void {
  const { msg, registry } = ctx;
  if (msg.sessionId && msg.newName) {
    registry.rename(msg.sessionId as string, msg.newName as string);
  }
}

export function handleListSessions(ctx: RouteContext): void {
  const { ws, registry } = ctx;
  const sessions = registry.list();
  ws.send(JSON.stringify({ type: "sessions", sessions }));
}

export function handleListProfiles(ctx: RouteContext): void {
  const { ws, registry } = ctx;
  const profiles = registry.listProfiles();
  ws.send(JSON.stringify({ type: S2C.PROFILES, profiles }));
}

export async function handleSwitchProfile(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry } = ctx;
  if (!msg.sessionId || !msg.profileName) return;
  const result = await registry.switchProfile({
    sessionId: msg.sessionId as string,
    profileName: msg.profileName as string,
  });
  if (result.success) {
    ws.send(
      JSON.stringify({
        type: S2C.PROFILE_SWITCHED,
        sessionId: msg.sessionId,
        profile: msg.profileName,
        success: true,
      }),
    );
  } else {
    ws.send(
      JSON.stringify({
        type: S2C.ERROR,
        message: result.error || "Profile switch failed",
      }),
    );
  }
}

export async function handleSwitchSession(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry, bridge } = ctx;
  // Manual sidebar switch: the client has no replay cursor for a session
  // it is not currently on, so this is always a full replay (cursor 0).
  if (!msg.sessionId) return;
  const attached = await attachLiveSession(
    ws,
    registry,
    bridge,
    msg.sessionId as string,
  );
  if (!attached) {
    ws.send(JSON.stringify({ type: S2C.ERROR, message: "Session not found" }));
  }
}
