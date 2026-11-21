// Cold session log frames: list, load (resume), view, delete.

import { access } from "node:fs/promises";
import { getSessionRow, searchSessionCorpora } from "@core/session/session-index.ts";
import { deleteSessionLog, listSessionLogs, readSessionEntries, trySessionPath } from "@core/session/session-log.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";
import {
  S2C,
  errorFrame,
  wireImages,
  wireImageStubs,
  MAX_SEARCH_HITS,
  MAX_SEARCH_SNIPPETS_PER_LOG,
  SEARCH_SNIPPET_CONTEXT,
  type SearchHitWire,
} from "./protocol.ts";
import { HISTORY_WINDOW_MESSAGES, MAX_HISTORY_PAGE_MESSAGES, windowOlderThan } from "./history-window.ts";
import { SessionRegistry } from "./session-registry.ts";
import { registryArgDisplay, registryDisplay, registryHeaderKeys } from "./replay.ts";
import { taskLineageWire, wireToolDisplay } from "./wire-messages.ts";
import { MAX_SUBAGENT_LINEAGE_ROWS } from "./constants.ts";
import type { LineageRecord } from "@core/session/spawn-log.ts";
import type { LogEntry } from "@core/session/session-log.ts";
import type { ToolRegistry } from "@core/extensions/tool-registry.ts";
import { summarizeHeaderArgs } from "@core/extensions/tool-utils.ts";
import { attachResumedSession } from "./attach.ts";
import { dropPinned, getPinnedIds, isPinned } from "./pin-store.ts";
import { epochStartIndex } from "@core/session/session-log.ts";
import type { RouteContext } from "./route-types.ts";

/** Build the LOGS_LISTED payload: cold logs only (live ids filtered out),
 *  enriched with the index row, the absolute log path, and the server-side
 *  pin flag. Shared between the listLogs reply and the setPinned sidebar
 *  broadcast so both wires speak the exact same grammar.
 *
 *  Additive nested lineage: a cold manager row whose delegations the restart
 *  sidecar still attests carries `subagents` (taskLineageWire rows, same
 *  grammar the live task feed uses, capped per manager). A row without
 *  lineage carries NO field -- no section, exactly as before. The lineage is
 *  the process-lifetime boot snapshot (SpawnLog.lineage doctrine).
 *
 *  B5 (R4/D7): logs the sidecar attests as WORKER logs (joinedAgentSessionIds
 *  -- boot lineage UNION this lifetime's live joins, minus D6 promotions)
 *  are excluded from THIS list only. viewLog/LOG_VIEWED/loadOlder and the
 *  search corpora keep reaching them by id (the list hides, the log stays
 *  addressable); promoted sessions and unattested logs ride as plain rows
 *  (no attestation, no claim). D8 pin honesty: a pin persisted before the
 *  refusal table on an id this list excludes drops here (dropPinned persists
 *  only on a hit; the promote set is subtracted up front, so a promoted
 *  session's pin survives). */
