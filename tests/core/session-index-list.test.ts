// The sidebar list served from the session index (listSessionLogs): parity
// with the raw file scan (scanSessionLogFile), zero log-body reads once rows
// are fresh, the un-indexed fallback policy (never drop a log), and the
// backfill of the list columns on an old-version DB.

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  closeSessionIndex,
  listSessionLogsFromIndex,
  reconcileSessionIndex,
  sessionIndexPath,
  getSessionRow,
  SESSION_STATE,
  type SessionFileFallback,
} from "@core/session/session-index.ts";
import {
  listSessionLogs,
  scanSessionLogFile,
  LOG_SOURCE,
  type LogEntry,
  type SessionLogInfo,
} from "@core/session/session-log.ts";
import { TMP_PARENT } from "../mocks/io.ts";

// Fresh sessions dir (and db) per test, per the session-index.test.ts idiom.
let SESSIONS_DIR = "";
const allDirs: string[] = [];

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  closeSessionIndex();
  for (const dir of allDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

beforeEach(() => {
  closeSessionIndex();
  SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-index-list-"));
  allDirs.push(SESSIONS_DIR);
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

const iso = (ms: number) => new Date(ms).toISOString();

function line(over: Partial<LogEntry>): string {
  const entry: LogEntry = {
    ts: iso(1700000000000), // fixed ts: deterministic rows
    session_id: "s",
    source: LOG_SOURCE.INPUT,
    content: "hello",
    ...over,
  };
  return JSON.stringify(entry) + "\n";
}

function fixtureLog(sessionId: string, lines: string[]): string {
  writeFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), lines.join(""));
  return sessionId;
}

/** Reference derivation, end to end: scan every .jsonl raw. */
async function reference(): Promise<SessionLogInfo[]> {
  const files = readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl"));
  const rows: SessionLogInfo[] = [];
  for (const file of files) {
    const info = await scanSessionLogFile(SESSIONS_DIR, file);
    if (info) rows.push(info);
  }
  rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt);
  return rows;
}

/** A fallback that fails the test if the list ever touches a log body. */
const noLogReads: SessionFileFallback = async (_dir, file) => {
  throw new Error(`listSessionLogs read a log body: ${file}`);
};

/** The synthetic store: conversations, a mid-log RESET whose own ts is the
 *  earliest entry (the ts scan covers ALL entries, RESET included), an
 *  all-system_prompt log (count filter), a junk-only file, a ts-less log
 *  (mtime fallback), and an unsafe-id file the index can never hold. */
function seedStore(withDotted: boolean): void {
  fixtureLog("list-conv", [
    line({ source: LOG_SOURCE.SESSION_START, content: "", model: "m", profile: "p" }),
    line({ source: LOG_SOURCE.INPUT, content: "one", ts: iso(1700000100000) }),
    line({ source: LOG_SOURCE.LLM, content: "reply", ts: iso(1700000200000) }),
    line({ source: LOG_SOURCE.TOOL_STARTED, content: "run", tool_call_id: "t1", ts: iso(1700000300000) }),
    line({ source: LOG_SOURCE.INPUT, content: "two", ts: iso(1700000400000) }),
  ]);
  fixtureLog("list-reset", [
    line({ source: LOG_SOURCE.INPUT, content: "kept", ts: iso(1700000500000) }),
    line({ source: LOG_SOURCE.RESET, content: "", ts: iso(1699000000000) }),
    line({ source: LOG_SOURCE.LLM, content: "post", ts: iso(1700000600000) }),
  ]);
  fixtureLog("list-sys", [
    line({ source: LOG_SOURCE.SYSTEM_PROMPT, content: "prompt" }),
    line({ source: LOG_SOURCE.RESET, content: "", ts: iso(1700000005000) }),
  ]);
  fixtureLog("list-junk", ["null\n", "42\n"]);
  writeFileSync(
    join(SESSIONS_DIR, "list-nots.jsonl"),
    JSON.stringify({ session_id: "list-nots", source: LOG_SOURCE.INPUT, content: "timeless" }) + "\n",
  );
  if (withDotted) fixtureLog(".dotted", [line({ content: "hidden gem" })]);
}

describe("index-served list == the old file scan (parity)", () => {
  it("identical lists cold (fallback), warm (index), with semantics pinned", async () => {
    seedStore(true);
    const ref = await reference();

    // Cold store, no rows: every file rides the fallback, values identical.
    expect(await listSessionLogs()).toEqual(ref);

    await reconcileSessionIndex();
    expect(await listSessionLogs()).toEqual(ref);

    // Byte-level semantics of the derivation itself:
    const list = await listSessionLogs();
    const conv = list.find((l) => l.id === "list-conv")!;
    expect(conv.messageCount).toBe(3); // input x2 + llm; tool traffic never counts
    expect(conv.createdAt).toBe(1700000000000); // session_start ts is the min
    expect(conv.lastActivityAt).toBe(1700000400000);
    const reset = list.find((l) => l.id === "list-reset")!;
    expect(reset.createdAt).toBe(1699000000000); // RESET's own ts is earliest: min covers ALL entries
    expect(reset.lastActivityAt).toBe(1700000600000);
    expect(reset.messageCount).toBe(2); // entries above the RESET still count
    expect(list.find((l) => l.id === "list-sys")).toBeUndefined(); // count filter
    expect(list.find((l) => l.id === "list-junk")).toBeUndefined();
    const nots = list.find((l) => l.id === "list-nots")!;
    const notsMtime = Math.floor(statSync(join(SESSIONS_DIR, "list-nots.jsonl")).mtimeMs);
    expect(nots.createdAt).toBe(notsMtime); // no valid ts: mtime fallback
    expect(nots.lastActivityAt).toBe(notsMtime);
    expect(list.find((l) => l.id === ".dotted")?.messageCount).toBe(1);
  });

  it("a fully indexed store answers the list with zero log-body reads", async () => {
    seedStore(false);
    await reconcileSessionIndex();
    const ref = await reference();
    expect(await listSessionLogsFromIndex(noLogReads)).toEqual(ref);
  });
});

