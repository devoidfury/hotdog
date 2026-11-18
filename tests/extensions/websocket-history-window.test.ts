// Lazy history windowing: the pure window seam (history-window.ts) and the
// wire pair it powers -- viewLog now ships the trailing window with the
// additive oldestIndex/hasOlder/epochToken meta, and loadOlder pages
// backwards through the SAME alignment (requestId-correlated,
// LIST_DIR_RESULT-style honest refusals, epochToken staleness guard).
// Handler-level driving is the message-routing harness (stub registry, mock
// socket, real temp-dir logs).
//
// The search deep-link decision rides these pins: a search hit only OPENS a
// log (never positions to a match), so the window can never "miss" a match
// on open -- and the loop-to-the-top test below proves every match is
// REACHABLE through the loadOlder seam (window + all pages == the full
// epoch, entry for entry).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TMP_PARENT } from "../mocks/io.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import {
  HISTORY_WINDOW_MESSAGES,
  MAX_HISTORY_PAGE_MESSAGES,
  windowOlderThan,
} from "@extensions/websocket/history-window.ts";
import { LOG_SOURCE, type LogEntry } from "@core/session/session-log.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createWsMockWs } from "../mocks/websocket.ts";

// ── pure windowOlderThan: the boundary table ────────────────────────────────

type Seed = { source: string; content?: string };
const input = (c: string): Seed => ({ source: LOG_SOURCE.INPUT, content: c });
const prompt = (c: string): Seed => ({ source: LOG_SOURCE.PROMPT, content: c });
const llm = (c: string): Seed => ({ source: LOG_SOURCE.LLM, content: c });
const tool = (c = "out"): Seed => ({ source: LOG_SOURCE.TOOL_RESULT, content: c });
const usage = (): Seed => ({ source: LOG_SOURCE.TOKEN_USAGE, content: "" });
const bookkeeping = (): Seed => ({ source: LOG_SOURCE.SESSION_START, content: "" });

/** `k` complete turns: input + llm (+ token_usage bookkeeping). */
function turns(k: number): Seed[] {
  const out: Seed[] = [];
  for (let i = 0; i < k; i++) out.push(input(`Q${i}`), llm(`A${i}`), usage());
  return out;
}

function win(seeds: Seed[], k = HISTORY_WINDOW_MESSAGES) {
  return windowOlderThan(seeds as unknown as LogEntry[], seeds.length, k);
}

