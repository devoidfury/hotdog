// Session lifecycle + listing frames: create, delete, dismiss, rename,
// list, profiles, the sidebar's manual switch, and the server-persisted
// pin flip.

import { isSafeSessionId } from "@core/session/session-log.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { S2C, errorFrame } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { sessionCreatedPayload } from "./session-created.ts";
import { attachLiveSession } from "./attach.ts";
import { dropPinned, getPinnedIds, setPinned } from "./pin-store.ts";
import { bumpListMembership } from "./list-gen.ts";
import { coldLogRows } from "./handlers-logs.ts";
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
    .then(async ({ sessionId }) => {
      const channel = registry.createChannel(sessionId, ws);
      ws.activeSessionId = sessionId;
      ws.activeChannel = channel;

      const sessionCreatedMsg = sessionCreatedPayload(registry, sessionId);
      SessionRegistry.sendSafe(ws, sessionCreatedMsg);
      registry.broadcast(sessionCreatedMsg);
      await registry.sendTaskSnapshot(ws);
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}

export function handleDeleteSession(ctx: RouteContext): void {
  const { ws, msg, registry } = ctx;
  if (!msg.sessionId) return;
  // B3 refusal table: the task lifecycle owns a worker's terminal (and its
  // sweep); nothing here may fire -- not even the pin drop below. An
  // ADOPTED worker row gets the honest variant (no task lifecycle owns it).
  const row = registry.getRow(msg.sessionId as string);
  if (row?.kind === "worker") {
    SessionRegistry.sendSafe(ws, {
      type: S2C.ERROR,
      message:
        row.adoptedWorker === true
          ? "An adopted subagent goes cold when its adopted turn settles; it cannot be deleted here."
          : "Subagent sessions are ended by their task lifecycle, not deleted.",
    });
    return;
  }
  // Stale-prune server-side: the pin dies with the session (dropped
  // unconditionally -- even if the live agent vanished a moment ago, the id
  // may still ride the cold-log list, and a deleted row must not keep it).
  dropPinned(msg.sessionId as string);
  const deleted = registry.delete(msg.sessionId as string);
  // Membership watermark bump on a real teardown: the log file survives a
  // delete, so the id may surface as a plain cold row. No row push here
  // (the row build would be async I/O on a sync route, and a zero-turn
  // session has no log to announce): gen catches it -- every tab's next
  // LOGS_LISTED re-attests full.
  if (deleted) bumpListMembership();
  const sessionDeletedMsg = {
    type: S2C.SESSION_DELETED,
    sessionId: msg.sessionId,
  };
  ws.send(JSON.stringify(sessionDeletedMsg));
  registry.broadcast(sessionDeletedMsg);
}

/**
 * Dismiss an IDLE live session: same teardown as Delete (channels, bus,
 * SESSION_END re-fire, delegated-task interrupt via registry.delete) but
 * non-destructive framing -- the JSONL log survives and the row's pin
 * survives (pins span both sidebar sections, so no dropPinned here). The
 * id lands back in the cold "Recent Logs" list, visibly, in every tab:
 * SESSION_DELETED drops the live row (the client also clears the transcript
 * when the dismissed session was the attached view), the refreshed SESSIONS
 * payload follows, and a targeted logRowAdded frame re-lands the single
 * demoted row -- same pin flag and all -- without a windowed-payload fanout.
 */
export async function handleDismissSession(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry } = ctx;
  const sessionId = msg.sessionId;
  // Malformed frames are dropped like the other sidebar messages; the id
  // carries the core session-id gate (it reaches the filesystem scan).
  if (typeof sessionId !== "string" || !isSafeSessionId(sessionId)) return;
  // B3 refusal table: a worker row is not a dismissable live session (its
  // row is reclaimed by the sweep after the task's terminal event). An
  // ADOPTED worker row gets the honest variant (no task lifecycle owns it).
  const row = registry.getRow(sessionId);
  if (row?.kind === "worker") {
    SessionRegistry.sendSafe(ws, {
      type: S2C.ERROR,
      message:
        row.adoptedWorker === true
          ? "An adopted subagent goes cold when its adopted turn settles; it cannot be dismissed here."
          : "Subagent sessions are ended by their task lifecycle, not dismissed.",
    });
    return;
  }
  // Busy guard: refuse a session that is mid-run server-side, so a stale
  // menu (run started in another tab between right-click and click) cannot
  // silently tear down live work. The signal is the exact one the attach
  // path reports as the "working" event (attach.ts): the SessionManager
  // entry's bus. Guard and registry.delete() share one synchronous block --
  // no await between check and teardown, so no run can start in between.
  if (registry.getSessionManager().isSessionRunning(sessionId)) {
    logger.warn(
      `[websocket] dismissSession rejected: ${sessionId} is running; cancel it first`,
    );
    SessionRegistry.sendSafe(ws, errorFrame(new Error(`Session ${sessionId} is running. Nothing changed.`)));
    return;
  }
  // Unknown id: nothing live to demote; no-op, no frames, no teardown.
  if (!registry.delete(sessionId)) return;
  const sessionDeletedMsg = { type: S2C.SESSION_DELETED, sessionId };
  SessionRegistry.sendSafe(ws, sessionDeletedMsg);
  registry.broadcast(sessionDeletedMsg);
  // Demote now, not on the next refresh: live half first (cheap and sync),
  // then the TARGETED cold half -- one watermark bump and one logRowAdded
  // frame carrying the single demoted row (built through the same
  // coldLogRows grammar, onlyId path), instead of rebuilding and fanning
  // out the whole windowed payload. Awaited per the handleSetPinned settle
  // contract; a failed/vanished row build must not fail the dismissal (it
  // is already done): the bump already landed, so the next listLogs
  // re-attests full.
  registry.broadcast({ type: S2C.SESSIONS, sessions: registry.list() });
  const gen = bumpListMembership();
  await coldLogRows(registry, sessionId)
    .then((rows) => {
      const row = rows[0];
      if (row === undefined) {
        logger.warn(
          `[websocket] dismissSession ${sessionId}: no cold row to announce; gen ${gen} re-attests on the next listLogs`,
        );
        return;
      }
      registry.broadcast({ type: S2C.LOG_ROW_ADDED, row, gen });
    })
    .catch((err: unknown) => {
      logger.error(`[websocket] dismissSession row build failed: ${formatError(err)}`);
    });
}

