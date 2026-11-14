// Sidebar row grammar (shared by live sessions and cold logs), pinned on the
// owner's fixture row:
//
//   manager · ai365/qwen3.8-flash-next    working            Stop
//   10-31 22:30 · 69k/262k · 42 msgs   [plug]   (this year, so no "YYYY-")
//
// Separators are middle dots (·, U+00B7) -- never a baseline period.
// No literal parens: status is a glyph badge (label as native title),
// profile quiet muted text, and
// the profile dot-joins ahead of the model on line 1 -- the join dot rides
// only when both halves speak. The line-1 action pins right
// (row-action-right) with no separator before it. The connected-client count
// shows as the plug icon trailing the bottom row -- the card's bottom-right
// (icon + number for 2+, icon only for 1, nothing at 0/unattested; tooltip
// via the native title) -- never a text metric, so row text must never read
// "client(s)". The raw session id renders nowhere -- the data model keeps it
// as the selection key. Segments that have no data are omitted outright; the
// legacy-log pins watch for "undefined"/"null" leakage into rendered text.

import { describe, it, expect, afterEach, jest } from "bun:test";
import {
  Sidebar,
  ContextMenu,
  clampMenuAnchor,
  formatDateTime,
  scrollHitIntoView,
  sortPinned,
  type SessionInfo,
  type LogInfo,
  type SearchState,
} from "@extensions/webui/ui/sessions.tsx";
import type { SearchHitWire, TaskInfoWire } from "@extensions/websocket/protocol.ts";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

// ── Fixture + harness ───────────────────────────────────────────────────────

// Local-time constructor: the expected stamp holds in any TZ. The year is
// pinned to the current one so the fixture stays a this-year row (line 3
// drops "YYYY-" while the year matches); last-year pins offset off CURRENT.
const CURRENT_YEAR = new Date().getFullYear();
const STAMP = new Date(CURRENT_YEAR, 9, 31, 22, 30).getTime();
const FULL_ID = "2s34e9825faaf89878923598";

const noop = (): void => {};

// Search closed by default; individual search tests override `search`.
const CLOSED_SEARCH = { open: false, query: "", pending: false, results: null } as const;

function mountSidebar(container: Element, opts: { sessions?: SessionInfo[]; logs?: LogInfo[]; working?: Map<string, boolean>; pinned?: Set<string>; search?: SearchState; logsCollapsed?: boolean; tasks?: TaskInfoWire[]; viewedTaskId?: string | null; subagentsCollapsed?: boolean; now?: number }): Mounted {
  return mount(
    <Sidebar
      sessions={opts.sessions ?? []}
      activeSessionId={null}
      workingMap={opts.working ?? new Map()}
      logs={opts.logs ?? []}
      activeLogId={null}
      pinnedIds={opts.pinned ?? new Set()}
      sidebarWidth={300}
      sidebarMax={520}
      sidebarCollapsed={false}
      logsCollapsed={opts.logsCollapsed ?? false}
      logsHeight={240}
      logsMin={96}
      logsMax={450}
      tasks={opts.tasks ?? []}
      viewedTaskId={opts.viewedTaskId ?? null}
      subagentsCollapsed={opts.subagentsCollapsed ?? false}
      now={opts.now ?? STAMP}
      onCreate={noop}
      onSwitch={noop}
      onCancel={noop}
      onViewLog={noop}
      onOpenTask={noop}
      onToggleSubagents={noop}
      onSessionMenu={noop}
      onLogMenu={noop}
      onTaskMenu={noop}
      search={opts.search ?? CLOSED_SEARCH}
      searchInputRef={noop}
      onOpenSearch={noop}
      onCloseSearch={noop}
      onSearchQuery={noop}
      onSearchKeydown={noop}
      onActivateHit={noop}
      onToggleLogs={noop}
      onResizeStart={noop}
      onResizeMove={noop}
      onResizeEnd={noop}
      onResizeKey={noop}
      onResizeReset={noop}
      onLogsResizeStart={noop}
      onLogsResizeMove={noop}
      onLogsResizeEnd={noop}
      onLogsResizeKey={noop}
      onLogsResizeReset={noop}
    />,
    container as unknown as DomNode,
  );
}

const texts = (root: Element, sel: string): string[] =>
  Array.from(root.querySelectorAll(sel)).map((n) => n.textContent ?? "");

let app: Mounted | null = null;
function render(opts: Parameters<typeof mountSidebar>[1]): Element {
  const host = document.createElement("div");
  app = mountSidebar(host, opts);
  return host;
}

afterEach(() => {
  app?.unmount();
  app = null;
});

function liveSession(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: FULL_ID,
    profile: "manager",
    title: null,
    model: "ai365/qwen3.8-flash-next",
    createdAt: STAMP,
    lastActivityAt: STAMP,
    connectedClients: 1,
    messageCount: 42,
    ctxUsed: 69000,
    ctxTotal: 262144,
    ...over,
  };
}

function coldLog(over: Partial<LogInfo> = {}): LogInfo {
  return {
    id: FULL_ID,
    createdAt: STAMP,
    lastActivityAt: STAMP,
    messageCount: 42,
    model: "ai365/qwen3.8-flash-next",
    profile: "manager",
    ctxUsed: 69000,
    ctxTotal: 262144,
    ...over,
  };
}

// ── Live row: every segment present ─────────────────────────────────────────

