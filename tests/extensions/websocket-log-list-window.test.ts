// RECENT LOGS window suite: the LOGS_LISTED payload ships the newest
// LOG_LIST_WINDOW rows of the cold list (DESCENDING lastActivityAt, id DESC
// as the tie-break), attests `hasOlder` + the exclusive `olderCursor`
// seam, ships every pinned cold row on `pinnedLogs` regardless of window,
// and pages older history through C2S loadOlderLogs. Pins: the head window
// + cursor over 51+ synthetic logs; a full page walk whose concatenation
// covers every id exactly once; the equal-timestamp tie-break; a pinned
// row beyond the window that never rides a page; the garbage-cursor
// refusal (correlated error, LIST_DIR_RESULT posture); the untrusted page
// size clamped to MAX_LOG_LIST_PAGE; live ids excluded from EVERY frame
// (head and pages alike); the setPinned broadcast on its targeted logPins
// frame (no LOGS_LISTED fanout anywhere); the delta posture -- C2S `since`
// answers the strictly-newer set with full:false (no seam fields) and
// falls back to the FULL head when >window rows are newer, garbage
// `since` refuses on the requesting socket, the gen watermark stamps every
// frame and advances exactly +1 per membership transition (dismiss push,
// deleteLog stamp, cold-Continue adoption) with no windowed payload
// broadcast at those sites; and the search regression guard -- a hit
// outside the window is still found and still opens through viewLog by id.
// Last: a fat-store derivation-cost guard (a row read never materializes
// nor walks a fat log's search_text overflow).

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { TMP_PARENT } from "../mocks/io.ts";
import { join } from "node:path";
import { SessionRegistry } from "@extensions/websocket/session-registry.ts";
import { routeMessage } from "@extensions/websocket/message-routing.ts";
import { C2S, S2C } from "@extensions/websocket/protocol.ts";
import { LOG_LIST_WINDOW, MAX_LOG_LIST_PAGE } from "@extensions/websocket/history-window.ts";
import { closePinStore, dropPinned, setPinned } from "@extensions/websocket/pin-store.ts";
import { closeSessionIndex, reconcileSessionIndex, sessionIndexPath } from "@core/session/session-index.ts";
import { coldLogRows, compareLogRowsDesc, isOlderThanCursor, searchSessionLogs } from "@extensions/websocket/handlers-logs.ts";
import type { AgentLike } from "@core/session/index.ts";
import type { AuthMiddleware } from "@extensions/websocket/auth.ts";
import type { WebSocketQuestionBridge } from "@extensions/websocket/question-input.ts";
import type { CoreContext } from "@core/extensions/types.ts";
import { createWsMockWs, makeWsMockAgent } from "../mocks/websocket.ts";

const authStub = undefined as unknown as AuthMiddleware;
const bridgeStub = {
  peek: () => null,
  cancel: () => {},
  answer: () => false,
  clear: () => {},
} as unknown as WebSocketQuestionBridge;
const coreStub = { completion: undefined } as unknown as CoreContext;

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((r) => setTimeout(r, 0));
}

function makeRegistry(): SessionRegistry {
  return new SessionRegistry({ buildAgent: async () => makeWsMockAgent({}) as unknown as AgentLike });
}

/** Like makeRegistry, but the mock agent ADOPTS the requested sessionId --
 *  what cold-log resume/adoption needs (the gen-adopted pin) -- with the
 *  boot-resolved toolExec bag the real server hands over (without it the
 *  attach's sessionCreated posture throws). */
function makeResumeRegistry(): SessionRegistry {
  return new SessionRegistry({
    buildAgent: async (config: { sessionId?: string }) =>
      makeWsMockAgent({ sessionId: config.sessionId || "fresh-1" }) as unknown as AgentLike,
    toolExecResolved: { toolExec: "inline", execFence: "probe" },
  });
}

const TMP = mkdtempSync(join(TMP_PARENT, "hotdog-log-list-window-"));
let prevSessionsDir: string | undefined;

beforeAll(() => {
  prevSessionsDir = process.env.HOTDOG_SESSIONS_DIR;
  process.env.HOTDOG_SESSIONS_DIR = TMP;
  closePinStore();
});