describe("windowOlderThan boundary table", () => {
  it("empty log ships everything", () => {
    expect(win([])).toEqual({ start: 0, hasOlder: false });
  });

  it("a log smaller than the window ships everything (hasOlder false)", () => {
    expect(win(turns(2))).toEqual({ start: 0, hasOlder: false });
  });

  it("exactly K messages ship everything (hasOlder false)", () => {
    const r = win(turns(HISTORY_WINDOW_MESSAGES));
    expect(r).toEqual({ start: 0, hasOlder: false });
  });

  it("K+1 messages: start is the SECOND user boundary, hasOlder true", () => {
    const seeds = turns(HISTORY_WINDOW_MESSAGES + 1);
    const r = win(seeds);
    expect(r.hasOlder).toBe(true);
    expect(seeds[r.start]!.source).toBe(LOG_SOURCE.INPUT);
    expect(seeds[r.start]!.content).toBe("Q1");
  });

  it("bookkeeping riding between boundaries travels with its turn (start stays a boundary)", () => {
    const seeds = [
      bookkeeping(),
      ...turns(HISTORY_WINDOW_MESSAGES + 2),
    ];
    const r = win(seeds);
    expect(r.hasOlder).toBe(true);
    expect(seeds[r.start]!.source).toMatch(/^(input|prompt)$/);
  });

  it("a log ending mid-tool-run ships the trailing tool run whole", () => {
    const seeds = [
      ...turns(HISTORY_WINDOW_MESSAGES + 1),
      input("mid run"),
      llm("calling"),
      tool(),
      tool(), // ends before the turn closes: the baggage must ride, not get cut
    ];
    const r = win(seeds);
    expect(r.hasOlder).toBe(true);
    // The trailing half-turn is smaller than a boundary-to-boundary turn; the
    // window holds its K boundaries AND everything after the last one.
    const shipped = seeds.slice(r.start);
    expect(shipped[0]!.source).toBe(LOG_SOURCE.INPUT);
    expect(shipped[shipped.length - 1]!.source).toBe(LOG_SOURCE.TOOL_RESULT);
    expect(shipped[shipped.length - 2]!.source).toBe(LOG_SOURCE.TOOL_RESULT);
  });

  it("consecutive prompts each count as a message", () => {
    const seeds: Seed[] = [];
    for (let i = 0; i < HISTORY_WINDOW_MESSAGES + 2; i++) seeds.push(prompt(`p${i}`));
    const r = win(seeds);
    expect(r.start).toBe(2); // all but the last K prompts fall out
    expect(r.hasOlder).toBe(true);
  });

  it("PROMPT counts as a boundary alongside INPUT", () => {
    const seeds: Seed[] = [input("a"), llm("b"), prompt("c"), llm("d")];
    expect(win(seeds, 1)).toMatchObject({ start: 2, hasOlder: true });
  });

  it("a log with NO boundary ships everything (nothing to align to)", () => {
    const seeds = [bookkeeping(), llm("no user ever spoke"), usage()];
    expect(win(seeds)).toEqual({ start: 0, hasOlder: false });
  });

  it("leading bookkeeping under the first boundary ships with the last page (hasOlder false)", () => {
    const seeds = [bookkeeping(), bookkeeping(), ...turns(HISTORY_WINDOW_MESSAGES + 1)];
    const firstPage = win(seeds);
    const older = windowOlderThan(seeds as unknown as LogEntry[], firstPage.start, HISTORY_WINDOW_MESSAGES);
    // Only K-1 boundaries remain below -> there is nothing older to page to:
    // the whole remainder ships from 0, the two bookkeeping rows included
    // (they render nothing; paging for them would buy nothing).
    expect(older.start).toBe(0);
    expect(older.hasOlder).toBe(false);
  });

  it("CJK/unicode content shifts no index (alignment is source-based)", () => {
    const seeds: Seed[] = [];
    for (let i = 0; i < HISTORY_WINDOW_MESSAGES + 1; i++) {
      seeds.push(input(`问题 ${i} 🚀 café`), llm(`回答 ${i} — ok`));
    }
    const r = win(seeds);
    expect(seeds[r.start]!.content).toBe("问题 1 🚀 café");
  });

  it("untrusted k is sanitized into [1, MAX_HISTORY_PAGE_MESSAGES]", () => {
    const seeds = turns(3);
    // k=0 / NaN clamp to 1: the last turn only (the LAST boundary to the
    // turn's end), older history honestly flagged.
    expect(win(seeds, 0)).toMatchObject({ start: 6, hasOlder: true });
    expect(win(seeds, NaN)).toMatchObject({ start: 6, hasOlder: true });
    // k beyond the cap collapses to the cap: 100 turns still page at MAX.
    const big = turns(100);
    const r = windowOlderThan(big as unknown as LogEntry[], big.length, 10_000);
    expect(r.start).toBe((100 - MAX_HISTORY_PAGE_MESSAGES) * 3);
  });
});

// ── handler level: viewLog windows, loadOlder pages ─────────────────────────

const SESSIONS_DIR = mkdtempSync(join(TMP_PARENT, "hotdog-history-win-"));
const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;
const coreStub = { completion: undefined } as unknown as CoreContext;

