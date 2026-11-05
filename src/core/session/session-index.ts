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
// `parked` is derivable from the log (MAX_CONSECUTIVE_AUTO_RESUMES auto
// resume_attempt records with no progress between them) and outranks the
// other states: it is the gate on the next auto-resume, and the writer only
// sets it at the fsynced resume_attempt commit point where the cap is
// reached. `active` stays absent: it is live-registry knowledge at query
// time (the webui already filters its own live sessions); claim columns
// with no consumer would just drift.

import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "@utils/logger.ts";
import { formatError } from "@core/error.ts";
import {
  LOG_SOURCE,
  MAX_CONSECUTIVE_AUTO_RESUMES,
  collectDurabilityFacts,
  epochEntries,
  readSessionEntries,
  searchableEntryText,
  sessionPath,
  sessionsDir,
  type LogEntry,
} from "./session-log.ts";

export const SESSION_STATE = {
  IDLE: "idle",
  AWAITING_QUESTION: "awaiting_question",
  INTERRUPTED: "interrupted",
  /** Auto-resume churn without progress hit the cap; auto-resumes are
   *  refused until a manual resume (the escape hatch) or progress. */
  PARKED: "parked",
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
  /** Sidebar ctx display: last token_usage record's per-call totalTokens. */
  ctx_used: number | null;
  /** Its contextWindow; absent/0 on pre-window logs. */
  ctx_total: number | null;
  /**
   * The session's searchable text (user input + assistant response text,
   * see searchableEntryText), mirrored so full-text search reads a compact
   * column instead of re-parsing the JSONL. Re-derivable from the log scan
   * like every other column, and gated on the same size/mtime staleness
   * marker: a search only trusts it when the row is fresh for the file.
   */
  search_text: string | null;
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
  model        TEXT,
  ctx_used     INTEGER,
  ctx_total    INTEGER,
  search_text  TEXT
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

/**
 * True when a bun:sqlite error means the index BYTES are corrupt and
 * quarantine-and-rebuild is the right repair. Environmental failures
 * (SQLITE_BUSY from a sibling hotdog process, READONLY/CANTOPEN from
 * permissions or a full disk) are NOT corruption: a healthy shared index
 * renamed aside over a lock timeout would split a live WAL off its owner.
 */
export function isIndexCorruption(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" && (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB");
}

/** Open + prepare one index file. Any throw (corrupt header, WAL failure,
 *  schema refusal) closes the handle before propagating, so a quarantined
 *  file never stays pinned by a half-open connection. */
function openPrepared(path: string): Database {
  const next = new Database(path, { create: true });
  try {
    next.exec("PRAGMA journal_mode = WAL;");
    next.exec("PRAGMA synchronous = FULL;");
    // Multiple hotdog processes share the index (webui + one-shot + CLI).
    next.exec("PRAGMA busy_timeout = 5000;");
    next.exec(SCHEMA);
    // Column adds for pre-existing DBs (CREATE TABLE IF NOT EXISTS is a
    // no-op there): ALTER ADD COLUMN is nullable, cheap, and idempotent-
    // guarded via table_info (sqlite has no IF NOT EXISTS for columns).
    const cols = new Set(
      next
        .query<{ name: string }, []>("PRAGMA table_info(sessions)")
        .all()
        .map((c) => c.name),
    );
    if (!cols.has("ctx_used")) next.exec("ALTER TABLE sessions ADD COLUMN ctx_used INTEGER");
    if (!cols.has("ctx_total")) next.exec("ALTER TABLE sessions ADD COLUMN ctx_total INTEGER");
    if (!cols.has("search_text")) next.exec("ALTER TABLE sessions ADD COLUMN search_text TEXT");
  } catch (err) {
    try { next.close(); } catch {}
    throw err;
  }
  return next;
}

/**
 * Rename a corrupt index (and its WAL sidecars, whose stale frames must not
 * meet a fresh main db) aside for postmortem -- NEVER delete: the corrupt
 * bytes are the evidence, and the rebuild costs only a log re-scan. Returns
 * the renamed main-file path, or null when there was no file to move.
 */
