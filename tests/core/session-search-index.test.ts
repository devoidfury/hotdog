// Index-backed full-text search: searchSessionCorpora reads the disposable
// session mirror's `search_text` column, re-deriving a log only when its
// size/mtime disagree with the row (the staleness marker). These cover the
// three properties that make the mirror honest:
//   1. corpus = user + assistant text only (tool/reasoning never match);
//   2. a log changed since the last mirror is re-read, so search never serves
//      stale text and never misses a just-appended message;
//   3. matching is exact substring, so `%`/`_` stay literal (no LIKE wildcards).

import { describe, it, expect, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import {
  reconcileSessionIndex,
  syncSessionFromLog,
  searchSessionCorpora,
  getSessionRow,
  closeSessionIndex,
} from "@core/session/session-index.ts";
import { LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";
import { TMP_PARENT } from "../mocks/io.ts";

let SESSIONS_DIR = "";
const allDirs: string[] = [];

function uniqueId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function line(over: Partial<LogEntry>): string {
  const entry: LogEntry = {
    ts: new Date(1700000000000).toISOString(),
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

beforeEach(() => {
  closeSessionIndex();
  SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-search-idx-"));
  allDirs.push(SESSIONS_DIR);
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  closeSessionIndex();
  for (const dir of allDirs) {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("searchSessionCorpora", () => {
  it("empty query matches nothing", async () => {
    fixtureLog(uniqueId("e"), [line({ content: "anything" })]);
    expect(await searchSessionCorpora("")).toEqual([]);
  });

  it("finds user + assistant text, case-insensitively, and not tool/reasoning", async () => {
    const id = fixtureLog(uniqueId("corpus"), [
      line({ source: LOG_SOURCE.INPUT, content: "quantum Zeta request" }),
      line({ source: LOG_SOURCE.LLM, content: "here is the QUANTUM answer" }),
      line({ source: LOG_SOURCE.TOOL_RESULT, content: "quantum in tool output" }),
      line({ source: LOG_SOURCE.LLM, content: "clean", reasoning_content: "quantum in reasoning" }),
    ]);
    await reconcileSessionIndex();

    const hits = await searchSessionCorpora("quantum");
    expect(hits.map((h) => h.sessionId)).toEqual([id]);
    // The corpus text carries the two conversation matches and none of the
    // tool/reasoning lines.
    const text = hits[0]!.text;
    expect(text).toContain("quantum Zeta request");
    expect(text).toContain("here is the QUANTUM answer");
    expect(text).not.toContain("tool output");
    expect(text).not.toContain("in reasoning");
  });

  it("a never-reconciled live session is found (no commit-point row required)", async () => {
    const id = fixtureLog(uniqueId("cold"), [line({ content: "needle here" })]);
    // No reconcile / sync at all -- the row does not exist yet.
    const hits = await searchSessionCorpora("needle");
    expect(hits.map((h) => h.sessionId)).toEqual([id]);
  });

  it("re-reads a log changed after its mirror (staleness marker), never serving stale text", async () => {
    const id = fixtureLog(uniqueId("stale"), [line({ source: LOG_SOURCE.LLM, content: "first quantum" })]);
    await syncSessionFromLog(id); // mirror populated with only the first message
    expect(await searchSessionCorpora("zeta-later")).toEqual([]);

    // Append a new assistant message WITHOUT re-syncing: size/mtime now differ
    // from the row, so the next search must re-read and find it.
    appendFileSync(join(SESSIONS_DIR, `${id}.jsonl`), line({ source: LOG_SOURCE.LLM, content: "now zeta-later too" }));
    const hits = await searchSessionCorpora("zeta-later");
    expect(hits.map((h) => h.sessionId)).toEqual([id]);
    // The same search refreshed the mirror: the row's search_text now attests
    // the appended text.
    expect(getSessionRow(id)?.search_text).toContain("zeta-later too");
  });

  it("matches exact substrings: % and _ are literal, not LIKE wildcards", async () => {
    const pct = fixtureLog(uniqueId("pct"), [line({ content: "100% done" })]);
    const under = fixtureLog(uniqueId("under"), [line({ content: "a_c" })]);
    await reconcileSessionIndex();

    // "%" alone matches only logs containing a literal percent, not everything.
    const pctHits = await searchSessionCorpora("%");
    expect(pctHits.map((h) => h.sessionId)).toEqual([pct]);
    // "a_c" matches the literal underscore text, and "%c" does not wildcard.
    expect((await searchSessionCorpora("a_c")).map((h) => h.sessionId)).toEqual([under]);
    expect(await searchSessionCorpora("a%c")).toEqual([]);
  });

  it("returns results newest-activity first", async () => {
    const oldId = fixtureLog(uniqueId("old"), [line({ content: "shared needle token" })]);
    const newId = fixtureLog(uniqueId("new"), [line({ content: "shared needle token" })]);
    const past = new Date(1_600_000_000_000);
    const future = new Date(1_800_000_000_000);
    utimesSync(join(SESSIONS_DIR, `${oldId}.jsonl`), past, past);
    utimesSync(join(SESSIONS_DIR, `${newId}.jsonl`), future, future);
    await reconcileSessionIndex();

    const hits = await searchSessionCorpora("shared needle");
    expect(hits.map((h) => h.sessionId)).toEqual([newId, oldId]);
  });
});
