// Sidebar row grammar (shared by live sessions and cold logs), pinned on the
// owner's fixture row:
//
//   ai365/qwen3.8-flash-next    working            Cancel
//   manager 69k/262k . 42 msgs . 1 client
//   2026-10-31 22:30 . 2s34e9825faaf89878923598
//
// No literal parens: status is a text badge, profile quiet muted text, and
// the line-1 action pins right (row-action-right) with no separator before
// it. Segments that have no data are omitted outright -- the legacy-log pins
// watch for "undefined"/"null" leakage into rendered text.

import { describe, it, expect, afterEach } from "bun:test";
import {
  Sidebar,
  formatDateTime,
  type SessionInfo,
  type LogInfo,
} from "@extensions/webui/ui/sessions.tsx";
import { mount, type DomNode, type Mounted } from "@utils/jsx";

// ── Fixture + harness ───────────────────────────────────────────────────────

// Local-time constructor: the expected stamp holds in any TZ.
const STAMP = new Date(2026, 9, 31, 22, 30).getTime();
const FULL_ID = "2s34e9825faaf89878923598";

const noop = (): void => {};

function mountSidebar(container: Element, opts: { sessions?: SessionInfo[]; logs?: LogInfo[]; working?: Map<string, boolean> }): Mounted {
  return mount(
    <Sidebar
      sessions={opts.sessions ?? []}
      activeSessionId={null}
      workingMap={opts.working ?? new Map()}
      logs={opts.logs ?? []}
      activeLogId={null}
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
    const metrics = texts(row, ".row-metric");
    expect(metrics).toEqual(["69k/262k", "42 msgs", "1 client"]);

    expect(row.querySelector(".row-date")!.textContent).toBe("2026-10-31 22:30");
    // Full id, no shortening.
    expect(row.querySelector(".row-id")!.textContent).toBe(FULL_ID);

    // Separators: line 2 (two) + line 3 (one); line 1 dots are gone.
    expect(row.querySelectorAll(".row-sep")).toHaveLength(3);
  });

  it("working row carries the Cancel action; idle row renders idle without one", () => {
    const root = render({ sessions: [liveSession()], working: new Map() });
    const row = root.querySelector(".session-item")!;
    expect(row.querySelector(".row-status")!.textContent).toBe("idle");
    expect(row.querySelector(".session-cancel-btn")).toBeNull();
    expect(row.querySelector(".session-spinner")).toBeNull();
    // No action slot: line 1 never had a dot here; line2 x2 + line3.
    expect(row.querySelectorAll(".row-sep")).toHaveLength(3);
  });

  it("an explicit title wins the profile slot", () => {
    const root = render({ sessions: [liveSession({ title: "renamed" })] });
    expect(root.querySelector(".row-profile")!.textContent).toBe("renamed");
  });

  it("client segment pluralizes and vanishes at zero", () => {
    const root = render({ sessions: [liveSession({ connectedClients: 2 }), liveSession({ id: "s2", connectedClients: 0 })] });
    const rows = root.querySelectorAll(".session-item");
    expect(texts(rows[0]!, ".row-metric")).toContain("2 clients");
    const metrics2 = texts(rows[1]!, ".row-metric");
    expect(metrics2).not.toContain("0 clients");
    expect(metrics2).toContain("42 msgs");
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
    const cont = row.querySelector(".log-continue-btn")!;
    expect(cont.textContent).toBe("Continue");
    // Continue sits in the right-pinned action slot, no sep precedes it.
    expect(row.querySelector(".row-action .log-continue-btn")).toBeTruthy();
    expect(row.querySelector(".row-action")!.classList.contains("row-action-right")).toBe(true);
    expect(row.textContent).not.toContain("client");
    expect(row.querySelector(".session-cancel-btn")).toBeNull();
  });

  it("idle (and missing) states omit the status segment", () => {
    const root = render({ logs: [coldLog({ id: "a", state: "idle" }), coldLog({ id: "b", state: undefined })] });
    const rows = root.querySelectorAll(".log-item");
    for (const row of rows) expect(row.querySelector(".row-status")).toBeNull();
    // No status: line 1 has no dots (action pins right), line 2 one dot
    // (ctx . msgs), line 3 one dot.
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
    // ctx absent: only the msgs metric remains, and it carries no leading dot.
    expect(texts(row, ".row-metric")).toEqual(["42 msgs"]);
    // Continue (the log's own action) still renders, right-pinned; line 1
    // holds no dots at all now (and never did when model/status are absent).
    expect(row.querySelector(".log-continue-btn")).toBeTruthy();
    const l1 = row.querySelector(".row-l1")!;
    expect(l1.querySelectorAll(".row-sep")).toHaveLength(0);
    // Line 3 still holds: date . full id.
    expect(row.querySelector(".row-date")!.textContent).toBe("2026-10-31 22:30");
    expect(row.querySelector(".row-id")!.textContent).toBe(FULL_ID);
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
