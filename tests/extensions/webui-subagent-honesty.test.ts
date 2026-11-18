// Subagent attach honesty (owner ruling 2026-11-18):
//  - a FAILED subagent-row attach renders the honest fallback card (exact
//    copy, View log / Close, no raw error bubble, no other session's
//    transcript), while interactive attach failures keep the plain error
//    bubble and successful attaches keep turn errors as plain rows;
//  - the build-skew decision: bundle stamp vs the additive authOk
//    version (equal NEVER alarms; a daemon that reports nothing skews --
//    it is older than the report itself).
// Driven through createChat over a FakeWebSocket (the webui-chat.test.ts
// idiom) against the dom-helper DOM, so the card and its buttons are the
// real message-list render path.

import { describe, it, expect, afterEach } from "bun:test";
import { createChat, type ChatController } from "@extensions/webui/ui/chat.ts";
import { CLIENT_VERSION, versionSkews } from "@extensions/webui/ui/build-info.ts";

class FakeWebSocket {
  static OPEN = 1;
  static instances: FakeWebSocket[] = [];
  readyState = FakeWebSocket.OPEN;
  sent: Record<string, unknown>[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(JSON.parse(data));
  }
  close(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  emit(msg: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
}

const RealWebSocket = globalThis.WebSocket;

let chat: ChatController | null = null;

afterEach(() => {
  chat?.disconnect();
  chat = null;
  FakeWebSocket.instances = [];
  globalThis.WebSocket = RealWebSocket;
});

/** A mounted manager on the real dom-helper DOM (the card is DOM output). */
function makeChat(): { chat: ChatController; ws: FakeWebSocket; container: HTMLElement } {
  globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
  const container = document.createElement("div");
  chat = createChat({
    token: null,
    host: "localhost",
    getMessageListContainer: () => container,
    onSessionCreated: (d) => chat!.setSession(d.sessionId, d.replayDelta === true),
  });
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  return { chat, ws, container };
}

// ── The failed-attach card ────────────────────────────────────────────────

describe("subagent attach failure: the honest card", () => {
  it("a failed live-row attach shows the card, never the raw error bubble", () => {
    const { ws, container } = makeChat();
    // A manager session on screen first (the pane the row press leaves).
    ws.emit({ type: "sessionCreated", sessionId: "s-mgr" });
    // The row press: switchSession carries the subagent hint.
    chat!.switchSession("worker-1", { subagent: true });
    expect(ws.sent.filter((m) => m.type === "switchSession" && m.sessionId === "worker-1")).toHaveLength(1);

    // The server refuses the attach (ANY error message -- the field one was
    // the bare "Session not found" from a pre-B3 daemon).
    ws.emit({ type: "error", message: "Session not found" });

    const card = container.querySelector(".message.attach-fallback");
    expect(card, "honest card rendered").not.toBeNull();
    expect(card!.querySelector(".content")!.textContent).toBe(
      "Live tail unavailable for this subagent.",
    );
    // No raw error bubble anywhere; the failed session's transcript is empty,
    // never another session's.
    expect(container.querySelectorAll(".message.error")).toHaveLength(0);
    expect(container.textContent).not.toContain("Session not found");

    // Two REAL actions. "View log" opens the worker's own durable log (the
    // B4 settled view keys on the SAME id the attach used).
    const buttons = [...card!.querySelectorAll("button")];
    const labels = buttons.map((b) => b.textContent);
    expect(labels).toContain("View log");
    expect(labels).toContain("Close");
    const viewBtn = buttons.find((b) => b.textContent === "View log")!;
    viewBtn.dispatchEvent!({ type: "click" } as Event);
    expect(ws.sent.filter((m) => m.type === "viewLog" && m.logId === "worker-1")).toHaveLength(1);

    // Close removes the card.
    const closeBtn = buttons.find((b) => b.textContent === "Close")!;
    closeBtn.dispatchEvent!({ type: "click" } as Event);
    expect(container.querySelector(".message.attach-fallback")).toBeNull();
  });

  it("an interactive switchSession failure keeps the plain error bubble (hint-gated)", () => {
    const { ws, container } = makeChat();
    ws.emit({ type: "sessionCreated", sessionId: "s-mgr" });
    chat!.switchSession("s-other");
    ws.emit({ type: "error", message: "Session not found" });
    expect(container.querySelector(".message.attach-fallback")).toBeNull();
    expect(container.querySelector(".message.error .content")!.textContent).toContain(
      "Session not found",
    );
  });

  it("a landing sessionCreated closes the window: later turn errors stay plain rows", () => {
    const { ws, container } = makeChat();
    ws.emit({ type: "sessionCreated", sessionId: "worker-2" });
    chat!.switchSession("worker-2", { subagent: true });
    ws.emit({ type: "sessionCreated", sessionId: "worker-2", kind: "subagent" });
    // A REAL turn error inside the live worker view: the normal treatment.
    ws.emit({ type: "error", message: "llm exploded" });
    expect(container.querySelector(".message.attach-fallback")).toBeNull();
    expect(container.querySelector(".message.error .content")!.textContent).toContain(
      "llm exploded",
    );
  });

  it("a view change mid-attach ends the window: a late error is no card", () => {
    const { ws, container } = makeChat();
    ws.emit({ type: "sessionCreated", sessionId: "s-mgr" });
    chat!.switchSession("worker-3", { subagent: true });
    chat!.viewLog("some-log");
    ws.emit({ type: "error", message: "Session not found" });
    expect(container.querySelector(".message.attach-fallback")).toBeNull();
  });
});

// ── The version-skew decision ─────────────────────────────────────────────

describe("version skew: bundle stamp vs the daemon's authOk", () => {
  it("equal versions never skew; unequal skew; a missing report skews", () => {
    expect(versionSkews(CLIENT_VERSION)).toBe(false);
    expect(versionSkews("0.0.1-definitely-not-this")).toBe(true);
    expect(versionSkews(undefined)).toBe(true);
    expect(versionSkews(null)).toBe(true);
  });

  it("authOk attests the flag per handshake: mismatch -> true, match -> false", () => {
    const { chat, ws } = makeChat();
    expect(chat.versionSkewAtom()).toBe(false); // false before the first authOk
    ws.emit({ type: "authOk", version: "0.0.1-old-daemon" });
    expect(chat.versionSkewAtom()).toBe(true);
    ws.emit({ type: "authOk", version: CLIENT_VERSION });
    expect(chat.versionSkewAtom()).toBe(false);
    // A daemon that sends no version at all (older than the report): skew.
    ws.emit({ type: "authOk" });
    expect(chat.versionSkewAtom()).toBe(true);
  });
});
