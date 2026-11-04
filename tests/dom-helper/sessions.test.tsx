// Sidebar row grammar (shared by live sessions and cold logs), pinned on the
// owner's fixture row:
//
//   ai365/qwen3.8-flash-next    working            Cancel
//   manager
//   2026-10-31 22:30 . 69k/262k . 42 msgs   [plug]
//
// No literal parens: status is a text badge, profile quiet muted text, and
// the line-1 action pins right (row-action-right) with no separator before
// it. The connected-client count shows as the plug icon trailing line 3 --
// the card's bottom-right (icon + number for 2+, icon only for 1, nothing
// at 0/unattested; tooltip via the native title) -- never a text metric, so
// row text must never read "client(s)". The raw session id renders nowhere
// -- the data model keeps it as the selection key. Segments that have no
// data are omitted outright; the legacy-log pins watch for
// "undefined"/"null" leakage into rendered text.

import { describe, it, expect, afterEach } from "bun:test";
import {
  Sidebar,
  ContextMenu,
  formatDateTime,
  sortPinned,
  type SessionInfo,
  type LogInfo,
} from "@extensions/webui/ui/sessions.tsx";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

// ── Fixture + harness ───────────────────────────────────────────────────────

// Local-time constructor: the expected stamp holds in any TZ.
const STAMP = new Date(2026, 9, 31, 22, 30).getTime();
const FULL_ID = "2s34e9825faaf89878923598";

const noop = (): void => {};

