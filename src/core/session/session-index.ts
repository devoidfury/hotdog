// Session index: a disposable bun:sqlite mirror of the JSONL session logs.
//
// The JSONL logs stay the system of record. Every fact in this index is
// re-derivable from a log scan (or from the filesystem), so deleting the db
// file costs a re-scan and nothing else. The one carve-out is the resume
// counter: its system of record is the `resume_attempt` record IN the log;
// this index only mirrors the count, so losing the index never loses the
// livelock cap.
//
// Derivability discipline for `state`: the writer only touches state at a
// point where it has just fsynced the log fact that honestly witnesses it
// (question_asked -> awaiting_question). It NEVER declares "interrupted" or
// "active": nobody can witness their own crash, and a live writer declaring
// truth about a session outranks the log it just wrote. `interrupted` is
// produced solely by boot reconcile, from log facts. The row's size+mtime
// doubles as the staleness marker: a crash between the fsynced record and
// the index transaction leaves them disagreeing with the file, and the next
// reconcile re-reads and recomputes.
//
// Durability honesty: WAL + synchronous=NORMAL loses tail transactions on
// power loss, so synchronous=FULL is always on and we eat the fsync --
// commit-point writes are rare (one per durability record). SQLite's win
// over JSONL here is torn-tail rollback and queryability, nothing more.
//
// The `active`/`parked` states from the design notes are deliberately absent
// in part 2: parked is part 3 (livelock cap), and "active" is live-registry
// knowledge at query time (the webui already filters its own live sessions);
// claim columns with no consumer would just drift.