describe("live row (owner fixture)", () => {
  it("renders both grammar lines with the dot separators", () => {
    const root = render({ sessions: [liveSession()], working: new Map([[FULL_ID, true]]) });
    const row = root.querySelector(".session-item")!;
    expect(row).toBeTruthy();

    expect(row.querySelector(".row-model")!.textContent).toBe("ai365/qwen3.8-flash-next");
    // Working carries no status badge (owner ruling 2026-11-05): the Stop
    // button's spinner is the busy tell, so the bolt slot would double-say it.
    expect(row.querySelector(".row-status")).toBeNull();
    // The spinner rides the Stop button (composer idiom).
    const cancel = row.querySelector(".session-cancel-btn")!;
    expect(cancel.textContent).toBe("Stop");
    expect(cancel.querySelector(".spinner")).toBeTruthy();

    // Line 1 grammar: profile dot-joined ahead of the model, then the action
    // pinning right -- it trails every other line-1 slot and no sep precedes
    // it (the only line-1 dot is the profile/model join). No status slot while
    // working (owner ruling 2026-11-05): the Stop button carries the busy tell.
    const action = row.querySelector(".row-action")!;
    expect(action.classList.contains("row-action-right")).toBe(true);
    expect([...row.querySelector(".row-l1")!.children].map((n) => n.className)).toEqual([
      "row-profile",
      "row-sep",
      "row-model",
      "row-action row-action-right",
    ]);

    expect(row.querySelector(".row-profile")!.textContent).toBe("manager");
    // The client count rides the card's bottom-right as a plug icon, trailing
    // line 3 (the glyph is the inline svg idiom -- an empty glyph adds no
    // DOM text at 1 client; tooltip on the native title). aria-hidden
    // decoration: a glyph is not a stop on the way to the row's controls.
    // Never a text metric, and no row text ever mentions clients.
    const plug = row.querySelector(".row-clients")!;
    expect(plug).toBeTruthy();
    expect(plug.textContent).toBe("");
    expect(plug.getAttribute("title")).toBe("1 client connected");
    expect(plug.getAttribute("tabindex")).toBeNull();
    expect(plug.getAttribute("aria-hidden")).toBe("true");
    expect(row.textContent).not.toContain("client");

    expect(row.querySelector(".row-date")!.textContent).toBe("10-31 22:30");
    // Bottom row: date · ctx · msgs [plug][menu] -- the plug trails the
    // metrics (the bottom-right corner is CSS: margin-left:auto, the
    // row-action-right idiom) and the visible menu button trails the plug,
    // in that order.
    const l3 = row.querySelector(".row-l3")!;
    expect(l3.children[l3.children.length - 2]).toBe(plug);
    expect([...l3.children].map((n) => n.className)).toEqual([
      "row-date",
      "row-sep",
      "row-metric",
      "row-sep",
      "row-metric",
      "row-clients",
      "row-menu-btn",
    ]);
    expect(texts(l3, ".row-metric")).toEqual(["69k/262k", "42 msgs"]);

    // The raw id renders nowhere (it stays the selection key; see the id-
    // display section for the round trip through the click handler).
    expect(row.querySelector(".row-id")).toBeNull();
    expect(row.textContent).not.toContain(FULL_ID);

    // Separators: the profile/model join dot plus the two bottom-row dots,
    // all middle dots (·) -- a baseline "." would sit low in flex-centered
    // lines, so the glyph itself is pinned, not just the count.
    expect(row.querySelectorAll(".row-sep")).toHaveLength(3);
    for (const sep of row.querySelectorAll(".row-sep")) {
      expect(sep.textContent).toBe("·");
    }
  });

  it("idle rows carry no badge and no Stop action", () => {
    const root = render({ sessions: [liveSession()], working: new Map() });
    const row = root.querySelector(".session-item")!;
    expect(row.querySelector(".row-status")).toBeNull();
    expect(row.querySelector(".session-cancel-btn")).toBeNull();
    expect(row.querySelector(".spinner")).toBeNull();
    // No action slot: still the join dot + the two bottom-row dots.
    expect(row.querySelectorAll(".row-sep")).toHaveLength(3);
  });

  it("profile keeps the profile slot; the title rides its own middle line", () => {
    const root = render({ sessions: [liveSession({ title: "renamed" })] });
    const row = root.querySelector(".session-item")!;
    expect(row.querySelector(".row-profile")!.textContent).toBe("manager");
    const l2 = row.querySelector(".row-l2")!;
    expect(l2.textContent).toBe("renamed");
    // The line ellipsizes, so the full value rides the native title.
    expect(l2.getAttribute("title")).toBe("renamed");
    // The middle line sits between the grammar lines (l1, l2, l3).
    expect([...row.children].map((n) => n.className)).toEqual(["row-l1", "row-l2", "row-l3"]);
  });

  it("an untitled row omits the middle line outright", () => {
    const root = render({ sessions: [liveSession({ title: null })] });
    const row = root.querySelector(".session-item")!;
    expect(row.querySelector(".row-l2")).toBeNull();
    expect([...row.children].map((n) => n.className)).toEqual(["row-l1", "row-l3"]);
  });

  it("the profile/model join dot rides only when both halves speak", () => {
    const root = render({
      sessions: [
        liveSession({ id: "s-no-model", model: undefined }),
        liveSession({ id: "s-no-profile", profile: undefined }),
      ],
    });
    const rows = root.querySelectorAll(".session-item");
    // Profile alone leads line 1 with no dangling dot.
    expect(rows[0]!.querySelector(".row-profile")!.textContent).toBe("manager");
    expect(rows[0]!.querySelector(".row-model")).toBeNull();
    expect(rows[0]!.querySelectorAll(".row-l1 .row-sep")).toHaveLength(0);
    // Model alone: the profile slot omits outright, join dot with it.
    expect(rows[1]!.querySelector(".row-profile")).toBeNull();
    expect(rows[1]!.querySelector(".row-model")!.textContent).toBe("ai365/qwen3.8-flash-next");
    expect(rows[1]!.querySelectorAll(".row-l1 .row-sep")).toHaveLength(0);
  });

  it("a pending question wins the status slot over working/idle", () => {
    const root = render({
      sessions: [
        // Working AND asked: the human answer is what's actually outstanding.
        liveSession({ id: "q1", questionPending: true }),
        liveSession({ id: "q2", questionPending: false }),
      ],
      working: new Map([["q1", true]]),
    });
    const rows = root.querySelectorAll(".session-item");

    const asked = rows[0]!.querySelector(".row-status")!;
    expect(asked.getAttribute("title")).toBe("Awaiting question");
    expect(asked.querySelector("svg.row-glyph-awaiting_question")).toBeTruthy();
    expect(asked.className).toContain("log-state-awaiting_question");
    expect(asked.querySelector(".row-glyph-working")).toBeNull();
    // Stop still rides: interrupting settles the pending question.
    expect(rows[0]!.querySelector(".session-cancel-btn")).toBeTruthy();

    // questionPending false is an ordinary idle row: no badge at all.
    expect(rows[1]!.querySelector(".row-status")).toBeNull();
  });

  it("plug rules: number + plural tooltip at 2+, nothing at 0 or unattested", () => {
    const root = render({
      sessions: [
        liveSession({ id: "s2", connectedClients: 2 }),
        liveSession({ id: "s3", connectedClients: 0 }),
        // No connectedClients at all: unattested, not a zero state.
        (() => {
          const { connectedClients: _omit, ...bare } = liveSession({ id: "s4" });
          return bare as SessionInfo;
        })(),
      ],
    });
    const rows = root.querySelectorAll(".session-item");

    // Two clients: plug + number, plural tooltip, still no client WORD.
    const plug = rows[0]!.querySelector(".row-clients")!;
    expect(plug).toBeTruthy();
    expect(plug.textContent).toBe("2");
    expect(plug.getAttribute("title")).toBe("2 clients connected");
    // Icon + number (not the retired "2 clients" text metric): the plug is
    // its own span, and the row's metrics stay the ctx/msgs pair.
    expect(plug.querySelector(".row-clients-count")!.textContent).toBe("2");
    expect(texts(rows[0]!, ".row-metric")).toEqual(["69k/262k", "42 msgs"]);

    expect(rows[1]!.querySelector(".row-clients")).toBeNull();
    expect(rows[2]!.querySelector(".row-clients")).toBeNull();
    // Line 3 ends at the msgs metric on plug-less rows.
    expect(texts(rows[1]!, ".row-metric")).toEqual(["69k/262k", "42 msgs"]);
  });
});

// ── Cold row: no client segment, the log's own action ───────────────────────

describe("cold row", () => {
  it("renders model/status/ctx/msgs, and never a client segment", () => {
    const root = render({ logs: [coldLog({ state: "interrupted" })] });
    const row = root.querySelector(".log-item")!;
    expect(row.querySelector(".row-model")!.textContent).toBe("ai365/qwen3.8-flash-next");
    const status = row.querySelector(".row-status")!;
    expect(status.getAttribute("title")).toBe("Interrupted");
    expect(status.querySelector("svg.row-glyph-interrupted")).toBeTruthy();
    expect(row.querySelector(".row-profile")!.textContent).toBe("manager");
    expect(texts(row, ".row-metric")).toEqual(["69k/262k", "42 msgs"]);
    // Same bottom-row grammar as the live list: date · ctx · msgs [menu].
    expect([...row.querySelector(".row-l3")!.children].map((n) => n.className)).toEqual([
      "row-date",
      "row-sep",
      "row-metric",
      "row-sep",
      "row-metric",
      "row-menu-btn",
    ]);
    expect(row.querySelector(".row-id")).toBeNull();
    expect(row.textContent).not.toContain(FULL_ID);
    // No inline Resume (owner 2026-11-09: the context-menu item is the
    // resume path) -- cold rows carry no action slot at all.
    expect(row.querySelector(".log-continue-btn")).toBeNull();
    expect(row.querySelector(".row-action")).toBeNull();
    expect(row.textContent).not.toContain("client");
    expect(row.querySelector(".row-clients")).toBeNull();
    expect(row.querySelector(".session-cancel-btn")).toBeNull();
  });

  it("a cold log with a derived title gets the middle line between the grammar lines", () => {
    const root = render({ logs: [coldLog({ title: "Review the staged changes" })] });
    const row = root.querySelector(".log-item")!;
    const l2 = row.querySelector(".row-l2")!;
    expect(l2.textContent).toBe("Review the staged changes");
    expect(l2.getAttribute("title")).toBe("Review the staged changes");
    expect([...row.children].map((n) => n.className)).toEqual(["row-l1", "row-l2", "row-l3"]);
    // The profile slot still speaks the profile, never the title.
    expect(row.querySelector(".row-profile")!.textContent).toBe("manager");
  });

  it("an untitled cold log omits the middle line", () => {
    const root = render({ logs: [coldLog()] });
    expect(root.querySelector(".log-item")!.querySelector(".row-l2")).toBeNull();
  });

  it("idle (and missing) states omit the status segment", () => {
    const root = render({ logs: [coldLog({ id: "a", state: "idle" }), coldLog({ id: "b", state: undefined })] });
    const rows = root.querySelectorAll(".log-item");
    for (const row of rows) expect(row.querySelector(".row-status")).toBeNull();
    // No status: line 1 carries just the profile/model join dot, the bottom
    // row both dots (date · ctx · msgs).
    expect(rows[0]!.querySelectorAll(".row-sep")).toHaveLength(3);
  });

  it("the state label (underscores to spaces) rides the title; the glyph and state class follow the token", () => {
    const root = render({ logs: [coldLog({ state: "awaiting_question" })] });
    const status = root.querySelector(".row-status")!;
    expect(status.getAttribute("title")).toBe("Awaiting question");
    expect(status.textContent).toBe("");
    expect(status.className).toContain("log-state-awaiting_question");
    expect(status.querySelector("svg.row-glyph-awaiting_question")).toBeTruthy();
  });

  it("unknown state tokens fall back to text: no glyph, nothing vanishes", () => {
    const root = render({ logs: [coldLog({ state: "haunted" })] });
    const status = root.querySelector(".row-status")!;
    expect(status.textContent).toBe("haunted");
    expect(status.getAttribute("title")).toBe("haunted");
    expect(status.querySelector(".row-glyph")).toBeNull();
  });
});