function quarantineIndexFiles(path: string): string | null {
  let aside: string | null = null;
  let stamp = Date.now();
  // renameSync silently replaces an existing destination; "never delete"
  // means stepping forward until the quarantine name is free.
  while (existsSync(`${path}.corrupt-${stamp}`)) stamp++;
  const base = `${path}.corrupt-${stamp}`;
  for (const suffix of ["", "-wal", "-shm"]) {
    const src = path + suffix;
    try {
      statSync(src);
    } catch {
      continue; // sidecar absent (or already gone): nothing to move
    }
    try {
      renameSync(src, base + suffix);
      if (suffix === "") aside = base + suffix;
    } catch (err) {
      logger.error(
        `[session-index] could not quarantine ${src}: ${formatError(err)} -- leaving it in place`,
      );
    }
  }
  return aside;
}

export function openSessionIndex(): Database {
  const path = sessionIndexPath();
  if (db && dbFile === path) return db;
  if (db) {
    // The sessions dir moved (env override): reopen against the new home.
    try { db.close(); } catch {}
  }
  mkdirSync(sessionsDir(), { recursive: true });
  let next: Database;
  try {
    next = openPrepared(path);
  } catch (err) {
    if (!isIndexCorruption(err)) {
      // Environmental failure (BUSY from a sibling hotdog process,
      // READONLY/CANTOPEN from permissions or a full disk): propagate
      // honestly. Renaming a healthy index aside over a lock timeout would
      // destroy a mirror another live process owns.
      throw err;
    }
    // Corrupt index: quarantine aside and rebuild empty. The logs are the
    // system of record, so this only costs re-reads -- reconcile (boot, or
    // the row-missing sync in atCommitPoint) repopulates every row. Without
    // this the throw rethrows forever and the process runs de-indexed for
    // its whole life (boot reconcile catches once; every later open fails).
    const quarantined = quarantineIndexFiles(path);
    logger.error(
      `[session-index] index at ${path} failed to open (${formatError(err)}); ` +
        (quarantined
          ? `quarantined the corrupt file to ${quarantined}`
          : "no index file was in the way") +
        " -- rebuilding an empty index from the session logs",
    );
    // A second failure is environmental (disk/permissions), not index
    // corruption: propagate honestly instead of looping.
    next = openPrepared(path);
  }
  db = next;
  dbFile = path;
  return db;
}

/**
 * Quarantine + close + rebuild after corruption is DISCOVERED ON AN OPEN
 * HANDLE. SQLite is lazy: an index with damaged leaf pages opens fine and
 * throws only when a query reads the bad page; without this the throw
 * repeats for the life of the process. Order matters: close BEFORE moving
 * files so no WAL checkpoint writes into the evidence. The rebuild is
 * empty -- reconcile and the writer's row-missing path repopulate it from
 * the JSONL logs, the system of record.
 */
function recoverIndexCorruption(err: unknown): void {
  const path = sessionIndexPath();
  closeSessionIndex();
  const quarantined = quarantineIndexFiles(path);
  logger.error(
    `[session-index] index corrupted mid-run (${formatError(err)}); ` +
      (quarantined
        ? `quarantined the corrupt file to ${quarantined}`
        : "no index file was in the way") +
      " -- rebuilt an empty index; the session logs repopulate it",
  );
}

/**
 * Run a synchronous index operation with corruption recovery: if the
 * operation throws a corruption error, quarantine + rebuild and retry
 * exactly once on the fresh handle. Callers' ops must be re-runnable
 * against a rebuilt empty index (reads, upserts, delete+insert txns --
 * first-attempt transactions roll back, so a retry never double-applies).
 * A second failure propagates honestly (it is no longer recoverable
 * corruption: the file is brand new). Environmental errors never retry.
 */
function withIndex<T>(op: (d: Database) => T): T {
  try {
    return op(openSessionIndex());
  } catch (err) {
    if (!isIndexCorruption(err)) throw err;
    recoverIndexCorruption(err);
    return op(openSessionIndex());
  }
}

export function closeSessionIndex(): void {
  if (db) {
    try { db.close(); } catch {}
  }
  db = null;
  dbFile = null;
}