import { Database } from "bun:sqlite";
import { mkdirSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@utils/logger.ts";
import { formatError } from "@core/error.ts";
import {
  LOG_SOURCE,
  collectDurabilityFacts,
  readSessionEntries,
  sessionPath,
  sessionsDir,
} from "./session-log.ts";

export const SESSION_STATE = {
  IDLE: "idle",
  AWAITING_QUESTION: "awaiting_question",
  INTERRUPTED: "interrupted",
} as const;
export type SessionState = (typeof SESSION_STATE)[keyof typeof SESSION_STATE];

/** Open-call kinds mirrored from the log's durability records. */
export const OPEN_CALL_KIND = {
  STARTED: "started",
  QUESTION: "question",
} as const;
export type OpenCallKind = (typeof OPEN_CALL_KIND)[keyof typeof OPEN_CALL_KIND];

export interface SessionRow {
  session_id: string;
  path: string;
  updated_at: number;
  state: SessionState;
  last_seq: number;
  size: number;
  mtime: number;
  resume_count: number;
  title: string | null;
  profile: string | null;
  model: string | null;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id   TEXT PRIMARY KEY,
  path         TEXT NOT NULL,
  updated_at   INTEGER NOT NULL,
  state        TEXT NOT NULL,
  last_seq     INTEGER NOT NULL,
  size         INTEGER NOT NULL,
  mtime        REAL NOT NULL,
  resume_count INTEGER NOT NULL DEFAULT 0,
  title        TEXT,
  profile      TEXT,
  model        TEXT
);
CREATE TABLE IF NOT EXISTS open_calls (
  session_id   TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  kind         TEXT NOT NULL,
  PRIMARY KEY (session_id, tool_call_id)
);
`;

let db: Database | null = null;
let dbFile: string | null = null;

/** The index lives inside the sessions dir: HOTDOG_SESSIONS_DIR moves the
 *  whole world, and one rm -rf sweeps it. Fully disposable either way --
 *  a missing file makes the next boot rebuild it from the logs. */
export function sessionIndexPath(): string {
  return join(sessionsDir(), "sessions.sqlite");
}

export function openSessionIndex(): Database {
  const path = sessionIndexPath();
  if (db && dbFile === path) return db;
  if (db) {
    // The sessions dir moved (env override): reopen against the new home.
    try { db.close(); } catch {}
  }
  mkdirSync(sessionsDir(), { recursive: true });
  const next = new Database(path, { create: true });
  next.exec("PRAGMA journal_mode = WAL;");
  next.exec("PRAGMA synchronous = FULL;");
  // Multiple hotdog processes share the index (webui + one-shot + CLI).
  next.exec("PRAGMA busy_timeout = 5000;");
  next.exec(SCHEMA);
  db = next;
  dbFile = path;
  return db;
}

export function closeSessionIndex(): void {
  if (db) {
    try { db.close(); } catch {}
  }
  db = null;
  dbFile = null;
}

/** State derived purely from durability facts (no writer declarations). */
export function deriveSessionState(facts: {
  started: Set<string>;
  answered: Set<string>;
  asked: Array<{ toolCallId: string }>;
}): SessionState {
  for (const q of facts.asked) {
    if (!facts.answered.has(q.toolCallId)) return SESSION_STATE.AWAITING_QUESTION;
  }
  for (const id of facts.started) {
    if (!facts.answered.has(id)) return SESSION_STATE.INTERRUPTED;
  }
  return SESSION_STATE.IDLE;
}

/** First user-visible text in the log, truncated, for sidebar rendering. */
function deriveTitle(entries: Array<{ source: string; content: unknown }>): string | null {
  for (const e of entries) {
    if (e.source !== LOG_SOURCE.INPUT && e.source !== LOG_SOURCE.PROMPT) continue;
    let text = "";
    if (typeof e.content === "string") {
      text = e.content;
    } else if (Array.isArray(e.content)) {
      const part = e.content.find(
        (p) => p && typeof p === "object" && (p as Record<string, unknown>).type === "text",
      ) as { text?: unknown } | undefined;
      text = typeof part?.text === "string" ? part.text : "";
    }
    text = text.trim();
    if (text) return text.length > 120 ? `${text.slice(0, 119)}…` : text;
  }
  return null;
}

/**
 * Rebuild one session's row (and its open_calls mirror) from a full log read.
 * This is the adopt/reindex/repair path; returns null when the log file does
 * not exist. Position fields (size/mtime/updated_at) come from a stat taken
 * around the read, so a row is only ever "fresh" for bytes it actually read.
 */
export async function syncSessionFromLog(sessionId: string): Promise<SessionRow | null> {
  const path = sessionPath(sessionId); // validates the id
  let st;
  try {
    st = statSync(path);
  } catch {
    return null;
  }
  const entries = await readSessionEntries(sessionId);
  const facts = collectDurabilityFacts(entries);
  const state = deriveSessionState(facts);
  const title = deriveTitle(entries);

  const d = openSessionIndex();
  const write = d.transaction(() => {
    d.run(
      `INSERT INTO sessions (session_id, path, updated_at, state, last_seq, size, mtime, resume_count, title)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         path = excluded.path,
         updated_at = excluded.updated_at,
         state = excluded.state,
         last_seq = excluded.last_seq,
         size = excluded.size,
         mtime = excluded.mtime,
         resume_count = excluded.resume_count,
         title = COALESCE(excluded.title, sessions.title)`,
      [
        sessionId,
        path,
        st.mtimeMs,
        state,
        entries.length,
        st.size,
        st.mtimeMs,
        facts.resumeAttempts,
        title,
      ],
    );
    d.run("DELETE FROM open_calls WHERE session_id = ?", [sessionId]);
    const ins = d.query(
      "INSERT INTO open_calls (session_id, tool_call_id, kind) VALUES (?, ?, ?)",
    );
    for (const id of facts.started) {
      if (!facts.answered.has(id)) ins.run(sessionId, id, OPEN_CALL_KIND.STARTED);
    }
    for (const q of facts.asked) {
      if (!facts.answered.has(q.toolCallId)) ins.run(sessionId, q.toolCallId, OPEN_CALL_KIND.QUESTION);
    }
  });
  write();
  return getSessionRow(sessionId);
}

export function getSessionRow(sessionId: string): SessionRow | null {
  return openSessionIndex()
    .query<SessionRow, [string]>("SELECT * FROM sessions WHERE session_id = ?")
    .get(sessionId);
}

export interface ReconcileStats {
  scanned: number;
  unchanged: number;
  /** Changed rows re-derived from a log re-read (size/mtime disagreed). */
  reindexed: number;
  /** Logs adopted without a row. */
  adopted: number;
  /** Rows whose log file is gone (row dropped, warned). */
  quarantined: number;
  /** Full log reads performed -- 0 proves a stat-only boot. */
  logReads: number;
  errors: number;
}

/**
 * Boot reconcile: readdir + stat only. A log is read only when its size or
 * mtime disagrees with the row's stored position (or `full` -- the --reindex
 * repair mode). Rows whose file vanished are quarantined: warned and dropped
 * (the file is the system of record; a row for a missing log is undeletable
 * truth, and the warn is the audit trail).
 */
export async function reconcileSessionIndex(
  opts: { full?: boolean } = {},
): Promise<ReconcileStats> {
  const d = openSessionIndex();
  const stats: ReconcileStats = {
    scanned: 0,
    unchanged: 0,
    reindexed: 0,
    adopted: 0,
    quarantined: 0,
    logReads: 0,
    errors: 0,
  };

  const dir = sessionsDir();
  let files: string[] = [];
  try {
    files = await readdir(dir);
  } catch {
    // No sessions dir yet: nothing to reconcile (rows, if any, quarantine below).
  }

  const seen = new Set<string>();
  const rowStmt = d.query<{ size: number; mtime: number }, [string]>(
    "SELECT size, mtime FROM sessions WHERE session_id = ?",
  );

  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.slice(0, -".jsonl".length);
    let path: string;
    try {
      path = sessionPath(sessionId);
    } catch {
      continue; // invalid id on disk: leave the file alone, index nothing
    }
    seen.add(sessionId);
    stats.scanned++;

    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }

    const row = rowStmt.get(sessionId);
    if (!opts.full && row && row.size === st.size && row.mtime === st.mtimeMs) {
      stats.unchanged++;
      continue; // the stat-only fast path: fresh row, no read
    }
    if (row) stats.reindexed++;
    else stats.adopted++;

    stats.logReads++;
    try {
      await syncSessionFromLog(sessionId);
    } catch (err) {
      stats.errors++;
      logger.warn(`[session-index] failed to sync ${sessionId}: ${formatError(err)}`);
    }
  }

  for (const row of d.query<{ session_id: string }, []>(
    "SELECT session_id FROM sessions",
  ).all()) {
    if (seen.has(row.session_id)) continue;
    stats.quarantined++;
    logger.warn(
      `[session-index] quarantining index row for missing session log: ${row.session_id} (dropped; the log is the source of truth)`,
    );
    d.run("DELETE FROM open_calls WHERE session_id = ?", [row.session_id]);
    d.run("DELETE FROM sessions WHERE session_id = ?", [row.session_id]);
  }

  return stats;
}

// ---------------------------------------------------------------------------
// Writer commit-point hooks
//
// Called by the session-log extension AFTER the JSONL record has been fsynced
// (the log commits first; the index transaction mirrors it). A crash between
// the two leaves size/mtime stale, and the next reconcile repairs the row
// from the log -- so these calls are best-effort by design, but a failed one
// is logged loudly: it degrades boot to O(changed) work, not correctness.
//
// Row-missing case: the index was deleted mid-session (the delete-the-index
// DoD). The honest position then comes only from re-reading the log (which
// already contains the just-appended record), so the helpers sync from the
// log and skip the position delta.
// ---------------------------------------------------------------------------

/**
 * Bump the row's log position (size/mtime/last_seq) to the file's current
 * state, then apply `mutate` inside the same sqlite transaction. `delta` is
 * the number of log entries appended since the row's last position update.
 *
 * Row-missing case: the index was deleted mid-session (the delete-the-index
 * DoD). The honest position then comes only from re-reading the log (which
 * already contains the just-appended record), so the sync replaces the delta
 * -- and it already mirrored this commit point's facts. `mutate` may still
 * run afterwards only when it is an idempotent mirror upsert (open-call
 * inserts, state CASE, metadata COALESCE); arithmetic bumps must set
 * `idempotentOnMissing` false to avoid double-counting.
 */
async function atCommitPoint(
  sessionId: string,
  delta: number,
  mutate?: (d: Database) => void,
  idempotentOnMissing = false,
): Promise<void> {
  const d = openSessionIndex();
  const existing = d
    .query("SELECT 1 AS x FROM sessions WHERE session_id = ?")
    .get(sessionId);
  if (!existing) {
    await syncSessionFromLog(sessionId);
    if (mutate && idempotentOnMissing) {
      const fix = d.transaction(() => mutate(d));
      fix();
    }
    return;
  }
  const path = sessionPath(sessionId);
  const run = d.transaction(() => {
    const st = statSync(path);
    d.run(
      `UPDATE sessions SET last_seq = last_seq + ?, size = ?, mtime = ?, updated_at = ?
       WHERE session_id = ?`,
      [delta, st.size, st.mtimeMs, st.mtimeMs, sessionId],
    );
    mutate?.(d);
  });
  run();
}

/** tool_started fsynced: mirror the open call; state stays honest (untouched). */
export async function indexToolStarted(
  sessionId: string,
  toolCallId: string,
  meta?: { profile?: string; model?: string },
): Promise<void> {
  await atCommitPoint(sessionId, 1, (d) => {
    d.run(
      `INSERT INTO open_calls (session_id, tool_call_id, kind) VALUES (?, ?, ?)
       ON CONFLICT(session_id, tool_call_id) DO NOTHING`,
      [sessionId, toolCallId, OPEN_CALL_KIND.STARTED],
    );
    if (meta) {
      d.run(
        `UPDATE sessions SET profile = COALESCE(?, profile), model = COALESCE(?, model)
         WHERE session_id = ?`,
        [meta.profile ?? null, meta.model ?? null, sessionId],
      );
    }
  }, true);
}

/**
 * question_asked fsynced: awaiting_question is honest both alive and dead --
 * the session IS waiting on a human the moment the record lands.
 */
export async function indexQuestionAsked(sessionId: string, toolCallId: string): Promise<void> {
  await atCommitPoint(sessionId, 1, (d) => {
    d.run(
      `INSERT INTO open_calls (session_id, tool_call_id, kind) VALUES (?, ?, ?)
       ON CONFLICT(session_id, tool_call_id) DO NOTHING`,
      [sessionId, toolCallId, OPEN_CALL_KIND.QUESTION],
    );
    d.run("UPDATE sessions SET state = ? WHERE session_id = ?", [
      SESSION_STATE.AWAITING_QUESTION,
      sessionId,
    ]);
  }, true);
}

/**
 * tool_result appended: close the mirrored call and re-derive state from the
 * open_calls mirror alone (no in-memory truth). Open non-question started
 * calls do NOT make a live session "interrupted" (the writer is alive), so
 * the query only distinguishes awaiting_question from idle.
 */
export async function indexToolResult(sessionId: string, toolCallId: string): Promise<void> {
  await atCommitPoint(sessionId, 1, (d) => {
    d.run("DELETE FROM open_calls WHERE session_id = ? AND tool_call_id = ?", [
      sessionId,
      toolCallId,
    ]);
    d.run(
      `UPDATE sessions SET state =
         CASE WHEN EXISTS (
           SELECT 1 FROM open_calls WHERE session_id = ? AND kind = ?
         ) THEN ? ELSE ? END
       WHERE session_id = ?`,
      [sessionId, OPEN_CALL_KIND.QUESTION, SESSION_STATE.AWAITING_QUESTION, SESSION_STATE.IDLE, sessionId],
    );
  }, true);
}

/** resume_attempt fsynced: mirror the counter (log remains its source of record). */
export async function indexResumeAttempt(sessionId: string): Promise<void> {
  await atCommitPoint(sessionId, 1, (d) => {
    d.run("UPDATE sessions SET resume_count = resume_count + 1 WHERE session_id = ?", [
      sessionId,
    ]);
  });
}