// ── Legacy log: model/profile/ctx absent ────────────────────────────────────

describe("legacy log row (no model/profile/ctx attested)", () => {
  it("omits those segments entirely -- no 'undefined'/'null'/'()' leaks", () => {
    const root = render({
      logs: [coldLog({ model: undefined, profile: undefined, ctxUsed: undefined, ctxTotal: undefined, state: undefined })],
    });
    const row = root.querySelector(".log-item")!;
    const text = row.textContent;
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("null");
    expect(text).not.toContain("()");
    expect(text).not.toContain("NaN");
    expect(row.querySelector(".row-model")).toBeNull();
    expect(row.querySelector(".row-profile")).toBeNull();
    // ctx absent: only the msgs metric remains, dot-joined after the date.
    expect(texts(row, ".row-metric")).toEqual(["42 msgs"]);
    // Line 1 holds no dots at all (model/status absent, and the row carries
    // no inline action since the Resume button was retired).
    const l1 = row.querySelector(".row-l1")!;
    expect(l1.querySelectorAll(".row-sep")).toHaveLength(0);
    // Bottom row: no ctx attestation, so that segment omits -- date · msgs.
    expect(row.querySelector(".row-date")!.textContent).toBe("10-31 22:30");
    expect([...row.querySelector(".row-l3")!.children].map((n) => n.className)).toEqual([
      "row-date",
      "row-sep",
      "row-metric",
      "row-menu-btn",
    ]);
    expect(row.querySelector(".row-l3 .row-metric")!.textContent).toBe("42 msgs");
    expect(row.querySelector(".row-id")).toBeNull();
    expect(row.textContent).not.toContain(FULL_ID);
  });

  it("ctxUsed without a window renders bare k-notation (no '/undefined')", () => {
    const root = render({ logs: [coldLog({ ctxTotal: undefined })] });
    const metrics = texts(root, ".row-metric");
    expect(metrics[0]).toBe("69k");
    expect(metrics[0]).not.toContain("/");
  });
});

// ── Formatting composition ──────────────────────────────────────────────────

describe("formatDateTime", () => {
  it("drops the year for this-year stamps, padded MM-DD HH:MM in local time", () => {
    expect(formatDateTime(new Date(CURRENT_YEAR, 0, 5, 9, 7).getTime())).toBe("01-05 09:07");
    expect(formatDateTime(STAMP)).toBe("10-31 22:30");
  });

  it("keeps the full YYYY-MM-DD HH:MM when the year is not the current one", () => {
    expect(formatDateTime(new Date(CURRENT_YEAR - 1, 0, 5, 9, 7).getTime())).toBe(
      `${CURRENT_YEAR - 1}-01-05 09:07`,
    );
    // Future years are "not this year" too -- the rule is equality, not "past".
    expect(formatDateTime(new Date(CURRENT_YEAR + 1, 11, 31, 23, 59).getTime())).toBe(
      `${CURRENT_YEAR + 1}-12-31 23:59`,
    );
  });

  it("compares against the render-time year: a Jan-1 flip re-grows the year with no extra casing", () => {
    const newYearEve = new Date(2026, 11, 31, 23, 30).getTime();
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date(2026, 11, 31, 23, 59));
      expect(formatDateTime(newYearEve)).toBe("12-31 23:30");
      jest.setSystemTime(new Date(2027, 0, 1, 0, 1));
      // Same timestamp, one render later: the year comparison (new Date() at
      // call time, nothing cached) simply prints the full form again.
      expect(formatDateTime(newYearEve)).toBe("2026-12-31 23:30");
    } finally {
      jest.useRealTimers();
    }
  });
});

// ── Row interactions (handler wiring) ───────────────────────────────────────
// The grammar above is only as good as its routing: each slot must reach
// exactly the handler that owns it, and inner actions (Stop) must
// not leak through to the row's select -- stopPropagation is the pin here.

function mountInteractive(
  container: Element,
  opts: { sessions?: SessionInfo[]; logs?: LogInfo[]; working?: Map<string, boolean>; pinned?: Set<string>; search?: SearchState; activeSessionId?: string | null; activeLogId?: string | null; tasks?: TaskInfoWire[]; viewedTaskId?: string | null; subagentsCollapsed?: boolean; now?: number },
  calls: string[],
): Mounted {
  return mount(
    <Sidebar
      sessions={opts.sessions ?? []}
      activeSessionId={opts.activeSessionId ?? null}
      workingMap={opts.working ?? new Map()}
      logs={opts.logs ?? []}
      activeLogId={opts.activeLogId ?? null}
      pinnedIds={opts.pinned ?? new Set()}
      sidebarWidth={300}
      sidebarMax={520}
      sidebarCollapsed={false}
      logsCollapsed={false}
      logsHeight={240}
      logsMin={96}
      logsMax={450}
      tasks={opts.tasks ?? []}
      viewedTaskId={opts.viewedTaskId ?? null}
      subagentsCollapsed={opts.subagentsCollapsed ?? false}
      now={opts.now ?? STAMP}
      onCreate={() => calls.push("create")}
      onSwitch={(id) => calls.push(`switch:${id}`)}
      onCancel={(id) => calls.push(`cancel:${id}`)}
      onViewLog={(id) => calls.push(`view:${id}`)}
      onOpenTask={(id) => calls.push(`openTask:${id}`)}
      onToggleSubagents={() => calls.push("toggleSubagents")}
      onSessionMenu={(_e, s) => calls.push(`sessionMenu:${s.id}`)}
      onLogMenu={(_e, id) => calls.push(`logMenu:${id}`)}
      onTaskMenu={(_e, t) => calls.push(`taskMenu:${t.taskId}`)}
      search={opts.search ?? CLOSED_SEARCH}
      searchInputRef={noop}
      onOpenSearch={() => calls.push("openSearch")}
      onCloseSearch={() => calls.push("closeSearch")}
      onSearchQuery={(t) => calls.push(`searchQuery:${t}`)}
      onSearchKeydown={noop}
      onActivateHit={(hit) => calls.push(`activateHit:${hit.logId}`)}
      onToggleLogs={() => calls.push("toggleLogs")}
      onResizeStart={noop}
      onResizeMove={noop}
      onResizeEnd={noop}
      onResizeKey={noop}
      onResizeReset={noop}
      onLogsResizeStart={() => calls.push("logsResizeStart")}
      onLogsResizeMove={() => calls.push("logsResizeMove")}
      onLogsResizeEnd={() => calls.push("logsResizeEnd")}
      onLogsResizeKey={() => calls.push("logsResizeKey")}
      onLogsResizeReset={() => calls.push("logsResizeReset")}
    />,
    container as unknown as DomNode,
  );
}

function renderInteractive(
  opts: Parameters<typeof mountInteractive>[1],
  calls: string[],
): Element {
  const host = document.createElement("div");
  app = mountInteractive(host, opts, calls);
  return host;
}

