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

// Owner-ruled 2026-10-31: Cancel lives in the composer action row immediately
// left of Send, carrying the spinner; there is no standalone working row.
// Pinned here on the real app wiring.
describe("working state: spinnered composer Cancel (real app wiring)", () => {
  beforeAll(async () => {
    // Land on a known live session regardless of the previous suite's exit state.
    fireAttachBurst("working hello");
    await tick();
    expect(composerDisabled()).toBe(false);
  });

  const composerButtonIds = (): (string | null)[] =>
    Array.from(el("#composer-actions").children).map((c) => c.getAttribute("id"));

  it("idle: no indicator, no Cancel in the composer", () => {
    expect(document.querySelector("#working-indicator")).toBeNull();
    expect(document.querySelector("#cancel-btn")).toBeNull();
  });

  it("working: Cancel (carrying the spinner) sits inside #composer-actions left of Send", async () => {
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();

    // The standalone working row is gone; the busy tell is the button itself.
    expect(document.querySelector("#working-indicator")).toBeNull();
    const cancel = el("#composer-actions #cancel-btn");
    expect(cancel.querySelector(".spinner")).toBeTruthy();
    expect(cancel.textContent).toContain("Cancel");
    const ids = composerButtonIds();
    const cancelAt = ids.indexOf("cancel-btn");
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(ids[cancelAt + 1]).toBe("send-btn");
  });

  it("clicking Cancel sends {type:cancel} and drops the button", async () => {
    ws.sent.length = 0;
    el("#cancel-btn").click();
    const cancelMsg = ws.sent
      .map((m) => JSON.parse(m) as { type: string; sessionId?: string })
      .find((m) => m.type === "cancel");
    expect(cancelMsg?.sessionId).toBe(SID);
    await tick();
    expect(document.querySelector("#working-indicator")).toBeNull();
    expect(document.querySelector("#cancel-btn")).toBeNull();
    // Send keeps its slot as the row's last control with Cancel gone.
    const ids = composerButtonIds();
    expect(ids[ids.length - 1]).toBe("send-btn");
  });
});

// Header-strip fence toggle (real app wiring). Worker postures ("fence:") are
// click-to-toggle FOR THE ATTACHED SESSION: probe -> off confirms with the
// explicit UNFENCED wording (cancelTask idiom), off -> probe applies without
// one. The strip repaints ONLY from the server's sessionState(key:"toolExec")
// push -- never optimistically. Inline/degraded postures and log view stay
// inert. Pinned with a stubbed global confirm around the real FakeWebSocket.
describe("header fence toggle (real app wiring)", () => {
  const g = globalThis as Record<string, unknown>;
  const prevConfirm = g.confirm;
  let confirmCalls = 0;

  afterAll(() => {
    if (prevConfirm === undefined) delete g.confirm;
    else g.confirm = prevConfirm;
  });

  function stubConfirm(answer: boolean): void {
    confirmCalls = 0;
    g.confirm = () => {
      confirmCalls++;
      return answer;
    };
  }

  /** Re-attach to the live session carrying a specific posture. */
  async function attachWithPosture(posture: string | undefined): Promise<void> {
    ws.fireMessage({
      type: "sessionCreated",
      sessionId: SID,
      profile: "manager",
      title: null,
      currentModel: "m1",
      models: ["m1"],
      ...(posture !== undefined ? { toolExec: posture } : {}),
    });
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "cursor", value: 9 });
    fireSidebarReplies();
    await tick();
  }

  const fenceMsgs = () =>
    ws.sent
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .filter((m) => m.type === "execFence");

  it("worker posture renders the clickable affordance and a naming tooltip", async () => {
    await attachWithPosture("worker (fence: bwrap)");
    const strip = el("#tool-exec-status");
    expect(strip.textContent).toContain("worker (fence: bwrap)");
    expect(strip.getAttribute("class")).toContain("tool-exec-toggleable");
    // Button chrome lives in the class, not an inline style attribute.
    expect(strip.getAttribute("style")).toBeNull();
    expect(strip.getAttribute("title")).toContain("click to toggle this session's fence");
  });

  it("probe -> off: confirm->true sends execFence for the ATTACHED session only", async () => {
    stubConfirm(true);
    ws.sent.length = 0;
    el("#tool-exec-status").click();
    expect(confirmCalls).toBe(1);
    expect(fenceMsgs()).toEqual([{ type: "execFence", sessionId: SID, policy: "off" }]);
  });

  it("probe -> off: confirm->false sends NOTHING", async () => {
    stubConfirm(false);
    ws.sent.length = 0;
    el("#tool-exec-status").click();
    expect(confirmCalls).toBe(1);
    expect(fenceMsgs()).toEqual([]);
  });

  it("the confirm states plainly that this session runs UNFENCED", async () => {
    let seen = "";
    g.confirm = (msg?: unknown) => {
      seen = String(msg ?? "");
      return false;
    };
    el("#tool-exec-status").click();
    expect(seen).toContain("Tool code for this session will run UNFENCED");
  });

  it("server-pushed posture update repaints the strip; off -> probe flips back WITHOUT confirm", async () => {
    stubConfirm(true);
    ws.fireMessage({
      type: "sessionState",
      sessionId: SID,
      key: "toolExec",
      value: "worker (fence: off)",
    });
    await tick();
    expect(el("#tool-exec-status").textContent).toContain("fence: off");
    // Still the clickable worker shape: clicking now proposes the tighten.
    ws.sent.length = 0;
    el("#tool-exec-status").click();
    expect(confirmCalls).toBe(0); // off -> probe is never confirm-gated
    expect(fenceMsgs()).toEqual([{ type: "execFence", sessionId: SID, policy: "probe" }]);
  });

  it("a push for ANOTHER session never repaints this strip (per-session posture)", async () => {
    stubConfirm(false);
    ws.fireMessage({
      type: "sessionState",
      sessionId: "s-some-other-session",
      key: "toolExec",
      value: "worker (fence: seatbelt)",
    });
    await tick();
    // The strip still carries OUR last server-pushed posture.
    expect(el("#tool-exec-status").textContent).toContain("fence: off");
    expect(el("#tool-exec-status").textContent).not.toContain("seatbelt");
  });

  it("inline posture: inert strip, no class, no click effect", async () => {
    stubConfirm(true);
    await attachWithPosture("inline (unfenced)");
    const strip = el("#tool-exec-status");
    expect(strip.getAttribute("class") ?? "").not.toContain("tool-exec-toggleable");
    expect(strip.getAttribute("style")).toBeNull();
    ws.sent.length = 0;
    strip.click();
    expect(fenceMsgs()).toEqual([]);
    expect(confirmCalls).toBe(0);
  });

  it("log view (activeLogId set): inert, tooltip says live sessions only", async () => {
    stubConfirm(true);
    await attachWithPosture("worker (fence: bwrap)"); // clickable when live
    viewLog(L1, "fence log line");
    await tick();
    expect(el("#log-view-label")).toBeTruthy();
    const strip = el("#tool-exec-status");
    expect(strip.getAttribute("class") ?? "").not.toContain("tool-exec-toggleable");
    expect(strip.getAttribute("title")).toContain("live sessions only");
    ws.sent.length = 0;
    strip.click();
    expect(fenceMsgs()).toEqual([]);
    expect(confirmCalls).toBe(0);
    // Leave log view for the next scenario.
    el("#close-log-view-btn").click();
    fireAttachBurst("back live");
    await tick();
  });
});