function stubRegistry(): any {
  return {
    get: () => undefined,
    list: () => [],
    size: 0,
    createChannel: () => ({}),
    removeChannel: () => {},
    sendTaskSnapshot: () => {},
    broadcast: () => {},
    broadcastExcept: () => {},
    getSessionManager: () => ({ isSessionRunning: () => false }),
    getTaskManager: () => null,
    sttEnabled: false,
    toolExecLabel: () => "inline",
  } as unknown as any;
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

async function send(msg: Record<string, unknown>): Promise<Array<Record<string, unknown>>> {
  const ws = createWsMockWs();
  await routeMessage(ws, msg as any, stubRegistry(), undefined, bridgeStub, coreStub);
  await flush();
  return ws.messages.map((m) => JSON.parse(m) as Record<string, unknown>);
}

/** Write an N-turn log: per turn input, llm (+ one bookkeeping row). */
function writeTurnLog(logId: string, n: number, contentTag = "q"): void {
  const lines: string[] = [];
  let t = 0;
  const ts = () => new Date(Date.parse("2024-01-01T00:00:00Z") + t++ * 1000).toISOString();
  lines.push(JSON.stringify({ ts: ts(), session_id: logId, source: LOG_SOURCE.SESSION_START, content: "" }));
  for (let i = 0; i < n; i++) {
    lines.push(JSON.stringify({ ts: ts(), session_id: logId, source: LOG_SOURCE.INPUT, content: `${contentTag}${i}` }));
    lines.push(JSON.stringify({ ts: ts(), session_id: logId, source: LOG_SOURCE.LLM, content: `a${i}` }));
    lines.push(JSON.stringify({ ts: ts(), session_id: logId, source: LOG_SOURCE.SESSION_START, content: "" }));
  }
  writeFileSync(join(SESSIONS_DIR, `${logId}.jsonl`), lines.join("\n") + "\n");
}

beforeAll(() => {
  process.env.HOTDOG_SESSIONS_DIR = SESSIONS_DIR;
});

afterAll(() => {
  delete process.env.HOTDOG_SESSIONS_DIR;
  try { rmSync(SESSIONS_DIR, { recursive: true, force: true }); } catch {}
});

describe("viewLog ships the trailing window", () => {
  it("a log that fits the window ships everything with NEITHER additive field", async () => {
    writeTurnLog("fits", HISTORY_WINDOW_MESSAGES);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "fits" });
    expect(viewed!.type).toBe(S2C.LOG_VIEWED);
    expect(viewed!.hasOlder).toBeUndefined();
    expect(viewed!.oldestIndex).toBeUndefined();
    // Everything ships: the only INPUT entries are all present.
    const inputs = (viewed!.entries as Array<Record<string, unknown>>).filter((e) => e.source === "input");
    expect(inputs).toHaveLength(HISTORY_WINDOW_MESSAGES);
  });

  it("a bigger log ships the last K turns, boundary-aligned, with oldestIndex/hasOlder", async () => {
    writeTurnLog("big", 10);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "big" });
    const entries = viewed!.entries as Array<Record<string, unknown>>;
    expect(viewed!.hasOlder).toBe(true);
    const oldestIndex = viewed!.oldestIndex as number;
    // Per turn: [bookkeeping, (input, llm, bookkeeping)*10] -> the window
    // starts AT a boundary, and ships the last K INPUTs.
    expect(entries[0]!.source).toBe("input");
    expect(entries[0]!.content).toBe("q4"); // 10 turns - K=6
    const inputs = entries.filter((e) => e.source === "input");
    expect(inputs).toHaveLength(HISTORY_WINDOW_MESSAGES);
    // oldestIndex is the index in the (epoch) log read, and the entry there
    // is exactly the first shipped one.
    const all = await send({ type: C2S.LOAD_OLDER, requestId: 1, logId: "big", olderThan: oldestIndex + 1 });
    const page = all[0]!;
    expect((page.entries as Array<Record<string, unknown>>).pop()).toEqual(entries[0]);
  });

  it("per-entry caps survive windowing (over-cap image still skipped)", async () => {
    const lines = [
      JSON.stringify({ ts: "2024-01-01T00:00:00Z", session_id: "caps", source: LOG_SOURCE.INPUT, content: "look" }),
      JSON.stringify({
        ts: "2024-01-01T00:00:01Z",
        session_id: "caps",
        source: LOG_SOURCE.INPUT,
        content: "pic",
        images: [{ mimeType: "image/png", data: "A".repeat(9 * 1024 * 1024) }],
      }),
    ];
    writeFileSync(join(SESSIONS_DIR, "caps.jsonl"), lines.join("\n") + "\n");
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "caps" });
    const withImg = (viewed!.entries as Array<Record<string, unknown>>).find((e) => e.images);
    const img = (withImg!.images as Array<Record<string, unknown>>)[0]!;
    expect(img.skipped).toBe(true);
    expect(typeof img.note).toBe("string");
    expect(img.data).toBeUndefined();
  });
});