afterAll(() => {
  closePinStore();
  closeSessionIndex();
  if (prevSessionsDir === undefined) delete process.env.HOTDOG_SESSIONS_DIR;
  else process.env.HOTDOG_SESSIONS_DIR = prevSessionsDir;
  rmSync(TMP, { recursive: true, force: true });
});

// ── Fixtures ────────────────────────────────────────────────────────────────
// 62 cold logs: wl-000..wl-059 with ts = T0 + i*1000 (i up = newer), plus
// the tie pair tie-aa/tie-bb both at TB = T0 + 30500. The full DESCENDING
// walk order (the cursor's total order: ts desc, id desc on ties):
//   wl-059 .. wl-031, tie-bb, tie-aa, wl-030 .. wl-000
const T0 = 1762000000000;
const TB = T0 + 30500;

function writeLog(logId: string, tsMs: number): void {
  writeFileSync(
    join(TMP, `${logId}.jsonl`),
    JSON.stringify({
      ts: new Date(tsMs).toISOString(),
      session_id: logId,
      source: "input",
      content: `window probe ${logId}`,
    }) + "\n",
  );
}

beforeAll(() => {
  for (let i = 0; i < 60; i++) writeLog(`wl-${String(i).padStart(3, "0")}`, T0 + i * 1000);
  writeLog("tie-aa", TB);
  writeLog("tie-bb", TB);
});

type Row = Record<string, unknown>;

async function listLogsFrame(registry: SessionRegistry, extra: Row = {}): Promise<Row> {
  const ws = createWsMockWs();
  await routeMessage(ws, { type: C2S.LIST_LOGS, ...extra } as never, registry, authStub, bridgeStub, coreStub);
  await flush();
  const frames = ws.messages.map((m) => JSON.parse(m) as Row);
  const frame = frames.find((f) => f.type === S2C.LOGS_LISTED)!;
  expect(frame).toBeTruthy();
  return frame;
}

async function olderPage(
  registry: SessionRegistry,
  requestId: number,
  olderThan: Row,
  extra: Row = {},
): Promise<Row> {
  const ws = createWsMockWs();
  await routeMessage(
    ws,
    { type: C2S.LOAD_OLDER_LOGS, requestId, olderThan, ...extra } as never,
    registry,
    authStub,
    bridgeStub,
    coreStub,
  );
  await flush();
  const frames = ws.messages.map((m) => JSON.parse(m) as Row);
  const frame = frames.find((f) => f.type === S2C.LOAD_OLDER_LOGS_RESULT)!;
  expect(frame).toBeTruthy();
  return frame;
}

const idsOf = (rows: unknown): string[] => (rows as Row[]).map((r) => r.id as string);

const parseFrames = (ws: { messages: string[] }): Row[] =>
  ws.messages.map((m) => JSON.parse(m) as Row);

