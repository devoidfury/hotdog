// Cold session log frames: list, load (resume), view, delete.

import { getSessionRow } from "@core/session/session-index.ts";
import { deleteSessionLog, listSessionLogs, readSessionEntries } from "@core/session/session-log.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import { S2C, errorFrame, wireImages } from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { attachResumedSession } from "./attach.ts";
import type { RouteContext } from "./route-types.ts";

export async function handleListLogs(ctx: RouteContext): Promise<void> {
  const { ws, registry } = ctx;
  // Awaited so the reply has settled when routeMessage resolves (the
  // directory read is real I/O; fire-and-forget raced the caller).
  await listSessionLogs()
    .then((logs) => {
      // Only return cold logs, not sessions that are still live.
      const activeIds = new Set(registry.list().map((s) => s.id));
      const coldLogs = logs
        .filter((log) => !activeIds.has(log.id))
        .map((log) => {
          // The index row carries the session's derived state (parked,
          // interrupted, ...) plus the model/profile/ctx the log attests,
          // so the sidebar row grammar needs no log scan; missing row
          // (fresh log, unreconciled) simply has no state, and legacy
          // logs attest no model/profile/ctx (segments omitted).
          const row = getSessionRow(log.id);
          if (!row) return log;
          return {
            ...log,
            state: row.state,
            ...(row.model ? { model: row.model } : {}),
            ...(row.profile ? { profile: row.profile } : {}),
            ...(row.ctx_used != null ? { ctxUsed: row.ctx_used } : {}),
            ...(row.ctx_total != null ? { ctxTotal: row.ctx_total } : {}),
          };
        });
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