/**
 * Flip a row's server-persisted pin (live session OR cold log id; pins
 * span both sidebar sections). No per-socket ack: the sidebar-refresh
 * broadcasts below reach the requester too, and the client reconciles its
 * optimistic flip against them.
 */
export async function handleSetPinned(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry } = ctx;
  const sessionId = msg.sessionId;
  const pinned = msg.pinned;
  // Malformed frames are dropped like the other sidebar messages; the id
  // carries the core session-id gate (it reaches the filesystem store).
  if (typeof sessionId !== "string" || !isSafeSessionId(sessionId) || typeof pinned !== "boolean") {
    return;
  }
  // B3 refusal table (D8, ledger N5: this refusal is B3's): hidden rows
  // have no sidebar slot to pin into.
  if (registry.getRow(sessionId)?.kind === "worker") {
    SessionRegistry.sendSafe(ws, {
      type: S2C.ERROR,
      message: "Worker sessions cannot be pinned.",
    });
    return;
  }
  setPinned(sessionId, pinned);
  // The sidebar-refresh broadcast idiom (attach.ts): live rows rehydrate
  // their pin marks from the SESSIONS payload flags first (cheap and sync).
  registry.broadcast({ type: S2C.SESSIONS, sessions: registry.list() });
  // Pins ride their own frame: the COMPLETE pin-store set (both
  // sections; pins are few) reaches every tab, which re-derives its marks
  // wholesale -- including rows no window would ever show. No directory
  // scan, no windowed LOGS_LISTED fanout, no gen (pin flips are not
  // membership changes), and nothing async left to fail: the store write
  // above already landed.
  registry.broadcast({ type: S2C.LOG_PINS, pinnedIds: [...getPinnedIds()] });
}

export function handleRenameSession(ctx: RouteContext): void {
  const { ws, msg, registry } = ctx;
  if (!msg.sessionId || !msg.newName) return;
  // B3 refusal table: a worker row is hidden (B1's projection), so a title
  // would be a label nobody renders; the honest answer is the refusal.
  if (registry.getRow(msg.sessionId as string)?.kind === "worker") {
    SessionRegistry.sendSafe(ws, {
      type: S2C.ERROR,
      message: "Subagent sessions cannot be renamed.",
    });
    return;
  }
  registry.rename(msg.sessionId as string, msg.newName as string);
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
  // B3 refusal table (R4's switch-disabled): the worker profile is the
  // spawn-time decision; switching it would rewrite the task's placement.
  if (registry.getRow(msg.sessionId as string)?.kind === "worker") {
    SessionRegistry.sendSafe(ws, {
      type: S2C.ERROR,
      message: "Subagent sessions cannot switch profiles.",
    });
    return;
  }
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
    // Direct-send seam: an ERROR commits the client's in-flight row, so
    // drain this socket's batched tail before the frame lands (the success
    // ack above is a non-committing notice and rides raw by doctrine).
    registry.flushSocket(ws);
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