describe("LOGS_LISTED: the windowed head over 51+ cold logs", () => {
  it("ships exactly LOG_LIST_WINDOW == 50 newest rows, DESC, with hasOlder + the last row's cursor", async () => {
    expect(LOG_LIST_WINDOW).toBe(50); // the module constant is the contract
    const frame = await listLogsFrame(makeRegistry());
    const ids = idsOf(frame.logs);
    expect(ids).toHaveLength(50);
    // Newest first: the head leads at the freshest log and ends at the 50th.
    expect(ids[0]).toBe("wl-059");
    expect(ids[49]).toBe("wl-012");
    // Strictly descending (ts, id) -- no jump, no repeat across the head.
    const rows = frame.logs as Row[];
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1]!;
      const b = rows[i]!;
      const desc =
        (a.lastActivityAt as number) > (b.lastActivityAt as number)
        || ((a.lastActivityAt as number) === (b.lastActivityAt as number) && (a.id as string) > (b.id as string));
      expect(desc).toBe(true);
    }
    // The tie pair rides the head in the cursor's id order (bb before aa):
    // equal lastActivityAt never inherits readdir luck.
    expect(ids.indexOf("tie-bb")).toBeGreaterThan(-1);
    expect(ids.indexOf("tie-bb")).toBeLessThan(ids.indexOf("tie-aa"));
    expect(frame.hasOlder).toBe(true);
    expect(frame.olderCursor).toEqual({ lastActivityAt: T0 + 12000, id: "wl-012" });
    // No pins persisted: the field is absent, not empty.
    expect("pinnedLogs" in frame).toBe(false);
  });

  it("a store that fits the window ships everything with hasOlder false and no cursor", async () => {
    // 62 fixtures > 50, so shrink the reachable store honestly: this pin
    // asks the SMALL side of the seam through the page reply instead (a
    // page's tail behaves identically -- hasOlder false, cursor omitted).
    const first = await olderPage(makeRegistry(), 1, { lastActivityAt: T0 + 50000, id: "wl-050" }, { size: 5 });
    expect(idsOf(first.logs)).toEqual(["wl-049", "wl-048", "wl-047", "wl-046", "wl-045"]);
    expect(first.hasOlder).toBe(true);
    expect(first.olderCursor).toEqual({ lastActivityAt: T0 + 45000, id: "wl-045" });
    const last = await olderPage(makeRegistry(), 2, { lastActivityAt: T0 + 21000, id: "wl-020" }, { size: 99 });
    expect(last.hasOlder).toBe(false);
    expect("olderCursor" in last).toBe(false);
  });

  it("an equal-timestamp cursor breaks the tie by id: only id < cursor.id ships", async () => {
    // Cursor ON tie-bb: the strict-older rule (== ts && id < cursor.id)
    // puts tie-aa on the page and never re-ships tie-bb or the newer rows.
    const page = await olderPage(makeRegistry(), 7, { lastActivityAt: TB, id: "tie-bb" }, { size: 3 });
    expect(idsOf(page.logs)).toEqual(["tie-aa", "wl-030", "wl-029"]);
    // Cursor ON tie-aa: both ties are NOT older -- the page starts below.
    const next = await olderPage(makeRegistry(), 8, { lastActivityAt: TB, id: "tie-aa" }, { size: 2 });
    expect(idsOf(next.logs)).toEqual(["wl-030", "wl-029"]);
  });

  it("the comparator is the TOTAL order the cursor promises (parity pin, readdir-proof)", () => {
    // The walk's no-skip/no-repeat contract needs (ts DESC, id DESC on
    // ties) no matter what order the store hands over -- pinned directly
    // because readdir's tie order is filesystem luck.
    const rows = [
      { lastActivityAt: 5, id: "b" },
      { lastActivityAt: 9, id: "z" },
      { lastActivityAt: 5, id: "a" },
      { lastActivityAt: 5, id: "c" },
      { lastActivityAt: 7, id: "m" },
    ];
    expect(rows.slice().sort(compareLogRowsDesc).map((r) => r.id)).toEqual(["z", "m", "c", "b", "a"]);
    // And the exclusive cursor follows the SAME total order: everything
    // strictly after the cursor row, nothing at or before it.
    const cursor = { lastActivityAt: 5, id: "b" };
    expect(
      rows
        .slice()
        .sort(compareLogRowsDesc)
        .filter((r) => isOlderThanCursor(r, cursor))
        .map((r) => r.id),
    ).toEqual(["a"]);
  });

  it("the page walk concatenates every id exactly once (head + pages, no gaps, no repeats)", async () => {
    const registry = makeRegistry();
    const frame = await listLogsFrame(registry);
    const seen: string[] = [];
    let cursor = frame.olderCursor as Row;
    expect(frame.hasOlder).toBe(true);
    let pages = 0;
    for (;;) {
      expect(cursor).toBeTruthy();
      const page = await olderPage(registry, 100 + pages, cursor, { size: 5 });
      pages++;
      expect(pages).toBeLessThan(20); // termination guard: the walk drains
      seen.push(...idsOf(page.logs));
      if (page.hasOlder !== true) {
        expect("olderCursor" in page).toBe(false);
        break;
      }
      cursor = page.olderCursor as Row;
    }
    const expectedTail: string[] = [];
    for (let i = 11; i >= 0; i--) expectedTail.push(`wl-${String(i).padStart(3, "0")}`);
    expect(seen).toEqual(expectedTail);
    const all = [...idsOf(frame.logs), ...seen];
    expect(new Set(all).size).toBe(62); // 60 + the tie pair, each exactly once
  });

  it("loadOlderLogs honors a sane size and defaults to the window; a cursor past the end honestly empties", async () => {
    const page = await olderPage(makeRegistry(), 9, { lastActivityAt: T0 + 59000, id: "wl-059" }, { size: 10 });
    expect((page.logs as Row[]).length).toBe(10);
    // Garbage sizes (0, negative, fractional) fall back to the window default.
    const dflt = await olderPage(makeRegistry(), 10, { lastActivityAt: T0 + 19000, id: "wl-019" }, { size: 0 });
    expect((dflt.logs as Row[]).length).toBeLessThanOrEqual(LOG_LIST_WINDOW);
    expect(dflt.hasOlder).toBe(false); // only 19 rows live below that cursor
    // A cursor older than everything: an honest empty page, not an error.
    const past = await olderPage(makeRegistry(), 11, { lastActivityAt: 1, id: "zz" });
    expect(past.logs).toEqual([]);
    expect(past.hasOlder).toBe(false);
  });

  it("a garbage cursor refuses honestly, still correlated, with zero rows", async () => {
    for (const garbage of ["nope", 42, {}, { lastActivityAt: "ts" }, null]) {
      const frame = await olderPage(makeRegistry(), 77, garbage as never);
      expect(frame.requestId).toBe(77);
      expect(typeof frame.error).toBe("string");
      expect((frame.error as string).length).toBeGreaterThan(0);
      expect("logs" in frame).toBe(false);
      expect("hasOlder" in frame).toBe(false);
    }
  });

  it("live ids stay out of EVERY frame: head, pinnedLogs, and the pages alike", async () => {
    const registry = makeRegistry();
    const { sessionId } = await registry.create({});
    writeLog(sessionId, T0 - 1000); // older than everything: it WOULD be the walk's tail
    try {
      const frame = await listLogsFrame(registry);
      expect(idsOf(frame.logs)).not.toContain(sessionId);
      expect(idsOf(frame.pinnedLogs ?? [])).not.toContain(sessionId);
      let cursor = frame.olderCursor as Row;
      for (;;) {
        const page = await olderPage(registry, 200, cursor);
        expect(idsOf(page.logs)).not.toContain(sessionId);
        if (page.hasOlder !== true) break;
        cursor = page.olderCursor as Row;
      }
    } finally {
      registry.delete(sessionId);
      rmSync(join(TMP, `${sessionId}.jsonl`), { force: true });
    }
  });

  it("pinned rows beyond the window ship via pinnedLogs and are NEVER duplicated on a page", async () => {
    const registry = makeRegistry();
    setPinned("wl-003", true); // sits in the OLDER pages, outside the head
    try {
      const frame = await listLogsFrame(registry);
      expect(idsOf(frame.logs)).not.toContain("wl-003");
      const pinned = frame.pinnedLogs as Row[];
      expect(idsOf(pinned)).toEqual(["wl-003"]);
      expect(pinned[0]!.pinned).toBe(true);
      expect(frame.hasOlder).toBe(true); // the walk only owns the UNPINNED remainder
      // Walk the whole seam: wl-003 never rides a page (its copy is the
      // base frame's pinnedLogs; the client dedupes by id anyway).
      const seen = [...idsOf(frame.logs)];
      let cursor = frame.olderCursor as Row;
      for (;;) {
        const page = await olderPage(registry, 300, cursor);
        expect(idsOf(page.logs)).not.toContain("wl-003");
        seen.push(...idsOf(page.logs));
        if (page.hasOlder !== true) break;
        cursor = page.olderCursor as Row;
      }
      const covered = new Set([...seen, ...idsOf(pinned)]);
      expect(covered.size).toBe(62); // every id exactly once across the frame set
    } finally {
      dropPinned("wl-003");
    }
  });

  it("a pinned row INSIDE the head rides both logs and pinnedLogs (client merges by id)", async () => {
    setPinned("wl-059", true);
    try {
      const frame = await listLogsFrame(makeRegistry());
      expect(idsOf(frame.logs)).toContain("wl-059");
      expect(idsOf(frame.pinnedLogs ?? [])).toContain("wl-059");
      expect((frame.logs as Row[]).find((r) => r.id === "wl-059")!.pinned).toBe(true);
    } finally {
      dropPinned("wl-059");
    }
  });
});

