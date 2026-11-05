// The session log's append chokepoint and its live record counts.
//
// EVERY committed record to a session's JSONL goes through queuedAppend or
// queuedFsyncAppend below, so counting lives with the writer: a record
// increments the session's live count exactly when its bytes land (append
// resolved), under the ONE exclusion rule the cold rows use
// (core's countSessionLogEntries -- system_prompt/reset never counted). A
// failed write counts nothing, which is honest: the cold row can never show
// a record the file does not hold, so an unwritable log degrades the live
// count the same way it degrades the log itself. The websocket sidebar reads
// getRecordCount for live rows; with the seed below establishing the base at
// registration, the live row equals what listSessionLogs reports for the
// same file at the same moment.
//
// The queue and counts are module state (one chokepoint per process, like
// the boot-reconcile gate next to it in index.ts): sessions sharing a log
// path share one serialized queue, which is what the order guarantee needs.

import { appendFile, open } from "node:fs/promises";
import {
  countSessionLogEntries,
  isCountedLogEntry,
  readSessionEntries,
  sessionPath,
} from "@core/session/session-log.ts";
import { formatError } from "@core/error.ts";
import { logger } from "@utils/logger.ts";

// Serialize writes per session file. Hook handlers fire independently (addMessage
// does not await notifyHooks), so floating appendFile calls can land out of dispatch
// order -- e.g. a /fork's first prompt entry written below the copied history it
// should follow. Chaining keeps file order equal to hook dispatch order, which holds
// because handlers enqueue synchronously (async handlers run to their first await
// before the next dispatch).
const writeQueues = new Map<string, Promise<void>>();

// Live record counts keyed by session id: committed counted records in the
// session's log (seeded at registration, then bumped per landed append).
const recordCounts = new Map<string, number>();

// Sessions whose registration seed could not read an existing log. Their
// count is unknowable (a blind append tally would fabricate a base the file
// may not have), so getRecordCount refuses to report one; landed appends
// wait for the next successful seed. Cleared with the count at session end.
const unseeded = new Set<string>();

/** Apply the shared sidebar rule to one about-to-land record. */
const countCommitted = (sessionId: string, source: string): void => {
  if (unseeded.has(sessionId)) return;
  // The predicate is core's -- the very one countSessionLogEntries sums for
  // the cold rows -- so a record counts live iff a cold read of the same
  // line would count it.
  if (!isCountedLogEntry({ source })) return;
  recordCounts.set(sessionId, (recordCounts.get(sessionId) ?? 0) + 1);
};

/**
 * Durability-class append: same write queue (file order = dispatch order),
 * fsynced so the record and everything appended before it survive
 * kill -9 / power loss. Only for records whose presence on disk carries
 * meaning: tool_started, question_asked.
 */
export const queuedFsyncAppend = (
  sessionId: string,
  logPath: string,
  line: string,
  source: string,
): Promise<void> => {
  const prev = writeQueues.get(logPath) ?? Promise.resolve();
  const write = async () => {
    const fh = await open(logPath, "a");
    try {
      await fh.appendFile(line);
      // Bytes are in the file from here on: a later sync failure loses
      // durability, not the record -- and the cold reader would count it.
      countCommitted(sessionId, source);
      await fh.sync();
    } finally {
      await fh.close();
    }
  };
  const next = prev.then(write, write);
  writeQueues.set(logPath, next);
  return next;
};

export const queuedAppend = (
  sessionId: string,
  logPath: string,
  line: string,
  source: string,
): Promise<void> => {
  const prev = writeQueues.get(logPath) ?? Promise.resolve();
  const write = async () => {
    await appendFile(logPath, line);
    countCommitted(sessionId, source);
  };
  // Chain on either outcome: one failed write must not poison the queue.
  const next = prev.then(write, write);
  writeQueues.set(logPath, next);
  return next;
};

/** Await (never rethrow) whatever is queued for a path: reads must see every
 *  dispatched entry on disk (the readEntries drain). */
export async function drainWrites(logPath: string): Promise<void> {
  const pending = writeQueues.get(logPath);
  if (pending) {
    try {
      await pending;
    } catch {}
  }
}

/** Reclaim a dead session's queue entry (its last write has settled or been
 *  dropped; the next append re-chains). */
export function dropWrites(logPath: string): void {
  writeQueues.delete(logPath);
}

/**
 * Seed a registered session's live count from its EXISTING log (one-time
 * full read, once per registration). A session adopted over an existing log
 * (-s resume, webui cold-load, delete-then-resume) starts at the file's
 * recorded count, not 0; a session with no log yet seeds 0.
 *
 * The read is chained behind the path's write queue, so it snapshots the
 * file strictly between already-dispatched appends (counted, then absorbed
 * into the absolute base) and later ones (increment on top of that base).
 * Order cannot interleave with the read by construction -- the same
 * serialization the append order guarantee relies on.
 */
export function seedRecordCount(sessionId: string): Promise<void> {
  let logPath: string;
  try {
    logPath = sessionPath(sessionId);
  } catch {
    // Rejected id: no file was ever addressable, nothing to seed.
    return Promise.resolve();
  }
  const prev = writeQueues.get(logPath) ?? Promise.resolve();
  const seed = async () => {
    try {
      // Full view (not epoch): the sidebar rule counts every record in the
      // file except system_prompt/reset, including history above a RESET.
      recordCounts.set(sessionId, countSessionLogEntries(await readSessionEntries(sessionId, { full: true })));
      unseeded.delete(sessionId);
    } catch (err) {
      // Unreadable existing log: refuse to report a count at all (landed
      // appends alone would fabricate a base). Parity is never guessed.
      unseeded.add(sessionId);
      logger.warn(
        `[session-log] record-count seed failed for ${sessionId}: ${formatError(err)} -- live row shows no count until the log reads again`,
      );
    }
  };
  const next = prev.then(seed, seed);
  writeQueues.set(logPath, next);
  return next;
}

/** The live row's message count: committed counted records in the session's
 *  log. Undefined until seeded, or while a failed seed leaves the base
 *  unknowable (the row then omits the field outright -- no fabricated
 *  parity; an unwritable log simply never appends, so the count stays
 *  exactly what a cold read of the file would report). */
export function getRecordCount(sessionId: string): number | undefined {
  if (unseeded.has(sessionId)) return undefined;
  return recordCounts.get(sessionId);
}

/** Reclaim a dead session's count; a later re-registration re-seeds. */
export function dropRecordCount(sessionId: string): void {
  recordCounts.delete(sessionId);
  unseeded.delete(sessionId);
}
