/// <reference lib="dom" />
// Log-view mode round trip on the real app wiring (app.tsx mounted on the
// dom-helper DOM with a FakeWebSocket standing in for the server).
//
// Owner-reported bug: with a live session attached, viewing a recent log
// works, but clicking the live session's own sidebar row afterwards is a
// no-op -- the view stays stuck on the log. The sidebar refresh that entering
// log view itself triggers (listSessions) used to drop the display pointer
// whenever any session was attached (the client stays attached while browsing
// a log), which then made the live-row click read "same session, nothing to
// do". Every scenario below therefore fires the full reply set the server
// sends, poison message included.

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { FakeWebSocket } from "./index.ts";

const SID = "s-live-0001";
const L1 = "l-log-0001";
const L2 = "l-log-0002";

// ── Browser env for app.tsx's init() (install before the import) ────────────

const g = globalThis as Record<string, unknown>;
// Serial mode shares one process across files: these stubs must not outlive
// this suite or every later fetch/WebSocket test inherits them.
const prev = { localStorage: g.localStorage, WebSocket: g.WebSocket, fetch: g.fetch };
const store = new Map<string, string>([["hotdog-webui-token", "tok"]]);
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
g.WebSocket = FakeWebSocket;
g.fetch = async () => ({ status: 200, ok: true, json: async () => ({}) }) as Response;

afterAll(() => {
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
});

const appEl = document.createElement("div");
// DElement has no `id` property proxy; the attribute is what getElementById reads.
appEl.setAttribute("id", "app");
document.body.appendChild(appEl);

let ws: FakeWebSocket;

/** Flush the coalesced render (queueMicrotask) plus any stubbed fetch ticks. */
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

const sentTypes = (): string[] => ws.sent.map((s) => String((JSON.parse(s) as { type: string }).type));
// The dom-helper implements the extra surface (click()); the lib-dom types only
// carry it on HTMLElement.
const el = (sel: string): HTMLElement => document.querySelector(sel) as unknown as HTMLElement;
const els = (sel: string): HTMLElement[] =>
  Array.from(document.querySelectorAll(sel)) as unknown as HTMLElement[];
const composerDisabled = () => el("#chat-input").hasAttribute("disabled");
const activeRows = (sel: string) => els(`${sel}.active`);

const sessionRow = {
  id: SID,
  profile: "manager",
  title: null,
  model: "m1",
  createdAt: 1,
  lastActivityAt: 2,
  connectedClients: 1,
  userMessageCount: 3,
};
const logRow = (id: string) => ({ id, createdAt: 1, lastActivityAt: 2, messageCount: 5 });

/** The sidebar replies every log-view enter/leave triggers (listLogs +
 *  listSessions). The sessions reply is what used to kill log view. */
function fireSidebarReplies(): void {
  ws.fireMessage({ type: "logsListed", logs: [logRow(L1), logRow(L2)] });
  ws.fireMessage({ type: "sessions", sessions: [sessionRow] });
}

/** A (re-)attach burst as the server sends it: sessionCreated, replay,
 *  cursor, then the sidebar/profile replies the client's handler asks for. */
function fireAttachBurst(userLine: string): void {
  ws.fireMessage({
    type: "sessionCreated",
    sessionId: SID,
    profile: "manager",
    title: null,
    currentModel: "m1",
    models: ["m1"],
  });
  ws.fireMessage({ type: "userMessage", content: userLine });
  ws.fireMessage({ type: "sessionState", sessionId: SID, key: "cursor", value: 7 });
  fireSidebarReplies();
  ws.fireMessage({ type: "profiles", profiles: { manager: { body: "", model: null } } });
}

function viewLog(logId: string, text: string): void {
  const idx = logId === L1 ? 0 : 1;
  els(".log-item")[idx]!.click();
  ws.fireMessage({ type: "logViewed", logId, entries: [{ source: "prompt", content: text }] });
  fireSidebarReplies();
}