describe("setPinned broadcast: the pins frame replaces the windowed fanout", () => {
  it("every socket receives logPins with the complete id set -- and NO LOGS_LISTED", async () => {
    const registry = makeRegistry();
    const wsA = createWsMockWs();
    const wsB = createWsMockWs();
    registry.registerConnection(wsA);
    registry.registerConnection(wsB);
    try {
      // A pin BEYOND the window: the flip must still land in every tab's
      // marks even though the row sits nowhere near the head -- the pins
      // frame carries ids, not rows, so the window is irrelevant.
      await routeMessage(
        wsA,
        { type: C2S.SET_PINNED, sessionId: "wl-002", pinned: true } as never,
        registry,
        authStub,
        bridgeStub,
        coreStub,
      );
      await flush();
      for (const ws of [wsA, wsB]) {
        const frames = ws.messages
          .map((m) => JSON.parse(m) as Row)
          .filter((f) => f.type === S2C.LOG_PINS);
        expect(frames).toHaveLength(1);
        expect(frames[0]!.pinnedIds).toContain("wl-002");
        // The 50-row LOGS_LISTED fanout is GONE from this route.
        const listed = ws.messages
          .map((m) => JSON.parse(m) as Row)
          .filter((f) => f.type === S2C.LOGS_LISTED);
        expect(listed).toHaveLength(0);
      }
      // The full frame still ATTESTS the pin when the client asks: the
      // pins frame and the pinnedLogs attestation agree (store truth).
      const frame = await listLogsFrame(registry);
      expect(idsOf(frame.pinnedLogs ?? [])).toContain("wl-002");
    } finally {
      dropPinned("wl-002");
    }
  });

  it("an unpin broadcast drops the id from the complete set", async () => {
    const registry = makeRegistry();
    setPinned("wl-004", true);
    const ws = createWsMockWs();
    registry.registerConnection(ws);
    try {
      await routeMessage(
        ws,
        { type: C2S.SET_PINNED, sessionId: "wl-004", pinned: false } as never,
        registry,
        authStub,
        bridgeStub,
        coreStub,
      );
      await flush();
      const pins = ws.messages
        .map((m) => JSON.parse(m) as Row)
        .filter((f) => f.type === S2C.LOG_PINS)
        .pop()!;
      expect(pins.pinnedIds).not.toContain("wl-004");
    } finally {
      dropPinned("wl-004");
    }
  });
});