// The dom-helper implements click() on every element; lib-dom types carry it
// only on HTMLElement (same cast as logview.test.tsx).
const clickable = (root: Element, sel: string): HTMLElement =>
  root.querySelector(sel) as unknown as HTMLElement;

describe("row interactions", () => {
  it("clicking a session row switches to it; the header + creates", () => {
    const calls: string[] = [];
    const root = renderInteractive({ sessions: [liveSession()] }, calls);
    clickable(root, ".session-item").click();
    expect(calls).toEqual([`switch:${FULL_ID}`]);
    clickable(root, "#new-session-btn").click();
    expect(calls).toEqual([`switch:${FULL_ID}`, "create"]);
  });

  it("Stop on a working row cancels it without also switching", () => {
    const calls: string[] = [];
    const root = renderInteractive(
      { sessions: [liveSession()], working: new Map([[FULL_ID, true]]) },
      calls,
    );
    clickable(root, ".session-cancel-btn").click();
    // Exactly one call: the button's stopPropagation keeps the row select off.
    expect(calls).toEqual([`cancel:${FULL_ID}`]);
  });

  it("right-clicking a session row opens its menu and suppresses the native one", () => {
    const calls: string[] = [];
    const root = renderInteractive({ sessions: [liveSession()] }, calls);
    // dispatchEvent returns !defaultPrevented: false proves SidebarRow's
    // wrapper called preventDefault before handing the event to the app.
    const prevented = clickable(root, ".session-item").dispatchEvent(new Event("contextmenu"));
    expect(calls).toEqual([`sessionMenu:${FULL_ID}`]);
    expect(prevented).toBe(false);
  });

  it("clicking a log row body opens it; right-click opens the log menu", () => {
    const calls: string[] = [];
    const root = renderInteractive({ logs: [coldLog()] }, calls);
    const row = clickable(root, ".log-item");
    row.click();
    row.dispatchEvent(new Event("contextmenu"));
    expect(calls).toEqual([`view:${FULL_ID}`, `logMenu:${FULL_ID}`]);
  });
});

// ── Keyboard access (audit 1.2) ─────────────────────────────────────────────
// Rows were inert divs; they are focusable list items now, with Enter/Space
// opening exactly what a left-click opens and the Menu key / Shift+F10 opening
// exactly what a right-click opens. keyOn returns !defaultPrevented, so the
// Enter/Space pins also prove the page scroll was suppressed.

const keyOn = (el: Element, k: string, over: Record<string, unknown> = {}): boolean =>
  // No preventDefault in the payload on purpose: dom-helper Object.assigns
  // payload fields over DEvent, and a stub would swallow the real flag the
  // return value reports.
  (el as unknown as HTMLElement).dispatchEvent({
    type: "keydown",
    key: k,
    currentTarget: el,
    ...over,
  } as unknown as Event);

describe("row keyboard access", () => {
  it("rows are focusable list items; the lists carry role=list only with rows", () => {
    const root = render({ sessions: [liveSession()], logs: [coldLog()] });
    expect(clickable(root, ".session-item").getAttribute("role")).toBe("listitem");
    expect(clickable(root, ".session-item").getAttribute("tabindex")).toBe("0");
    expect(clickable(root, ".log-item").getAttribute("role")).toBe("listitem");
    expect(clickable(root, ".log-item").getAttribute("tabindex")).toBe("0");
    expect(root.querySelector("#session-list")!.getAttribute("role")).toBe("list");
    expect(root.querySelector("#log-list")!.getAttribute("role")).toBe("list");
    // No rows -> no list (a role=list without listitems misleads readers).
    const empty = render({});
    expect(empty.querySelector("#session-list")!.getAttribute("role")).toBeNull();
    expect(empty.querySelector("#log-list")!.getAttribute("role")).toBeNull();
  });

  it("Enter on a row activates exactly what a click activates", () => {
    const calls: string[] = [];
    const root = renderInteractive({ sessions: [liveSession()], logs: [coldLog()] }, calls);
    expect(keyOn(clickable(root, ".session-item"), "Enter")).toBe(false); // prevented
    expect(keyOn(clickable(root, ".log-item"), "Enter")).toBe(false);
    expect(calls).toEqual([`switch:${FULL_ID}`, `view:${FULL_ID}`]);
  });

  it("Space activates and suppresses the list scroll", () => {
    const calls: string[] = [];
    const root = renderInteractive({ sessions: [liveSession()] }, calls);
    expect(keyOn(clickable(root, ".session-item"), " ")).toBe(false);
    expect(calls).toEqual([`switch:${FULL_ID}`]);
  });

  it("keys bubbling from a row's own button never double-activate the row", () => {
    const calls: string[] = [];
    const root = renderInteractive(
      { sessions: [liveSession()], working: new Map([[FULL_ID, true]]) },
      calls,
    );
    const row = clickable(root, ".session-item");
    const stop = clickable(root, ".session-cancel-btn");
    // The real-browser shape of a keydown that started on the button:
    // target=button, currentTarget=row. The row must stay silent.
    stop.dispatchEvent({
      type: "keydown",
      key: "Enter",
      target: stop,
      currentTarget: row,
      preventDefault: () => {},
    } as unknown as Event);
    expect(calls).toEqual([]);
  });

  it("the Menu key and Shift+F10 open the row menu; plain F10 does not", () => {
    const calls: string[] = [];
    const root = renderInteractive({ sessions: [liveSession()], logs: [coldLog()] }, calls);
    keyOn(clickable(root, ".session-item"), "ContextMenu");
    keyOn(clickable(root, ".log-item"), "F10", { shiftKey: true });
    keyOn(clickable(root, ".log-item"), "F10"); // unmodified F10 stays unclaimed
    expect(calls).toEqual([`sessionMenu:${FULL_ID}`, `logMenu:${FULL_ID}`]);
  });

  it("the active row carries aria-current; inactive rows carry none", () => {
    const calls: string[] = [];
    const liveActive = renderInteractive(
      { sessions: [liveSession()], logs: [coldLog()], activeSessionId: FULL_ID },
      calls,
    );
    expect(clickable(liveActive, ".session-item").getAttribute("aria-current")).toBe("true");
    expect(clickable(liveActive, ".log-item").getAttribute("aria-current")).toBeNull();
    const logActive = renderInteractive(
      { sessions: [liveSession()], logs: [coldLog()], activeLogId: FULL_ID },
      calls,
    );
    expect(clickable(logActive, ".log-item").getAttribute("aria-current")).toBe("true");
    expect(clickable(logActive, ".session-item").getAttribute("aria-current")).toBeNull();
  });
});

// ── Recent Logs titlebar (collapse + vertical drag handle) ─────────────────
// The secondary header is the section's collapse control AND its vertical
// resize handle (panel-resize.ts drives it from app.tsx). What the component
// owns: the chevron button's a11y contract, the separator semantics that ride
// only while there is a height to drag, and the rule that a gesture landing
// on the button belongs to the button.

const pointer = (el: Element, type: string, init: Record<string, unknown> = {}): boolean =>
  (el as unknown as HTMLElement).dispatchEvent({ type, ...init } as unknown as Event);

