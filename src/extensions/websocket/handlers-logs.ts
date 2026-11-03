// Cold session log frames: list, load (resume), view, delete.

import { getSessionRow } from "@core/session/session-index.ts";
import { deleteSessionLog, listSessionLogs, readSessionEntries, trySessionPath } from "@core/session/session-log.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { S2C, errorFrame, wireImages } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { attachResumedSession } from "./attach.ts";
import { dropPinned, isPinned } from "./pin-store.ts";
import type { RouteContext } from "./route-types.ts";

/** Build the LOGS_LISTED payload: cold logs only (live ids filtered out),
 *  enriched with the index row, the absolute log path, and the server-side
 *  pin flag. Shared between the listLogs reply and the setPinned sidebar
 *  broadcast so both wires speak the exact same grammar. */
export async function coldLogsPayload(registry: SessionRegistry): Promise<Array<Record<string, unknown>>> {
  // Awaited so the reply has settled when routeMessage resolves (the
  // directory read is real I/O; fire-and-forget raced the caller).
  const logs = await listSessionLogs();
  // Only return cold logs, not sessions that are still live.
  const activeIds = new Set(registry.list().map((s) => s.id));
  return logs
    .filter((log) => !activeIds.has(log.id))
    .map((log) => {
      // The index row carries the session's derived state (parked,
      // interrupted, ...) plus the model/profile/ctx the log attests,
      // so the sidebar row grammar needs no log scan; missing row
      // (fresh log, unreconciled) simply has no state, and legacy
      // logs attest no model/profile/ctx (segments omitted).
      const row = getSessionRow(log.id);
      // Absolute log path for the sidebar's "Copy log file path" row
      // action; omitted when the id fails the core path helper's gate.
      const logPath = trySessionPath(log.id);
      const withPath = {
        ...log,
        ...(logPath !== undefined ? { logPath } : {}),
        pinned: isPinned(log.id),
      };
      if (!row) return withPath;
      return {
        ...withPath,
        state: row.state,
        ...(row.model ? { model: row.model } : {}),
        ...(row.profile ? { profile: row.profile } : {}),
        ...(row.ctx_used != null ? { ctxUsed: row.ctx_used } : {}),
        ...(row.ctx_total != null ? { ctxTotal: row.ctx_total } : {}),
      };
    });
}

export async function handleListLogs(ctx: RouteContext): Promise<void> {
  const { ws, registry } = ctx;
  await coldLogsPayload(registry)
    .then((coldLogs) => {
      SessionRegistry.sendSafe(ws, {
        type: S2C.LOGS_LISTED,
        logs: coldLogs,
      });
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}

export async function handleLoadLog(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry, bridge } = ctx;
  // "Continue": resume the log under its OWN session id (identity is
  // preserved; the session keeps living in the same log). User-initiated,
  // so auto=false: the livelock cap never blocks an explicit resume, and
  // its resume_attempt records as manual. If the log is already live
  // (another tab on it), this is just an attach.
  if (!msg.logId) return;
  // Awaited for the settle contract: the attach reads the real log.
  await attachResumedSession(ws, registry, bridge, msg.logId as string, 0, false).catch(
    (err: unknown) => {
      logger.error(`[websocket] loadLog failed: ${formatError(err)}`);
      SessionRegistry.sendSafe(ws, errorFrame(err));
    },
  );
}

export async function handleViewLog(ctx: RouteContext): Promise<void> {
  const { ws, msg } = ctx;
  if (!msg.logId) return;
  // Awaited so the caller sees LOG_VIEWED/ERROR on return (real log read).
  await readSessionEntries(msg.logId as string)
    .then((entries) => {
      // Log entries carry raw images; put them through the same wire cap so a huge base64 can't flood the socket.
      const capped = entries.map((entry) => {
        const imgs = wireImages(entry.images);
        if (!entry.images) return entry;
        return { ...entry, images: imgs };
      });
      SessionRegistry.sendSafe(ws, {
        type: S2C.LOG_VIEWED,
        logId: msg.logId,
        entries: capped,
      });
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}

export async function handleDeleteLog(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry } = ctx;
  if (!msg.logId) return;
  // Awaited so the caller sees the confirm/error on return (real unlink).
  await deleteSessionLog(msg.logId as string)
    .then((deleted) => {
      if (deleted) {
        // Stale-prune server-side: a dead log's pin dies with it.
        dropPinned(msg.logId as string);
        SessionRegistry.sendSafe(ws, {
          type: S2C.LOG_DELETED,
          logId: msg.logId,
        });
        registry.broadcast({ type: S2C.LOG_DELETED, logId: msg.logId });
      } else {
        SessionRegistry.sendSafe(ws, {
          type: S2C.ERROR,
          message: `Log ${msg.logId} not found`,
        });
      }
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}