// ── Delta refreshes: since-cursor, cap fallback, gen watermark ─────────────

describe("listLogs since: delta frames and the gen watermark", () => {
  const genOf = (frame: Row): { boot: string; n: number } => {
    const gen = frame.gen as string;
    expect(typeof gen).toBe("string");
    const i = gen.lastIndexOf("-");
    return { boot: gen.slice(0, i), n: Number(gen.slice(i + 1)) };
  };

  it("absent since: the FULL frame shape is frozen -- exactly one additive gen, repeatable byte-identical", async () => {
    const registry = makeRegistry();
    const a = await listLogsFrame(registry);
    expect(Object.keys(a).sort()).toEqual(["gen", "hasOlder", "logs", "olderCursor", "type"]);
    expect("full" in a).toBe(false);
    // Membership is static between the two requests: the watermark is
    // stable, so the FULL frame is byte-identical (gen is the only added
    // field, and it moves only when membership moves).
    const b = await listLogsFrame(registry);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("since lands the strictly-newer set in the shipped order, full:false, seam fields absent", async () => {
    const frame = await listLogsFrame(makeRegistry(), {
      since: { lastActivityAt: T0 + 57000, id: "wl-057" },
    });
    expect(idsOf(frame.logs)).toEqual(["wl-059", "wl-058"]);
    expect(frame.full).toBe(false);
    expect(typeof frame.gen).toBe("string");
    // Doctrine: the client PREPENDS and keeps its held paging seam, so a
    // delta ships no seam at all.
    expect("hasOlder" in frame).toBe(false);
    expect("olderCursor" in frame).toBe(false);
    // No pins persisted: absent, not empty (same idiom as the full frame).
    expect("pinnedLogs" in frame).toBe(false);
  });

  it("a delta carries pinnedLogs: EVERY pinned cold row, even one OLDER than the cursor", async () => {
    setPinned("wl-003", true); // outside both the new set and the head
    try {
      const frame = await listLogsFrame(makeRegistry(), {
        since: { lastActivityAt: T0 + 55000, id: "wl-055" },
      });
      expect(idsOf(frame.logs)).toEqual(["wl-059", "wl-058", "wl-057", "wl-056"]);
      expect(frame.full).toBe(false);
      expect(idsOf(frame.pinnedLogs as Row[])).toEqual(["wl-003"]);
      expect((frame.pinnedLogs as Row[])[0]!.pinned).toBe(true);
    } finally {
      dropPinned("wl-003");
    }
  });

  it("the equal-timestamp cursor semantics hold for `since` too: strict newer, tie partner included", async () => {
    const withTie = await listLogsFrame(makeRegistry(), {
      since: { lastActivityAt: TB, id: "tie-aa" },
    });
    const ids = idsOf(withTie.logs);
    expect(ids).toHaveLength(30); // 29 rows above the tie ts + tie-bb
    expect(ids).toContain("tie-bb");
    expect(ids).not.toContain("tie-aa");
    expect(ids[0]).toBe("wl-059"); // the shipped DESC order is preserved
    const past = await listLogsFrame(makeRegistry(), {
      since: { lastActivityAt: TB, id: "tie-bb" },
    });
    expect(idsOf(past.logs)).toHaveLength(29);
    expect(idsOf(past.logs)).not.toContain("tie-bb");
  });

  it("a garbage since refuses honestly, on the requesting socket, with no frame", async () => {
    for (const garbage of ["nope", 42, {}, { lastActivityAt: "ts" }, null, { lastActivityAt: 1 }]) {
      const ws = createWsMockWs();
      await routeMessage(
        ws,
        { type: C2S.LIST_LOGS, since: garbage } as never,
        makeRegistry(),
        authStub,
        bridgeStub,
        coreStub,
      );
      await flush();
      const frames = ws.messages.map((m) => JSON.parse(m) as Row);
      expect(frames.filter((f) => f.type === S2C.LOGS_LISTED)).toHaveLength(0);
      const err = frames.find((f) => f.type === S2C.ERROR)!;
      expect(err).toBeTruthy();
      expect(typeof err.message).toBe("string");
      expect((err.message as string).length).toBeGreaterThan(0);
    }
  });

  it("a dark client (everything newer) gets the FULL head frame, not a partial merge", async () => {
    // 62 fixtures are all newer than the primeval cursor -- MORE than the
    // 50-row window -- so the reply must re-attest the head (no silent
    // partial prepend inside the window).
    const frame = await listLogsFrame(makeRegistry(), {
      since: { lastActivityAt: 1, id: "" },
    });
    expect(idsOf(frame.logs)).toHaveLength(LOG_LIST_WINDOW);
    expect(idsOf(frame.logs)[0]).toBe("wl-059");
    expect(frame.hasOlder).toBe(true);
    expect(frame.olderCursor).toEqual({ lastActivityAt: T0 + 12000, id: "wl-012" });
    expect("full" in frame).toBe(false);
    expect(typeof frame.gen).toBe("string");
  });

  it("a dismissed id bumps the watermark exactly +1, pushes the row, and never fans a LOGS_LISTED", async () => {
    const registry = makeRegistry();
    const before = genOf(await listLogsFrame(registry));
    const { sessionId } = await registry.create({});
    writeLog(sessionId, T0 + 61000); // newer than everything
    const peer = createWsMockWs();
    registry.registerConnection(peer);
    try {
      await routeMessage(
        createWsMockWs(),
        { type: C2S.DISMISS_SESSION, sessionId } as never,
        registry,
        authStub,
        bridgeStub,
        coreStub,
      );
      await flush();
      const added = parseFrames(peer).find((f) => f.type === S2C.LOG_ROW_ADDED)!;
      expect(added).toBeTruthy();
      expect((added.row as Row).id).toBe(sessionId);
      expect(genOf(added).boot).toBe(before.boot);
      expect(genOf(added).n).toBe(before.n + 1); // exactly one transition
      expect(parseFrames(peer).some((f) => f.type === S2C.LOGS_LISTED)).toBe(false);
      // The reply to a later listLogs continues the SAME watermark.
      const after = genOf(await listLogsFrame(registry));
      expect(after.n).toBe(genOf(added).n);
    } finally {
      rmSync(join(TMP, `${sessionId}.jsonl`), { force: true });
    }
  });

  it("a deleted log bumps the watermark and stamps both logDeleted sends alike", async () => {
    writeLog("gen-deleted", T0 + 62000);
    const registry = makeRegistry();
    const before = genOf(await listLogsFrame(registry));
    const peer = createWsMockWs();
    registry.registerConnection(peer);
    const ws = createWsMockWs();
    await routeMessage(ws, { type: C2S.DELETE_LOG, logId: "gen-deleted" } as never, registry, authStub, bridgeStub, coreStub);
    await flush();
    const mine = parseFrames(ws).filter((f) => f.type === S2C.LOG_DELETED);
    const theirs = parseFrames(peer).filter((f) => f.type === S2C.LOG_DELETED);
    expect(mine).toHaveLength(1);
    expect(theirs).toHaveLength(1);
    expect(mine[0]!.gen).toBe(theirs[0]!.gen); // one bump, one truth
    expect(genOf(mine[0]!).boot).toBe(before.boot);
    expect(genOf(mine[0]!).n).toBe(before.n + 1);
    const after = genOf(await listLogsFrame(registry));
    expect(after.n).toBe(before.n + 1);
  });

  it("a cold Continue (adoption) broadcasts logRowRemoved and bumps once", async () => {
    writeLog("gen-adopted", T0 + 63000);
    const registry = makeResumeRegistry();
    const before = genOf(await listLogsFrame(registry));
    const peer = createWsMockWs();
    registry.registerConnection(peer);
    try {
      const ws = createWsMockWs();
      registry.registerConnection(ws); // every production socket is registered
      await routeMessage(ws, { type: C2S.LOAD_LOG, logId: "gen-adopted" } as never, registry, authStub, bridgeStub, coreStub);
      await flush();
      const removed = parseFrames(peer).find((f) => f.type === S2C.LOG_ROW_REMOVED)!;
      expect(removed).toBeTruthy();
      expect(removed.sessionId).toBe("gen-adopted");
      expect(genOf(removed).boot).toBe(before.boot);
      expect(genOf(removed).n).toBe(before.n + 1);
      expect(parseFrames(peer).some((f) => f.type === S2C.LOGS_LISTED)).toBe(false);
      // The adopting socket is INCLUDED in the removal (its own sidebar
      // held the row; the prune is idempotent elsewhere).
      expect(parseFrames(ws).some((f) => f.type === S2C.LOG_ROW_REMOVED && f.sessionId === "gen-adopted")).toBe(true);
    } finally {
      registry.delete("gen-adopted");
      rmSync(join(TMP, "gen-adopted.jsonl"), { force: true });
    }
  });
});

describe("loadOlderLogs: the untrusted size ceiling", () => {
  it("clamps size to MAX_LOG_LIST_PAGE == 100 (150 older rows, size 9999)", async () => {
    expect(MAX_LOG_LIST_PAGE).toBe(100);
    // Deepen the store ONLY here: 150 rows strictly older than the base
    // cursor (the head frame's last row, wl-014 / T0+14000), so a
    // hostile size has to answer with exactly the ceiling, nothing more.
    for (let i = 0; i < 150; i++) writeLog(`cap-${String(i).padStart(3, "0")}`, T0 - 10000 - i * 1000);
    const frame = await olderPage(
      makeRegistry(),
      1,
      { lastActivityAt: T0 + 14000, id: "wl-014" },
      { size: 9999 },
    );
    expect((frame.logs as Row[]).length).toBe(MAX_LOG_LIST_PAGE);
    expect(frame.hasOlder).toBe(true);
    // The walk keeps draining from the returned cursor; nothing repeats.
    const cursor = frame.olderCursor as Row;
    const next = await olderPage(makeRegistry(), 2, cursor);
    const first = idsOf(frame.logs);
    expect(next.logs).toBeTruthy();
    for (const id of idsOf(next.logs)) expect(first).not.toContain(id);
  });
});

describe("search does not regress: a hit outside the window still opens", () => {
  it("searchSessionLogs scans the FULL corpus and viewLog opens the out-of-window hit", async () => {
    const registry = makeRegistry();
    // wl-001 is beyond the LOGS_LISTED head; its text proves the scan is
    // corpus-wide, not window-wide.
    const hits = await searchSessionLogs("window probe wl-001", registry);
    const hit = hits.find((h) => h.logId === "wl-001");
    expect(hit).toBeTruthy();
    expect(hit!.live).toBe(false);
    const frame = await listLogsFrame(registry);
    expect(idsOf(frame.logs)).not.toContain("wl-001"); // proof it is OUT of the head
    // The view opens by id (the list hides, the log stays addressable).
    const ws = createWsMockWs();
    await routeMessage(ws, { type: C2S.VIEW_LOG, logId: "wl-001" } as never, registry, authStub, bridgeStub, coreStub);
    await flush();
    const viewed = ws.messages.map((m) => JSON.parse(m) as Row).find((f) => f.type === S2C.LOG_VIEWED)!;
    expect(viewed.logId).toBe("wl-001");
    expect((viewed.entries as Row[]).length).toBeGreaterThan(0);
  });
});

describe("row-derivation cost: a fat log never rides a frame", () => {
  it("a 10 MB indexed log does not move the warm coldLogRows cost", async () => {
    // The frame derivation must answer from slim columns only: a row read
    // that expands search_text materializes the log's whole searchable body
    // (overflow pages) into a JS string, per cold row, per frame. The test
    // isolates exactly that variable: the SAME store is timed with the blob
    // mirrored and with it UPDATE-d away (position markers untouched, so the
    // row still serves the list). Same files, same rows, same plan -- the
    // blob is the only thing that changes, so no readdir/machine luck
    // enters. Threshold 2x + 1.5 ms is deliberately loose: it is a
    // regression bar, not a benchmark -- a row read that expands or even
    // walks the overflow chain (the list columns sit AFTER search_text, so
    // without the sessions_list covering index SQLite walks it) blows past
    // it by multiples, a covering-index read does not. min-of-9 per state,
    // states interleaved, so transient load hits both sides alike.
    const store = mkdtempSync(join(TMP_PARENT, "hotdog-log-list-fat-"));
    const prevDir = process.env.HOTDOG_SESSIONS_DIR;
    process.env.HOTDOG_SESSIONS_DIR = store;
    closeSessionIndex(); // reopen the index (and the pin store) on the fat store
    try {
      for (let i = 0; i < 24; i++) {
        const id = `lw-tiny-${String(i).padStart(2, "0")}`;
        writeFileSync(join(store, `${id}.jsonl`), JSON.stringify({
          ts: new Date(T0 + i * 1000).toISOString(), session_id: id, source: "input", content: `tiny ${i}`,
        }) + "\n");
      }
      const fatBody = "x".repeat(10_000_000);
      writeFileSync(join(store, "lw-fat.jsonl"), JSON.stringify({
        ts: new Date(T0 + 999000).toISOString(), session_id: "lw-fat", source: "input", content: fatBody,
      }) + "\n");
      const stats = await reconcileSessionIndex();
      expect(stats.logReads).toBe(25);

      const probe = new Database(sessionIndexPath());
      try {
        const blobLen = probe.query<{ n: number }, []>(
          "SELECT length(search_text) AS n FROM sessions WHERE session_id = 'lw-fat'",
        ).get()?.n;
        expect(blobLen).toBeGreaterThanOrEqual(9_900_000); // the mirror really is fat

        const registry = makeRegistry();
        const warm = await coldLogRows(registry); // index open + statement caches first
        expect(warm).toHaveLength(25);
        expect(warm.find((r) => r.id === "lw-fat")?.messageCount).toBe(1);

        const timed = async (): Promise<number> => {
          let best = Infinity;
          for (let i = 0; i < 9; i++) {
            const t0 = performance.now();
            await coldLogRows(registry);
            const dt = performance.now() - t0;
            if (dt < best) best = dt;
          }
          return best;
        };
        const clearBlob = () => probe.run("UPDATE sessions SET search_text = NULL WHERE session_id = 'lw-fat'");
        const restoreBlob = () => probe.run(
          "UPDATE sessions SET search_text = ? WHERE session_id = 'lw-fat'", [fatBody],
        );
        const a1 = await timed();
        clearBlob();
        const b1 = await timed();
        restoreBlob();
        const a2 = await timed();
        clearBlob();
        const b2 = await timed();
        const withBlob = Math.min(a1, a2);
        const blobless = Math.min(b1, b2);
        expect(withBlob).toBeLessThanOrEqual(2 * blobless + 1.5);
      } finally {
        probe.close();
      }
    } finally {
      process.env.HOTDOG_SESSIONS_DIR = prevDir ?? TMP;
      closeSessionIndex();
      rmSync(store, { recursive: true, force: true });
    }
  });
});
