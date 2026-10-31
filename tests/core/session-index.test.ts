// Session index (durability part 2) tests.
//
// The index is a disposable mirror: everything here pins the derivability
// rule -- delete the db, rebuild from logs, identical state; the boot scan
// is stat-only when rows are fresh; states come from log facts, never from
// writer declarations; and the resume counter survives index deletion because
// its source of record is the resume_attempt record in the log.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

import {
  reconcileSessionIndex,
  openSessionIndex,
  closeSessionIndex,
  sessionIndexPath,
  syncSessionFromLog,
  getSessionRow,
  deriveSessionState,
  deriveCtxFromLog,
  indexTokenUsage,
  indexToolStarted,
  indexQuestionAsked,
  indexToolResult,
  indexResumeAttempt,
  SESSION_STATE,
} from "@core/session/session-index.ts";
import {
  replayEntriesIntoContext,
  LOG_SOURCE,
  type LogEntry,
} from "@core/session/session-log.ts";
import type { Message } from "@core/context/message.ts";

const SESSIONS_DIR = mkdtempSync(join(os.tmpdir(), "hotdog-session-index-"));

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  closeSessionIndex();
  try { rmSync(SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function line(over: Partial<LogEntry>): string {
  const entry: LogEntry = {
    ts: new Date(1700000000000).toISOString(), // fixed ts: deterministic rows
    session_id: "s",
    source: LOG_SOURCE.INPUT,
    content: "hello",
    ...over,
  };
  return JSON.stringify(entry) + "\n";
}

/** Write a raw fixture log. Returns the session id. */
function fixtureLog(sessionId: string, lines: string[]): string {
  writeFileSync(join(SESSIONS_DIR, `${sessionId}.jsonl`), lines.join(""));
  return sessionId;
}

function dropLog(sessionId: string): void {
  try { rmSync(join(SESSIONS_DIR, `${sessionId}.jsonl`)); } catch {}
}

function dumpIndex(): string {
  const d = openSessionIndex();
  const sessions = d
    .query("SELECT * FROM sessions ORDER BY session_id")
    .all();
  const calls = d
    .query("SELECT * FROM open_calls ORDER BY session_id, tool_call_id")
    .all();
  return JSON.stringify({ sessions, calls });
}

beforeEach(() => {
  // Fresh index per test; logs are per-test ids so the sessions dir may
  // still hold other tests' files -- reconcile scopes its writes per file.
  closeSessionIndex();
  rmSync(sessionIndexPath(), { force: true });
  rmSync(`${sessionIndexPath()}-wal`, { force: true });
  rmSync(`${sessionIndexPath()}-shm`, { force: true });
});

describe("reconcile", () => {
  it("adopts logs and derives state from durability facts", async () => {
    const idle = fixtureLog(uniqueId("idle"), [line({ content: "hi" })]);
    const asked = fixtureLog(uniqueId("asked"), [
      line({ source: LOG_SOURCE.LLM, content: "", tool_calls: [{ id: "q1", name: "question", input: "{}" }] as never }),
      line({ source: LOG_SOURCE.QUESTION_ASKED, content: [{ prompt: "which?" }], tool_call_id: "q1" }),
    ]);
    const interrupted = fixtureLog(uniqueId("busted"), [
      line({ source: LOG_SOURCE.LLM, content: "", tool_calls: [{ id: "t1", name: "bash", input: "{}" }] as never }),
      line({ source: LOG_SOURCE.TOOL_STARTED, content: "echo x", tool_call_id: "t1" }),
    ]);
    const answered = fixtureLog(uniqueId("answered"), [
      line({ source: LOG_SOURCE.LLM, content: "", tool_calls: [{ id: "t2", name: "bash", input: "{}" }] as never }),
      line({ source: LOG_SOURCE.TOOL_STARTED, content: "echo x", tool_call_id: "t2" }),
      line({ source: LOG_SOURCE.TOOL_RESULT, content: "x", tool_call_id: "t2" }),
    ]);
    const resumed = fixtureLog(uniqueId("resumed"), [
      line({}),
      line({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" }),
      line({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" }),
    ]);

    const stats = await reconcileSessionIndex();
    expect(stats.adopted).toBeGreaterThanOrEqual(5);
    expect(stats.logReads).toBeGreaterThanOrEqual(5);

    expect(getSessionRow(idle)?.state).toBe(SESSION_STATE.IDLE);
    expect(getSessionRow(idle)?.title).toBe("hi");
    expect(getSessionRow(asked)?.state).toBe(SESSION_STATE.AWAITING_QUESTION);
    expect(getSessionRow(interrupted)?.state).toBe(SESSION_STATE.INTERRUPTED);
    expect(getSessionRow(answered)?.state).toBe(SESSION_STATE.IDLE);
    expect(getSessionRow(resumed)?.resume_count).toBe(2);
    expect(getSessionRow(answered)?.last_seq).toBe(3);
  });

  it("mirrors open calls only for unanswered durability records", async () => {
    const sid = fixtureLog(uniqueId("opencalls"), [
      line({ source: LOG_SOURCE.QUESTION_ASKED, content: [{ prompt: "a?" }], tool_call_id: "q1" }),
      line({ source: LOG_SOURCE.QUESTION_ASKED, content: [{ prompt: "b?" }], tool_call_id: "q2" }),
      line({ source: LOG_SOURCE.TOOL_RESULT, content: "ans", tool_call_id: "q1" }),
    ]);
    await syncSessionFromLog(sid);
    const calls = openSessionIndex()
      .query<{ tool_call_id: string; kind: string }, [string]>(
        "SELECT tool_call_id, kind FROM open_calls WHERE session_id = ? ORDER BY tool_call_id",
      )
      .all(sid);
    expect(calls).toEqual([{ tool_call_id: "q2", kind: "question" }]);
  });

  it("boot is stat-only when size+mtime match the row (no log reads)", async () => {
    fixtureLog(uniqueId("warm"), [line({})]);
    fixtureLog(uniqueId("warm2"), [line({ content: "two" })]);
    await reconcileSessionIndex();

    const second = await reconcileSessionIndex();
    expect(second.logReads).toBe(0);
    expect(second.unchanged).toBeGreaterThanOrEqual(2);

    // --reindex repair mode ignores freshness: everything is re-read.
    const full = await reconcileSessionIndex({ full: true });
    expect(full.logReads).toBe(second.unchanged);
    expect(full.unchanged).toBe(0);
  });

  it("re-reads only logs whose size or mtime disagree with the row", async () => {
    const a = fixtureLog(uniqueId("a"), [line({})]);
    const b = fixtureLog(uniqueId("b"), [line({ content: "b" })]);
    await reconcileSessionIndex();

    appendFileSync(join(SESSIONS_DIR, `${b}.jsonl`), line({ content: "more" }));
    const stats = await reconcileSessionIndex();
    expect(stats.logReads).toBe(1);
    expect(stats.reindexed).toBe(1);
    expect(getSessionRow(b)?.last_seq).toBe(2);
    expect(getSessionRow(a)?.last_seq).toBe(1);
  });

  it("quarantines rows whose log file is gone", async () => {
    const sid = fixtureLog(uniqueId("gone"), [line({})]);
    await reconcileSessionIndex();
    expect(getSessionRow(sid)).not.toBeNull();

    dropLog(sid);
    const stats = await reconcileSessionIndex();
    expect(stats.quarantined).toBe(1);
    expect(getSessionRow(sid)).toBeNull();
  });

  it("delete-the-index: reboot rebuilds identical state from the logs", async () => {
    fixtureLog(uniqueId("keep1"), [
      line({ content: "first prompt" }),
      line({ source: LOG_SOURCE.TOOL_STARTED, content: "run", tool_call_id: "t1" }),
      line({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" }),
    ]);
    fixtureLog(uniqueId("keep2"), [
      line({ content: "q prompt" }),
      line({ source: LOG_SOURCE.QUESTION_ASKED, content: [{ prompt: "?" }], tool_call_id: "q1" }),
    ]);
    fixtureLog(uniqueId("keep3"), [line({ content: "idle" })]);

    await reconcileSessionIndex();
    const before = dumpIndex();

    // The delete-the-index DoD: kill the db file, reopen, reconcile.
    closeSessionIndex();
    rmSync(sessionIndexPath(), { force: true });
    rmSync(`${sessionIndexPath()}-wal`, { force: true });
    rmSync(`${sessionIndexPath()}-shm`, { force: true });

    const stats = await reconcileSessionIndex();
    expect(stats.logReads).toBeGreaterThanOrEqual(3);
    expect(dumpIndex()).toBe(before); // includes resume_count: cap survived
  });
});

describe("writer commit-point hooks", () => {
  it("question asked -> awaiting_question; result -> idle; never declares interrupted", async () => {
    const sid = fixtureLog(uniqueId("writer"), [line({ content: "go" })]);
    const logPath = join(SESSIONS_DIR, `${sid}.jsonl`);

    await syncSessionFromLog(sid);
    expect(getSessionRow(sid)?.state).toBe(SESSION_STATE.IDLE);

    appendFileSync(logPath, line({ source: LOG_SOURCE.TOOL_STARTED, content: "run", tool_call_id: "t1" }));
    await indexToolStarted(sid, "t1", { profile: "default", model: "m1" });
    const afterStarted = getSessionRow(sid);
    // Honest row for a live mid-tool session: state untouched, position fresh.
    expect(afterStarted?.state).toBe(SESSION_STATE.IDLE);
    expect(afterStarted?.last_seq).toBe(2);
    expect(afterStarted?.model).toBe("m1");
    expect(afterStarted?.profile).toBe("default");

    appendFileSync(logPath, line({ source: LOG_SOURCE.QUESTION_ASKED, content: [{ prompt: "?" }], tool_call_id: "q1" }));
    await indexQuestionAsked(sid, "q1");
    expect(getSessionRow(sid)?.state).toBe(SESSION_STATE.AWAITING_QUESTION);

    appendFileSync(logPath, line({ source: LOG_SOURCE.TOOL_RESULT, content: "done", tool_call_id: "t1" }));
    await indexToolResult(sid, "t1");
    // Question still open: a plain tool result must not clear awaiting_question.
    expect(getSessionRow(sid)?.state).toBe(SESSION_STATE.AWAITING_QUESTION);

    appendFileSync(logPath, line({ source: LOG_SOURCE.TOOL_RESULT, content: "ans", tool_call_id: "q1" }));
    await indexToolResult(sid, "q1");
    expect(getSessionRow(sid)?.state).toBe(SESSION_STATE.IDLE);
    expect(getSessionRow(sid)?.last_seq).toBe(5);
  });

  it("index deleted mid-session: next commit point rebuilds from the log, no double-count", async () => {
    const sid = fixtureLog(uniqueId("miracle"), [line({ content: "one" })]);
    const logPath = join(SESSIONS_DIR, `${sid}.jsonl`);
    await reconcileSessionIndex();
    expect(getSessionRow(sid)?.last_seq).toBe(1);

    closeSessionIndex();
    rmSync(sessionIndexPath(), { force: true });
    rmSync(`${sessionIndexPath()}-wal`, { force: true });
    rmSync(`${sessionIndexPath()}-shm`, { force: true });

    // A resume record lands while the index is gone; the next commit point
    // must re-derive position from the log (which already has the record).
    appendFileSync(logPath, line({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" }));
    await indexResumeAttempt(sid);
    const row = getSessionRow(sid);
    expect(row).not.toBeNull();
    // The rebuild counted the record from the log (1); the mirror bump must
    // not also fire on the pre-existing count. resume_count is then re-read
    // from the log on the next reconcile and agrees.
    expect(row?.last_seq).toBe(2);
    await reconcileSessionIndex();
    expect(getSessionRow(sid)?.resume_count).toBe(1);
    expect(getSessionRow(sid)?.last_seq).toBe(2);
  });

  it("resume_attempt survives index deletion (log is the counter's source)", async () => {
    const sid = fixtureLog(uniqueId("cap"), [
      line({}),
      line({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" }),
      line({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" }),
      line({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" }),
    ]);
    await reconcileSessionIndex();
    expect(getSessionRow(sid)?.resume_count).toBe(3);

    closeSessionIndex();
    rmSync(sessionIndexPath(), { force: true });
    rmSync(`${sessionIndexPath()}-wal`, { force: true });
    rmSync(`${sessionIndexPath()}-shm`, { force: true });
    await reconcileSessionIndex();
    expect(getSessionRow(sid)?.resume_count).toBe(3);
  });
});

describe("deriveSessionState", () => {
  it("prioritizes awaiting_question over interrupted", () => {
    expect(
      deriveSessionState({
        started: new Set(["t1"]),
        answered: new Set<string>(),
        asked: [{ toolCallId: "q1" }],
      }),
    ).toBe(SESSION_STATE.AWAITING_QUESTION);
    expect(
      deriveSessionState({ started: new Set(["t1"]), answered: new Set<string>(), asked: [] }),
    ).toBe(SESSION_STATE.INTERRUPTED);
    expect(
      deriveSessionState({ started: new Set(["t1"]), answered: new Set(["t1"]), asked: [] }),
    ).toBe(SESSION_STATE.IDLE);
  });
});

describe("resume_attempt replay", () => {
  it("never replays as a conversation message", () => {
    const log: Message[] = [];
    const agent = { addMessage: (m: Message) => void log.push(m) };
    const entries = readSessionEntriesSync([
      line({ source: LOG_SOURCE.INPUT, content: "u" }),
      line({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" }),
      line({ source: LOG_SOURCE.LLM, content: "a" }),
      line({ source: LOG_SOURCE.RESUME_ATTEMPT, content: "" }),
    ]);
    const result = replayEntriesIntoContext(agent, entries);
    expect(result.replayed).toBe(2);
    expect(log.map((m) => m.content)).toEqual(["u", "a"]);
  });
});

function readSessionEntriesSync(lines: string[]): LogEntry[] {
  return lines.map((l) => JSON.parse(l) as LogEntry);
}

// ── ctx columns (sidebar row grammar) ───────────────────────────────────────

describe("ctx columns", () => {
  it("rebuild derives ctx_used/ctx_total from the LAST token_usage record", async () => {
    const sid = fixtureLog(uniqueId("ctx"), [
      line({ source: LOG_SOURCE.SESSION_START, content: "", model: "ai365/qwen3.8", profile: "manager" }),
      line({ source: LOG_SOURCE.INPUT, content: "hi" }),
      line({ source: LOG_SOURCE.TOKEN_USAGE, content: "", totalTokens: 900, contextWindow: 131072 }),
      line({ source: LOG_SOURCE.LLM, content: "yo" }),
      line({ source: LOG_SOURCE.TOKEN_USAGE, content: "", totalTokens: 69000, contextWindow: 262144 }),
    ]);
    const row = await syncSessionFromLog(sid);
    expect(row?.ctx_used).toBe(69000);
    expect(row?.ctx_total).toBe(262144);
    // The header records keep attesting model/profile through the same read.
    expect(row?.model).toBe("ai365/qwen3.8");
    expect(row?.profile).toBe("manager");
  });

  it("a legacy log attests no ctx: columns stay null (segments omitted)", async () => {
    const sid = fixtureLog(uniqueId("ctx-legacy"), [line({ content: "ancient" })]);
    const row = await syncSessionFromLog(sid);
    expect(row?.ctx_used).toBeNull();
    expect(row?.ctx_total).toBeNull();
  });

  it("a rebuild re-derives ctx outright: a truncating rewind clears stale values", async () => {
    const sid = fixtureLog(uniqueId("ctx-rewind"), [
      line({ content: "a" }),
      line({ source: LOG_SOURCE.TOKEN_USAGE, content: "", totalTokens: 5000, contextWindow: 65536 }),
    ]);
    await syncSessionFromLog(sid);
    expect(getSessionRow(sid)?.ctx_used).toBe(5000);

    // Rewind-style rewrite: the ctx record no longer exists in the log.
    fixtureLog(sid, [line({ content: "a" })]);
    await syncSessionFromLog(sid);
    expect(getSessionRow(sid)?.ctx_used).toBeNull();
    expect(getSessionRow(sid)?.ctx_total).toBeNull();
  });

  it("indexTokenUsage mirrors absolute values at the writer commit point", async () => {
    const sid = fixtureLog(uniqueId("ctx-mirror"), [line({ content: "hi" })]);
    await syncSessionFromLog(sid);
    await indexTokenUsage(sid, 424242, 1048576);
    expect(getSessionRow(sid)?.ctx_used).toBe(424242);
    expect(getSessionRow(sid)?.ctx_total).toBe(1048576);
    await indexTokenUsage(sid, 10, 20);
    expect(getSessionRow(sid)?.ctx_used).toBe(10);
    expect(getSessionRow(sid)?.ctx_total).toBe(20);
  });

  it("indexTokenUsage on a missing row self-heals via the log sync", async () => {
    const sid = fixtureLog(uniqueId("ctx-norow"), [
      line({ content: "hi" }),
      line({ source: LOG_SOURCE.TOKEN_USAGE, content: "", totalTokens: 777, contextWindow: 888 }),
    ]);
    await indexTokenUsage(sid, 777, 888);
    const row = getSessionRow(sid);
    expect(row?.ctx_used).toBe(777);
    expect(row?.ctx_total).toBe(888);
  });

  it("deriveCtxFromLog ignores non-usage sources and zero/absent windows", () => {
    const usage = (over: Partial<LogEntry>): LogEntry => ({
      ts: "2026-01-01T00:00:00.000Z",
      session_id: "s",
      source: LOG_SOURCE.TOKEN_USAGE,
      content: "",
      ...over,
    });
    expect(
      deriveCtxFromLog([usage({ totalTokens: 50, contextWindow: 1000 })]),
    ).toEqual({ ctxUsed: 50, ctxTotal: 1000 });
    expect(
      deriveCtxFromLog([usage({ totalTokens: 50, contextWindow: 0 })]),
    ).toEqual({ ctxUsed: 50, ctxTotal: null });
    expect(deriveCtxFromLog([{ ...usage({}), source: LOG_SOURCE.INPUT }])).toEqual({ ctxUsed: null, ctxTotal: null });
    expect(deriveCtxFromLog([])).toEqual({ ctxUsed: null, ctxTotal: null });
  });

  it("an index from the pre-ctx schema gains the columns on open (row preserved)", () => {
    closeSessionIndex();
    rmSync(sessionIndexPath(), { force: true });
    rmSync(`${sessionIndexPath()}-wal`, { force: true });
    rmSync(`${sessionIndexPath()}-shm`, { force: true });
    const legacy = new Database(sessionIndexPath());
    try {
      legacy.exec(`CREATE TABLE sessions (
        session_id TEXT PRIMARY KEY, path TEXT NOT NULL, updated_at INTEGER NOT NULL,
        state TEXT NOT NULL, last_seq INTEGER NOT NULL, size INTEGER NOT NULL, mtime REAL NOT NULL,
        resume_count INTEGER NOT NULL DEFAULT 0, title TEXT, profile TEXT, model TEXT)`);
      legacy.run(
        "INSERT INTO sessions (session_id, path, updated_at, state, last_seq, size, mtime) VALUES (?, ?, ?, ?, ?, ?, ?)",
        ["legacy-row", "/p", 1, SESSION_STATE.IDLE, 0, 1, 1.0],
      );
    } finally {
      legacy.close();
    }
    const row = getSessionRow("legacy-row"); // opens + migrates on first use
    expect(row).not.toBeNull();
    expect(row?.state).toBe(SESSION_STATE.IDLE);
    expect(row?.ctx_used).toBeNull();
    expect(row?.ctx_total).toBeNull();
  });
});