describe("loadOlder pages backwards through the same seam", () => {
  it("round trip: requestId-correlated page, then hasOlder flips false at the beginning", async () => {
    writeTurnLog("page", 10);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "page" });
    const oldest = viewed!.oldestIndex as number;
    const replies = await send({ type: C2S.LOAD_OLDER, requestId: 77, logId: "page", olderThan: oldest });
    const result = replies.find((m) => m.type === S2C.LOAD_OLDER_RESULT)!;
    expect(result.requestId).toBe(77);
    expect(result.logId).toBe("page");
    const entries = result.entries as Array<Record<string, unknown>>;
    // The 4 remaining turns ride, whole, ending right above the held window
    // head -- trailing per-turn bookkeeping included (the page is the raw
    // epoch slice [start, olderThan), aligned only at the START boundary).
    expect(entries[entries.length - 1]!.source).toBe("session_start");
    expect(entries[entries.length - 2]!.content).toBe("a3");
    expect(entries[entries.length - 3]!.content).toBe("q3");
    expect(result.hasOlder).toBe(false); // <=K boundaries left -> everything ships
    // The epoch truth: a second page cannot exist (olderThan 0 refuses).
    const refusals = await send({ type: C2S.LOAD_OLDER, requestId: 78, logId: "page", olderThan: result.oldestIndex });
    const refusal = refusals.find((m) => m.type === S2C.LOAD_OLDER_RESULT)!;
    expect(refusal.requestId).toBe(78);
    expect(refusal.entries).toBeUndefined();
  });

  it("window + every page == the full epoch, entry for entry (a search match is always reachable)", async () => {
    writeTurnLog("deep-link", 20);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "deep-link" });
    let cursor = viewed!.oldestIndex as number;
    let hasOlder = viewed!.hasOlder === true;
    const collected = [...(viewed!.entries as Array<Record<string, unknown>>)];
    let guard = 0;
    while (hasOlder && guard++ < 50) {
      const [result] = await send({ type: C2S.LOAD_OLDER, requestId: 100 + guard, logId: "deep-link", olderThan: cursor });
      expect(result!.type).toBe(S2C.LOAD_OLDER_RESULT);
      expect(result!.error).toBeUndefined();
      collected.unshift(...(result!.entries as Array<Record<string, unknown>>));
      cursor = result!.oldestIndex as number;
      hasOlder = result!.hasOlder === true;
    }
    expect(hasOlder).toBe(false);
    // No gaps, no overlaps, log order: the loop delivers EVERY epoch entry
    // (deep-linked search matches page into view through this same seam).
    const inputs = collected.filter((e) => e.source === "input").map((e) => e.content);
    expect(inputs).toEqual(Array.from({ length: 20 }, (_, i) => `q${i}`));
  });

  it("pageSize is honored (and clamped)", async () => {
    writeTurnLog("sizes", 40);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "sizes" });
    const [result] = await send({
      type: C2S.LOAD_OLDER, requestId: 5, logId: "sizes", olderThan: viewed!.oldestIndex, pageSize: 2,
    });
    const inputs = (result!.entries as Array<Record<string, unknown>>).filter((e) => e.source === "input");
    expect(inputs).toHaveLength(2);
    expect(result!.hasOlder).toBe(true);
    // Beyond the cap: the request clamps to MAX_HISTORY_PAGE_MESSAGES, and
    // the older history is STILL there below (hasOlder stays honest).
    const [clamped] = await send({
      type: C2S.LOAD_OLDER, requestId: 6, logId: "sizes", olderThan: viewed!.oldestIndex, pageSize: 10_000,
    });
    const many = (clamped!.entries as Array<Record<string, unknown>>).filter((e) => e.source === "input");
    expect(many).toHaveLength(MAX_HISTORY_PAGE_MESSAGES);
    expect(clamped!.hasOlder).toBe(true);
  });

  it("honest refusals ride the correlated reply: bad index, unknown log, missing fields", async () => {
    writeTurnLog("refuse", 10);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "refuse" });
    const oldest = viewed!.oldestIndex as number;

    const beyond = await send({ type: C2S.LOAD_OLDER, requestId: 1, logId: "refuse", olderThan: 99999 });
    expect(beyond[0]!.type).toBe(S2C.LOAD_OLDER_RESULT);
    expect(beyond[0]!.requestId).toBe(1);
    expect(typeof beyond[0]!.error).toBe("string");
    expect(beyond[0]!.entries).toBeUndefined();

    const zero = await send({ type: C2S.LOAD_OLDER, requestId: 2, logId: "refuse", olderThan: 0 });
    expect(zero[0]!.requestId).toBe(2);
    expect(zero[0]!.error).toBeDefined();

    const notIndex = await send({ type: C2S.LOAD_OLDER, requestId: 3, logId: "refuse", olderThan: "5" });
    expect(notIndex[0]!.requestId).toBe(3);
    expect(notIndex[0]!.error).toBeDefined();

    const unknown = await send({ type: C2S.LOAD_OLDER, requestId: 4, logId: "no-such-log", olderThan: 3 });
    expect(unknown[0]!.requestId).toBe(4);
    expect(unknown[0]!.error).toBeDefined();

    const noId = await send({ type: C2S.LOAD_OLDER, requestId: 5, olderThan: 3 });
    expect(noId[0]!.requestId).toBe(5);
    expect(noId[0]!.error).toBeDefined();

    // The valid page still works next to the garbage.
    const ok = await send({ type: C2S.LOAD_OLDER, requestId: 6, logId: "refuse", olderThan: oldest });
    expect(ok[0]!.error).toBeUndefined();
    expect(ok[0]!.entries).toBeDefined();
  });

  it("sessionId names a live-ish log through the same seam (one id space)", async () => {
    writeTurnLog("via-session", 10);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "via-session" });
    const [result] = await send({
      type: C2S.LOAD_OLDER, requestId: 9, sessionId: "via-session", olderThan: viewed!.oldestIndex,
    });
    expect(result!.error).toBeUndefined();
    expect(result!.logId).toBe("via-session");
    expect((result!.entries as unknown[]).length).toBeGreaterThan(0);
  });
});

