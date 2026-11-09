// Sidebar row grammar (shared by live sessions and cold logs), pinned on the
// owner's fixture row:
//
//   manager · ai365/qwen3.8-flash-next    working            Stop
//   2026-10-31 22:30 · 69k/262k · 42 msgs   [plug]
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

import { describe, it, expect, afterEach } from "bun:test";
import {
  Sidebar,
  ContextMenu,
  formatDateTime,
  scrollHitIntoView,
  sortPinned,
  type SessionInfo,
  type LogInfo,
  type SearchState,
} from "@extensions/webui/ui/sessions.tsx";
import type { SearchHitWire } from "@extensions/websocket/protocol.ts";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

// ── Fixture + harness ───────────────────────────────────────────────────────

// Local-time constructor: the expected stamp holds in any TZ.
const STAMP = new Date(2026, 9, 31, 22, 30).getTime();
const FULL_ID = "2s34e9825faaf89878923598";

const noop = (): void => {};

// Search closed by default; individual search tests override `search`.
const CLOSED_SEARCH = { open: false, query: "", pending: false, results: null } as const;

function mountSidebar(container: Element, opts: { sessions?: SessionInfo[]; logs?: LogInfo[]; working?: Map<string, boolean>; pinned?: Set<string>; search?: SearchState; logsCollapsed?: boolean }): Mounted {
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
      logsCollapsed={opts.logsCollapsed ?? false}
      logsHeight={240}
      logsMin={96}
      logsMax={450}
      onCreate={noop}
      onSwitch={noop}
      onCancel={noop}
      onContinueLog={noop}
      onViewLog={noop}
      onSessionMenu={noop}
      onLogMenu={noop}
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
    // line 3 (the glyph itself lives in a CSS mask, so no DOM text at 1
    // client; tooltip on the native title). aria-hidden decoration: a glyph
    // is not a stop on the way to the row's controls. Never a text metric,
    // and no row text ever mentions clients.
    const plug = row.querySelector(".row-clients")!;
    expect(plug).toBeTruthy();
    expect(plug.textContent).toBe("");
    expect(plug.getAttribute("title")).toBe("1 client connected");
    expect(plug.getAttribute("tabindex")).toBeNull();
    expect(plug.getAttribute("aria-hidden")).toBe("true");
    expect(row.textContent).not.toContain("client");

    expect(row.querySelector(".row-date")!.textContent).toBe("2026-10-31 22:30");
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
    expect(asked.querySelector(".row-glyph-awaiting_question")).toBeTruthy();
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
  it("renders model/status/ctx/msgs + Resume, and never a client segment", () => {
    const root = render({ logs: [coldLog({ state: "interrupted" })] });
    const row = root.querySelector(".log-item")!;
    expect(row.querySelector(".row-model")!.textContent).toBe("ai365/qwen3.8-flash-next");
    const status = row.querySelector(".row-status")!;
    expect(status.getAttribute("title")).toBe("Interrupted");
    expect(status.querySelector(".row-glyph-interrupted")).toBeTruthy();
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
    const cont = row.querySelector(".log-continue-btn")!;
    expect(cont.textContent).toBe("Resume");
    // Resume sits in the right-pinned action slot, no sep precedes it.
    expect(row.querySelector(".row-action .log-continue-btn")).toBeTruthy();
    expect(row.querySelector(".row-action")!.classList.contains("row-action-right")).toBe(true);
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
    expect(status.querySelector(".row-glyph-awaiting_question")).toBeTruthy();
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
    // Resume (the log's own action) still renders, right-pinned; line 1
    // holds no dots at all now (and never did when model/status are absent).
    expect(row.querySelector(".log-continue-btn")).toBeTruthy();
    const l1 = row.querySelector(".row-l1")!;
    expect(l1.querySelectorAll(".row-sep")).toHaveLength(0);
    // Bottom row: no ctx attestation, so that segment omits -- date · msgs.
    expect(row.querySelector(".row-date")!.textContent).toBe("2026-10-31 22:30");
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
  it("pads to YYYY-MM-DD HH:MM in local time", () => {
    expect(formatDateTime(new Date(2026, 0, 5, 9, 7).getTime())).toBe("2026-01-05 09:07");
    expect(formatDateTime(STAMP)).toBe("2026-10-31 22:30");
  });
});

// ── Row interactions (handler wiring) ───────────────────────────────────────
// The grammar above is only as good as its routing: each slot must reach
// exactly the handler that owns it, and inner actions (Stop/Resume) must
// not leak through to the row's select -- stopPropagation is the pin here.

function mountInteractive(
  container: Element,
  opts: { sessions?: SessionInfo[]; logs?: LogInfo[]; working?: Map<string, boolean>; pinned?: Set<string>; search?: SearchState; activeSessionId?: string | null; activeLogId?: string | null },
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
      logsCollapsed={false}
      logsHeight={240}
      logsMin={96}
      logsMax={450}
      onCreate={() => calls.push("create")}
      onSwitch={(id) => calls.push(`switch:${id}`)}
      onCancel={(id) => calls.push(`cancel:${id}`)}
      onContinueLog={(id) => calls.push(`continue:${id}`)}
      onViewLog={(id) => calls.push(`view:${id}`)}
      onSessionMenu={(_e, s) => calls.push(`sessionMenu:${s.id}`)}
      onLogMenu={(_e, id) => calls.push(`logMenu:${id}`)}
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

  it("Resume on a log row resumes it without opening the log", () => {
    const calls: string[] = [];
    const root = renderInteractive({ logs: [coldLog()] }, calls);
    clickable(root, ".log-continue-btn").click();
    expect(calls).toEqual([`continue:${FULL_ID}`]);
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
    expect(root.querySelector(".logs-toggle-glyph")!.getAttribute("class")).not.toContain("-up");
    expect(root.querySelector(".logs-toggle-glyph")!.getAttribute("aria-hidden")).toBe("true");
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
    expect(root.querySelector(".logs-toggle-glyph")!.getAttribute("class")).toContain("logs-toggle-glyph-up");
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
    clickable(root, ".log-continue-btn").click();
    expect(calls).toEqual([`switch:${FULL_ID}`, `view:${FULL_ID}`, `continue:${FULL_ID}`]);
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
