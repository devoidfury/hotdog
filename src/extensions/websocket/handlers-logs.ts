// Cold session log frames: list, load (resume), view, delete.

import { getSessionRow, searchSessionCorpora } from "@core/session/session-index.ts";
import { deleteSessionLog, listSessionLogs, readSessionEntries, trySessionPath } from "@core/session/session-log.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import {
  S2C,
  errorFrame,
  wireImages,
  MAX_SEARCH_HITS,
  MAX_SEARCH_SNIPPETS_PER_LOG,
  SEARCH_SNIPPET_CONTEXT,
  type SearchHitWire,
} from "./protocol.ts";
import { SessionRegistry } from "./session-registry.ts";
import { registryDisplay } from "./replay.ts";
import { wireToolDisplay } from "./wire-messages.ts";
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
  const { ws, msg, core } = ctx;
  if (!msg.logId) return;
  // Awaited so the caller sees LOG_VIEWED/ERROR on return (real log read).
  await readSessionEntries(msg.logId as string)
    .then((entries) => {
      // A browsed log is a cold surface with no client-side registry, so the
      // server resolves each tool_call's declared display parts against the
      // LIVE registry (registryDisplay, the replay resolver) and maps them
      // through wireToolDisplay -- the one metadata->wire seam. Additive
      // per-call field: old clients ignore it, hintless tools and non-call
      // entries ride untouched (no null-noise, no empty arrays).
      const toolDisplay = registryDisplay(core?.toolRegistry);
      // Log entries carry raw images; put them through the same wire cap so a huge base64 can't flood the socket.
      const capped: Array<Record<string, unknown>> = entries.map((entry) => {
        const imgs = wireImages(entry.images);
        const calls = entry.tool_calls;
        const withImages = entry.images ? { ...entry, images: imgs } : entry;
        if (!Array.isArray(calls) || calls.length === 0) return withImages;
        let touched = false;
        const wired = calls.map((raw) => {
          const call = raw as { name?: string; function?: { name?: string } };
          const display = wireToolDisplay(toolDisplay(call?.function?.name || call?.name || ""));
          if (!display) return raw;
          touched = true;
          return { ...call, display };
        });
        return touched ? { ...withImages, tool_calls: wired } : withImages;
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

// ── Full-text log search ──────────────────────────────────────────────────
// Case-insensitive substring scan across every session log (live + cold),
// newest-activity first. The corpus is user messages + assistant response
// text (see searchableEntryText in @core/session/session-log.ts): tool
// results, tool calls and reasoning are never searched, and base64 image
// payloads ride their own field, so a hit is always real conversation text.

/** Collapse a match to a single trimmed snippet line, keeping
 *  SEARCH_SNIPPET_CONTEXT characters on each side of the match. `idx`/`len`
 *  are the match offsets in the lowercased scan string; toLowerCase is
 *  length-preserving except for rare Unicode, where the excerpt window
 *  shifts by a character at worst -- display-only, harmless. */
function makeSnippet(text: string, idx: number, len: number): string {
  const start = Math.max(0, idx - SEARCH_SNIPPET_CONTEXT);
  const end = Math.min(text.length, idx + len + SEARCH_SNIPPET_CONTEXT);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  const prefix = start > 0 ? "…" : "";
  const suffix = end < text.length ? "…" : "";
  return `${prefix}${body}${suffix}`;
}

/** Scan one session's searchable-text corpus (user+assistant, newline-joined)
 *  for `needle` (already lowercased). Returns the match count and up to
 *  MAX_SEARCH_SNIPPETS_PER_LOG excerpts. */
function scanText(text: string, needle: string): { matchCount: number; snippets: string[] } {
  let matchCount = 0;
  const snippets: string[] = [];
  const lower = text.toLowerCase();
  let from = 0;
  while (true) {
    const idx = lower.indexOf(needle, from);
    if (idx < 0) break;
    matchCount++;
    if (snippets.length < MAX_SEARCH_SNIPPETS_PER_LOG) {
      snippets.push(makeSnippet(text, idx, needle.length));
    }
    from = idx + needle.length;
  }
  return { matchCount, snippets };
}

/**
 * Search every session log (live and cold) for a case-insensitive substring,
 * newest-activity first, capped at MAX_SEARCH_HITS matching logs. The heavy
 * lifting -- enumeration + a staleness-checked `search_text` mirror (so cold,
 * unchanged logs are never re-parsed) -- is searchSessionCorpora in the
 * session index; this layer only counts matches, cuts excerpts, and adds the
 * live/cold status the client uses to pick viewLog vs switchSession.
 */
export async function searchSessionLogs(
  query: string,
  registry: SessionRegistry,
): Promise<SearchHitWire[]> {
  const needle = query.toLowerCase();
  const matches = await searchSessionCorpora(query);
  const activeIds = new Set(registry.list().map((s) => s.id));
  const hits: SearchHitWire[] = [];
  for (const match of matches) {
    if (hits.length >= MAX_SEARCH_HITS) break;
    const { matchCount, snippets } = scanText(match.text, needle);
    if (matchCount === 0) continue;
    hits.push({
      logId: match.sessionId,
      lastActivityAt: match.lastActivityAt,
      matchCount,
      ...(match.profile ? { profile: match.profile } : {}),
      ...(match.model ? { model: match.model } : {}),
      live: activeIds.has(match.sessionId),
      snippets,
    });
  }
  return hits;
}

export async function handleSearchLogs(ctx: RouteContext): Promise<void> {
  const { ws, msg, registry } = ctx;
  const query = typeof msg.query === "string" ? msg.query.trim() : "";
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;
  // Empty/whitespace query: answer empty rather than scanning every log for
  // "" (which would match the first line of every file).
  if (query === "") {
    SessionRegistry.sendSafe(ws, {
      type: S2C.SEARCH_RESULTS,
      requestId,
      query: "",
      results: [],
    });
    return;
  }
  // Awaited for the settle contract: this walks every log on disk.
  await searchSessionLogs(query, registry)
    .then((results) => {
      SessionRegistry.sendSafe(ws, {
        type: S2C.SEARCH_RESULTS,
        requestId,
        query,
        results,
      });
    })
    .catch((err: unknown) => {
      logger.warn(`[websocket] searchLogs failed: ${formatError(err)}`);
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}