describe("windowing never moves the sidebar counts", () => {
  it("listLogs reports the durable count for a log whose VIEW was windowed", async () => {
    writeTurnLog("counts", 20);
    await send({ type: C2S.VIEW_LOG, logId: "counts" }); // window the view
    const [listed] = await send({ type: C2S.LIST_LOGS });
    const row = (listed!.logs as Array<Record<string, unknown>>).find((l) => l.id === "counts");
    // The durable truth: 20 inputs + 20 llm records count; the window is a
    // view, not a count (webui-count-parity doctrine).
    expect(row!.messageCount).toBe(40);
  });
});

// ── epoch token: a mid-socket RESET must not page a stale index ─────────────
// /rewind, /undo and /clear are dispatched to the LIVE agent (only /fork is
// intercepted): they append RESET + re-emitted history and send the attached
// socket nothing that re-attaches or re-attests. Once the epoch regrows past
// the held oldestIndex, the old coordinate means a DIFFERENT entry -- the
// attestation's epochToken (full-log epochStartIndex) is echoed on loadOlder
// and a mismatch refuses with code "epoch_moved" instead of serving a page
// that duplicates the on-screen head. Pins the judge-reproduced probe.

describe("epoch token guards stale indexes", () => {
  it("windowed logViewed attests epochToken = the epoch start (0 with no RESET)", async () => {
    writeTurnLog("tok-attest", 10);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "tok-attest" });
    expect(viewed!.oldestIndex).toBe(13); // the probe's held head
    expect(viewed!.epochToken).toBe(0);
  });

  it("RESET + kept history + regrowth past the head: stale token refuses, fresh attestation pages on", async () => {
    writeTurnLog("tok-undo", 10);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "tok-undo" });
    const oldest = viewed!.oldestIndex as number; // 13
    const token = viewed!.epochToken as number; // 0
    expect(oldest).toBe(13);

    // Emulate the live /undo the judge's probe ran: the log APPENDS a RESET,
    // the kept turns (q0..q8) re-appear below the marker, and two fresh
    // turns regrow the epoch past the held index (epoch-relative 13 lands
    // INSIDE the re-emitted kept history: q4 -- a duplicate of the head the
    // client already shows, with the true older history off by a turn).
    const kept = [
      { source: LOG_SOURCE.SESSION_START, content: "" },
      ...[...Array(9).keys()].flatMap((i) => [
        { source: LOG_SOURCE.INPUT, content: `q${i}` },
        { source: LOG_SOURCE.LLM, content: `a${i}` },
        { source: LOG_SOURCE.SESSION_START, content: "" },
      ]),
    ];
    const appended = [
      { source: LOG_SOURCE.RESET, content: "" },
      ...kept.slice(1), // re-emitted kept history (input/llm/bookkeeping)
      { source: LOG_SOURCE.INPUT, content: "new1" },
      { source: LOG_SOURCE.LLM, content: "n1" },
      { source: LOG_SOURCE.INPUT, content: "new2" },
      { source: LOG_SOURCE.LLM, content: "n2" },
    ];
    const path = join(SESSIONS_DIR, "tok-undo.jsonl");
    const original = readFileSync(path, "utf-8").trimEnd().split("\n");
    const lines = [...original, ...appended.map((e) => JSON.stringify({ ts: "2024-02-01T00:00:00Z", session_id: "tok-undo", ...e }))];
    writeFileSync(path, lines.join("\n") + "\n");
    // Sanity: the epoch really moved (epochStart = original 31 lines + the
    // RESET line = 32) and really regrew past the held index (epoch 34 long).
    expect(lines.length).toBe(31 + 1 + 27 + 4);

    // The held window's request: REFUSED, correlated, no entries.
    const stale = await send({
      type: C2S.LOAD_OLDER, requestId: 11, logId: "tok-undo", olderThan: oldest, epochToken: token,
    });
    const refusal = stale.find((m) => m.type === S2C.LOAD_OLDER_RESULT)!;
    expect(refusal.requestId).toBe(11);
    expect(refusal.code).toBe("epoch_moved");
    expect(typeof refusal.error).toBe("string");
    expect(refusal.entries).toBeUndefined();

    // A fresh attestation after the rewrite: new token, paging resumes.
    const [viewed2] = await send({ type: C2S.VIEW_LOG, logId: "tok-undo" });
    expect(viewed2!.epochToken).toBe(32);
    expect(viewed2!.hasOlder).toBe(true);
    const ok = await send({
      type: C2S.LOAD_OLDER,
      requestId: 12,
      logId: "tok-undo",
      olderThan: viewed2!.oldestIndex,
      epochToken: viewed2!.epochToken,
    });
    expect(ok[0]!.error).toBeUndefined();
    expect(ok[0]!.code).toBeUndefined();
    expect(ok[0]!.epochToken).toBe(32);
    // The fresh page is aligned in the NEW epoch (a boundary entry first).
    const entries = ok[0]!.entries as Array<Record<string, unknown>>;
    expect(entries[0]!.source).toBe("input");
  });

  it("pure appends never move the token (paging keeps working across new turns)", async () => {
    writeTurnLog("tok-append", 10);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "tok-append" });
    const path = join(SESSIONS_DIR, "tok-append.jsonl");
    const append = (e: Record<string, unknown>) =>
      appendFileSync(path, JSON.stringify({ ts: "2024-02-01T00:00:00Z", session_id: "tok-append", ...e }) + "\n");
    append({ source: LOG_SOURCE.INPUT, content: "q10" });
    append({ source: LOG_SOURCE.LLM, content: "a10" });
    const res = await send({
      type: C2S.LOAD_OLDER,
      requestId: 21,
      logId: "tok-append",
      olderThan: viewed!.oldestIndex,
      epochToken: viewed!.epochToken,
    });
    expect(res[0]!.error).toBeUndefined();
    expect(res[0]!.epochToken).toBe(0);
  });

  it("a tokenless request (pre-token client) keeps the pre-token behavior", async () => {
    writeTurnLog("tok-none", 10);
    const [viewed] = await send({ type: C2S.VIEW_LOG, logId: "tok-none" });
    const res = await send({ type: C2S.LOAD_OLDER, requestId: 31, logId: "tok-none", olderThan: viewed!.oldestIndex });
    expect(res[0]!.error).toBeUndefined();
    expect(res[0]!.entries).toBeDefined();
  });
});