describe("webui log-view round trip (real app wiring)", () => {
  beforeAll(async () => {
    await import("@extensions/webui/ui/app.tsx");
    await tick();
    ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.fireOpen();
    ws.fireMessage({ type: "authOk" });
    fireAttachBurst("live hello");
    await tick();
  });

  it("attached live session: composer enabled, live row highlighted, no log label", () => {
    expect(composerDisabled()).toBe(false);
    expect(activeRows(".session-item")).toHaveLength(1);
    expect(activeRows(".log-item")).toHaveLength(0);
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(el("#message-list").textContent).toContain("live hello");
  });

  it("viewing a log stays in log view across the sidebar refresh it triggers", async () => {
    viewLog(L1, "L1 cold line");
    await tick();
    expect(composerDisabled()).toBe(true);
    expect(el("#log-view-label")).toBeTruthy();
    expect(activeRows(".log-item")).toHaveLength(1);
    expect(activeRows(".log-item")[0]!.textContent).toContain(L1);
    expect(el("#message-list").textContent).toContain("L1 cold line");
  });

  it("clicking the live session row while viewing a log exits log view and re-attaches", async () => {
    // Re-enter log view so this scenario stands on its own.
    viewLog(L1, "L1 cold line");
    await tick();
    ws.sent.length = 0;
    el(".session-item").click();
    // The bug: the click was a no-op -- nothing reached the socket.
    expect(sentTypes()).toContain("switchSession");
    // The server answers a switch-to-same-session with a full re-attach.
    fireAttachBurst("live hello 2");
    await tick();
    expect(composerDisabled()).toBe(false);
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(activeRows(".log-item")).toHaveLength(0);
    expect(activeRows(".session-item")).toHaveLength(1);
    const list = el("#message-list").textContent!;
    expect(list).toContain("live hello 2");
    expect(list).not.toContain("L1 cold line");
  });

  it("log -> another log switches transcripts and stays in log view", async () => {
    viewLog(L1, "L1 cold line");
    await tick();
    ws.sent.length = 0;
    viewLog(L2, "L2 cold line");
    await tick();
    expect(sentTypes()).toContain("viewLog");
    expect(composerDisabled()).toBe(true);
    expect(activeRows(".log-item")).toHaveLength(1);
    expect(activeRows(".log-item")[0]!.textContent).toContain(L2);
    const list = el("#message-list").textContent!;
    expect(list).toContain("L2 cold line");
    expect(list).not.toContain("L1 cold line");
  });

  it("clicking the log row already being viewed re-renders it idempotently", async () => {
    ws.sent.length = 0;
    viewLog(L2, "L2 cold line");
    await tick();
    expect(sentTypes()).toContain("viewLog");
    expect(sentTypes()).not.toContain("switchSession");
    expect(composerDisabled()).toBe(true);
    expect(activeRows(".log-item")).toHaveLength(1);
    expect(activeRows(".log-item")[0]!.textContent).toContain(L2);
  });


  it("the close-log-view button still returns to the live session", async () => {
    ws.sent.length = 0;
    el("#close-log-view-btn").click();
    expect(sentTypes()).toContain("switchSession");
    fireAttachBurst("live hello 3");
    await tick();
    expect(composerDisabled()).toBe(false);
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(el("#message-list").textContent).toContain("live hello 3");
  });

  it("clicking a DIFFERENT live session row while viewing a log switches to it", async () => {
    // Re-enter log view, then leave for another (not the attached) session:
    // the sidebar must re-highlight the new session and log view must clear,
    // exactly like a live->live switch.
    viewLog(L1, "L1 cold line");
    await tick();
    expect(composerDisabled()).toBe(true);

    const OTHER = "s-live-0002";
    const otherRow = { ...sessionRow, id: OTHER, profile: "other", userMessageCount: 1 };
    ws.fireMessage({ type: "sessions", sessions: [sessionRow, otherRow] });
    await tick();
    ws.sent.length = 0;
    els(".session-item")[1]!.click();
    const sw = ws.sent
      .map((m) => JSON.parse(m) as { type: string; sessionId?: string })
      .find((m) => m.type === "switchSession");
    expect(sw?.sessionId).toBe(OTHER);

    ws.fireMessage({
      type: "sessionCreated",
      sessionId: OTHER,
      profile: "other",
      title: null,
      currentModel: "m1",
      models: ["m1"],
    });
    ws.fireMessage({ type: "userMessage", content: "other session line" });
    ws.fireMessage({ type: "sessionState", sessionId: OTHER, key: "cursor", value: 2 });
    ws.fireMessage({ type: "sessions", sessions: [sessionRow, otherRow] });
    ws.fireMessage({ type: "logsListed", logs: [logRow(L1), logRow(L2)] });
    await tick();
    expect(composerDisabled()).toBe(false);
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(activeRows(".session-item")).toHaveLength(1);
    expect(activeRows(".session-item")[0]!.textContent).toContain(OTHER);
    const list = el("#message-list").textContent!;
    expect(list).toContain("other session line");
    expect(list).not.toContain("L1 cold line");
  });
});