function mountSidebar(container: Element, opts: { sessions?: SessionInfo[]; logs?: LogInfo[]; working?: Map<string, boolean>; pinned?: Set<string> }): Mounted {
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
      onCreate={noop}
      onSwitch={noop}
      onCancel={noop}
      onContinueLog={noop}
      onViewLog={noop}
      onSessionMenu={noop}
      onLogMenu={noop}
      onResizeStart={noop}
      onResizeMove={noop}
      onResizeEnd={noop}
      onResizeKey={noop}
      onResizeReset={noop}
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
    userMessageCount: 42,
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
  it("renders all three grammar lines with the dot separators", () => {
    const root = render({ sessions: [liveSession()], working: new Map([[FULL_ID, true]]) });
    const row = root.querySelector(".session-item")!;
    expect(row).toBeTruthy();

    expect(row.querySelector(".row-model")!.textContent).toBe("ai365/qwen3.8-flash-next");
    expect(row.querySelector(".row-status")!.textContent).toBe("working");
    expect(row.querySelector(".session-spinner")).toBeTruthy();
    const cancel = row.querySelector(".session-cancel-btn")!;
    expect(cancel.textContent).toBe("Cancel");

    // Action pins right and trails every other line-1 slot; no sep precedes it.
    const action = row.querySelector(".row-action")!;
    expect(action.classList.contains("row-action-right")).toBe(true);
    const l1Kids = row.querySelector(".row-l1")!.children;
    expect(l1Kids[l1Kids.length - 1]).toBe(action);
    expect(row.querySelectorAll(".row-l1 .row-sep")).toHaveLength(0);

    expect(row.querySelector(".row-profile")!.textContent).toBe("manager");
    // The client count rides the card's bottom-right as a plug icon, trailing
    // line 3 (the glyph itself lives in a CSS mask, so no DOM text at 1
    // client; tooltip on the native title, focusable like other title
    // carriers). Never a text metric, and no row text ever mentions clients.
    const plug = row.querySelector(".row-clients")!;
    expect(plug).toBeTruthy();
    expect(plug.textContent).toBe("");
    expect(plug.getAttribute("title")).toBe("1 client connected");
    expect(plug.getAttribute("tabindex")).toBe("0");
    expect(row.textContent).not.toContain("client");

    expect(row.querySelector(".row-date")!.textContent).toBe("2026-10-31 22:30");
    // Bottom row: date . ctx . msgs [plug] -- the plug trails line 3 (the
    // bottom-right corner is CSS: margin-left:auto, the row-action-right
    // idiom), in that order.
    const l3 = row.querySelector(".row-l3")!;
    expect(l3.children[l3.children.length - 1]).toBe(plug);
    expect([...l3.children].map((n) => n.className)).toEqual([
      "row-date",
      "row-sep",
      "row-metric",
      "row-sep",
      "row-metric",
      "row-clients",
    ]);
    expect(texts(l3, ".row-metric")).toEqual(["69k/262k", "42 msgs"]);

    // The raw id renders nowhere (it stays the selection key; see the id-
    // display section for the round trip through the click handler).
    expect(row.querySelector(".row-id")).toBeNull();
    expect(row.textContent).not.toContain(FULL_ID);

    // Separators: the two bottom-row dots; lines 1-2 are dot-free.
    expect(row.querySelectorAll(".row-sep")).toHaveLength(2);
  });

  it("working row carries the Cancel action; idle row renders idle without one", () => {
    const root = render({ sessions: [liveSession()], working: new Map() });
    const row = root.querySelector(".session-item")!;
    expect(row.querySelector(".row-status")!.textContent).toBe("idle");
    expect(row.querySelector(".session-cancel-btn")).toBeNull();
    expect(row.querySelector(".session-spinner")).toBeNull();
    // No action slot: line 1 never had a dot here; the two bottom-row dots.
    expect(row.querySelectorAll(".row-sep")).toHaveLength(2);
  });

  it("an explicit title wins the profile slot", () => {
    const root = render({ sessions: [liveSession({ title: "renamed" })] });
    expect(root.querySelector(".row-profile")!.textContent).toBe("renamed");
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
  it("renders model/status/ctx/msgs + Continue, and never a client segment", () => {
    const root = render({ logs: [coldLog({ state: "interrupted" })] });
    const row = root.querySelector(".log-item")!;
    expect(row.querySelector(".row-model")!.textContent).toBe("ai365/qwen3.8-flash-next");
    expect(row.querySelector(".row-status")!.textContent).toBe("interrupted");
    expect(row.querySelector(".row-profile")!.textContent).toBe("manager");
    expect(texts(row, ".row-metric")).toEqual(["69k/262k", "42 msgs"]);
    // Same bottom-row grammar as the live list: date . ctx . msgs.
    expect([...row.querySelector(".row-l3")!.children].map((n) => n.className)).toEqual([
      "row-date",
      "row-sep",
      "row-metric",
      "row-sep",
      "row-metric",
    ]);
    expect(row.querySelector(".row-id")).toBeNull();
    expect(row.textContent).not.toContain(FULL_ID);
    const cont = row.querySelector(".log-continue-btn")!;
    expect(cont.textContent).toBe("Continue");
    // Continue sits in the right-pinned action slot, no sep precedes it.
    expect(row.querySelector(".row-action .log-continue-btn")).toBeTruthy();
    expect(row.querySelector(".row-action")!.classList.contains("row-action-right")).toBe(true);
    expect(row.textContent).not.toContain("client");
    expect(row.querySelector(".row-clients")).toBeNull();
    expect(row.querySelector(".session-cancel-btn")).toBeNull();
  });

  it("idle (and missing) states omit the status segment", () => {
    const root = render({ logs: [coldLog({ id: "a", state: "idle" }), coldLog({ id: "b", state: undefined })] });
    const rows = root.querySelectorAll(".log-item");
    for (const row of rows) expect(row.querySelector(".row-status")).toBeNull();
    // No status: lines 1-2 hold no dots (action pins right, no client slot),
    // the bottom row carries both (date . ctx . msgs).
    expect(rows[0]!.querySelectorAll(".row-sep")).toHaveLength(2);
  });

  it("state text underscores become spaces and the state class colors the slot", () => {
    const root = render({ logs: [coldLog({ state: "awaiting_question" })] });
    const status = root.querySelector(".row-status")!;
    expect(status.textContent).toBe("awaiting question");
    expect(status.className).toContain("log-state-awaiting_question");
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
    // Continue (the log's own action) still renders, right-pinned; line 1
    // holds no dots at all now (and never did when model/status are absent).
    expect(row.querySelector(".log-continue-btn")).toBeTruthy();
    const l1 = row.querySelector(".row-l1")!;
    expect(l1.querySelectorAll(".row-sep")).toHaveLength(0);
    // Bottom row: no ctx attestation, so that segment omits -- date . msgs.
    expect(row.querySelector(".row-date")!.textContent).toBe("2026-10-31 22:30");
    expect([...row.querySelector(".row-l3")!.children].map((n) => n.className)).toEqual([
      "row-date",
      "row-sep",
      "row-metric",
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
// exactly the handler that owns it, and inner actions (Cancel/Continue) must
// not leak through to the row's select -- stopPropagation is the pin here.

function mountInteractive(
  container: Element,
  opts: { sessions?: SessionInfo[]; logs?: LogInfo[]; working?: Map<string, boolean>; pinned?: Set<string> },
  calls: string[],
): Mounted {
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
      onCreate={() => calls.push("create")}
      onSwitch={(id) => calls.push(`switch:${id}`)}
      onCancel={(id) => calls.push(`cancel:${id}`)}
      onContinueLog={(id) => calls.push(`continue:${id}`)}
      onViewLog={(id) => calls.push(`view:${id}`)}
      onSessionMenu={(_e, s) => calls.push(`sessionMenu:${s.id}`)}
      onLogMenu={(_e, id) => calls.push(`logMenu:${id}`)}
      onResizeStart={noop}
      onResizeMove={noop}
      onResizeEnd={noop}
      onResizeKey={noop}
      onResizeReset={noop}
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

  it("Cancel on a working row cancels it without also switching", () => {
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

  it("Continue on a log row resumes it without opening the log", () => {
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