/** State derived purely from durability facts (no writer declarations).
 *  parked outranks everything: it is the gate on the next auto-resume. */
export function deriveSessionState(facts: {
  started: Set<string>;
  answered: Set<string>;
  asked: Array<{ toolCallId: string }>;
  consecutiveAutoResumes?: number;
  /** v2 turn lifecycle: the log's last turn never reached turn_end. */
  openTurn?: boolean;
}): SessionState {
  if ((facts.consecutiveAutoResumes ?? 0) >= MAX_CONSECUTIVE_AUTO_RESUMES) {
    return SESSION_STATE.PARKED;
  }
  for (const q of facts.asked) {
    if (!facts.answered.has(q.toolCallId)) return SESSION_STATE.AWAITING_QUESTION;
  }
  // An open v2 turn is an interrupted turn even when no tool call dangles
  // (crash mid-generation leaves a clean-looking tail).
  if (facts.openTurn) return SESSION_STATE.INTERRUPTED;
  for (const id of facts.started) {
    if (!facts.answered.has(id)) return SESSION_STATE.INTERRUPTED;
  }
  return SESSION_STATE.IDLE;
}

// ---------------------------------------------------------------------------
// Session title: a deterministic heuristic headline over the first user
// messages. No model call -- the index is disposable, so the title must be
// purely re-derivable from the log, and every rebuild must produce the exact
// same bytes. Ruleset corpus-tuned against the full session history: each
// strip earns its keep there (the tuning log lives in the commit).

/** Hard word budget for a finished title. */
const TITLE_WORD_CAP = 12;
/** First N user texts considered; the first title-worthy one wins. */
const TITLE_SCAN_MESSAGES = 5;
/** Positional decay in the sentence picker: later sentences need to earn
 *  their way past the opener, but not by much (0.5 over-penalized, 0 just
 *  takes sentence one). */
const SENTENCE_DECAY = 0.25;

/** Scoring stopwords: words that never make a sentence title-worthy. */
const TITLE_STOPWORDS = new Set(
  ("a about above after again against all am an and any are aren't as at be because been before being " +
    "below between both but by can cannot could couldn't did didn't do does doesn't doing don't down " +
    "during each few for from further had hadn't has hasn't have haven't having he her here hers herself " +
    "him himself his how i if in into is isn't it its itself just me more most my myself no nor not of off " +
    "on once only or other our ours ourselves out over own same she should shouldn't so some such than that " +
    "the their theirs them themselves then there these they this those through to too under until very " +
    "was wasn't we were weren't what when where which while who whom why will with would wouldn't you your " +
    "yours yourself yourselves also please hey hi ok okay thanks thank want needs need make made use using " +
    "used get got let's lets one two thing things something anything nothing really much lot still even " +
    "now new way know think see look going").split(/\s+/),
);

/** Whole-message rejects: openers that say nothing about the session's topic. */
const TRIVIAL_MESSAGE =
  /^(continue|go( ahead)?|ok( ay)?|yes|yeah|yep|no|nope|do it|same|try again|redo|hm+m?|k|sure|sounds good|lgtm|nice|great|perfect|cool|thanks?|thx|ty|hi|hello|hey|yo|sup|test(ing)?|ping)[\s.!?,]*$/i;

/** Personal pronouns (1st/2nd person + he/she/they; it/its kept -- usually
 *  refers to code, not a person, and dropping it mangles more than it helps). */
const PERSONAL_PRONOUN =
  /\b(i(?:'m|'ve|'ll|'d)?|me|my(?:self)?|mine|we(?:'re|'ve|'ll|'d)?|us|our(?:s|selves)?|you(?:'re|'ve|'ll|'d)?|your(?:s|self|selves)?|he|him|his|himself|she|her(?:self)?|hers|they|them|their(?:s|selves)?)\b\s*/gi;

/** Sentence-head throat-clearing (run on the pronoun-stripped text until it
 *  stops matching: openers stack -- "hey also could you like to..."). */