describe("Recent Logs titlebar", () => {
  it("expanded: the header is a focusable horizontal separator and the chevron says collapse", () => {
    const root = render({ logs: [coldLog()] });
    const header = root.querySelector(".sidebar-header-secondary")!;
    expect(header.getAttribute("class")).toContain("sidebar-header-resize");
    expect(header.getAttribute("role")).toBe("separator");
    expect(header.getAttribute("aria-orientation")).toBe("horizontal");
    expect(header.getAttribute("aria-label")).toContain("Resize");
    expect(header.getAttribute("tabindex")).toBe("0");
    expect(header.getAttribute("aria-valuenow")).toBe("240");
    expect(header.getAttribute("aria-valuemin")).toBe("96");
    expect(header.getAttribute("aria-valuemax")).toBe("450");

    const toggle = root.querySelector("#logs-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe("log-list");
    expect(toggle.getAttribute("aria-label")).toBe("Collapse recent logs");
    // Chevron down while expanded; the glyph is decoration (aria-hidden).
    // The flip rides the same class names (CSS rotates the svg).
    expect(root.querySelector("svg.logs-toggle-glyph")!.getAttribute("class")).not.toContain("-up");
    expect(root.querySelector("svg.logs-toggle-glyph")!.getAttribute("aria-hidden")).toBe("true");
    // The list is present and the live-sessions section above it untouched.
    expect(root.querySelector("#log-list")).not.toBeNull();
    expect(root.querySelector("#session-list")).not.toBeNull();
    expect(root.querySelector("aside")!.getAttribute("class") ?? "").not.toContain("logs-collapsed");
  });

  it("collapsed: the header stays, the drag semantics drop, the chevron flips", () => {
    const root = render({ logs: [coldLog()], logsCollapsed: true });
    const header = root.querySelector(".sidebar-header-secondary")!;
    // A collapsed section has no height to drag: no separator, no tabindex,
    // no row-resize class (the cursor must not lie).
    expect(header.getAttribute("class")).not.toContain("sidebar-header-resize");
    expect(header.getAttribute("role")).toBeNull();
    expect(header.getAttribute("tabindex")).toBeNull();
    expect(header.getAttribute("aria-valuenow")).toBeNull();
    // Still a header with its title, still holding the toggle.
    expect(header.textContent).toContain("Recent Logs");
    const toggle = root.querySelector("#logs-toggle")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(toggle.getAttribute("aria-label")).toBe("Expand recent logs");
    expect(root.querySelector("svg.logs-toggle-glyph")!.getAttribute("class")).toContain("logs-toggle-glyph-up");
    // The class that hides the list rides the aside (CSS drops #log-list out
    // of the flow; the live-sessions list keeps its own slot).
    expect(root.querySelector("aside")!.getAttribute("class")).toContain("logs-collapsed");
    expect(root.querySelector("#session-list")).not.toBeNull();
  });

  it("the toggle routes to onToggleLogs", () => {
    const calls: string[] = [];
    const root = renderInteractive({ logs: [coldLog()] }, calls);
    clickable(root, "#logs-toggle").click();
    expect(calls).toEqual(["toggleLogs"]);
  });

  it("drag and reset ride the titlebar, but never the toggle button", () => {
    const calls: string[] = [];
    const root = renderInteractive({ logs: [coldLog()] }, calls);
    const header = root.querySelector(".sidebar-header-secondary")!;
    pointer(header, "pointerdown", { pointerId: 1, clientY: 200, currentTarget: header });
    expect(calls).toEqual(["logsResizeStart"]);
    calls.length = 0;
    // The button swallows its own pointerdown and dblclick, so a press on the
    // chevron is never a drag and a double-click on it is never a height reset.
    const toggle = clickable(root, "#logs-toggle");
    pointer(toggle, "pointerdown", { pointerId: 1, clientY: 200, currentTarget: toggle });
    pointer(toggle, "dblclick", { currentTarget: toggle });
    expect(calls).toEqual([]);
    // ...while the same gesture on the titlebar still reaches the seam.
    pointer(header, "dblclick", { currentTarget: header });
    expect(calls).toEqual(["logsResizeReset"]);
  });

  it("keydown on the titlebar reaches the keyboard resize handler", () => {
    const calls: string[] = [];
    const root = renderInteractive({ logs: [coldLog()] }, calls);
    const header = root.querySelector(".sidebar-header-secondary")!;
    pointer(header, "keydown", { key: "ArrowDown", currentTarget: header });
    expect(calls).toEqual(["logsResizeKey"]);
  });
});

// ── Subagents section (nested under the manager card) ───────────────────────
// The collapsible disclosure under a live session row: header "Subagents" +
// chevron (#logs-toggle grammar), one row per task agent with a status glyph,
// a chipLabel idiom label, and an elapsed clock. Rows are the task feed
// scoped to that manager; clicking a row asks the app to open the task's
// transcript in the main view (openTask routing).

const subTask = (over: Partial<TaskInfoWire> & { taskId: string }): TaskInfoWire => ({
  description: `task ${over.taskId}`,
  sessionId: FULL_ID,
  status: "running",
  createdAt: STAMP - 5000,
  startedAt: STAMP - 4000,
  endedAt: null,
  activeMs: 1000,
  inRun: true,
  turnStartedAt: STAMP - 1000,
  ...over,
});

describe("Subagents section", () => {
  it("rows render under the owning card only; foreign and null-parent tasks stay away", () => {
    const root = render({
      sessions: [liveSession(), liveSession({ id: "other-session", profile: "coder" })],
      tasks: [
        subTask({ taskId: "2:chrome#1" }),
        subTask({ taskId: "x1", sessionId: "other-session" }),
        subTask({ taskId: "orphan", sessionId: null }),
      ],
      now: STAMP,
    });
    // Every task rides the section of ITS manager card (the server scopes the
    // feed to the attached session, so in practice one section populates;
    // the filter routes, it does not leak).
    const sections = root.querySelectorAll(".subagents-section");
    expect(sections).toHaveLength(2);
    expect(sections[0]!.querySelectorAll(".subagent-row")).toHaveLength(1);
    expect(sections[1]!.querySelectorAll(".subagent-row")).toHaveLength(1);
    const rows = sections[0]!.querySelectorAll(".subagent-row");
    expect(rows[0]!.getAttribute("data-task-id")).toBe("2:chrome#1");
    // chipLabel: the step name after the last ':', the clock right-aligned.
    expect(rows[0]!.querySelector(".subagent-row-label")!.textContent).toBe("chrome#1");
    expect(rows[0]!.querySelector(".subagent-row-elapsed")!.textContent).toBe("2s");
    // The glyph slot reuses the subagent status vocabulary (running here).
    expect(rows[0]!.querySelector("svg")!.getAttribute("class")).toContain("subagent-glyph-running");
    // No card text leaks the raw task id (title only); sessions keep their
    // data-sid anchors, rows ride data-task-id (scrollHitIntoView stays
    // session-id-only).
    expect(rows[0]!.getAttribute("data-sid")).toBeNull();
    expect(rows[0]!.getAttribute("title")).toContain("2:chrome#1");
    // The null-parent task (workflow-engine spawn) belongs to no card.
    expect(root.textContent).not.toContain("orphan");
  });

  it("live tasks lead, settled ones trail newest-first; one run needs no prefix", () => {
    const root = render({
      sessions: [liveSession()],
      tasks: [
        subTask({ taskId: "runx:doneOld", status: "completed", inRun: false, createdAt: STAMP - 9000 }),
        subTask({ taskId: "runx:liveNow", createdAt: STAMP - 1000 }),
        subTask({ taskId: "runx:doneNew", status: "completed", inRun: false, createdAt: STAMP - 2000 }),
      ],
      now: STAMP,
    });
    const ids = Array.from(root.querySelectorAll(".subagent-row")).map((r) => r.getAttribute("data-task-id"));
    expect(ids).toEqual(["runx:liveNow", "runx:doneNew", "runx:doneOld"]);
    // Single run: labels are bare step names (no discriminator prefix).
    const labels = Array.from(root.querySelectorAll(".subagent-row-label")).map((n) => n.textContent);
    expect(labels).toEqual(["liveNow", "doneNew", "doneOld"]);
  });

  it("two runs in one list get the shortest discriminating prefix", () => {
    const root = render({
      sessions: [liveSession()],
      tasks: [
        subTask({ taskId: "20261017-1848-hotdog-archeology:review#1" }),
        subTask({ taskId: "20261017-1848-hotdog-reprint:pass#1" }),
      ],
      now: STAMP,
    });
    const labels = Array.from(root.querySelectorAll(".subagent-row-label")).map((n) => n.textContent);
    // The shared timestamp prefix stays off the row: the discriminating tail
    // (last dash segment, unique across runs) rides instead.
    expect(labels).toEqual(["archeology:review#1", "reprint:pass#1"]);
  });

  it("a parked-running row reads waiting with a frozen clock; the header keeps the disclosure grammar", () => {
    const root = render({
      sessions: [liveSession()],
      tasks: [subTask({ taskId: "p#1", activeMs: 12_000, inRun: false, turnStartedAt: null })],
      now: STAMP,
    });
    const row = root.querySelector(".subagent-row")!;
    expect(row.getAttribute("class")).toContain("status-running");
    expect(row.getAttribute("class")).toContain("waiting");
    expect(row.querySelector(".subagent-row-elapsed")!.getAttribute("class")).toContain("waiting");
    expect(row.querySelector(".subagent-row-elapsed")!.textContent).toBe("12s"); // frozen
    expect(row.querySelector("svg")!.getAttribute("class")).toContain("subagent-glyph-parked");

    const header = root.querySelector(".subagents-header")!;
    expect(header.textContent).toContain("Subagents");
    const toggle = root.querySelector(`#subagents-toggle-${FULL_ID}`)!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.getAttribute("aria-controls")).toBe(`subagent-list-${FULL_ID}`);
    expect(root.querySelector(`#subagent-list-${FULL_ID}`)).toBeTruthy();
    expect(root.querySelector("svg.subagents-toggle-glyph")!.getAttribute("class")).not.toContain("-up");
  });

  it("collapse hides the rows, flips the chevron, and routes to onToggleSubagents", () => {
    const calls: string[] = [];
    const root = renderInteractive(
      { sessions: [liveSession()], tasks: [subTask({ taskId: "c#1" })] },
      calls,
    );
    clickable(root, `#subagents-toggle-${FULL_ID}`).click();
    expect(calls).toEqual(["toggleSubagents"]);
    // Collapsed rendering (the app drives the prop; mount again to see it).
    const folded = render({
      sessions: [liveSession()],
      tasks: [subTask({ taskId: "c#1" })],
      subagentsCollapsed: true,
    });
    expect(folded.querySelector(".subagents-section")!.getAttribute("class")).toContain("collapsed");
    expect(folded.querySelector(`#subagents-toggle-${FULL_ID}`)!.getAttribute("aria-expanded")).toBe("false");
    expect(folded.querySelector("svg.subagents-toggle-glyph")!.getAttribute("class")).toContain("subagents-toggle-glyph-up");
    // The header stays on screen (the rows are hidden by CSS, the disclosure
    // must remain operable): aria-controls still points at the list.
    expect(folded.querySelector(".subagents-header")).toBeTruthy();
    expect(folded.querySelector("#subagent-list-" + FULL_ID)).toBeTruthy();
  });

  it("row clicks route the task id to onOpenTask; the viewed row carries the active mark", () => {
    const calls: string[] = [];
    const root = renderInteractive(
      {
        sessions: [liveSession()],
        tasks: [subTask({ taskId: "run:alpha#1" }), subTask({ taskId: "run:beta#2" })],
        viewedTaskId: "run:beta#2",
      },
      calls,
    );
    const rows = root.querySelectorAll(".subagent-row");
    (rows[0] as HTMLElement).click();
    expect(calls).toEqual(["openTask:run:alpha#1"]);
    // The viewed task highlights in the list (same aria-current idiom as the
    // session/log rows), and re-clicking it re-routes (the main view re-opens).
    expect(rows[1]!.getAttribute("class")).toContain("active");
    expect(rows[1]!.getAttribute("aria-current")).toBe("true");
    expect(rows[0]!.getAttribute("class")).not.toContain("active");
    (rows[1] as HTMLElement).click();
    expect(calls[calls.length - 1]).toBe("openTask:run:beta#2");
  });

  it("subagent rows: right-click, kebab, and keyboard twins route the task menu", () => {
    const calls: string[] = [];
    const root = renderInteractive(
      { sessions: [liveSession()], tasks: [subTask({ taskId: "run:one#1" })] },
      calls,
    );
    const row = root.querySelector(".subagent-row")!;
    // The row shares the session/log row grammar: a focusable list item.
    expect(row.getAttribute("role")).toBe("listitem");
    expect(row.getAttribute("tabindex")).toBe("0");
    // Right-click routes the task to onTaskMenu (the app's context menu).
    row.dispatchEvent({
      type: "contextmenu",
      currentTarget: row,
      preventDefault: () => {},
    } as unknown as Event);
    expect(calls).toEqual(["taskMenu:run:one#1"]);
    calls.length = 0;
    // Keyboard twin on the row itself.
    keyOn(row, "ContextMenu");
    keyOn(row, "F10", { shiftKey: true });
    expect(calls).toEqual(["taskMenu:run:one#1", "taskMenu:run:one#1"]);
    calls.length = 0;
    // The visible trigger (owner 2026-11-13): the row-menu-btn idiom inside
    // the row, named, and opening the SAME menu without leaking into the
    // row's click-to-open.
    const kebab = root.querySelector(".subagent-row .row-menu-btn") as HTMLElement;
    expect(kebab.getAttribute("aria-label")).toBe("Subagent actions");
    kebab.click();
    expect(calls).toEqual(["taskMenu:run:one#1"]);
    calls.length = 0;
    // Enter/Space on the row open the transcript; a keydown that STARTED on
    // the kebab never double-activates the row (target guard, session idiom).
    expect(keyOn(row, "Enter")).toBe(false); // prevented
    expect(calls).toEqual(["openTask:run:one#1"]);
    calls.length = 0;
    kebab.dispatchEvent({
      type: "keydown",
      key: "Enter",
      target: kebab,
      currentTarget: row,
      preventDefault: () => {},
    } as unknown as Event);
    expect(calls).toEqual([]);
  });
});