export async function coldLogsPayload(registry: SessionRegistry): Promise<Array<Record<string, unknown>>> {
  // Awaited so the reply has settled when routeMessage resolves (the
  // directory read is real I/O; fire-and-forget raced the caller).
  const logs = await listSessionLogs();
  // Only return cold logs, not sessions that are still live.
  const activeIds = new Set(registry.list().map((s) => s.id));
  // Group the sidecar lineage by manager session once for the whole payload.
  // A manager with no sidecar history yields no group (no field, no section).
  const lineageByManager = new Map<string, LineageRecord[]>();
  const taskManager = registry.getTaskManager();
  const joined = taskManager
    ? await taskManager.joinedAgentSessionIds()
    : new Set<string>();
  if (taskManager) {
    for (const rec of await taskManager.lineageTasks()) {
      if (rec.sessionId === null) continue; // no parent, no card to nest under
      const group = lineageByManager.get(rec.sessionId);
      if (group) group.push(rec);
      else lineageByManager.set(rec.sessionId, [rec]);
    }
  }
  // D8 pin honesty: no persisted pin survives pointing at an id this list
  // excludes (pins predate B3's refusal). Pruned on the list-build path,
  // persisting only on a hit (dropPinned idiom). Promotions are already
  // out of `joined`, so a promoted session's pin is never touched.
  for (const id of getPinnedIds()) if (joined.has(id)) dropPinned(id);
  return logs
    .filter((log) => !activeIds.has(log.id) && !joined.has(log.id))
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
      const enriched = !row
        ? withPath
        : {
            ...withPath,
            state: row.state,
            ...(row.model ? { model: row.model } : {}),
            ...(row.profile ? { profile: row.profile } : {}),
            ...(row.title ? { title: row.title } : {}),
            ...(row.ctx_used != null ? { ctxUsed: row.ctx_used } : {}),
            ...(row.ctx_total != null ? { ctxTotal: row.ctx_total } : {}),
          };
      // Nested subagent lineage (spawn order, capped): omitted outright when
      // the sidecar attests none -- the client renders no section without a
      // field, so "no subagents" stays byte-identical to the old wire.
      const group = lineageByManager.get(log.id);
      if (group === undefined) return enriched;
      return {
        ...enriched,
        subagents: group.slice(-MAX_SUBAGENT_LINEAGE_ROWS).map(taskLineageWire),
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
  // D6 PROMOTION, made durable: this route is the ONLY manual Continue
  // (reconnect adoption goes through attachResumedSession with auto=true
  // and never passes here), so an auto/reconnect adoption structurally
  // cannot promote -- only a human claim does. Recording the promote
  // BEFORE the attach is safe: a failed attach over a log this lifetime
  // could not open leaves a promote line for a session nobody adopted,
  // whose only effect is that the log rides the plain list (honest: the
  // human reached for it) -- while recording it AFTER would race the
  // list rebuilds the attach's own broadcasts trigger.
  const logId = msg.logId as string;
  const taskManager = registry.getTaskManager();
  if (taskManager && (await taskManager.joinedAgentSessionIds()).has(logId)) {
    taskManager.promoteAgentSession(logId);
  }
  // Awaited for the settle contract: the attach reads the real log.
  await attachResumedSession(ws, registry, bridge, logId, 0, false).catch(
    (err: unknown) => {
      logger.error(`[websocket] loadLog failed: ${formatError(err)}`);
      SessionRegistry.sendSafe(ws, errorFrame(err));
    },
  );
}

/** The LOG_VIEWED / LOAD_OLDER_RESULT entry cap, ONE seam for both paths:
 *  images replaced by BYTE-HONEST STUBS ({ omitted, mimeType,
 *  bytes, entryIndex, imageIndex }, zero base64; the client fetches a single
 *  image back by coordinate via handleFetchImage below) and each tool_call
 *  annotated with its display parts + title-bar fold resolved against the
 *  LIVE registry (a browsed log has no registry of its own; the same
 *  resolution live frames and replays use, mapped through wireToolDisplay).
 *  `entryBase` is the FULL-LOG index of entries[0]: the stub coordinate
 *  lives in the cursor's append-only space (stable across appends AND
 *  RESETs), not the epoch-relative slice the windowing cuts. Additive
 *  per-call fields only -- hintless tools and non-call entries ride
 *  untouched, so the TEXT entry shape is unchanged and the windowing above
 *  this seam never touches a field. */
function capViewedLogEntries(
  entries: LogEntry[],
  toolRegistry: ToolRegistry | undefined,
  entryBase: number,
): Array<Record<string, unknown>> {
  const toolDisplay = registryDisplay(toolRegistry);
  const headerKeys = registryHeaderKeys(toolRegistry);
  const argDisplay = registryArgDisplay(toolRegistry);
  return entries.map((entry, i) => {
    const stubs = wireImageStubs(entry.images, entryBase + i);
    const calls = entry.tool_calls;
    const withImages = entry.images ? { ...entry, images: stubs } : entry;
    if (!Array.isArray(calls) || calls.length === 0) return withImages;
    let touched = false;
    const wired = calls.map((raw) => {
      const call = raw as {
        name?: string;
        arguments?: string | Record<string, unknown>;
        args?: Record<string, unknown>;
        function?: { name?: string; arguments?: string };
      };
      const name = call?.function?.name || call?.name || "";
      const display = wireToolDisplay(toolDisplay(name));
      const keys = headerKeys(name);
      if (!display && keys === undefined) return raw;
      touched = true;
      return {
        ...call,
        ...(display ? { display } : {}),
        ...(keys !== undefined
          ? {
              argsSummary: summarizeHeaderArgs(
                call?.function?.arguments ?? call?.arguments ?? call?.args ?? "",
                keys,
                argDisplay(name),
              ),
            }
          : {}),
      };
    });
    return touched ? { ...withImages, tool_calls: wired } : withImages;
  });
}

export async function handleViewLog(ctx: RouteContext): Promise<void> {
  const { ws, msg, core } = ctx;
  if (!msg.logId) return;
  // Honest refusal for a log that does not exist (deleteLog's wording): a
  // settled worker row whose durable log vanished must never paint an empty
  // transcript -- emptiness is a fact about an EXISTING log, not a default.
  const logPath0 = trySessionPath(msg.logId as string);
  let logExists = false;
  if (logPath0 !== undefined) {
    try {
      await access(logPath0);
      logExists = true;
    } catch {
      logExists = false;
    }
  }
  if (!logExists) {
    SessionRegistry.sendSafe(ws, { type: S2C.ERROR, message: `Log ${msg.logId} not found` });
    return;
  }
  // Awaited so the caller sees LOG_VIEWED/ERROR on return (real log read).
  // FULL read + epoch slice: identical entries to the epoch-default read,
  // but it also yields the epochStartIndex that rides the attestation as
  // epochToken (see history-window.ts -- loadOlder refuses a mismatch).
  await readSessionEntries(msg.logId as string, { full: true })
    .then((full) => {
      const epochStart = epochStartIndex(full);
      const entries = full.slice(epochStart);
      // Lazy history: ship the TRAILING window of conversation messages,
      // aligned to a turn boundary (history-window.ts). Older history pages
      // through C2S loadOlder against the oldestIndex shipped here. A
      // session that fits the window ships everything with NONE of the
      // additive fields -- byte-identical to the pre-windowing wire.
      const win = windowOlderThan(entries, entries.length, HISTORY_WINDOW_MESSAGES);
      const capped = capViewedLogEntries(
        entries.slice(win.start),
        core?.toolRegistry,
        // Stub coordinates count the FULL log (the cursor's space).
        epochStart + win.start,
      );
      SessionRegistry.sendSafe(ws, {
        type: S2C.LOG_VIEWED,
        logId: msg.logId,
        entries: capped,
        ...(win.hasOlder
          ? { oldestIndex: win.start, hasOlder: true, epochToken: epochStart }
          : {}),
      });
    })
    .catch((err: unknown) => {
      SessionRegistry.sendSafe(ws, errorFrame(err));
    });
}

/**
 * C2S loadOlder: the page of conversation messages immediately older than
 * `olderThan` (the oldestIndex of the window the client holds), aligned by
 * the same windowOlderThan seam as the initial window. Reads the SAME epoch
 * view the window was cut from (index-valid for appends -- the log is
 * append-only). A mid-socket RESET (/rewind, /undo, /clear via handleCommand
 * appends RESET + re-emitted history with NO attach) moves the epoch, which
 * silently re-points every epoch-relative index: the attestation frames
 * therefore carry `epochToken` (the full-log epochStartIndex the window was
 * cut at), the client echoes it, and a mismatch refuses honestly with
 * code "epoch_moved" instead of serving a page from the wrong epoch (the
 * client closes its seam on that class). A request without the token keeps
 * the pre-token behavior (older clients; never worse than before).
 * Refusals ride the correlated reply -- a bad index or unknown log never
 * serves garbage.
 */
export async function handleLoadOlder(ctx: RouteContext): Promise<void> {
  const { ws, msg, core } = ctx;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;
  // One seam for both browse modes: the id names a cold log OR a live
  // session (both have a durable epoch log on disk).
  const id =
    typeof msg.logId === "string" ? msg.logId : typeof msg.sessionId === "string" ? msg.sessionId : "";
  const refuse = (message: string, code?: string): void => {
    SessionRegistry.sendSafe(ws, {
      type: S2C.LOAD_OLDER_RESULT,
      requestId,
      ...(id !== "" ? { logId: id } : {}),
      ...(code !== undefined ? { code } : {}),
      error: message,
    });
  };
  if (id === "") return refuse("loadOlder requires a logId or sessionId");
  const olderThan = msg.olderThan;
  if (typeof olderThan !== "number" || !Number.isFinite(olderThan) || !Number.isInteger(olderThan)) {
    return refuse(`loadOlder olderThan must be an integer index, got ${JSON.stringify(olderThan)}.`);
  }
  // Untrusted page size: sanitized here, again inside windowOlderThan.
  const pageSize =
    typeof msg.pageSize === "number" && Number.isInteger(msg.pageSize) && msg.pageSize > 0
      ? Math.min(msg.pageSize, MAX_HISTORY_PAGE_MESSAGES)
      : HISTORY_WINDOW_MESSAGES;
  const epochToken = typeof msg.epochToken === "number" && Number.isInteger(msg.epochToken)
    ? msg.epochToken
    : undefined;
  // Awaited for the settle contract (real log read). FULL read + epoch
  // slice so the stale-epoch check sees the epochStartIndex the token
  // indexes (a default-epoch read cannot attest WHERE the epoch starts).
  await readSessionEntries(id, { full: true })
    .then((full) => {
      if (full.length === 0) return refuse(`No readable log for ${JSON.stringify(id)}.`);
      const epochStart = epochStartIndex(full);
      const entries = full.slice(epochStart);
      if (epochToken !== undefined && epochToken !== epochStart) {
        // The epoch moved under the held window (a mid-socket RESET): the
        // client's index means a DIFFERENT entry now. Refuse; the client
        // closes its seam on this class until its next attach.
        return refuse(
          `The session's epoch moved (epochToken ${epochToken} is no longer current). Older history must be re-attested.`,
          "epoch_moved",
        );
      }
      if (olderThan <= 0) return refuse(`Nothing is older than index ${olderThan}.`);
      if (olderThan > entries.length) {
        return refuse(`olderThan ${olderThan} is beyond log ${JSON.stringify(id)} (${entries.length} entries).`);
      }
      const page = windowOlderThan(entries, olderThan, pageSize);
      const capped = capViewedLogEntries(
        entries.slice(page.start, olderThan),
        core?.toolRegistry,
        // Stub coordinates count the FULL log (the cursor's space).
        epochStart + page.start,
      );
      SessionRegistry.sendSafe(ws, {
        type: S2C.LOAD_OLDER_RESULT,
        requestId,
        logId: id,
        entries: capped,
        oldestIndex: page.start,
        hasOlder: page.hasOlder,
        // Echo the CURRENT epoch token: the window stays in the epoch this
        // page proved live, so paging continues without a re-attestation.
        epochToken: epochStart,
      });
    })
    .catch((err: unknown) => {
      logger.warn(`[websocket] loadOlder failed: ${formatError(err)}`);
      refuse(formatError(err));
    });
}

/**
 * C2S fetchImage: ONE image, on demand, for a history frame's stub.
 * The client holds only coordinates -- (id, entryIndex,
 * imageIndex); NO path input crosses the wire, and the id names a cold log
 * OR a live session exactly like loadOlder (workspace/session-scoped by the
 * core log helper). The server RE-READS the durable FULL log (append-only:
 * a coordinate stays valid across appends and RESETs, so no epoch token
 * guards this route) and answers the ONE requested payload through the same
 * wireImages normalization + MAX_WIRE_IMAGE_BASE64_BYTES cap the live frames
 * use -- an over-cap image honestly answers skipped+note, never bytes.
 * Absent log / out-of-range entry / imageless entry / empty payload refuse
 * with a correlated honest one-liner (the LIST_DIR_RESULT posture); stale or
 * duplicate replies are the client's to drop by requestId.
 */
export async function handleFetchImage(ctx: RouteContext): Promise<void> {
  const { ws, msg } = ctx;
  const requestId = typeof msg.requestId === "number" ? msg.requestId : undefined;
  const id =
    typeof msg.logId === "string" ? msg.logId : typeof msg.sessionId === "string" ? msg.sessionId : "";
  const entryIndex =
    typeof msg.entryIndex === "number" && Number.isSafeInteger(msg.entryIndex) && msg.entryIndex >= 0
      ? msg.entryIndex
      : undefined;
  const imageIndex =
    typeof msg.imageIndex === "number" && Number.isSafeInteger(msg.imageIndex) && msg.imageIndex >= 0
      ? msg.imageIndex
      : undefined;
  const refuse = (message: string): void => {
    SessionRegistry.sendSafe(ws, {
      type: S2C.FETCH_IMAGE_RESULT,
      requestId,
      ...(id !== "" ? { logId: id } : {}),
      ...(entryIndex !== undefined ? { entryIndex } : {}),
      ...(imageIndex !== undefined ? { imageIndex } : {}),
      error: message,
    });
  };
  if (id === "") return refuse("fetchImage requires a logId or sessionId");
  if (entryIndex === undefined) {
    return refuse(`fetchImage entryIndex must be a non-negative integer index, got ${JSON.stringify(msg.entryIndex)}.`);
  }
  if (imageIndex === undefined) {
    return refuse(`fetchImage imageIndex must be a non-negative integer index, got ${JSON.stringify(msg.imageIndex)}.`);
  }
  // Awaited for the settle contract (real log read).
  await readSessionEntries(id, { full: true })
    .then((full) => {
      if (full.length === 0) return refuse(`No readable log for ${JSON.stringify(id)}.`);
      if (entryIndex >= full.length) {
        return refuse(`entryIndex ${entryIndex} is beyond log ${JSON.stringify(id)} (${full.length} entries).`);
      }
      const rawImages = (full[entryIndex] as { images?: unknown }).images;
      if (!Array.isArray(rawImages) || rawImages.length === 0) {
        return refuse(`Entry ${entryIndex} of log ${JSON.stringify(id)} carries no images.`);
      }
      if (imageIndex >= rawImages.length) {
        return refuse(
          `imageIndex ${imageIndex} is out of range for entry ${entryIndex} of log ${JSON.stringify(id)} (${rawImages.length} images).`,
        );
      }
      const imgs = wireImages([rawImages[imageIndex]]);
      if (!imgs || imgs.length === 0) {
        return refuse(`Image ${imageIndex} of entry ${entryIndex} has no readable payload.`);
      }
      SessionRegistry.sendSafe(ws, {
        type: S2C.FETCH_IMAGE_RESULT,
        requestId,
        logId: id,
        entryIndex,
        imageIndex,
        image: imgs[0],
      });
    })
    .catch((err: unknown) => {
      logger.warn(`[websocket] fetchImage failed: ${formatError(err)}`);
      refuse(formatError(err));
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
  // B5 label: a hit on a worker-attested id (the id Recent Logs hides)
  // carries its delegation task description, read from the sidecar lineage
  // (cold records) or THIS lifetime's task registry (live/just-settled
  // records the boot snapshot cannot see). No description to attest -> no
  // field (honest non-claim); interactive hits never enter `joined`, so
  // their payloads are untouched.
  const taskManager = registry.getTaskManager();
  const joined = taskManager
    ? await taskManager.joinedAgentSessionIds()
    : new Set<string>();
  const taskDescByWorker = new Map<string, string>();
  if (taskManager) {
    for (const rec of await taskManager.lineageTasks()) {
      if (rec.agentSessionId !== null) taskDescByWorker.set(rec.agentSessionId, rec.description);
    }
    for (const info of taskManager.listTasks()) {
      if (info.agentSessionId) taskDescByWorker.set(info.agentSessionId, info.description);
    }
  }
  const hits: SearchHitWire[] = [];
  for (const match of matches) {
    if (hits.length >= MAX_SEARCH_HITS) break;
    const { matchCount, snippets } = scanText(match.text, needle);
    if (matchCount === 0) continue;
    const desc = joined.has(match.sessionId)
      ? taskDescByWorker.get(match.sessionId)
      : undefined;
    hits.push({
      logId: match.sessionId,
      lastActivityAt: match.lastActivityAt,
      matchCount,
      ...(match.profile ? { profile: match.profile } : {}),
      ...(match.model ? { model: match.model } : {}),
      ...(desc ? { subagentOf: desc } : {}),
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