const THROAT_CLEAR = [
  /^(hey|hello|hi|yo|sup)[!,.\s-]+/i,
  /^(and|but|also|so|plus|then)[,\s]+/i,
  /^(am|are|can|could|should)\s+/i, // polite head modals ("could you...")
  /^((i|we|you)\s+)?(would\s+|'d\s+)?(really\s+|just\s+)?(like|love|want|need|hope|hate)(\s+you)?\s+to\s+/i,
];

function trimThroat(s: string): string {
  let prev: string;
  let out = s;
  do {
    prev = out;
    for (const re of THROAT_CLEAR) out = out.replace(re, "");
  } while (out !== prev);
  return out;
}

/** Strip code, URLs, markdown chrome, and discourse noise to plain prose.
 *  Hyphenated compounds are safe: every word strip requires trailing
 *  whitespace, which a hyphen never provides (state-of-the-art survives). */
function cleanTitleText(raw: string): string {
  let t = raw;
  t = t.replace(/```[\s\S]*?(```|$)/g, " ");            // fenced code blocks
  t = t.replace(/~~~[\s\S]*?(~~~|$)/g, " ");
  t = t.replace(/`[^`\n]*`/g, " ");                     // inline code
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");          // images
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");        // links -> label
  t = t.replace(/https?:\/\/\S+/gi, " ");               // bare urls
  t = t.replace(/<\/?[^>\n]{1,60}>/g, " ");             // html-ish tags
  t = t.replace(/^\s{0,3}(#{1,6}|[*+-]?>)\s+/gm, " ");  // md headers/list markers/quotes
  t = t.replace(/[*_]{1,3}([^*\n]+?)[*_]{1,3}/g, "$1"); // bold/italic
  t = t.replace(/\|/g, " ");                            // table pipes
  t = t.replace(/(^|\s)@\S+/g, "$1");                   // @file references
  t = t.replace(/\(\s*[-–—:,]*\s*\)/g, " ");            // parens emptied by stripping
  t = t.replace(/\[\s*[-–—:,]*\s*\]/g, " ");
  t = t.replace(/\(\s+(?=[-–—])/g, "");                 // dangling "( --"
  if ((t.match(/\(/g)?.length ?? 0) !== (t.match(/\)/g)?.length ?? 0)) t = t.replace(/[()]/g, " ");
  t = t.replace(/\bplease\b\s+/gi, "");                 // politeness (all positions)
  t = t.replace(PERSONAL_PRONOUN, "");
  t = t.replace(/\b(is|a|an)\b\s+/gi, "");              // copula + indefinite articles ("the" stays)
  t = t.replace(/\bhere\b\s+/gi, "");                   // deictic
  t = t.replace(/\bthere(?:'s| is| are)?\b\s*/gi, "");  // existential leftovers ("is there a" -> "")
  t = t.replace(/^(in|for)\s+\w+\s+--\s+/i, "");        // "In hotdog --" project preambles
  t = trimThroat(t);
  t = t.replace(/\s{2,}/g, " ").trim();
  if (t) t = t[0]!.toUpperCase() + t.slice(1);
  return t.replace(/\s+/g, " ").trim();
}

const titleWords = (t: string): string[] => t.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) ?? [];
const titleContentWordCount = (t: string): number =>
  titleWords(t).filter((w) => !TITLE_STOPWORDS.has(w.toLowerCase())).length;

/** Highest-scoring sentence: non-stopword count with positional decay. */
function bestTitleSentence(text: string): string {
  const sentences = text
    .split(/(?<=[.!?…])\s+(?=[A-Z0-9"'“(*\[]|[A-Za-z]{2,})/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map(trimThroat)
    .filter(Boolean);
  if (sentences.length <= 1) return text;
  let best = "";
  let bestScore = -1;
  sentences.forEach((s, i) => {
    const score = titleContentWordCount(s) / (1 + SENTENCE_DECAY * i);
    if (score > bestScore) {
      bestScore = score;
      best = s;
    }
  });
  return best;
}

/** Workflow dispatch headers carry the only identifying token in the whole
 *  message -- the workflow name. Reformat rather than let the picker lose it. */
function workflowTitleTile(raw: string): string | null {
  const m = raw.match(/^Workflow '([^']+)' run [^:]+: (JUDGE )?node '([^']+)'/);
  return m ? `${m[1]} · ${m[3]}${m[2] ? " (judge)" : ""}` : null;
}

/** Final edge trim: leading junk up to the first letter/digit, trailing
 *  punctuation (a terminal ? or ! is kept -- question titles read better),
 *  then re-capitalize whatever survived at the head. */
function trimTitleEdges(s: string): string {
  const ell = s.endsWith("…") ? "…" : "";
  let t = s.slice(0, s.length - ell.length);
  t = t.replace(/^[^\p{L}\p{N}]+/u, "").replace(/[^0-9\p{L}?!]+$/u, "");
  t = (t + ell).trim();
  return t ? t.replace(/^./, (c) => c.toUpperCase()) : "";
}

/** Turn one candidate message into a title; null if it is untitled-worthy. */
function titleFromMessage(raw: string): string | null {
  if (TRIVIAL_MESSAGE.test(raw.trim())) return null;
  const tile = workflowTitleTile(raw);
  if (tile) return tile;
  const text = cleanTitleText(raw);
  if (!text || titleContentWordCount(text) < 2) return null; // too thin to say anything
  let out = text;
  if (titleWords(out).length > TITLE_WORD_CAP) out = bestTitleSentence(out);
  if (titleWords(out).length > TITLE_WORD_CAP) {
    // Cut at the budget word's end offset, so punctuation/spaces survive.
    let count = 0;
    let cut = out.length;
    for (const m of out.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)) {
      if (++count === TITLE_WORD_CAP) {
        cut = (m.index as number) + m[0].length;
        break;
      }
    }
    out = out.slice(0, cut).replace(/[,;:—-]+\s*$/, "") + "…";
  }
  return trimTitleEdges(out) || null;
}

/** The pure title core: first of the candidate user messages that yields a
 *  title wins. Deterministic -- same inputs, same bytes, every rebuild. */
export function deriveTitleFromMessages(messages: string[]): string | null {
  for (const m of messages) {
    const t = titleFromMessage(m);
    if (t) return t;
  }
  return null;
}

/** User-visible text of a log entry: plain string or a parts array. Both
 *  "text" and "untrusted" parts count (the webui wraps user input in
 *  "untrusted"; matching only "text" silently titled nothing for those). */
function userEntryText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const part = content.find(
      (p) =>
        p &&
        typeof p === "object" &&
        ((p as Record<string, unknown>).type === "text" ||
          (p as Record<string, unknown>).type === "untrusted"),
    ) as { text?: unknown } | undefined;
    return typeof part?.text === "string" ? part.text : "";
  }
  return "";
}

/** Title the session from its first user messages, oldest-first scan. */
function deriveTitle(entries: Array<{ source: string; content: unknown }>): string | null {
  const texts: string[] = [];
  for (const e of entries) {
    if (e.source !== LOG_SOURCE.INPUT && e.source !== LOG_SOURCE.PROMPT) continue;
    const t = userEntryText(e.content).trim();
    if (t) texts.push(t);
    if (texts.length >= TITLE_SCAN_MESSAGES) break;
  }
  return deriveTitleFromMessages(texts);
}

/**
 * Model/profile fidelity for rebuilds: the session's model/profile columns
 * are re-derived from the log's own header/switch records, so a rebuilt
 * index restores what the session ran on instead of silently defaulting.
 * Attested records: session_start (initial model + profile), model_change
 * (runtime model switch), profile_switch (runtime profile switch; last
 * wins, matching replay's profile rule). Null means the log attests nothing
 * -- the column stays absent and resume must warn, not default quietly.
 */
export function deriveModelProfileFromLog(
  entries: LogEntry[],
): { model: string | null; profile: string | null } {
  let model: string | null = null;
  let profile: string | null = null;
  for (const e of entries) {
    const m = e.model;
    const p = e.profile;
    if (e.source === LOG_SOURCE.SESSION_START) {
      if (typeof m === "string" && m) model = m;
      if (typeof p === "string" && p) profile = p;
    } else if (e.source === LOG_SOURCE.MODEL_CHANGE) {
      if (typeof m === "string" && m) model = m;
    } else if (e.source === LOG_SOURCE.PROFILE_SWITCH) {
      if (typeof p === "string" && p) profile = p;
    }
  }
  return { model, profile };
}

/**
 * Ctx display for rebuilds: the LAST token_usage record's per-call
 * totalTokens (the number the chat's token bubble shows) and its
 * contextWindow. Absent window/0 means the log attests nothing usable;
 * resume display omits the segment rather than inventing a denominator.
 */
export function deriveCtxFromLog(
  entries: LogEntry[],
): { ctxUsed: number | null; ctxTotal: number | null } {
  let ctxUsed: number | null = null;
  let ctxTotal: number | null = null;
  for (const e of entries) {
    if (e.source !== LOG_SOURCE.TOKEN_USAGE) continue;
    const used = (e as Record<string, unknown>).totalTokens;
    const window = (e as Record<string, unknown>).contextWindow;
    ctxUsed = typeof used === "number" && Number.isFinite(used) && used > 0 ? used : null;
    ctxTotal = typeof window === "number" && Number.isFinite(window) && window > 0 ? window : null;
  }
  return { ctxUsed, ctxTotal };
}

/**
 * The full searchable text of a session for the search mirror: every
 * user/assistant entry's searchable text (see searchableEntryText in
 * session-log.ts) joined, in log order. Derived from the FULL log so a search
 * still finds text that sits above a mid-session RESET (audit view). Returns
 * "" for a log with no user/assistant text. Kept here so the mirror and the
 * future live-append path share one corpus.
 */
export function deriveSearchText(entries: LogEntry[]): string {
  const parts: string[] = [];
  for (const e of entries) {
    const t = searchableEntryText(e);
    if (t) parts.push(t);
  }
  return parts.join("\n");
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
  // One full-log read serves both views: the epoch (the context's open
  // calls) is sliced from it, and the lifetime facts (the cap's counter,
  // the resume count) are audit trails a mid-turn RESET must not truncate.
  const full = await readSessionEntries(sessionId, { full: true });
  const entries = epochEntries(full);
  const facts = collectDurabilityFacts(entries);
  const lifetime = collectDurabilityFacts(full);
  const state = deriveSessionState({
    ...facts,
    consecutiveAutoResumes: lifetime.consecutiveAutoResumes,
  });
  const title = deriveTitle(entries);
  // Model/profile fidelity invariant: a rebuild restores the model/profile
  // the log itself attests (session_start / model_change / profile_switch).
  // A rebuilt index must never resume a session on the boot-default model
  // when the log says otherwise. The log cannot re-attest a live mirror, so
  // on conflict the row's existing value wins (COALESCE(sessions.x, ...)):
  // the mirror came from the writer's live agent and may be newer than the
  // log's attestation (legacy logs predate model_change records); the
  // derived value only ever fills an absent column.
  const derived = deriveModelProfileFromLog(full);
  // Ctx is display data whose system of record is the log itself (the last
  // token_usage record), and this read sees every record the row's mirror
  // ever mirrored -- so the derived value wins outright; a rewind truncation
  // must be able to clear a stale one.
  const ctx = deriveCtxFromLog(full);
  // Search text: same outright-win rule as ctx -- it is fully re-derived from
  // the log each sync, so a rewind that truncates the epoch view also clears
  // the undone text from the mirror (a stale hit for deleted history would be
  // worse than a re-read).
  const searchText = deriveSearchText(full);

  withIndex((d) => {
    const write = d.transaction(() => {
      d.run(
        `INSERT INTO sessions (session_id, path, updated_at, state, last_seq, size, mtime, resume_count, title, profile, model, ctx_used, ctx_total, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         path = excluded.path,
         updated_at = excluded.updated_at,
         state = excluded.state,
         last_seq = excluded.last_seq,
         size = excluded.size,
         mtime = excluded.mtime,
         resume_count = excluded.resume_count,
         title = COALESCE(excluded.title, sessions.title),
         profile = COALESCE(sessions.profile, excluded.profile),
         model = COALESCE(sessions.model, excluded.model),
         ctx_used = excluded.ctx_used,
         ctx_total = excluded.ctx_total,
         search_text = excluded.search_text`,
        [
          sessionId,
          path,
          st.mtimeMs,
          state,
          entries.length,
          st.size,
          st.mtimeMs,
          lifetime.resumeAttempts,
          title,
          derived.profile,
          derived.model,
          ctx.ctxUsed,
          ctx.ctxTotal,
          searchText,
        ],
      );
      d.run("DELETE FROM open_calls WHERE session_id = ?", [sessionId]);
      const ins = d.query(
        "INSERT INTO open_calls (session_id, tool_call_id, kind) VALUES (?, ?, ?) ON CONFLICT(session_id, tool_call_id) DO NOTHING",
      );
      for (const id of facts.started) {
        if (!facts.answered.has(id)) ins.run(sessionId, id, OPEN_CALL_KIND.STARTED);
      }
      for (const q of facts.asked) {
        if (!facts.answered.has(q.toolCallId)) ins.run(sessionId, q.toolCallId, OPEN_CALL_KIND.QUESTION);
      }
    });
    write();
  });
  return getSessionRow(sessionId);
}

export function getSessionRow(sessionId: string): SessionRow | null {
  return withIndex((d) =>
    d.query<SessionRow, [string]>("SELECT * FROM sessions WHERE session_id = ?").get(sessionId),
  );
}

/** One search match: the fresh searchable text of a session plus the columns
 *  the sidebar row grammar needs. Snippet/match-count formatting is a display
 *  concern and stays with the caller. */
export interface SessionSearchMatch {
  sessionId: string;
  profile: string | null;
  model: string | null;
  /** Last activity (epoch ms) -- the row's mtime-based updated_at. */
  lastActivityAt: number;
  /** The mirrored user+assistant text (the corpus `needle` was found in). */
  text: string;
}

/**
 * Full-text search over every session log (live + cold), newest-activity
 * first, using the disposable index as a text mirror:
 *
 *  - Enumeration is readdir + stat only (never a per-file read like
 *    listSessionLogs), so a session that has only exchanged user/assistant
 *    turns -- and so has no commit-point mirror row yet -- is still found.
 *  - A row's `search_text` is trusted only when its size/mtime match the
 *    file (the same staleness marker the whole index uses). On any
 *    disagreement the log is re-read via syncSessionFromLog, which refreshes
 *    both the row position and the mirror -- so the result is always the real
 *    log content, and cold/unchanged logs never re-parse their JSONL.
 *
 * Matching is exact substring (`includes`) on the lowercased corpus, NOT
 * SQL LIKE: a needle containing `%` or `_` stays literal. Empty query matches
 * nothing. Case-insensitive throughout.
 */
export async function searchSessionCorpora(query: string): Promise<SessionSearchMatch[]> {
  const needle = query.toLowerCase();
  if (needle === "") return [];

  const dir = sessionsDir();
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return []; // no sessions dir yet
  }

  const matches: SessionSearchMatch[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const sessionId = file.slice(0, -".jsonl".length);
    let path: string;
    try {
      path = sessionPath(sessionId); // validates the id; malformed names skipped
    } catch {
      continue;
    }
    let st;
    try {
      st = statSync(path);
    } catch {
      continue; // vanished mid-scan
    }

    // Ensure a fresh mirror row: use the cache only when the position matches
    // the file AND the text was actually mirrored; otherwise re-derive.
    let row = getSessionRow(sessionId);
    const cacheFresh =
      row != null && row.size === st.size && row.mtime === st.mtimeMs && typeof row.search_text === "string";
    if (!cacheFresh) {
      try {
        row = await syncSessionFromLog(sessionId);
      } catch {
        continue; // unreadable log: nothing honest to search
      }
    }
    if (!row) continue;
    const text = row.search_text ?? "";
    if (text === "" || !text.toLowerCase().includes(needle)) continue;
    matches.push({
      sessionId,
      profile: row.profile,
      model: row.model,
      lastActivityAt: row.updated_at,
      text,
    });
  }

  matches.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return matches;
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

    // getSessionRow (not a hoisted statement) so every read is corruption-
    // self-healing: recovery closes the handle, and a cached statement from
    // the dead connection would throw on its next use.
    const row = getSessionRow(sessionId);
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

  withIndex((d) => {
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
  });

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
  const rowPresent = withIndex((d) => {
    const existing = d
      .query("SELECT 1 AS x FROM sessions WHERE session_id = ?")
      .get(sessionId);
    if (!existing) return false;
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
    return true;
  });
  if (rowPresent) return;
  // Row-missing path: the sync re-derives the honest position from the log.
  await syncSessionFromLog(sessionId);
  if (mutate && idempotentOnMissing) {
    withIndex((d) => {
      const fix = d.transaction(() => mutate(d));
      fix();
    });
  }
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

/** Mirror the session's active model in the index so cold-log resume picks it up. */
export async function indexSessionModel(
  sessionId: string,
  model: string,
): Promise<void> {
  await atCommitPoint(sessionId, 0, (d) => {
    d.run(
      `UPDATE sessions SET model = ? WHERE session_id = ?`,
      [model, sessionId],
    );
  }, true);
}

/** Mirror the session's active profile in the index so cold-log resume picks it up. */
export async function indexSessionProfile(
  sessionId: string,
  profile: string,
): Promise<void> {
  await atCommitPoint(sessionId, 0, (d) => {
    d.run(
      `UPDATE sessions SET profile = ? WHERE session_id = ?`,
      [profile, sessionId],
    );
  }, true);
}

/**
 * User input committed (the registry's CONTEXT_MESSAGE mirror): seed the
 * row's derived title so a live session shows its headline from the first
 * title-worthy message, no rebuild wait. Set-once (`title IS NULL` guard):
 * the first title-worthy message wins forever, matching the rebuild's
 * oldest-first scan, so cold-resume replays and later messages are honest
 * no-ops that never clobber. Deliberately NOT an atCommitPoint writer: the
 * record itself is counted by the session-log chokepoint, and a title is
 * display data, not a durability fact. Missing row: the UPDATE matches
 * nothing and the honest answer is false -- row creation is the first
 * durability commit point's job, and its sync derives the title anyway.
 */
export function indexUserInput(sessionId: string, content: unknown): boolean {
  const text = userEntryText(content).trim();
  if (!text) return false;
  const title = deriveTitleFromMessages([text]);
  if (!title) return false;
  return withIndex((d) => {
    const res = d.run(
      `UPDATE sessions SET title = ? WHERE session_id = ? AND title IS NULL`,
      [title, sessionId],
    );
    return res.changes > 0;
  });
}

/**
 * Mirror the latest token_usage snapshot (per-call totalTokens + window) so
 * the sidebar's cold rows carry ctx without a log scan. Same shape as the
 * model/profile mirrors: the value is absolute (idempotentOnMissing), and
 * syncSessionFromLog re-derives it from the log on rebuild.
 */
export async function indexTokenUsage(
  sessionId: string,
  ctxUsed: number | null,
  ctxTotal: number | null,
): Promise<void> {
  await atCommitPoint(sessionId, 0, (d) => {
    d.run(
      `UPDATE sessions SET ctx_used = ?, ctx_total = ? WHERE session_id = ?`,
      [ctxUsed, ctxTotal, sessionId],
    );
  }, true);
}

/**
 * resume_attempt fsynced: mirror the count. When the consecutive auto-resume
 * cap was just reached, the row goes parked at this exact commit point;
 * reconcile re-derives the same state if the index is lost.
 *
 * A manually resumed parked session keeps showing parked until a later
 * commit point (or boot reconcile) re-derives from the progressed log -- a
 * transient sidebar badge, not a gate: refusal always re-reads the log.
 */
export async function indexResumeAttempt(sessionId: string, reachedCap = false): Promise<void> {
  await atCommitPoint(sessionId, 1, (d) => {
    d.run("UPDATE sessions SET resume_count = resume_count + 1 WHERE session_id = ?", [
      sessionId,
    ]);
    if (reachedCap) {
      d.run("UPDATE sessions SET state = ? WHERE session_id = ?", [
        SESSION_STATE.PARKED,
        sessionId,
      ]);
    }
  });
}