// ── Session id display ─────────────────────────────────────────────────────
// Neither list's card markup renders the raw session id; it survives only in
// the data model, so card interactions must still route it to the handlers.

describe("session id display (both lists)", () => {
  it("no card text shows the full id, yet clicks still carry it", () => {
    const calls: string[] = [];
    const root = renderInteractive({ sessions: [liveSession()], logs: [coldLog()] }, calls);
    expect(root.querySelector(".row-id")).toBeNull();
    expect(root.textContent).not.toContain(FULL_ID);
    clickable(root, ".session-item").click();
    clickable(root, ".log-item").click();
    expect(calls).toEqual([`switch:${FULL_ID}`, `view:${FULL_ID}`]);
  });
});

// ── ContextMenu ─────────────────────────────────────────────────────────────

describe("ContextMenu", () => {
  it("renders each item once, marks the danger entry, routes clicks per item", () => {
    const calls: string[] = [];
    const host = document.createElement("div");
    app = mount(
      <ContextMenu
        menu={{
          x: 12,
          y: 34,
          items: [
            { label: "Open", onSelect: () => calls.push("open") },
            { label: "Delete", danger: true, onSelect: () => calls.push("delete") },
          ],
        }}
        rootRef={() => {}}
        onClose={() => {}}
      />,
      host as unknown as DomNode,
    );
    const items = Array.from(host.querySelectorAll(".context-menu-item")) as unknown as HTMLElement[];
    expect(items.map((n) => n.textContent)).toEqual(["Open", "Delete"]);
    expect(items[1]!.getAttribute("class")).toContain("context-menu-item-danger");
    expect(items[0]!.getAttribute("class")).not.toContain("danger");
    items[0]!.click();
    items[1]!.click();
    expect(calls).toEqual(["open", "delete"]);
  });

  it("keyboard: arrows cycle focus, Enter activates, Escape and Tab close (Tab un-prevented)", () => {
    const calls: string[] = [];
    let closes = 0;
    const host = document.createElement("div");
    app = mount(
      <ContextMenu
        menu={{
          x: 0,
          y: 0,
          items: [
            { label: "Open", onSelect: () => calls.push("open") },
            { label: "Copy", onSelect: () => calls.push("copy") },
          ],
        }}
        rootRef={() => {}}
        onClose={() => closes++}
      />,
      host as unknown as DomNode,
    );
    const menu = clickable(host, ".context-menu");
    const items = Array.from(host.querySelectorAll(".context-menu-item")) as unknown as HTMLElement[];
    expect(menu.getAttribute("role")).toBe("menu");
    expect(items.map((i) => i.getAttribute("role"))).toEqual(["menuitem", "menuitem"]);
    items[0]!.focus();
    expect(keyOn(menu, "ArrowDown")).toBe(false); // prevented
    expect(document.activeElement).toBe(items[1]!);
    expect(keyOn(items[1]!, "Enter")).toBe(false); // menuitems have no native activation
    expect(calls).toEqual(["copy"]);
    items[0]!.focus();
    expect(keyOn(menu, "Escape")).toBe(false);
    expect(closes).toBe(1);
    // Tab closes but is NOT prevented: WAI traversal must continue past the
    // dismissed menu (in-app, the close hands focus to the row first).
    items[1]!.focus();
    expect(keyOn(menu, "Tab")).toBe(true);
    expect(closes).toBe(2);
  });
});