describe("fallback policy", () => {
  it("a stale row is re-derived from the log, never served stale", async () => {
    seedStore(false);
    await reconcileSessionIndex();
    appendFileSync(join(SESSIONS_DIR, "list-conv.jsonl"), line({ source: LOG_SOURCE.LLM, content: "tail", ts: iso(1700000700000) }));

    // The stale file must go through a read: a fallback that throws proves
    // the list did not trust the (now stale) row.
    await expect(listSessionLogsFromIndex(noLogReads)).rejects.toThrow("read a log body: list-conv.jsonl");

    // The production fallback answers from the file, so the list is never
    // stale -- and it stays read-only: the row itself waits for reconcile.
    const ref = await reference();
    expect(await listSessionLogs()).toEqual(ref);
    expect(getSessionRow("list-conv")?.message_count).toBe(3);
    await reconcileSessionIndex();
    expect(getSessionRow("list-conv")?.message_count).toBe(4);
    expect(await listSessionLogsFromIndex(noLogReads)).toEqual(ref);
  });

  it("delete-the-index: the list never drops a log; reconcile rebuilds the rows", async () => {
    seedStore(false);
    await reconcileSessionIndex();
    const ref = await reference();

    closeSessionIndex();
    rmSync(sessionIndexPath(), { force: true });
    rmSync(`${sessionIndexPath()}-wal`, { force: true });
    rmSync(`${sessionIndexPath()}-shm`, { force: true });

    // No rows: every file rides the raw scan, the list stays whole, and the
    // list writes no rows itself.
    expect(await listSessionLogs()).toEqual(ref);
    expect(getSessionRow("list-conv")).toBeNull();
    await reconcileSessionIndex();
    expect(await listSessionLogsFromIndex(noLogReads)).toEqual(ref);
  });

  it("a missing sessions dir lists empty; an unusable one throws (as before)", async () => {
    process.env.HOTDOG_SESSIONS_DIR = join(SESSIONS_DIR, "gone");
    expect(await listSessionLogs()).toEqual([]);
    const fileAsDir = join(SESSIONS_DIR, "not-a-dir");
    writeFileSync(fileAsDir, "x\n");
    process.env.HOTDOG_SESSIONS_DIR = fileAsDir;
    await expect(listSessionLogs()).rejects.toThrow();
  });

  it("an index-incapable id rides the raw scan while indexed ids cost nothing", async () => {
    seedStore(true);
    await reconcileSessionIndex();

    const scanned: string[] = [];
    const spy: SessionFileFallback = async (dir, file) => {
      scanned.push(file);
      return scanSessionLogFile(dir, file);
    };
    const list = await listSessionLogsFromIndex(spy);
    expect(list.find((l) => l.id === ".dotted")?.messageCount).toBe(1);
    expect(scanned).toEqual([".dotted.jsonl"]); // only the never-indexed file
    expect(list).toEqual(await reference());
  });
});

describe("list-column migration", () => {
  it("an old-version DB gains the columns and backfills position-fresh rows once", async () => {
    const sid = "legacy-list";
    const path = join(SESSIONS_DIR, `${sid}.jsonl`);
    writeFileSync(
      path,
      [line({ source: LOG_SOURCE.INPUT, content: "a", ts: iso(1700001000000) }),
       line({ source: LOG_SOURCE.LLM, content: "b", ts: iso(1700001100000) })].join(""),
    );
    const st = statSync(path);

    closeSessionIndex();
    rmSync(sessionIndexPath(), { force: true });
    rmSync(`${sessionIndexPath()}-wal`, { force: true });
    rmSync(`${sessionIndexPath()}-shm`, { force: true });

    // A row written by a pre-list-columns index, already position-fresh:
    // only the NULL columns mark it for the one-time backfill.
    const legacy = new Database(sessionIndexPath());
    try {
      legacy.exec(`CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY, path TEXT NOT NULL, updated_at INTEGER NOT NULL,
        state TEXT NOT NULL, last_seq INTEGER NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
        resume_count INTEGER NOT NULL DEFAULT 0, title TEXT, profile TEXT, model TEXT)`);
      legacy.run(
        "INSERT INTO sessions (session_id, path, updated_at, state, last_seq, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [sid, path, 1, SESSION_STATE.IDLE, 2, st.size, st.mtimeMs],
      );
    } finally {
      legacy.close();
    }

    // Open migrates the schema; the row is present but un-backfilled.
    const before = getSessionRow(sid);
    expect(before).not.toBeNull();
    expect(before?.created_at).toBeNull();
    expect(before?.message_count).toBeNull();

    const stats = await reconcileSessionIndex();
    expect(stats.reindexed).toBe(1); // fresh by position, stale by columns
    expect(stats.logReads).toBe(1);

    const row = getSessionRow(sid)!;
    expect(row.message_count).toBe(2);
    expect(row.created_at).toBe(1700001000000);
    expect(row.last_activity_at).toBe(1700001100000);

    // The backfill is one-time: the next boot is stat-only again.
    const second = await reconcileSessionIndex();
    expect(second.logReads).toBe(0);

    // And the list serves the row without any file read.
    expect(await listSessionLogsFromIndex(noLogReads)).toEqual([
      { id: sid, createdAt: 1700001000000, lastActivityAt: 1700001100000, messageCount: 2 },
    ]);
  });
});