// ── Pinned rows ─────────────────────────────────────────────────────────────
// Pinned ids are server-sourced (pin-store.ts via the list payload flags,
// applied in app.tsx); the Sidebar only sorts and badges: pinned rows lead
// their own section, relative order preserved on both sides, and the two
// sections never interleave.

describe("pinned row sorting", () => {
  it("sortPinned lifts pinned rows, keeps both groups' relative order", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(sortPinned(rows, new Set(["c"])).map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
    expect(sortPinned(rows, new Set(["d", "b"])).map((r) => r.id)).toEqual(["b", "d", "a", "c"]);
    // Empty pin set is the identity; the input array is not mutated.
    expect(sortPinned(rows, new Set()).map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
    expect(rows.map((r) => r.id)).toEqual(["a", "b", "c", "d"]);
  });

  it("pinned sessions lead #session-list and pinned logs lead #log-list, independently", () => {
    const s = (id: string): SessionInfo => ({ ...liveSession(), id });
    const l = (id: string): LogInfo => ({ ...coldLog(), id });
    // Cards display no ids anymore: row order is pinned through the click
    // handlers, which still carry the data-model id.
    const calls: string[] = [];
    const root = renderInteractive(
      { sessions: [s("s1"), s("s2"), s("s3")], logs: [l("l1"), l("l2"), l("l3")], pinned: new Set(["s3", "l1"]) },
      calls,
    );
    for (const row of root.querySelectorAll("#session-list .session-item")) {
      (row as unknown as HTMLElement).click();
    }
    for (const row of root.querySelectorAll("#log-list .log-item")) {
      (row as unknown as HTMLElement).click();
    }
    expect(calls).toEqual([
      "switch:s3",
      "switch:s1",
      "switch:s2",
      "view:l1",
      "view:l2",
      "view:l3",
    ]);
  });

  it("pinned rows carry the line-1 pin badge; unpinned rows do not", () => {
    const s = (id: string): SessionInfo => ({ ...liveSession(), id });
    const l = (id: string): LogInfo => ({ ...coldLog(), id });
    const root = render({
      sessions: [s("s1"), s("s2")],
      logs: [l("l1"), l("l2")],
      pinned: new Set(["s2", "l1"]),
    });
    const badgesIn = (sel: string) =>
      Array.from(root.querySelectorAll(sel)).map((row) =>
        Boolean(row.querySelector(".row-pin")),
      );
    // The badge follows the pin, not the position (s2 is pinned yet first;
    // l2 unpinned yet last).
    expect(badgesIn("#session-list .session-item")).toEqual([true, false]);
    expect(badgesIn("#log-list .log-item")).toEqual([true, false]);
  });
});

// ── Search panel ────────────────────────────────────────────────────────────
// The header magnifier swaps the two sidebar lists for a single search panel.
// The panel is presentational: it echoes the query into <mark> highlights and
// hands activations back to the app (live → switchSession, cold → viewLog).

function hit(o: Partial<SearchHitWire> & { logId: string }): SearchHitWire {
  return {
    logId: o.logId,
    lastActivityAt: o.lastActivityAt ?? STAMP,
    matchCount: o.matchCount ?? 1,
    live: o.live ?? false,
    snippets: o.snippets ?? [],
    ...(o.profile ? { profile: o.profile } : {}),
    ...(o.model ? { model: o.model } : {}),
  };
}

describe("search panel", () => {
  it("closed search shows the two lists and no panel", () => {
    const root = render({ sessions: [{ ...liveSession(), id: "s1" }], logs: [{ ...coldLog(), id: "l1" }] });
    expect(root.querySelector("#search-panel")).toBeNull();
    expect(root.querySelector("#session-list")).not.toBeNull();
    expect(root.querySelector("#log-list")).not.toBeNull();
    expect(root.querySelector("#search-btn")).not.toBeNull();
  });

  it("open search replaces both lists with the panel and marks the button active", () => {
    const root = render({ search: { open: true, query: "", pending: false, results: null } });
    expect(root.querySelector("#session-list")).toBeNull();
    expect(root.querySelector("#log-list")).toBeNull();
    expect(root.querySelector("#search-panel")).not.toBeNull();
    const cls = (root.querySelector("#search-btn") as HTMLElement).getAttribute("class") ?? "";
    expect(cls).toContain("active");
  });

  it("idle vs pending vs no-match statuses render distinct prompts", () => {
    const idle = render({ search: { open: true, query: "", pending: false, results: null } });
    expect(idle.querySelector(".search-status")?.textContent).toContain("Type to search");

    const pending = render({ search: { open: true, query: "needle", pending: true, results: null } });
    expect(pending.querySelector(".search-status")?.textContent).toContain("Searching");

    const empty = render({ search: { open: true, query: "needle", pending: false, results: [] } });
    expect(empty.querySelector(".search-status")?.textContent).toContain("No logs match");
  });

  it("renders a hit row per result with the match highlighted case-insensitively", () => {
    const root = render({
      search: {
        open: true,
        query: "bar",
        pending: false,
        results: [
          hit({ logId: "l1", profile: "owner", model: "m1", matchCount: 2, snippets: ["foo BAR baz", "a Bar b"] }),
          hit({ logId: "s9", live: true, matchCount: 1, snippets: ["no match text"] }),
        ],
      },
    });
    const rows = root.querySelectorAll(".search-hit");
    expect(rows.length).toBe(2);
    // Highlights ride every case-insensitive occurrence; the l1 row has two
    // snippets with one match each, the s9 row has none for its snippet.
    const marks1 = Array.from(rows[0]!.querySelectorAll(".search-mark")).map((m) => m.textContent);
    expect(marks1).toEqual(["BAR", "Bar"]);
    expect(rows[1]!.querySelectorAll(".search-mark").length).toBe(0);
    // live/cold scope tag distinguishes the attach verb for each hit.
    expect(rows[0]!.querySelector(".search-scope")?.textContent).toBe("log");
    expect(rows[1]!.querySelector(".search-scope-live")?.textContent).toBe("live");
  });

  it("magnifier, close, input and row activation route to the app handlers", () => {
    const calls: string[] = [];
    const root = renderInteractive(
      {
        search: { open: true, query: "", pending: false, results: [hit({ logId: "l1", snippets: ["x"] })] },
      },
      calls,
    );
    // Open panel already: the button click closes it.
    (root.querySelector("#search-btn") as unknown as HTMLElement).click();
    (root.querySelector("#search-clear") as unknown as HTMLElement).click();
    // Row click hands the hit back.
    (root.querySelector(".search-hit") as unknown as HTMLElement).click();
    // Typing routes the raw value (uncontrolled input) to onSearchQuery.
    const input = root.querySelector("#search-input") as HTMLElement;
    (input as unknown as { value: string }).value = "hello";
    input.dispatchEvent({ type: "input", currentTarget: input } as unknown as Event);
    expect(calls).toEqual(["closeSearch", "closeSearch", "activateHit:l1", "searchQuery:hello"]);
  });

  it("closed magnifier opens the panel", () => {
    const calls: string[] = [];
    const root = renderInteractive({}, calls);
    (root.querySelector("#search-btn") as unknown as HTMLElement).click();
    expect(calls).toEqual(["openSearch"]);
  });
});

// ── Search-activation scroll (owner QoL 2026-11-05) ────────────────────────

describe("scrollHitIntoView", () => {
  // Every sidebar row carries its id as data-sid so the app can find the row
  // a search hit names once the lists are re-mounted (raw id stays in the
  // attribute: the textContent pins above keep it out of visible text).
  it("rows carry data-sid on both lists", () => {
    const root = render({ sessions: [liveSession()], logs: [coldLog({ id: "log77" })] });
    expect(root.querySelector("#session-list [data-sid]")!.getAttribute("data-sid")).toBe(FULL_ID);
    expect(root.querySelector("#log-list [data-sid]")!.getAttribute("data-sid")).toBe("log77");
  });

  it("a live hit scrolls the session row; a cold hit the log row -- never the sibling", () => {
    // Same id on both sides: scope is the only thing that can disambiguate.
    const root = render({ sessions: [liveSession()], logs: [coldLog()] });
    const sRow = root.querySelector("#session-list .session-item")!;
    const lRow = root.querySelector("#log-list .log-item")!;
    const sc = sRow as unknown as { scrollIntoViewCalls: unknown[] };
    const lc = lRow as unknown as { scrollIntoViewCalls: unknown[] };

    scrollHitIntoView(root, true, FULL_ID);
    expect(sc.scrollIntoViewCalls).toEqual([{ block: "nearest" }]);
    expect(lc.scrollIntoViewCalls).toEqual([]);

    scrollHitIntoView(root, false, FULL_ID);
    expect(sc.scrollIntoViewCalls).toHaveLength(1); // no late cross-list hit
    expect(lc.scrollIntoViewCalls).toEqual([{ block: "nearest" }]);
  });

  it("a missing row is a silent no-op (session ended between search and click)", () => {
    const root = render({ sessions: [liveSession()] });
    expect(() => scrollHitIntoView(root, true, "gone")).not.toThrow();
    expect(() => scrollHitIntoView(root, false, "gone")).not.toThrow();
  });
});

describe("clampMenuAnchor", () => {
  // Pure geometry (the dom harness has no layout, so the menu call site in
  // app.tsx stays a measure+apply; every direction is pinned here).
  it("leaves a box that fits untouched", () => {
    expect(clampMenuAnchor(100, 200, 140, 90, 1280, 800)).toEqual({ left: 100, top: 200 });
  });

  it("nudges a bottom-edge anchor up so the whole box stays visible", () => {
    // Owner bug: a row low on screen put y near vh; the menu ran offscreen.
    expect(clampMenuAnchor(300, 780, 140, 200, 1280, 800)).toEqual({ left: 300, top: 592 });
  });

  it("nudges a right-edge anchor left", () => {
    expect(clampMenuAnchor(1240, 300, 200, 90, 1280, 800)).toEqual({ left: 1072, top: 300 });
  });

  it("clamps both axes together", () => {
    expect(clampMenuAnchor(1270, 790, 200, 220, 1280, 800)).toEqual({ left: 1072, top: 572 });
  });

  it("pins a box taller or wider than the viewport to the pad, never negative", () => {
    expect(clampMenuAnchor(640, 790, 200, 1600, 1280, 800)).toEqual({ left: 640, top: 8 });
    expect(clampMenuAnchor(1270, 400, 2000, 90, 1280, 800)).toEqual({ left: 8, top: 400 });
  });

  it("clamps a negative or zero anchor back to the pad (zero-rect fallback)", () => {
    expect(clampMenuAnchor(0, 0, 140, 90, 1280, 800)).toEqual({ left: 8, top: 8 });
    expect(clampMenuAnchor(-50, -40, 140, 90, 1280, 800)).toEqual({ left: 8, top: 8 });
  });

  it("honors a custom pad", () => {
    expect(clampMenuAnchor(300, 795, 140, 90, 1280, 800, 20)).toEqual({ left: 300, top: 690 });
  });
});

// ── Cold-row Subagents section (restart-survivor lineage) ───────────────────
// The sidecar-rebuilt lineage nests under the COLD manager row in the same
// section grammar the live cards use. Rows ride durable:true with honest
// interrupted/completed badges and frozen clocks (they never tick). A durable
// row opens only when the sidecar recorded the worker key; a log WITHOUT
// lineage renders no section at all (the unchanged absence).

const durableRow = (over: Partial<TaskInfoWire> & { taskId: string }): TaskInfoWire => ({
  description: `task ${over.taskId}`,
  sessionId: "cold-mgr",
  status: "interrupted",
  createdAt: STAMP - 300_000,
  startedAt: null,
  endedAt: null,
  activeMs: 90_000,
  inRun: false,
  turnStartedAt: null,
  durable: true,
  ...over,
});

describe("Cold-row Subagents section", () => {
  it("a cold manager with lineage nests the same section; a log without lineage renders none", () => {
    const root = render({
      logs: [
        coldLog({
          id: "cold-mgr",
          subagents: [
            durableRow({ taskId: "run:one#1" }),
            durableRow({
              taskId: "run:two#2",
              status: "completed",
              createdAt: STAMP - 100_000,
              endedAt: STAMP - 60_000,
              agentSessionId: "worker-a",
            }),
          ],
        }),
        coldLog({ id: "plain-cold" }),
      ],
      now: STAMP,
    });
    // Exactly one section: only the row WITH lineage gets one.
    expect(root.querySelectorAll("#log-list .subagents-section")).toHaveLength(1);
    const rows = root.querySelectorAll("#log-list .subagent-row");
    expect(rows).toHaveLength(2);
    // All-durable lists are settled: newest-first (the section's own sort).
    expect(Array.from(rows).map((r) => r.getAttribute("data-task-id"))).toEqual([
      "run:two#2",
      "run:one#1",
    ]);
    // The interrupted row: status class, its own broken-ring glyph, the FROZEN
    // sidecar clock (activeMs, no live tick), and the honest status word.
    const interrupted = rows[1]!;
    expect(interrupted.getAttribute("class")).toContain("status-interrupted");
    expect(interrupted.querySelector("svg")!.getAttribute("class")).toContain("subagent-glyph-interrupted");
    expect(interrupted.querySelector(".subagent-row-elapsed")!.textContent).toBe("1m 30s");
    expect(interrupted.getAttribute("title")).toContain("interrupted");
    // The completed row keeps its recorded outcome as its badge.
    expect(rows[0]!.getAttribute("class")).toContain("status-completed");
    // The disclosure anchors on the log id (the live cards' grammar).
    expect(root.querySelector("#subagent-list-cold-mgr")).toBeTruthy();
    // The cold rows themselves are untouched: both stay plain selectable rows.
    expect(root.querySelectorAll(".log-item")).toHaveLength(2);
  });

  it("collapses with the shared flag like every other section", () => {
    const root = render({
      logs: [coldLog({ id: "cold-mgr", subagents: [durableRow({ taskId: "run:one#1" })] })],
      subagentsCollapsed: true,
    });
    expect(root.querySelector(".subagents-section")!.getAttribute("class")).toContain("collapsed");
    // Hidden, not unmounted: the list keeps its slot (the live idiom).
    expect(root.querySelector("#subagent-list-cold-mgr")).toBeTruthy();
  });

  it("durable rows route clicks to openTask; one WITHOUT a worker key stays inert", () => {
    const calls: string[] = [];
    const root = renderInteractive(
      {
        logs: [
          coldLog({
            id: "cold-mgr",
            subagents: [
              durableRow({ taskId: "joined#1", agentSessionId: "worker-a" }),
              durableRow({ taskId: "prejoin#2", createdAt: STAMP - 400_000 }),
            ],
          }),
        ],
      },
      calls,
    );
    const rows = root.querySelectorAll(".subagent-row");
    expect(rows).toHaveLength(2);
    (rows[0] as HTMLElement).click();
    expect(calls).toEqual(["openTask:joined#1"]);
    // A pre-join record (no transcript key): the click does nothing, Enter is
    // swallowed, and the title says why; the row keeps its menu (the kebab
    // still reaches the task context menu with its honest items).
    (rows[1] as HTMLElement).click();
    expect(calls).toHaveLength(1);
    expect(keyOn(rows[1]!, "Enter")).toBe(false); // prevented, never forwarded
    expect(calls).toHaveLength(1);
    expect(rows[1]!.getAttribute("title")).toContain("transcript not on record");
    expect(rows[0]!.getAttribute("title")).not.toContain("transcript not on record");
    (rows[1]!.querySelector(".row-menu-btn") as HTMLElement).click();
    expect(calls).toEqual(["openTask:joined#1", "taskMenu:prejoin#2"]);
  });
});
