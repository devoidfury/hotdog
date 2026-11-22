/// <reference lib="dom" />
// THE app-wiring suite: app.tsx mounted on the dom-helper DOM with a
// FakeWebSocket standing in for the server. Covers the interactive surface
// (composer send/draft, tab completion, attachments, push-to-talk, the
// profile/model comboboxes,
// sidebar glue: create/switch/cancel/resize, context menus, the subagent
// sidebar list and its main-view transcript, log-view header controls) plus
// the auth lifecycle
// (socket authError teardown, login form, Ctrl+Shift+L) at the end.
//
// Single-booter doctrine: app.tsx boots its singleton at import, so exactly
// ONE test file may import it. Under the serial `bun test --coverage` run (the
// CI gate) the module registry is shared across files, and bun attributes the
// module's coverage to one importer -- a second file booting it inherits the
// first file's browser stubs and steals the attribution. Hence the log-view /
// working-Cancel / fence-matrix scenarios (and the auth lifecycle) live here
// as sections rather than separate files. `bun run test`/`loud-test` run
// --parallel (one process per file), where the constraint is invisible; keep
// it in mind if a second app-booting file ever appears -- the serial gate is
// the one that breaks.
//
// All browser stubs below are installed before the import and torn down after.

import { describe, it, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { FakeWebSocket, SVG_NS, TEXTAREA_LINE_PX } from "./index.ts";
import { DRAFT_STORAGE_KEY, DRAFT_CARET_STORAGE_KEY } from "@extensions/webui/ui/draft.ts";
import { ATTACHMENTS_STORAGE_KEY } from "@extensions/webui/ui/attachment-store.ts";
import { HIDE_THINKING_STORAGE_KEY } from "@extensions/webui/ui/thinking-pref.ts";
import {
  applyStoredTheme,
  DEFAULT_THEME_ID,
  THEME_REGISTRY,
  THEME_STORAGE_KEY,
} from "@extensions/webui/ui/theme-pref.ts";
import {
  seedWorkbenchStoreFromStorage,
  WORKBENCH_TABS_KEY,
  workbenchStore,
} from "@extensions/webui/ui/workbench.tsx";
import { STASH_KEY_PREFIX, STASH_TAB_ID_KEY } from "@extensions/webui/ui/editor-stash.ts";

const SID = "s-ui-0001";
const L1 = "l-ui-0001";

// ── Browser env (before the app import) ─────────────────────────────────────

const g = globalThis as Record<string, unknown>;
const prev = {
  localStorage: g.localStorage,
  WebSocket: g.WebSocket,
  fetch: g.fetch,
  confirm: g.confirm,
  prompt: g.prompt,
  FileReader: g.FileReader,
  MediaRecorder: g.MediaRecorder,
};

// Three lines on purpose: the boot pin asserts the composer autoExpands a
// restored multi-line draft WITHOUT any key event (the draft-restore seam
// re-measures once the node is connected).
const SEEDED_DRAFT = "restored draft\nsecond line of the draft\nthird";
const store = new Map<string, string>([
  ["hotdog-webui-token", "tok"],
  // The composer mounts with this draft restored (ref contract)...
  [DRAFT_STORAGE_KEY, SEEDED_DRAFT],
  // ...and with the caret that went down with the reload (marker CLEAR: the
  // selection hydrates, the composer must NOT grab focus at boot -- the
  // no-steal matrix continues on the exported seam below).
  [DRAFT_CARET_STORAGE_KEY, JSON.stringify({ s: 5, e: 9, f: 0 })],
  // ...and with one attachment staged by the previous page load.
  [
    ATTACHMENTS_STORAGE_KEY,
    JSON.stringify([{ name: "kept.png", mimeType: "image/png", size: 4, data: "QUJDRA==" }]),
  ],
  // The sessions sidebar boots COLLAPSED from the previous visit's choice:
  // the boot read is only observable through a seeded key (single-booter
  // doctrine), so the sidebar-visibility section verifies the restore and
  // then reopens the panel -- the shape every later section expects.
  ["hotdog.sidebarCollapsed", "1"],
  // Chat mode (the default side) seeded EXPLICITLY so the chat/editor-mode
  // section can observe the boot read without ever booting the app swapped:
  // the whole suite renders the chat layout. The section flips and returns.
  ["hotdog.editorMode", "0"],
]);
g.localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
};
// draft.ts reaches storage through window.localStorage (the dom-helper stub
// window has none) -- point both at the same map.
(window as unknown as { localStorage: unknown }).localStorage = g.localStorage;
g.WebSocket = FakeWebSocket;
let loginReply: { status: number; ok: boolean; json?: () => Promise<unknown> } =
  { status: 200, ok: true, json: async () => ({ token: "fresh-tok" }) };
g.fetch = async (url: unknown, init?: RequestInit) => {
  fetchLog.push({ url: String(url), init });
  // Boot's /verify always passes: the auth section drives /login instead.
  return (String(url) === "/login" ? loginReply : { status: 200, ok: true, json: async () => ({}) }) as unknown as Response;
};
const fetchLog: Array<{ url: string; init?: RequestInit }> = [];

let confirmAnswer = true;
let confirmSeen: string[] = [];
g.confirm = (msg?: unknown) => {
  confirmSeen.push(String(msg ?? ""));
  return confirmAnswer;
};
let promptAnswer: string | null = "renamed";
g.prompt = () => promptAnswer;

// FileReader/Blob readers: base64 payloads are stubbed, never real audio.
class FakeFileReader {
  result: string | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(file: Blob): void {
    const size = (file as unknown as { size: number }).size ?? 0;
    this.result = `data:audio/webm;base64,${"A".repeat(size)}`;
    queueMicrotask(() => this.onload?.());
  }
}
g.FileReader = FakeFileReader;

// MediaRecorder double: stop() replays one chunk and fires onstop.
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static nextChunkSize = 8;
  mimeType = "audio/webm";
  stream: unknown;
  ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
  onstop: (() => void) | null = null;
  startCount = 0;
  stopCount = 0;
  chunkSize: number;
  constructor(stream: unknown) {
    this.stream = stream;
    this.chunkSize = FakeMediaRecorder.nextChunkSize;
    FakeMediaRecorder.instances.push(this);
  }
  start(): void {
    this.startCount++;
  }
  stop(): void {
    this.stopCount++;
    if (this.chunkSize > 0) this.ondataavailable?.({ data: { size: this.chunkSize } });
    this.onstop?.();
  }
}

function stubMic(opts: { deny?: boolean; pending?: boolean; chunkSize?: number } = {}): { resolve: () => void } {
  FakeMediaRecorder.nextChunkSize = opts.chunkSize ?? 8;
  g.MediaRecorder = FakeMediaRecorder;
  const tracks = [{ stopped: false, stop() { this.stopped = true; } }];
  let release: () => void = () => {};
  const getUserMedia = () => {
    if (opts.deny) return Promise.reject(new Error("denied"));
    if (opts.pending) return new Promise<unknown>((res) => { release = () => res({ getTracks: () => tracks }); });
    return Promise.resolve({ getTracks: () => tracks });
  };
  Object.defineProperty(g, "navigator", {
    value: { mediaDevices: { getUserMedia } },
    configurable: true,
    writable: true,
  });
  return { resolve: () => release() };
}

const appEl = document.createElement("div");
appEl.setAttribute("id", "app");
document.body.appendChild(appEl);

const win = window as unknown as Record<string, unknown>;
const prevWin = {
  innerWidth: win.innerWidth,
  innerHeight: win.innerHeight,
  addEventListener: win.addEventListener,
  removeEventListener: win.removeEventListener,
  localStorage: win.localStorage,
};
win.innerWidth = 1200;
// The Recent Logs height clamp reads the viewport height the same way the
// sidebar width reads the viewport width (half of it, at most).
win.innerHeight = 900;
const winListeners = new Map<string, Set<(e: unknown) => void>>();
win.addEventListener = (type: string, cb: (e: unknown) => void) => {
  (winListeners.get(type) ?? winListeners.set(type, new Set()).get(type)!).add(cb);
};
win.removeEventListener = (type: string, cb: (e: unknown) => void) => {
  winListeners.get(type)?.delete(cb);
};
const fireWin = (type: string): void => {
  for (const cb of [...(winListeners.get(type) ?? [])]) cb({ type });
};

afterAll(() => {
  appEl.remove();
  win.innerWidth = prevWin.innerWidth;
  win.innerHeight = prevWin.innerHeight;
  win.addEventListener = prevWin.addEventListener;
  win.removeEventListener = prevWin.removeEventListener;
  if (prevWin.localStorage === undefined) delete win.localStorage;
  else win.localStorage = prevWin.localStorage;
  for (const [k, v] of Object.entries(prev)) {
    if (v === undefined) delete g[k];
    else g[k] = v;
  }
  delete (g as { navigator?: unknown }).navigator;
});

const wsBase = FakeWebSocket.instances.length;
// The app module object is kept for the caret-restore seam test at the end
// of the file (single-booter doctrine: this file IS the app's importer).
const appModule = await import("@extensions/webui/ui/app.tsx");
await tick();
const ws = FakeWebSocket.instances[wsBase]!;

// ── Helpers ─────────────────────────────────────────────────────────────────

function tick(times = 1): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i++) p = p.then(() => new Promise<void>((r) => setTimeout(r, 0)));
  return p;
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const el = (sel: string): HTMLElement => document.querySelector(sel) as unknown as HTMLElement;
const els = (sel: string): HTMLElement[] => Array.from(document.querySelectorAll(sel)) as unknown as HTMLElement[];

/** The settings dialog header's Refresh is the glyph-button standard
 *  (.file-reload-btn, no text node): find it by aria-label, scoped to the
 *  dialog so a workbench pane elsewhere can never shadow the lookup. */
const settingsRefresh = (): HTMLElement =>
  els(".settings-view .file-reload-btn").find((b) => b.getAttribute("aria-label") === "Refresh")!;

function sent<T = Record<string, unknown>>(type: string): T[] {
  return ws.sent
    .map((s) => JSON.parse(s) as T & { type: string })
    .filter((m) => (m as { type: string }).type === type);
}
const clearSent = (): void => {
  ws.sent.length = 0;
};
const sentTypes = (): string[] => ws.sent.map((s) => String((JSON.parse(s) as { type: string }).type));
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
  messageCount: 3,
};
const logRow = { id: L1, createdAt: 1, lastActivityAt: 2, messageCount: 5 };

async function attach(): Promise<void> {
  ws.fireMessage({
    type: "sessionCreated",
    sessionId: SID,
    profile: "manager",
    title: null,
    currentModel: "m1",
    models: ["m1", "m2"],
    sttEnabled: true,
  });
  ws.fireMessage({ type: "sessionState", sessionId: SID, key: "cursor", value: 3 });
  ws.fireMessage({ type: "sessions", sessions: [sessionRow] });
  ws.fireMessage({ type: "logsListed", logs: [logRow] });
  ws.fireMessage({ type: "profiles", profiles: { manager: { body: "", model: null }, coder: { body: "", model: null } } });
  await tick();
}

function setComposer(text: string): void {
  const box = el("#chat-input");
  (box as unknown as { value: string }).value = text;
}

async function submitComposer(): Promise<void> {
  el("#chat-form").dispatchEvent(new Event("submit"));
  await tick();
}

/** Keyboard event on a node: plain object keeps key/shiftKey/target fields. */
function key(node: Element, k: string, over: Record<string, unknown> = {}): void {
  // currentTarget rides on the payload: the dom-helper does not rewrite it
  // during the bubbling walk, and the app reads handlers off it.
  node.dispatchEvent({ type: "keydown", key: k, currentTarget: node, preventDefault: () => {}, ...over } as unknown as Event);
}

// ── Boot & attach ───────────────────────────────────────────────────────────

describe("app boot (stored token)", () => {
  beforeAll(async () => {
    ws.fireOpen();
    ws.fireMessage({ type: "authOk" });
    await tick();
  });

  it("the header band spans the top of the app, panes ride the row below it", () => {
    // Layout contract (2026-11-14): #session-info is a direct child of
    // #main-ui, full width, with #workspace-row (sidebar + chat + workbench)
    // as the next sibling. The workbench can open/close without pushing the
    // header, and the sidebar sits under the band, not beside it. The band
    // carries ONLY the global controls; the per-pane identity + toggles
    // (#chat-header) open the chat column.
    const main = el("#main-ui");
    const header = el("#session-info");
    const row = el("#workspace-row");
    expect(header.parentElement).toBe(main);
    expect(row.parentElement).toBe(main);
    expect(el("#chat-area").querySelector("#session-info")).toBeNull();
    const kids = (main as unknown as { children: Element[] }).children;
    expect(kids.indexOf(row)).toBe(kids.indexOf(header) + 1);
    expect(row.querySelector("#sidebar")).not.toBeNull();
    expect(row.querySelector("#chat-area")).not.toBeNull();
    // The band holds the four global controls only (settings/theme/mode/
    // workbench).
    const bandBtns = Array.from(el("#session-info").querySelectorAll("button"));
    expect(bandBtns.map((b) => b.getAttribute("id"))).toEqual([
      "settings-btn",
      "theme-btn",
      "editor-mode-toggle",
      "workbench-toggle",
    ]);
    // #chat-header opens the chat column and owns the moved controls.
    // (The fence chip is conditional on a toolExec posture; the reasoning
    // toggle always renders. Pin the fence's home in the toggle test, which
    // attaches a posture.) The sidebar disclosure belongs to this header
    // too, never the band.
    const chatHeader = el("#chat-header")!;
    expect(chatHeader.parentElement).toBe(el("#chat-area"));
    for (const id of ["sidebar-toggle", "session-label", "thinking-toggle"]) {
      expect(el("#chat-header").querySelector(`#${id}`)).not.toBeNull();
    }
    expect(el("#session-info").querySelector("#thinking-toggle")).toBeNull();
    expect(el("#session-info").querySelector("#sidebar-toggle")).toBeNull();
  });

  it("auto-login opens main-ui with the composer draft restored", () => {
    expect(el("#main-ui").getAttribute("class")).not.toContain("hidden");
    expect(el("#login-screen").getAttribute("class")).toContain("hidden");
    // The connection indicator left the header and renders ONLY while
    // disconnected: connected means zero DOM, not a hidden span.
    expect(document.querySelector("#connection-status")).toBeNull();
    // chatInputRef brought the stored draft back, and the SAME autoResize the
    // input handler runs has ALREADY re-measured the connected node: a
    // restored multi-line draft is expanded at boot, before any key event.
    const box = el("#chat-input") as unknown as {
      value: string;
      style: { height: string };
      selectionStart: number | null;
      selectionEnd: number | null;
    };
    expect(box.value).toBe(SEEDED_DRAFT);
    expect(box.style.height).toBe(`${SEEDED_DRAFT.split("\n").length * TEXTAREA_LINE_PX}px`);
    // The seeded caret record hydrates with the text (the reload lands where
    // the typing left off), and the CLEARED focus marker means the composer
    // took the selection but NOT the focus.
    expect(box.selectionStart).toBe(5);
    expect(box.selectionEnd).toBe(9);
    expect(document.activeElement as unknown as HTMLElement).not.toBe(el("#chat-input"));
    // The steer switch is gone; nothing may resurrect it (steering-on is the
    // default; see the send pin below).
    expect(document.querySelector("#steer-checkbox")).toBeNull();
    expect(document.querySelector("#steer-label")).toBeNull();
  });

  it("attachments staged before the reload come back as chips; dismissing clears the key", async () => {
    const chips = els(".attachment-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.querySelector(".attachment-name")!.textContent).toBe("kept.png");
    expect(chips[0]!.querySelector(".attachment-size")!.textContent).toBe("4 B");
    // Dismiss it here so the rest of the suite ships clean sends.
    els(".attachment-remove")[0]!.click();
    await tick();
    expect(els(".attachment-chip")).toHaveLength(0);
    expect(store.has(ATTACHMENTS_STORAGE_KEY)).toBe(false);
  });

  it("attach fills the header, selects, and sidebar", async () => {
    await attach();
    expect(el("#current-session-id").textContent).toBe(SID.slice(0, 8));
    // The controls are searchable comboboxes now (the section below drives
    // them): the trigger BUTTON shows the current value as its text, and the
    // option list exists only inside the popup. Open once per control to
    // enumerate, then toggle-close the way a user would.
    expect(el("#profile-select").localName).toBe("button");
    expect(el("#profile-select").textContent).toBe("manager");
    el("#profile-select").click();
    await tick();
    expect(els("#profile-select-list [role=option]")).toHaveLength(2);
    el("#profile-select").click();
    await tick();
    expect(document.querySelector(".combobox-popup")).toBeNull();
    expect(el("#model-select").localName).toBe("button");
    expect(el("#model-select").textContent).toBe("m1");
    el("#model-select").click();
    await tick();
    expect(els("#model-select-list [role=option]")).toHaveLength(2);
    el("#model-select").click();
    await tick();
    expect(els(".session-item")).toHaveLength(1);
    expect(els(".log-item")).toHaveLength(1);
  });
});

// ── Sessions sidebar visibility (chat-header disclosure) ────────────────────
// ONE preference, two shapes (app.tsx sidebarCollapsedAtom): desktop drops
// #sidebar out of the #workspace-row flex row (.sidebar-hidden); mobile
// opens/closes the fixed drawer (.open, the rule that shipped with the
// drawer and had no writer until this button). The class flip is all the
// DOM shows (no CSS engine here); the rules' truth is the pair
// #sidebar.sidebar-hidden / #sidebar.open in styles.css. The suite seeded
// hotdog.sidebarCollapsed="1" before the import so the boot read is
// observable; this section verifies it, then reopens the panel and leaves
// it expanded (the canonical default) for the sections behind it.

describe("sessions sidebar visibility (chat-header disclosure)", () => {
  it("boots from the stored pref: .sidebar-hidden, aria-expanded false, nothing rewritten", async () => {
    await attach();
    expect(store.get("hotdog.sidebarCollapsed")).toBe("1"); // read at boot, written only by a toggle
    expect(el("#sidebar").classList.contains("sidebar-hidden")).toBe(true);
    expect(el("#sidebar").classList.contains("open")).toBe(false);
    const btn = el("#sidebar-toggle");
    expect(btn.localName).toBe("button");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Toggle sessions sidebar");
    expect(btn.getAttribute("title")).toBe("Toggle Sessions sidebar"); // position-free: the rail docks left in chat mode, right (beside the chat) in the editor shape
    // First position in the header: the cluster leads with the disclosure,
    // the Session: chip rides right behind it, the status group stays last.
    const kids = el("#chat-header").children;
    expect(kids[0]!.getAttribute("class")).toBe("header-identity-group");
    expect(kids[0]!.children[0]!).toBe(btn);
    expect(kids[0]!.children[1]!.getAttribute("id")).toBe("session-label");
    expect(kids[kids.length - 1]!.getAttribute("class")).toBe("header-status-group");
  });

  it("the glyph is the workbench panel mirrored: fill LEFT (x=4), zero text node, tint inherited", () => {
    const btn = el("#sidebar-toggle");
    expect(btn.textContent).toBe(""); // glyph-only chrome, like its siblings
    expect(btn.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    // Mirror geometry: the outline is the workbench's own, and the solid
    // column lands at x=4 -- the 15.4 fill mirrored about x=12.
    expect(btn.querySelector("rect[x='4']")).toBeTruthy();
    expect(btn.querySelector("rect[x='15.4']")).toBeNull();
    // The workbench toggle keeps its RIGHT fill; the flip is the sidebar's.
    expect(el("#workbench-toggle").querySelector("rect[x='15.4']")).toBeTruthy();
    expect(el("#workbench-toggle").querySelector("rect[x='4']")).toBeNull();
  });

  it("click reopens: .open replaces .sidebar-hidden, aria-expanded follows, the pref persists, the socket stays silent", async () => {
    const before = ws.sent.length;
    el("#sidebar-toggle").click();
    await tick();
    expect(el("#sidebar").classList.contains("sidebar-hidden")).toBe(false);
    expect(el("#sidebar").classList.contains("open")).toBe(true);
    expect(el("#sidebar-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(store.get("hotdog.sidebarCollapsed")).toBe("0");
    // A view preference: nothing goes to the server.
    expect(ws.sent.length).toBe(before);
    // Hiding is CSS-only -- the panel's DOM (and the drawer's state) rides
    // along, which is exactly what the offsetParent-guarded handle expects.
    expect(document.querySelector("#sidebar")).not.toBeNull();
    expect(el("#sidebar").querySelector("#new-session-btn")).toBeTruthy();
  });

  it("the round trip closes and reopens, leaving the app on the default-expanded side", async () => {
    el("#sidebar-toggle").click(); // close
    await tick();
    expect(el("#sidebar").classList.contains("sidebar-hidden")).toBe(true);
    expect(el("#sidebar-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(store.get("hotdog.sidebarCollapsed")).toBe("1");
    el("#sidebar-toggle").click(); // open again: the canonical shape behind us
    await tick();
    expect(el("#sidebar").classList.contains("sidebar-hidden")).toBe(false);
    expect(el("#sidebar-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(store.get("hotdog.sidebarCollapsed")).toBe("0");
  });
});

// ── Header fingerprint badge (whole badge = full-id copy button) ───────────

describe("header fingerprint badge", () => {
  it("clicking the badge copies the FULL session id and flashes the confirmed state", async () => {
    await attach();
    const copied: string[] = [];
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: {
        clipboard: {
          writeText: async (t: string) => {
            copied.push(t);
          },
        },
      },
      configurable: true,
    });
    try {
      clearSent();
      const badge = el("#current-session-id");
      badge.click();
      await tick();
      // The FULL id, not the 8-char text printed on the badge.
      expect(copied).toEqual([SID]);
      expect(badge.classList.contains("copied")).toBe(true);
      // Badge text stays the short display form (the copy/check glyph is a
      // CSS ::after affordance, not DOM text).
      expect(badge.textContent).toBe(SID.slice(0, 8));
      // Copying is inert on the wire.
      expect(ws.sent).toHaveLength(0);
    } finally {
      if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it("stays the fingerprint even when the session carries a title", async () => {
    await attach();
    // The bug class: derived titles now ride every title channel the header
    // used to read (rename push + authoritative list), turning the copy
    // button into a headline. The badge text is always the 8-char id.
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "title", value: "Some fine headline" });
    ws.fireMessage({ type: "sessions", sessions: [{ ...sessionRow, title: "Some fine headline" }] });
    await tick();
    expect(el("#current-session-id").textContent).toBe(SID.slice(0, 8));
  });
});

// ── Composer ────────────────────────────────────────────────────────────────

describe("composer", () => {
  it("text send goes straight to the socket and clears the box + draft", async () => {
    await attach();
    clearSent();
    await submitComposer(); // draft text restored -> non-empty
    const [msg] = sent<{ type: string; content: string; steering: boolean }>("send");
    expect(msg?.content).toBe(SEEDED_DRAFT);
    expect(msg?.steering).toBe(true);
    expect((el("#chat-input") as unknown as { value: string }).value).toBe("");
    expect(store.has(DRAFT_STORAGE_KEY)).toBe(false);
  });

  it("empty composer is inert", async () => {
    clearSent();
    await submitComposer();
    expect(sent("send")).toHaveLength(0);
  });

  it("leading slash routes through the command wire, not send", async () => {
    setComposer("/help me");
    clearSent();
    await submitComposer();
    const [cmd] = sent<{ command: string }>("command");
    expect(cmd?.command).toBe("/help me");
    expect(sent("send")).toHaveLength(0);
  });

  it("Enter submits via the form; Shift+Enter does not", async () => {
    const box = el("#chat-input");
    setComposer("enter send");
    clearSent();
    key(box, "Enter");
    await tick();
    expect(sent<{ content: string }>("send")[0]?.content).toBe("enter send");

    (box as unknown as { value: string }).value = "shift enter";
    clearSent();
    key(box, "Enter", { shiftKey: true });
    await tick();
    expect(sent("send")).toHaveLength(0);
  });

  it("typing schedules the debounced draft save; pagehide flushes it", async () => {
    setComposer("typing work");
    el("#chat-input").dispatchEvent(new Event("input"));
    await tick();
    expect(store.get(DRAFT_STORAGE_KEY)).toBeUndefined(); // still debounced
    // The dom-helper window has no `onpagehide`, so the composer's leave
    // flush bound the beforeunload fallback.
    fireWin("beforeunload");
    expect(store.get(DRAFT_STORAGE_KEY)).toBe("typing work");
    await sleep(280); // the timer fires on the stale closure, harmless
  });

  it("emptying the box clears the stored draft outright", async () => {
    store.set(DRAFT_STORAGE_KEY, "stale");
    setComposer("");
    el("#chat-input").dispatchEvent(new Event("input"));
    await tick();
    expect(store.has(DRAFT_STORAGE_KEY)).toBe(false);
  });

  it("the debounced save carries the caret and the focus marker in one write", async () => {
    setComposer("caret work");
    const box = el("#chat-input") as unknown as {
      selectionStart: number | null;
      selectionEnd: number | null;
      focus(): void;
      blur(): void;
    };
    box.selectionStart = 3;
    box.selectionEnd = 5;
    box.focus();
    el("#chat-input").dispatchEvent(new Event("input"));
    await tick();
    expect(store.get(DRAFT_CARET_STORAGE_KEY)).toBeUndefined(); // debounced, same as the text
    fireWin("beforeunload"); // the leave flush runs text+caret as ONE snapshot
    expect(store.get(DRAFT_STORAGE_KEY)).toBe("caret work");
    expect(store.get(DRAFT_CARET_STORAGE_KEY)).toBe(JSON.stringify({ s: 3, e: 5, f: 1 }));
    // Focus given away WITHOUT a keystroke: the composer's blur write demotes
    // the marker, so a reload must not re-grab focus the user abandoned.
    box.blur(); // dom-helper moves activeElement without firing events...
    el("#chat-input").dispatchEvent(new Event("blur")); // ...the handler is the event
    fireWin("beforeunload");
    expect(store.get(DRAFT_CARET_STORAGE_KEY)).toBe(JSON.stringify({ s: 3, e: 5, f: 0 }));
    // An emptied box takes the caret record with the text (clearDraft clears
    // both keys: no orphan marker waiting to focus an empty composer).
    setComposer("");
    el("#chat-input").dispatchEvent(new Event("input"));
    expect(store.has(DRAFT_STORAGE_KEY)).toBe(false);
    expect(store.has(DRAFT_CARET_STORAGE_KEY)).toBe(false);
  });
});

// ── Tab completion ──────────────────────────────────────────────────────────

describe("tab completion", () => {
  const menuItems = () => els(".completion-item");

  async function requestCompletions(line: string): Promise<void> {
    setComposer(line);
    const box = el("#chat-input");
    (box as unknown as { selectionStart: number | null }).selectionStart = line.length;
    clearSent();
    key(box, "Tab");
    await tick();
  }

  function replyCompletions(options: Array<{ value: string; display?: string }>): void {
    const req = sent<{ requestId: number }>("complete")[0]!;
    ws.fireMessage({ type: "completions", requestId: req.requestId, prefix: "/mod", options });
  }

  it("Tab with no session is inert; with a session it asks the server", async () => {
    await attach();
    await requestCompletions("/mod");
    const [req] = sent<{ line: string; cursorPos: number }>("complete");
    expect(req?.line).toBe("/mod");
    expect(req?.cursorPos).toBe(4);
  });

  it("reply renders the menu; arrows/Tab cycle; Escape dismisses", async () => {
    await requestCompletions("/mod");
    replyCompletions([{ value: "/model" }, { value: "/models", display: "/models (all)" }]);
    await tick();
    expect(menuItems().map((n) => n.textContent)).toEqual(["/model", "/models (all)"]);
    expect(menuItems()[0]!.classList.contains("active")).toBe(true);

    key(el("#chat-input"), "ArrowDown");
    await tick();
    expect(menuItems()[1]!.classList.contains("active")).toBe(true);
    key(el("#chat-input"), "ArrowUp");
    key(el("#chat-input"), "ArrowUp");
    await tick();
    expect(menuItems()[1]!.classList.contains("active")).toBe(true); // wraps

    key(el("#chat-input"), "Escape");
    await tick();
    expect(document.querySelector("#completion-menu")).toBeNull();
  });

  it("Enter accepts the selection instead of submitting", async () => {
    await requestCompletions("/mod");
    replyCompletions([{ value: "/model" }]);
    await tick();
    clearSent();
    key(el("#chat-input"), "Enter");
    await tick();
    expect(sent("send")).toHaveLength(0);
    expect((el("#chat-input") as unknown as { value: string }).value).toBe("/model");
    expect(document.querySelector("#completion-menu")).toBeNull();
  });

  it("mousedown on an option accepts it; blur dismisses", async () => {
    await requestCompletions("/mod");
    replyCompletions([{ value: "/model" }]);
    await tick();
    menuItems()[0]!.dispatchEvent({ type: "mousedown", preventDefault: () => {} } as unknown as Event);
    await tick();
    expect((el("#chat-input") as unknown as { value: string }).value).toBe("/model");

    await requestCompletions("/mod");
    replyCompletions([{ value: "/model" }]);
    await tick();
    expect(menuItems()).toHaveLength(1);
    el("#chat-input").dispatchEvent(new Event("blur"));
    await tick();
    expect(document.querySelector("#completion-menu")).toBeNull();
  });

  it("an empty option list closes the menu", async () => {
    await requestCompletions("/mod");
    replyCompletions([]);
    await tick();
    expect(document.querySelector("#completion-menu")).toBeNull();
  });

  it("a reply invalidated by an edit is dropped", async () => {
    await requestCompletions("/mod");
    const req = sent<{ requestId: number }>("complete")[0]!;
    // Any composer edit dismisses the menu and bumps the completion token;
    // the in-flight reply must then reopen nothing.
    setComposer("/mode");
    el("#chat-input").dispatchEvent(new Event("input"));
    ws.fireMessage({ type: "completions", requestId: req.requestId, prefix: "/mod", options: [{ value: "/model" }] });
    await tick();
    expect(document.querySelector("#completion-menu")).toBeNull();
  });
});

// ── Attachments ─────────────────────────────────────────────────────────────

describe("attachments", () => {
  const makeFile = (name: string, type: string, size: number): unknown => ({ name, type, size });

  function dropAll(): void {
    els(".attachment-remove").forEach((b) => b.click());
  }

  async function pick(files: unknown[]): Promise<void> {
    dropAll();
    const fileInput = el("#file-input");
    (fileInput as unknown as { files: unknown[] }).files = files;
    fileInput.dispatchEvent({ type: "change", currentTarget: fileInput } as unknown as Event);
    await tick();
  }

  it("Attach button opens the file picker", () => {
    const fileInput = el("#file-input");
    let opened = 0;
    (fileInput as unknown as { click: () => void }).click = () => {
      opened++;
    };
    el("#attach-btn").click();
    expect(opened).toBe(1);
  });

  it("Attach button is an SVG paperclip with an aria-label", () => {
    const btn = el("#attach-btn");
    expect(btn.getAttribute("aria-label")).toBe("Attach files to the next message");
    // The icon only renders because the JSX runtime mounts the <svg> subtree
    // via createElementNS; assert the mounted node really is namespaced.
    const svg = btn.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(svg!.namespaceURI).toBe(SVG_NS);
    expect(svg!.querySelector("path")!.namespaceURI).toBe(SVG_NS);
    expect(svg!.getAttribute("aria-hidden")).toBe("true");
  });

  it("picked files become chips with size labels; empty files are skipped", async () => {
    await pick([makeFile("a.txt", "text/plain", 2048), makeFile("empty.txt", "text/plain", 0)]);
    const chips = els(".attachment-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.querySelector(".attachment-name")!.textContent).toBe("a.txt");
    expect(chips[0]!.querySelector(".attachment-size")!.textContent).toBe("2.0 KB");
    expect(el("#file-input").getAttribute("value")).not.toBe("a.txt"); // input reset for re-pick
  });

  it("the staged set persists to storage (payload only; ids are per-boot)", async () => {
    await pick([makeFile("note.txt", "text/plain", 7)]);
    const raw = JSON.parse(store.get(ATTACHMENTS_STORAGE_KEY) ?? "[]");
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ name: "note.txt", mimeType: "text/plain", size: 7 });
    expect(raw[0].id).toBeUndefined();
    dropAll();
    await tick();
    expect(store.has(ATTACHMENTS_STORAGE_KEY)).toBe(false);
  });

  it("the remove button drops a chip", async () => {
    await pick([makeFile("b.bin", "", 1024 * 1024)]);
    expect(els(".attachment-chip")).toHaveLength(1);
    expect(els(".attachment-size")[0]!.textContent).toBe("1.0 MB");
    els(".attachment-remove")[0]!.click();
    await tick();
    expect(els(".attachment-chip")).toHaveLength(0);
  });

  it("sending with attachments ships files and never takes the slash path", async () => {
    await pick([makeFile("note.txt", "text/plain", 512)]);
    setComposer("/not-a-command");
    clearSent();
    await submitComposer();
    const [msg] = sent<{ content: string; files: Array<{ name: string; mimeType: string }> }>("send");
    expect(msg?.content).toBe("/not-a-command");
    expect(msg?.files?.[0]?.name).toBe("note.txt");
    expect(sent("command")).toHaveLength(0);
    expect(els(".attachment-chip")).toHaveLength(0);
    expect(store.has(ATTACHMENTS_STORAGE_KEY)).toBe(false); // sent: never resurrected
  });

  it("a lone attachment sends even with no text", async () => {
    await pick([makeFile("only.txt", "text/plain", 1)]);
    setComposer("   ");
    clearSent();
    await submitComposer();
    const [msg] = sent<{ content: string; files: unknown[] }>("send");
    expect(msg?.files).toHaveLength(1);
  });

  it("size grammar: bytes, KB with one decimal, MB with one decimal", async () => {
    await pick([makeFile("tiny.bin", "x", 5), makeFile("k.bin", "x", 1536), makeFile("m.bin", "x", 3 * 1024 * 1024)]);
    expect(els(".attachment-size").map((n) => n.textContent)).toEqual(["5 B", "1.5 KB", "3.0 MB"]);
    await tick();
  });

  // ── Paste & drag-drop ─────────────────────────────────────────────────────

  function paste(clipboard: { types: string[]; files: unknown[]; text?: string }): { prevented: boolean } {
    const input = el("#chat-input");
    const state = { prevented: false };
    input.dispatchEvent({
      type: "paste",
      currentTarget: input,
      clipboardData: {
        types: clipboard.types,
        files: clipboard.files,
        getData: (kind: string) => (kind === "text/plain" ? clipboard.text ?? "" : ""),
      },
      preventDefault: () => {
        state.prevented = true;
      },
    } as unknown as Event);
    return state;
  }

  function dragForm(type: string, dt: { types: string[]; files?: unknown[] }): { prevented: boolean } {
    const form = el("#chat-form");
    const state = { prevented: false };
    form.dispatchEvent({
      type,
      currentTarget: form,
      dataTransfer: dt,
      preventDefault: () => {
        state.prevented = true;
      },
      stopPropagation: () => {},
    } as unknown as Event);
    return state;
  }

  it("pasted files attach and the paste is intercepted", async () => {
    dropAll();
    await tick();
    const r = paste({ types: ["Files"], files: [makeFile("shot.png", "image/png", 64)] });
    expect(r.prevented).toBe(true);
    await tick();
    expect(els(".attachment-chip")).toHaveLength(1);
    expect(els(".attachment-name")[0]!.textContent).toBe("shot.png");
  });

  it("an anonymous pasted screenshot gets a timestamped name", async () => {
    dropAll();
    await tick();
    paste({ types: ["Files"], files: [makeFile("blob", "image/png", 32)] });
    await tick();
    expect(els(".attachment-name")[0]!.textContent).toMatch(/^pasted-\d{4}-\d{2}-\d{2}-\d{2}-\d{2}-\d{2}\.png$/);
  });

  it("a mixed text+file paste keeps both", async () => {
    dropAll();
    await tick();
    setComposer("");
    paste({ types: ["Files", "text/plain"], files: [makeFile("d.txt", "text/plain", 8)], text: "look: " });
    await tick();
    expect((el("#chat-input") as unknown as { value: string }).value).toBe("look: ");
    expect(els(".attachment-chip")).toHaveLength(1);
  });

  it("plain-text paste is left to the browser", () => {
    const r = paste({ types: ["text/plain"], files: [], text: "hello" });
    expect(r.prevented).toBe(false);
  });

  it("dragging files highlights the composer; drop attaches and clears it", async () => {
    dropAll();
    await tick();
    const files = [makeFile("drop.txt", "text/plain", 16)];
    const dt = { types: ["Files"], files };
    dragForm("dragenter", dt);
    expect(el("#chat-form").classList.contains("drag-over")).toBe(true);
    expect(dragForm("dragover", dt).prevented).toBe(true);
    const dropped = dragForm("drop", dt);
    expect(dropped.prevented).toBe(true);
    expect(el("#chat-form").classList.contains("drag-over")).toBe(false);
    await tick();
    expect(els(".attachment-chip")).toHaveLength(1);
    expect(els(".attachment-name")[0]!.textContent).toBe("drop.txt");
  });

  it("dragcancel clears the highlight so the next drag starts clean", async () => {
    const dt = { types: ["Files"], files: [] };
    dragForm("dragenter", dt);
    dragForm("dragenter", dt); // nested crossing: depth 2
    dragForm("dragcancel", dt);
    expect(el("#chat-form").classList.contains("drag-over")).toBe(false);
    dragForm("dragenter", dt);
    expect(el("#chat-form").classList.contains("drag-over")).toBe(true);
    dragForm("dragcancel", dt);
  });

  it("dragleave for a non-file drag and a stray drop without files are inert", () => {
    const before = els(".attachment-chip").length;
    dragForm("dragleave", { types: ["text/plain"] });
    expect(el("#chat-form").classList.contains("drag-over")).toBe(false);
    expect(dragForm("drop", { types: ["text/plain"], files: [] }).prevented).toBe(false);
    expect(els(".attachment-chip")).toHaveLength(before);
  });
});

// ── Push-to-talk ────────────────────────────────────────────────────────────

describe("push-to-talk", () => {
  const mousedownMic = (): void => {
    el("#mic-btn").dispatchEvent({ type: "mousedown", preventDefault: () => {} } as unknown as Event);
  };
  const release = (): void => {
    document.dispatchEvent({ type: "mouseup" } as unknown as Event);
  };

  it("no mediaDevices: a system notice, never a crash", async () => {
    await attach();
    // Keep `navigator` defined (browsers always have it) but strip capture.
    Object.defineProperty(g, "navigator", { value: {}, configurable: true, writable: true });
    delete g.MediaRecorder;
    clearSent();
    mousedownMic();
    await tick(2);
    expect(el("#message-list").textContent).toContain("secure context");
    expect(document.querySelector("#mic-btn.recording")).toBeNull();
  });

  it("denied permission: mic unavailable notice", async () => {
    stubMic({ deny: true });
    mousedownMic();
    await tick(2);
    expect(el("#message-list").textContent).toContain("permission denied");
  });

  it("released while permission is pending: tracks stop, nothing records", async () => {
    const mic = stubMic({ pending: true });
    mousedownMic();
    release(); // lands before the permission promise resolves
    mic.resolve();
    await tick(2);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    // Idle is glyph-only; the name rides aria-label + title, the glyph is
    // the aria-hidden svg.
    expect(el("#mic-btn").textContent).toBe("");
    expect(el("#mic-btn").getAttribute("aria-label")).toBe(
      "Hold to record; the transcript is inserted into the input",
    );
    expect(el("#mic-btn").querySelector("svg[aria-hidden='true']")).toBeTruthy();
  });

  it("empty recording: back to idle with no transcribe", async () => {
    stubMic({ chunkSize: 0 });
    mousedownMic();
    await tick(2);
    expect(el("#mic-btn").textContent).toBe("● Recording");
    release();
    await tick(3);
    expect(el("#mic-btn").textContent).toBe("");
    expect(sent("transcribe")).toHaveLength(0);
  });

  it("full round trip: record, transcribe, transcript inserted at the caret", async () => {
    stubMic({ chunkSize: 4 });
    setComposer("hello ");
    const box = el("#chat-input");
    (box as unknown as { selectionStart: number | null; selectionEnd: number | null }).selectionStart = 6;
    (box as unknown as { selectionStart: number | null; selectionEnd: number | null }).selectionEnd = 6;

    mousedownMic();
    await tick(2);
    release();
    await tick(2);
    const req = sent<{ id: string; mimeType: string }>("transcribe")[0]!;
    expect(req.mimeType).toContain("audio/");
    expect(el("#mic-btn").textContent).toBe("..."); // transcribing phase
    ws.fireMessage({ type: "transcript", id: req.id, ok: true, text: "dictated words" });
    await tick(2);
    expect((el("#chat-input") as unknown as { value: string }).value).toBe("hello dictated words");
    expect(el("#mic-btn").textContent).toBe("");
  });

  it("failed transcription lands as a system message", async () => {
    stubMic({ chunkSize: 4 });
    clearSent();
    mousedownMic();
    await tick(2);
    release();
    await tick(2);
    const req = sent<{ id: string }>("transcribe")[0]!;
    ws.fireMessage({ type: "transcript", id: req.id, ok: false, error: "backend down" });
    await tick(2);
    expect(el("#message-list").textContent).toContain("backend down");
    expect(el("#mic-btn").textContent).toBe("");
  });
});

// ── Profile / model comboboxes (searchable dropdowns) ──────────────────────
// The controls replaced their native <select>s; these pins ARE the contract:
// open (click/keyboard), live substring filter, arrow highlight + Enter
// dispatch (exactly once), Escape keeps the value, outside mousedown closes
// clean, same-value no-op, server pushes move the display. The switch paths
// underneath are the native selects' own (chat.switchProfile / the /model
// slash command) -- the frame shapes are pinned here end to end.

const comboFilter = (): HTMLElement => el(".combobox-filter");
const comboOptions = (id: string): HTMLElement[] => els(`#${id}-list [role=option]`);
const comboOpen = (): HTMLElement | null => document.querySelector(".combobox-popup");
function typeFilter(text: string): void {
  const filter = comboFilter() as unknown as { value: string };
  filter.value = text;
  (filter as unknown as EventTarget).dispatchEvent({ type: "input", currentTarget: filter } as unknown as Event);
}

describe("profile / model comboboxes (searchable dropdowns)", () => {
  it("click opens: listbox + options + a11y flags, and the caret lands in the filter", async () => {
    await attach();
    const trigger = el("#profile-select");
    expect(trigger.getAttribute("aria-haspopup")).toBe("listbox");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.getAttribute("aria-label")).toBe("Profile");
    trigger.click();
    await tick();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe("profile-select-list");
    expect(el("#profile-select-list").getAttribute("role")).toBe("listbox");
    expect(comboOptions("profile-select").map((o) => o.textContent)).toEqual(["manager", "coder"]);
    // The current value enters selected AND highlighted (a bare Enter re-picks
    // it -- the native "open and press Enter does nothing" shape).
    expect(comboOptions("profile-select")[0]!.getAttribute("aria-selected")).toBe("true");
    expect(comboOptions("profile-select")[0]!.classList.contains("active")).toBe(true);
    // Keyboard-only operation: the popup took the caret to its filter input.
    expect(document.activeElement).toBe(comboFilter());
    // Trigger click toggles closed (same control, same value, nothing sent).
    clearSent();
    trigger.click();
    await tick();
    expect(comboOpen()).toBeNull();
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(sent("switchProfile")).toHaveLength(0);
    // Keyboard-only re-open: ArrowDown on the trigger (Enter/Space open via
    // the button's native click activation, which .click() above already
    // exercised).
    key(trigger, "ArrowDown");
    await tick();
    expect(comboOpen()).not.toBeNull();
    expect(document.activeElement).toBe(comboFilter());
    key(comboFilter(), "Escape");
    await tick();
    expect(comboOpen()).toBeNull();
  });

  it("typing filters live (case-insensitive substring); the control keeps its real value", async () => {
    await attach();
    el("#model-select").click();
    await tick();
    typeFilter("M2");
    await tick();
    expect(comboOptions("model-select").map((o) => o.textContent)).toEqual(["m2"]);
    // Filtering never mutates the control: the trigger still shows m1, and a
    // current value that no longer matches the filter IS still the value.
    expect(el("#model-select").textContent).toBe("m1");
    typeFilter("nothing-matches");
    await tick();
    expect(comboOptions("model-select")).toHaveLength(0);
    expect(comboOpen()).not.toBeNull();
    expect(el("#model-select").textContent).toBe("m1");
    typeFilter("");
    await tick();
    expect(comboOptions("model-select")).toHaveLength(2);
    key(comboFilter(), "Escape");
    await tick();
    expect(comboOpen()).toBeNull();
    expect(sent("command")).toHaveLength(0);
  });

  it("ArrowDown + Enter dispatches the profile switch EXACTLY once, then focus is back", async () => {
    await attach();
    clearSent();
    el("#profile-select").click();
    await tick();
    key(comboFilter(), "ArrowDown");
    await tick();
    // Highlight (not native focus) moves; exactly one option carries it.
    expect(comboOptions("profile-select").map((o) => o.classList.contains("active"))).toEqual([
      false,
      true,
    ]);
    expect(comboFilter().getAttribute("aria-activedescendant")).toBe("profile-select-opt-1");
    key(comboFilter(), "Enter");
    await tick();
    const msgs = sent<{ profileName: string }>("switchProfile");
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.profileName).toBe("coder");
    expect(comboOpen()).toBeNull();
    expect(el("#profile-select").textContent).toBe("manager"); // display follows the SERVER, not the click
    expect(document.activeElement).toBe(el("#profile-select"));
  });

  it("ArrowUp wraps, and Enter on the already-current value is a no-op (native change parity)", async () => {
    await attach();
    clearSent();
    el("#profile-select").click();
    await tick();
    key(comboFilter(), "ArrowUp"); // from index 0 wrap to the last option
    await tick();
    const opts = comboOptions("profile-select");
    expect(opts.map((o) => o.classList.contains("active"))).toEqual([false, true]);
    // Wrap back down onto the current value and Enter: close WITHOUT a wire.
    key(comboFilter(), "ArrowDown");
    await tick();
    key(comboFilter(), "Enter");
    await tick();
    expect(sent("switchProfile")).toHaveLength(0);
    expect(comboOpen()).toBeNull();
    expect(el("#profile-select").textContent).toBe("manager");
  });

  it("option mousedown selects, closes, and rides the existing slash command once", async () => {
    await attach();
    clearSent();
    el("#model-select").click();
    await tick();
    typeFilter("2");
    await tick();
    const opt = comboOptions("model-select")[0]!;
    opt.dispatchEvent({ type: "mousedown", preventDefault: () => {} } as unknown as Event);
    await tick();
    const cmds = sent<{ command: string }>("command");
    expect(cmds).toHaveLength(1);
    expect(cmds[0]!.command).toBe("/model m2");
    expect(comboOpen()).toBeNull();
    // Double-fire guard: in a real browser the picking mousedown is followed
    // by a click on the same press. The options carry NO click listener (the
    // pick is mousedown-only, completion-menu idiom), so the trailing click
    // dispatches nothing.
    opt.dispatchEvent({ type: "click" } as unknown as Event);
    await tick();
    expect(sent("command")).toHaveLength(1);
    expect(el("#model-select").textContent).toBe("m1"); // display waits for the server like before
  });

  it("Escape closes without changing the value -- never commits, even on a NON-current highlight", async () => {
    await attach();
    clearSent();
    el("#profile-select").click();
    await tick();
    // The mutation this pin exists for: Escape routed to the pick path. A
    // filter that matched only the CURRENT value (or nothing) would make
    // that commit a same-value no-op and the test vacuous -- so filter onto
    // a NOT-current option and prove the highlight is genuinely on it:
    // "cod" leaves one option (coder), and typing resets the highlight to
    // it while the control's value is still manager.
    typeFilter("cod");
    await tick();
    expect(comboOptions("profile-select").map((o) => o.textContent)).toEqual(["coder"]);
    expect(comboOptions("profile-select")[0]!.classList.contains("active")).toBe(true);
    expect(comboFilter().getAttribute("aria-activedescendant")).toBe("profile-select-opt-0");
    expect(el("#profile-select").textContent).toBe("manager");
    key(comboFilter(), "Escape");
    await tick();
    expect(comboOpen()).toBeNull();
    expect(el("#profile-select").textContent).toBe("manager");
    expect(sent("switchProfile")).toHaveLength(0);
    expect(document.activeElement).toBe(el("#profile-select"));
  });

  it("mousedown outside closes without a change; mousedown inside does not", async () => {
    await attach();
    clearSent();
    el("#model-select").click();
    await tick();
    // Inside: the filter input itself.
    document.dispatchEvent({ type: "mousedown", target: comboFilter() } as unknown as Event);
    expect(comboOpen()).not.toBeNull();
    // Outside: anywhere else.
    document.dispatchEvent({ type: "mousedown", target: document.body } as unknown as Event);
    await tick();
    expect(comboOpen()).toBeNull();
    expect(sent("command")).toHaveLength(0);
    expect(el("#model-select").textContent).toBe("m1");
  });

  it("opening one control closes the other (one popup app-wide)", async () => {
    await attach();
    el("#profile-select").click();
    await tick();
    // The real browser's sequence: mousedown lands outside the open popup
    // first (closes it), then the click opens the new one.
    document.dispatchEvent({
      type: "mousedown",
      target: el("#model-select"),
    } as unknown as Event);
    await tick();
    expect(comboOpen()).toBeNull();
    el("#model-select").click();
    await tick();
    expect(comboOptions("model-select")).toHaveLength(2);
    key(comboFilter(), "Escape");
    await tick();
  });

  it("server pushes move the control display (external value sync)", async () => {
    await attach();
    expect(el("#profile-select").textContent).toBe("manager");
    ws.fireMessage({ type: "profileSwitched", sessionId: SID, profile: "coder", success: true });
    await tick();
    expect(el("#profile-select").textContent).toBe("coder");
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "model", value: "m2" });
    await tick();
    expect(el("#model-select").textContent).toBe("m2");
    // A push while OPEN repaints the trigger too (the filter text is its own
    // space; the control's display is server truth either way). Escape here
    // also lands on a NON-current highlight (filter "cod" highlighted coder,
    // the push moved the value back to manager): zero wire after it is the
    // second face of the Escape-never-commits pin.
    clearSent();
    el("#profile-select").click();
    await tick();
    typeFilter("cod");
    ws.fireMessage({ type: "profileSwitched", sessionId: SID, profile: "manager", success: true });
    await tick();
    expect(el("#profile-select").textContent).toBe("manager");
    key(comboFilter(), "Escape");
    await tick();
    expect(comboOpen()).toBeNull();
    expect(sent("switchProfile")).toHaveLength(0);
    // Put the fixture back for the sections behind this one.
    await attach();
  });
});

describe("composer send steering", () => {
  it("every webui send carries steering: true (the switch retired; the wire shape did not move)", async () => {
    // The composer's send site passes steer=true unconditionally; chat.ts
    // still ADDS the field conditionally (its default false is for other
    // callers), so the frame matches the old steer-checked case.
    await attach();
    setComposer("first line");
    clearSent();
    await submitComposer();
    setComposer("second line");
    await submitComposer();
    const sends = sent<{ steering?: boolean }>("send");
    expect(sends).toHaveLength(2);
    expect(sends.every((m) => m.steering === true)).toBe(true);
  });
});

// ── Sidebar glue ────────────────────────────────────────────────────────────

describe("sidebar glue", () => {
  it("the create button asks for a new session", async () => {
    clearSent();
    el("#new-session-btn").click();
    await tick();
    expect(sent("createSession")).toHaveLength(1);
  });

  it("clicking the attached row is a no-op; another row switches", async () => {
    await attach();
    clearSent();
    els(".session-item")[0]!.click();
    expect(sent("switchSession")).toHaveLength(0);

    ws.fireMessage({ type: "sessions", sessions: [sessionRow, { ...sessionRow, id: "s-ui-0002" }] });
    await tick();
    clearSent();
    els(".session-item")[1]!.click();
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe("s-ui-0002");
    ws.fireMessage({ type: "sessions", sessions: [sessionRow] });
    await tick();
  });

  it("a working row re-polls sessions and its Cancel sends the cancel", async () => {
    clearSent();
    ws.fireMessage({ type: "sessionState", sessionId: "s-other-1", key: "working", value: true });
    ws.fireMessage({ type: "sessions", sessions: [sessionRow, { ...sessionRow, id: "s-other-1" }] });
    await tick();
    expect(sent("listSessions").length).toBeGreaterThan(0); // workingMapChange re-poll
    clearSent();
    els(".session-cancel-btn")[0]!.click();
    const [c] = sent<{ sessionId: string }>("cancel");
    expect(c?.sessionId).toBe("s-other-1");
    ws.fireMessage({ type: "sessions", sessions: [sessionRow] });
    await tick();
  });

  it("the log menu's Resume loads the log as a session", async () => {
    // The inline card Resume was retired (owner 2026-11-09); this is now
    // the only resume path, so the menu item carries the old pin.
    clearSent();
    els(".log-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    els(".context-menu-item").find((b) => b.textContent === "Resume")!.click();
    await tick();
    expect(sent<{ logId: string }>("loadLog")[0]?.logId).toBe(L1);
    expect(document.querySelector(".context-menu")).toBeNull(); // dismissed after pick
  });

  it("the fence strip acts for the attached worker posture", async () => {
    ws.fireMessage({
      type: "sessionCreated",
      sessionId: SID,
      profile: "manager",
      title: null,
      currentModel: "m1",
      models: ["m1"],
      toolExec: "worker (fence: bwrap)",
    });
    await tick();
    clearSent();
    confirmSeen = [];
    el("#tool-exec-status").click();
    expect(confirmSeen.join()).toContain("Turn the exec fence OFF");
    expect(sent("execFence")).toEqual([{ type: "execFence", sessionId: SID, policy: "off" }]);

    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "toolExec", value: "worker (fence: off)" });
    await tick();
    clearSent();
    el("#tool-exec-status").click(); // off -> probe needs no confirm
    expect(sent("execFence")).toEqual([{ type: "execFence", sessionId: SID, policy: "probe" }]);
  });
});

// ── Sidebar resize ──────────────────────────────────────────────────────────

describe("sidebar resize", () => {
  const handle = () => {
    const h = el("#sidebar-resize");
    const any = h as unknown as Record<string, unknown>;
    any.offsetParent ??= {};
    any.setPointerCapture ??= () => {};
    return h;
  };

  const ariaNow = () => el("#sidebar-resize").getAttribute("aria-valuenow");

  it("drag updates the CSS var live and persists on release", async () => {
    handle();
    handle().dispatchEvent({ type: "pointerdown", pointerId: 1, clientX: 300, currentTarget: handle() } as unknown as Event);
    expect(document.body.classList.contains("sidebar-resizing")).toBe(true);
    handle().dispatchEvent({ type: "pointermove", pointerId: 1, clientX: 330, currentTarget: handle() } as unknown as Event);
    const docStyle = (document.documentElement as unknown as { style: { getPropertyValue: (n: string) => string } }).style;
    expect(docStyle.getPropertyValue("--sidebar-width")).toBe("330px");
    handle().dispatchEvent({ type: "pointerup", pointerId: 1, clientX: 330, currentTarget: handle() } as unknown as Event);
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
    expect(store.get("hotdog.sidebarWidth")).toBe("330");
    await tick();
  });

  it("moves/ends from a different pointer are ignored", () => {
    handle();
    handle().dispatchEvent({ type: "pointermove", pointerId: 99, clientX: 500, currentTarget: handle() } as unknown as Event);
    handle().dispatchEvent({ type: "pointerup", pointerId: 99, currentTarget: handle() } as unknown as Event);
    // (no drag active for id 99: nothing threw, width unchanged)
    const docStyle = (document.documentElement as unknown as { style: { getPropertyValue: (n: string) => string } }).style;
    expect(docStyle.getPropertyValue("--sidebar-width")).toBe("330px");
  });

  it("keys step and jump to the clamp limits; unrelated keys do nothing", async () => {
    key(el("#sidebar-resize"), "ArrowRight", { currentTarget: el("#sidebar-resize") });
    expect(ariaNow()).toBe("346");
    key(el("#sidebar-resize"), "ArrowLeft", { shiftKey: true, currentTarget: el("#sidebar-resize") });
    expect(ariaNow()).toBe("298");
    key(el("#sidebar-resize"), "End", { currentTarget: el("#sidebar-resize") });
    expect(ariaNow()).toBe("720"); // End names the static 780; the 0.6x1200 viewport cap binds first
    key(el("#sidebar-resize"), "Home", { currentTarget: el("#sidebar-resize") });
    expect(ariaNow()).toBe("200");
    key(el("#sidebar-resize"), "a", { currentTarget: el("#sidebar-resize") });
    expect(ariaNow()).toBe("200");
    expect(store.get("hotdog.sidebarWidth")).toBe("200");
    await tick();
  });

  it("double-click resets to the default and forgets the stored width", () => {
    el("#sidebar-resize").dispatchEvent({ type: "dblclick", currentTarget: el("#sidebar-resize") } as unknown as Event);
    const docStyle = (document.documentElement as unknown as { style: { getPropertyValue: (n: string) => string } }).style;
    expect(docStyle.getPropertyValue("--sidebar-width")).toBe("300px");
    expect(store.has("hotdog.sidebarWidth")).toBe(false);
  });

  it("the 0.6 viewport fraction binds, and a wide viewport lifts End to the new static max", () => {
    // Wide screen: 0.6*2000 = 1200 sits above the static 780, so End reaches it.
    win.innerWidth = 2000;
    key(el("#sidebar-resize"), "End", { currentTarget: el("#sidebar-resize") });
    expect(ariaNow()).toBe("780");
    // Back on the stubbed 1200 viewport the fraction caps again (min(780, 720)).
    win.innerWidth = 1200;
    key(el("#sidebar-resize"), "End", { currentTarget: el("#sidebar-resize") });
    expect(ariaNow()).toBe("720");
    // Leave the panel at the default for the rest of the suite (also forgets).
    el("#sidebar-resize").dispatchEvent({ type: "dblclick", currentTarget: el("#sidebar-resize") } as unknown as Event);
    expect(ariaNow()).toBe("300");
  });

  it("a hidden handle (mobile drawer) is inert", () => {
    const h = el("#sidebar-resize");
    (h as unknown as Record<string, unknown>).offsetParent = null;
    h.dispatchEvent({ type: "pointerdown", pointerId: 7, clientX: 0, currentTarget: h } as unknown as Event);
    expect(document.body.classList.contains("sidebar-resizing")).toBe(false);
    delete (h as unknown as Record<string, unknown>).offsetParent;
  });
});

// ── Recent Logs: collapse + vertical resize ────────────────────────────────
// The same seam, one axis over, driven through the mounted app: the titlebar
// rides the list's TOP edge, so the pointer and the height move opposite ways
// (drag up = taller). Keys: ArrowUp grows. Storage rides its own two keys, and
// the collapse button owns its own gestures.

const logsBar = () => {
  const b = el(".sidebar-header-secondary");
  const any = b as unknown as Record<string, unknown>;
  any.offsetParent ??= {};
  any.setPointerCapture ??= () => {};
  return b;
};
const logsHeightVar = (): string =>
  (document.documentElement as unknown as { style: { getPropertyValue: (n: string) => string } }).style.getPropertyValue(
    "--logs-height",
  );
const logsPointer = (type: string, over: Record<string, unknown> = {}): void => {
  const b = logsBar();
  b.dispatchEvent({ type, currentTarget: b, ...over } as unknown as Event);
};
const logsAria = (): string | null => el(".sidebar-header-secondary").getAttribute("aria-valuenow");

describe("Recent Logs section", () => {
  it("the titlebar starts as the handle and the chevron starts expanded", () => {
    expect(logsAria()).toBe("240");
    expect(el(".sidebar-header-secondary").getAttribute("role")).toBe("separator");
    expect(el("#logs-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(el("#sidebar").classList.contains("logs-collapsed")).toBe(false);
  });

  it("dragging the titlebar UP grows the list, release persists", () => {
    logsPointer("pointerdown", { pointerId: 1, clientY: 500 });
    expect(document.body.classList.contains("logs-resizing")).toBe(true);
    logsPointer("pointermove", { pointerId: 1, clientY: 460 });
    expect(logsHeightVar()).toBe("280px"); // 240 + (500 - 460): near-edge, so up grows
    expect(store.has("hotdog.logsHeight")).toBe(false); // nothing written mid-drag
    logsPointer("pointerup", { pointerId: 1, clientY: 460 });
    expect(document.body.classList.contains("logs-resizing")).toBe(false);
    expect(store.get("hotdog.logsHeight")).toBe("280");
    expect(logsAria()).toBe("280");
  });

  it("dragging DOWN shrinks it, and the clamp floor holds", () => {
    logsPointer("pointerdown", { pointerId: 2, clientY: 460 });
    logsPointer("pointermove", { pointerId: 2, clientY: 520 });
    expect(logsHeightVar()).toBe("220px");
    logsPointer("pointermove", { pointerId: 2, clientY: 5000 });
    expect(logsHeightVar()).toBe("96px"); // LOGS_MIN_HEIGHT
    logsPointer("pointerup", { pointerId: 2, clientY: 5000 });
    expect(store.get("hotdog.logsHeight")).toBe("96");
  });

  it("keys resize it (ArrowUp grows) and Home/End clamp; the reset forgets", async () => {
    logsBar().dispatchEvent({ type: "dblclick", currentTarget: logsBar() } as unknown as Event);
    expect(logsHeightVar()).toBe("240px");
    expect(store.has("hotdog.logsHeight")).toBe(false);
    key(logsBar(), "ArrowUp", { currentTarget: logsBar() });
    expect(logsAria()).toBe("256");
    key(logsBar(), "ArrowDown", { shiftKey: true, currentTarget: logsBar() });
    expect(logsAria()).toBe("208");
    key(logsBar(), "End", { currentTarget: logsBar() });
    expect(logsAria()).toBe("680"); // min(900, stubbed 900 - LOGS_VIEWPORT_RESERVE 220)
    key(logsBar(), "Home", { currentTarget: logsBar() });
    expect(logsAria()).toBe("96");
    key(logsBar(), "a", { currentTarget: logsBar() });
    expect(logsAria()).toBe("96");
    expect(store.get("hotdog.logsHeight")).toBe("96");
    logsBar().dispatchEvent({ type: "dblclick", currentTarget: logsBar() } as unknown as Event);
    expect(logsHeightVar()).toBe("240px");
    expect(store.has("hotdog.logsHeight")).toBe(false);
    await tick();
  });

  it("the chevron collapses the section and keeps the height the user left", async () => {
    logsPointer("pointerdown", { pointerId: 3, clientY: 300 });
    logsPointer("pointermove", { pointerId: 3, clientY: 268 });
    logsPointer("pointerup", { pointerId: 3, clientY: 268 });
    expect(store.get("hotdog.logsHeight")).toBe("272");
    el("#logs-toggle").click();
    await tick();
    expect(el("#sidebar").classList.contains("logs-collapsed")).toBe(true);
    expect(el("#logs-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(store.get("hotdog.logsCollapsed")).toBe("1");
    // A collapsed section has no height to drag: the gestures are inert.
    logsPointer("pointerdown", { pointerId: 4, clientY: 300 });
    expect(document.body.classList.contains("logs-resizing")).toBe(false);
    key(logsBar(), "ArrowUp", { currentTarget: logsBar() });
    expect(logsAria()).toBeNull(); // the handle semantics are gone while collapsed
    expect(store.get("hotdog.logsHeight")).toBe("272");
    // Expand: the user's height rides along (the var was never touched).
    el("#logs-toggle").click();
    await tick();
    expect(el("#sidebar").classList.contains("logs-collapsed")).toBe(false);
    expect(logsAria()).toBe("272");
    expect(logsHeightVar()).toBe("272px");
    expect(store.get("hotdog.logsCollapsed")).toBe("0");
    // Leave the section as the app shipped it for the suites below.
    logsBar().dispatchEvent({ type: "dblclick", currentTarget: logsBar() } as unknown as Event);
    expect(logsHeightVar()).toBe("240px");
  });

  it("a gesture on the chevron is never a drag or a reset", () => {
    const toggle = el("#logs-toggle");
    toggle.dispatchEvent({ type: "pointerdown", pointerId: 5, clientY: 300, currentTarget: toggle } as unknown as Event);
    expect(document.body.classList.contains("logs-resizing")).toBe(false);
    toggle.dispatchEvent({ type: "dblclick", currentTarget: toggle } as unknown as Event);
    expect(logsHeightVar()).toBe("240px");
  });

  it("a cold search hit reveals a collapsed list before scrolling to the row", async () => {
    // scrollHitIntoView has no scroll box to reveal a row in while the section
    // is collapsed, so onActivateHit expands it first (the height the user left
    // rides along untouched).
    el("#logs-toggle").click();
    await tick();
    expect(el("#sidebar").classList.contains("logs-collapsed")).toBe(true);

    el("#search-btn").click();
    await tick();
    const input = el("#search-input");
    (input as unknown as { value: string }).value = "needle";
    input.dispatchEvent({ type: "input", currentTarget: input } as unknown as Event);
    await sleep(300); // the search debounce
    const [req] = sent<{ requestId: number }>("searchLogs");
    expect(req?.requestId).toBeNumber();
    ws.fireMessage({
      type: "searchResults",
      requestId: req!.requestId,
      query: "needle",
      results: [{ logId: L1, lastActivityAt: 2, matchCount: 1, profile: "manager", live: false, snippets: ["a needle line"] }],
    });
    await tick();
    el(".search-hit").click();
    await tick();
    expect(el("#sidebar").classList.contains("logs-collapsed")).toBe(false);
    expect(el("#logs-toggle").getAttribute("aria-expanded")).toBe("true");
    const row = els(".log-item").find((r) => r.getAttribute("data-sid") === L1);
    expect(row).toBeDefined();
    expect((row as unknown as { scrollIntoViewCalls: unknown[] }).scrollIntoViewCalls).toEqual([{ block: "nearest" }]);
    // Revealing is a collapse-flag write only: the height the user left (here,
    // none) is never rewritten, and the section stays expanded below.
    expect(store.has("hotdog.logsHeight")).toBe(false);
    expect(store.get("hotdog.logsCollapsed")).toBe("0");
  });
});

// ── RECENT LOGS lazy window (older pages on the bottom edge) ───────────────

describe("Recent Logs lazy window: older pages on the bottom edge", () => {
  const winRow = (id: string, ts: number, extra: Record<string, unknown> = {}) => ({
    id,
    createdAt: ts,
    lastActivityAt: ts,
    messageCount: 1,
    ...extra,
  });
  const logIds = (): string[] => els("#log-list .log-item").map((r) => r.getAttribute("data-sid") ?? "");
  const setScroll = (scrollTop: number): void => {
    const list = el("#log-list") as unknown as { scrollTop: number; clientHeight: number; scrollHeight: number };
    list.scrollTop = scrollTop;
    list.clientHeight = 240;
    list.scrollHeight = 1000; // 150px band starts at scrollTop 610
  };
  const fireScroll = (): void => {
    el("#log-list").dispatchEvent(new Event("scroll"));
  };

  async function baseFrame(): Promise<void> {
    ws.fireMessage({
      type: "logsListed",
      logs: [winRow("lw-1", 300), winRow("lw-2", 200)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 200, id: "lw-2" },
      pinnedLogs: [winRow("lw-9", 50, { pinned: true })],
    });
    await tick();
  }

  it("the base frame renders head + pinnedLogs (deduped, pinned floats up)", async () => {
    await attach();
    await baseFrame();
    expect(logIds()).toEqual(["lw-9", "lw-1", "lw-2"]);
    // The pinned tail row carries the real pin mark and floats above the
    // day rows (sortPinned): proof pinnedLogs merged into the list, not
    // just rendered from a side channel.
    const pinnedRow = els("#log-list .log-item").find((r) => r.getAttribute("data-sid") === "lw-9")!;
    expect(pinnedRow.querySelector(".row-pin")).toBeTruthy();
  });

  it("mid-list scroll fires nothing; bottom edge fires ONE loadOlderLogs; a second edge while in flight is inert", async () => {
    clearSent();
    setScroll(0);
    fireScroll();
    expect(sent("loadOlderLogs")).toHaveLength(0);
    setScroll(900);
    fireScroll();
    const reqs = sent<{ requestId: number; olderThan: unknown }>("loadOlderLogs");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.olderThan).toEqual({ lastActivityAt: 200, id: "lw-2" });
    fireScroll(); // in flight: the once-per-gap guard holds
    expect(sent("loadOlderLogs")).toHaveLength(1);
  });

  it("a stale requestId drops; the matching page appends and dedupes; the cursor re-attests; a refusal frees the slot", async () => {
    const rid = sent<{ requestId: number }>("loadOlderLogs")[0]!.requestId;
    ws.fireMessage({
      type: "loadOlderLogsResult",
      requestId: rid + 50, // a frame from a superseded request
      logs: [winRow("lw-ghost", 99)],
      hasOlder: true,
    });
    await tick();
    expect(logIds()).not.toContain("lw-ghost");
    fireScroll(); // still the same request in flight (stale reply changed nothing)
    expect(sent("loadOlderLogs")).toHaveLength(1);

    ws.fireMessage({
      type: "loadOlderLogsResult",
      requestId: rid,
      logs: [winRow("lw-3", 150), winRow("lw-1", 300)], // lw-1 repeats the head
      hasOlder: true,
      olderCursor: { lastActivityAt: 150, id: "lw-3" },
    });
    await tick();
    expect(logIds()).toEqual(["lw-9", "lw-1", "lw-2", "lw-3"]); // dup dropped, server order kept

    clearSent();
    setScroll(900);
    fireScroll();
    const req2 = sent<{ requestId: number; olderThan: unknown }>("loadOlderLogs")[0]!;
    expect(req2.olderThan).toEqual({ lastActivityAt: 150, id: "lw-3" }); // the PAGE's cursor, not the base one
    // Honest refusal: no rows, slot freed -- the next bottom edge retries.
    ws.fireMessage({ type: "loadOlderLogsResult", requestId: req2.requestId, error: "boom" });
    await tick();
    expect(logIds()).toEqual(["lw-9", "lw-1", "lw-2", "lw-3"]);
    fireScroll();
    expect(sent("loadOlderLogs")).toHaveLength(2);
    // Settle this one with a real last page (held rows: lw-3, lw-4).
    ws.fireMessage({
      type: "loadOlderLogsResult",
      requestId: sent<{ requestId: number }>("loadOlderLogs")[1]!.requestId,
      logs: [winRow("lw-4", 100)],
      hasOlder: false,
    });
    await tick();
    expect(logIds()).toEqual(["lw-9", "lw-1", "lw-2", "lw-3", "lw-4"]);
  });

  it("the base frame reconciles the held pages: fresh copies win, LIVE ids drop, deleted ids never resurrect", async () => {
    // lw-4 went LIVE (another tab hit Continue): the cold list must not
    // keep its held page copy.
    ws.fireMessage({
      type: "sessions",
      sessions: [sessionRow, { id: "lw-4", createdAt: 100, lastActivityAt: 100, connectedClients: 1 }],
    });
    await baseFrame();
    expect(logIds()).toEqual(["lw-9", "lw-1", "lw-2", "lw-3"]); // live id gone, unpinned held row kept
    ws.fireMessage({ type: "sessions", sessions: [sessionRow] });
    // lw-3 (a held page row) dies: logDeleted prunes the hold, so the next
    // base frame cannot resurrect it from memory.
    clearSent();
    ws.fireMessage({ type: "logDeleted", logId: "lw-3" });
    await tick();
    await baseFrame();
    expect(logIds()).toEqual(["lw-9", "lw-1", "lw-2"]);
    expect(sent("listLogs").length).toBeGreaterThan(0); // the existing refresh idiom still runs
  });

  it("a cold pin unpinned elsewhere loses its seat AND its mark: pinnedLogs is the complete attestation", async () => {
    await baseFrame(); // pins lw-9 via pinnedLogs
    expect(logIds()).toContain("lw-9");
    // Another tab unpinned it: the frame ships no pinnedLogs and lw-9 sits
    // past the head -- silence means gone: a windowed attestation carries no
    // unpinned flag for rows it omits.
    ws.fireMessage({
      type: "logsListed",
      logs: [winRow("lw-1", 300), winRow("lw-2", 200)],
      hasOlder: false,
    });
    await tick();
    expect(logIds()).not.toContain("lw-9");
    // And the mark itself: ship the row back INSIDE the head unpinned -- a
    // lingering pinnedIdsAtom entry would badge it and float it up.
    ws.fireMessage({
      type: "logsListed",
      logs: [winRow("lw-1", 300), winRow("lw-9", 50, { pinned: false }), winRow("lw-2", 200)],
      hasOlder: false,
    });
    await tick();
    const row9 = els("#log-list .log-item").find((r) => r.getAttribute("data-sid") === "lw-9")!;
    expect(row9).toBeTruthy();
    expect(row9.querySelector(".row-pin")).toBeNull();
  });

  it("an unattested mark dies while its row is OFF-screen, so a later page row rides plain", async () => {
    await baseFrame(); // lw-9 pinned via pinnedLogs; cursor at lw-2
    expect(logIds()).toContain("lw-9");
    // Unpinned elsewhere: the frame neither ships lw-9 nor attests it, and
    // the row is gone from the list -- a sweep over VISIBLE rows would leave
    // the mark orphaned, so the sweep runs over all marks.
    ws.fireMessage({
      type: "logsListed",
      logs: [winRow("lw-1", 300), winRow("lw-2", 200)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 200, id: "lw-2" },
    });
    await tick();
    expect(logIds()).not.toContain("lw-9");
    // The page now ships lw-9 unpinned (its ts sits below the cursor): plain
    // row at the tail, no badge, no float above the day rows.
    clearSent();
    setScroll(900);
    fireScroll();
    const rid = sent<{ requestId: number }>("loadOlderLogs")[0]!.requestId;
    ws.fireMessage({
      type: "loadOlderLogsResult",
      requestId: rid,
      logs: [winRow("lw-9", 50, { pinned: false })],
      hasOlder: false,
    });
    await tick();
    const ids = logIds();
    expect(ids[0]).not.toBe("lw-9");
    const row9 = els("#log-list .log-item").find((r) => r.getAttribute("data-sid") === "lw-9")!;
    expect(row9).toBeTruthy();
    expect(row9.querySelector(".row-pin")).toBeNull();
    ws.fireMessage({ type: "logDeleted", logId: "lw-9" }); // clear the held row for the suites below
    await tick();
  });

  it("an older page lands at its comparator place, not the tail: an older pinned row keeps its seat", async () => {
    ws.fireMessage({
      type: "logsListed",
      logs: [winRow("lp-1", 300)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 300, id: "lp-1" },
      pinnedLogs: [winRow("lp-p", 170, { pinned: true })],
    });
    await tick();
    clearSent();
    setScroll(900);
    fireScroll();
    const rid = sent<{ requestId: number }>("loadOlderLogs")[0]!.requestId;
    ws.fireMessage({
      type: "loadOlderLogsResult",
      requestId: rid,
      logs: [winRow("lp-2", 200), winRow("lp-3", 150)],
      hasOlder: false,
    });
    await tick();
    expect(logIds()).toEqual(["lp-p", "lp-1", "lp-2", "lp-3"]); // the float hides the merge
    ws.fireMessage({ type: "logPins", pinnedIds: [] });
    await tick();
    // Raw order: the page row NEWER than the pinned row slots above its seat;
    // a tail append (or a head re-anchor) buries it under rows older still.
    expect(logIds()).toEqual(["lp-1", "lp-2", "lp-p", "lp-3"]);
    // No held rows leak into the suites below.
    ws.fireMessage({ type: "logDeleted", logId: "lp-2" });
    ws.fireMessage({ type: "logDeleted", logId: "lp-3" });
    await tick();
  });

  it("a search hit OUTSIDE the window still opens (viewLog by id); the absent row no-ops and focus falls to the chip", async () => {
    clearSent();
    el("#search-btn").click();
    await tick();
    const input = el("#search-input");
    (input as unknown as { value: string }).value = "needle";
    input.dispatchEvent({ type: "input", currentTarget: input } as unknown as Event);
    await sleep(300); // the search debounce
    const [req] = sent<{ requestId: number }>("searchLogs");
    ws.fireMessage({
      type: "searchResults",
      requestId: req!.requestId,
      query: "needle",
      results: [{ logId: "lw-remote", lastActivityAt: 2, matchCount: 1, live: false, snippets: ["a needle line"] }],
    });
    await tick();
    el(".search-hit").click();
    await tick();
    // The read opens regardless of the window (the list hides, the log
    // stays addressable), and the missing sidebar row is a silent no-op
    // (scrollHitIntoView) -- focus falls back to the chip, nothing throws.
    expect(sent<{ logId: string }>("viewLog").some((m) => m.logId === "lw-remote")).toBe(true);
    expect(document.activeElement).toBe(el("#search-btn") as unknown as Element);
    expect(logIds()).not.toContain("lw-remote");

    // Leave the lists as the suites below expect.
    ws.fireMessage({ type: "logDeleted", logId: "lw-9" }); // drops its pin mark too
    await tick();
    ws.fireMessage({ type: "logsListed", logs: [logRow] });
    await tick();
    expect(logIds()).toEqual([L1]);
  });
});

// ── RECENT LOGS delta refreshes: gen watermark + targeted pushes ────────────
// The server posts two LOGS_LISTED postures (full / full:false) stamped with
// a "<boot>-<counter>" membership gen, plus the targeted logRowAdded /
// logRowRemoved pushes (+1 each) and the complete-set logPins frame. This
// section pins the client half: the watermark-gated delta PREPEND (seam held
// intact), the traceable full re-attest on a mismatch (exactly ONE bare
// listLogs, no `since`), the mid-list insert of an old-ts demote, the
// prune-through-held-pages with the value-based seam still walking, and the
// wholesale pin re-derive (off-screen marks included). Every delta posture
// also fires WITH the complete pinnedLogs: a re-shipped pinned row replaces
// its held row IN PLACE and never re-anchors at the head, because the merged
// total DESC order is what the mid-list INSERT reads. The pinned float hides
// that order in the render, so the raw-order assertions lift the mark with an
// empty logPins frame first.

describe("Recent Logs delta refreshes: gen watermark and targeted pushes", () => {
  const dRow = (id: string, ts: number, extra: Record<string, unknown> = {}) => ({
    id,
    createdAt: ts,
    lastActivityAt: ts,
    messageCount: 1,
    ...extra,
  });
  const logIds = (): string[] => els("#log-list .log-item").map((r) => r.getAttribute("data-sid") ?? "");
  const setScroll = (scrollTop: number): void => {
    const list = el("#log-list") as unknown as { scrollTop: number; clientHeight: number; scrollHeight: number };
    list.scrollTop = scrollTop;
    list.clientHeight = 240;
    list.scrollHeight = 1000; // 150px band starts at scrollTop 610
  };
  const fireScroll = (): void => {
    el("#log-list").dispatchEvent(new Event("scroll"));
  };

  it("a delta PREPENDS with the seam held; a gen mismatch re-attests full, exactly once", async () => {
    ws.fireMessage({
      type: "logsListed",
      logs: [dRow("dl-1", 300), dRow("dl-2", 200)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 200, id: "dl-2" },
      gen: "b-1",
    });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-2"]);

    // Delta (gen continues at +0): strictly-newer rows PREPEND; the held
    // paging seam is untouched (the frame ships none) -- proof: the bottom
    // edge still pages from the BASE frame's cursor.
    ws.fireMessage({ type: "logsListed", full: false, logs: [dRow("dl-3", 400)], gen: "b-1" });
    await tick();
    expect(logIds()).toEqual(["dl-3", "dl-1", "dl-2"]);
    clearSent();
    setScroll(900);
    fireScroll();
    const reqs = sent<{ requestId: number; olderThan: unknown }>("loadOlderLogs");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.olderThan).toEqual({ lastActivityAt: 200, id: "dl-2" });
    ws.fireMessage({ type: "loadOlderLogsResult", requestId: reqs[0]!.requestId, logs: [], hasOlder: false });
    await tick();

    // Mismatched delta (gen jumped): dropped -- and it triggers ONE bare
    // listLogs (no `since`): the traceable re-attest.
    clearSent();
    ws.fireMessage({ type: "logsListed", full: false, logs: [dRow("dl-4", 500)], gen: "b-9" });
    await tick();
    expect(logIds()).not.toContain("dl-4");
    let bare = sent("listLogs");
    expect(bare).toHaveLength(1);
    expect(bare[0]).toEqual({ type: "listLogs" }); // no since: full frame demanded
    // A second mismatch while the re-attest is pending does NOT spam.
    ws.fireMessage({ type: "logRowAdded", row: dRow("dl-5", 600), gen: "b-9" });
    await tick();
    expect(sent("listLogs")).toHaveLength(1);
    expect(logIds()).not.toContain("dl-5");

    // The full frame settles it (watermark adopted, pending freed), and a
    // later delta continues from the new gen.
    ws.fireMessage({
      type: "logsListed",
      logs: [dRow("dl-4", 500), dRow("dl-3", 400), dRow("dl-1", 300), dRow("dl-2", 200)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 200, id: "dl-2" },
      gen: "b-9",
    });
    await tick();
    expect(logIds()).toEqual(["dl-4", "dl-3", "dl-1", "dl-2"]);
    ws.fireMessage({ type: "logsListed", full: false, logs: [dRow("dl-6", 700)], gen: "b-9" });
    await tick();
    expect(logIds()).toEqual(["dl-6", "dl-4", "dl-3", "dl-1", "dl-2"]);

    // With a held watermark the app's refresh idiom carries `since` (the
    // newest held row) -- delta cost on a quiet store.
    clearSent();
    ws.fireMessage({ type: "logDeleted", logId: "dl-gone" });
    await tick();
    const refresh = sent<{ type: string; since?: unknown }>("listLogs");
    expect(refresh).toHaveLength(1);
    expect(refresh[0]!.since).toEqual({ lastActivityAt: 700, id: "dl-6" });
  });

  it("a delta re-shipping an OLDER pinned tail row keeps the merged list total DESC; the next push inserts mid-list", async () => {
    // Base [a(300), b(200)] with a pinned tail p(50): a pin below the head is
    // what pins are for, and the delta contract ships EVERY pinned cold row
    // with every frame, older-than-cursor included.
    ws.fireMessage({
      type: "logsListed",
      logs: [dRow("jd-a", 300), dRow("jd-b", 200)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 200, id: "jd-b" },
      pinnedLogs: [dRow("jd-p", 50, { pinned: true })],
      gen: "jd-1",
    });
    await tick();
    expect(logIds()).toEqual(["jd-p", "jd-a", "jd-b"]); // the float, not the merge order
    ws.fireMessage({
      type: "logsListed",
      full: false,
      logs: [dRow("jd-d", 400)],
      pinnedLogs: [dRow("jd-p", 50, { pinned: true })],
      gen: "jd-1",
    });
    await tick();
    expect(logIds()).toEqual(["jd-p", "jd-d", "jd-a", "jd-b"]);
    // The merged order the push walks, stated raw: lift the mark and the rows
    // read the comparator's order -- d, a, b, p, never d, p, a, b.
    ws.fireMessage({ type: "logPins", pinnedIds: [] });
    await tick();
    expect(logIds()).toEqual(["jd-d", "jd-a", "jd-b", "jd-p"]);
    // The targeted demote on top of that list: r(250) INSERTS between
    // a(300) and b(200) -- the insert walks the merged comparator order,
    // so the pinned float above must not pull it to the head.
    ws.fireMessage({ type: "logPins", pinnedIds: ["jd-p"] });
    ws.fireMessage({ type: "logRowAdded", row: dRow("jd-r", 250), gen: "jd-2" });
    await tick();
    expect(logIds()).toEqual(["jd-p", "jd-d", "jd-a", "jd-r", "jd-b"]);
    ws.fireMessage({ type: "logPins", pinnedIds: [] });
    await tick();
    expect(logIds()).toEqual(["jd-d", "jd-a", "jd-r", "jd-b", "jd-p"]);
  });

  it("a re-shipped held row replaces IN PLACE: one slot, the fresh copy's data and position", async () => {
    ws.fireMessage({
      type: "logsListed",
      logs: [dRow("jp-a", 300), dRow("jp-b", 200)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 200, id: "jp-b" },
      pinnedLogs: [dRow("jp-p", 50, { pinned: true })],
      gen: "jp-1",
    });
    await tick();
    // A ZERO-row delta (the quiet refresh a log view sends when nothing is
    // newer) still carries the complete pinnedLogs -- and p's attested ts has
    // moved to 250, so the position re-derives from the fresh data.
    ws.fireMessage({
      type: "logsListed",
      full: false,
      logs: [],
      pinnedLogs: [dRow("jp-p", 250, { pinned: true, messageCount: 7 })],
      gen: "jp-1",
    });
    await tick();
    expect(logIds().filter((id) => id === "jp-p")).toHaveLength(1); // re-attested, never duplicated
    const rowP = els("#log-list .log-item").find((r) => r.getAttribute("data-sid") === "jp-p")!;
    expect(rowP.querySelector(".row-metric")!.textContent).toBe("7 msgs"); // the fresh copy won
    ws.fireMessage({ type: "logPins", pinnedIds: [] });
    await tick();
    expect(logIds()).toEqual(["jp-a", "jp-p", "jp-b"]); // its seat came from the fresh ts
  });

  it("every delta posture with the complete pinnedLogs: prepend, whole-frame drop, settle, quiet re-attest", async () => {
    // Head + pinned tail + a HELD page: the pin's seat sits below the seam,
    // exactly where a real old pin lives.
    ws.fireMessage({
      type: "logsListed",
      logs: [dRow("jq-1", 300), dRow("jq-2", 200)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 200, id: "jq-2" },
      pinnedLogs: [dRow("jq-p", 50, { pinned: true })],
      gen: "q-1",
    });
    await tick();
    clearSent();
    setScroll(900);
    fireScroll();
    const rid = sent<{ requestId: number }>("loadOlderLogs")[0]!.requestId;
    ws.fireMessage({
      type: "loadOlderLogsResult",
      requestId: rid,
      logs: [dRow("jq-old", 120)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 120, id: "jq-old" },
    });
    await tick();
    expect(logIds()).toEqual(["jq-p", "jq-1", "jq-2", "jq-old"]);
    // (1) strictly-newer delta WITH pinnedLogs: prepend; the pin keeps its
    // tail seat and the value-based seam still walks from the held page.
    ws.fireMessage({
      type: "logsListed",
      full: false,
      logs: [dRow("jq-new", 400)],
      pinnedLogs: [dRow("jq-p", 50, { pinned: true })],
      gen: "q-1",
    });
    await tick();
    expect(logIds()).toEqual(["jq-p", "jq-new", "jq-1", "jq-2", "jq-old"]);
    // Raw order (the float hides the pin's seat): the re-shipped copy stayed
    // at the tail instead of re-anchoring behind the new head.
    ws.fireMessage({ type: "logPins", pinnedIds: [] });
    await tick();
    expect(logIds()).toEqual(["jq-new", "jq-1", "jq-2", "jq-old", "jq-p"]);
    ws.fireMessage({ type: "logPins", pinnedIds: ["jq-p"] });
    await tick();
    clearSent();
    setScroll(900);
    fireScroll();
    expect(sent<{ olderThan: unknown }>("loadOlderLogs")[0]!.olderThan).toEqual({ lastActivityAt: 120, id: "jq-old" });
    // (2) mismatched delta WITH pinnedLogs: dropped WHOLE -- no row, no pin
    // copy -- and exactly one bare re-attest.
    ws.fireMessage({
      type: "logsListed",
      full: false,
      logs: [dRow("jq-ghost", 500)],
      pinnedLogs: [dRow("jq-ghostpin", 60, { pinned: true })],
      gen: "q-7",
    });
    await tick();
    expect(logIds()).not.toContain("jq-ghost");
    expect(logIds()).not.toContain("jq-ghostpin");
    expect(sent("listLogs")).toHaveLength(1);
    expect(sent("listLogs")[0]).toEqual({ type: "listLogs" });
    // (3) the settling full frame re-ships the pin: seat holds, held page rides
    // below, the frame re-attests the seam.
    ws.fireMessage({
      type: "logsListed",
      logs: [dRow("jq-new", 400), dRow("jq-1", 300), dRow("jq-2", 200)],
      pinnedLogs: [dRow("jq-p", 50, { pinned: true })],
      hasOlder: true,
      olderCursor: { lastActivityAt: 200, id: "jq-2" },
      gen: "q-7",
    });
    await tick();
    expect(logIds()).toEqual(["jq-p", "jq-new", "jq-1", "jq-2", "jq-old"]);
    // (4) quiet zero-row delta WITH pinnedLogs: nothing moves -- raw order
    // included, not just the floated render -- and no request.
    clearSent();
    ws.fireMessage({
      type: "logsListed",
      full: false,
      logs: [],
      pinnedLogs: [dRow("jq-p", 50, { pinned: true })],
      gen: "q-7",
    });
    await tick();
    ws.fireMessage({ type: "logPins", pinnedIds: [] });
    await tick();
    expect(logIds()).toEqual(["jq-new", "jq-1", "jq-2", "jq-old", "jq-p"]);
    expect(sent("listLogs")).toHaveLength(0);
    // The held page must not leak into the suites below.
    ws.fireMessage({ type: "logDeleted", logId: "jq-old" });
    await tick();
  });

  it("logRowAdded INSERTS by the DESC comparator (mid-list), dedupes re-adds, floats a pinned demote", async () => {
    ws.fireMessage({ type: "logsListed", logs: [dRow("dl-1", 300), dRow("dl-2", 200)], hasOlder: false, gen: "m-1" });
    await tick();
    // An old-ts demote lands between the 300 and the 200 row -- not at the
    // head, not at the tail.
    ws.fireMessage({ type: "logRowAdded", row: dRow("dl-mid", 250), gen: "m-2" });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-mid", "dl-2"]);
    // Re-added after a stale overlap: the fresh copy wins and the row rides
    // exactly once.
    ws.fireMessage({ type: "logRowAdded", row: dRow("dl-mid", 250, { messageCount: 2 }), gen: "m-3" });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-mid", "dl-2"]);
    // A dismissed row keeps its pin: the fresh flag re-attests the mark the
    // sessionDeleted notice dropped, and it floats above the day rows.
    ws.fireMessage({ type: "logRowAdded", row: dRow("dl-pin", 10, { pinned: true }), gen: "m-4" });
    await tick();
    expect(logIds()).toEqual(["dl-pin", "dl-1", "dl-mid", "dl-2"]);
    const pinnedRow = els("#log-list .log-item").find((r) => r.getAttribute("data-sid") === "dl-pin")!;
    expect(pinnedRow.querySelector(".row-pin")).toBeTruthy();
  });

  it("logRowRemoved prunes the list AND held pages; the value-based seam keeps walking", async () => {
    ws.fireMessage({
      type: "logsListed",
      logs: [dRow("dl-1", 300), dRow("dl-2", 200)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 200, id: "dl-2" },
      gen: "r-1",
    });
    await tick();
    clearSent();
    setScroll(900);
    fireScroll();
    const rid = sent<{ requestId: number }>("loadOlderLogs")[0]!.requestId;
    ws.fireMessage({
      type: "loadOlderLogsResult",
      requestId: rid,
      logs: [dRow("dl-a", 150), dRow("dl-b", 100)],
      hasOlder: true,
      olderCursor: { lastActivityAt: 100, id: "dl-b" },
    });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-2", "dl-a", "dl-b"]);
    // Removal inside the HELD pages: the row is gone from the render, and
    // the held copy cannot resurrect it on the next base frame.
    ws.fireMessage({ type: "logRowRemoved", sessionId: "dl-a", gen: "r-2" });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-2", "dl-b"]);
    // Seam untouched by the removal: the bottom edge still pages from the
    // held VALUE cursor.
    clearSent();
    setScroll(900);
    fireScroll();
    const reqs = sent<{ requestId: number; olderThan: unknown }>("loadOlderLogs");
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!.olderThan).toEqual({ lastActivityAt: 100, id: "dl-b" });
    // Even removing the row the cursor NAMES cannot strand the walk: the
    // cursor is a value, not an index -- the in-flight page still lands.
    ws.fireMessage({ type: "logRowRemoved", sessionId: "dl-b", gen: "r-3" });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-2"]);
    ws.fireMessage({
      type: "loadOlderLogsResult",
      requestId: reqs[0]!.requestId,
      logs: [dRow("dl-c", 50)],
      hasOlder: false,
    });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-2", "dl-c"]);
    // Clean the held row out for the suites below.
    ws.fireMessage({ type: "logRowRemoved", sessionId: "dl-c", gen: "r-4" });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-2"]);
  });

  it("the logPins frame re-derives marks WHOLESALE, off-screen ids included", async () => {
    ws.fireMessage({
      type: "logsListed",
      logs: [dRow("dl-1", 300)],
      pinnedLogs: [dRow("dl-pin9", 50, { pinned: true })],
      hasOlder: true,
      olderCursor: { lastActivityAt: 300, id: "dl-1" },
      gen: "p-1",
    });
    await tick();
    expect(logIds()).toEqual(["dl-pin9", "dl-1"]);
    // Unpinned elsewhere: the complete set drops the id, so the mark dies
    // -- the row keeps its seat (rows are not the pins frame's business),
    // plain and un-floated.
    ws.fireMessage({ type: "logPins", pinnedIds: [] });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-pin9"]);
    const demoted = els("#log-list .log-item").find((r) => r.getAttribute("data-sid") === "dl-pin9")!;
    expect(demoted.querySelector(".row-pin")).toBeNull();
    // Pinned elsewhere an id this tab does NOT hold: no row to mark yet,
    // but the mark set gains it -- when a later page ships the row, it
    // floats and badges from the mark, not from the page frame.
    ws.fireMessage({ type: "logPins", pinnedIds: ["dl-off9"] });
    await tick();
    expect(logIds()).toEqual(["dl-1", "dl-pin9"]);
    clearSent();
    setScroll(900);
    fireScroll();
    const rid = sent<{ requestId: number }>("loadOlderLogs")[0]!.requestId;
    ws.fireMessage({
      type: "loadOlderLogsResult",
      requestId: rid,
      logs: [dRow("dl-off9", 50)],
      hasOlder: false,
    });
    await tick();
    expect(logIds()).toEqual(["dl-off9", "dl-1", "dl-pin9"]);
    const offRow = els("#log-list .log-item").find((r) => r.getAttribute("data-sid") === "dl-off9")!;
    expect(offRow.querySelector(".row-pin")).toBeTruthy();
    // Leave the lists as the suites below expect.
    ws.fireMessage({ type: "logPins", pinnedIds: [] });
    ws.fireMessage({ type: "logDeleted", logId: "dl-off9" }); // drops the held copy too
    await tick();
    ws.fireMessage({ type: "logsListed", logs: [logRow] });
    await tick();
    expect(logIds()).toEqual([L1]);
  });
});

// ── Context menus ───────────────────────────────────────────────────────────

describe("context menus", () => {
  const menuButtons = () => els(".context-menu-item");

  it("session menu: rename through the prompt, delete & dismiss behind confirm", async () => {
    await attach();
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    // Pin leads; the contextual action (Cancel while working, Dismiss when
    // idle), the copies and Export follow; Rename/Delete keep the bottom
    // slots. The fixture row carries no logPath, so "Copy log file path"
    // is hidden.
    expect(menuButtons().map((b) => b.textContent)).toEqual([
      "Pin",
      "Dismiss",
      "Copy session id",
      "Export",
      "Rename",
      "Delete",
    ]);

    clearSent();
    menuButtons().find((b) => b.textContent === "Rename")!.click();
    await tick();
    expect(sent<{ type: string; sessionId: string; newName: string }>("renameSession")[0]).toEqual({
      type: "renameSession",
      sessionId: SID,
      newName: "renamed",
    });
    expect(document.querySelector(".context-menu")).toBeNull(); // dismissed after pick

    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    clearSent();
    confirmAnswer = false;
    menuButtons().find((b) => b.textContent === "Delete")!.click();
    await tick();
    expect(sent("deleteSession")).toHaveLength(0);
    confirmAnswer = true;
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    menuButtons().find((b) => b.textContent === "Delete")!.click();
    await tick();
    expect(sent<{ sessionId: string }>("deleteSession")[0]?.sessionId).toBe(SID);

    // Dismiss is confirm-gated too (it tears down a live agent): refuse ->
    // nothing on the wire; accept -> the plain dismissSession frame.
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    clearSent();
    confirmAnswer = false;
    menuButtons().find((b) => b.textContent === "Dismiss")!.click();
    await tick();
    expect(sent("dismissSession")).toHaveLength(0);
    confirmAnswer = true;

    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    menuButtons().find((b) => b.textContent === "Dismiss")!.click();
    await tick();
    expect(sent<{ type: string; sessionId: string }>("dismissSession")[0]).toEqual({
      type: "dismissSession",
      sessionId: SID,
    });
    expect(document.querySelector(".context-menu")).toBeNull(); // dismissed after pick
  });

  it("an empty rename name changes nothing", async () => {
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    promptAnswer = "   ";
    clearSent();
    menuButtons().find((b) => b.textContent === "Rename")!.click();
    await tick();
    expect(sent("renameSession")).toHaveLength(0);
    promptAnswer = "renamed";
  });

  it("log menu deletes; deleting the viewed log exits log view", async () => {
    // Enter log view first.
    els(".log-item")[0]!.click();
    ws.fireMessage({ type: "logViewed", logId: L1, entries: [{ source: "prompt", content: "log line" }] });
    await tick();
    expect(el("#log-view-label")).toBeTruthy();

    els(".log-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    // Pin leads, then the Resume entry (the sole resume path since the
    // inline card button was retired 2026-11-09) and the shared tail;
    // Delete takes the bottom slot (no "Copy log file path": the fixture
    // log row omits it).
    expect(menuButtons().map((b) => b.textContent)).toEqual([
      "Pin",
      "Resume",
      "Copy session id",
      "Export",
      "Delete",
    ]);
    menuButtons().find((b) => b.textContent === "Delete")!.click();
    await tick();
    expect(sent<{ logId: string }>("deleteLog")[0]?.logId).toBe(L1);

    clearSent();
    ws.fireMessage({ type: "logDeleted", logId: L1 });
    await tick();
    // Active log vanished: log view exits (label gone) and the list refreshes.
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(sent("listLogs").length).toBeGreaterThan(0);
  });

  it("deleting the viewed log restores the live transcript (same exit as closing log view)", async () => {
    // Enter log view with a different log than the section fixture above.
    ws.fireMessage({
      type: "logsListed",
      logs: [logRow, { id: "l-doomed", createdAt: 1, lastActivityAt: 2, messageCount: 2 }],
    });
    await tick();
    // Cards show no ids: the doomed row is the list's second entry.
    const doomed = els(".log-item")[1]!;
    expect(doomed).toBeTruthy();
    doomed.click(); // onViewLog
    ws.fireMessage({
      type: "logViewed",
      logId: "l-doomed",
      entries: [{ source: "prompt", content: "gone-log line" }],
    });
    await tick();
    expect(el("#message-list").textContent).toContain("gone-log line");

    clearSent();
    ws.fireMessage({ type: "logDeleted", logId: "l-doomed" });
    await tick();
    // The restore path the normal exit uses: re-switch to the live session
    // (server replays) with the transcript cleared, never leaving the
    // deleted log on screen for live events to append beneath.
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe(SID);
    expect(document.querySelector("#log-view-label")).toBeNull();

    // The server's re-attach lands; live events render into the restored
    // transcript, and the dead log's entries are gone.
    ws.fireMessage({ type: "sessionCreated", sessionId: SID });
    ws.fireMessage({ type: "userMessage", sessionId: SID, content: "live tail" });
    await tick();
    const text = el("#message-list").textContent ?? "";
    expect(text).toContain("live tail");
    expect(text).not.toContain("gone-log line");

    // Leave the transcript clean-ish for the sections below.
    ws.fireMessage({ type: "logsListed", logs: [logRow] });
    await tick();
  });

  it("mousedown outside the menu dismisses it; inside does not", async () => {
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    menuButtons()[0]!.dispatchEvent({ type: "mousedown", target: menuButtons()[0] } as unknown as Event);
    await tick();
    expect(document.querySelector(".context-menu")).toBeTruthy();

    document.dispatchEvent({ type: "mousedown", target: document.body } as unknown as Event);
    await tick();
    expect(document.querySelector(".context-menu")).toBeNull();
    // With no menu open, stray mousedowns are ignored (no crash).
    document.dispatchEvent({ type: "mousedown", target: document.body } as unknown as Event);
  });

  it("Pin sends setPinned; the menu label follows the server payload flag", async () => {
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    const pin = menuButtons().find((b) => b.textContent === "Pin")!;
    expect(pin).toBeTruthy();
    clearSent();
    pin.click();
    await tick();
    // Optimistic flip out on the wire; localStorage is gone entirely.
    expect(sent<{ type: string; sessionId: string; pinned: boolean }>("setPinned")[0]).toEqual({
      type: "setPinned",
      sessionId: SID,
      pinned: true,
    });

    // The label follows the broadcast, not the click: only a sessions
    // payload carrying pinned:true moves the toggle to Unpin.
    ws.fireMessage({ type: "sessions", sessions: [{ ...sessionRow, pinned: true }] });
    await tick();
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    const unpin = menuButtons().find((b) => b.textContent === "Unpin")!;
    expect(unpin).toBeTruthy();
    clearSent();
    unpin.click();
    await tick();
    expect(sent<{ type: string; sessionId: string; pinned: boolean }>("setPinned")[0]).toEqual({
      type: "setPinned",
      sessionId: SID,
      pinned: false,
    });

    // Reconcile the atom back to the plain fixture state.
    ws.fireMessage({ type: "sessions", sessions: [sessionRow] });
    await tick();
  });

  it("the optimistic flip reverts when the server round-trip fails", async () => {
    // Pre-click state: the row is unpinned per the server's truth.
    ws.fireMessage({ type: "sessions", sessions: [sessionRow] });
    await tick();
    expect(els(".session-item")[0]!.querySelector(".row-pin")).toBeNull();

    // Click Pin: the icon flips immediately, before any server reply.
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    clearSent();
    menuButtons().find((b) => b.textContent === "Pin")!.click();
    await tick();
    expect(sent("setPinned")).toHaveLength(1);
    expect(els(".session-item")[0]!.querySelector(".row-pin")).toBeTruthy();
    document.dispatchEvent({ type: "mousedown", target: document.body } as unknown as Event);
    await tick();

    // The round-trip FAILED: the reconcile payload disagrees with the flip
    // (server refused the id / lost the write / store reload says no). The
    // UI must snap back to the pre-click value -- flags on rows present in
    // the payload win outright (applyPinnedFlags).
    ws.fireMessage({ type: "sessions", sessions: [sessionRow] });
    await tick();
    expect(els(".session-item")[0]!.querySelector(".row-pin")).toBeNull();

    // No ghost pin: the menu's label reads the same atom as the row icon,
    // so it offers Pin again, never a lingering Unpin.
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    expect(menuButtons().find((b) => b.textContent === "Pin")).toBeTruthy();
    expect(menuButtons().find((b) => b.textContent === "Unpin")).toBeUndefined();
    document.dispatchEvent({ type: "mousedown", target: document.body } as unknown as Event);
    await tick();
  });

  it("payload flags hydrate pins; a dead row's pin is dropped, no client-side prune", async () => {
    // Another tab's pin arrives as a flagged row and drives this tab's menu.
    ws.fireMessage({ type: "sessions", sessions: [{ ...sessionRow, pinned: true }] });
    await tick();
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    expect(menuButtons().find((b) => b.textContent === "Unpin")).toBeTruthy();
    document.dispatchEvent({ type: "mousedown", target: document.body } as unknown as Event);
    await tick();

    // sessionDeleted drops the stale mark immediately (the server store is
    // already pruned by the delete handler); no list round-trip needed.
    ws.fireMessage({ type: "sessionDeleted", sessionId: SID });
    await tick();
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    expect(menuButtons().find((b) => b.textContent === "Pin")).toBeTruthy();
    document.dispatchEvent({ type: "mousedown", target: document.body } as unknown as Event);
    await tick();
  });

  it("menu Stop mirrors the row affordance: working-only, same cancel path", async () => {
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    expect(menuButtons().map((b) => b.textContent)).toEqual([
      "Pin",
      "Stop",
      "Copy session id",
      "Export",
      "Rename",
      "Delete",
    ]);
    clearSent();
    menuButtons().find((b) => b.textContent === "Stop")!.click();
    await tick();
    // Same frame as the inline row Stop, no confirm on either.
    expect(sent<{ sessionId: string }>("cancel")[0]?.sessionId).toBe(SID);
    // Reset for the sections below.
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: false });
    await tick();
  });

  it("Copy log file path appears when the row carries logPath", async () => {
    ws.fireMessage({
      type: "sessions",
      sessions: [{ ...sessionRow, logPath: "/srv/hotdog/sessions/s-ui-0001.jsonl" }],
    });
    await tick();
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    expect(menuButtons().map((b) => b.textContent)).toEqual([
      "Pin",
      "Dismiss",
      "Copy session id",
      "Copy log file path",
      "Export",
      "Rename",
      "Delete",
    ]);
    // Dismiss; later menus read the (restored) plain fixture again.
    document.dispatchEvent({ type: "mousedown", target: document.body } as unknown as Event);
    await tick();
    ws.fireMessage({ type: "sessions", sessions: [sessionRow] });
    await tick();
  });
});

// ── Subagents sidebar + main-view transcript ────────────────────────────────

describe("subagents sidebar and main-view transcript", () => {
  const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    taskId: "task-1",
    description: "do the thing",
    sessionId: SID,
    status: "running",
    createdAt: Date.now() - 5000,
    startedAt: Date.now() - 4000,
    endedAt: null,
    activeMs: 1000,
    inRun: true,
    turnStartedAt: Date.now() - 1000,
    // B4: the worker session a row opens (openTargetFor reads it; without
    // it the row is informational-only).
    agentSessionId: "wsess-1",
    ...over,
  });

  /** Live row press: sends the plain switchSession for the worker's own
   *  session (B4 -- the pane becomes the worker's session view), and the
   *  fake server answers with the standard attach burst (sessionCreated
   *  rides kind/parentSessionId additively, B3). */
  function workerAttach(workerSid = "wsess-1"): void {
    ws.fireMessage({ type: "sessionCreated", sessionId: workerSid, kind: "subagent", parentSessionId: SID });
    // The worker attach answers `working` with the task's inRun (B3 source);
    // tests whose turn is open flip it true on top of this burst.
    ws.fireMessage({ type: "sessionState", sessionId: workerSid, key: "working", value: false });
    ws.fireMessage({ type: "sessionState", sessionId: workerSid, key: "cursor", value: 2 });
  }

  async function openSubagent(): Promise<void> {
    ws.fireMessage({ type: "taskList", tasks: [task()] });
    await tick();
    els(".subagent-row")[0]!.click();
    await tick();
    workerAttach();
    await tick();
  }

  /** Leave an open worker view BEFORE shipping the MANAGER's task snapshot:
   *  the daemon scopes attach-burst snapshots to the ATTACHED session, so a
   *  manager-scoped taskList frame only ever arrives while the manager owns
   *  the pane (a worker attach ships its own scoped one, which never
   *  re-attests the board -- owner ruling 2026-11-18). */
  async function toManagerView(): Promise<void> {
    if (document.querySelector("#close-subagent-view-btn")) {
      el("#close-subagent-view-btn").click();
      await attach();
    }
  }

  it("sidebar rows scope to the attached session; null-parent tasks never show", async () => {
    await attach();
    ws.fireMessage({
      type: "taskList",
      tasks: [task(), task({ taskId: "task-2", sessionId: "other-session" }), task({ taskId: "task-3", sessionId: null })],
    });
    await tick();
    // The section nests under the manager card; task-2 has no card in this
    // fixture's sidebar and the null-parent task belongs to none at all.
    expect(els(".subagents-section")).toHaveLength(1);
    const rows = els(".subagent-row");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("data-task-id")).toBe("task-1");
    // chipLabel falls back to the description words when the id has no ":".
    expect(rows[0]!.textContent).toContain("do the thing");
    // Disclosure grammar: the header names the section, the chevron is open.
    expect(el(".subagents-header").textContent).toContain("Subagents");
    expect(el(`#subagents-toggle-${SID}`).getAttribute("aria-expanded")).toBe("true");
  });

  it("the collapse chevron folds the list and persists the choice", async () => {
    el(`#subagents-toggle-${SID}`).click();
    await tick();
    expect(el(".subagents-section").getAttribute("class")).toContain("collapsed");
    expect(el(`#subagents-toggle-${SID}`).getAttribute("aria-expanded")).toBe("false");
    expect(store.get("hotdog.subagentsCollapsed")).toBe("1");
    el(`#subagents-toggle-${SID}`).click();
    await tick();
    expect(el(".subagents-section").getAttribute("class")).not.toContain("collapsed");
    expect(store.get("hotdog.subagentsCollapsed")).toBe("0");
  });

  it("clicking a row opens the transcript in the main view (history seeded)", async () => {
    await openSubagent();
    // B4: a live row opens the worker session through the STANDARD attach
    // -- the transcript seeds from the session's own replay, no relay frames.
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe("wsess-1");
    ws.fireMessage({ type: "userMessage", sessionId: "wsess-1", content: "delegate prompt" });
    ws.fireMessage({ type: "assistantMessage", sessionId: "wsess-1", content: "thinking out loud" });
    ws.fireMessage({
      type: "toolCall", sessionId: "wsess-1", name: "bash", args: "{\"cmd\":\"ls\"}", toolCallId: "t1",
    });
    ws.fireMessage({ type: "toolResult", sessionId: "wsess-1", name: "bash", output: "file.txt", toolCallId: "t1" });
    await tick();
    expect(el("#message-list").textContent).toContain("thinking out loud");
    expect(el("#message-list").textContent).toContain("bash");
    // Header affordance (the log-view label idiom): what is on screen + exit.
    expect(el("#subagent-view-label").textContent).toContain("do the thing");
    // B4: the label's title is the WORKER session id (the key its durable
    // log rides), not the task id.
    expect(el("#current-subagent-label").getAttribute("title")).toBe("wsess-1");
    // Doctrine (owner ruling 2026-11-13): viewing a subagent works like any
    // other live view -- the composer stays enabled (it steers the task).
    // The ONLY thing that locks in this mode is the profile/model switching.
    expect(el("#chat-input").hasAttribute("disabled")).toBe(false);
    expect((el("#input-area").getAttribute("class") ?? "")).not.toContain("read-only");
    // B4 (N2): profile/model switching is refused for a worker row, so the
    // affordances are ABSENT here -- hidden, never disabled-and-tempting.
    // Attachments ride the same fence (taskFollowup is text-only on the wire).
    expect(document.querySelector("#profile-select")).toBeNull();
    expect(document.querySelector("#model-select")).toBeNull();
    expect(document.querySelector("#attach-btn")).toBeNull();
    // The viewed row carries the active mark (its worker session IS the pane).
    expect(els(".subagent-row")[0]!.getAttribute("class")).toContain("active");
  });

  it("live worker output streams into the MAIN transcript; manager events stay out", async () => {
    ws.fireMessage({ type: "streamingChunk", sessionId: "wsess-1", content: "chunk one" });
    await tick();
    expect(el("#message-list").textContent).toContain("chunk one");

    // The manager keeps streaming underneath the viewed transcript: the pane
    // is the worker's session view now, so manager-session events are
    // dropped (and never dirty the manager's attach cursor).
    ws.fireMessage({ type: "assistantMessage", sessionId: SID, content: "MANAGER LEAK" });
    await tick();
    expect(el("#message-list").textContent).not.toContain("MANAGER LEAK");

    // Another delta rides the same streaming row.
    ws.fireMessage({ type: "streamingChunk", sessionId: "wsess-1", content: " chunk two" });
    await tick();
    expect(el("#message-list").textContent).toContain("chunk one chunk two");

    // The attested assistant message commits the row: no streaming class left.
    ws.fireMessage({ type: "assistantMessage", sessionId: "wsess-1", content: "chunk one chunk two" });
    await tick();
    expect(el("#message-list").querySelectorAll(".message.assistant.streaming")).toHaveLength(0);

    // The turn boundary in the ticker (inRun false) is chrome only: it never
    // repaints the transcript a second time.
    ws.fireMessage({ type: "taskUpdate", task: task({ inRun: false }) });
    await tick();
    expect(el("#message-list").textContent).toContain("chunk one chunk two");
  });

  it("clicking the manager row switches back to the live transcript", async () => {
    clearSent();
    els(".session-item")[0]!.click(); // the ATTACHED manager: the browse view ends
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe(SID);
    await attach(); // the server answers with the re-attach burst
    expect(document.querySelector("#subagent-view-label")).toBeNull();
    expect(el("#chat-input").hasAttribute("disabled")).toBe(false);
    // Live manager output flows again.
    ws.fireMessage({ type: "assistantMessage", sessionId: SID, content: "back live" });
    await tick();
    expect(el("#message-list").textContent).toContain("back live");
  });

  it("the header close button re-switches too (onCloseLogView idiom)", async () => {
    await openSubagent();
    clearSent();
    el("#close-subagent-view-btn").click();
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe(SID);
    await attach();
    expect(document.querySelector("#subagent-view-label")).toBeNull();
  });

  it("the header shows the VIEWED subagent's identity; returning to the manager reverts", async () => {
    await openSubagent();
    // The badge is the pane's subject id: while the task transcript is on
    // screen the identity speaks for the task, not for the hidden manager.
    expect(el("#session-label").textContent).toContain("Subagent:");
    // B4: the badge is the worker's OWN session id (its durable-log key).
    expect(el("#current-session-id").textContent).toBe("wsess-1".slice(0, 8));
    expect(el("#current-session-id").getAttribute("title")).toBe("Copy full session id");
    // Not dimmed: the badge is what the pane is showing (log view keeps the
    // dim, where the badge is NOT the record on screen).
    expect(el("#session-label").getAttribute("style")).toBeNull();
    const copied: string[] = [];
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: async (t: string) => { copied.push(t); } } },
      configurable: true,
    });
    try {
      clearSent();
      el("#current-session-id").click();
      await tick();
      // The copy button copies the FULL worker session id (badge idiom kept).
      expect(copied).toEqual(["wsess-1"]);
      expect(ws.sent).toHaveLength(0); // copy stays inert on the wire
    } finally {
      if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
    // Re-switching back to the manager reverts the whole identity block.
    el("#close-subagent-view-btn").click();
    await attach();
    expect(el("#session-label").textContent).toContain("Session:");
    expect(el("#current-session-id").textContent).toBe(SID.slice(0, 8));
    expect(el("#current-session-id").getAttribute("title")).toBe("Copy full session id");
    // The profile/model dropdowns unlock with the mode.
    expect(el("#profile-select").hasAttribute("disabled")).toBe(false);
    expect(el("#model-select").hasAttribute("disabled")).toBe(false);
  });

  it("the selects vanish entering the worker view (a popup open when the mode lands goes with them)", async () => {
    // B4 (N2): the switchers are refused for a worker row, so they are
    // absent in the view -- a popup open when the mode lands unmounts with
    // its trigger, and the wire stays clean throughout.
    clearSent();
    el("#profile-select").click();
    await tick();
    expect(comboOpen()).not.toBeNull();
    await openSubagent(); // the row click enters the worker view
    expect(comboOpen()).toBeNull();
    expect(document.querySelector("#profile-select")).toBeNull();
    expect(document.querySelector("#model-select")).toBeNull();
    // Keyboard lands nowhere: nothing to expand, nothing to send.
    key(document.body, "ArrowDown");
    await tick();
    expect(comboOpen()).toBeNull();
    expect(sent("switchProfile")).toHaveLength(0);
    // Back to the canonical unlocked, attached shape for the sections behind.
    el("#close-subagent-view-btn").click();
    await attach();
    expect(el("#profile-select").hasAttribute("disabled")).toBe(false);
    expect(el("#model-select").hasAttribute("disabled")).toBe(false);
  });

  it("the composer steers the viewed subagent (taskFollowup frame addressed to the task)", async () => {
    await openSubagent();
    // No staged attachments: steering is text-only on the wire, and the
    // fixture's restored attachment must not skew this pin.
    els(".attachment-remove").forEach((b) => b.click());
    clearSent();
    setComposer("use the -la flag");
    await submitComposer();
    // Exactly the existing C2S taskFollowup frame, scoped to the VIEWED task.
    expect(sent<{ type: string; taskId: string; message: string }>("taskFollowup")).toEqual([
      { type: "taskFollowup", taskId: "task-1", message: "use the -la flag" },
    ]);
    // Nothing rides the manager's send frame; the working flip is the
    // manager's own state and steering never forges it.
    expect(sent("send")).toHaveLength(0);
    // B4: no optimistic echo. The steer reaches the worker's log and the
    // drained USER_MESSAGE rides the session's live tail -- that event is
    // the row's sole bearer, so it can never double up.
    expect(el("#message-list").querySelector(".message.user")).toBeNull();
    ws.fireMessage({ type: "userMessage", sessionId: "wsess-1", content: "use the -la flag" });
    await tick();
    expect(el("#message-list").querySelectorAll(".message.user")).toHaveLength(1);
    expect(el("#message-list").textContent).toContain("use the -la flag");
    // A refusal (the requester-only taskControl reply) lands as a notice.
    ws.fireMessage({
      type: "taskControl",
      taskId: "task-1",
      action: "followup",
      ok: false,
      error: "Steering needs a running task with a live turn",
    });
    await tick();
    expect(el("#message-list").textContent).toContain("Steering needs a running task with a live turn");
  });

  it("the steering row survives the pane switch: reopening repaints it (real layout)", async () => {
    // A task id of its own: reopening is a fresh attach, and the transcript
    // is painted from the worker session's OWN replay -- no second render
    // path, no DOM survivor.
    await toManagerView(); // the manager's snapshot ships only in the manager's pane
    ws.fireMessage({ type: "taskList", tasks: [task({ taskId: "task-echo", inRun: true })] });
    await tick();
    els(".subagent-row")[0]!.click();
    await tick();
    workerAttach();
    await tick();
    els(".attachment-remove").forEach((b) => b.click());
    setComposer("check the fixtures first");
    await submitComposer();
    ws.fireMessage({ type: "userMessage", sessionId: "wsess-1", content: "check the fixtures first" });
    await tick();
    expect(el("#message-list").querySelectorAll(".message.user")).toHaveLength(1);

    // Leave for the manager (the re-attach clears the pane and replays the
    // manager's transcript)...
    el("#close-subagent-view-btn").click();
    await attach();
    // ...and back: the full attach paints the worker log's rows -- the
    // delegated prompt and the drained steer -- exactly once each.
    els(".subagent-row")[0]!.click();
    await tick();
    workerAttach();
    ws.fireMessage({ type: "userMessage", sessionId: "wsess-1", content: "task task-echo" });
    ws.fireMessage({ type: "userMessage", sessionId: "wsess-1", content: "check the fixtures first" });
    await tick();
    const rows = el("#message-list").querySelectorAll(".message.user");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("task task-echo");
    expect(rows[1]!.textContent).toContain("check the fixtures first");
    expect(els(".subagent-row")[0]!.getAttribute("data-task-id")).toBe("task-echo");
  });

  it("the composer Stop is the VIEWED task's: taskInterrupt for it, never the manager's cancel", async () => {
    // A task with a live turn, viewed, and the ATTACHED manager idle: the
    // pane's Stop affordance belongs to the task on screen (owner ruling
    // 2026-11-13 -- "the send/stop buttons you see are for THAT subagent
    // session, not the parent session").
    await toManagerView();
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: false });
    ws.fireMessage({ type: "taskList", tasks: [task({ inRun: true })] });
    await tick();
    els(".subagent-row")[0]!.click(); // the one and only row: task-1
    await tick();
    workerAttach();
    // The worker attach answers `working` with the task's inRun (B3 source);
    // here the turn is open, so the burst carries the true.
    ws.fireMessage({ type: "sessionState", sessionId: "wsess-1", key: "working", value: true });
    await tick();
    const stop = el("#composer-actions #cancel-btn");
    expect(stop.textContent).toContain("Stop");
    expect(stop.querySelector(".spinner")).toBeTruthy();
    clearSent();
    stop.click();
    // Exactly the existing C2S taskInterrupt frame, addressed to the task...
    expect(sent<{ type: string; taskId: string }>("taskInterrupt")).toEqual([
      { type: "taskInterrupt", taskId: "task-1" },
    ]);
    // ...and the manager's cancel frame is never sent.
    expect(sent("cancel")).toHaveLength(0);
    // The worker session's own turn boundary retires the button (server
    // truth; the click never flips a working flag optimistically).
    ws.fireMessage({ type: "sessionState", sessionId: "wsess-1", key: "working", value: false });
    ws.fireMessage({ type: "taskUpdate", task: task({ inRun: false, status: "cancelled" }) });
    await tick();
    expect(document.querySelector("#cancel-btn")).toBeNull();
    // The manager's aria-live narration stays honest: a task Stop is not a
    // user-initiated end of the MANAGER's run, so the next manager turn still
    // announces a completion, not "Work stopped".
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: false });
    await tick();
    expect(el("#live-status").textContent).toBe("Reply complete");
  });

  it("a refused task Stop lands the server's text in the viewed transcript", async () => {
    await toManagerView();
    ws.fireMessage({ type: "taskList", tasks: [task({ inRun: true })] });
    await tick();
    els(".subagent-row")[0]!.click(); // the one and only row: task-1
    await tick();
    workerAttach();
    ws.fireMessage({ type: "sessionState", sessionId: "wsess-1", key: "working", value: true });
    await tick();
    el("#composer-actions #cancel-btn").click();
    ws.fireMessage({
      type: "taskControl",
      taskId: "task-1",
      action: "interrupt",
      ok: false,
      error: "Task not found or no longer active",
    });
    await tick();
    expect(el("#message-list").textContent).toContain(
      "Stop refused: Task not found or no longer active",
    );
  });

  it("the working posture tracks the VIEWED task, never the hidden manager", async () => {
    // Manager busy, viewed task parked (no turn in flight): the pane is the
    // task's, and a parked task has nothing to stop -- no Stop.
    await toManagerView();
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    ws.fireMessage({ type: "taskList", tasks: [task({ inRun: false })] });
    await tick();
    els(".subagent-row")[0]!.click(); // the one and only row: task-1
    await tick();
    // Parked task: the attach burst carries working=false (inRun source),
    // so there is nothing to stop.
    workerAttach();
    await tick();
    expect(document.querySelector("#cancel-btn")).toBeNull();
    expect(el("#chat-input").hasAttribute("disabled")).toBe(false);
    // The task opens a turn: the worker session's own working flip returns
    // the Stop (the server derives it from the task's inRun).
    ws.fireMessage({ type: "taskUpdate", task: task({ inRun: true }) });
    ws.fireMessage({ type: "sessionState", sessionId: "wsess-1", key: "working", value: true });
    await tick();
    expect(el("#composer-actions #cancel-btn").textContent).toContain("Stop");
    // Leave the view: the manager's own working flag drives the composer again.
    el("#close-subagent-view-btn").click();
    await attach();
    expect(el("#composer-actions #cancel-btn").textContent).toContain("Stop");
    clearSent();
    el("#composer-actions #cancel-btn").click();
    expect(sent("cancel")).toHaveLength(1);
    expect(sent("taskInterrupt")).toHaveLength(0);
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: false });
    await tick();
  });

  it("subagent rows carry an honest context menu (right-click, kebab, keyboard twins)", async () => {
    // Start from a clean pane: a leftover viewed task would blur the
    // "kebab does not row-click-open" pin below.
    if (document.querySelector("#close-subagent-view-btn")) {
      el("#close-subagent-view-btn").click();
      await attach();
    }
    ws.fireMessage({ type: "taskList", tasks: [task(), task({ taskId: "task-2", agentSessionId: "wsess-2" })] });
    await tick();
    const menuItems = () => els(".context-menu-item").map((b) => b.textContent);
    const rows = els(".subagent-row");
    expect(rows).toHaveLength(2);

    // Right-click: the task-honest action set (live task -> Cancel rides).
    rows[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    expect(menuItems()).toEqual(["Open", "Copy task id", "Export", "Cancel"]);
    key(el(".context-menu"), "Escape");
    await tick();
    expect(document.querySelector(".context-menu")).toBeNull();

    // The visible trigger: the row-menu-btn idiom, same menu, and a
    // kebab press must NOT row-click-open the transcript.
    const kebab = rows[0]!.querySelector(".row-menu-btn") as HTMLElement;
    expect(kebab).toBeTruthy();
    expect(kebab.getAttribute("aria-label")).toBe("Subagent actions");
    kebab.click();
    await tick();
    expect(menuItems()).toEqual(["Open", "Copy task id", "Export", "Cancel"]);
    expect(document.querySelector("#subagent-view-label")).toBeNull();
    key(el(".context-menu"), "Escape");
    await tick();

    // Keyboard twin on the row itself.
    key(rows[1]!, "ContextMenu");
    await tick();
    expect(menuItems()).toEqual(["Open", "Copy task id", "Export", "Cancel"]);
    // "Open" is the row-click action, aimed at the menu's task: B4 opens the
    // worker's OWN session (task-2 rides its own worker row).
    clearSent();
    menuItems(); // no-op read keeps the ordering explicit
    els(".context-menu-item").find((b) => b.textContent === "Open")!.click();
    await tick();
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe("wsess-2");
    workerAttach("wsess-2");
    await tick();
    expect(el("#current-subagent-label").getAttribute("title")).toBe("wsess-2");

    // Cancel is confirm-gated and refuses stay silent on the wire.
    rows[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    clearSent();
    confirmAnswer = false;
    els(".context-menu-item").find((b) => b.textContent === "Cancel")!.click();
    await tick();
    expect(sent("taskInterrupt")).toHaveLength(0);
    confirmAnswer = true;
    rows[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    els(".context-menu-item").find((b) => b.textContent === "Cancel")!.click();
    await tick();
    expect(sent<{ type: string; taskId: string }>("taskInterrupt")).toEqual([{ type: "taskInterrupt", taskId: "task-1" }]);

    // Copy task id lands the full id on the clipboard seam.
    const copied: string[] = [];
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: async (t: string) => { copied.push(t); } } },
      configurable: true,
    });
    try {
      rows[1]!.dispatchEvent(new Event("contextmenu"));
      await tick();
      els(".context-menu-item").find((b) => b.textContent === "Copy task id")!.click();
      await tick();
      expect(copied).toEqual(["task-2"]);
    } finally {
      if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
      else delete (globalThis as Record<string, unknown>).navigator;
    }

    // Settled tasks lose Cancel (zero dead menu items).
    ws.fireMessage({ type: "taskUpdate", task: task({ taskId: "task-1", status: "completed", inRun: false, endedAt: Date.now() }) });
    ws.fireMessage({ type: "taskUpdate", task: task({ taskId: "task-2", status: "completed", inRun: false, endedAt: Date.now() }) });
    await tick();
    els(".subagent-row")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    expect(menuItems()).toEqual(["Open", "Copy task id", "Export"]);
    key(el(".context-menu"), "Escape");
    await tick();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("the row menu grows Export/Copy-log-path on the worker session and Reveal on runDir (matrix)", async () => {
    const menuItems = () => els(".context-menu-item").map((b) => b.textContent);
    // Address rows by their data-task-id (the section re-sorts live-first).
    const rowOf = (taskId: string): HTMLElement =>
      els(".subagent-row").find((r) => r.getAttribute("data-task-id") === taskId)! as HTMLElement;
    const openMenu = async (taskId: string): Promise<void> => {
      rowOf(taskId).dispatchEvent(new Event("contextmenu"));
      await tick();
    };
    const dismiss = async (): Promise<void> => {
      key(el(".context-menu"), "Escape");
      await tick();
    };
    // Four shapes: LIVE task with every field; SETTLED task with the worker
    // session but no run dir; QUEUED engine task whose agent never built
    // (no worker session, runDir present); plain delegate task (nothing).
    await toManagerView(); // the previous section ended inside a worker view
    ws.fireMessage({
      type: "taskList",
      tasks: [
        task({
          taskId: "run-a:fix#1",
          agentSessionId: "worker-101",
          agentLogPath: "/srv/sessions/worker-101.jsonl",
          runDir: "/rootA/runs/run-a",
        }),
        task({
          taskId: "task-settled",
          status: "completed",
          inRun: false,
          endedAt: Date.now(),
          agentSessionId: "worker-202",
          agentLogPath: "/srv/sessions/worker-202.jsonl",
        }),
        task({
          taskId: "run-b:juge#1",
          status: "queued",
          inRun: false,
          startedAt: null,
          runDir: "/rootA/runs/run-b",
          // Queued engine task with the agent not built yet: no worker row.
          agentSessionId: undefined,
        }),
        task({ taskId: "task-plain" }),
      ],
    });
    await tick();
    try {
      // Live workflow task: full set, Cancel last.
      await openMenu("run-a:fix#1");
      expect(menuItems()).toEqual([
        "Open",
        "Copy task id",
        "Copy log file path",
        "Export",
        "Reveal run directory",
        "Cancel",
      ]);
      // Copy log file path lands the SERVER-computed path (copy idiom).
      const copied: string[] = [];
      const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
      Object.defineProperty(globalThis, "navigator", {
        value: { clipboard: { writeText: async (t: string) => { copied.push(t); } } },
        configurable: true,
      });
      try {
        els(".context-menu-item").find((b) => b.textContent === "Copy log file path")!.click();
        await tick();
        expect(copied).toEqual(["/srv/sessions/worker-101.jsonl"]);
      } finally {
        if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
        else delete (globalThis as Record<string, unknown>).navigator;
      }
      // Export keys the EXISTING /export/:id route with the WORKER session
      // id (never the task id, never the manager session): the hidden anchor
      // carries the whole download request. The click never bubbles (the
      // anchor is a detached body child), so capture the element itself.
      const created: HTMLElement[] = [];
      const docAny = document as unknown as { createElement: (t: string) => HTMLElement };
      const prevCreate = docAny.createElement;
      docAny.createElement = (tag: string) => {
        const el = prevCreate.call(document, tag);
        if (tag === "a") created.push(el);
        return el;
      };
      try {
        rowOf("run-a:fix#1").dispatchEvent(new Event("contextmenu"));
        await tick();
        els(".context-menu-item").find((b) => b.textContent === "Export")!.click();
        await tick();
      } finally {
        (document as unknown as { createElement: (t: string) => HTMLElement }).createElement = prevCreate;
      }
      expect(created).toHaveLength(1);
      const anchor = created[0] as unknown as { href: string; download: string };
      expect(anchor.href.startsWith("/export/worker-101?token=")).toBe(true);
      expect(anchor.download).toBe("worker-101.jsonl");

      // Settled task: the log stays reachable (triage!), no Reveal (no dir).
      await openMenu("task-settled");
      expect(menuItems()).toEqual(["Open", "Copy task id", "Copy log file path", "Export"]);
      await dismiss();

      // Queued engine task (agent never built -> no worker row at all): the
      // log items AND B4's Open are absent (never dead), Reveal and Cancel ride.
      await openMenu("run-b:juge#1");
      expect(menuItems()).toEqual(["Copy task id", "Reveal run directory", "Cancel"]);
      await dismiss();

      // Plain LIVE delegate task: nothing new (exactly the pre-existing menu).
      await openMenu("task-plain");
      expect(menuItems()).toEqual(["Open", "Copy task id", "Export", "Cancel"]);
      await dismiss();
    } finally {
      ws.fireMessage({ type: "taskList", tasks: [] });
      await tick();
    }
  });

  it("Reveal run directory opens/focuses the tree tab, expands the chain, selects the dir", async () => {
    const RUN = "/wsfxA/runs/run-c";
    await toManagerView(); // the manager's snapshot ships only in the manager's pane
    ws.fireMessage({
      type: "taskList",
      tasks: [task({ taskId: "run-c:fix#1", runDir: RUN })],
    });
    await tick();
    // Open the pane from whatever state the earlier sections left it in.
    if (document.querySelector("#workbench-panel")) {
      for (const t of [...workbenchStore.get().tabs]) workbenchStore.close(t.id);
      await tick();
    }
    clearSent();
    els(".subagent-row")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    els(".context-menu-item").find((b) => b.textContent === "Reveal run directory")!.click();
    await tick();

    // The pane is visible and the Files tab is open AND active (focus).
    expect(document.querySelector("#workbench-panel")).toBeTruthy();
    const tabs = els("#workbench-tabs [role=tab]");
    expect(tabs.map((b) => b.textContent)).toEqual(["Files"]);
    expect(tabs[0]!.getAttribute("aria-selected")).toBe("true");

    // The reveal re-ran the tree-open machinery: roots + every expanded
    // ancestor of the run dir, through the plain listDir frame.
    const reqs = sent<{ requestId: number; path?: string }>("listDir");
    const paths = reqs.map((r) => r.path ?? "<roots>");
    expect(paths).toContain("<roots>");
    expect(paths).toContain("/wsfxA");
    expect(paths).toContain("/wsfxA/runs");
    expect(paths).toContain(RUN);

    // Serve the listings: root -> runs -> run-c (empty dir).
    for (const r of reqs) {
      if (r.path === undefined) {
        ws.fireMessage({
          type: "listDirResult",
          requestId: r.requestId,
          roots: [{ name: "wsfxA", path: "/wsfxA" }],
        });
      } else if (r.path === "/wsfxA") {
        ws.fireMessage({
          type: "listDirResult",
          requestId: r.requestId,
          path: r.path,
          entries: [{ name: "runs", path: "/wsfxA/runs", isDir: true }],
        });
      } else if (r.path === "/wsfxA/runs") {
        ws.fireMessage({
          type: "listDirResult",
          requestId: r.requestId,
          path: r.path,
          entries: [{ name: "run-c", path: RUN, isDir: true }],
        });
      } else {
        ws.fireMessage({
          type: "listDirResult",
          requestId: r.requestId,
          path: r.path,
          entries: [],
        });
      }
    }
    await tick();
    // The run dir rendered, expanded, and carries the selection mark.
    const rows = els(".ft-row").filter((r) => r.getAttribute("data-path") === RUN);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("class")).toContain("ft-selected");
    expect(rows[0]!.getAttribute("aria-current")).toBe("true");
    expect(rows[0]!.getAttribute("class")).toContain("ft-dir");
    // Cleanup: collapse the revealed chain (deepest first) -- module-level
    // tree state must not leak into the later file-tree sections (their
    // roots/expand requests would ride the leftover expansions). The reveal
    // uses a DEDICATED root ("/wsfxA") so its cached listings can never be
    // mistaken for the later sections' "/rootA" fixture either.
    for (const p of [RUN, "/wsfxA/runs", "/wsfxA"]) {
      const row = els(".ft-row").find((r) => r.getAttribute("data-path") === p);
      if (row) (row.querySelector(".ft-row-btn") as HTMLElement).click();
    }

    for (const t of [...workbenchStore.get().tabs]) workbenchStore.close(t.id);
    if (document.querySelector("#workbench-panel")) el("#workbench-toggle").click();
    await tick();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("running rows tick; the last live task ending freezes the clocks", async () => {
    await toManagerView();
    ws.fireMessage({ type: "taskList", tasks: [task()] });
    await tick();
    const before = el(".subagent-row-elapsed").textContent;
    await sleep(1100); // the once-per-second nowAtom tick while a task is live
    expect(el(".subagent-row-elapsed").textContent).not.toBe(before);

    // Settle the task: the tick timer stops and the row freezes.
    ws.fireMessage({ type: "taskUpdate", task: task({ status: "done", endedAt: Date.now(), inRun: false }) });
    await tick();
    const after = el(".subagent-row-elapsed").textContent;
    await sleep(1100);
    expect(el(".subagent-row-elapsed").textContent).toBe(after); // no more ticking
  });

  it("the strip and the popup path are gone from the DOM", async () => {
    // The retired surface may not resurrect anywhere: no strip, no overlay,
    // no steering form, no control note.
    expect(document.querySelector("#subagents-strip")).toBeNull();
    expect(document.querySelector(".subagent-chip")).toBeNull();
    expect(document.querySelector(".task-overlay")).toBeNull();
    expect(document.querySelector(".task-followup-form")).toBeNull();
    expect(document.querySelector(".task-control-note")).toBeNull();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("the reasoning toggle sweeps the viewed subagent's transcript (doctrine: only the switchers disappear)", async () => {
    // The owner doctrine (2026-11-13) removes ONLY the profile/model
    // switchers while a worker session is viewed; everything else in the
    // header keeps working, reasoning visibility included. The toggle is a
    // per-browser VIEW setting and must sweep the transcript (which renders
    // into the one MessageListManager, exactly like any session view), and
    // never touch the wire.
    await openSubagent();
    ws.fireMessage({ type: "thinking", sessionId: "wsess-1", content: "planning the next move" });
    await tick();
    const flags = () => els(".thinking-block").map((b) => b.classList.contains("hidden"));
    const chip = el("#thinking-toggle");
    expect(chip.hasAttribute("disabled")).toBe(false); // never locked by the view mode
    expect(flags()).toEqual([false]); // shown at rest

    const before = ws.sent.length;
    chip.click();
    await tick();
    expect(flags()).toEqual([true]); // swept the subagent's reasoning row
    expect(el("#thinking-toggle").getAttribute("aria-label")).toContain("Reasoning hidden");
    expect(store.get(HIDE_THINKING_STORAGE_KEY)).toBe("1");
    expect(ws.sent.length).toBe(before); // a view toggle never touches the wire

    // Restore shown for the suites that follow (default is reasoning shown).
    el("#thinking-toggle").click();
    await tick();
    expect(flags()).toEqual([false]);
    expect(store.get(HIDE_THINKING_STORAGE_KEY)).toBe("0");
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("opening a subagent from log view clears the stale log label (browse mirrors stay honest)", async () => {
    // Sidebar-batch finding 1 is FIXED in the tree and now pinned. Opening a
    // live row (switchSession -> SESSION_VIEWED) drops the chat-side
    // viewedLogId; app.tsx's onOpenTask clears the
    // app-side activeLogId mirror in the SAME click, so the header never carries
    // both #log-view-label and #subagent-view-label and the cold log row drops
    // its highlight (browse modes are exclusive -- owner doctrine).
    await attach();
    els(".log-item")[0]!.click(); // onViewLog -> chat.viewLog
    ws.fireMessage({ type: "logViewed", logId: L1, entries: [{ source: "prompt", content: "cold line" }] });
    await tick();
    expect(el("#log-view-label")).toBeTruthy();
    expect(activeRows(".log-item")).toHaveLength(1); // the cold log row is highlighted

    // The task feed keeps flowing in log view; opening a live row hands the
    // header over to the worker session cleanly -- no double label, no stale
    // log highlight (openTaskRow clears the log mirror in the SAME click).
    ws.fireMessage({ type: "taskList", tasks: [task({ taskId: "task-hand" })] });
    await tick();
    clearSent();
    els(".subagent-row")[0]!.click();
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe("wsess-1");
    workerAttach();
    await tick();
    expect(document.querySelector("#log-view-label")).toBeNull(); // mirror cleared by the open
    expect(el("#subagent-view-label")).toBeTruthy(); // only the subagent label now
    expect(activeRows(".log-item")).toHaveLength(0); // log row highlight gone

    // Exit the browse mode for the suites that follow.
    el("#close-subagent-view-btn").click();
    await attach();
  });

  // ── Settled/live transcript authority (B4: the session surface IS the pane) ──
  // The relay's activity buffer is gone: a LIVE worker pane holds exactly the
  // session events it received, and a SETTLED row's authority is the worker's
  // durable log through the standard viewLog machinery. The client half pinned
  // here: the settle flip is chrome-only (zero traffic, zero repaint), a
  // settled reopen asks the log ONCE and the fold replaces wholesale.

  it("the settle flip is chrome-only; a settled reopen asks the durable log once and replaces wholesale", async () => {
    const T = "task-flip";
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [task({ taskId: T })] });
    await tick();
    els(".subagent-row")[0]!.click();
    await tick();
    workerAttach();
    ws.fireMessage({ type: "assistantMessage", sessionId: "wsess-1", content: "the streamed tail" });
    await tick();
    els(".attachment-remove").forEach((b) => b.click());
    setComposer("use the -la flag");
    await submitComposer();
    ws.fireMessage({ type: "userMessage", sessionId: "wsess-1", content: "use the -la flag" });
    await tick();

    clearSent();
    ws.fireMessage({ type: "taskUpdate", task: task({ taskId: T, status: "completed", inRun: false, endedAt: Date.now() }) });
    await tick();
    // Chrome-only: no log/history traffic on the flip; the pane keeps its bytes.
    expect(sent("viewLog")).toHaveLength(0);
    expect(sent("switchSession")).toHaveLength(0);
    expect(el("#message-list").textContent).toContain("the streamed tail");
    // A double flip requests nothing more (nothing ever requested).
    ws.fireMessage({ type: "taskUpdate", task: task({ taskId: T, status: "completed", inRun: false, endedAt: Date.now() }) });
    await tick();
    expect(sent("viewLog")).toHaveLength(0);

    // Settled NOW: leaving and re-clicking routes to the durable log (once),
    // and the fold REPLACES the pane wholesale -- the steer row exists exactly
    // once, because the log's user lane is its only carrier.
    els(".session-item")[0]!.click();
    await attach();
    clearSent();
    els(".subagent-row")[0]!.click();
    await tick();
    expect(sent<{ logId: string }>("viewLog").map((m) => m.logId)).toEqual(["wsess-1"]);
    expect(sent("switchSession")).toHaveLength(0);
    ws.fireMessage({
      type: "logViewed",
      logId: "wsess-1",
      entries: [
        { source: "prompt", content: "the delegated prompt" },
        { source: "llm", content: "the whole conversation" },
        { source: "prompt", content: "use the -la flag" },
        { source: "llm", content: "FINAL ANSWER" },
      ],
    });
    await tick();
    const pane = el("#message-list");
    expect(pane.textContent).toContain("FINAL ANSWER");
    expect(pane.textContent).not.toContain("the streamed tail");
    expect(pane.querySelectorAll(".message.user")).toHaveLength(2); // prompt + steer, once each

    el("#close-log-view-btn").click();
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("reopening a SETTLED row goes through the durable log; a live reopen is a plain attach", async () => {
    const S = "task-settle-reopen";
    const L = "task-live-reopen";
    await attach();
    ws.fireMessage({
      type: "taskList",
      tasks: [
        task({ taskId: L, agentSessionId: "wsess-live" }),
        task({ taskId: S, agentSessionId: "wsess-settled", status: "completed", inRun: false, endedAt: Date.now() }),
      ],
    });
    await tick();
    clearSent();

    // The settled row (live-first sort: L is row 0, S row 1): the durable
    // log route, whatever this client watched before.
    els(".subagent-row")[1]!.click();
    await tick();
    expect(sent<{ logId: string }>("viewLog").map((m) => m.logId)).toEqual(["wsess-settled"]);
    ws.fireMessage({
      type: "logViewed",
      logId: "wsess-settled",
      entries: [{ source: "llm", content: "THE WHOLE CONVERSATION" }],
    });
    await tick();
    expect(el("#message-list").textContent).toContain("THE WHOLE CONVERSATION");

    // Reopen after navigating away: refetches again (the log is the authority,
    // not any client-side cache; identical bytes make the replace idempotent).
    els(".session-item")[0]!.click();
    await attach();
    clearSent();
    els(".subagent-row")[1]!.click();
    await tick();
    expect(sent("viewLog")).toHaveLength(1);
    ws.fireMessage({
      type: "logViewed",
      logId: "wsess-settled",
      entries: [{ source: "llm", content: "THE WHOLE CONVERSATION" }],
    });
    await tick();
    expect(el("#message-list").textContent).toContain("THE WHOLE CONVERSATION");

    // The live row: the STANDARD attach (the server replays on its own);
    // no log request, and the streamed bytes land in the pane.
    els(".session-item")[0]!.click();
    await attach();
    clearSent();
    els(".subagent-row")[0]!.click();
    await tick();
    expect(sent("viewLog")).toHaveLength(0);
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe("wsess-live");
    workerAttach("wsess-live");
    ws.fireMessage({ type: "assistantMessage", sessionId: "wsess-live", content: "live tail" });
    await tick();
    expect(el("#message-list").textContent).toContain("live tail");

    el("#close-subagent-view-btn").click();
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("an empty settled log paints the pane honestly (no cache authority to hide behind)", async () => {
    // The relay's warm-buffer degradation rule retired with the relay: for a
    // settled worker the durable log IS the whole truth, so an empty record
    // paints empty instead of keeping bytes no log can vouch for.
    const T = "task-settle-empty";
    await attach();
    ws.fireMessage({
      type: "taskList",
      tasks: [task({ taskId: T, status: "completed", inRun: false, endedAt: Date.now() })],
    });
    await tick();
    clearSent();
    els(".subagent-row")[0]!.click();
    await tick();
    expect(sent("viewLog")).toHaveLength(1);
    ws.fireMessage({ type: "logViewed", logId: "wsess-1", entries: [] });
    await tick();
    expect(el("#message-list").textContent).toBe("");
    el("#close-log-view-btn").click();
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("the settled fold renders UNCAPPED: 205 log entries keep their head", async () => {
    // The relay's live cap (MAX_ACTIVITY_BLOCKS) retired with the relay; the
    // durable fold writes the WHOLE log through the standard render pipeline,
    // so the head of a long transcript survives (the real run-2155 worker
    // folds 402 records).
    const T = "task-settle-uncapped";
    await attach();
    ws.fireMessage({
      type: "taskList",
      tasks: [task({ taskId: T, status: "completed", inRun: false, endedAt: Date.now() })],
    });
    await tick();
    els(".subagent-row")[0]!.click();
    await tick();
    const head = "THE HEAD OF A VERY LONG TRANSCRIPT";
    ws.fireMessage({
      type: "logViewed",
      logId: "wsess-1",
      entries: [
        { source: "llm", content: head },
        ...Array.from({ length: 204 }, (_, i) => ({
          source: "llm",
          content: "",
          tool_calls: [{ id: `t${i}`, name: `t${i}`, args: {} }],
        })),
      ],
    });
    await tick();
    const pane = el("#message-list");
    expect(pane.textContent).toContain(head);
    el("#close-log-view-btn").click();
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("a live usage attestation finalizes the viewed subagent's rows with the footer", async () => {
    // B4: the worker pane IS the session view, so the session lane's usage
    // footer machinery applies verbatim: held for the next commit, no lane of
    // its own, gauge + call time on the footer it feeds.
    const T = "task-live-footer";
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [task({ taskId: T })] });
    await tick();
    els(".subagent-row")[0]!.click();
    await tick();
    workerAttach();
    const usage = () =>
      ws.fireMessage({
        type: "tokenUsage",
        sessionId: "wsess-1",
        ctxUsed: 62000,
        ctxTotal: 262000,
        promptTokens: 50000,
        completionTokens: 12000,
        cachedTokens: 0,
        durationMs: 13000,
      });

    ws.fireMessage({ type: "streamingChunk", sessionId: "wsess-1", content: "thinking out loud" });
    await tick();
    usage();
    await tick();
    // Held, not a lane: no footer yet, no gauge text on its own.
    expect(el("#message-list").querySelectorAll(".message-assistant-footer")).toHaveLength(0);
    expect(el("#message-list").textContent).not.toContain("62k");

    // The tool-call boundary commits the row with the held numbers.
    ws.fireMessage({ type: "toolCall", sessionId: "wsess-1", name: "bash", args: "", toolCallId: "t1" });
    await tick();
    const footer = el("#message-list").querySelector(".message-assistant-footer");
    expect(footer).toBeTruthy();
    expect(footer!.querySelector(".footer-ctx")!.textContent).toBe("62k/262k");
    expect(footer!.querySelector(".footer-call")!.textContent).toBe("13s");

    // The final text row: the turn boundary (the worker session's
    // working=false edge) stamps it with the turn's last attested numbers.
    ws.fireMessage({ type: "streamingChunk", sessionId: "wsess-1", content: "final words" });
    await tick();
    ws.fireMessage({ type: "sessionState", sessionId: "wsess-1", key: "working", value: false });
    ws.fireMessage({ type: "taskUpdate", task: task({ taskId: T, status: "completed", inRun: false, endedAt: Date.now() }) });
    await tick();
    const footers = el("#message-list").querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(2);
    expect(footers[1]!.querySelector(".footer-ctx")!.textContent).toBe("62k/262k");
    expect(footers[1]!.querySelector(".footer-call")!.textContent).toBe("13s");

    el("#close-subagent-view-btn").click();
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("a settled fold finalizes with the LOG-stamped footer: 9:55 PM 62k/262k 13s Worked for 7m 37s", async () => {
    // The settled pane is the worker log's cold render: the token_usage
    // record at the message's position feeds the gauge, the log's own clock
    // stamps the time -- the owner's example footer, byte for byte.
    const T = "task-settled-footer";
    const t0 = new Date(2026, 10, 15, 21, 47, 23, 0).getTime(); // turn open
    const t1 = new Date(2026, 10, 15, 21, 55, 0, 0).getTime(); //  local 9:55 PM
    const iso = (ms: number): string => new Date(ms).toISOString();
    await attach();
    ws.fireMessage({
      type: "taskList",
      tasks: [task({ taskId: T, status: "completed", inRun: false, endedAt: Date.now() })],
    });
    await tick();
    els(".subagent-row")[0]!.click();
    await tick();
    ws.fireMessage({
      type: "logViewed",
      logId: "wsess-1",
      entries: [
        { source: "prompt", content: "audit the fixtures", ts: iso(t0) },
        { source: "turn_started", content: "", ts: iso(t0) },
        { source: "llm", content: "FINAL ANSWER", ts: iso(t1) },
        {
          source: "token_usage",
          content: "",
          ts: iso(t1),
          totalTokens: 62000,
          contextWindow: 262000,
          promptTokens: 50000,
          completionTokens: 12000,
          cachedTokens: 0,
          durationMs: 13000,
        },
        { source: "turn_end", content: "", ts: iso(t1) },
      ],
    });
    await tick();
    const footers = el("#message-list").querySelectorAll(".message-assistant-footer");
    expect(footers).toHaveLength(1);
    expect(footers[0]!.querySelector(".footer-time")!.textContent).toBe("9:55 PM");
    expect(footers[0]!.querySelector(".footer-ctx")!.textContent).toBe("62k/262k");
    expect(footers[0]!.querySelector(".footer-call")!.textContent).toBe("13s");
    expect(footers[0]!.querySelector(".footer-worked")!.textContent).toBe("Worked for 7m 37s");

    el("#close-log-view-btn").click();
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });


  it("the delegated prompt lands exactly once across live replay, settle, and re-view", async () => {
    const T = "task-prompt-once";
    await attach();
    ws.fireMessage({
      type: "taskList",
      tasks: [task({ taskId: T, description: "audit the fixtures" })],
    });
    await tick();
    els(".subagent-row")[0]!.click();
    await tick();
    // The attach replay carries the delegated prompt -- ONCE.
    workerAttach();
    ws.fireMessage({ type: "userMessage", sessionId: "wsess-1", content: "audit the fixtures (the full log prompt)" });
    await tick();
    let rows = el("#message-list").querySelectorAll(".message.user");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("the full log prompt");
    expect(el("#message-list").querySelectorAll(".message.assistant")).toHaveLength(0);

    // Live bytes ride behind the prompt...
    ws.fireMessage({ type: "streamingChunk", sessionId: "wsess-1", content: "ring tail" });
    await tick();
    expect(el("#message-list").querySelectorAll(".message.user")).toHaveLength(1);

    // The settle flip is chrome-only: no repaint, no re-seed.
    ws.fireMessage({ type: "taskUpdate", task: task({ taskId: T, description: "audit the fixtures", status: "completed", inRun: false, endedAt: Date.now() }) });
    await tick();
    expect(el("#message-list").querySelectorAll(".message.user")).toHaveLength(1);

    // Re-view as a settled row: the fold leads with the log's own prompt row,
    // and the wholesale replace keeps ONE prompt row -- the log's version.
    els(".session-item")[0]!.click();
    await attach();
    els(".subagent-row")[0]!.click();
    await tick();
    ws.fireMessage({
      type: "logViewed",
      logId: "wsess-1",
      entries: [
        { source: "prompt", content: "audit the fixtures (the full log prompt)" },
        { source: "llm", content: "the whole conversation" },
      ],
    });
    await tick();
    rows = el("#message-list").querySelectorAll(".message.user");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.textContent).toContain("the full log prompt");
    expect(el("#message-list").textContent).toContain("the whole conversation");

    el("#close-log-view-btn").click();
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("the streamReset sentinel retracts the dead attempt (prompt and tool blocks survive the trim)", async () => {
    const T = "task-reset-kinds";
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [task({ taskId: T })] });
    await tick();
    els(".subagent-row")[0]!.click();
    await tick();
    workerAttach();
    ws.fireMessage({ type: "userMessage", sessionId: "wsess-1", content: "the delegated prompt" });
    ws.fireMessage({ type: "streamingChunk", sessionId: "wsess-1", content: "kept prose" });
    ws.fireMessage({ type: "toolCall", sessionId: "wsess-1", name: "bash", args: "", toolCallId: "t1" });
    ws.fireMessage({ type: "toolResult", sessionId: "wsess-1", name: "bash", output: "ok", toolCallId: "t1" });
    await tick();
    ws.fireMessage({ type: "streamingChunk", sessionId: "wsess-1", content: "dead attempt prose" });
    await tick();
    ws.fireMessage({ type: "streamReset", sessionId: "wsess-1" });
    await tick();
    // The dead attempt's streamed row is gone from the pane; the committed
    // prose, the tool block, and the replayed prompt stand.
    expect(el("#message-list").textContent).not.toContain("dead attempt");
    expect(el("#message-list").textContent).toContain("kept prose");
    expect(el("#message-list").textContent).toContain("the delegated prompt");
    ws.fireMessage({ type: "streamingChunk", sessionId: "wsess-1", content: "retry text" });
    await tick();
    expect(el("#message-list").textContent).toContain("retry text");

    el("#close-subagent-view-btn").click();
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("a durable lineage row under a cold log card opens the worker's durable log", async () => {
    // Owner-reported bug (2026-11-14): a subagent row nested under a COLD
    // Recent Logs card must open the worker's own log (viewLog keyed by
    // agentSessionId), not the live-task activity route.
    await attach();
    ws.fireMessage({
      type: "logsListed",
      logs: [
        {
          ...logRow,
          subagents: [
            {
              taskId: "run:one#1",
              description: "durable survivor",
              sessionId: L1,
              status: "completed",
              createdAt: 1,
              startedAt: null,
              endedAt: 2,
              activeMs: 1000,
              inRun: false,
              turnStartedAt: null,
              durable: true,
              agentSessionId: "worker-log-1",
            },
          ],
        },
      ],
    });
    await tick();
    // Scope to the cold list: the previous test's LIVE task feed keeps its
    // own .subagent-row under the attached card.
    const coldRows = Array.from(
      el("#log-list").querySelectorAll(".subagent-row"),
    ) as unknown as HTMLElement[];
    expect(coldRows).toHaveLength(1);
    clearSent();
    coldRows[0]!.click();
    await tick();
    expect(sent<{ logId: string }>("viewLog")[0]?.logId).toBe("worker-log-1");
    expect(sent("switchSession")).toHaveLength(0);
    ws.fireMessage({ type: "logsListed", logs: [logRow] });
    await tick();
  });
});

// ── Viewing a live worker keeps the parent's Subagents board (owner ruling 2026-11-18) ──
// The attach burst ends with the socket's task-list snapshot (attach.ts),
// scoped to the ATTACHED session -- and a worker attach ships an empty one,
// because every task row carries the MANAGER's sessionId. Taking that empty
// snapshot at face value deletes the parent card's Subagents section: the
// very menu that hops between siblings, hidden the moment a child is picked.
// The worker attach therefore must not re-attest the manager's board.

describe("worker view keeps the parent's Subagents section", () => {
  const boardTask = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    taskId: "task-1",
    description: "do the thing",
    sessionId: SID,
    status: "running",
    createdAt: Date.now() - 1000,
    startedAt: Date.now() - 900,
    endedAt: null,
    activeMs: 100,
    inRun: true,
    turnStartedAt: Date.now() - 100,
    agentSessionId: "wsess-1",
    ...over,
  });

  /** The burst the daemon ships for a worker-row attach (attach.ts order):
   *  sessionCreated(kind) -> cursor -> working -> the scoped TASK_LIST. */
  function workerBurst(workerSid: string): void {
    ws.fireMessage({ type: "sessionCreated", sessionId: workerSid, kind: "subagent", parentSessionId: SID });
    ws.fireMessage({ type: "sessionState", sessionId: workerSid, key: "cursor", value: 2 });
    ws.fireMessage({ type: "sessionState", sessionId: workerSid, key: "working", value: true });
    ws.fireMessage({ type: "taskList", tasks: [] }); // scoped to the worker: no rows are its own
  }

  it("the scoped snapshot of a worker attach leaves the board and its selection intact", async () => {
    await attach();
    ws.fireMessage({
      type: "taskList",
      tasks: [boardTask(), boardTask({ taskId: "task-sib", createdAt: Date.now() - 9000, agentSessionId: "wsess-2" })],
    });
    await tick();
    expect(els(".subagents-section")).toHaveLength(1);
    expect(els(".subagent-row")).toHaveLength(2);
    clearSent();
    els(".subagent-row")[0]!.click();
    await tick();
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe("wsess-1");
    workerBurst("wsess-1");
    await tick();
    // The menu that hops between siblings SURVIVES the child's attach: the
    // parent's section is still there with both rows...
    expect(els(".subagents-section")).toHaveLength(1);
    expect(els(".subagent-row")).toHaveLength(2);
    // ...and the viewed row carries the active mark (the selection the
    // section had before the attach, kept through it).
    const viewed = els('.subagent-row[data-task-id="task-1"]')[0]!;
    expect(viewed.getAttribute("class")).toContain("active");
    expect(viewed.getAttribute("aria-current")).toBe("true");
    expect(els('.subagent-row[data-task-id="task-sib"]')[0]!.getAttribute("class")).not.toContain("active");
    // Leave back to the manager: a NON-worker attach re-attests the board
    // wholesale exactly as before (the guard rides the worker view only).
    el("#close-subagent-view-btn").click();
    await tick();
    await attach();
    ws.fireMessage({ type: "taskList", tasks: [boardTask({ taskId: "task-only" })] });
    await tick();
    expect(els(".subagent-row")).toHaveLength(1);
    expect(els(".subagent-row")[0]!.getAttribute("data-task-id")).toBe("task-only");
    clearSent();
  });
});

// ── Log-view header controls ────────────────────────────────────────────────

describe("log-view controls", () => {
  it("viewing a log labels the header and disables the composer; close re-switches", async () => {
    await attach();
    clearSent();
    els(".log-item")[0]!.click();
    ws.fireMessage({ type: "logViewed", logId: L1, entries: [{ source: "prompt", content: "cold line" }] });
    await tick();
    expect(el("#log-view-label").textContent).toContain(L1.slice(0, 8));
    expect(el("#chat-input").hasAttribute("disabled")).toBe(true);
    expect(el("#message-list").textContent).toContain("cold line");

    clearSent();
    el("#close-log-view-btn").click();
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe(SID);
    await attach(); // server answers with the re-attach burst
    expect(el("#chat-input").hasAttribute("disabled")).toBe(false);
    expect(document.querySelector("#log-view-label")).toBeNull();
  });
});

// ── Search hits peek (owner ruling 2026-11-18): read-only open, honest banner, explicit claim ──
// A click on a hit must NEVER silently re-attach the client (owner ruling 2026-11-18).
// A LIVE hit opens the named PEEKING state (viewLog read of the durable
// log; the socket keeps its session; the composer is locked; the banner
// names the subject and offers Take over + close); a COLD hit OBSERVES.
// The hit's query rides as the seek needle: a landed match gets the
// transient flash; a match the reachable history never ships is said so.

describe("search hits peek: read-only open, claim, honest seek", () => {
  const P1 = "s-peek-9001"; // a live session OTHER than the attached SID

  async function hitSearch(query: string, results: Array<Record<string, unknown>>): Promise<void> {
    el("#search-btn").click();
    await tick();
    const input = el("#search-input");
    (input as unknown as { value: string }).value = query;
    input.dispatchEvent({ type: "input", currentTarget: input } as unknown as Event);
    clearSent();
    await sleep(300); // the search debounce
    const [req] = sent<{ requestId: number }>("searchLogs");
    ws.fireMessage({ type: "searchResults", requestId: req!.requestId, query, results });
    await tick();
  }

  it("a LIVE hit opens a read-only peek: viewLog read, ZERO attach frames", async () => {
    await attach();
    await hitSearch("needle", [
      { logId: P1, lastActivityAt: 2, matchCount: 1, profile: "other", live: true, snippets: ["a needle line"] },
    ]);
    el(".search-hit").click();
    await tick();
    // THE point: no silent attach; the peek rides the durable-log read.
    expect(sent("switchSession")).toHaveLength(0);
    expect(sent<{ logId: string }>("viewLog")[0]?.logId).toBe(P1);
    clearSent();
    ws.fireMessage({
      type: "logViewed",
      logId: P1,
      entries: [{ source: "prompt", content: "the needle line, rendered" }],
    });
    await tick();
    // Banner: the named state, the subject id, the read-only word, and
    // BOTH controls (claim + close).
    const label = el("#peek-view-label");
    expect(label.textContent).toContain(P1.slice(0, 8));
    expect(label.textContent).toContain("read only");
    expect(el("#peek-takeover-btn")).toBeTruthy();
    expect(el("#close-peek-view-btn")).toBeTruthy();
    // Composer locked; the pane shows the peeked transcript; the seek
    // LANDED on the matched row (flash + scroll) in the peeking pane.
    expect(composerDisabled()).toBe(true);
    expect((el("#input-area").getAttribute("class") ?? "")).toContain("read-only");
    expect(el("#message-list").textContent).toContain("the needle line, rendered");
    const flashed = document.querySelectorAll(".search-flash");
    expect(flashed).toHaveLength(1);
    expect(
      (flashed[0] as unknown as { scrollIntoViewCalls: unknown[] }).scrollIntoViewCalls,
    ).toEqual([{ block: "center" }]);
    // Focus: the peek's arrival hands the claim the focus the chip held.
    expect(document.activeElement).toBe(el("#peek-takeover-btn"));
    // The manager did not move: its own row stays the highlighted session.
    expect(activeRows(".session-item")).toHaveLength(1);
  });

  it("Take over performs exactly ONE attach and restores the live composer", async () => {
    // Continues from the open peek above (ordered suite).
    clearSent();
    const claim = el("#peek-takeover-btn");
    claim.click();
    claim.click(); // a double-click cannot double-attach
    const sw = sent<{ sessionId: string }>("switchSession");
    expect(sw).toHaveLength(1);
    expect(sw[0]?.sessionId).toBe(P1);
    // The server answers the claim with the normal attach burst.
    ws.fireMessage({ type: "sessionCreated", sessionId: P1, profile: "other", title: null, currentModel: "m1", models: ["m1"] });
    ws.fireMessage({ type: "userMessage", content: "peeked hello now mine" });
    ws.fireMessage({ type: "sessionState", sessionId: P1, key: "cursor", value: 1 });
    await tick();
    expect(document.querySelector("#peek-view-label")).toBeNull();
    expect(composerDisabled()).toBe(false);
    expect(el("#message-list").textContent).toContain("peeked hello now mine");
  });

  it("a COLD hit observes with the honest state name and lands the match", async () => {
    await attach();
    await hitSearch("needle", [
      { logId: L1, lastActivityAt: 2, matchCount: 1, profile: "manager", live: false, snippets: ["a needle line"] },
    ]);
    el(".search-hit").click();
    await tick();
    expect(sent("switchSession")).toHaveLength(0);
    ws.fireMessage({ type: "logViewed", logId: L1, entries: [{ source: "prompt", content: "cold line with a needle" }] });
    await tick();
    const label = el("#log-view-label");
    expect(label.textContent).toContain("Observing log"); // the state NAME, not a euphemism
    expect(label.textContent).toContain(L1.slice(0, 8));
    expect(document.querySelector("#peek-view-label")).toBeNull();
    expect(composerDisabled()).toBe(true);
    expect(document.querySelectorAll(".search-flash")).toHaveLength(1);
    // Close: optimistic unlock (the re-attach re-attests), like the old
    // log-view close.
    el("#close-log-view-btn").click();
    await tick();
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(composerDisabled()).toBe(false);
  });

  it("a hit whose match is past the reachable history SAYS SO in the banner", async () => {
    await attach();
    await hitSearch("ghost", [
      { logId: P1, lastActivityAt: 2, matchCount: 1, profile: "other", live: true, snippets: ["..."] },
    ]);
    el(".search-hit").click();
    await tick();
    // The whole epoch fits the first page (no hasOlder) and the needle is
    // not in it: the peek opens, says the match is unreachable, and shows
    // no flash (never the head pretending to be the answer).
    ws.fireMessage({ type: "logViewed", logId: P1, entries: [{ source: "prompt", content: "nothing matching here" }] });
    await tick();
    expect(el("#peek-view-label").textContent).toContain("search match not in reachable history");
    expect(document.querySelectorAll(".search-flash")).toHaveLength(0);
    // Leave cleanly for the suites that follow.
    el("#close-peek-view-btn").click();
    await attach();
    expect(composerDisabled()).toBe(false);
  });
});

// ── Read-only view chips: keyboard-accessible controls (owner ruling 2026-11-18) ────────
// The field pass found the "Viewing log" chip's ✕ outside the interactive
// set. The controls are real BUTTONs now: they sit in the standard
// interactive set, carry a spoken name (the ✕ glyph is decoration, never a
// label), are type="button" (a chip close must never be a form submit),
// take focus, and activation -- Enter/Space turning into a click is native
// button semantics -- runs the same close/claim path the mouse runs.

describe("read-only view chips are keyboard-accessible (owner ruling 2026-11-18)", () => {
  const INTERACTIVE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const interactiveSet = (): Set<Element> => new Set(Array.from(document.querySelectorAll(INTERACTIVE)));

  const assertControl = (node: HTMLElement, named: boolean): void => {
    expect(node.tagName).toBe("BUTTON");
    expect(node.getAttribute("type")).toBe("button");
    if (named) expect((node.getAttribute("aria-label") ?? "").length).toBeGreaterThan(3);
    expect(node.getAttribute("tabindex")).toBeNull(); // focusable by default, never exiled
    expect(interactiveSet().has(node)).toBe(true);
    node.focus();
    expect(document.activeElement).toBe(node);
  };

  async function openObserved(): Promise<void> {
    await attach();
    clearSent();
    el("#log-list .log-item").click(); // cold row -> the durable-log read
    await tick();
    ws.fireMessage({ type: "logViewed", logId: L1, entries: [{ source: "prompt", content: "cold line" }] });
    await tick();
  }

  it("the observing chip: close is a named focusable button and activates", async () => {
    await openObserved();
    expect(el("#log-view-label")).toBeTruthy();
    const close = el("#close-log-view-btn");
    assertControl(close, true);
    close.click(); // what Enter/Space fire natively on a focused button
    await tick();
    expect(document.querySelector("#log-view-label")).toBeNull();
  });

  async function openPeek(): Promise<void> {
    await attach();
    el("#search-btn").click();
    await tick();
    const input = el("#search-input");
    (input as unknown as { value: string }).value = "needle";
    input.dispatchEvent({ type: "input", currentTarget: input } as unknown as Event);
    clearSent();
    await sleep(300); // the search debounce
    const [req] = sent<{ requestId: number }>("searchLogs");
    ws.fireMessage({
      type: "searchResults",
      requestId: req!.requestId,
      query: "needle",
      results: [{ logId: "s-peek-9002", lastActivityAt: 2, matchCount: 1, profile: "other", live: true, snippets: ["a needle line"] }],
    });
    await tick();
    el(".search-hit").click();
    await tick();
    ws.fireMessage({ type: "logViewed", logId: "s-peek-9002", entries: [{ source: "prompt", content: "the needle line" }] });
    await tick();
  }

  it("the peek chip: claim AND close are named focusable buttons", async () => {
    await openPeek();
    expect(el("#peek-view-label")).toBeTruthy();
    assertControl(el("#peek-takeover-btn"), false); // its text IS the name
    assertControl(el("#close-peek-view-btn"), true);
    // Leave cleanly for the suites that follow.
    el("#close-peek-view-btn").click();
    await attach();
    await tick();
    expect(composerDisabled()).toBe(false);
  });

  it("the header chips keep their pressed-state grammar (toggle chips stay buttons)", () => {
    for (const id of ["#sidebar-toggle", "#thinking-toggle", "#tool-exec-status", "#search-btn"]) {
      const node = document.querySelector(id) as HTMLElement | null;
      if (!node) continue; // posture-dependent (the fence chip speaks only when the server does)
      expect(node.tagName).toBe("BUTTON");
      expect(node.getAttribute("type")).toBe("button");
      expect((node.getAttribute("aria-label") ?? "").length).toBeGreaterThan(3);
    }
  });
});

// ── Log-view round trip, working Cancel, fence matrix ───────────────────────
// Merged from the standalone log-view suite so app.tsx has exactly ONE booting
// test file: bun attributes the module's coverage per source file under the
// serial `bun test --coverage` run, and a second import-time booter would both
// fight for that attribution and inherit this file's browser stubs.

const LV_SID = "s-live-0001";
const LV_L1 = "l-log-0001";
const LV_L2 = "l-log-0002";

// Distinct lastActivityAt (LV_L1 newest): a LOGS_LISTED head arrives in the
// shipped DESC order, and the tests below read a row's identity off its index.
const lvLogRow = (id: string, lastActivityAt = id === LV_L1 ? 3 : 2) => ({
  id,
  createdAt: 1,
  lastActivityAt,
  messageCount: 5,
});
const lvSessionRow = {
  id: LV_SID,
  profile: "manager",
  title: null,
  model: "m1",
  createdAt: 1,
  lastActivityAt: 2,
  connectedClients: 1,
  messageCount: 3,
};

/** The sidebar replies every log-view enter/leave triggers (listLogs +
 *  listSessions). The sessions reply is what used to kill log view. */
function lvSidebarReplies(): void {
  ws.fireMessage({ type: "logsListed", logs: [lvLogRow(LV_L1), lvLogRow(LV_L2)] });
  ws.fireMessage({ type: "sessions", sessions: [lvSessionRow] });
}

/** A (re-)attach burst as the server sends it: sessionCreated, replay,
 *  cursor, then the sidebar/profile replies the client's handler asks for. */
function lvAttachBurst(userLine: string): void {
  ws.fireMessage({
    type: "sessionCreated",
    sessionId: LV_SID,
    profile: "manager",
    title: null,
    currentModel: "m1",
    models: ["m1"],
  });
  ws.fireMessage({ type: "userMessage", content: userLine });
  ws.fireMessage({ type: "sessionState", sessionId: LV_SID, key: "cursor", value: 7 });
  lvSidebarReplies();
  ws.fireMessage({ type: "profiles", profiles: { manager: { body: "", model: null } } });
}

function lvViewLog(logId: string, text: string): void {
  const idx = logId === LV_L1 ? 0 : 1;
  els(".log-item")[idx]!.click();
  ws.fireMessage({ type: "logViewed", logId, entries: [{ source: "prompt", content: text }] });
  lvSidebarReplies();
}

/** Cards no longer display the raw id: a row's identity in the pinned fixture
 *  lists is its index (LV_L1 is 0, LV_L2 is 1). Reports the index of the one
 *  highlighted row of the given list. */
function activeRowIndex(sel: string): number {
  return els(sel).indexOf(activeRows(sel)[0]!);
}

describe("webui log-view round trip (real app wiring)", () => {
  beforeAll(async () => {
    // Query-suffixed copy: app-ui.test.tsx owns the plain-path import, which
    // is what bun attributes app.tsx's coverage to. Under the serial `bun
    // test --coverage` run the module registry is shared across files, and
    // this singleton boots at import -- a fresh copy keeps each file's
    // browser stubs (localStorage/WebSocket/fetch) authoritative.
    // The merged boot already opened the socket; land on a live session.
    ws.fireOpen();
    ws.fireMessage({ type: "authOk" });
    lvAttachBurst("live hello");
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
    lvViewLog(LV_L1, "LV_L1 cold line");
    await tick();
    expect(composerDisabled()).toBe(true);
    expect(el("#log-view-label")).toBeTruthy();
    expect(activeRows(".log-item")).toHaveLength(1);
    expect(activeRowIndex(".log-item")).toBe(0); // LV_L1's row
    expect(el("#message-list").textContent).toContain("LV_L1 cold line");
  });

  it("clicking the live session row while viewing a log exits log view and re-attaches", async () => {
    // Re-enter log view so this scenario stands on its own.
    lvViewLog(LV_L1, "LV_L1 cold line");
    await tick();
    ws.sent.length = 0;
    el(".session-item").click();
    // The bug: the click was a no-op -- nothing reached the socket.
    expect(sentTypes()).toContain("switchSession");
    // The server answers a switch-to-same-session with a full re-attach.
    lvAttachBurst("live hello 2");
    await tick();
    expect(composerDisabled()).toBe(false);
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(activeRows(".log-item")).toHaveLength(0);
    expect(activeRows(".session-item")).toHaveLength(1);
    const list = el("#message-list").textContent!;
    expect(list).toContain("live hello 2");
    expect(list).not.toContain("LV_L1 cold line");
  });

  it("log -> another log switches transcripts and stays in log view", async () => {
    lvViewLog(LV_L1, "LV_L1 cold line");
    await tick();
    ws.sent.length = 0;
    lvViewLog(LV_L2, "LV_L2 cold line");
    await tick();
    expect(sentTypes()).toContain("viewLog");
    expect(composerDisabled()).toBe(true);
    expect(activeRows(".log-item")).toHaveLength(1);
    expect(activeRowIndex(".log-item")).toBe(1); // LV_L2's row
    const list = el("#message-list").textContent!;
    expect(list).toContain("LV_L2 cold line");
    expect(list).not.toContain("LV_L1 cold line");
  });

  it("clicking the log row already being viewed re-renders it idempotently", async () => {
    ws.sent.length = 0;
    lvViewLog(LV_L2, "LV_L2 cold line");
    await tick();
    expect(sentTypes()).toContain("viewLog");
    expect(sentTypes()).not.toContain("switchSession");
    expect(composerDisabled()).toBe(true);
    expect(activeRows(".log-item")).toHaveLength(1);
    expect(activeRowIndex(".log-item")).toBe(1); // LV_L2's row (clicking it re-renders, stays active)
  });


  it("the close-log-view button still returns to the live session", async () => {
    ws.sent.length = 0;
    el("#close-log-view-btn").click();
    expect(sentTypes()).toContain("switchSession");
    lvAttachBurst("live hello 3");
    await tick();
    expect(composerDisabled()).toBe(false);
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(el("#message-list").textContent).toContain("live hello 3");
  });

  it("clicking a DIFFERENT live session row while viewing a log switches to it", async () => {
    // Re-enter log view, then leave for another (not the attached) session:
    // the sidebar must re-highlight the new session and log view must clear,
    // exactly like a live->live switch.
    lvViewLog(LV_L1, "LV_L1 cold line");
    await tick();
    expect(composerDisabled()).toBe(true);

    const OTHER = "s-live-0002";
    const otherRow = { ...lvSessionRow, id: OTHER, profile: "other", messageCount: 1 };
    ws.fireMessage({ type: "sessions", sessions: [lvSessionRow, otherRow] });
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
    ws.fireMessage({ type: "sessions", sessions: [lvSessionRow, otherRow] });
    ws.fireMessage({ type: "logsListed", logs: [lvLogRow(LV_L1), lvLogRow(LV_L2)] });
    await tick();
    expect(composerDisabled()).toBe(false);
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(activeRows(".session-item")).toHaveLength(1);
    expect(activeRowIndex(".session-item")).toBe(1); // the OTHER row's index
    const list = el("#message-list").textContent!;
    expect(list).toContain("other session line");
    expect(list).not.toContain("LV_L1 cold line");
  });
});

// Owner-ruled 2026-10-31: Cancel lives in the composer action row immediately
// left of Send, carrying the spinner; there is no standalone working row.
// Pinned here on the real app wiring.
describe("working state: spinnered composer Cancel (real app wiring)", () => {
  beforeAll(async () => {
    // Land on a known live session regardless of the previous suite's exit state.
    lvAttachBurst("working hello");
    await tick();
    expect(composerDisabled()).toBe(false);
  });

  const composerButtonIds = (): (string | null)[] =>
    Array.from(el("#composer-actions").children).map((c) => c.getAttribute("id"));

  it("idle: no indicator, no Stop in the composer", () => {
    expect(document.querySelector("#working-indicator")).toBeNull();
    expect(document.querySelector("#cancel-btn")).toBeNull();
  });

  it("working: Stop (carrying the spinner) sits inside #composer-actions left of Send", async () => {
    ws.fireMessage({ type: "sessionState", sessionId: LV_SID, key: "working", value: true });
    await tick();

    // The standalone working row is gone; the busy tell is the button itself.
    expect(document.querySelector("#working-indicator")).toBeNull();
    const cancel = el("#composer-actions #cancel-btn");
    expect(cancel.querySelector(".spinner")).toBeTruthy();
    expect(cancel.textContent).toContain("Stop");
    const ids = composerButtonIds();
    const cancelAt = ids.indexOf("cancel-btn");
    expect(cancelAt).toBeGreaterThanOrEqual(0);
    expect(ids[cancelAt + 1]).toBe("send-btn");
  });

  it("clicking Stop sends {type:cancel} and drops the button", async () => {
    ws.sent.length = 0;
    el("#cancel-btn").click();
    const cancelMsg = ws.sent
      .map((m) => JSON.parse(m) as { type: string; sessionId?: string })
      .find((m) => m.type === "cancel");
    expect(cancelMsg?.sessionId).toBe(LV_SID);
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
  const prevConfirm = g.confirm;
  let fenceConfirmCalls = 0;

  afterAll(() => {
    if (prevConfirm === undefined) delete g.confirm;
    else g.confirm = prevConfirm;
  });

  function stubConfirm(answer: boolean): void {
    fenceConfirmCalls = 0;
    g.confirm = () => {
      fenceConfirmCalls++;
      return answer;
    };
  }

  /** Re-attach to the log-view fixture session carrying a posture. */
  async function attachWithPosture(posture: string | undefined): Promise<void> {
    ws.fireMessage({
      type: "sessionCreated",
      sessionId: LV_SID,
      profile: "manager",
      title: null,
      currentModel: "m1",
      models: ["m1"],
      ...(posture !== undefined ? { toolExec: posture } : {}),
    });
    ws.fireMessage({ type: "sessionState", sessionId: LV_SID, key: "cursor", value: 9 });
    lvSidebarReplies();
    await tick();
  }

  const fenceMsgs = () =>
    ws.sent
      .map((m) => JSON.parse(m) as Record<string, unknown>)
      .filter((m) => m.type === "execFence");

  it("worker posture renders the clickable affordance and a naming tooltip", async () => {
    await attachWithPosture("worker (fence: bwrap)");
    const strip = el("#tool-exec-status");
    // Icon-only: the posture truth rides the aria-label (always) and the
    // title (clickable case); the icon identity (shield-check for an
    // in-force jail) rides the svg class.
    expect(strip.textContent).toBe("");
    expect(strip.getAttribute("aria-label")).toBe("Tool execution: worker (fence: bwrap)");
    expect(strip.querySelector("svg.fence-on")).toBeTruthy();
    expect(strip.getAttribute("class")).toContain("toggleable");
    // The clickable chip must never carry disabled: an inverted
    // disabled={fenceClickable} once made the live chip swallow every click
    // (disabled <button> eats the event) while every harness click still
    // worked -- the click-suppressing dom-helper now catches that, and this
    // pin names the invariant directly.
    expect(strip.hasAttribute("disabled")).toBe(false);
    // Button chrome lives in the class, not an inline style attribute.
    expect(strip.getAttribute("style")).toBeNull();
    // Hover text is the Sandbox Mode sentence (raw posture stays in the
    // aria-label); the toggle hint still rides for the live control.
    expect(strip.getAttribute("title")).toContain("Sandbox Mode: enabled (worker, bwrap)");
    expect(strip.getAttribute("title")).toContain("click to toggle this session's fence");
  });

  it("probe -> off: confirm->true sends execFence for the ATTACHED session only", async () => {
    stubConfirm(true);
    ws.sent.length = 0;
    el("#tool-exec-status").click();
    expect(fenceConfirmCalls).toBe(1);
    expect(fenceMsgs()).toEqual([{ type: "execFence", sessionId: LV_SID, policy: "off" }]);
  });

  it("probe -> off: confirm->false sends NOTHING", async () => {
    stubConfirm(false);
    ws.sent.length = 0;
    el("#tool-exec-status").click();
    expect(fenceConfirmCalls).toBe(1);
    expect(fenceMsgs()).toEqual([]);
  });

  it("the confirm states plainly that this session runs UNFENCED", async () => {
    let seen = "";
    g.confirm = (msg?: unknown) => {
      seen = String(msg ?? "");
      return false;
    };
    el("#tool-exec-status").click();
    expect(seen).toContain("Tools will run UNFENCED");
  });

  it("server-pushed posture update repaints the strip; off -> probe flips back WITHOUT confirm", async () => {
    stubConfirm(true);
    ws.fireMessage({
      type: "sessionState",
      sessionId: LV_SID,
      key: "toolExec",
      value: "worker (fence: off)",
    });
    await tick();
    // The repaint's truth rides the aria-label + the no-symbol identity
    // (deliberate off, error-tinted -- never a silent shield-check).
    expect(el("#tool-exec-status").getAttribute("aria-label")).toContain("fence: off");
    expect(el("#tool-exec-status").getAttribute("title")).toContain("Sandbox Mode: partial (worker, fence off)");
    expect(el("#tool-exec-status").querySelector("svg.fence-off")).toBeTruthy();
    expect(el("#tool-exec-status").querySelector("svg.fence-on")).toBeNull();
    // Still the clickable worker shape: clicking now proposes the tighten.
    ws.sent.length = 0;
    el("#tool-exec-status").click();
    expect(fenceConfirmCalls).toBe(0); // off -> probe is never confirm-gated
    expect(fenceMsgs()).toEqual([{ type: "execFence", sessionId: LV_SID, policy: "probe" }]);
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
    // The strip still carries OUR last server-pushed posture (the aria-label
    // carries it now).
    expect(el("#tool-exec-status").getAttribute("aria-label")).toContain("fence: off");
    expect(el("#tool-exec-status").getAttribute("aria-label")).not.toContain("seatbelt");
  });

  it("inline posture: inert strip, no class, no click effect", async () => {
    stubConfirm(true);
    await attachWithPosture("inline (unfenced)");
    const strip = el("#tool-exec-status");
    expect(strip.getAttribute("class") ?? "").not.toContain("toggleable");
    expect(strip.getAttribute("style")).toBeNull();
    // Inert inline posture: muted NEUTRAL shield, never a no-symbol and
    // never shield-check (nothing about confinement can be claimed here).
    expect(strip.querySelector("svg.fence-neutral")).toBeTruthy();
    expect(strip.getAttribute("title")).toBe("Sandbox Mode: off (inline)");
    ws.sent.length = 0;
    strip.click();
    expect(fenceMsgs()).toEqual([]);
    expect(fenceConfirmCalls).toBe(0);
  });

  it("log view (activeLogId set): inert, tooltip says live sessions only", async () => {
    stubConfirm(true);
    await attachWithPosture("worker (fence: bwrap)"); // clickable when live
    lvViewLog(LV_L1, "fence log line");
    await tick();
    expect(el("#log-view-label")).toBeTruthy();
    const strip = el("#tool-exec-status");
    expect(strip.getAttribute("class") ?? "").not.toContain("toggleable");
    expect(strip.getAttribute("title")).toContain("Sandbox Mode: enabled (worker, bwrap)");
    expect(strip.getAttribute("title")).toContain("live sessions only");
    ws.sent.length = 0;
    strip.click();
    expect(fenceMsgs()).toEqual([]);
    expect(fenceConfirmCalls).toBe(0);
    // Leave log view for the next scenario.
    el("#close-log-view-btn").click();
    lvAttachBurst("back live");
    await tick();
  });

  it("degraded posture: the chip's error chrome + a plain CHECKLESS shield (never shield-check)", async () => {
    await attachWithPosture("worker (fence: bwrap) [degraded: broker respawn cap]");
    const strip = el("#tool-exec-status");
    expect(strip.getAttribute("class")).toContain("tool-exec-degraded");
    expect(strip.getAttribute("class") ?? "").not.toContain("toggleable"); // degraded stays inert
    expect(strip.querySelector("svg.fence-degraded")).toBeTruthy();
    expect(strip.querySelector("svg.fence-on")).toBeNull();
    expect(strip.getAttribute("aria-label")).toContain("degraded");
    expect(strip.getAttribute("title")).toContain("-- degraded: broker respawn cap");
  });

  it("an unrecognized posture falls back to the neutral shield, never a lie", async () => {
    await attachWithPosture("worker (no plane)"); // outside the bwrap|seatbelt|off|probe-failed vocabulary
    const strip = el("#tool-exec-status");
    expect(strip.querySelector("svg.fence-neutral")).toBeTruthy();
    expect(strip.querySelector("svg.fence-on")).toBeNull();
    expect(strip.getAttribute("title")).toContain("Sandbox Mode: unknown posture");
    expect(strip.getAttribute("class") ?? "").not.toContain("toggleable");
  });

  it("a failed probe reads as the no-symbol on WARNING, not the deliberate-off error tint", async () => {
    await attachWithPosture("worker (fence: none -- probe failed)");
    const strip = el("#tool-exec-status");
    expect(strip.querySelector("svg.fence-probe-failed")).toBeTruthy();
    expect(strip.querySelector("svg.fence-off")).toBeNull();
    expect(strip.getAttribute("aria-label")).toContain("fence: none -- probe failed");
    expect(strip.getAttribute("title")).toContain("Sandbox Mode: partial (worker, fence failed)");
  });
});

// ── Client plug on live cards (bottom-right, from the sessions payload) ─────
// The count renders as the card's trailing plug icon (see sessions.test.tsx
// for the row grammar); through real app wiring that means every live row's
// figure comes straight from the payload's connectedClients. Render rules:
// 0/unattested renders nothing; 1 is icon-only (the plug is the inline svg
// idiom, so textContent stays empty); 2+ appends the number; native title is
// the tooltip, singular for one; aria-hidden decoration, not a tab stop.

describe("client plug on live cards", () => {
  async function fireSessions(rows: Record<string, unknown>[]): Promise<void> {
    ws.fireMessage({ type: "sessions", sessions: rows });
    await tick();
  }

  it("one client: icon-only (no number), singular tooltip, decoration", async () => {
    await fireSessions([{ ...lvSessionRow, connectedClients: 1 }]);
    const plug = el(".session-item .row-clients");
    expect(plug.textContent).toBe("");
    expect(plug.getAttribute("title")).toBe("1 client connected");
    expect(plug.getAttribute("tabindex")).toBeNull();
    expect(plug.getAttribute("aria-hidden")).toBe("true");
  });

  it("2+ clients: icon plus the number, plural tooltip", async () => {
    await fireSessions([{ ...lvSessionRow, connectedClients: 3 }]);
    expect(el(".session-item .row-clients").textContent).toBe("3");
    expect(el(".session-item .row-clients").getAttribute("title")).toBe("3 clients connected");
  });

  it("zero or unattested: no plug at all", async () => {
    await fireSessions([{ ...lvSessionRow, connectedClients: 0 }]);
    expect(document.querySelector(".session-item .row-clients")).toBeNull();
    const { connectedClients: _gone, ...bareRow } = lvSessionRow;
    await fireSessions([bareRow]);
    expect(document.querySelector(".session-item .row-clients")).toBeNull();
  });

  it("per-card counts never mix; no card text ever reads 'client'", async () => {
    await fireSessions([
      { ...lvSessionRow, connectedClients: 7 },
      { ...lvSessionRow, id: "s-other-0001", connectedClients: 1 },
    ]);
    // Position-independent: pin marks could re-sort the list, so key the
    // cards off the ACTIVE highlight (LV_SID is the attached session).
    const attached = activeRows(".session-item")[0]!;
    expect(attached.querySelector(".row-clients")!.textContent).toBe("7");
    expect(attached.querySelector(".row-clients")!.getAttribute("title")).toBe("7 clients connected");
    const other = els(".session-item").find((r) => r !== attached)!;
    expect(other.querySelector(".row-clients")!.textContent).toBe("");
    expect(other.querySelector(".row-clients")!.getAttribute("title")).toBe("1 client connected");
    for (const row of els(".session-item")) expect(row.textContent).not.toContain("client");
  });

  afterAll(async () => {
    await fireSessions([lvSessionRow]); // restore the fixture list for later consumers
  });
});

// ── Header reasoning-visibility chip (per-browser view preference) ──────────
// The chip sits immediately LEFT of the tool-exec chip and drives
// chat.toggleHideThinking: the value lands in the shared `store` localStorage
// stub and message-list sweeps every .thinking-block (committed + in-flight).
// It is a VIEW setting: nothing goes out on the wire, and the server's
// sessionState(hideThinking) (a CLI /thinking toggle) must not repaint it.
// Stays attached to LV_SID -- the suites after this one key their sidebar rows
// off "LV_SID is the attached session".

describe("header reasoning-visibility chip", () => {
  async function attachWithChip(): Promise<void> {
    ws.fireMessage({
      type: "sessionCreated",
      sessionId: LV_SID,
      profile: "manager",
      title: null,
      currentModel: "m1",
      models: ["m1"],
      toolExec: "worker (fence: probe)",
    });
    ws.fireMessage({ type: "sessionState", sessionId: LV_SID, key: "cursor", value: 4 });
    lvSidebarReplies();
    await tick();
  }

  const hiddenFlags = (): boolean[] => els(".thinking-block").map((b) => b.classList.contains("hidden"));

  it("renders left of the tool-exec chip, states its state, and explains itself", async () => {
    await attachWithChip();
    const chip = el("#thinking-toggle");
    expect(chip.localName).toBe("button");
    // Glyph-only chrome (the .file-reload-btn / #settings-btn idiom): zero text
    // node, a decorative aria-hidden svg carries the picture, and the STATE --
    // once read from the words -- now rides the aria-label + title. Shown reads
    // the FILLED thought bubble (thinking-on, text lines and all); the empty
    // thinking-off bubble must not be present.
    expect(chip.textContent).toBe("");
    expect(chip.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(chip.querySelector("svg.thinking-on")).toBeTruthy();
    expect(chip.querySelector("svg.thinking-off")).toBeNull();
    expect(chip.getAttribute("aria-label")).toContain("Reasoning shown");
    expect(chip.getAttribute("title")).toContain("Reasoning shown");
    expect(chip.getAttribute("title")).toContain("view setting only");
    expect(chip.getAttribute("title")).toContain("/thinking");
    const group = els(".header-status-group");
    expect(group).toHaveLength(2);
    // The pane's own toggles ride #chat-header: reasoning first, then the
    // fence posture (the fixture attaches a toolExec state).
    const chatGroup = el("#chat-header").querySelector(".header-status-group")!;
    expect(chatGroup.children[0]!.getAttribute("id")).toBe("thinking-toggle");
    expect(chatGroup.children[1]!.getAttribute("id")).toBe("tool-exec-status");
    // The top band's group ENDS with the workbench toggle: the connection
    // indicator left for the composer, so the dock's own control owns the
    // absolute edge.
    const kids = el("#session-info .header-status-group")!.children;
    expect(kids[kids.length - 1]!.getAttribute("id")).toBe("workbench-toggle");
  });

  it("click sweeps committed AND in-flight blocks, persists, and sends nothing", async () => {
    await attachWithChip();
    // One committed block (closed by the assistant row) and one still in flight.
    ws.fireMessage({ type: "thinking", content: "old thought" });
    ws.fireMessage({ type: "assistantMessage", content: "committed answer" });
    ws.fireMessage({ type: "thinking", content: "live thought" });
    await tick();
    expect(hiddenFlags()).toEqual([false, false]);

    const before = ws.sent.length;
    el("#thinking-toggle").click();
    await tick();
    expect(hiddenFlags()).toEqual([true, true]);
    // Hidden state: the SAME bubble with its text lines gone (thinking-off
    // present, thinking-on gone) and the aria-label names the state -- the
    // old text-label pin's truth, re-homed onto the glyph + accessible name.
    expect(el("#thinking-toggle").getAttribute("aria-label")).toContain("Reasoning hidden");
    expect(el("#thinking-toggle").querySelector("svg.thinking-off")).toBeTruthy();
    expect(el("#thinking-toggle").querySelector("svg.thinking-on")).toBeNull();
    expect(store.get(HIDE_THINKING_STORAGE_KEY)).toBe("1");

    el("#thinking-toggle").click();
    await tick();
    expect(hiddenFlags()).toEqual([false, false]);
    expect(el("#thinking-toggle").getAttribute("aria-label")).toContain("Reasoning shown");
    expect(el("#thinking-toggle").querySelector("svg.thinking-on")).toBeTruthy();
    expect(el("#thinking-toggle").querySelector("svg.thinking-off")).toBeNull();
    expect(store.get(HIDE_THINKING_STORAGE_KEY)).toBe("0");
    expect(ws.sent.length).toBe(before); // a view toggle never touches the wire
  });

  it("the server's sessionState(hideThinking) leaves this browser alone", async () => {
    await attachWithChip();
    ws.fireMessage({ type: "thinking", content: "the cli cannot hide me" });
    await tick();
    ws.fireMessage({ type: "sessionState", sessionId: LV_SID, key: "hideThinking", value: true });
    await tick();
    expect(hiddenFlags()).toEqual([false]);
    expect(el("#thinking-toggle").getAttribute("aria-label")).toContain("Reasoning shown");
    expect(el("#thinking-toggle").querySelector("svg.thinking-on")).toBeTruthy();
  });

  it("stays clickable in log view and sweeps the cold log's reasoning", async () => {
    await attachWithChip();
    ws.fireMessage({
      type: "logViewed",
      logId: LV_L1,
      entries: [{ source: "llm", content: "frozen answer", reasoning_content: "buried thought" }],
    });
    await tick();
    expect(el("#log-view-label")).toBeTruthy();
    expect(hiddenFlags()).toEqual([false]);

    el("#thinking-toggle").click(); // always clickable -- log view is the point
    await tick();
    expect(hiddenFlags()).toEqual([true]);
    expect(el("#thinking-toggle").getAttribute("aria-label")).toContain("Reasoning hidden");
    expect(el("#thinking-toggle").querySelector("svg.thinking-off")).toBeTruthy();

    // Leave cleanly for the suites that follow.
    el("#thinking-toggle").click();
    el("#close-log-view-btn").click();
    await tick();
    expect(el("#log-view-label")).toBeFalsy();
  });

  it("carries aria-pressed with the sibling search-chip idiom (audit 1.6)", async () => {
    await attachWithChip();
    // Same contract as #search-btn: the attribute rides only when pressed.
    // Pressed = the view deviation (reasoning hidden) is engaged; the
    // default shown state reads unpressed.
    expect(el("#thinking-toggle").getAttribute("aria-pressed")).toBeNull();
    el("#thinking-toggle").click();
    await tick();
    expect(el("#thinking-toggle").getAttribute("aria-pressed")).toBe("true");
    el("#thinking-toggle").click();
    await tick();
    expect(el("#thinking-toggle").getAttribute("aria-pressed")).toBeNull();
  });
});

// ── Header theme switcher (ui/theme-pref.ts + THEME_REGISTRY) ──────────────
// Per-browser palette: click cycles the registry, persisting to the store
// and re-tagging documentElement's data-theme. The default hotdog renders
// from the bare :root (attribute REMOVED); index.html's inline script
// pre-paints a stored pref and boot re-applies the same value. init() ran
// once per file (single-booter doctrine), so the "boot with a stored pref"
// cases call applyStoredTheme() -- the exact line init() runs.

describe("header theme switcher", () => {
  const root = document.documentElement;
  const btn = () => el("#theme-btn");

  it("boots hotdog with no stored pref and renders the glyph control", async () => {
    await attach();
    // init() ran with no THEME_STORAGE_KEY: the bare-:root default means NO
    // attribute, and boot writes nothing to storage.
    expect(root.getAttribute("data-theme")).toBeNull();
    expect(store.get(THEME_STORAGE_KEY)).toBeUndefined();
    expect(btn().localName).toBe("button"); // native: Enter/Space activate
    const title = btn().getAttribute("title")!;
    expect(title).toContain("Hotdog");
    expect(btn().getAttribute("aria-label")).toBe(title);
    const glyph = btn().querySelector("svg[aria-hidden='true']");
    expect(glyph).toBeTruthy(); // the inline palette glyph
    expect(glyph!.getAttribute("tabindex")).toBe("-1"); // no svg tab stops
    // Sits in the top band's group without disturbing the pinned slots.
    const group = el("#session-info .header-status-group")!;
    expect(Array.from(group.children).some((c) => c.getAttribute("id") === "theme-btn")).toBe(true);
  });

  it("click applies purple: attribute flips, title follows, persists, wire silent", async () => {
    const before = ws.sent.length;
    btn().click();
    await tick();
    expect(root.getAttribute("data-theme")).toBe("purple");
    expect(btn().getAttribute("title")).toContain("Purple");
    expect(store.get(THEME_STORAGE_KEY)).toBe("purple");
    expect(ws.sent.length).toBe(before); // a view toggle never touches the wire
  });

  it("click again cycles back to hotdog: attribute removed, persisted", async () => {
    btn().click();
    await tick();
    expect(root.getAttribute("data-theme")).toBeNull();
    expect(btn().getAttribute("title")).toContain("Hotdog");
    expect(store.get(THEME_STORAGE_KEY)).toBe("hotdog");
  });

  it("a boot with the pref stored applies purple (init's exact line)", async () => {
    store.set(THEME_STORAGE_KEY, "purple");
    expect(applyStoredTheme()).toBe("purple");
    expect(root.getAttribute("data-theme")).toBe("purple");
    // A stored DEFAULT (hotdog) is an attribute no-op: hotdog IS the bare
    // :root now, so no attribute appears even when the id was saved.
    store.set(THEME_STORAGE_KEY, "hotdog");
    expect(applyStoredTheme()).toBe(DEFAULT_THEME_ID);
    expect(root.getAttribute("data-theme")).toBeNull();
    // Leave for the suites that follow: hotdog (default) path, key cleared.
    store.delete(THEME_STORAGE_KEY);
    expect(applyStoredTheme()).toBe(DEFAULT_THEME_ID);
    expect(root.getAttribute("data-theme")).toBeNull();
  });

  it("a garbage stored value falls back to hotdog", async () => {
    store.set(THEME_STORAGE_KEY, "ketchup");
    expect(applyStoredTheme()).toBe(DEFAULT_THEME_ID);
    expect(root.getAttribute("data-theme")).toBeNull();
    store.delete(THEME_STORAGE_KEY);
  });

  it("throwing storage degrades to the default and never breaks anything", async () => {
    const win = window as unknown as { localStorage: unknown };
    const prev = win.localStorage;
    try {
      win.localStorage = {
        getItem() {
          throw new Error("SecurityError: storage access denied");
        },
        setItem() {
          throw new Error("SecurityError: storage access denied");
        },
        removeItem() {
          throw new Error("SecurityError: storage access denied");
        },
      };
      expect(() => applyStoredTheme()).not.toThrow();
      expect(root.getAttribute("data-theme")).toBeNull();
      // The switcher stays fully operable; a failed save only costs the reload.
      expect(() => btn().click()).not.toThrow();
      await tick();
      expect(root.getAttribute("data-theme")).toBe("purple");
      expect(btn().getAttribute("title")).toContain("Purple");
      expect(store.get(THEME_STORAGE_KEY)).toBeUndefined(); // nothing got through
    } finally {
      win.localStorage = prev;
    }
    // Sync back to hotdog (the default) for the suites that follow (real
    // storage again).
    btn().click();
    await tick();
    expect(root.getAttribute("data-theme")).toBeNull();
  });

  it("a third registry entry joins the cycle without touching the switcher", async () => {
    THEME_REGISTRY.push({ id: "mustard", label: "Mustard" });
    try {
      btn().click();
      await tick(); // hotdog -> purple: the title promises the new entry
      expect(btn().getAttribute("title")).toContain("Mustard");
      btn().click();
      await tick(); // purple -> mustard
      expect(root.getAttribute("data-theme")).toBe("mustard");
      expect(btn().getAttribute("title")).toContain("Mustard");
      expect(store.get(THEME_STORAGE_KEY)).toBe("mustard");
      btn().click();
      await tick(); // wraps back to the default (atom hotdog, store "hotdog")
      expect(root.getAttribute("data-theme")).toBeNull();
    } finally {
      THEME_REGISTRY.pop();
    }
  });
});

// ── Accessibility: composer escape hatches (focus-trap findings) ────────────

describe("a11y: composer focus escape hatches", () => {
  // Custom dispatch: the shared key() swallows preventDefault behind a no-op;
  // these pins need to OBSERVE it. Returns defaultPrevented.
  function keyTrack(node: Element, k: string, over: Record<string, unknown> = {}): boolean {
    let prevented = false;
    node.dispatchEvent({
      type: "keydown",
      key: k,
      currentTarget: node,
      preventDefault: () => {
        prevented = true;
      },
      ...over,
    } as unknown as Event);
    return prevented;
  }

  // "/"-style prefix -> server options -> popup rendered. Callers own the
  // popup afterwards and dismiss it before finishing.
  async function openCompletionPopup(): Promise<HTMLElement> {
    await attach();
    const box = el("#chat-input");
    setComposer("/mod");
    (box as unknown as { selectionStart: number | null }).selectionStart = 4;
    clearSent();
    key(box, "Tab");
    await tick();
    const req = sent<{ requestId: number }>("complete")[0]!;
    ws.fireMessage({
      type: "completions",
      requestId: req.requestId,
      prefix: "/mod",
      options: [{ value: "/model" }, { value: "/models" }],
    });
    await tick();
    return box;
  }

  it("Shift+Tab traverses: not prevented, and no completion request fires", async () => {
    await attach();
    const box = el("#chat-input");
    (box as unknown as { value: string }).value = "ship it";
    clearSent();
    // The trap: the old guard preventDefaulted BOTH directions and fired a
    // forward completion request off Shift+Tab too.
    expect(keyTrack(box, "Tab", { shiftKey: true })).toBe(false);
    await tick();
    expect(sent("complete")).toHaveLength(0);
  });

  it("forward Tab still requests completions (the completion UX is unchanged)", async () => {
    await attach();
    const box = el("#chat-input");
    setComposer("/mod");
    (box as unknown as { selectionStart: number | null }).selectionStart = 4;
    clearSent();
    expect(keyTrack(box, "Tab")).toBe(true);
    await tick();
    expect(sent("complete")).toHaveLength(1);
  });

  it("popup-open Tab and Shift+Tab cycle options (menu branch unchanged)", async () => {
    const box = await openCompletionPopup();
    expect(els(".completion-item")[0]!.classList.contains("active")).toBe(true);
    key(box, "Tab");
    await tick();
    expect(els(".completion-item")[1]!.classList.contains("active")).toBe(true);
    key(box, "Tab", { shiftKey: true });
    await tick();
    expect(els(".completion-item")[0]!.classList.contains("active")).toBe(true);
    key(box, "Escape"); // leave no popup for the suites that follow
    await tick();
    expect(document.querySelector("#completion-menu")).toBeNull();
  });

  it("Escape closes the popup first (focus stays), blurs on the second press", async () => {
    const box = await openCompletionPopup();
    box.focus();
    key(box, "Escape"); // press 1: popup dismissal only -- focus never moves
    await tick();
    expect(document.querySelector("#completion-menu")).toBeNull();
    expect(document.activeElement).toBe(box);
    box.focus();
    key(box, "Escape"); // press 2: no popup -> leave the field
    await tick();
    expect(document.activeElement).toBe(document.body);
    expect((box as unknown as { value: string }).value).toBe("/mod"); // text untouched
  });

  it("Escape with no popup open blurs the textarea and prevents its default", async () => {
    await attach();
    const box = el("#chat-input");
    box.focus();
    expect(document.activeElement).toBe(box);
    expect(keyTrack(box, "Escape")).toBe(true);
    expect(document.activeElement).toBe(document.body);
  });
});

// ── Accessibility: sidebar rows + context menus on the keyboard (audit 1.2) ─

describe("a11y: sidebar rows and menus on the keyboard", () => {
  it("rows are focusable list items inside role=list containers", async () => {
    await attach();
    expect(els(".session-item")[0]!.getAttribute("role")).toBe("listitem");
    expect(els(".session-item")[0]!.getAttribute("tabindex")).toBe("0");
    expect(els(".log-item")[0]!.getAttribute("role")).toBe("listitem");
    expect(els(".log-item")[0]!.getAttribute("tabindex")).toBe("0");
    expect(el("#session-list").getAttribute("role")).toBe("list");
    expect(el("#log-list").getAttribute("role")).toBe("list");
  });

  it("Enter on a cold log row opens that log (left-click parity)", async () => {
    await attach();
    clearSent();
    key(els(".log-item")[0]!, "Enter");
    await tick();
    expect(sent<{ logId: string }>("viewLog")[0]?.logId).toBe(L1);
  });

  it("Space on a live row switches to it and suppresses the page scroll", async () => {
    await attach();
    ws.fireMessage({
      type: "sessions",
      sessions: [sessionRow, { ...sessionRow, id: "s-kb-2" }],
    });
    await tick();
    const other = els(".session-item").find((r) => r.getAttribute("data-sid") === "s-kb-2")!;
    expect(other).toBeDefined();
    let prevented = false;
    other.dispatchEvent({
      type: "keydown",
      key: " ",
      currentTarget: other,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as Event);
    await tick();
    expect(sent<{ sessionId: string }>("switchSession")[0]?.sessionId).toBe("s-kb-2");
    expect(prevented).toBe(true);
  });

  it("the ContextMenu key opens the row menu; roles ride it, focus lands on the first item", async () => {
    await attach();
    const row = els(".session-item")[0]!;
    row.focus();
    key(row, "ContextMenu");
    await tick();
    const menu = el(".context-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    const items = els(".context-menu-item");
    expect(items.length).toBeGreaterThan(1);
    expect(items.map((i) => i.getAttribute("role"))).toEqual(items.map(() => "menuitem"));
    expect(items.every((i) => i.getAttribute("tabindex") === "-1")).toBe(true);
    expect(document.activeElement).toBe(items[0]!);
    key(menu, "Escape");
    await tick();
  });

  it("Shift+F10 opens the menu too (the browser that never fires contextmenu from keys)", async () => {
    await attach();
    const row = els(".session-item")[0]!;
    row.focus();
    key(row, "F10", { shiftKey: true });
    await tick();
    expect(el(".context-menu")).toBeTruthy();
    expect(document.activeElement).toBe(els(".context-menu-item")[0]!);
    key(el(".context-menu"), "Escape");
    await tick();
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("the row's visible menu button opens the menu without selecting the row", async () => {
    await attach();
    clearSent();
    const row = els(".session-item")[0]!;
    els(".row-menu-btn")[0]!.click();
    await tick();
    expect(el(".context-menu")).toBeTruthy();
    expect(sent("switchSession").length).toBe(0); // the click belongs to the button
    const menu = el(".context-menu");
    expect(document.activeElement).toBe(els(".context-menu-item")[0]!);
    key(menu, "Escape");
    await tick();
    // Focus-return lands on the row, not on the unmounted button.
    expect(document.activeElement).toBe(row);
  });

  it("Tab closes the menu WITHOUT preventDefault and returns focus to the row", async () => {
    await attach();
    const row = els(".session-item")[0]!;
    row.focus();
    key(row, "ContextMenu");
    await tick();
    const menu = el(".context-menu");
    let prevented = false;
    menu.dispatchEvent({
      type: "keydown",
      key: "Tab",
      currentTarget: menu,
      preventDefault: () => {
        prevented = true;
      },
    } as unknown as Event);
    await tick();
    expect(prevented).toBe(false); // traversal must continue
    expect(document.querySelector(".context-menu")).toBeNull(); // WAI: Tab dismisses
    // The dismissal hands focus to the row (not the unmounted item), so the
    // browser's Tab advance starts from a live element instead of <body>.
    expect(document.activeElement).toBe(row);
  });

  it("arrow keys traverse the menu (wrapping) and Escape closes + refocuses the row", async () => {
    await attach();
    const row = els(".session-item")[0]!;
    row.focus();
    key(row, "ContextMenu");
    await tick();
    const menu = el(".context-menu");
    const items = els(".context-menu-item");
    key(menu, "ArrowDown");
    await tick();
    expect(document.activeElement).toBe(items[1]!);
    key(menu, "ArrowUp");
    key(menu, "ArrowUp");
    await tick();
    expect(document.activeElement).toBe(items[items.length - 1]!); // wraps past the top
    key(menu, "Escape");
    await tick();
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(document.activeElement).toBe(row);
  });

  it("Enter activates the highlighted item and focus returns to the row", async () => {
    await attach();
    const row = els(".session-item")[0]!;
    row.focus();
    key(row, "ContextMenu");
    await tick();
    clearSent();
    key(els(".context-menu-item")[0]!, "Enter"); // Pin leads every menu
    await tick();
    expect(sent<{ sessionId: string }>("setPinned")[0]?.sessionId).toBe(SID);
    expect(document.querySelector(".context-menu")).toBeNull();
    expect(document.activeElement).toBe(row);
    // The next attach's applyPinnedFlags reconciles the optimistic pin away.
  });
});

// ── Accessibility: search dialog Escape focus return + live region ──────────

describe("a11y: search dialog focus", () => {
  it("Escape in the search input closes the panel and refocuses #search-btn", async () => {
    await attach();
    el("#search-btn").click();
    await tick();
    const input = el("#search-input");
    expect(document.activeElement).toBe(input); // openSearch auto-focus
    key(input, "Escape");
    await tick();
    expect(document.querySelector("#search-panel")).toBeNull();
    expect(document.activeElement).toBe(el("#search-btn"));
  });

  it("the X button closes the panel and refocuses #search-btn (same handoff as Escape)", async () => {
    await attach();
    el("#search-btn").click();
    await tick();
    // The ✕ unmounts its own panel: focus must not drop to <body>.
    el("#search-clear").click();
    await tick();
    expect(document.querySelector("#search-panel")).toBeNull();
    expect(document.activeElement).toBe(el("#search-btn"));
  });

  it("activating a search hit hands focus to the revealed row, not <body>", async () => {
    await attach();
    el("#search-btn").click();
    await tick();
    const input = el("#search-input");
    (input as unknown as { value: string }).value = "needle";
    input.dispatchEvent({ type: "input", currentTarget: input } as unknown as Event);
    clearSent();
    await sleep(300); // the search debounce
    const [req] = sent<{ requestId: number }>("searchLogs");
    ws.fireMessage({
      type: "searchResults",
      requestId: req!.requestId,
      query: "needle",
      results: [
        { logId: L1, lastActivityAt: 2, matchCount: 1, profile: "manager", live: false, snippets: ["a needle line"] },
      ],
    });
    await tick();
    el(".search-hit").click(); // the hit unmounts with the panel
    await tick();
    const row = els(".log-item").find((r) => r.getAttribute("data-sid") === L1)!;
    expect(row).toBeDefined();
    expect(document.querySelector("#search-panel")).toBeNull();
    expect(document.activeElement).toBe(row);
  });
});

// ── Workbench pane (real app wiring) ────────────────────────────────────────────────
// The header chip opens the right-docked pane; the app's own createPanelResize
// instance persists the seam keys hotdog.workbenchWidth /
// hotdog.workbenchCollapsed; the tab strip paints from the workbench-state
// store through the app's subscription. Runs before the auth lifecycle and
// leaves the pane collapsed, exactly as a first visit would.

describe("workbench pane (real app wiring)", () => {
  const wbHandle = (): HTMLElement => {
    const h = el("#workbench-resize");
    const any = h as unknown as Record<string, unknown>;
    any.offsetParent ??= {};
    any.setPointerCapture ??= () => {};
    return h;
  };
  const wbPointer = (type: string, over: Record<string, unknown> = {}): void => {
    const h = wbHandle();
    h.dispatchEvent({ type, currentTarget: h, ...over } as unknown as Event);
  };

  it("boots first-run collapsed: the seed persisted, no pane DOM at all", async () => {
    await attach();
    expect(store.get("hotdog.workbenchCollapsed")).toBe("1"); // init()'s first-run seed
    expect(el("#workbench-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector("#workbench-panel")).toBeNull();
  });

  it("the chip opens the pane, aria-expanded follows, and the handle carries the seam's aria", async () => {
    el("#workbench-toggle").click();
    await tick();
    expect(el("#workbench-panel")).toBeTruthy();
    expect(el("#workbench-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(el("#workbench-toggle").getAttribute("title")).toBe("Toggle Workbench (right pane sidebar)");
    expect(store.get("hotdog.workbenchCollapsed")).toBe("0");
    const h = wbHandle();
    expect(h.getAttribute("role")).toBe("separator");
    expect(h.getAttribute("aria-orientation")).toBe("vertical");
    // Stubbed viewport 1200: max = max(320, min(1680, 1200*0.6)) = 720.
    expect(h.getAttribute("aria-valuenow")).toBe("420");
    expect(h.getAttribute("aria-valuemin")).toBe("320");
    expect(h.getAttribute("aria-valuemax")).toBe("720");
  });

  it("dragging RIGHT shrinks (nearEdge) and release writes hotdog.workbenchWidth", () => {
    wbPointer("pointerdown", { pointerId: 1, clientX: 900 });
    wbPointer("pointermove", { pointerId: 1, clientX: 960 });
    const docStyle = (document.documentElement as unknown as { style: { getPropertyValue: (n: string) => string } }).style;
    expect(docStyle.getPropertyValue("--workbench-width")).toBe("360px");
    wbPointer("pointerup", { pointerId: 1, clientX: 960 });
    expect(store.get("hotdog.workbenchWidth")).toBe("360");
  });

  it("End on a wide viewport lifts the pane to the new static max", () => {
    // 0.6*3000 = 1800 sits above the static 1680: the px max now binds, so a
    // wide screen really can hand the workbench most of its width.
    win.innerWidth = 3000;
    key(wbHandle(), "End", { currentTarget: wbHandle() });
    expect(wbHandle().getAttribute("aria-valuenow")).toBe("1680");
    expect(store.get("hotdog.workbenchWidth")).toBe("1680");
    // Back to the stubbed viewport; double-click restores the default width
    // and forgets the key, leaving the suite state clean.
    win.innerWidth = 1200;
    wbPointer("dblclick");
    expect(wbHandle().getAttribute("aria-valuenow")).toBe("420");
    expect(store.has("hotdog.workbenchWidth")).toBe(false);
  });

  it("tabs injected through the state module paint the strip; emptying it brings the honest line", async () => {
    workbenchStore.open({ id: "w1", kind: "placeholder", label: "a.ts", dirty: false });
    await tick();
    expect(els("#workbench-tabs [role=tab]").map((b) => b.textContent)).toEqual(["a.ts"]);
    workbenchStore.close("w1");
    await tick();
    expect(document.querySelector("#workbench-tabs")).toBeNull();
    expect(el("#workbench-empty").textContent).toBe("Files will open here");
  });

  it("the second toggle closes the pane and leaves the app collapsed", async () => {
    el("#workbench-toggle").click();
    await tick();
    expect(document.querySelector("#workbench-panel")).toBeNull();
    expect(store.get("hotdog.workbenchCollapsed")).toBe("1");
  });
});

// ── Workbench workspace-tree dock pin (the tree header's disclosure) ───────
// ONE stored preference (hotdog.workbenchTreePinned) + the pane-width gate
// (>= WORKBENCH_TREE_PIN_MIN_WIDTH = the default 420): pinning docks the
// workspace tree as a fixed left column inside the dock and seats the
// "files" tab nowhere; releasing restores every seat. Below the min the
// pin auto-releases and the button hides while the preference survives
// for the next wide pane. The projection combos live in workbench.test.tsx
// (shell); this section pins the app wiring, the gate and the storage. The
// key boots UNWRITTEN (default tab mode) -- pinned below before anything
// can write it. The section leaves no trace: key back at "0", width key
// forgotten, tabs closed, pane collapsed.

describe("workbench workspace-tree dock pin (real app wiring)", () => {
  const treePinBtn = (): HTMLElement | null =>
    els("#workbench-panel .file-reload-btn").find(
      (b) => b.getAttribute("aria-label") === "Toggle workspace tree dock",
    ) ?? null;
  const handle = (): HTMLElement => {
    const h = el("#workbench-resize");
    const any = h as unknown as Record<string, unknown>;
    any.offsetParent ??= {};
    any.setPointerCapture ??= () => {};
    return h;
  };
  const seamPointer = (type: string, over: Record<string, unknown> = {}): void => {
    const h = handle();
    h.dispatchEvent({ type, currentTarget: h, ...over } as unknown as Event);
  };

  it("opens at default width: the button rides right of Refresh, unpressed, the key never written", async () => {
    await attach();
    expect(store.has("hotdog.workbenchTreePinned")).toBe(false); // read at boot; a toggle is the only writer
    el("#workbench-toggle").click();
    await tick();
    workbenchStore.open({ id: "files", kind: "files", label: "Files", dirty: false });
    await tick();
    const btn = treePinBtn();
    expect(btn).toBeTruthy();
    expect(btn!.getAttribute("aria-expanded")).toBe("false");
    expect(btn!.textContent).toBe(""); // glyph-only, like the whole chip family
    expect(btn!.querySelectorAll("rect[height='3.2']")).toHaveLength(3); // the lined dock
    // Right of Refresh in the tree header's actions group.
    const kids = el(".ft-header-actions").children;
    expect(kids[0]!.getAttribute("aria-label")).toBe("Refresh");
    expect(kids[1]!).toBe(btn!);
    // Flat life: the tree is the active tab's body, not a column.
    expect(document.querySelector(".workbench-tree-col")).toBeNull();
    expect(el("#wtab-files").getAttribute("aria-selected")).toBe("true");
  });

  it("the click docks: class, column, unseated files tab, honest empty body, pref written; the socket stays silent", async () => {
    const before = ws.sent.length;
    treePinBtn()!.click();
    await tick();
    expect(el("#workbench-panel").getAttribute("class")).toContain("workbench-tree-pinned");
    expect(document.querySelector(".workbench-tree-col .file-tree")).toBeTruthy();
    expect(document.querySelector("#workbench-body .file-tree")).toBeNull(); // not doubled
    expect(document.querySelector("#wtab-files")).toBeNull(); // no seat while docked
    expect(document.querySelector("#workbench-tabs")).toBeNull(); // nothing selectable: no tablist
    expect(document.querySelector("#workbench-open-files")).toBeNull(); // docked already: no entry into a seatless tab
    expect(el("#workbench-empty").textContent).toBe("Files will open here");
    expect(el(".workbench-tree-col #workbench-tree-pin").getAttribute("aria-expanded")).toBe("true");
    // The docked column carries its OWN handle at its right border (the tree
    // <> file-viewer line) in THIS shape too: the seam is wired in both modes,
    // so the docked tree is resizable and can never starve the viewer side.
    // Stubbed viewport 1200: the 0.3 fraction says 360, but the dock's own 420
    // minus the 200 viewer floor binds first -- and the reported value is
    // shape-clamped like the CSS cap (the tree's 260 default renders 220 here
    // and grows back to 260 with the wide editor pane), so the handle never
    // claims a width the dock cannot show.
    const seam = el("#tree-col-resize");
    expect(seam.getAttribute("role")).toBe("separator");
    expect(seam.getAttribute("aria-orientation")).toBe("vertical");
    expect(seam.getAttribute("aria-label")).toBe("Resize workspace tree width");
    expect(seam.getAttribute("aria-valuenow")).toBe("220"); // 260 default, dock-capped
    expect(seam.getAttribute("aria-valuemin")).toBe("150");
    expect(seam.getAttribute("aria-valuemax")).toBe("220");
    expect(store.has("hotdog.treeColWidth")).toBe(false); // a mount writes nothing
    expect(store.get("hotdog.workbenchTreePinned")).toBe("1");
    expect(ws.sent.length).toBe(before); // a view preference speaks no wire
  });

  it("file tabs ride beside the docked tree", async () => {
    workbenchStore.open({ id: "/x.ts", kind: "file", label: "x.ts", dirty: false });
    await tick();
    expect(els("#workbench-tabs .workbench-tab")).toHaveLength(1); // only the file keeps a seat
    expect(document.querySelector("#workbench-empty")).toBeNull();
    expect(el("#workbench-body .workbench-tab-body")).toBeTruthy();
    expect(document.querySelector(".workbench-tree-col .file-tree")).toBeTruthy();
  });

  it("drag below 420 RELEASES the pin (button hides, files tab reseats, the pref survives); dragging back re-applies", async () => {
    // nearEdge: drag RIGHT by 60 shrinks 420 -> 360 (the seam's own pin).
    seamPointer("pointerdown", { pointerId: 1, clientX: 900 });
    seamPointer("pointermove", { pointerId: 1, clientX: 960 });
    seamPointer("pointerup", { pointerId: 1, clientX: 960 });
    await tick();
    expect(treePinBtn()).toBeNull(); // a narrow pane pins nothing
    expect(el("#workbench-panel").getAttribute("class") ?? "").not.toContain("workbench-tree-pinned");
    expect(document.querySelector(".workbench-tree-col")).toBeNull();
    expect(el("#wtab-files")).toBeTruthy(); // back in its seat
    expect(store.get("hotdog.workbenchTreePinned")).toBe("1"); // the want survives the refused can
    // And wide again: the preference re-applies itself, no re-click.
    seamPointer("pointerdown", { pointerId: 1, clientX: 960 });
    seamPointer("pointermove", { pointerId: 1, clientX: 900 });
    seamPointer("pointerup", { pointerId: 1, clientX: 900 });
    await tick();
    expect(el("#workbench-panel").getAttribute("class")).toContain("workbench-tree-pinned");
    expect(treePinBtn()!.getAttribute("aria-expanded")).toBe("true");
  });

  it("the release click, the width reset, and the teardown leave the app exactly as it was", async () => {
    treePinBtn()!.click();
    await tick();
    expect(el("#workbench-panel").getAttribute("class") ?? "").not.toContain("workbench-tree-pinned");
    expect(store.get("hotdog.workbenchTreePinned")).toBe("0");
    expect(el("#wtab-files")).toBeTruthy();
    expect(document.querySelector(".workbench-tree-col")).toBeNull();
    // Suite hygiene: double-click resets the seam width AND forgets the key;
    // close every injected tab; collapse the pane -- first-visit shape.
    seamPointer("dblclick");
    expect(store.has("hotdog.workbenchWidth")).toBe(false);
    for (const t of [...workbenchStore.get().tabs]) workbenchStore.close(t.id);
    await tick();
    el("#workbench-toggle").click();
    await tick();
    expect(document.querySelector("#workbench-panel")).toBeNull();
  });
});

// ── Chat/Editor mode (top-band swap; the dock flag keeps its meaning) ──────
// One class on #workspace-row is the whole structural story the DOM can
// show (no CSS engine here -- the layout's truth is the CHAT/EDITOR MODE
// block in styles.css): the mode swaps what the slots WEAR, never re-parents
// anything, and the collapse flag keeps meaning "the right dock is closed"
// whichever tenant the dock carries, and the SESSIONS SIDEBAR travels to
// the right dock beside the chat -- it never disappears, so neither does
// its disclosure. Entering the mode PINS the tree through
// the pref's own path (the default is [tree | viewer]) but the pin button
// stays live: one release frees the viewer to the full workspace -- the
// focus shape -- and the tree rides as a tab again. The dock is TWO numbers
// and each border carries the handle that owns it: #dock-resize (mounted on
// #workspace-row) sizes the sessions+chat BLOCK at its left border, the
// sidebar's own handle sizes the RAIL at the sessions<->chat line, and
// #tree-col-resize stays the tree rail's own seam. The suite
// starts from the shape the dock-pin teardown left (chat mode, dock
// collapsed, tree unpinned) and leaves exactly that shape behind it.

describe("chat/editor mode (top-band toggle)", () => {
  const wireSeam = (id: string): HTMLElement => {
    const h = el(id);
    const any = h as unknown as Record<string, unknown>;
    any.offsetParent ??= {};
    any.setPointerCapture ??= () => {};
    return h;
  };
  const dragSeam = (id: string, type: string, over: Record<string, unknown> = {}): void => {
    const h = wireSeam(id);
    h.dispatchEvent({ type, currentTarget: h, ...over } as unknown as Event);
  };
  const treePinBtn = (): HTMLElement | null =>
    els("#workbench-panel .file-reload-btn").find(
      (b) => b.getAttribute("aria-label") === "Toggle workspace tree dock",
    ) ?? null;

  it("boots in chat mode from the stored '0': no swap class, the key never rewritten", async () => {
    await attach();
    expect(store.get("hotdog.editorMode")).toBe("0");
    expect((el("#workspace-row").getAttribute("class") ?? "")).not.toContain("editor-mode");
    const btn = el("#editor-mode-toggle");
    expect(btn.getAttribute("aria-pressed")).toBe("false");
    expect(btn.getAttribute("aria-label")).toBe("Toggle chat/editor mode");
    expect(btn.getAttribute("title")).toContain("Editor mode off");
    expect(btn.textContent).toBe(""); // glyph-only chrome, like the whole band
    expect(btn.querySelector("svg[aria-hidden='true']")).toBeTruthy();
    expect(btn.querySelectorAll("path")).toHaveLength(4); // two mirrored arrow runs
    // Chat mode owns the labels: the dock's tenant is the workbench.
    expect(el("#workbench-toggle").getAttribute("aria-label")).toBe("Toggle workbench pane");
    expect(document.querySelector("#dock-resize")).toBeNull(); // the dock's seam is editor-only
    expect(document.querySelector("#tree-col-resize")).toBeNull(); // and the tree's follows the COLUMN (unpinned here)
  });

  it("enters with the dock CLOSED and leaves it closed: the panel mounts, tree PINNED by default (the button stays live), the chat hides without unmounting", async () => {
    expect(document.querySelector("#workbench-panel")).toBeNull(); // the resting shape
    const chatBefore = el("#chat-area");
    const listBefore = el("#message-list"); // the imperative transcript's home
    const sidebarPrefBefore = store.get("hotdog.sidebarCollapsed"); // whatever the suite left
    clearSent();
    el("#editor-mode-toggle").click();
    await tick();
    expect(el("#workspace-row").getAttribute("class")).toContain("editor-mode");
    expect(el("#editor-mode-toggle").getAttribute("aria-pressed")).toBe("true");
    expect(el("#editor-mode-toggle").getAttribute("title")).toContain("Editor mode on");
    expect(store.get("hotdog.editorMode")).toBe("1");
    // The workspace default: [tree | viewer]. The pin rides the SAME pref the
    // dock uses (entering the mode wrote it through the toggle's own path;
    // leaving takes it back -- one preference, two shapes, no shadow).
    expect(store.get("hotdog.workbenchTreePinned")).toBe("1");
    expect(el("#workbench-panel").getAttribute("class")).toContain("workbench-tree-pinned");
    expect(document.querySelector(".workbench-tree-col .file-tree")).toBeTruthy();
    expect(els("#workbench-panel .file-reload-btn").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Refresh",
      "Toggle workspace tree dock", // the release stays ONE CLICK away even here
    ]);
    expect(treePinBtn()!.getAttribute("aria-expanded")).toBe("true");
    // The tree column carries its own seam's handle (not the rail's).
    expect(el("#tree-col-resize").getAttribute("aria-label")).toBe("Resize workspace tree width");
    // Zero file tabs: the strip stays silent, the empty line speaks, and the
    // tree-entry button cannot re-activate a seatless tab.
    expect(document.querySelector("#workbench-tabs")).toBeNull();
    expect(el("#workbench-empty").textContent).toBe("Files will open here");
    expect(document.querySelector("#workbench-open-files")).toBeNull();
    // The chat is the docked thing, HIDDEN by the shared flag -- hidden,
    // never gone: the same live nodes ride under the hide.
    expect(el("#chat-area").getAttribute("class")).toContain("chat-dock-hidden");
    expect(el("#chat-area")).toBe(chatBefore);
    expect(el("#message-list")).toBe(listBefore);
    // The sessions rail travels with the dock: still mounted (while the dock
    // is CLOSED the CSS hides it -- owner ruling 2026-11-14, pinned in
    // webui-editor-dock-css.test.ts; the dom-helper has no CSSOM), still on
    // its own pref (mode flips never rewrite it), and its disclosure's
    // machinery stays live -- in this shape the rail sits right beside the
    // chat header.
    const disclosure = el("#sidebar-toggle");
    expect(disclosure.getAttribute("aria-expanded")).toBe(sidebarPrefBefore === "1" ? "false" : "true");
    expect(el("#sidebar").classList.contains("sidebar-hidden")).toBe(sidebarPrefBefore === "1");
    expect(store.get("hotdog.sidebarCollapsed")).toBe(sidebarPrefBefore);
    disclosure.click();
    await tick();
    expect(el("#sidebar").classList.contains("sidebar-hidden")).toBe(sidebarPrefBefore !== "1");
    expect(store.get("hotdog.sidebarCollapsed")).toBe(sidebarPrefBefore === "1" ? "0" : "1");
    disclosure.click(); // back where the suite found it
    await tick();
    expect(store.get("hotdog.sidebarCollapsed")).toBe(sidebarPrefBefore);
    // The dock toggle changes tenant honestly.
    expect(el("#workbench-toggle").getAttribute("aria-label")).toBe("Toggle chat dock");
    expect(el("#workbench-toggle").getAttribute("aria-expanded")).toBe("false");
    expect(el("#dock-resize").getAttribute("aria-label")).toBe("Resize the right dock");
    // Entering the mode IS a tree open: exactly the roots listing goes out
    // (no path), so the rail never stares at a request nobody sent.
    expect(sent("listDir")).toHaveLength(1);
    expect("path" in sent<{ path?: unknown }>("listDir")[0]!).toBe(false);
  });

  it("one pin release frees the FULLSCREEN viewer: the tree drops to a tab, its handle goes; re-pinning docks it back", async () => {
    treePinBtn()!.click();
    await tick();
    expect((el("#workbench-panel").getAttribute("class") ?? "")).not.toContain("workbench-tree-pinned");
    expect(document.querySelector(".workbench-tree-col")).toBeNull();
    expect(store.get("hotdog.workbenchTreePinned")).toBe("0");
    // No column, no handle for a column that is not there.
    expect(document.querySelector("#tree-col-resize")).toBeNull();
    // The store never learned the tab in this suite, so the freed workspace
    // shows the honest empty line -- WITH its entry button back (unpinned).
    expect(el("#workbench-empty").textContent).toBe("Files will open here");
    clearSent();
    el("#workbench-open-files").click();
    await tick();
    expect(sent("listDir")).toHaveLength(1); // opening the tree re-requests (doctrine)
    expect(el("#wtab-files").getAttribute("aria-selected")).toBe("true");
    expect(el("#workbench-body .file-tree")).toBeTruthy(); // the tree as a TAB
    // And the pin button rides the tab body's header too (same FileTree).
    expect(treePinBtn()!.getAttribute("aria-expanded")).toBe("false");
    treePinBtn()!.click();
    await tick();
    expect(document.querySelector(".workbench-tree-col .file-tree")).toBeTruthy();
    expect(document.querySelector("#wtab-files")).toBeNull(); // back off its seat
    expect(el("#tree-col-resize")).toBeTruthy(); // the handle follows the column
    expect(store.get("hotdog.workbenchTreePinned")).toBe("1");
  });

  it("the shared flag now steers the CHAT: the disclosure opens the dock; each handle sizes the border it owns", async () => {
    el("#workbench-toggle").click();
    await tick();
    expect((el("#chat-area").getAttribute("class") ?? "")).not.toContain("chat-dock-hidden");
    expect(el("#workbench-toggle").getAttribute("aria-expanded")).toBe("true");
    expect(el("#workbench-panel").getAttribute("class")).toContain("workbench-tree-pinned");
    expect(store.get("hotdog.workbenchCollapsed")).toBe("0");
    // THE BLOCK (D). #dock-resize rides the dock's LEFT edge (the
    // viewer<->sessions line) on its own seam: nearEdge, so dragging LEFT by
    // 60 grows the whole sessions+chat block, and the RAIL's number is none
    // of its business. Stubbed viewport 1200 caps D at 0.6*1200 = 720 --
    // exactly the default -- so the drag lifts the window first and puts it
    // back (the workbench suite's wide-End idiom). Starts read live, never
    // hardcoded: the seam is shared module state.
    const dockStart = Number(el("#dock-resize").getAttribute("aria-valuenow"));
    const railStart = Number(el("#sidebar-resize").getAttribute("aria-valuenow"));
    const railKeyBefore = store.get("hotdog.sidebarWidth");
    win.innerWidth = 2000;
    dragSeam("#dock-resize", "pointerdown", { pointerId: 7, clientX: 900 });
    dragSeam("#dock-resize", "pointermove", { pointerId: 7, clientX: 840 });
    dragSeam("#dock-resize", "pointerup", { pointerId: 7, clientX: 840 });
    win.innerWidth = 1200;
    await tick();
    expect(el("#dock-resize").getAttribute("aria-valuenow")).toBe(String(dockStart + 60));
    expect(store.get("hotdog.editorDockWidth")).toBe(String(dockStart + 60));
    expect(store.get("hotdog.sidebarWidth")).toBe(railKeyBefore); // the rail did not move
    // The tree rail's OWN seam sizes it through #tree-col-resize (the
    // column flexes to --tree-col-width): far-edge grammar, drag RIGHT by
    // 60 grows it by 60. It never touches --sidebar-width (that stays the
    // docked sessions rail's number).
    const treeStart = Number(el("#tree-col-resize").getAttribute("aria-valuenow"));
    dragSeam("#tree-col-resize", "pointerdown", { pointerId: 8, clientX: 200 });
    dragSeam("#tree-col-resize", "pointermove", { pointerId: 8, clientX: 260 });
    dragSeam("#tree-col-resize", "pointerup", { pointerId: 8, clientX: 260 });
    await tick();
    expect(el("#tree-col-resize").getAttribute("aria-valuenow")).toBe(String(treeStart + 60));
    expect(store.get("hotdog.treeColWidth")).toBe(String(treeStart + 60));
    expect(store.get("hotdog.sidebarWidth")).not.toBe(String(treeStart + 60));
    // THE RAIL (S). The sidebar's own handle stays live in this shape -- its
    // border IS the sessions<->chat line -- and it drags the RAIL only:
    // far-edge grammar (drag RIGHT by 60 widens the rail), the chat column
    // absorbs the difference, so D and the block's outer edges hold. The
    // seam caps the rail at D - CHAT_DOCK_MIN_WIDTH (280) in editor mode
    // and 0.6*1200 = 720 on the stub, both far above a +60 step.
    dragSeam("#sidebar-resize", "pointerdown", { pointerId: 9, clientX: 600 });
    dragSeam("#sidebar-resize", "pointermove", { pointerId: 9, clientX: 660 });
    dragSeam("#sidebar-resize", "pointerup", { pointerId: 9, clientX: 660 });
    await tick();
    expect(el("#sidebar-resize").getAttribute("aria-valuenow")).toBe(String(railStart + 60));
    expect(store.get("hotdog.sidebarWidth")).toBe(String(railStart + 60));
    expect(el("#dock-resize").getAttribute("aria-valuenow")).toBe(String(dockStart + 60));
    expect(store.get("hotdog.editorDockWidth")).toBe(String(dockStart + 60));
  });

  it("leaving the mode hands the layout back with both flags intact; the teardown restores the first-visit shape", async () => {
    // Forget every width the drags wrote (each seam forgets its own key on
    // reset). The rail's pref must end UNWRITTEN like the rest of the suite
    // left it -- later sections never saw a stored sidebarWidth.
    dragSeam("#dock-resize", "dblclick");
    dragSeam("#tree-col-resize", "dblclick");
    dragSeam("#sidebar-resize", "dblclick");
    await tick();
    expect(store.has("hotdog.editorDockWidth")).toBe(false);
    expect(store.has("hotdog.treeColWidth")).toBe(false);
    expect(store.has("hotdog.sidebarWidth")).toBe(false);
    el("#editor-mode-toggle").click(); // back to chat -- the dock is OPEN, so the pane returns open
    await tick();
    expect((el("#workspace-row").getAttribute("class") ?? "")).not.toContain("editor-mode");
    expect((el("#chat-area").getAttribute("class") ?? "")).not.toContain("chat-dock-hidden");
    expect(el("#workbench-panel")).toBeTruthy(); // the shared flag: dock open means the pane shows
    // The pin pref rode along into the dock (420 passes the gate): one
    // preference means the same column question in either shape.
    expect(el("#workbench-panel").getAttribute("class")).toContain("workbench-tree-pinned");
    expect(el("#sidebar-toggle").localName).toBe("button"); // the disclosure never left
    expect(el("#sidebar")).toBeTruthy(); // and neither did the rail
    expect(el("#workbench-toggle").getAttribute("aria-label")).toBe("Toggle workbench pane");
    expect(document.querySelector("#dock-resize")).toBeNull(); // the editor dock's seam leaves with the mode
    // The tree column's handle does NOT: it follows the COLUMN, and the pin
    // rode along into the dock, so the chat-mode tree <> viewer border keeps
    // its seam (which is exactly where it lives in the docked shape).
    expect(el("#tree-col-resize").getAttribute("aria-label")).toBe("Resize workspace tree width");
    expect(store.get("hotdog.editorMode")).toBe("0");
    // Suite hygiene: release the pin (the dock-pin section's shape), close
    // the injected tab, collapse the dock -- first-visit shape.
    treePinBtn()!.click();
    await tick();
    expect(store.get("hotdog.workbenchTreePinned")).toBe("0");
    for (const t of [...workbenchStore.get().tabs]) workbenchStore.close(t.id);
    await tick();
    el("#workbench-toggle").click();
    await tick();
    expect(document.querySelector("#workbench-panel")).toBeNull();
    expect(store.get("hotdog.workbenchCollapsed")).toBe("1");
  });
});

// The shared editor snapshot the settings suites paint (module scope: both
// the viewer rail-filter test and the editor suite ride it).
const editPayload = (requestId: number): Record<string, unknown> => ({
  type: "configSnapshotResult",
  requestId,
  ts: 1700000000000,
  configDir: "/cfg",
  files: [{ path: "/cfg/defaults.json", inUse: true, status: "ok" }],
  findings: [],
  sections: [
    {
      name: "webui",
      rows: [
        { key: "webui.port", description: "WebUI server port", default: 3000, file: 3000, resolved: 3000, edit: { type: "number" } },
        { key: "webui.host", description: "WebUI server host", default: "127.0.0.1", resolved: "127.0.0.1" },
        { key: "webui.apiKey", description: "API key for login authentication.", default: null, resolved: null, leafSecret: true, redacted: true },
        { key: "webui.enabled", description: "Enable the WebUI", default: true, resolved: true, edit: { type: "boolean" } },
      ],
    },
    {
      name: "providers",
      // Card-shaped snapshot (server groundwork 2026-11-11): the top `providers`
      // chrome (section heading), then per element a chrome HEADER row (NO edit
      // stamp -- the card header owns it; a wholesale container write is refused
      // as provider-list chrome) followed by the element's field rows.
      rows: [
        { key: "providers", description: "Model providers", file: [{ name: "p1" }, { name: "p2" }] },
        { key: "providers[0]", description: "Provider entry", file: { name: "p1", url: "http://127.0.0.1:8000/v1" } },
        { key: "providers[0].url", description: "Provider base URL", file: "http://127.0.0.1:8000/v1", edit: { type: "string" } },
        { key: "providers[0].apiKey", description: "Provider API key.", leafSecret: true, file: null, redacted: true, edit: { type: "string", writeOnly: true } },
        { key: "providers[1]", description: "Provider entry", file: { name: "p2", url: "http://127.0.0.1:8100/v1" } },
        { key: "providers[1].url", description: "Provider base URL", file: "http://127.0.0.1:8100/v1", edit: { type: "string" } },
      ],
    },
    {
      name: "workspace",
      rows: [
        { key: "workspace.paths", description: "Workspace roots", file: ["/home/u/proj"], edit: { type: "json" } },
      ],
    },
    {
      name: "loop-detect",
      rows: [
        { key: "loopDetect.repeatThreshold", description: "Identical repeats before the first nudge", default: 3, resolved: 3, edit: { type: "integer", minimum: 2, maximum: 12 } },
      ],
    },
  ],
});

// ── Settings viewer (settings button -> dialog, real app wiring) ───────────

describe("settings viewer (real app wiring)", () => {
  const snapshotPayload = (requestId: number): Record<string, unknown> => ({
    type: "configSnapshotResult",
    requestId,
    ts: 1700000000000,
    configDir: "/cfg",
    files: [{ path: "/cfg/defaults.json", inUse: true, status: "ok" }],
    findings: [],
    sections: [
      {
        name: "core",
        rows: [
          { key: "theme", description: "Theme", default: "dark", file: "light", resolved: "light" },
          { key: "apiKey", leafSecret: true, redacted: true, resolved: null },
        ],
      },
    ],
  });

  it("the settings button opens the dialog and re-fetches; matching reply paints; Escape returns focus", async () => {
    await attach();
    clearSent();
    // Chip chrome (the .toggleable fill, not the browser-default grey) +
    // the pressed state mirrors the dialog (owner 2026-11-09).
    expect(el("#settings-btn").getAttribute("class")).toContain("toggleable");
    expect(el("#settings-btn").getAttribute("title")).toBe("Settings Menu");
    expect(el("#settings-btn").textContent).toBe("");
    expect(el("#settings-btn").getAttribute("aria-expanded")).toBe("false");
    el("#settings-btn").click();
    await tick();
    expect(el("#settings-btn").getAttribute("aria-expanded")).toBe("true");
    const reqs = sent<{ requestId: number }>("configSnapshot");
    expect(reqs).toHaveLength(1);
    const dialog = el("#settings-view");
    expect(dialog.getAttribute("role")).toBe("dialog");
    // openSettings focuses the dialog root (queueMicrotask idiom).
    expect(document.activeElement).toBe(dialog);
    ws.fireMessage(snapshotPayload(reqs[0]!.requestId));
    await tick();
    // The Zed row renders the DERIVED label; the redaction wording survives.
    expect(el(".settings-row").getAttribute("data-key")).toBe("theme");
    expect(el(".settings-row .settings-row-label").textContent).toBe("Theme");
    expect(el("#settings-view").textContent).toContain("set (redacted)");
    // The rail: search input + the category list with counts.
    expect(el(".settings-search")).toBeTruthy();
    expect(el(".settings-cat .settings-cat-title").textContent).toBe("All settings");
    key(el("#settings-view"), "Escape");
    await tick();
    expect(document.querySelector("#settings-view")).toBeNull();
    expect(document.activeElement).toBe(el("#settings-btn"));
    expect(el("#settings-btn").getAttribute("aria-expanded")).toBe("false");
  });

  it("every open re-fetches with a fresh id and stale replies drop", async () => {
    await attach();
    clearSent();
    el("#settings-btn").click();
    await tick();
    // Live-at-open: one open issues exactly one configSnapshot request.
    expect(sent("configSnapshot").length).toBe(1);
    const first = sent<{ requestId: number }>("configSnapshot").pop()!;
    // A stale reply (older id) must not paint anything.
    ws.fireMessage(snapshotPayload(first.requestId - 1));
    await tick();
    expect(document.querySelector(".settings-row")).toBeNull();
    // Close + reopen: a NEW request id goes out (config may have changed).
    key(el("#settings-view"), "Escape");
    await tick();
    clearSent();
    el("#settings-btn").click();
    await tick();
    const second = sent<{ requestId: number }>("configSnapshot").pop()!;
    expect(second.requestId).toBeGreaterThan(first.requestId);
    ws.fireMessage(snapshotPayload(second.requestId));
    await tick();
    expect(els(".settings-row").length).toBe(2);
  });

  it("Refresh re-issues with a fresh id; the ✕ button hands focus back to the settings button", async () => {
    await attach();
    clearSent();
    el("#settings-btn").click();
    await tick();
    const first = sent<{ requestId: number }>("configSnapshot").pop()!;
    const refresh = settingsRefresh();
    // The glyph-button standard: zero text; the aria-label (above) + the
    // glyph carry the button.
    expect(refresh.textContent).toBe("");
    expect(refresh.querySelector(".file-reload-glyph[aria-hidden='true']")).toBeTruthy();
    // Opened snapshot still in flight: Refresh is busy-disabled, so this
    // scripted dispatch (not a trusted click) models the pre-repaint race
    // and drives the superseded-id drop below.
    refresh.dispatchEvent(new Event("click"));
    await tick();
    const second = sent<{ requestId: number }>("configSnapshot").pop()!;
    expect(second.requestId).toBeGreaterThan(first.requestId);
    // An in-flight reply for the superseded id drops even though it lands after.
    ws.fireMessage(snapshotPayload(first.requestId));
    await tick();
    expect(document.querySelector(".settings-row")).toBeNull();
    ws.fireMessage(snapshotPayload(second.requestId));
    await tick();
    expect(els(".settings-row").length).toBe(2);
    els(".settings-close")[0]!.click();
    await tick();
    expect(document.querySelector("#settings-view")).toBeNull();
    expect(document.activeElement).toBe(el("#settings-btn"));
  });

  it("the rail filters: a category click filters the pane, the search flattens, closing resets both", async () => {
    await attach();
    el("#settings-btn").click();
    await tick();
    const req = sent<{ requestId: number }>("configSnapshot").pop()!;
    ws.fireMessage(editPayload(req.requestId));
    await tick();
    clearSent();
    // Click the Providers category: the card layout paints (one card per
    // element; the chrome heading + header rows are card chrome, NOT flat
    // .settings-row dumps; the field rows live inside their card body).
    const provCat = els(".settings-cat").find((c) => c.querySelector(".settings-cat-title")!.textContent === "Providers")!;
    provCat.click();
    await tick();
    expect(els(".settings-provider-card").map((c) => c.getAttribute("data-key"))).toEqual(["providers[0]", "providers[1]"]);
    expect(els(".settings-row").map((r) => r.getAttribute("data-key"))).toEqual([
      "providers[0].url",
      "providers[0].apiKey",
      "providers[1].url",
    ]);
    // The search box (live, client-side): matches keyPath AND description,
    // flattening across categories with a chip naming each row's home. The
    // RAIL filters too: only Providers holds a match, count at match level.
    const search = el(".settings-search");
    (search as unknown as { value: string }).value = "base url";
    search.dispatchEvent({ type: "input" } as unknown as Event);
    await tick();
    expect(els(".settings-row").map((r) => r.getAttribute("data-key"))).toEqual(["providers[0].url", "providers[1].url"]);
    expect(el(".settings-row .settings-cat-chip")!.textContent).toBe("Providers");
    expect(els(".settings-cat").map((c) => c.querySelector(".settings-cat-title")!.textContent)).toEqual(["All settings", "Providers"]);
    expect(els(".settings-cat").map((c) => c.querySelector(".settings-cat-count")!.textContent)).toEqual(["2", "2"]);
    // Escape inside a non-empty box clears the search FIRST and does NOT close
    // (owner 2026-11-11, mirroring the JSON-collapse precedent). The rail
    // returns to snapshot truth; the surviving Providers selection narrows
    // the restored pane -- the field's live value goes down with the query.
    key(el("#settings-view"), "Escape");
    await tick();
    expect(el("#settings-view")).toBeTruthy();
    expect(els(".settings-search")[0]!.getAttribute("value") ?? "").toBe("");
    expect((els(".settings-search")[0] as unknown as { value: string }).value).toBe("");
    expect(els(".settings-row").map((r) => r.getAttribute("data-key"))).toEqual([
      "providers[0].url",
      "providers[0].apiKey",
      "providers[1].url",
    ]);
    expect(els(".settings-cat").map((c) => c.querySelector(".settings-cat-title")!.textContent)).toEqual([
      "All settings",
      "WebUI",
      "Providers",
      "Loop Detect",
      "Workspace",
    ]);
    expect(els(".settings-cat").map((c) => c.querySelector(".settings-cat-count")!.textContent)).toEqual(["8", "4", "2", "1", "1"]);
    // Escape with the box empty now closes. Closing retires the filter state:
    // the next visit is the full sweep.
    key(el("#settings-view"), "Escape");
    await tick();
    expect(document.querySelector("#settings-view")).toBeNull();
    el("#settings-btn").click();
    await tick();
    ws.fireMessage(editPayload(sent<{ requestId: number }>("configSnapshot").pop()!.requestId));
    await tick();
    expect(els(".settings-row").length).toBe(9);
    expect(els(".settings-search")[0]!.getAttribute("value") ?? "").toBe("");
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("the search x button clears the query, restores the unfiltered pane and the full rail, and keeps focus in the box", async () => {
    await attach();
    el("#settings-btn").click();
    await tick();
    ws.fireMessage(editPayload(sent<{ requestId: number }>("configSnapshot").pop()!.requestId));
    await tick();
    const search = el(".settings-search");
    expect(el(".settings-search-clear")).toBeNull(); // empty box: no affordance at all
    (search as unknown as { value: string }).value = "port";
    search.dispatchEvent({ type: "input" } as unknown as Event);
    await tick();
    expect(els(".settings-row").map((r) => r.getAttribute("data-key"))).toEqual(["webui.port"]);
    expect(els(".settings-search-clear")).toHaveLength(1);
    search.focus();
    els(".settings-search-clear")[0]!.click();
    await tick();
    expect(els(".settings-search-clear")).toHaveLength(0); // the x retires with the query
    expect(document.activeElement).toBe(search); // focus stayed in the search field
    expect((els(".settings-search")[0] as unknown as { value: string }).value).toBe("");
    // Unfiltered group list + full snapshot-truth rail are back.
    expect(els(".settings-row").length).toBe(9);
    expect(els(".settings-cat").map((c) => c.querySelector(".settings-cat-count")!.textContent)).toEqual(["8", "4", "2", "1", "1"]);
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("click-outside does NOT close (config values get selected)", async () => {
    await attach();
    el("#settings-btn").click();
    await tick();
    document.body.dispatchEvent({ type: "mousedown", currentTarget: document.body } as unknown as Event);
    await tick();
    expect(el("#settings-view")).toBeTruthy();
    key(el("#settings-view"), "Escape");
    await tick();
  });
});

// ── Settings focus: the JSON reveal + the armed provider Remove ─────────────
// Both interactions REPLACE the focused control (the reveal swaps the Edit
// JSON button for the textarea; arming swaps Remove for the confirm pair), so
// without an explicit handoff focus drops to <body> and the next Tab restarts
// from the top of the document (owner bug report 2026-11-11). The reveal must
// land the caret in THAT row's textarea; the collapse must hand focus back.
// FOCUS OBSERVABILITY: the dom-helper already tracks document.activeElement
// through focus()/blur() (the a11y affordance seam, the same seam the
// provider-card focus pin below uses) -- no helper extension was needed.

describe("settings focus: JSON reveal + armed Remove (real app wiring)", () => {
  // THREE json-stamped rows plus a live scalar FIRST in document order: an
  // implementation that grabs the first .settings-edit-input in the pane (the
  // old document-wide selector) or the first textarea is caught cold.
  const jsonPayload = (requestId: number): Record<string, unknown> => ({
    type: "configSnapshotResult",
    requestId,
    ts: 1700000000000,
    configDir: "/cfg",
    files: [{ path: "/cfg/defaults.json", inUse: true, status: "ok" }],
    findings: [],
    sections: [
      {
        name: "webui",
        rows: [{ key: "webui.port", description: "WebUI server port", default: 3000, file: 3000, resolved: 3000, edit: { type: "number" } }],
      },
      {
        name: "prompts",
        rows: [
          { key: "prompts.displayPrompt", description: "Rendered system prompt", file: "one", resolved: "one", edit: { type: "json" } },
          { key: "prompts.batonNotice", description: "Baton notice prose", file: "two", resolved: "two", edit: { type: "json" } },
        ],
      },
      {
        name: "workspace",
        rows: [{ key: "workspace.paths", description: "Workspace roots", file: ["/srv"], resolved: ["/srv"], edit: { type: "json" } }],
      },
    ],
  });

  /** Open the dialog against the three-json-row snapshot. */
  async function openJson(): Promise<void> {
    await attach();
    el("#settings-btn").click();
    await tick();
    ws.fireMessage(jsonPayload(sent<{ requestId: number }>("configSnapshot").pop()!.requestId));
    await tick();
  }
  const rowOf = (key: string): HTMLElement =>
    els(".settings-row").find((r) => r.getAttribute("data-key") === key)!;

  it("Edit JSON focuses THAT row's textarea, not the first editable control or textarea", async () => {
    await openJson();
    const row = rowOf("prompts.batonNotice"); // the SECOND json row (document order)
    (row.querySelector(".settings-json-open") as unknown as HTMLElement).click();
    await tick();
    const area = row.querySelector(".settings-edit-json");
    expect(area).toBeTruthy();
    expect(document.activeElement).toBe(area);
    // The row was brought into view (the dom-helper records the call).
    expect((area as unknown as { scrollIntoViewCalls: unknown[] }).scrollIntoViewCalls.length).toBeGreaterThan(0);
    // Exactly one textarea exists and the other rows keep their buttons.
    expect(els(".settings-edit-json")).toHaveLength(1);
    expect(rowOf("prompts.displayPrompt").querySelector(".settings-json-open")).toBeTruthy();
    // The old selector's victim: the first .settings-edit-input in the pane
    // (the webui.port stepper value) is NOT what took focus.
    expect(document.activeElement).not.toBe(rowOf("webui.port").querySelector(".settings-edit-input"));
    key(el("#settings-view"), "Escape"); // collapse (staged ladder)...
    await tick();
    key(el("#settings-view"), "Escape"); // ...then close
    await tick();
  });

  it("Cancel collapses and hands focus back to THAT row's Edit JSON button", async () => {
    await openJson();
    const row = rowOf("workspace.paths");
    (row.querySelector(".settings-json-open") as unknown as HTMLElement).click();
    await tick();
    expect(document.activeElement).toBe(row.querySelector(".settings-edit-json"));
    (row.querySelector(".settings-cancel") as unknown as HTMLElement).click();
    await tick();
    expect(row.querySelector(".settings-edit-json")).toBeNull();
    expect(document.activeElement).toBe(row.querySelector(".settings-json-open"));
    expect(el("#settings-view")).toBeTruthy(); // collapsing never closes
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("Escape inside the textarea collapses it (never closes) and returns focus to the button", async () => {
    await openJson();
    const row = rowOf("workspace.paths");
    (row.querySelector(".settings-json-open") as unknown as HTMLElement).click();
    await tick();
    key(row.querySelector(".settings-edit-json") as Element, "Escape");
    await tick();
    expect(el("#settings-view")).toBeTruthy(); // the textarea owns the first Escape
    expect(row.querySelector(".settings-edit-json")).toBeNull();
    expect(document.activeElement).toBe(row.querySelector(".settings-json-open"));
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("arming Remove moves focus to the Confirm control; Cancel and Escape hand it back to Remove", async () => {
    await attach();
    el("#settings-btn").click();
    await tick();
    ws.fireMessage(editPayload(sent<{ requestId: number }>("configSnapshot").pop()!.requestId));
    await tick();
    const card = els(".settings-provider-card").find((c) => c.getAttribute("data-key") === "providers[0]")!;
    (card.querySelector(".settings-provider-remove") as unknown as HTMLElement).click();
    await tick();
    const yes = card.querySelector(".settings-provider-remove-yes");
    expect(yes).toBeTruthy();
    // The focused Remove was replaced -- the confirm pair takes the focus.
    expect(document.activeElement).toBe(yes);
    // Cancel disarms and returns to the row's Remove control.
    const cancelBtn = (Array.from(card.querySelectorAll(".settings-btn")) as unknown as HTMLElement[]).find(
      (b) => b.textContent === "Cancel",
    )!;
    cancelBtn.click();
    await tick();
    expect(card.querySelector(".settings-provider-remove-yes")).toBeNull();
    expect(document.activeElement).toBe(card.querySelector(".settings-provider-remove"));
    // Escape disarms the same way (staged ladder, dialog stays open).
    (card.querySelector(".settings-provider-remove") as unknown as HTMLElement).click();
    await tick();
    key(el("#settings-view"), "Escape");
    await tick();
    expect(el("#settings-view")).toBeTruthy();
    expect(card.querySelector(".settings-provider-remove-yes")).toBeNull();
    expect(document.activeElement).toBe(card.querySelector(".settings-provider-remove"));
    key(el("#settings-view"), "Escape");
    await tick();
  });
});
// ── Settings editor (immediate-save controls -> setConfigKey on the wire) ───
// The socket half of the editor (redesign C6: NO Edit click for scalars):
// the app parses the control's text, mints a WRITE id from its own sequence
// (independent of the snapshot id), serializes writes through one in-flight
// slot with a last-write-wins queue, and settles rows only from the reply
// carrying that id. Rejections render verbatim and REVERT the control; the
// restart marker follows the reply's needsRestart field. The pure state
// doctrine + widgets are pinned in settings-editor.test.tsx.

describe("settings editor (real app wiring)", () => {
  /** Open the dialog against the editor snapshot; returns the snapshot id. */
  async function openSnapshot(): Promise<number> {
    await attach();
    clearSent();
    el("#settings-btn").click();
    await tick();
    const req = sent<{ requestId: number }>("configSnapshot").pop()!;
    ws.fireMessage(editPayload(req.requestId));
    await tick();
    return req.requestId;
  }

  const rowFor = (keyName: string): HTMLElement =>
    els(".settings-row").find((r) => r.getAttribute("data-key") === keyName)!;
  const labeled = (scope: HTMLElement, label: string): HTMLElement | undefined =>
    Array.from(scope.querySelectorAll("button")).find((b) => b.textContent === label) as unknown as HTMLElement | undefined;
  const ariaBtn = (scope: HTMLElement, aria: string): HTMLElement | undefined =>
    Array.from(scope.querySelectorAll("button")).find((b) => b.getAttribute("aria-label") === aria) as unknown as HTMLElement | undefined;
  const fieldOf = (keyName: string): HTMLElement & { value: string } =>
    rowFor(keyName).querySelector(".settings-edit-input") as unknown as HTMLElement & { value: string };
  const blur = (node: Element): void => {
    node.dispatchEvent({ type: "blur" } as unknown as Event);
  };
  const settleLast = async (result: Record<string, unknown>): Promise<void> => {
    const frame = sent<{ requestId: number }>("setConfigKey").pop()!;
    ws.fireMessage({ type: "setConfigKeyResult", requestId: frame.requestId, ...result });
    await tick();
  };

  it("stamped rows carry live controls; the rest stay inert (value + honest hint)", async () => {
    await openSnapshot();
    expect(rowFor("webui.port").querySelector(".settings-edit-input")).toBeTruthy();
    expect(rowFor("webui.enabled").querySelector('[role="switch"]')).toBeTruthy();
    expect(rowFor("webui.host").querySelector(".settings-edit-input")).toBeNull();
    expect(rowFor("webui.host").querySelector(".settings-file-hint")!.textContent).toContain("edit in file");
    // A redacted row without a stamp (ancient reply) gets no affordance but
    // does get the honest edit-in-file hint (judge finding #3, 2026-11-09).
    expect(rowFor("webui.apiKey").querySelector("input")).toBeNull();
    expect(rowFor("webui.apiKey").querySelector(".settings-file-hint")!.textContent).toContain("edit in file");
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("an unchanged blur is ZERO wire traffic; a typed blur sends setConfigKey with its own write id; id crossings drop; the matching reply paints the echo + banner", async () => {
    const snapId = await openSnapshot();
    const field = fieldOf("webui.port");
    expect(field.getAttribute("value")).toBe("3000");
    // An honest unchanged blur (the field holds what the panel seeded): no frame.
    field.value = "3000";
    blur(field);
    await tick();
    expect(sent("setConfigKey")).toHaveLength(0);
    field.value = "4399";
    clearSent();
    blur(field);
    await tick();
    const frames = sent<{ requestId: number; keyPath: string; value: unknown }>("setConfigKey");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyPath).toBe("webui.port");
    expect(frames[0]!.value).toBe(4399); // parsed to a NUMBER before the wire
    const saveId = frames[0]!.requestId!;
    expect(typeof saveId).toBe("number");
    // The row says "saving" while the reply is out.
    expect(rowFor("webui.port").className).toContain("settings-row-pending");

    // A snapshot refresh rides the OTHER sequence: the in-flight save survives
    // it, and a write reply carrying the SNAPSHOT id is not the reply this row
    // waits for.
    settingsRefresh().click();
    await tick();
    const refreshed = sent<{ requestId: number }>("configSnapshot").pop()!.requestId;
    expect(refreshed).toBeGreaterThan(snapId);
    ws.fireMessage({ type: "setConfigKeyResult", requestId: refreshed, ok: true, value: 777, needsRestart: true });
    await tick();
    expect(document.querySelector(".settings-restart")).toBeNull();
    expect(rowFor("webui.port").className).toContain("settings-row-pending"); // still in flight
    expect(rowFor("webui.port").textContent).not.toContain("restart pending");

    // The matching reply: row from the SERVER echo, banner up, pending gone.
    ws.fireMessage({ type: "setConfigKeyResult", requestId: saveId, ok: true, value: 4399, needsRestart: true });
    await tick();
    expect(fieldOf("webui.port").getAttribute("value")).toBe("4399");
    expect(rowFor("webui.port").className).not.toContain("settings-row-pending");
    const banner = el(".settings-restart");
    expect(banner.textContent).toContain("Restart required");
    expect(banner.getAttribute("role")).toBe("status");

    // Settled: that id is spent, so a late/duplicate reply is inert.
    ws.fireMessage({ type: "setConfigKeyResult", requestId: saveId, ok: true, value: 999, needsRestart: true });
    await tick();
    expect(fieldOf("webui.port").getAttribute("value")).toBe("4399");

    // The next save gets a STRICTLY FRESHER write id, and the banner survives it.
    clearSent();
    fieldOf("webui.port").value = "4400";
    blur(fieldOf("webui.port"));
    await tick();
    expect(sent<{ requestId: number }>("setConfigKey").pop()!.requestId).toBeGreaterThan(saveId);
    expect(document.querySelector(".settings-restart")).toBeTruthy();

    // Closing retires the banner: the next visit is honest against its own snapshot.
    key(el("#settings-view"), "Escape");
    await tick();
    clearSent();
    el("#settings-btn").click();
    await tick();
    ws.fireMessage(editPayload(sent<{ requestId: number }>("configSnapshot").pop()!.requestId));
    await tick();
    expect(document.querySelector(".settings-restart")).toBeNull();
    expect(fieldOf("webui.port").getAttribute("value")).toBe("3000");
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("a toggle flip rides value as a BOOLEAN; a second flip while pending QUEUES (no parallel second save) and drains freshest-first", async () => {
    await openSnapshot();
    clearSent();
    const toggle = () => rowFor("webui.enabled").querySelector('[role="switch"]') as unknown as HTMLElement;
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    toggle().click();
    await tick();
    let frames = sent<{ requestId: number; value?: unknown }>("setConfigKey");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.value).toBe(false); // the flip is the save, boolean on `value`
    expect(toggle().getAttribute("aria-checked")).toBe("false"); // optimistic while pending

    // Flip AGAIN while the first is in flight: NO parallel frame -- the queue
    // holds the newest intent instead.
    toggle().click();
    await tick();
    expect(sent("setConfigKey")).toHaveLength(1);
    expect(toggle().getAttribute("aria-checked")).toBe("true"); // the queued intent shows

    // Settle the first: the queued write goes out with a fresher id.
    ws.fireMessage({ type: "setConfigKeyResult", requestId: frames[0]!.requestId, ok: true, value: false, needsRestart: true });
    await tick();
    frames = sent<{ requestId: number; value?: unknown }>("setConfigKey");
    expect(frames).toHaveLength(2);
    expect(frames[1]!.value).toBe(true);
    expect(frames[1]!.requestId).toBeGreaterThan(frames[0]!.requestId);

    // Settle the queue too (the row lands on true, the reply echo attests).
    ws.fireMessage({ type: "setConfigKeyResult", requestId: frames[1]!.requestId, ok: true, value: true, needsRestart: true });
    await tick();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("the stepper: plus/minus steps a BOUNDED integer on `value` and clamps at the bounds without wire traffic", async () => {
    await openSnapshot();
    clearSent();
    const row = () => rowFor("loopDetect.repeatThreshold");
    ariaBtn(row(), "Increase loopDetect.repeatThreshold")!.click();
    await tick();
    let frames = sent<{ keyPath: string; value?: unknown }>("setConfigKey");
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyPath).toBe("loopDetect.repeatThreshold");
    expect(frames[0]!.value).toBe(4);
    await settleLast({ ok: true, value: 4, needsRestart: true });
    expect(fieldOf("loopDetect.repeatThreshold").getAttribute("value")).toBe("4");
    ariaBtn(row(), "Decrease loopDetect.repeatThreshold")!.click();
    await tick();
    expect(sent("setConfigKey").pop()!.value).toBe(3);
    await settleLast({ ok: true, value: 3, needsRestart: true });
    // Clamp: hold the field at the floor (2) -- minus has nothing to save.
    fieldOf("loopDetect.repeatThreshold").value = "2";
    clearSent();
    ariaBtn(row(), "Decrease loopDetect.repeatThreshold")!.click();
    await tick();
    expect(sent("setConfigKey")).toHaveLength(0);
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("the ALL-the-settings channels: scalars ride value, json and writeOnly ride valueText", async () => {
    await openSnapshot();
    // A string scalar with an INDEXED keyPath goes out verbatim on `value`.
    fieldOf("providers[0].url").value = "http://127.0.0.1:9100/v1";
    clearSent();
    blur(fieldOf("providers[0].url"));
    await tick();
    let frame = sent<{ keyPath: string; value?: unknown; valueText?: unknown }>("setConfigKey").pop()!;
    expect(frame.keyPath).toBe("providers[0].url");
    expect(frame.value).toBe("http://127.0.0.1:9100/v1");
    expect("valueText" in frame).toBe(false);
    // Settle it (a save in flight queues anything further).
    await settleLast({ ok: true, value: "http://127.0.0.1:9100/v1", needsRestart: true });

    // A json container: Edit JSON reveals the textarea; the RAW textarea text
    // rides valueText, never value. (workspace.paths -- a provider element is
    // chrome now: the whole-element JSON editor is retired, the card + the
    // list ops own it, and the server refuses a container write there.)
    labeled(rowFor("workspace.paths"), "Edit JSON")!.click();
    await tick();
    const area = rowFor("workspace.paths").querySelector("textarea.settings-edit-input") as unknown as { value: string };
    area.value = '["/srv/new"]';
    clearSent();
    labeled(rowFor("workspace.paths"), "Save")!.click();
    await tick();
    frame = sent<{ keyPath: string; value?: unknown; valueText?: unknown }>("setConfigKey").pop()!;
    expect(frame.keyPath).toBe("workspace.paths");
    expect(frame.valueText).toBe('["/srv/new"]');
    expect("value" in frame).toBe(false);
    // Its ok reply updates the row from the ECHOED text (re-parsed), collapses
    // the textarea, and the cell shows the persisted value.
    await settleLast({ ok: true, valueText: '["/srv/new"]', needsRestart: true });
    expect(rowFor("workspace.paths").querySelector(".settings-value")!.textContent).toContain("/srv/new");

    // A writeOnly secret: empty Set refuses CLIENT-side (no frame, honest
    // hint); a typed Set rides valueText; its reply patches the row to the
    // "set (redacted)" display plus the pending marker -- value:null echoes.
    clearSent();
    labeled(rowFor("providers[0].apiKey"), "Set")!.click();
    await tick();
    expect(sent("setConfigKey")).toHaveLength(0);
    expect(rowFor("providers[0].apiKey").querySelector(".settings-edit-error")!.textContent).toContain("no new value entered");
    (rowFor("providers[0].apiKey").querySelector(".settings-edit-secret") as unknown as { value: string }).value = "FRESH-SECRET";
    labeled(rowFor("providers[0].apiKey"), "Set")!.click();
    await tick();
    frame = sent<{ keyPath: string; value?: unknown; valueText?: unknown }>("setConfigKey").pop()!;
    expect(frame.valueText).toBe("FRESH-SECRET");
    expect("value" in frame).toBe(false);
    await settleLast({ ok: true, value: null, redacted: true, needsRestart: true });
    expect(rowFor("providers[0].apiKey").querySelector(".settings-value")!.textContent).toBe("set (redacted)");
    expect(rowFor("providers[0].apiKey").textContent).toContain("restart pending");
    // The REPLACE box never shows anything: cleared on Set, still empty after.
    expect((rowFor("providers[0].apiKey").querySelector(".settings-edit-secret") as unknown as { value: string }).value).toBe("");
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("a refusal renders the server text VERBATIM, reverts the control, and never claims a save", async () => {
    await openSnapshot();
    const field = fieldOf("webui.port");
    field.value = "0";
    clearSent();
    blur(field);
    await tick();
    const id = sent<{ requestId: number }>("setConfigKey").pop()!.requestId;
    const message = '"webui.port" must be >= 1 (got 0)';
    ws.fireMessage({ type: "setConfigKeyResult", requestId: id, ok: false, error: message });
    await tick();
    const err = rowFor("webui.port").querySelector(".settings-edit-error")!;
    expect(err.textContent).toBe(message);
    expect(err.getAttribute("role")).toBe("alert");
    // REVERT: the control re-seeds from the last server-known value (3000)
    // and the row is no longer pending.
    expect(fieldOf("webui.port").getAttribute("value")).toBe("3000");
    expect(rowFor("webui.port").className).not.toContain("settings-row-pending");
    expect(document.querySelector(".settings-restart")).toBeNull(); // a refusal never claims a save
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("the restart marker is DRIVEN by the reply: ok WITHOUT needsRestart persists but raises no banner/badge", async () => {
    await openSnapshot();
    clearSent();
    const toggle = () => rowFor("webui.enabled").querySelector('[role="switch"]') as unknown as HTMLElement;
    toggle().click();
    await tick();
    await settleLast({ ok: true, value: false }); // Phase 9 shape: no needsRestart on this key
    expect(document.querySelector(".settings-restart")).toBeNull();
    expect(rowFor("webui.enabled").textContent).not.toContain("restart pending");
    // The write itself still persisted honestly (no queue churn).
    expect(sent("setConfigKey")).toHaveLength(1);
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("a parse miss never reaches the socket", async () => {
    await openSnapshot();
    const field = fieldOf("webui.port");
    field.value = "banana";
    clearSent();
    blur(field);
    await tick();
    expect(sent("setConfigKey")).toHaveLength(0);
    expect(rowFor("webui.port").querySelector(".settings-edit-error")!.textContent).toContain('"banana" is not a number');
    // No edit mode to retreat from: Escape closes the dialog (the control
    // stays live with the hint until a good save replaces it).
    key(el("#settings-view"), "Escape");
    await tick();
    expect(document.querySelector("#settings-view")).toBeNull();
  });

  // ── Provider list ops (additive editConfigList pair, one op in flight) ────
  // Add / two-step Remove ride their OWN id sequence (listReqId), separate
  // from the snapshot and write counters; the reply envelope mirrors
  // setConfigKeyResult (ok / error / needsRestart, NO value echo). Success
  // RE-READS the snapshot (the file is the truth); refusals render verbatim.

  const provCard = (keyName: string): HTMLElement =>
    els(".settings-provider-card").find((c) => c.getAttribute("data-key") === keyName)!;
  const listFrames = (): Array<{ requestId: number; keyPath: string; op: string; name?: string; index?: number }> =>
    sent("editConfigList");
  const addBtn = (): HTMLElement => els(".settings-provider-add-btn")[0]!;
  const addField = (): HTMLElement & { value: string } => el(".settings-provider-add-input") as unknown as HTMLElement & { value: string };
  const addCommitBtn = (): HTMLElement =>
    els(".settings-provider-add-go")[0]!;
  /** Settle the LAST list frame with a reply (the server echoes the id). */
  const settleList = async (result: Record<string, unknown>): Promise<void> => {
    const frame = listFrames().pop()!;
    ws.fireMessage({ type: "editConfigListResult", requestId: frame.requestId, ...result });
    await tick();
  };
  /** The editPayload shape plus a third provider (what the re-read after a
   *  successful append ships: the card list follows the file). */
  const payloadWithThird = (requestId: number): Record<string, unknown> => {
    const base = editPayload(requestId) as { sections: Array<{ name: string; rows: Record<string, unknown>[] }> };
    return {
      ...base,
      sections: base.sections.map((sec) =>
        sec.name === "providers"
          ? {
              ...sec,
              rows: [
                ...sec.rows,
                { key: "providers[2]", description: "Provider entry", file: { name: "p3" } },
                { key: "providers[2].url", description: "Provider base URL", file: "http://127.0.0.1:8200/v1", edit: { type: "string" } },
              ],
            }
          : sec,
      ),
    };
  };

  it("provider Add: opening is zero traffic; an empty name is refused LOCALLY; a commit sends exactly ONE declared frame; ok re-reads and the new card appears", async () => {
    await openSnapshot();
    clearSent();
    addBtn().click();
    await tick();
    expect(addField()).toBeTruthy();
    expect(listFrames()).toHaveLength(0);
    // Empty commit: the local refusal, no frame, honest text under the field.
    addCommitBtn().click();
    await tick();
    expect(listFrames()).toHaveLength(0);
    expect(el(".settings-provider-list-error")!.textContent).toContain("can't be empty");
    // A real commit: ONE editConfigList frame, the declared append shape
    // (keyPath "providers", the name, NO index, no value bytes of any kind).
    addField().value = "p3";
    addCommitBtn().click();
    await tick();
    const frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyPath).toBe("providers");
    expect(frames[0]!.op).toBe("append");
    expect(frames[0]!.name).toBe("p3");
    expect("index" in frames[0]!).toBe(false);
    expect(Object.keys(frames[0]!).sort()).toEqual(["keyPath", "name", "op", "requestId", "type"]);
    // ok -> the snapshot is RE-READ (fresh id), and the refreshed payload
    // brings the new card in; needsRestart followed the REPLY field.
    await settleList({ ok: true, needsRestart: true });
    const reRead = sent<{ requestId: number }>("configSnapshot").pop()!;
    ws.fireMessage(payloadWithThird(reRead.requestId));
    await tick();
    expect(els(".settings-provider-card").map((c) => c.getAttribute("data-key"))).toEqual([
      "providers[0]",
      "providers[1]",
      "providers[2]",
    ]);
    expect(provCard("providers[2]").getAttribute("data-name")).toBe("p3");
    expect(el(".settings-restart")).toBeTruthy();
    key(el("#settings-view"), "Escape");
    await tick();
  });

  // Audit finding 6 (2026-11-11): provider names are USER data. A `"` in the
  // name must not break the post-add focus pass -- the interpolated CSS
  // selector used to throw inside queueMicrotask, and the stranded focus
  // marker then re-threw on every later snapshot.
  it("provider Add with a quote in the name: the focus pass completes and the marker clears", async () => {
    await openSnapshot();
    clearSent();
    addBtn().click();
    await tick();
    addField().value = 'p"3';
    addCommitBtn().click();
    await tick();
    expect(listFrames().pop()!.name).toBe('p"3');
    await settleList({ ok: true });
    const reRead = sent<{ requestId: number }>("configSnapshot").pop()!;
    const base = editPayload(reRead.requestId) as unknown as { sections: Array<{ name: string; rows: Record<string, unknown>[] }> };
    ws.fireMessage({
      ...base,
      sections: base.sections.map((sec) =>
        sec.name === "providers"
          ? {
              ...sec,
              rows: [
                ...sec.rows,
                { key: "providers[2]", description: "Provider entry", file: { name: 'p"3' } },
                { key: "providers[2].url", description: "Provider base URL", file: "http://127.0.0.1:8200/v1", edit: { type: "string" } },
              ],
            }
          : sec,
      ),
    });
    await tick();
    // The quoted card rendered, got the focus (the attribute walk found it --
    // no selector was ever built from the name), and the marker was consumed.
    const card = els(".settings-provider-card").find((c) => c.getAttribute("data-key") === "providers[2]")!;
    expect(card.getAttribute("data-name")).toBe('p"3');
    expect(document.activeElement).toBe(card as unknown as Element);
    expect(card.getAttribute("data-focus")).toBeNull();
    // A LATER snapshot still applies cleanly (the stranded-marker re-throw
    // loop is gone): Refresh repaints the three cards.
    clearSent();
    const refreshBtn = settingsRefresh();
    refreshBtn.click();
    await tick();
    ws.fireMessage(editPayload(sent<{ requestId: number }>("configSnapshot").pop()!.requestId));
    await tick();
    expect(els(".settings-provider-card").map((c) => c.getAttribute("data-key"))).toEqual([
      "providers[0]",
      "providers[1]",
    ]);
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("provider Remove: the FIRST click is zero traffic; Confirm sends the remove; Escape cancels with zero traffic", async () => {
    await openSnapshot();
    clearSent();
    (provCard("providers[1]").querySelector(".settings-provider-remove") as unknown as HTMLElement).click();
    await tick();
    expect(listFrames()).toHaveLength(0); // nothing left the client on the first click
    expect(provCard("providers[1]").querySelector(".settings-provider-remove-yes")).toBeTruthy(); // armed
    // Escape dismisses the armed confirm -- pure client state, zero wire.
    key(el("#settings-view"), "Escape");
    await tick();
    expect(listFrames()).toHaveLength(0);
    expect(provCard("providers[1]").querySelector(".settings-provider-remove-yes")).toBeNull();
    // Arm again + Confirm: exactly ONE frame, keyed by the element path, the
    // index echo agreeing with the keyPath (the server demands it).
    (provCard("providers[1]").querySelector(".settings-provider-remove") as unknown as HTMLElement).click();
    await tick();
    (provCard("providers[1]").querySelector(".settings-provider-remove-yes") as unknown as HTMLElement).click();
    await tick();
    const frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyPath).toBe("providers[1]");
    expect(frames[0]!.op).toBe("remove");
    expect(frames[0]!.index).toBe(1);
    expect("name" in frames[0]!).toBe(false);
    // A refusal keeps the SERVER text verbatim (a referenced provider names
    // the referrer) and never claims the removal.
    ws.fireMessage({
      type: "editConfigListResult",
      requestId: frames[0]!.requestId,
      ok: false,
      error: '"p2" is still referenced by defaultProvider',
    });
    await tick();
    expect(el(".settings-provider-list-error")!.textContent).toBe('"p2" is still referenced by defaultProvider');
    expect(document.querySelector(".settings-restart")).toBeNull();
    expect(els(".settings-provider-card").length).toBe(2);
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("a second list op while one is in flight QUEUES (no parallel frame) and drains after the reply", async () => {
    await openSnapshot();
    clearSent();
    // Op 1: append p3 goes out immediately.
    addBtn().click();
    await tick();
    addField().value = "p3";
    addCommitBtn().click();
    await tick();
    expect(listFrames()).toHaveLength(1);
    // Mid-flight the affordances are busy-disabled. A real trusted click
    // cannot land on a disabled control (DOM spec click() returns early),
    // but a scripted dispatchEvent still fires -- it stands in for the
    // double-click window before the repaint applies disabled, and the
    // STATE queue is the belt that keeps the wire serial either way.
    const remove2 = provCard("providers[1]").querySelector(".settings-provider-remove") as unknown as HTMLElement;
    expect(addBtn().hasAttribute("disabled")).toBe(true);
    expect(remove2.hasAttribute("disabled")).toBe(true);
    remove2.dispatchEvent(new Event("click"));
    await tick();
    (provCard("providers[1]").querySelector(".settings-provider-remove-yes") as unknown as HTMLElement).dispatchEvent(new Event("click"));
    await tick();
    expect(listFrames()).toHaveLength(1); // the remove QUEUED; no parallel frame
    // The append reply settles: the queued remove drains (second frame), then
    // the success re-read follows; the remove's own ok re-reads again.
    await settleList({ ok: true, needsRestart: true });
    const afterAppend = listFrames();
    expect(afterAppend).toHaveLength(2);
    expect(afterAppend[1]!.op).toBe("remove");
    expect(sentTypes()).toEqual(["editConfigList", "editConfigList", "configSnapshot"]);
    await settleList({ ok: true, needsRestart: true });
    expect(sentTypes()).toEqual(["editConfigList", "editConfigList", "configSnapshot", "configSnapshot"]);
    key(el("#settings-view"), "Escape");
    await tick();
  });
});

// ── Generic array list ops (editConfigList for arrayChrome fields) ──────────
// The same additive pair every provider op rides now serves EVERY chrome'd
// array: x removes "<array>[i]" (index IN the keyPath, no separate field --
// duplicates address by occurrence), + appends {keyPath, op:"append", value}
// with the TYPED scalar (number for an integer stamp, real boolean, enum pick,
// string default). Local refusals (empty/whitespace, unparseable number) send
// ZERO frames; one op in flight (second QUEUES, stale replies drop); ok
// re-reads the snapshot, refusal renders the server text verbatim and does
// NOT. Provider frames stay byte-identical (no value key leaks onto them).

describe("array list ops (generic editConfigList, real app wiring)", () => {
  const listPayload = (requestId: number): Record<string, unknown> => ({
    type: "configSnapshotResult",
    requestId,
    ts: 1700000000000,
    configDir: "/cfg",
    files: [{ path: "/cfg/defaults.json", inUse: true, status: "ok" }],
    findings: [],
    sections: [
      {
        name: "workspace",
        rows: [
          // Two identical values FIRST: the x on the first row must address
          // deny[0] (occurrence, not value).
          { key: "workspace.deny", description: "Denied path globs", arrayChrome: true, file: ["dup", "dup", "dist"] },
          { key: "workspace.deny[0]", file: "dup", edit: { type: "string" } },
          { key: "workspace.deny[1]", file: "dup", edit: { type: "string" } },
          { key: "workspace.deny[2]", file: "dist", edit: { type: "string" } },
          { key: "workspace.ports", description: "Allowed ports", arrayChrome: true, file: [8080] },
          { key: "workspace.ports[0]", file: 8080, edit: { type: "integer", minimum: 1, maximum: 65535 } },
          { key: "workspace.modes", description: "Active modes", arrayChrome: true, file: ["fast"] },
          { key: "workspace.modes[0]", file: "fast", edit: { type: "string", enum: ["fast", "balanced", "thorough"] } },
          { key: "workspace.flags", description: "Feature booleans", arrayChrome: true, file: [true] },
          { key: "workspace.flags[0]", file: true, edit: { type: "boolean" } },
          { key: "workspace.tokens", description: "Rotate these tokens", arrayChrome: true, leafSecret: true, file: null, redacted: true },
          { key: "workspace.tokens[0]", leafSecret: true, file: null, redacted: true, edit: { type: "string", writeOnly: true } },
        ],
      },
      {
        name: "providers",
        rows: [
          { key: "providers", description: "Model providers", file: [{ name: "p1" }] },
          { key: "providers[0]", description: "Provider entry", file: { name: "p1", url: "http://a/v1" } },
          { key: "providers[0].url", description: "Provider base URL", file: "http://a/v1", edit: { type: "string" } },
        ],
      },
    ],
  });

  async function openLists(): Promise<void> {
    await attach();
    el("#settings-btn").click();
    await tick();
    ws.fireMessage(listPayload(sent<{ requestId: number }>("configSnapshot").pop()!.requestId));
    await tick();
  }
  const blockFor = (key: string): HTMLElement =>
    els(".settings-list-block").find((b) => b.getAttribute("data-key") === key)!;
  const rowOf = (key: string): HTMLElement =>
    els(".settings-row").find((r) => r.getAttribute("data-key") === key)!;
  const removeBtn = (row: HTMLElement): HTMLElement => row.querySelector(".settings-list-remove") as unknown as HTMLElement;
  const addBtnIn = (block: HTMLElement): HTMLElement | undefined =>
    (Array.from(block.querySelectorAll(".settings-list-add-btn")) as unknown as HTMLElement[])[0];
  const addGoIn = (block: HTMLElement): HTMLElement | undefined =>
    (Array.from(block.querySelectorAll(".settings-list-add-go")) as unknown as HTMLElement[])[0];
  const listFrames = (): Array<{ requestId: number; keyPath: string; op: string; name?: string; index?: number; value?: unknown }> =>
    sent("editConfigList");
  const settleList = async (result: Record<string, unknown>, frameIndex = -1): Promise<void> => {
    const frames = listFrames();
    const frame = frameIndex < 0 ? frames[frames.length + frameIndex]! : frames[frameIndex]!;
    ws.fireMessage({ type: "editConfigListResult", requestId: frame.requestId, ...result });
    await tick();
  };

  it("x sends EXACTLY the declared remove frame (no index field); ok re-reads, refusal does not", async () => {
    await openLists();
    clearSent();
    removeBtn(rowOf("workspace.deny[1]")).click();
    await tick();
    const frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyPath).toBe("workspace.deny[1]");
    expect(frames[0]!.op).toBe("remove");
    expect(Object.keys(frames[0]!).sort()).toEqual(["keyPath", "op", "requestId", "type"]); // no index, no value
    // A REFUSAL: verbatim under the owning block, and NO snapshot re-read.
    ws.fireMessage({ type: "editConfigListResult", requestId: frames[0]!.requestId, ok: false, error: '"workspace.deny[9]" no longer exists -- the array shifted' });
    await tick();
    expect(blockFor("workspace.deny").querySelector(".settings-list-error")!.textContent).toContain("the array shifted");
    expect(sent("configSnapshot")).toHaveLength(0);
    // A second x settles FREE (the refusal released the in-flight slot); its
    // OK reply re-reads with a FRESH id (rows refresh from the snapshot,
    // never from a local patch) and folds needsRestart from the REPLY field.
    removeBtn(rowOf("workspace.deny[2]")).click();
    await tick();
    expect(listFrames()).toHaveLength(2);
    ws.fireMessage({ type: "editConfigListResult", requestId: listFrames()[1]!.requestId, ok: true, needsRestart: true });
    await tick();
    expect(sentTypes()).toEqual(["editConfigList", "editConfigList", "configSnapshot"]);
    expect(el(".settings-restart")).toBeTruthy();
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("duplicate values: x on the FIRST dup addresses deny[0]", async () => {
    await openLists();
    clearSent();
    // Both rows DISPLAY "dup" -- the rows are distinct by index, and the
    // clicked row's own keyPath is what rides.
    expect((rowOf("workspace.deny[0]").querySelector(".settings-edit-input") as unknown as HTMLElement).getAttribute("value")).toBe("dup");
    expect((rowOf("workspace.deny[1]").querySelector(".settings-edit-input") as unknown as HTMLElement).getAttribute("value")).toBe("dup");
    removeBtn(rowOf("workspace.deny[0]")).click();
    await tick();
    const frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyPath).toBe("workspace.deny[0]");
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("+ commits TYPED values: number, real boolean, enum pick, string; wrong kind refused locally", async () => {
    await openLists();
    clearSent();
    // String stamp -> string (and the input receives focus, the provider-add
    // precedent: the field is ready to type in).
    addBtnIn(blockFor("workspace.deny"))!.click();
    await tick();
    const input = blockFor("workspace.deny").querySelector(".settings-list-add-input") as unknown as HTMLElement & { value: string };
    expect(document.activeElement).toBe(input as Element);
    input.value = "node_modules";
    addGoIn(blockFor("workspace.deny"))!.click();
    await tick();
    let frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyPath).toBe("workspace.deny");
    expect(frames[0]!.op).toBe("append");
    expect(frames[0]!.value).toBe("node_modules");
    expect(Object.keys(frames[0]!).sort()).toEqual(["keyPath", "op", "requestId", "type", "value"]);
    await settleList({ ok: true }); // settle + re-read so the slot frees

    // Integer stamp -> a real NUMBER on the wire; an unparseable input is
    // refused LOCALLY (never sent as a string) with the honest hint.
    clearSent();
    addBtnIn(blockFor("workspace.ports"))!.click();
    await tick();
    const num = blockFor("workspace.ports").querySelector(".settings-list-add-input") as unknown as HTMLElement & { value: string };
    expect(num.getAttribute("type")).toBe("number");
    num.value = "banana";
    addGoIn(blockFor("workspace.ports"))!.click();
    await tick();
    expect(listFrames()).toHaveLength(0); // the bad value never reached the wire
    expect(blockFor("workspace.ports").querySelector(".settings-list-error")!.textContent).toContain('"banana" is not a number');
    // The field stays open for the fix (local refusal is pure state).
    const num2 = blockFor("workspace.ports").querySelector(".settings-list-add-input") as unknown as HTMLElement & { value: string };
    expect(num2).toBeTruthy();
    num2.value = "42";
    addGoIn(blockFor("workspace.ports"))!.click();
    await tick();
    frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.value).toBe(42);
    expect(typeof frames[0]!.value).toBe("number");
    await settleList({ ok: true });

    // Boolean stamp -> a real JSON boolean.
    clearSent();
    addBtnIn(blockFor("workspace.flags"))!.click();
    await tick();
    const bsel = blockFor("workspace.flags").querySelector("select.settings-list-add-input") as unknown as HTMLElement & { value: string };
    bsel.value = "false";
    addGoIn(blockFor("workspace.flags"))!.click();
    await tick();
    frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.value).toBe(false);
    expect(typeof frames[0]!.value).toBe("boolean");
    await settleList({ ok: true });

    // Enum stamp -> the pick, verbatim, as a string.
    clearSent();
    addBtnIn(blockFor("workspace.modes"))!.click();
    await tick();
    const esel = blockFor("workspace.modes").querySelector("select.settings-list-add-input") as unknown as HTMLElement & { value: string };
    esel.value = "balanced";
    addGoIn(blockFor("workspace.modes"))!.click();
    await tick();
    frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.value).toBe("balanced");
    await settleList({ ok: true });

    // Empty and whitespace commits: ZERO frames, honest local text.
    clearSent();
    addBtnIn(blockFor("workspace.deny"))!.click();
    await tick();
    const denyInput = blockFor("workspace.deny").querySelector(".settings-list-add-input") as unknown as HTMLElement & { value: string };
    denyInput.value = "   ";
    addGoIn(blockFor("workspace.deny"))!.click();
    await tick();
    expect(listFrames()).toHaveLength(0);
    expect(blockFor("workspace.deny").querySelector(".settings-list-error")!.textContent).toContain("required");
    // Escape closes the open field with ZERO wire traffic.
    key(el("#settings-view"), "Escape");
    await tick();
    expect(listFrames()).toHaveLength(0);
    expect(blockFor("workspace.deny").querySelector(".settings-list-add-input")).toBeNull();
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("one op in flight: a second x QUEUES (no parallel frame); a STALE reply drops; the queue drains after the real reply", async () => {
    await openLists();
    clearSent();
    removeBtn(rowOf("workspace.deny[0]")).click();
    await tick();
    expect(listFrames()).toHaveLength(1);
    // Second x mid-flight: a trusted click cannot reach a disabled control;
    // scripted dispatch stands in for the pre-repaint race window (see the
    // provider queue test) -- the STATE queue must keep the wire serial.
    removeBtn(rowOf("workspace.deny[1]")).dispatchEvent(new Event("click"));
    await tick();
    expect(listFrames()).toHaveLength(1); // queued, not parallel
    // A reply with the WRONG id drops (stale): the queue NEVER drains on it
    // (the in-flight slot stays held by f1). An ok:true stale reply may still
    // fire the harmless snapshot re-read the app issues on any ok -- rows
    // refresh from truth either way; what must NOT happen is a parallel frame.
    const f1 = listFrames()[0]!;
    ws.fireMessage({ type: "editConfigListResult", requestId: f1.requestId + 999, ok: true });
    await tick();
    expect(listFrames()).toHaveLength(1); // queued, not drained by a stale id
    // The real reply settles f1 and the queued remove drains (fresh id).
    await settleList({ ok: true, needsRestart: true }, 0);
    const frames = listFrames();
    expect(frames).toHaveLength(2);
    expect(frames[1]!.keyPath).toBe("workspace.deny[1]");
    // (The stale ok's redundant re-read sits between -- a refresh, not a drain.)
    expect(sentTypes()).toEqual(["editConfigList", "configSnapshot", "editConfigList", "configSnapshot"]);
    await settleList({ ok: true });
    expect(sentTypes()).toEqual(["editConfigList", "configSnapshot", "editConfigList", "configSnapshot", "configSnapshot"]);
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("writeOnly element: REPLACE box (zero bytes) and x removes by keyPath; provider frames stay byte-identical", async () => {
    await openLists();
    clearSent();
    const tokenRow = rowOf("workspace.tokens[0]");
    const box = tokenRow.querySelector(".settings-edit-secret") as unknown as HTMLElement;
    expect(box.getAttribute("type")).toBe("password");
    expect(box.getAttribute("value")).toBe("");
    removeBtn(tokenRow).click();
    await tick();
    let frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyPath).toBe("workspace.tokens[0]");
    expect(frames[0]!.op).toBe("remove");
    expect(Object.keys(frames[0]!).sort()).toEqual(["keyPath", "op", "requestId", "type"]);
    await settleList({ ok: true }); // free the slot before the provider op
    clearSent();
    // Provider ops ride the SAME machinery with their historic byte shape:
    // append = name, NO value key; two-step remove = index echo, NO value key.
    (els(".settings-provider-add-btn")[0] as unknown as HTMLElement).click();
    await tick();
    const field = el(".settings-provider-add-input") as unknown as HTMLElement & { value: string };
    field.value = "p2";
    (els(".settings-provider-add-go")[0] as unknown as HTMLElement).click();
    await tick();
    frames = listFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]!.keyPath).toBe("providers");
    expect(frames[0]!.name).toBe("p2");
    expect(Object.keys(frames[0]!).sort()).toEqual(["keyPath", "name", "op", "requestId", "type"]);
    expect("value" in frames[0]!).toBe(false);
    key(el("#settings-view"), "Escape");
    await tick();
  });

  it("add cancel hands focus back to the + it replaced (generic block and provider affordance); zero wire", async () => {
    await openLists();
    clearSent();
    // Generic list: the Cancel button destroys the focused field; focus must
    // land on the + the re-render just created, not drop to body
    // (cancelSettingsEditRow doctrine; the judge's finding, 2026-11-11).
    addBtnIn(blockFor("workspace.deny"))!.click();
    await tick();
    const input = blockFor("workspace.deny").querySelector(".settings-list-add-input") as unknown as HTMLElement;
    expect(document.activeElement).toBe(input as Element); // open focuses the field
    const addRow = blockFor("workspace.deny").querySelector(".settings-list-add-row")!;
    const cancelBtn = (Array.from(addRow.querySelectorAll(".settings-btn")) as unknown as HTMLElement[]).find(
      (b) => b.textContent === "Cancel",
    )!;
    cancelBtn.click();
    await tick();
    expect(blockFor("workspace.deny").querySelector(".settings-list-add-input")).toBeNull();
    expect(document.activeElement).toBe(addBtnIn(blockFor("workspace.deny")) as Element);
    expect(listFrames()).toHaveLength(0); // cancel is pure client state
    // The Escape ladder (dialog-level, staged above close) hands off the same way.
    addBtnIn(blockFor("workspace.modes"))!.click();
    await tick();
    key(el("#settings-view"), "Escape");
    await tick();
    expect(blockFor("workspace.modes").querySelector(".settings-list-add-input")).toBeNull();
    expect(document.activeElement).toBe(addBtnIn(blockFor("workspace.modes")) as Element);
    // Provider add (same seam, different affordance): Cancel returns to
    // "+ Add provider".
    (els(".settings-provider-add-btn")[0] as unknown as HTMLElement).click();
    await tick();
    const pRow = els(".settings-provider-add-row")[0]!;
    const pCancel = (Array.from(pRow.querySelectorAll(".settings-btn")) as unknown as HTMLElement[]).find(
      (b) => b.textContent === "Cancel",
    )!;
    pCancel.click();
    await tick();
    expect(el(".settings-provider-add-input")).toBeNull();
    expect(document.activeElement).toBe(els(".settings-provider-add-btn")[0] as Element);
    expect(listFrames()).toHaveLength(0);
    key(el("#settings-view"), "Escape");
    await tick();
  });
});

// ── Workbench file tree + viewer (real app wiring) ──────────────────────────
// The zero-tabs button docks the tree tab and requests the roots; replies
// correlate by requestId (stale drop); a file click opens a "file" tab
// (id = path, reopened ONCE) and reads it; server rejections render verbatim;
// the row context menu is Copy path (the quote-to-composer item is deferred:
// no composer-insert seam). Leaves the app exactly as found: no tabs, pane
// collapsed.

describe("workbench file tree (real app wiring)", () => {
  const openPane = async (): Promise<void> => {
    if (!document.querySelector("#workbench-panel")) {
      el("#workbench-toggle").click();
      await tick();
    }
  };
  const closeTabs = async (): Promise<void> => {
    for (const t of [...workbenchStore.get().tabs]) workbenchStore.close(t.id);
    await tick();
  };
  const tabLabels = (): string[] => els("#workbench-tabs [role=tab]").map((b) => b.textContent ?? "");

  afterEach(async () => {
    await closeTabs();
    if (document.querySelector("#workbench-panel")) {
      el("#workbench-toggle").click();
      await tick();
    }
  });

  it("entry button -> roots request -> expand -> file click -> tab + read; reopening the path reuses the tab", async () => {
    await attach();
    await openPane();
    await closeTabs();
    clearSent();
    el("#workbench-open-files").click();
    await tick();
    expect(tabLabels()).toEqual(["Files"]);
    expect(el(".file-tree")).toBeTruthy();
    expect(el(".file-tree").textContent).toContain("Listing workspace");
    const rootsReq = sent<{ requestId: number; path?: unknown }>("listDir").pop()!;
    expect("path" in rootsReq).toBe(false);

    ws.fireMessage({
      type: "listDirResult",
      requestId: rootsReq.requestId,
      roots: [{ name: "rootA", path: "/rootA" }],
    });
    await tick();
    expect(el(".ft-root .ft-name").textContent).toBe("rootA");

    clearSent();
    el(".ft-root .ft-row-btn").click();
    await tick();
    const expReq = sent<{ requestId: number; path: string }>("listDir").pop()!;
    expect(expReq.path).toBe("/rootA");
    // A stale reply for the ROOTS id cannot overwrite the dir slot.
    ws.fireMessage({ type: "listDirResult", requestId: rootsReq.requestId - 1, entries: [] });
    await tick();
    expect(el(".ft-loading")).toBeTruthy(); // still listing

    ws.fireMessage({
      type: "listDirResult",
      requestId: expReq.requestId,
      path: "/rootA",
      entries: [
        { name: "src", path: "/rootA/src", isDir: true },
        { name: "run.sh", path: "/rootA/run.sh", isDir: false, size: 9 },
      ],
    });
    await tick();
    expect(els(".ft-file").length).toBe(1);

    clearSent();
    el(".ft-file .ft-row-btn").click();
    await tick();
    expect(tabLabels()).toEqual(["Files", "run.sh"]);
    const readReq = sent<{ requestId: number; path: string; offset: number }>("readFile").pop()!;
    expect(readReq.path).toBe("/rootA/run.sh");
    expect(readReq.offset).toBe(0);
    ws.fireMessage({
      type: "readFileResult",
      requestId: readReq.requestId,
      path: "/rootA/run.sh",
      offset: 0,
      content: "echo hi\nls\n",
    });
    await tick();
    // editor-core: a complete within-cap read now opens EDITABLE. The
    // line-addressing seam SURVIVES the swap into the editor's own layer
    // (data-line stays 1-based there), and the same tokenizer paints it.
    expect(els(".editor-line").map((r) => r.getAttribute("data-line"))).toEqual(["1", "2"]);
    expect(el(".editor-input")).toBeTruthy(); // the hidden capture owns focus/IME
    expect(el(".tk-command")!.textContent).toBe("echo");

    // Back to the tree, click the same file again: ONE tab (id = path), no
    // second read (openFileView reuses the cached entry).
    clearSent();
    els("#workbench-tabs [role=tab]")[0]!.click();
    await tick();
    el('.ft-file .ft-row-btn').click();
    await tick();
    expect(tabLabels()).toEqual(["Files", "run.sh"]);
    expect(sent("readFile")).toHaveLength(0);
  });

  it("server rejections render VERBATIM (tree row + viewer) and the row menu copies the path", async () => {
    await attach();
    await openPane();
    await closeTabs();
    clearSent();
    el("#workbench-open-files").click();
    await tick();
    // The tree atom may carry expanded dirs from an earlier test (open then
    // re-requests the roots AND them): address requests by shape, not count.
    const reqs = sent<{ requestId: number; path?: string }>("listDir");
    const rootsReq = reqs.find((r) => r.path === undefined)!;
    ws.fireMessage({ type: "listDirResult", requestId: rootsReq.requestId, roots: [{ name: "rootA", path: "/rootA" }] });
    await tick();
    expect(el(".ft-root .ft-name").textContent).toBe("rootA");
    let expReq = reqs.find((r) => r.path === "/rootA");
    if (!expReq) {
      // Fresh state: expand by click, which mints the dir request.
      clearSent();
      el(".ft-root .ft-row-btn").click();
      await tick();
      expReq = sent<{ requestId: number; path: string }>("listDir").pop()!;
    }
    ws.fireMessage({
      type: "listDirResult",
      requestId: expReq.requestId,
      error: "Symlink escape rejected: link-etc",
    });
    await tick();
    expect(el(".ft-error").textContent).toBe("Symlink escape rejected: link-etc");

    // Right-click the root row: the app's root-menu grammar (ContextMenu
    // idiom). Roots create and copy; they never rename/delete/download.
    const rowBtn = el(".ft-root .ft-row-btn");
    rowBtn.dispatchEvent({ type: "contextmenu", currentTarget: rowBtn, clientX: 50, clientY: 50 } as unknown as Event);
    await tick();
    const items = els(".context-menu-item").map((i) => i.textContent);
    expect(items).toEqual(["New file", "New folder", "Copy path"]);
    const copied: string[] = [];
    document.execCommand = (): boolean => {
      const ta = document.querySelector("textarea[readonly]") as unknown as { value: string } | null;
      if (ta) copied.push(ta.value);
      return true;
    };
    els(".context-menu-item")[2]!.click();
    await tick();
    expect(copied).toEqual(["/rootA"]);
    expect(el("#copy-toast").textContent).toBe("Path copied");
    expect(document.querySelector(".context-menu")).toBeNull();
  });

  it("a viewer error rides verbatim; pager re-requests with the loaded offset", async () => {
    await attach();
    await openPane();
    await closeTabs();
    clearSent();
    workbenchStore.open({ id: "/rootA/big.txt", kind: "file", label: "big.txt", dirty: false });
    await tick();
    // The tab landed with no view (a producer bypass); clicking the tab is
    // the recovery path -- activate ensures the first page is requested.
    els("#workbench-tabs [role=tab]").at(-1)!.click();
    await tick();
    const req = sent<{ requestId: number; path: string; offset: number }>("readFile").pop()!;
    expect(req.path).toBe("/rootA/big.txt");
    ws.fireMessage({
      type: "readFileResult",
      requestId: req.requestId,
      path: "/rootA/big.txt",
      content: "l1\nl2\n",
      truncated: true,
    });
    await tick();
    expect(els(".file-line").length).toBe(2);
    // editor-core: a truncated within-cap read is AUTO-PAGED to full by the
    // editability seam -- and the frame it mints carries the SAME loaded
    // offset the manual pager sent (the pager's offset grammar is pinned
    // here through its automatic caller; the manual "Load more" button
    // stays the viewer's own affordance, pinned in file-view.test.tsx).
    const more = sent<{ requestId: number; offset: number }>("readFile").pop()!;
    expect(more.offset).toBe(2);
    ws.fireMessage({
      type: "readFileResult",
      requestId: more.requestId,
      path: "/rootA/big.txt",
      error: "binary file (9 bytes) -- not displayed",
    });
    await tick();
    // Loaded lines stay; the honest pager text rides; pager is gone.
    expect(els(".file-line").length).toBe(2);
    expect(el(".file-view-error").textContent).toBe("binary file (9 bytes) -- not displayed");
    expect(document.querySelector(".file-view-more")).toBeNull();
  });

  it("the foot bar names the syntax type: the override repaints, Auto gives the guess back", async () => {
    await attach();
    await openPane();
    await closeTabs();
    clearSent();
    // A path NO earlier test has read: an already-viewed path must NOT
    // re-request on activation (the reopen-must-not-wipe doctrine).
    workbenchStore.open({ id: "/rootA/paint.sh", kind: "file", label: "paint.sh", dirty: false });
    await tick();
    // Activation is the read's owner (the store-open is a producer bypass).
    els("#workbench-tabs [role=tab]").at(-1)!.click();
    await tick();
    const req = sent<{ requestId: number; path: string }>("readFile").pop()!;
    ws.fireMessage({
      type: "readFileResult",
      requestId: req.requestId,
      path: "/rootA/paint.sh",
      content: "echo one\ncd /tmp\n",
      truncated: true,
    });
    await tick();
    // editor-core: the truncated page keeps the VIEWER mounted (editability
    // is undecided until the read is full), and the seam auto-pages to
    // finish -- answer its frame with the honest over-cap-line refusal so
    // this path provably stays read-only, foot bar and paint override
    // included. (Complete within-cap files open editable; the override
    // rides the editor's paint too -- pinned in the editor-core section.)
    const page2 = sent<{ requestId: number; offset: number }>("readFile").pop()!;
    expect(page2.offset).toBe(2);
    ws.fireMessage({
      type: "readFileResult",
      requestId: page2.requestId,
      path: "/rootA/paint.sh",
      error: "line 3 is longer than the 262144-char read cap",
    });
    await tick();
    // The auto-guess paints (shell tokens) and the AUTO entry is the chosen
    // option -- the selection IS the absence of an override.
    expect(el(".file-line .tk-command").textContent).toBe("echo");
    const sel = el(".file-view-lang");
    const selectedValue = () =>
      els(".file-view-lang option").find((o) => o.hasAttribute("selected"))?.getAttribute("value");
    expect(selectedValue()).toBe("");
    expect(sel.textContent).toContain("Auto (Shell)");
    // Forced plain: the runs vanish and the override wears the accent.
    (sel as unknown as { value: string }).value = "plain";
    sel.dispatchEvent({ type: "change", currentTarget: sel } as unknown as Event);
    await tick();
    expect(document.querySelector(".file-line .tk-command")).toBeNull();
    expect(selectedValue()).toBe("plain");
    expect(el(".file-view-lang").classList.contains("is-overridden")).toBe(true);
    // A different language: chosen, painted-with, still flagged.
    const sel2 = el(".file-view-lang");
    (sel2 as unknown as { value: string }).value = "go";
    sel2.dispatchEvent({ type: "change", currentTarget: sel2 } as unknown as Event);
    await tick();
    expect(selectedValue()).toBe("go");
    expect(el(".file-view-lang").classList.contains("is-overridden")).toBe(true);
    // Auto back: the tokens return and the flag drops.
    const sel3 = el(".file-view-lang");
    (sel3 as unknown as { value: string }).value = "";
    sel3.dispatchEvent({ type: "change", currentTarget: sel3 } as unknown as Event);
    await tick();
    expect(el(".file-line .tk-command").textContent).toBe("echo");
    expect(el(".file-view-lang").classList.contains("is-overridden")).toBe(false);
    expect(selectedValue()).toBe("");
  });
});

// ── Workbench file ops (row menu write family, real app wiring) ─────────────
// The menu grammar per row kind, confirm gating with honest recursive copy,
// the create/rename/delete frames on the socket, the SUBTREE-ONLY refresh the
// success reply lands (one listDir for the touched dir, never a whole-tree
// re-open), the tab bookkeeping (rename follows the file, delete closes the
// tabs it kills), the validation refusals, and the Download anchor's route.

describe("workbench file-tree row menu (write ops)", () => {
  const DIR_FIXTURE = [
    { name: "src", path: "/rootA/src", isDir: true },
    { name: "run.sh", path: "/rootA/run.sh", isDir: false, size: 9 },
  ];
  const closeTabs = async (): Promise<void> => {
    for (const t of [...workbenchStore.get().tabs]) workbenchStore.close(t.id);
    await tick();
  };
  const tabIds = (): string[] => workbenchStore.get().tabs.map((t) => t.id);

  /** Open the tree with roots=[/rootA] and /rootA listing DIR_FIXTURE,
   *  answering every minted request by shape (leftover expansions from
   *  earlier sections re-request too -- the reply loop covers them). */
  async function openTreeFixture(): Promise<void> {
    await attach();
    if (!document.querySelector("#workbench-panel")) {
      el("#workbench-toggle").click();
      await tick();
    }
    await closeTabs();
    clearSent();
    el("#workbench-open-files").click();
    await tick();
    for (const r of sent<{ requestId: number; path?: string }>("listDir")) {
      ws.fireMessage(
        r.path === undefined
          ? { type: "listDirResult", requestId: r.requestId, roots: [{ name: "rootA", path: "/rootA" }] }
          : { type: "listDirResult", requestId: r.requestId, path: r.path, entries: DIR_FIXTURE },
      );
    }
    await tick();
  }

  async function rowMenu(path: string): Promise<void> {
    const btn = els(".ft-row").find((r) => r.getAttribute("data-path") === path)?.querySelector(".ft-row-btn") as HTMLElement;
    btn!.dispatchEvent({ type: "contextmenu", currentTarget: btn, clientX: 20, clientY: 20 } as unknown as Event);
    await tick();
  }

  async function pickMenuItem(label: string): Promise<void> {
    els(".context-menu-item").find((b) => b.textContent === label)!.click();
    await tick();
  }

  afterEach(async () => {
    await closeTabs();
    if (document.querySelector("#workbench-panel")) {
      el("#workbench-toggle").click();
      await tick();
    }
    confirmAnswer = true;
    promptAnswer = "renamed";
  });

  it("menu grammar: root rows create+copy, dir rows create+rename+delete+copy, file rows rename+download+delete+copy", async () => {
    await openTreeFixture();
    await rowMenu("/rootA");
    expect(els(".context-menu-item").map((i) => i.textContent)).toEqual(["New file", "New folder", "Copy path"]);
    await rowMenu("/rootA/src");
    expect(els(".context-menu-item").map((i) => i.textContent)).toEqual(["New file", "New folder", "Rename", "Copy path", "Delete"]);
    await rowMenu("/rootA/run.sh");
    expect(els(".context-menu-item").map((i) => i.textContent)).toEqual(["Rename", "Download", "Copy path", "Delete"]);
  });

  it("Delete is confirm-gated; the refusal lands the parent refresh and closes the killed tabs", async () => {
    await openTreeFixture();
    workbenchStore.open({ id: "/rootA/run.sh", kind: "file", label: "run.sh", dirty: false });
    workbenchStore.activate("files"); // the tree must be on screen to be right-clicked
    await tick();
    clearSent();

    // Refused confirm: NOTHING rides the wire.
    confirmSeen = [];
    confirmAnswer = false;
    await rowMenu("/rootA/run.sh");
    await pickMenuItem("Delete");
    expect(confirmSeen.join()).toContain("Delete run.sh");
    expect(confirmSeen.join()).toContain("cannot be undone");
    expect(sent("deletePath")).toHaveLength(0);

    // Confirmed: the frame goes, the reply lands the refresh + tab close.
    confirmAnswer = true;
    await rowMenu("/rootA/run.sh");
    await pickMenuItem("Delete");
    const frame = sent<{ requestId: number; path: string }>("deletePath").pop()!;
    expect(frame.path).toBe("/rootA/run.sh");
    clearSent();
    ws.fireMessage({ type: "fileOpResult", requestId: frame.requestId, path: "/rootA/run.sh" });
    await tick();
    expect(tabIds()).not.toContain("/rootA/run.sh"); // the killed tab closed
    const refreshes = sent<{ requestId: number; path?: string }>("listDir");
    expect(refreshes).toHaveLength(1); // SUBTREE-ONLY: just the parent
    expect(refreshes[0]!.path).toBe("/rootA");
  });

  it("a DIRECTORY delete says the recursive truth in the confirm copy", async () => {
    await openTreeFixture();
    confirmSeen = [];
    confirmAnswer = true;
    await rowMenu("/rootA/src");
    await pickMenuItem("Delete");
    expect(confirmSeen.join()).toContain("EVERYTHING inside it");
    expect(confirmSeen.join()).toContain("recursively");
    expect(sent("deletePath")).toHaveLength(1);
  });

  it("New file: name -> createFile; the reply opens the tab, expands + re-lists the parent", async () => {
    await openTreeFixture();
    clearSent();
    promptAnswer = "notes.txt";
    await rowMenu("/rootA");
    await pickMenuItem("New file");
    const frame = sent<{ requestId: number; path: string }>("createFile").pop()!;
    expect(frame.path).toBe("/rootA/notes.txt");
    clearSent();
    ws.fireMessage({ type: "fileOpResult", requestId: frame.requestId, path: "/rootA/notes.txt" });
    await tick();
    expect(tabIds()).toContain("/rootA/notes.txt"); // opens in the workbench
    const refreshes = sent<{ requestId: number; path?: string }>("listDir");
    expect(refreshes).toHaveLength(1);
    expect(refreshes[0]!.path).toBe("/rootA"); // parent re-list (subtree-only)
  });

  it("name validation (empty / separator) refuses locally with an honest toast and ZERO wire", async () => {
    await openTreeFixture();
    clearSent();
    promptAnswer = "   ";
    await rowMenu("/rootA");
    await pickMenuItem("New file");
    expect(sent("createFile")).toHaveLength(0);
    expect(el("#copy-toast").textContent).toContain("empty");
    promptAnswer = "sneaky/../path";
    await rowMenu("/rootA");
    await pickMenuItem("New file");
    expect(sent("createFile")).toHaveLength(0);
    expect(el("#copy-toast").textContent).toContain("separator");
  });

  it("a server refusal (already exists) rides the toast VERBATIM; no refresh, no tab", async () => {
    await openTreeFixture();
    clearSent();
    promptAnswer = "brand-new.txt";
    await rowMenu("/rootA/src"); // /rootA/src is COLLAPSED here; its cache may be absent, the server is the authority
    await pickMenuItem("New file");
    const frame = sent<{ requestId: number; path: string }>("createFile").pop()!;
    clearSent();
    ws.fireMessage({ type: "fileOpResult", requestId: frame.requestId, error: "already exists: brand-new.txt" });
    await tick();
    expect(el("#copy-toast").textContent).toBe("already exists: brand-new.txt");
    expect(sent("listDir")).toHaveLength(0); // a failed op re-lists nothing
    expect(tabIds()).not.toContain("/rootA/src/brand-new.txt");
  });

  it("Rename retargets the open tab IN PLACE (identity follows the file) and re-lists the parent", async () => {
    await openTreeFixture();
    workbenchStore.open({ id: "/rootA/run.sh", kind: "file", label: "run.sh", dirty: false });
    workbenchStore.activate("files"); // the tree must be on screen to be right-clicked
    await tick();
    clearSent();
    promptAnswer = "start.sh";
    await rowMenu("/rootA/run.sh");
    await pickMenuItem("Rename");
    const frame = sent<{ requestId: number; oldPath: string; newPath: string }>("renamePath").pop()!;
    expect(frame.oldPath).toBe("/rootA/run.sh");
    expect(frame.newPath).toBe("/rootA/start.sh");
    clearSent();
    ws.fireMessage({ type: "fileOpResult", requestId: frame.requestId, path: "/rootA/start.sh" });
    await tick();
    expect(tabIds()).toEqual(["files", "/rootA/start.sh"]); // MOVED in place: same slot, new identity
    const tab = workbenchStore.get().tabs[1]!;
    expect(tab.label).toBe("start.sh");
    const refreshes = sent<{ requestId: number; path?: string }>("listDir");
    expect(refreshes).toHaveLength(1); // one parent, subtree-only
    expect(refreshes[0]!.path).toBe("/rootA");
  });

  it("Download points a hidden anchor at /download with the token (the export idiom)", async () => {
    await openTreeFixture();
    const created: HTMLElement[] = [];
    const docAny = document as unknown as { createElement: (t: string) => HTMLElement };
    const prevCreate = docAny.createElement;
    docAny.createElement = (tag: string) => {
      const made = prevCreate.call(document, tag);
      if (tag === "a") created.push(made);
      return made;
    };
    try {
      await rowMenu("/rootA/run.sh");
      await pickMenuItem("Download");
    } finally {
      docAny.createElement = prevCreate;
    }
    expect(created).toHaveLength(1);
    const anchor = created[0] as unknown as { href: string; download: string };
    expect(anchor.href.startsWith("/download/")).toBe(true);
    expect(decodeURIComponent(anchor.href.split("?")[0]!)).toContain("/rootA/run.sh");
    expect(anchor.href).toContain("token=");
    expect(anchor.download).toBe("run.sh");
    expect(sent("deletePath")).toHaveLength(0); // a download touches no other wire
  });
});

// ── Workbench tab persistence (real app wiring) ─────────────────────────────
// One sessionStorage key (hotdog.workbenchTabs) records the real tabs and
// the active tab on every store change (app.tsx's persist subscription; the
// codec/garbage units live in workbench.test.tsx). The stub installs HERE,
// not before the app import: the storage guard resolves per call, so the
// first-run workbench suites above stay first-run (boot's seed reads missing
// storage = no key = zero tabs). init() runs once per file, so the reload
// test calls the exact line init() calls (seedWorkbenchStoreFromStorage),
// then fires the attach where the restored reads dispatch (onSessionCreated
// -- chat.ts drops pre-OPEN frames, so attach is THE dispatch point).

describe("workbench tab persistence (real app wiring)", () => {
  const session = new Map<string, string>();
  beforeAll(() => {
    (window as unknown as Record<string, unknown>).sessionStorage = {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, String(v)),
      removeItem: (k: string) => void session.delete(k),
    };
  });
  afterAll(() => {
    delete (window as unknown as Record<string, unknown>).sessionStorage;
  });
  const openPane = async (): Promise<void> => {
    if (!document.querySelector("#workbench-panel")) {
      el("#workbench-toggle").click();
      await tick();
    }
  };
  afterEach(async () => {
    for (const t of [...workbenchStore.get().tabs]) workbenchStore.close(t.id);
    if (document.querySelector("#workbench-panel")) {
      el("#workbench-toggle").click();
      await tick();
    }
    session.clear();
    await tick();
  });
  const storedTabs = (): { tabs: { id: string; kind: string; label: string }[]; activeId: string | null } =>
    JSON.parse(session.get(WORKBENCH_TABS_KEY)!) as ReturnType<typeof storedTabs>;

  it("open / tree-click / activate / close persist the set; empty persists as empty; never localStorage", async () => {
    await attach();
    await openPane();
    clearSent();
    el("#workbench-open-files").click();
    await tick();
    expect(storedTabs()).toEqual({ tabs: [{ id: "files", kind: "files", label: "Files" }], activeId: "files" });
    // Land a file listing through the real tree flow (shape-addressed: the
    // shared atom may carry an expansion from the suite above).
    const reqs = sent<{ requestId: number; path?: string }>("listDir");
    ws.fireMessage({
      type: "listDirResult",
      requestId: reqs.find((r) => r.path === undefined)!.requestId,
      roots: [{ name: "rootA", path: "/rootA" }],
    });
    await tick();
    let expReq = reqs.find((r) => r.path === "/rootA");
    if (!expReq) {
      el(".ft-root .ft-row-btn").click();
      await tick();
      expReq = sent<{ requestId: number; path: string }>("listDir").pop()!;
    }
    ws.fireMessage({
      type: "listDirResult",
      requestId: expReq.requestId,
      path: "/rootA",
      entries: [
        { name: "persist-a.txt", path: "/rootA/persist-a.txt", isDir: false, size: 2 },
        { name: "persist-b.txt", path: "/rootA/persist-b.txt", isDir: false, size: 2 },
      ],
    });
    await tick();
    els(".ft-file .ft-row-btn")[0]!.click();
    await tick();
    // Back to the tree before the next click: opening a file tab ACTIVATES
    // it, and the tree body unmounts with the tab switch.
    els("#workbench-tabs [role=tab]")[0]!.click();
    await tick();
    els(".ft-file .ft-row-btn")[1]!.click();
    await tick();
    // Both file tabs recorded IN OPEN ORDER (ids = paths, labels = basenames),
    // the last-opened active.
    expect(storedTabs()).toEqual({
      tabs: [
        { id: "files", kind: "files", label: "Files" },
        { id: "/rootA/persist-a.txt", kind: "file", label: "persist-a.txt" },
        { id: "/rootA/persist-b.txt", kind: "file", label: "persist-b.txt" },
      ],
      activeId: "/rootA/persist-b.txt",
    });
    // Activation persists too.
    els("#workbench-tabs [role=tab]")[0]!.click();
    await tick();
    expect(storedTabs().activeId).toBe("files");
    // Closing the tree tab records the survivor set...
    els(".workbench-tab-close")[0]!.click();
    await tick();
    expect(storedTabs().tabs.map((t) => t.id)).toEqual(["/rootA/persist-a.txt", "/rootA/persist-b.txt"]);
    // ...and closing EVERYTHING persists an EMPTY list under a LIVE key
    // (close all, reload, see none; the decoded list decides, not key
    // presence).
    for (let i = els(".workbench-tab-close").length; i > 0; i = els(".workbench-tab-close").length) {
      els(".workbench-tab-close")[0]!.click();
      await tick();
    }
    expect(session.has(WORKBENCH_TABS_KEY)).toBe(true);
    expect(storedTabs()).toEqual({ tabs: [], activeId: null });
    // sessionStorage ONLY: the seam's own localStorage keys are one question
    // (collapsed/width), the tab record must never join them.
    expect(store.has(WORKBENCH_TABS_KEY)).toBe(false);
  });

  it("reload: the seed re-docks in order with the stored active tab; restored file tabs read on attach; a vanished path renders the viewer's error, the pane stays operable", async () => {
    session.set(
      WORKBENCH_TABS_KEY,
      JSON.stringify({
        tabs: [
          { id: "files", kind: "files", label: "Files" },
          { id: "/rootA/reloaded.txt", kind: "file", label: "reloaded.txt" },
          { id: "/rootA/vanished.txt", kind: "file", label: "vanished.txt" },
        ],
        activeId: "/rootA/reloaded.txt",
      }),
    );
    seedWorkbenchStoreFromStorage(); // init()'s exact boot line
    clearSent();
    await attach(); // sessionCreated: the restored reads dispatch here
    await tick();
    const reads = sent<{ requestId: number; path: string; offset: number }>("readFile").filter((r) =>
      r.path.endsWith("reloaded.txt") || r.path.endsWith("vanished.txt"),
    );
    expect(reads.map((r) => r.path)).toEqual(["/rootA/reloaded.txt", "/rootA/vanished.txt"]);
    expect(reads.every((r) => r.offset === 0)).toBe(true);
    await openPane();
    expect(els("#workbench-tabs [role=tab]").map((b) => b.textContent)).toEqual([
      "Files",
      "reloaded.txt",
      "vanished.txt",
    ]);
    expect(els("#workbench-tabs [role=tab]").map((b) => b.getAttribute("aria-selected"))).toEqual([
      "false",
      "true",
      "false",
    ]);
    const readOf = (path: string): number => reads.find((r) => r.path === path)!.requestId;
    ws.fireMessage({
      type: "readFileResult",
      requestId: readOf("/rootA/reloaded.txt"),
      path: "/rootA/reloaded.txt",
      offset: 0,
      content: "still here\nsecond line\n",
    });
    // The vanished path gets the server's honest one-liner (deleted/denied).
    ws.fireMessage({
      type: "readFileResult",
      requestId: readOf("/rootA/vanished.txt"),
      path: "/rootA/vanished.txt",
      offset: 0,
      error: "not found: /rootA/vanished.txt",
    });
    await tick();
    // editor-core: the restored complete read lands EDITABLE (the data-line
    // seam carries into the editor layer); the vanished tab next door still
    // renders the viewer's verbatim error.
    expect(els(".editor-line").map((r) => r.getAttribute("data-line"))).toEqual(["1", "2"]);
    // The errored tab is one click away and renders the verbatim error --
    // no hang, no wedge, the pane keeps operating.
    els("#workbench-tabs [role=tab]").at(-1)!.click();
    await tick();
    expect(el(".file-view-error").textContent).toBe("not found: /rootA/vanished.txt");
    expect(el("#workbench-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("a corrupt stored record is invisible to the boot line: seed leaves the store at zero tabs, silently", () => {
    session.set(WORKBENCH_TABS_KEY, "{not json");
    seedWorkbenchStoreFromStorage();
    expect(workbenchStore.get()).toEqual({ tabs: [], activeId: null });
  });
});

// ── workbench EDITOR (editor-core, real app wiring) ────────────────────────
// The hidden-textarea capture drives the buffer and the rendered layer;
// Ctrl+S speaks saveFile with the recorded BASE and clears the tab dot; the
// conflict refusal opens the honest Overwrite/Reload pair; close gates on
// unsaved work; the whitespace pref persists and repaints; the read cap
// keeps its files in the viewer with the honest note.

describe("workbench editor (real app wiring)", () => {
  const EDIT_PATH = "/rootA/wedit.txt";
  const CONFLICT_PATH = "/rootA/wconf.txt";
  const CLOSE_PATH = "/rootA/wclose.txt";
  const WS_PATH = "/rootA/wsview.txt";
  const CAP_PATH = "/rootA/wcap.txt";
  const TREE_PATH = "/rootA/wtree.txt";
  const KEEP_PATH = "/rootA/wkeep.txt";
  const CUT_PATH = "/rootA/wcut.txt";
  const WSTAB_PATH = "/rootA/wstab.txt";
  const DIR_FIXTURE = [{ name: "wtree.txt", path: TREE_PATH, isDir: false, size: 4 }];

  const openPane = async (): Promise<void> => {
    if (!document.querySelector("#workbench-panel")) {
      el("#workbench-toggle").click();
      await tick();
    }
  };

  /** Open a file tab DIRECTLY (the persistence section's producer idiom):
   *  activation owns the first read, which stays UNANSWERED for the test
   *  to reply to through answerRead. */
  async function openFile(path: string): Promise<void> {
    await attach();
    await openPane();
    clearSent();
    workbenchStore.open({ id: path, kind: "file", label: path.split("/").pop()!, dirty: false });
    await tick();
    els("#workbench-tabs [role=tab]").at(-1)!.click();
    await tick();
    const req = sent<{ requestId: number; path: string; offset: number }>("readFile").pop()!;
    expect(req.path).toBe(path);
    expect(req.offset).toBe(0);
  }

  /** Answer the OPEN read (or the seam's next auto-page) for a path. */
  async function answerRead(path: string, fields: Record<string, unknown>): Promise<void> {
    const req = sent<{ requestId: number }>("readFile").pop()!;
    ws.fireMessage({ type: "readFileResult", requestId: req.requestId, path, ...fields });
    await tick();
  }
  const loadComplete = (path: string, content: string, mtimeMs = 1000): Promise<void> =>
    answerRead(path, { offset: 0, content, mtimeMs });

  /** Press a key on the hidden capture textarea; returns false when the
   *  handler preventDefault'd (dispatchEvent reports !defaultPrevented). */
  const key = (k: string, mods: Record<string, unknown> = {}): boolean =>
    el(".editor-input").dispatchEvent({ type: "keydown", key: k, ...mods } as unknown as Event);
  const taValue = (): string => (el(".editor-input") as unknown as { value: string }).value;
  /** The editor's first rendered row, as plain text (nbsp-empty lines
   *  normalize back to ""). */
  const codeText = (): string => (el(".editor-code").textContent ?? "").replace(/\u00a0/g, "");

  /** Fire the house leave event (pagehide / beforeunload) with a spy and
   *  report whether a listener vetoed it (the dirty-buffer unload guard). */
  const fireEditorLeave = (): boolean => {
    let prevented = false;
    const mk = (): Event =>
      ({ type: "beforeunload", preventDefault: () => (prevented = true), returnValue: undefined }) as unknown as Event;
    for (const type of ["pagehide", "beforeunload"]) {
      for (const cb of [...(winListeners.get(type) ?? [])]) cb(mk());
    }
    return prevented;
  };

  async function openTreeFixture(): Promise<void> {
    await attach();
    await openPane();
    for (const t of [...workbenchStore.get().tabs]) workbenchStore.close(t.id);
    await tick();
    clearSent();
    el("#workbench-open-files").click();
    await tick();
    for (const r of sent<{ requestId: number; path?: string }>("listDir")) {
      ws.fireMessage(
        r.path === undefined
          ? { type: "listDirResult", requestId: r.requestId, roots: [{ name: "rootA", path: "/rootA" }] }
          : { type: "listDirResult", requestId: r.requestId, path: r.path, entries: DIR_FIXTURE },
      );
    }
    await tick();
  }

  afterEach(async () => {
    // Close tabs through the REAL close buttons with the confirm accepted:
    // dirty buffers confirm and DROP exactly as they do for the user, so
    // nothing leaks into the next test (paths stay exclusive regardless).
    confirmAnswer = true;
    promptAnswer = "renamed";
    for (const b of [...els(".workbench-tab-close")]) {
      confirmAnswer = true;
      b.click();
      await tick();
    }
    for (const t of [...workbenchStore.get().tabs]) workbenchStore.close(t.id);
    await tick();
    if (document.querySelector("#workbench-panel")) {
      el("#workbench-toggle").click();
      await tick();
    }
  });

  it("typing edits buffer+layer; the tab dot lands; Ctrl+S saves with the read's mtime and clears dirty", async () => {
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "ab\n");
    // EDITABLE posture: the editor is mounted, clean, and the data-line
    // seam carried into the editor's own layer.
    expect(el(".editor")).toBeTruthy();
    expect(els(".editor-line").map((r) => r.getAttribute("data-line"))).toEqual(["1"]);
    expect(codeText()).toBe("ab");
    expect(document.querySelector(".workbench-dirty")).toBeNull();

    // Type: keydown intercepted BEFORE default; the buffer owns the text
    // and the capture textarea STAYS EMPTY (the desync invariant).
    key("End");
    await tick();
    key("c");
    await tick();
    expect(codeText()).toBe("abc");
    expect(taValue()).toBe("");
    expect(el(".workbench-dirty")).toBeTruthy();
    expect(el(".file-view-status").textContent).toContain("edited");

    // Ctrl+S: one saveFile frame, content rebuilt byte-exact (the trailing
    // newline the read carried), BASE = the mtime the read reported.
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number; path: string; content: string; baseMtimeMs: number }>("saveFile").pop()!;
    expect(save.path).toBe(EDIT_PATH);
    expect(save.content).toBe("abc\n");
    expect(save.baseMtimeMs).toBe(1000);

    // Success: dot off, base moves to the file's NEW mtime -- the NEXT save
    // carries it (the conflict gate's chain stays honest).
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: EDIT_PATH, mtimeMs: 2000 });
    await tick();
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    expect(el(".file-view-status").textContent).toContain("saved");
    clearSent();
    key("!");
    await tick();
    key("s", { ctrlKey: true });
    await tick();
    const save2 = sent<{ requestId: number; baseMtimeMs: number; content: string }>("saveFile").pop()!;
    expect(save2.baseMtimeMs).toBe(2000);
    expect(save2.content).toBe("abc!\n");
    ws.fireMessage({ type: "fileOpResult", requestId: save2.requestId, path: EDIT_PATH, mtimeMs: 2500 });
    await tick();
  });

  it("the conflict refusal offers Overwrite (resend with the fresh mtime), which lands clean", async () => {
    await openFile(CONFLICT_PATH);
    await loadComplete(CONFLICT_PATH, "mine\n");
    key("End");
    await tick();
    key("X");
    await tick();
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    // The server wrote NOTHING: conflict + the CURRENT mtime + the honest
    // line. The dialog names BOTH doors.
    confirmSeen = [];
    confirmAnswer = true; // the Overwrite door
    ws.fireMessage({
      type: "fileOpResult",
      requestId: save.requestId,
      conflict: true,
      mtimeMs: 5555,
      error: "wconf.txt changed on disk since it was read -- reload or overwrite deliberately",
    });
    await tick();
    expect(confirmSeen.join()).toContain("changed on disk");
    expect(confirmSeen.join()).toContain("Overwrite");
    expect(confirmSeen.join()).toContain("DISCARDS");
    // Overwrite: the resend carries the FRESH mtime as its base (the
    // server's pinned flow) and success clears the dirty state.
    const again = sent<{ requestId: number; baseMtimeMs: number; content: string }>("saveFile").pop()!;
    expect(again.baseMtimeMs).toBe(5555);
    expect(again.content).toBe("mineX\n");
    ws.fireMessage({ type: "fileOpResult", requestId: again.requestId, path: CONFLICT_PATH, mtimeMs: 6000 });
    await tick();
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    expect(el(".file-view-status").textContent).toContain("saved");
  });

  it("conflict Cancel reloads from disk: the buffer rebuilds from the fresh bytes, dirty clears", async () => {
    await openFile(CONFLICT_PATH);
    await loadComplete(CONFLICT_PATH, "mine\n");
    key("End");
    await tick();
    key("Z");
    await tick();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    confirmSeen = [];
    confirmAnswer = false; // the Cancel door: reload, discard
    ws.fireMessage({
      type: "fileOpResult",
      requestId: save.requestId,
      conflict: true,
      mtimeMs: 5555,
      error: "wconf.txt changed on disk since it was read -- reload or overwrite deliberately",
    });
    await tick();
    expect(confirmSeen.join()).toContain("DISCARDS");
    // The Cancel door reloads SYNCHRONOUSLY inside the reply (one confirm
    // already said "DISCARDS", so onFileReload skips its own gate): the
    // reload frame is already on the wire -- no clearSent here, it would
    // eat the very request asserted below.
    const reload = sent<{ requestId: number; path: string; offset: number }>("readFile").pop()!;
    expect(reload.path).toBe(CONFLICT_PATH);
    expect(reload.offset).toBe(0);
    ws.fireMessage({
      type: "readFileResult",
      requestId: reload.requestId,
      path: CONFLICT_PATH,
      offset: 0,
      content: "from disk\n",
      mtimeMs: 5555,
    });
    await tick();
    expect(codeText()).toBe("from disk");
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("closing a dirty tab confirms; refused the tab stays, accepted the reopen re-reads fresh", async () => {
    await openFile(CLOSE_PATH);
    await loadComplete(CLOSE_PATH, "keep me\n");
    key("End");
    await tick();
    key("d");
    await tick();
    expect(el(".workbench-dirty")).toBeTruthy();
    // Refused: the tab (and its unsaved text) survive.
    confirmSeen = [];
    confirmAnswer = false;
    el(".workbench-tab-close").click();
    await tick();
    expect(confirmSeen.join()).toContain("unsaved");
    expect(workbenchStore.get().tabs.some((t) => t.id === CLOSE_PATH)).toBe(true);
    expect(el(".editor")).toBeTruthy();
    // Confirmed: the tab closes; reopening RE-READS (the discarded buffer's
    // stale cache must not masquerade as the truth).
    confirmAnswer = true;
    el(".workbench-tab-close").click();
    await tick();
    expect(workbenchStore.get().tabs.some((t) => t.id === CLOSE_PATH)).toBe(false);
    clearSent();
    workbenchStore.open({ id: CLOSE_PATH, kind: "file", label: "wclose.txt", dirty: false });
    await tick();
    els("#workbench-tabs [role=tab]").at(-1)!.click();
    await tick();
    const req = sent<{ requestId: number }>("readFile").pop()!;
    expect(req).toBeTruthy();
    ws.fireMessage({ type: "readFileResult", requestId: req.requestId, path: CLOSE_PATH, offset: 0, content: "keep me\n", mtimeMs: 1000 });
    await tick();
    expect(codeText()).toBe("keep me");
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("the whitespace toggle marks the editor and persists per browser (localStorage)", async () => {
    await openFile(WS_PATH);
    await loadComplete(WS_PATH, "a b\tc\n  ");
    expect(els(".editor-line .ws").length).toBe(0);
    // Toggle ON: middle dots + the tab arrow appear; the pref persists.
    el(".editor-ws-btn").click();
    await tick();
    expect(store.get("hotdog-webui-show-ws")).toBe("1");
    expect(els(".editor-line .ws-space").length).toBeGreaterThan(0);
    expect(els(".editor-line .ws-tab").length).toBe(1);
    expect(els(".editor-line .ws-trail").length).toBeGreaterThan(0);
    expect(el(".editor-ws-btn").getAttribute("aria-pressed")).toBe("true");
    // Toggle OFF: marks vanish, the key goes away too (remove, not "0").
    el(".editor-ws-btn").click();
    await tick();
    expect(els(".editor-line .ws").length).toBe(0);
    expect(store.has("hotdog-webui-show-ws")).toBe(false);
  });

  it("an over-cap read STAYS read-only with the honest note and no further auto-paging", async () => {
    await openFile(CAP_PATH);
    await answerRead(CAP_PATH, { offset: 0, content: "y".repeat(300000) + "\n", truncated: true, mtimeMs: 1 });
    expect(document.querySelector(".editor")).toBeNull();
    expect(els(".file-view-note").map((n) => n.textContent).join()).toContain("Over the 256 KiB edit cap");
    // The seam STOPPED paging: the accumulation already proved the verdict.
    clearSent();
    await tick();
    expect(sent("readFile")).toHaveLength(0);
  });

  it("IME composition commits ONCE at compositionend (keydown inert mid-composition, textarea cleared)", async () => {
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "");
    const ta = el(".editor-input") as unknown as HTMLTextAreaElement;
    ta.dispatchEvent({ type: "compositionstart" } as unknown as Event);
    ta.value = "\u306b"; // the IME owns the textarea between start and end
    key("x"); // inert while composing: nothing reaches the buffer
    await tick();
    expect(codeText()).toBe("");
    ta.dispatchEvent({ type: "compositionend", data: "\u306b\u307b" } as unknown as Event);
    await tick();
    expect(codeText()).toBe("\u306b\u307b");
    expect(taValue()).toBe("");
    expect(el(".workbench-dirty")).toBeTruthy();
  });

  it("paste inserts clipboardData text as one block; Ctrl+C writes the selection through the copyText seam", async () => {
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "");
    const ta = el(".editor-input") as unknown as HTMLTextAreaElement;
    ta.dispatchEvent({
      type: "paste",
      clipboardData: { getData: () => "two\r\nlines" },
    } as unknown as Event);
    await tick();
    expect(els(".editor-line").length).toBe(2);
    expect(el(".editor-line").textContent).toContain("two");
    expect(taValue()).toBe("");
    // Select-all then Ctrl+C: the payload goes STRAIGHT to the clipboard
    // seam (copyText) and the keydown is preventDefault'd. The old
    // stage-the-textarea-and-let-the-native-copy-fire contract was a lie:
    // our own copy handler wiped the value before the default action read
    // it, and the fake DOM has no default action to see it. The textarea
    // must stay clean throughout.
    const copied: string[] = [];
    const prevNav = Object.getOwnPropertyDescriptor(globalThis, "navigator");
    Object.defineProperty(globalThis, "navigator", {
      value: { clipboard: { writeText: async (t: string) => { copied.push(t); } } },
      configurable: true,
    });
    try {
      key("a", { ctrlKey: true });
      await tick();
      // dispatchEvent returns !defaultPrevented, so false == claim accepted.
      expect(key("c", { ctrlKey: true })).toBe(false);
      await tick(); // copyText's writeText lands on the microtask queue
      expect(copied).toEqual(["two\nlines"]);
      expect(taValue()).toBe("");
      // An EMPTY selection stays inert (the shipped Ctrl+X doctrine): no
      // copyText call, NO preventDefault, buffer untouched.
      key("End");
      await tick();
      expect(key("c", { ctrlKey: true })).toBe(true);
      await tick();
      expect(copied).toEqual(["two\nlines"]);
      expect(codeText()).toBe("two");
      // onCopy survives as the residue cleaner it now actually is: a stray
      // copy event over composition residue still restores the invariant.
      ta.value = "\u306b";
      ta.dispatchEvent({ type: "copy" } as unknown as Event);
      expect(taValue()).toBe("");
    } finally {
      if (prevNav) Object.defineProperty(globalThis, "navigator", prevNav);
      else delete (globalThis as Record<string, unknown>).navigator;
    }
  });

  it("rename follows the dirty tab: same seat, dot survives, save targets the NEW path", async () => {
    await openTreeFixture();
    clearSent();
    workbenchStore.open({ id: TREE_PATH, kind: "file", label: "wtree.txt", dirty: false });
    await tick();
    els("#workbench-tabs [role=tab]").at(-1)!.click();
    await tick();
    const req = sent<{ requestId: number; path: string }>("readFile").pop()!;
    ws.fireMessage({ type: "readFileResult", requestId: req.requestId, path: TREE_PATH, offset: 0, content: "src\n", mtimeMs: 7000 });
    await tick();
    key("End");
    await tick();
    key("t");
    await tick();
    expect(el(".workbench-dirty")).toBeTruthy();
    // Back to the tree, rename the row (the prompt answers BEFORE the click:
    // the menu action reads it synchronously and ships the frame).
    els("#workbench-tabs [role=tab]")[0]!.click();
    await tick();
    promptAnswer = "wtree2.txt";
    const btn = els(".ft-row").find((r) => r.getAttribute("data-path") === TREE_PATH)?.querySelector(".ft-row-btn") as HTMLElement;
    btn!.dispatchEvent({ type: "contextmenu", currentTarget: btn, clientX: 20, clientY: 20 } as unknown as Event);
    await tick();
    els(".context-menu-item").find((b) => b.textContent === "Rename")!.click();
    await tick();
    const ren = sent<{ requestId: number; oldPath: string; newPath: string }>("renamePath").pop()!;
    expect(ren.oldPath).toBe(TREE_PATH);
    expect(ren.newPath).toBe("/rootA/wtree2.txt");
    ws.fireMessage({ type: "fileOpResult", requestId: ren.requestId, path: "/rootA/wtree2.txt" });
    await tick();
    // The tab followed the file: SAME strip seat (index 0 is the tree), the
    // file tab re-pointed, the dot STILL on (unsaved text survived), and
    // Ctrl+S targets the NEW path with the ORIGINAL base.
    expect(workbenchStore.get().tabs.some((t) => t.id === TREE_PATH)).toBe(false);
    expect(workbenchStore.get().tabs.some((t) => t.id === "/rootA/wtree2.txt")).toBe(true);
    expect(el(".workbench-dirty")).toBeTruthy();
    // Back onto the followed tab: the EDITED text is still in the layer.
    // (The label's textContent carries the dirty dot too -- match on the
    // name only.)
    els("#workbench-tabs [role=tab]").find((b) => (b.textContent ?? "").startsWith("wtree2.txt"))!.click();
    await tick();
    expect(el(".editor")).toBeTruthy();
    expect(codeText()).toBe("srct");
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number; path: string; content: string; baseMtimeMs: number }>("saveFile").pop()!;
    expect(save.path).toBe("/rootA/wtree2.txt");
    expect(save.content).toBe("srct\n");
    expect(save.baseMtimeMs).toBe(7000);
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: "/rootA/wtree2.txt", mtimeMs: 8000 });
    await tick();
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("a clean close keeps the cache: zero-traffic reopen opens EDITABLE off the survived mtime; a save invalidates it", async () => {
    await openFile(KEEP_PATH);
    await loadComplete(KEEP_PATH, "stay\n", 4242);
    expect(el(".editor")).toBeTruthy();
    // CLEAN close: the discard gate never asks, and nothing goes on the wire.
    confirmSeen = [];
    els(".workbench-tab-close").at(-1)!.click();
    await tick();
    expect(confirmSeen).toHaveLength(0);
    clearSent();
    // Reopen: activation draws the cached view (the reopen-must-not-wipe
    // doctrine holds) AND the editor mounts anyway -- activation is the
    // cached ready view's "open editable" hook.
    workbenchStore.open({ id: KEEP_PATH, kind: "file", label: "wkeep.txt", dirty: false });
    await tick();
    els("#workbench-tabs [role=tab]").at(-1)!.click();
    await tick();
    expect(sent("readFile")).toHaveLength(0);
    expect(el(".editor")).toBeTruthy();
    expect(codeText()).toBe("stay");
    // The BASE survived the close: the save carries the read's mtime.
    key("End");
    await tick();
    key("!");
    await tick();
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number; content: string; baseMtimeMs: number }>("saveFile").pop()!;
    expect(save.content).toBe("stay!\n");
    expect(save.baseMtimeMs).toBe(4242);
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: KEEP_PATH, mtimeMs: 5000 });
    await tick();
    // A SUCCESSFUL SAVE invalidates the cached bytes (the disk is ahead now):
    // the next reopen pays a fresh read, so it can never edit off stale text.
    els(".workbench-tab-close").at(-1)!.click();
    await tick();
    clearSent();
    workbenchStore.open({ id: KEEP_PATH, kind: "file", label: "wkeep.txt", dirty: false });
    await tick();
    els("#workbench-tabs [role=tab]").at(-1)!.click();
    await tick();
    expect(sent("readFile")).toHaveLength(1);
  });

  it("Ctrl+X with an EMPTY selection is inert: no char eaten, no dirty, no line join", async () => {
    await openFile(CUT_PATH);
    await loadComplete(CUT_PATH, "ab\ncd"); // caret at (0,0); two lines, trailing NL
    key("End");
    await tick();
    expect(codeText()).toBe("ab");
    clearSent();
    key("x", { ctrlKey: true }); // caret at End of line 1, NOTHING selected
    await tick();
    // The cut is a copy THEN a delete: with no range it deletes nothing --
    // NOT the character left of the caret (the pre-fix caret-backspace leak).
    expect(codeText()).toBe("ab");
    expect(els(".editor-line").length).toBe(2);
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    // No undo step was recorded, so Ctrl+Z stays inert too.
    key("z", { ctrlKey: true });
    await tick();
    expect(codeText()).toBe("ab");
    expect(document.querySelector(".workbench-dirty")).toBeNull();

    // At column 0 the same chord must NOT join the two lines.
    key("Home");
    await tick();
    key("x", { ctrlKey: true });
    await tick();
    expect(els(".editor-line").length).toBe(2);
    expect(els(".editor-line").map((r) => r.getAttribute("data-line"))).toEqual(["1", "2"]);
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    // A REAL selection still cuts (the guard returns only when nothing is
    // staged): select-all then Ctrl+X empties the buffer and dirties it.
    key("a", { ctrlKey: true });
    await tick();
    key("x", { ctrlKey: true });
    await tick();
    expect(codeText()).toBe("");
    expect(el(".workbench-dirty")).toBeTruthy();
  });

  it("an empty-area click below the content puts the caret at the buffer END", async () => {
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "ab\ncd");
    // The full-height sheet paints empty space below the last row; a click
    // there is the viewport's own (no row handled it), and it maps to the
    // buffer's END -- the next typed character lands after "cd", not on a
    // phantom row. (The test DOM has no layout, so we hit the viewport, not
    // a phantom coordinate.)
    const viewport = el(".editor-viewport");
    viewport.dispatchEvent({ type: "mousedown", clientX: 40, clientY: 100000 } as unknown as Event);
    await tick();
    key("Z");
    await tick();
    expect(els(".editor-line").map((r) => r.textContent)).toEqual(["1ab", "2cdZ"]);
    expect(el(".workbench-dirty")).toBeTruthy();
  });

  it("a save in flight followed by a rename: the reply clears the saving gate on the moved session", async () => {
    await openTreeFixture();
    clearSent();
    workbenchStore.open({ id: TREE_PATH, kind: "file", label: "wtree.txt", dirty: false });
    await tick();
    els("#workbench-tabs [role=tab]").at(-1)!.click();
    await tick();
    const req = sent<{ requestId: number; path: string }>("readFile").pop()!;
    ws.fireMessage({ type: "readFileResult", requestId: req.requestId, path: TREE_PATH, offset: 0, content: "src\n", mtimeMs: 7000 });
    await tick();
    key("End");
    await tick();
    key("t"); // "srct", dirty
    await tick();
    expect(el(".workbench-dirty")).toBeTruthy();

    // Ctrl+S ships the save for the OLD path with the read's base; the reply
    // stays IN FLIGHT (do not answer it yet).
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number; path: string; baseMtimeMs: number }>("saveFile").pop()!;
    expect(save.path).toBe(TREE_PATH);
    expect(save.baseMtimeMs).toBe(7000);
    expect(el(".file-view-status").textContent).toContain("saving...");

    // Rename the file WHILE the save is in flight, and let the rename reply
    // land FIRST (the session moves to the new spelling).
    els("#workbench-tabs [role=tab]")[0]!.click(); // back to the tree
    await tick();
    promptAnswer = "wtree2.txt";
    const btn = els(".ft-row").find((r) => r.getAttribute("data-path") === TREE_PATH)?.querySelector(".ft-row-btn") as HTMLElement;
    btn!.dispatchEvent({ type: "contextmenu", currentTarget: btn, clientX: 20, clientY: 20 } as unknown as Event);
    await tick();
    els(".context-menu-item").find((b) => b.textContent === "Rename")!.click();
    await tick();
    const ren = sent<{ requestId: number; oldPath: string; newPath: string }>("renamePath").pop()!;
    expect(ren.oldPath).toBe(TREE_PATH);
    ws.fireMessage({ type: "fileOpResult", requestId: ren.requestId, path: "/rootA/wtree2.txt" });
    await tick();

    // Now the save reply lands with an ERROR. Its pending record was
    // retargeted to the MOVED session, so it clears `saving` there (before
    // the retarget the OLD-path lookup missed and the gate stuck true
    // forever -- every later Ctrl+S was silently refused).
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, error: "read-only filesystem" });
    await tick();
    // Back onto the followed tab: still dirty, NOT stuck on "saving...".
    els("#workbench-tabs [role=tab]").find((b) => (b.textContent ?? "").startsWith("wtree2.txt"))!.click();
    await tick();
    expect(el(".editor")).toBeTruthy();
    expect(codeText()).toBe("srct");
    expect(el(".workbench-dirty")).toBeTruthy();
    expect(el(".file-view-status").textContent).toContain("edited");

    // Ctrl+S works again and ships for the NEW path with the PRE-RENAME base.
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save2 = sent<{ requestId: number; path: string; content: string; baseMtimeMs: number }>("saveFile").pop()!;
    expect(save2.path).toBe("/rootA/wtree2.txt");
    expect(save2.content).toBe("srct\n");
    expect(save2.baseMtimeMs).toBe(7000);
    // A successful save then lands it clean on the new path.
    ws.fireMessage({ type: "fileOpResult", requestId: save2.requestId, path: "/rootA/wtree2.txt", mtimeMs: 8000 });
    await tick();
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("a dirty buffer vetoes a page leave (the refresh would silently eat it); a clean one does not", async () => {
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "abc\n");
    // Clean editor: the leave event is not vetoed (no nag).
    expect(fireEditorLeave()).toBe(false);
    // Type -> dirty: a refresh/close now shows the browser's prompt.
    key("End");
    await tick();
    key("!");
    await tick();
    expect(el(".workbench-dirty")).toBeTruthy();
    expect(fireEditorLeave()).toBe(true);
    // Save it clean: the veto lifts.
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: EDIT_PATH, mtimeMs: 2000 });
    await tick();
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    expect(fireEditorLeave()).toBe(false);
  });

  it("the veto guard ships on beforeunload, NOT the non-cancelable pagehide", async () => {
    // pagehide is NOT cancelable in modern browsers -- a veto registered
    // there is inert forever. The pin fires EACH event separately, so a
    // guard that rode the shared DRAFT_LEAVE_EVENT (which is pagehide in a
    // browser, where onpagehide exists) could not pass it.
    const fireOne = (type: string): boolean => {
      let prevented = false;
      for (const cb of [...(winListeners.get(type) ?? [])])
        cb({ type, preventDefault: () => (prevented = true), returnValue: undefined } as unknown as Event);
      return prevented;
    };
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "abc\n");
    key("End");
    await tick();
    key("!");
    await tick();
    expect(el(".workbench-dirty")).toBeTruthy();
    expect(fireOne("beforeunload")).toBe(true); // the cancelable event carries the veto
    expect(fireOne("pagehide")).toBe(false); // nothing rides the inert one
    // Clean it for the rest of the suite (same save dance as the pin above).
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: EDIT_PATH, mtimeMs: 2000 });
    await tick();
  });

  it("mouse selection: row mousedown then drag across a line boundary selects", async () => {
    // The repro ("unable to select text at all") only bites with real
    // rects: the capture textarea sat one gutter LEFT of the caret and ate
    // the next press. This pin drives the geometry a real browser reports
    // (viewport at {left:100,top:50}, code at x=140 -- one gutter right)
    // and asserts a row-anchored drag extends the selection across rows.
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "ab\ncd");
    const viewport = el(".editor-viewport");
    const rows = els(".editor-line");
    const code0 = rows[0]!.querySelector(".editor-code")!;
    const { charWidth } = await import("@extensions/webui/ui/editor.tsx");
    const cw = charWidth();
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, right: left + width, bottom: top + height, width, height });
    (viewport as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect(100, 50, 600, 400);
    (code0 as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect(140, 50, 600, 20);
    // Press inside row 0 at column 1.
    rows[0]!.dispatchEvent({
      type: "mousedown",
      currentTarget: rows[0],
      clientX: 140 + cw,
      clientY: 60,
    } as unknown as Event);
    await tick();
    // Drag to row 1, column 2 (buttons held).
    viewport.dispatchEvent({
      type: "mousemove",
      currentTarget: viewport,
      buttons: 1,
      clientX: 140 + 2 * cw,
      clientY: 80,
    } as unknown as Event);
    await tick();
    // Both rows carry selection rects (the overlay painted the range)...
    expect(els(".editor-line .editor-sel").length).toBe(2);
    // ...and the NEXT keystroke replaces the cross-line range, proving the
    // buffer's selection (not just the paint) moved: "b\ncd" -> "Z".
    key("Z");
    await tick();
    expect(els(".editor-line").map((r) => r.textContent)).toEqual(["1aZ"]);
    // Leave the buffer CLEAN for the pins that reuse this path (a dirty
    // session would short-circuit the next openFile's readFile request).
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: EDIT_PATH, mtimeMs: 2100 });
    await tick();
  });

  it("the FIRST gesture can be an empty-area drag: the drag x rides the LIVE code rect (real-Chromium repro)", async () => {
    // The drag's x origin must ride the LIVE code rect: one captured at
    // press time is 0 before the first-ever row
    // press, so a page's first gesture -- drag from the empty sheet --
    // lands a whole gutter RIGHT of the pointer. The pin injects the rects
    // a real browser reports and drives the fresh-page sequence: viewport
    // press (no row handler), one held move into row 2.
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "alpha\nbeta gamma\ndelta");
    const viewport = el(".editor-viewport");
    const { charWidth } = await import("@extensions/webui/ui/editor.tsx");
    const cw = charWidth();
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, right: left + width, bottom: top + height, width, height });
    (viewport as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect(100, 50, 600, 400);
    // Row 1's code origin sits at x=140 (one gutter right of the viewport).
    const code0 = els(".editor-line")[0]!.querySelector(".editor-code")!;
    (code0 as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect(140, 50, 600, 20);
    viewport.dispatchEvent({ type: "mousedown", currentTarget: viewport, clientX: 400, clientY: 250 } as unknown as Event);
    await tick();
    // Held move to row 2 ("beta gamma") at column 3, x read off the LIVE rect.
    viewport.dispatchEvent({ type: "mousemove", currentTarget: viewport, buttons: 1, clientX: 140 + 3 * cw, clientY: 50 + 25 } as unknown as Event);
    await tick();
    viewport.dispatchEvent({ type: "mouseup", currentTarget: viewport } as unknown as Event);
    await tick();
    const caret = el(".editor-caret");
    // The head is at (1,3): the caret paints on row 2 at 3 cells... a stale
    // zero origin would instead land it past col 20 (x = clientX, no gutter).
    expect(caret.getAttribute("style")).toContain(`left:${3 * cw}px`);
    expect(caret.parentElement!.parentElement!.getAttribute("data-line")).toBe("2");
    // ...and the anchor stayed at the buffer's END (the empty-area rule):
    // the selection paints across rows 2 and 3.
    expect(els(".editor-line .editor-sel").length).toBe(2);
    key("Escape"); // collapse the range back to a caret for the pins below
    await tick();
    // Leave the read cache INVALIDATED for the pins that reuse this path:
    // content-based dirty makes a same-bytes space-then-backspace CLEAN and
    // Ctrl+S honestly a no-op, so the exit needs a REAL edit -- a
    // SUCCESSFUL save drops the cache (doctrine) so the next openFile pays
    // a fresh read instead of a zero-traffic cache reopen.
    key("x");
    await tick();
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: EDIT_PATH, mtimeMs: 2100 });
    await tick();
  });

  it("a wheel-scroll MID-DRAG does not shift the columns: the origin re-reads per move (real-Chromium repro)", async () => {
    // Press a row (capturing codeLeft), wheel horizontally, keep dragging:
    // with the captured origin every column
    // lands scrollLeft/cw cells off. Injecting the shifted live rect and
    // aiming at column 4 must land column 4, not column 0 (the stale x
    // clamps negative once the content slid 40px past the old origin).
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "alpha\nbeta gamma");
    const viewport = el(".editor-viewport");
    const rows = els(".editor-line");
    const { charWidth } = await import("@extensions/webui/ui/editor.tsx");
    const cw = charWidth();
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, right: left + width, bottom: top + height, width, height });
    (viewport as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect(100, 50, 600, 400);
    const code0 = rows[0]!.querySelector(".editor-code")!;
    (code0 as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect(140, 50, 600, 20);
    // Press row 1 at column 2.
    rows[0]!.dispatchEvent({ type: "mousedown", currentTarget: rows[0], clientX: 140 + 2 * cw, clientY: 60 } as unknown as Event);
    await tick();
    // The wheel slides the content 40px left: the LIVE code origin is now
    // 100. The row-2 aim point for column 3 moves with it.
    (code0 as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect(100, 50, 600, 20);
    viewport.dispatchEvent({ type: "mousemove", currentTarget: viewport, buttons: 1, clientX: 100 + 3 * cw, clientY: 80 } as unknown as Event);
    await tick();
    viewport.dispatchEvent({ type: "mouseup", currentTarget: viewport } as unknown as Event);
    await tick();
    const caret = el(".editor-caret");
    expect(caret.getAttribute("style")).toContain(`left:${3 * cw}px`);
    expect(caret.parentElement!.parentElement!.getAttribute("data-line")).toBe("2");
    // Anchor survives at the press point (row 1, column 2).
    expect(els(".editor-line .editor-sel").length).toBe(2);
    key("Escape");
    await tick();
    // Same real-edit-then-save exit as the pin above (same bytes are now
    // honestly CLEAN; the successful save drops the read cache).
    key("x");
    await tick();
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: EDIT_PATH, mtimeMs: 2200 });
    await tick();
  });

  it("marks ON: a drag extends and the anchor row's rect starts AT the anchor column", async () => {
    // The marks-on live repro ("it will not highlight or
    // select anything"): the drag DOES reach
    // the viewport and the buffer DOES extend -- the rects were painted ZERO PIXELS TALL
    // (the empty abs child has no vertical extent, pinned structurally in
    // webui-editor-layout-css), and the anchor row's rect painted from x=0
    // no matter where the press landed. This pin drives the marks-on gesture
    // with the real-browser rects injected: press to the RIGHT of a tab,
    // drag across a row; the anchor row's rect must start at
    // xForCol(anchor.col), and one keystroke must replace the range.
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "\tab\ncd");
    const wasOn = el(".editor-ws-btn").getAttribute("aria-pressed") === "true";
    if (!wasOn) {
      el(".editor-ws-btn").click();
      await tick();
    }
    const viewport = el(".editor-viewport");
    const rows = els(".editor-line");
    const code0 = rows[0]!.querySelector(".editor-code")!;
    const { charWidth } = await import("@extensions/webui/ui/editor.tsx");
    const cw = charWidth();
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ left, top, right: left + width, bottom: top + height, width, height });
    (viewport as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect(100, 50, 600, 400);
    (code0 as unknown as { getBoundingClientRect: () => unknown }).getBoundingClientRect = () => rect(140, 50, 600, 20);
    // Press at visual column 5 (right of the tab: code column 2), drag to
    // row 2 column 2 with the button held.
    rows[0]!.dispatchEvent({ type: "mousedown", currentTarget: rows[0], clientX: 140 + 5 * cw, clientY: 60 } as unknown as Event);
    await tick();
    viewport.dispatchEvent({ type: "mousemove", currentTarget: viewport, buttons: 1, clientX: 140 + 2 * cw, clientY: 80 } as unknown as Event);
    await tick();
    viewport.dispatchEvent({ type: "mouseup", currentTarget: viewport } as unknown as Event);
    await tick();
    const sels = els(".editor-line .editor-sel");
    expect(sels.length).toBe(2);
    // Anchor row: starts at xForCol(code col 2) = the tab's 4 cells + one.
    expect(sels[0]!.getAttribute("style")).toContain(`left:${5 * cw}px`);
    // Head row: ends at xForCol(code col 2) of "cd".
    expect(sels[1]!.getAttribute("style")).toContain(`width:${2 * cw}px`);
    if (!wasOn) {
      el(".editor-ws-btn").click();
      await tick();
    }
    // The selection is REAL: one keystroke replaces the cross-row range.
    key("Z");
    await tick();
    expect(els(".editor-line").map((r) => r.textContent)).toEqual(["1\taZ"]);
    // Same cache-invalidation exit as the pins above.
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: EDIT_PATH, mtimeMs: 2300 });
    await tick();
  });

  it("alt+click adds carets and one keystroke edits at EVERY caret (DOM seam)", async () => {
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "ab\ncd");
    const rows = els(".editor-line");
    // The shipped CLICK-POINT rule: alt+click adds a caret where clicked
    // (0,1) then (1,1); the base caret from the load rides along at (0,0).
    rows[0]!.dispatchEvent({ type: "mousedown", altKey: true, currentTarget: rows[0], clientX: 8, clientY: 60 } as unknown as Event);
    await tick();
    rows[1]!.dispatchEvent({ type: "mousedown", altKey: true, currentTarget: rows[1], clientX: 8, clientY: 75 } as unknown as Event);
    await tick();
    // Three painted carets' worth of selection state -> type once, edits land at all.
    key("X");
    await tick();
    expect(els(".editor-line").map((r) => r.textContent)).toEqual(["1XaXb", "2cXd"]);
    // Leave the buffer CLEAN for the pins that reuse this path (a dirty
    // session would short-circuit the next openFile's readFile request).
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: EDIT_PATH, mtimeMs: 2100 });
    await tick();
  });

  it("the matched-pair tint appears on bracket adjacency and vanishes on move", async () => {
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "( ) x");
    // Caret at (0,0) sits right of nothing but ADJACENT to "(" -> the pair
    // (0,0)-(0,2) is tinted (one cell each side).
    expect(els(".editor-match").length).toBe(2);
    key("End"); // caret to the line end -- nothing adjacent anymore
    await tick();
    expect(els(".editor-match").length).toBe(0);
    // Cleanup INLINE (the shared openFile helper needs the NEXT test's read
    // to actually ship). First the new doctrine, observed: a same-bytes
    // type-and-delete is CLEAN again (content-based dirty, the dot flips
    // off). Then the cache exit: a clean Ctrl+S is a no-op, so a REAL edit
    // goes in and its SUCCESSFUL save drops the read cache (doctrine) --
    // the next openFile re-reads instead of reopening zero-traffic off cache.
    key(" ");
    await tick();
    expect(el(".workbench-dirty")).toBeTruthy();
    key("Backspace");
    await tick();
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    key("q");
    await tick();
    clearSent();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number }>("saveFile").pop()!;
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: EDIT_PATH, mtimeMs: 2100 });
    await tick();
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("a tab's whitespace mark occupies EXACTLY its tab-stop cells (marks add no advance)", async () => {
    await openFile(WSTAB_PATH);
    await loadComplete(WSTAB_PATH, "x\ty\nz = 1\n"); // 'x'=1, tab at visual 1 -> 3 cells -> stop 4
    // Marks ON (then restore the per-browser pref for the rest of the suite).
    const wasOn = el(".editor-ws-btn").getAttribute("aria-pressed") === "true";
    if (!wasOn) {
      el(".editor-ws-btn").click();
      await tick();
    }
    // The marks are ZERO-IMPACT OVERLAYS: the
    // wrapper carries the REAL whitespace character -- the flow advance
    // equals the unmarked line's whatever face the browser paints (CSS
    // tab-size still expands the tab to its stop) -- and the glyph is a
    // separate aria-hidden span out of the flow. Arrow at the tab's cell
    // start, dot over the space, and the DOM text stays honest. (In-flow
    // mark glyphs ride raw fallback metrics -- the drift this shape makes
    // impossible.)
    const tabMark = els(".editor-line .ws-tab")[0]!;
    expect(tabMark.textContent).toBe("\u2192\t"); // overlay arrow + the REAL tab
    const spaceMark = els(".editor-line .ws-space")[0]!;
    expect(spaceMark.textContent).toBe("\u00b7 "); // overlay dot + the REAL space
    const glyphs = els(".editor-line .ws-glyph");
    expect(glyphs.length).toBeGreaterThan(0);
    for (const glyph of glyphs) expect(glyph.getAttribute("aria-hidden")).toBe("true");
    if (!wasOn) {
      el(".editor-ws-btn").click();
      await tick();
    }
  });

  it("the webfont settling re-measures the shared cell width and repaints the caret", async () => {
    const ed = await import("@extensions/webui/ui/editor.tsx");
    await openFile(EDIT_PATH);
    await loadComplete(EDIT_PATH, "0123456789");
    key("End"); // caret at column 10
    await tick();
    const caretStyle = (): string => el(".editor-caret").getAttribute("style") ?? "";
    // No layout in the test DOM -> the deterministic fallback cell (8px).
    expect(ed.charWidth()).toBe(8);
    expect(caretStyle()).toContain("left:80px"); // 10 cells x 8
    // The webfont finishes: the probe now measures a wider mono advance (a
    // swapped-in Reddit Mono). document.fonts drives this in a real browser;
    // the injected reader stands in for the probe's offsetWidth here.
    expect(ed.remeasureCharWidth(() => 1200)).toBe(true); // 100 glyphs -> 12/cell
    expect(ed.charWidth()).toBe(12);
    await tick();
    // Mounted editors repainted: the caret re-placed onto the new advance, and
    // the click hit-test shares the SAME mapping (xForCol/colForX), so a click
    // and the caret it lands on stay glued together -- no column drift.
    expect(caretStyle()).toContain("left:120px"); // 10 cells x 12
    // The font-settled wiring: a FontFaceSet whose set is ready re-measures.
    let settled = false;
    await ed.installFontRemeasure(
      { ready: Promise.resolve(), load: () => (settled = true, Promise.resolve()) },
      () => 800, // back to the fallback advance on settle
    );
    await tick();
    expect(settled).toBe(true); // the exact code faces were requested
    await tick();
    expect(ed.charWidth()).toBe(8); // restored (ready re-measured to 8)
  });

  // ── the foot-bar caret readout + jump ────────────────────────────────────
  // Dedicated paths throughout: a read-only pin leaves its path's cache
  // WARM, so sharing EDIT_PATH (or itself) would silently short-circuit the
  // next openFile's read -- one path per pin keeps every openFile paying
  // (and answering) its own read, and afterEach's confirmed close drops
  // whatever dirt the typing pins leave behind.

  const GOTO_PATH = "/rootA/wgoto.txt";
  const GOTO2_PATH = "/rootA/wgoto2.txt";
  const GOTO3_PATH = "/rootA/wgoto3.txt";
  const GOTO4_PATH = "/rootA/wgoto4.txt";
  const GOTO5_PATH = "/rootA/wgoto5.txt";
  const GOTO6_PATH = "/rootA/wgoto6.txt";
  const GOTO7_PATH = "/rootA/wgoto7.txt";
  const GOTO8_PATH = "/rootA/wgoto8.txt";

  /** Write a spec into the open jump box and submit it with Enter. */
  async function gotoType(spec: string): Promise<void> {
    const box = el(".editor-goto-input") as unknown as HTMLElement & { value: string };
    box.value = spec;
    box.dispatchEvent({ type: "input" } as unknown as Event);
    await tick();
    box.dispatchEvent({ type: "keydown", key: "Enter" } as unknown as Event);
    await tick();
  }

  it("the caret readout shows row:col, follows a click, and advances as you type", async () => {
    await openFile(GOTO_PATH);
    await loadComplete(GOTO_PATH, "hello world\nsecond line here");
    const { charWidth } = await import("@extensions/webui/ui/editor.tsx");
    const cw = charWidth();
    expect(el(".editor-goto-btn").textContent).toBe("1:1");
    // A click places the caret (row mousedown; the zero-rect fallback keeps
    // x == the column's cell) and the readout rides the repaint for free.
    const rows = els(".editor-line");
    rows[1]!.dispatchEvent({ type: "mousedown", currentTarget: rows[1], clientX: 6 * cw, clientY: 75 } as unknown as Event);
    await tick();
    expect(el(".editor-goto-btn").textContent).toBe("2:7");
    // Typing advances the column one cell per character.
    key("z");
    await tick();
    expect(el(".editor-goto-btn").textContent).toBe("2:8");
    key("z");
    await tick();
    expect(el(".editor-goto-btn").textContent).toBe("2:9");
  });

  it("clicking the readout swaps in a focused input seeded with the caret position", async () => {
    await openFile(GOTO2_PATH);
    await loadComplete(GOTO2_PATH, "seed text\nmore");
    // SEAT: immediately LEFT of the whitespace toggle.
    const bar = el(".editor-bar") as unknown as { children: HTMLElement[] };
    const seats = bar.children.map((k) => k.className);
    const wsSeat = seats.indexOf("file-reload-btn editor-ws-btn");
    expect(wsSeat).toBeGreaterThan(0);
    expect(seats[wsSeat - 1]).toBe("file-reload-btn editor-goto-btn");
    el(".editor-goto-btn").click();
    await tick();
    // PINNED SHAPE: the readout becomes an INPUT carrying the caret value.
    expect(document.querySelector(".editor-goto-btn")).toBeNull();
    const box = el(".editor-goto-input") as unknown as HTMLElement & { value: string };
    expect(box).toBeTruthy();
    expect(box.value).toBe("1:1");
    expect(document.activeElement).toBe(box as unknown as Element);
  });

  it("Enter jumps to N:M, collapses a multi-caret list to one, and closes the box", async () => {
    const lines12 = Array.from({ length: 12 }, (_, i) => `line-${i + 1} padding`);
    await openFile(GOTO3_PATH);
    await loadComplete(GOTO3_PATH, lines12.join("\n") + "\n");
    // Seed TWO carets through the alt+click seam (base at 0:1, added at 2:2).
    els(".editor-line")[1]!.dispatchEvent({ type: "mousedown", altKey: true, currentTarget: els(".editor-line")[1], clientX: 8, clientY: 75 } as unknown as Event);
    await tick();
    el(".editor-goto-btn").click();
    await tick();
    await gotoType("10:5");
    expect(document.querySelector(".editor-goto-input")).toBeNull();
    expect(el(".editor-goto-btn").textContent).toBe("10:5");
    const { charWidth } = await import("@extensions/webui/ui/editor.tsx");
    const caret = el(".editor-caret");
    expect(caret.parentElement!.parentElement!.getAttribute("data-line")).toBe("10");
    expect(caret.getAttribute("style")).toContain(`left:${4 * charWidth()}px`);
    // Focus returns to the capture textarea: the editor keeps the keystrokes.
    expect(document.activeElement).toBe(el(".editor-input") as unknown as Element);
    // SINGLE caret (pinned): one keystroke edits exactly ONE row -- the
    // alt+click caret on row 2 is gone, so no second "Q" appears anywhere.
    key("Q");
    await tick();
    const texts = els(".editor-line").map((r) => r.textContent);
    expect(texts[9]).toBe("10lineQ-10 padding");
    expect(texts.filter((t) => (t ?? "").includes("Q"))).toHaveLength(1);
  });

  it("bare N jumps to the line KEEPING the column, clamped to the target line's length", async () => {
    const content = ["x".repeat(60), "pad", "pad", "pad", "pad", "pad", "xyz", "pad", "pad"].join("\n") + "\n";
    await openFile(GOTO4_PATH);
    await loadComplete(GOTO4_PATH, content);
    const { charWidth } = await import("@extensions/webui/ui/editor.tsx");
    const cw = charWidth();
    // Park the caret at column 39 (readout 1:40) on the long line.
    const row0 = els(".editor-line")[0]!;
    row0.dispatchEvent({ type: "mousedown", currentTarget: row0, clientX: 39 * cw, clientY: 60 } as unknown as Event);
    await tick();
    expect(el(".editor-goto-btn").textContent).toBe("1:40");
    el(".editor-goto-btn").click();
    await tick();
    await gotoType("7");
    // Line 7 is "xyz" (3 chars): the kept column CLAMPS to its end, and the
    // readout says so (col 3 -> 4 displayed).
    expect(el(".editor-goto-btn").textContent).toBe("7:4");
    const caret = el(".editor-caret");
    expect(caret.parentElement!.parentElement!.getAttribute("data-line")).toBe("7");
    expect(caret.getAttribute("style")).toContain(`left:${3 * cw}px`);
  });

  it("invalid specs refuse honestly: no jump, the box STAYS open, the buffer never moves", async () => {
    await openFile(GOTO5_PATH);
    await loadComplete(GOTO5_PATH, "abcdef\nghijkl\n");
    el(".editor-goto-btn").click();
    await tick();
    for (const bad of ["abc", "0:5", "1:x", "1:2:3", ""]) {
      await gotoType(bad);
      const box = document.querySelector(".editor-goto-input") as unknown as (HTMLElement & { value: string }) | null;
      // PINNED: a refused spec keeps the box open (fix it, do not reopen it).
      expect(box).toBeTruthy();
      expect(box!.value).toBe(bad);
      expect(document.querySelector(".editor-goto-btn")).toBeNull();
    }
    // The caret never moved and nothing was edited.
    expect(el(".editor-caret").parentElement!.parentElement!.getAttribute("data-line")).toBe("1");
    expect(el(".editor-goto-btn")).toBeNull(); // still in input mode
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("Escape cancels and a bare blur cancels: readout back, caret unmoved, editor refocused", async () => {
    await openFile(GOTO6_PATH);
    await loadComplete(GOTO6_PATH, "abcdef\nghijkl\nmnopqr\n");
    // Blur WITHOUT submit: cancel, never a jump.
    el(".editor-goto-btn").click();
    await tick();
    let box = el(".editor-goto-input") as unknown as HTMLElement & { value: string };
    box.value = "3";
    box.dispatchEvent({ type: "input" } as unknown as Event);
    await tick();
    box.dispatchEvent({ type: "blur" } as unknown as Event);
    await tick();
    expect(document.querySelector(".editor-goto-input")).toBeNull();
    expect(el(".editor-goto-btn").textContent).toBe("1:1");
    // Escape: same cancel, and focus lands back on the capture textarea.
    el(".editor-goto-btn").click();
    await tick();
    box = el(".editor-goto-input") as unknown as HTMLElement & { value: string };
    box.value = "2";
    box.dispatchEvent({ type: "input" } as unknown as Event);
    await tick();
    box.dispatchEvent({ type: "keydown", key: "Escape" } as unknown as Event);
    await tick();
    expect(document.querySelector(".editor-goto-input")).toBeNull();
    expect(el(".editor-goto-btn").textContent).toBe("1:1");
    expect(document.activeElement).toBe(el(".editor-input") as unknown as Element);
    // And the caret is where it was: the next keystroke lands at row 1 col 0.
    key("Z");
    await tick();
    expect(els(".editor-line")[0]!.textContent).toBe("1Zabcdef");
  });

  it("keystrokes in the jump box never reach the buffer (native keydown isolation)", async () => {
    await openFile(GOTO7_PATH);
    await loadComplete(GOTO7_PATH, "unchanged\n");
    el(".editor-goto-btn").click();
    await tick();
    const box = el(".editor-goto-input") as unknown as HTMLElement;
    // Ordinary chars, chords, even the editor's own keys -- the editor's
    // handler rides the textarea, so the box's keystrokes die with the box.
    // Ordinary chars, chords, even the editor's own editing keys -- the
    // editor's handler rides the textarea, so the box's keystrokes die with
    // the box (Enter is deliberately absent: that chord belongs to the box,
    // pinned by the jump tests above).
    for (const k of ["x", "Backspace", "Delete", "Tab", "ArrowDown"]) {
      box.dispatchEvent({ type: "keydown", key: k } as unknown as Event);
    }
    box.dispatchEvent({ type: "keydown", key: "a", ctrlKey: true } as unknown as Event);
    await tick();
    expect(codeText()).toBe("unchanged");
    expect(els(".editor-line").length).toBe(1);
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    expect(document.querySelector(".editor-goto-input")).toBeTruthy();
  });

  it("a jump to an off-screen line scrolls the windowed slice along (viewport scrollTop)", async () => {
    const many = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`).join("\n") + "\n";
    await openFile(GOTO8_PATH);
    await loadComplete(GOTO8_PATH, many);
    // Give the viewport a real height (400px = 20 rows) through the scroll
    // event, the same channel the browser uses; the window is rows 1..32.
    const viewport = el(".editor-viewport") as unknown as HTMLElement & { clientHeight: number; scrollTop: number };
    viewport.clientHeight = 400;
    viewport.scrollTop = 0;
    viewport.dispatchEvent({ type: "scroll", currentTarget: viewport } as unknown as Event);
    await tick();
    const visible = (): string[] => els(".editor-line").map((r) => r.getAttribute("data-line")!);
    expect(visible()).toContain("1");
    expect(visible()).not.toContain("50");
    el(".editor-goto-btn").click();
    await tick();
    await gotoType("50");
    // THE WINDOWING PIN: the slice followed the caret (scrollIntoView has no
    // other path here -- the caret paints inside the rendered window).
    expect(visible()).toContain("50");
    expect(visible()).not.toContain("1");
    const caret = el(".editor-caret");
    expect(caret.parentElement!.parentElement!.getAttribute("data-line")).toBe("50");
    expect(el(".editor-goto-btn").textContent).toBe("50:1");
    // The viewport itself carries the jump: row 50 bottom-aligned (50*20+20-400).
    expect(viewport.scrollTop).toBe(600);
  });

  // ── find & replace (widget wiring; the finder itself: editor-find.test.ts)
  // House-idiom pins: Ctrl+F opens (the strip's fields take focus, the
  // buffer keeps ZERO keystrokes), the current match rides the buffer's own
  // selection layer, replaces are ONE undo step with the dirty flag
  // re-derived, and the strip state is per PATH (per editor session).

  const FIND_PATH = "/rootA/wfind.txt";
  const FIND2_PATH = "/rootA/wfind2.txt";
  const FIND3_PATH = "/rootA/wfind3.txt";
  const FIND4_PATH = "/rootA/wfind4.txt";
  const FIND5_PATH = "/rootA/wfind5.txt";
  const FIND6_PATH = "/rootA/wfind6.txt";
  const FIND7_PATH = "/rootA/wfind7.txt";

  /** Write into a strip field and fire the input event (the box owns its
   *  caret; the DOM drives the mirror). */
  async function findType(sel: string, text: string): Promise<void> {
    const box = el(sel) as unknown as HTMLElement & { value: string };
    box.value = text;
    box.dispatchEvent({ type: "input" } as unknown as Event);
    await tick();
  }
  const fieldKey = (sel: string, k: string, mods: Record<string, unknown> = {}): void => {
    el(sel).dispatchEvent({ type: "keydown", key: k, ...mods } as unknown as Event);
  };
  const findCount = (): string => el(".editor-find-count").textContent ?? "";
  const allText = (): string =>
    els(".editor-code")
      .map((c) => (c.textContent ?? "").replace(/\u00a0/g, ""))
      .join("\n");

  it("ctrl+F opens the strip focused; typing selects matches, counts, and Enter/Shift+Enter walk with wrap", async () => {
    await openFile(FIND_PATH);
    await loadComplete(FIND_PATH, "one two one\nthree one\n");
    expect(key("f", { ctrlKey: true })).toBe(false); // preventDefault: native find refused
    await tick();
    expect(el(".editor-find")).toBeTruthy();
    // FOCUS: the query field owns the keyboard, NOT the capture textarea.
    expect(document.activeElement).toBe(el(".editor-find-query") as unknown as Element);
    await findType(".editor-find-query", "one");
    expect(findCount()).toBe("1 of 3");
    // The current match is a buffer SELECTION: the theme's own sel layer.
    expect(els(".editor-sel").length).toBe(1);
    fieldKey(".editor-find-query", "Enter");
    await tick();
    expect(findCount()).toBe("2 of 3");
    el(".editor-find-next").click();
    await tick();
    expect(findCount()).toBe("3 of 3");
    el(".editor-find-next").click(); // WRAP
    await tick();
    expect(findCount()).toBe("1 of 3");
    fieldKey(".editor-find-query", "Enter", { shiftKey: true }); // wrap backwards
    await tick();
    expect(findCount()).toBe("3 of 3");
    // Keystrokes inside the strip NEVER reach the buffer (the editor's
    // keydown rides the separate capture textarea -- focus guard by
    // construction -- and the claimed chords stopPropagation on top).
    for (const k of ["x", "Backspace", "Delete", "Tab", "ArrowDown"]) fieldKey(".editor-find-query", k);
    fieldKey(".editor-find-query", "a", { ctrlKey: true });
    await tick();
    expect(allText()).toBe("one two one\nthree one");
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("replace field + replace-all: ONE undo lands back on the original and dirty flips clean", async () => {
    await openFile(FIND2_PATH);
    await loadComplete(FIND2_PATH, "one two one\nthree one\n");
    key("f", { ctrlKey: true });
    await tick();
    await findType(".editor-find-query", "one");
    await findType(".editor-find-replace", "1");
    // Replace-ALL: ONE transaction over every occurrence (the performTx
    // multi-edit seam -- every staged range reverts as one undo step).
    el(".editor-replace-all").click();
    await tick();
    expect(allText()).toBe("1 two 1\nthree 1");
    expect(el(".workbench-dirty")).toBeTruthy();
    expect(el(".file-view-status").textContent).toContain("edited");
    key("z", { ctrlKey: true }); // ONE undo
    await tick();
    expect(allText()).toBe("one two one\nthree one");
    expect(document.querySelector(".workbench-dirty")).toBeNull(); // baseline again -> clean
    expect(el(".file-view-status").textContent).toContain("saved");
    // Replace-ONE swaps ONLY the current match and ADVANCES to the next;
    // it is its own undo step.
    el(".editor-replace-one").click();
    await tick();
    expect(allText()).toBe("1 two one\nthree one");
    expect(findCount()).toBe("1 of 2");
    key("z", { ctrlKey: true });
    await tick();
    expect(allText()).toBe("one two one\nthree one");
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("select-all occurrences -> every caret types (the existing multi-caret machine)", async () => {
    await openFile(FIND3_PATH);
    await loadComplete(FIND3_PATH, "x ax bx");
    key("f", { ctrlKey: true });
    await tick();
    await findType(".editor-find-query", "x");
    expect(findCount()).toBe("1 of 3");
    el(".editor-find-select-all").click();
    await tick();
    // The strip yields: closed, focus back on the editor, THREE ranges.
    expect(document.querySelector(".editor-find")).toBeNull();
    expect(document.activeElement).toBe(el(".editor-input") as unknown as Element);
    key("Q"); // the buffer's own multi-edit typing path
    await tick();
    expect(allText()).toBe("Q aQ bQ");
    expect(el(".workbench-dirty")).toBeTruthy();
  });

  it("alt+Enter in the field selects all occurrences too; Escape keeps the match and hands focus back", async () => {
    await openFile(FIND4_PATH);
    await loadComplete(FIND4_PATH, "x ax bx");
    key("f", { ctrlKey: true });
    await tick();
    await findType(".editor-find-query", "x");
    fieldKey(".editor-find-query", "Enter", { altKey: true }); // alt+Enter: audited free as a chord
    await tick();
    expect(document.querySelector(".editor-find")).toBeNull();
    key("Z");
    await tick();
    expect(allText()).toBe("Z aZ bZ");
    // Escape path (widget open, field focused): close, FOCUS returns to the
    // editor, the current match STAYS selected -- the next keystroke eats it.
    key("f", { ctrlKey: true });
    await tick();
    await findType(".editor-find-query", "aZ"); // one match at (0,2)
    expect(findCount()).toBe("1 of 1");
    fieldKey(".editor-find-query", "Escape");
    await tick();
    expect(document.querySelector(".editor-find")).toBeNull();
    expect(document.activeElement).toBe(el(".editor-input") as unknown as Element);
    key("!");
    await tick();
    expect(allText()).toBe("Z ! bZ"); // the selection ate the keystroke: it survived the close
  });

  it("a bad regex is an honest line in the strip, never a crash; toggles re-scope", async () => {
    await openFile(FIND5_PATH);
    await loadComplete(FIND5_PATH, "cat Cats");
    key("f", { ctrlKey: true });
    await tick();
    await findType(".editor-find-query", "cat");
    expect(findCount()).toBe("1 of 2"); // case-insensitive by default
    el(".editor-find-case").click(); // Match case
    await tick();
    expect(findCount()).toBe("1 of 1");
    expect(el(".editor-find-case").getAttribute("aria-pressed")).toBe("true");
    el(".editor-find-regex").click(); // regex mode
    await findType(".editor-find-query", "(");
    expect(el(".editor-find-error").textContent).toContain("Invalid regular expression");
    expect(document.querySelector(".editor-find-count")).toBeNull();
    expect(allText()).toBe("cat Cats"); // the finder cannot touch the buffer
    // Escape from the textarea ALSO closes the strip (widget open, editor
    // focused) WITHOUT collapsing the match selection.
    fieldKey(".editor-find-query", "Escape");
    await tick();
    key("f", { ctrlKey: true });
    await tick();
    await findType(".editor-find-query", "Cats");
    key("Escape"); // the TEXTAREA gets it: close the strip, keep the match
    await tick();
    expect(document.querySelector(".editor-find")).toBeNull();
    key("_");
    await tick();
    expect(allText()).toBe("cat _");
  });

  it("strip state is PER SESSION: another tab has no strip, coming back restores it", async () => {
    await openFile(FIND7_PATH);
    await loadComplete(FIND7_PATH, "per session\n");
    key("f", { ctrlKey: true });
    await tick();
    await findType(".editor-find-query", "session");
    expect(findCount()).toBe("1 of 1");
    // A SECOND tab (its own session + view): NO strip, nothing global.
    await openFile(FIND6_PATH);
    await loadComplete(FIND6_PATH, "sibling file\n");
    expect(document.querySelector(".editor-find")).toBeNull();
    // Back to the FIRST tab: the strip is open again, query intact, count
    // re-derived against ITS buffer.
    els("#workbench-tabs [role=tab]")[0]!.click();
    await tick();
    expect(el(".editor-find")).toBeTruthy();
    expect((el(".editor-find-query") as unknown as { value: string }).value).toBe("session");
    expect(findCount()).toBe("1 of 1");
    expect(allText()).toBe("per session");
  });

  // ── TASK K keyboard layer (bindings live in editor.tsx; the pure geometry
  // is pinned in editor-buffer.test.ts / editor-multicaret.test.ts). The
  // chords: Alt+Arrow(L/R) word move, Alt+Shift+same extends, Alt+Backspace
  // and Alt+Delete word delete, Ctrl+Shift+D duplicate line, Ctrl+/ comment
  // toggle, Alt+Shift+Enter select-inside-quotes -- the audited table lives
  // in keys-notes.md. Shift+Home/End ride the ALREADY-SHIPPED smart path.

  const KEYS1_PATH = "/rootA/wkeys1.txt";
  const KEYS2_PATH = "/rootA/wkeys2.txt";
  const KEYS3_PATH = "/rootA/wkeys.ts"; // the COMMENT toggle needs a real lang
  const KEYS4_PATH = "/rootA/wkeys.json"; // ... and an honest no-op twin
  const KEYS5_PATH = "/rootA/wkeys5.txt";
  const KEYS6_PATH = "/rootA/wkeys6.txt";
  const caretPos = (): string => el(".editor-goto-btn").textContent ?? "";

  it("alt+arrows walk words, alt+Shift extends, alt+Backspace deletes the word -- undo to the baseline reads CLEAN", async () => {
    await openFile(KEYS1_PATH);
    await loadComplete(KEYS1_PATH, "alpha beta gamma\n");
    expect(caretPos()).toBe("1:1");
    expect(key("ArrowRight", { altKey: true })).toBe(false); // consumed
    await tick();
    expect(caretPos()).toBe("1:6"); // end of "alpha"
    key("ArrowRight", { altKey: true });
    await tick();
    expect(caretPos()).toBe("1:11"); // the gap is CROSSED (VS Code does not stop in it)
    key("ArrowRight", { altKey: true, shiftKey: true });
    await tick();
    expect(caretPos()).toBe("1:17"); // extends to EOL over "gamma"
    expect(els(".editor-sel").length).toBe(1); // the theme's own selection layer
    expect(document.querySelector(".workbench-dirty")).toBeNull(); // caret moves never dirty
    key("Backspace", { altKey: true }); // the selection goes first (plain-delete doctrine)
    await tick();
    expect(allText()).toBe("alpha beta"); // "gamma" ate (the rendered gap space is inert)
    expect(caretPos()).toBe("1:11"); // the caret lands where the selection began
    key("z", { ctrlKey: true }); // ONE undo lands back on the baseline bytes
    await tick();
    expect(allText()).toBe("alpha beta gamma");
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    expect(el(".file-view-status").textContent).toContain("saved");
    // alt+Delete forward from the doc start eats the word, its own step.
    key("Home");
    await tick();
    key("Delete", { altKey: true });
    await tick();
    expect(allText()).toBe(" beta gamma");
    key("z", { ctrlKey: true });
    await tick();
    expect(allText()).toBe("alpha beta gamma");
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("Shift+Home / Shift+End select to the line start/end (smart-Home stops ride; already shipped, now pinned)", async () => {
    await openFile(KEYS2_PATH);
    await loadComplete(KEYS2_PATH, "    x = 1\n");
    key("End");
    await tick();
    expect(caretPos()).toBe("1:10");
    key("Home", { shiftKey: true });
    await tick();
    expect(caretPos()).toBe("1:5"); // press 1: first non-whitespace
    expect(els(".editor-sel").length).toBe(1);
    key("Home", { shiftKey: true });
    await tick();
    expect(caretPos()).toBe("1:1"); // press 2: column 0 (full-line select)
    key("End", { shiftKey: true });
    await tick();
    expect(caretPos()).toBe("1:10"); // Shift+End: out to the line end
    expect(document.querySelector(".workbench-dirty")).toBeNull(); // selections never dirty
  });

  it("Ctrl+/ toggles the file lang's line comment (ONE undo, clean); json is an honest no-op", async () => {
    await openFile(KEYS3_PATH); // .ts -> typescript: the "//" family
    await loadComplete(KEYS3_PATH, "foo()\nbar()\n");
    key("ArrowDown"); // caret lands on line 2 -> that line is the block
    await tick();
    expect(key("/", { ctrlKey: true })).toBe(false); // consumed even where the browser has a default
    await tick();
    expect(allText()).toBe("foo()\n// bar()"); // the token rides AFTER the indent, one space
    expect(el(".workbench-dirty")).toBeTruthy();
    key("z", { ctrlKey: true }); // ONE step reverts the whole toggle
    await tick();
    expect(allText()).toBe("foo()\nbar()");
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    expect(el(".file-view-status").textContent).toContain("saved");
    // json has NO line comment: the honest no-op (no invented block comment).
    await openFile(KEYS4_PATH);
    await loadComplete(KEYS4_PATH, '{"a": 1}\n');
    key("/", { ctrlKey: true });
    await tick();
    expect(allText()).toBe('{"a": 1}');
    expect(document.querySelector(".workbench-dirty")).toBeNull();
  });

  it("Ctrl+Shift+D duplicates the caret's line onto the copy; Alt+Shift+Down still ADDS carets (audited coexistence)", async () => {
    await openFile(KEYS5_PATH);
    await loadComplete(KEYS5_PATH, "one\ntwo\n");
    key("ArrowDown");
    await tick();
    key("d", { ctrlKey: true, shiftKey: true });
    await tick();
    expect(allText()).toBe("one\ntwo\ntwo");
    expect(caretPos()).toBe("3:1"); // the caret rides the COPY
    expect(el(".workbench-dirty")).toBeTruthy();
    key("z", { ctrlKey: true }); // ONE undo reverts the copy
    await tick();
    expect(allText()).toBe("one\ntwo");
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    // The chord that already lived here keeps its meaning: add-caret-below.
    key("ArrowUp", { altKey: true, shiftKey: true });
    await tick();
    key("!");
    await tick();
    expect(allText()).toBe("!one\n!two");
  });

  it("alt+Shift+Enter selects inside the quotes (escape-aware); typing replaces; unpaired is a no-op", async () => {
    await openFile(KEYS6_PATH);
    await loadComplete(KEYS6_PATH, 'say "hello \\"big\\" there"\nnot paired here\n');
    el(".editor-goto-btn").click();
    await tick();
    await gotoType("1:12"); // mid-string, past the first escaped quote
    key("Enter", { altKey: true, shiftKey: true });
    await tick();
    expect(els(".editor-sel").length).toBe(1); // the CONTENT of the pair (quotes excluded)
    key("Q"); // the selection eats the keystroke: the pair content is replaced
    await tick();
    expect(allText()).toBe('say "Q"\nnot paired here');
    // Line 2 holds no closed pair: an honest no-op -- the next keystroke
    // INSERTS (a live selection would have replaced instead).
    key("ArrowDown");
    await tick();
    key("Enter", { altKey: true, shiftKey: true });
    await tick();
    key("!");
    await tick();
    expect(allText()).toBe('say "Q"\nnot pa!ired here');
  });

  // ── HOT EXIT (real app wiring; the store units: editor-stash.test.ts) ────
  // The stash store is app.tsx's module singleton, and its tab-instance id
  // was minted against the persistence section's long-gone Map -- so the
  // FIRST dirty cycle here discovers the live record key by landing a real
  // write, and every scenario below derives from what the store itself
  // wrote (never a guessed key).

  const STASH_PATH = "/rootA/wstash.txt";
  const STASH2_PATH = "/rootA/wstash2.txt";
  const STASH3_PATH = "/rootA/wstash3.txt";
  const STASH4_PATH = "/rootA/wstash4.txt";
  const STASH5_PATH = "/rootA/wstash5.txt";
  const stashSession = new Map<string, string>();
  let stashKey = ""; // "hotdog.editorStash.<tab id>" after the first write lands
  beforeAll(() => {
    (window as unknown as Record<string, unknown>).sessionStorage = {
      getItem: (k: string) => stashSession.get(k) ?? null,
      setItem: (k: string, v: string) => void stashSession.set(k, String(v)),
      removeItem: (k: string) => void stashSession.delete(k),
    };
  });
  afterAll(() => {
    delete (window as unknown as Record<string, unknown>).sessionStorage;
  });
  type StashEntries = Record<string, { text: string; baseMtimeMs: number; stashedAt: number }>;
  const stashRecord = (): StashEntries =>
    JSON.parse(stashKey === "" ? "{}" : stashSession.get(stashKey) ?? "{}") as StashEntries;
  /** Simulate what the PREVIOUS page's leave-flush left behind. */
  const plantStash = (rec: StashEntries): void => {
    stashSession.set(stashKey, JSON.stringify(rec));
  };
  /** One dirty cycle through the leave flush (pinning the debounce: nothing
   *  lands while the window is young) to discover the store's live key. */
  async function discoverStashKey(): Promise<void> {
    if (stashKey !== "") return;
    await openFile(STASH_PATH);
    await loadComplete(STASH_PATH, "disk one\n");
    key("x");
    await tick();
    // Nothing reaches storage mid-debounce, and the leave flush lands ONE
    // write of the final text through the joinContent serialization.
    expect([...stashSession.keys()].filter((k) => k.startsWith(STASH_KEY_PREFIX))).toEqual([]);
    expect(fireEditorLeave()).toBe(true); // dirty: the courtesy veto still fires
    const keys = [...stashSession.keys()].filter((k) => k.startsWith(STASH_KEY_PREFIX) && k !== STASH_TAB_ID_KEY);
    expect(keys).toHaveLength(1);
    stashKey = keys[0]!;
    expect(stashRecord()[STASH_PATH]?.text).toBe("xdisk one\n");
  }

  it("hot exit: save success clears the record; re-dirtying re-stashes on the NEW base; closing kills it", async () => {
    await discoverStashKey();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number; path: string; content: string; baseMtimeMs: number }>("saveFile").pop()!;
    expect(save.content).toBe("xdisk one\n");
    ws.fireMessage({ type: "fileOpResult", requestId: save.requestId, path: STASH_PATH, mtimeMs: 2000 });
    await tick();
    // The clean session took the record with it (no stale stash survives a
    // save -- the next reload opens plain disk text).
    expect(stashRecord()[STASH_PATH]).toBeUndefined();
    // Dirty again: the leave-flush re-stashes against the save's new base
    // (the caret sits after "x", so "!" lands mid-word -- the exact bytes
    // are the point, not the shape).
    key("!");
    await tick();
    expect(fireEditorLeave()).toBe(true);
    const re = stashRecord()[STASH_PATH];
    expect(re?.text).toBe("x!disk one\n");
    expect(re?.baseMtimeMs).toBe(2000);
    expect(typeof re?.stashedAt).toBe("number");
    // Closing the tab (discard confirmed, as a user would) drops the record:
    // a closed buffer's "restore" must not resurrect work already discarded.
    els(".workbench-tab-close")[0]!.click();
    await tick();
    expect(stashRecord()[STASH_PATH]).toBeUndefined();
  });

  /** The dirty dot of ONE tab (the strip keeps dots for every open tab). */
  const tabDirty = (label: string): Element | null =>
    els("#workbench-tabs [role=tab]")
      .find((t) => (t.textContent ?? "").includes(label))
      ?.querySelector(".workbench-dirty") ?? null;

  it("hot exit: a same-mtime record restores dirty with an honest note; another tab's record is invisible", async () => {
    await discoverStashKey();
    plantStash({ [STASH2_PATH]: { text: "preserved work\n", baseMtimeMs: 1000, stashedAt: 111 } });
    // The same path under ANOTHER browser tab's key must stay invisible.
    stashSession.set(
      STASH_KEY_PREFIX + "other-tab",
      JSON.stringify({ [STASH3_PATH]: { text: "not yours\n", baseMtimeMs: 1000, stashedAt: 111 } }),
    );
    await openFile(STASH2_PATH);
    await loadComplete(STASH2_PATH, "disk bytes\n", 1000);
    // The DISK read happened (the pipeline ran), the stash overlaid it:
    // preserved bytes, dirty derived against the disk baseline, note shown.
    expect(allText()).toBe("preserved work");
    expect(tabDirty("wstash2.txt")).toBeTruthy();
    expect(el(".file-view-status").textContent).toContain("edited");
    expect(el("#copy-toast").textContent).toContain("restored unsaved edits");
    // Same path, another tab's stash: the plain clean disk read.
    await openFile(STASH3_PATH);
    await loadComplete(STASH3_PATH, "clean disk\n", 1000);
    expect(allText()).toBe("clean disk");
    expect(tabDirty("wstash3.txt")).toBeNull();
    expect(el(".file-view-status").textContent).toContain("saved");
    // Restored buffers keep their stash honest: the leave-flush re-lands the
    // same text on the same base (a reload cycle stays stable).
    expect(fireEditorLeave()).toBe(true);
    const re = stashRecord()[STASH2_PATH];
    expect(re?.text).toBe("preserved work\n");
    expect(re?.baseMtimeMs).toBe(1000);
  });

  it("hot exit: mtime drift offers the pair -- Cancel keeps disk clean, OK opens preserved on the OLD base", async () => {
    await discoverStashKey();
    // Cancel's door: disk stays clean and the offer is CONSUMED (a stale
    // re-offer on every reload is the bug this pin kills).
    plantStash({ [STASH4_PATH]: { text: "preserved work\n", baseMtimeMs: 999, stashedAt: 111 } });
    confirmSeen.length = 0;
    confirmAnswer = false;
    await openFile(STASH4_PATH);
    await loadComplete(STASH4_PATH, "agent bytes\n", 1000);
    expect(allText()).toBe("agent bytes"); // never auto-overlaid
    expect(document.querySelector(".workbench-dirty")).toBeNull();
    expect(el(".file-view-status").textContent).toContain("saved");
    expect(confirmSeen.some((m) => m.includes("preserved") && m.includes("changed on disk"))).toBe(true);
    expect(stashRecord()[STASH4_PATH]).toBeUndefined();
    // OK's door: the preserved text opens dirty ON THE STASH'S OLD BASE, so
    // its first save rides the normal conflict refusal (base != disk mtime).
    plantStash({ [STASH5_PATH]: { text: "preserved work\n", baseMtimeMs: 999, stashedAt: 111 } });
    confirmAnswer = true;
    await openFile(STASH5_PATH);
    await loadComplete(STASH5_PATH, "agent bytes\n", 1000);
    expect(allText()).toBe("preserved work");
    expect(document.querySelector(".workbench-dirty")).toBeTruthy();
    key("s", { ctrlKey: true });
    await tick();
    const save = sent<{ requestId: number; baseMtimeMs: number }>("saveFile").pop()!;
    expect(save.baseMtimeMs).toBe(999); // the refusal is the save gate's existing job
  });

  it("hot exit: a quota-full write marks the foot bar ONCE and blocks nothing", async () => {
    await discoverStashKey();
    await openFile("/rootA/wstashq.txt");
    await loadComplete("/rootA/wstashq.txt", "keep typing\n");
    const realSet = stashSession.set.bind(stashSession);
    stashSession.set = (() => {
      throw new Error("QuotaExceeded: the tab is full");
    }) as typeof stashSession.set;
    try {
      key("q");
      await tick();
      fireEditorLeave(); // the flush hits the wall...
      await tick();
      expect(el("#copy-toast").textContent).toContain("Storage full");
      expect(el(".file-view-status").textContent).toContain("stash off");
      // ...and NOTHING else notices: editing continues.
      key("!");
      await tick();
      expect(allText()).toBe("q!keep typing");
      expect(el(".file-view-status").textContent).toContain("stash off");
    } finally {
      stashSession.set = realSet;
    }
  });
});

// Live region: the terminal matrix and the teardown. This describe runs LAST
// before the auth lifecycle -- its final test logs the app out, and the auth
// section begins by firing authError anyway.

describe("a11y: aria-live terminals and teardown", () => {
  it("the live region is a polite status role and mirrors the attached run", async () => {
    await attach();
    const region = el("#live-status");
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-live")).toBe("polite");
    expect(region.classList.contains("visually-hidden")).toBe(true);
    // Baseline the attached session to idle, then run a full turn.
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: false });
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();
    expect(el("#live-status").textContent).toBe("Working");
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: false });
    await tick();
    expect(el("#live-status").textContent).toBe("Reply complete");
  });

  it("other sessions' working flips never announce", async () => {
    await attach();
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();
    expect(el("#live-status").textContent).toBe("Working");
    ws.fireMessage({ type: "sessionState", sessionId: "s-noise-1", key: "working", value: true });
    ws.fireMessage({ type: "sessionState", sessionId: "s-noise-1", key: "working", value: false });
    await tick();
    expect(el("#live-status").textContent).toBe("Working"); // a side session says nothing here
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: false });
    await tick();
    expect(el("#live-status").textContent).toBe("Reply complete");
  });

  it("a provider error announces Run failed; idle errors poison nothing", async () => {
    await attach();
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();
    expect(el("#live-status").textContent).toBe("Working");
    // The doctrine (message-list handleError): an errored turn is neither
    // completed nor stopped -- the region must not claim a completion.
    ws.fireMessage({ type: "error", message: "provider exploded" });
    await tick();
    expect(el("#live-status").textContent).toBe("Run failed");
    // A stray error frame with no run in flight announces nothing and must
    // not label the NEXT completion as failed.
    ws.fireMessage({ type: "error", message: "stray command error" });
    await tick();
    expect(el("#live-status").textContent).toBe("Run failed"); // unchanged
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: false });
    await tick();
    expect(el("#live-status").textContent).toBe("Reply complete"); // honest again
  });

  it("a local Stop announces Work stopped, not a completion", async () => {
    await attach();
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();
    expect(el("#live-status").textContent).toBe("Working");
    clearSent();
    el("#cancel-btn").click();
    await tick();
    expect(sent("cancel")).toHaveLength(1);
    expect(el("#live-status").textContent).toBe("Work stopped");
  });

  it("a socket drop mid-run announces Connection lost", async () => {
    await attach();
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();
    expect(el("#live-status").textContent).toBe("Working");
    // The double's plain onclose handler property -- exactly what a real
    // dropped connection fires (chat then flips working with connected=false).
    ws.onclose?.();
    await tick();
    expect(el("#live-status").textContent).toBe("Connection lost");
    // The indicator left the header: it renders ONLY now, inside
    // #composer-actions immediately LEFT of the Stop/Send cluster (the
    // non-focusable span is a DOM-order sibling, never a tab stop).
    const indicator = el("#connection-status");
    expect(indicator.textContent).toBe("Disconnected");
    expect(indicator.getAttribute("class")).toContain("status-disconnected");
    const ids = Array.from(el("#composer-actions").children).map((c) => c.getAttribute("id"));
    const at = ids.indexOf("connection-status");
    expect(at).toBeGreaterThanOrEqual(0);
    // The drop itself flipped working(false) (chat's connected=false path),
    // so Stop is already gone; the indicator's next sibling is Send --
    // immediately LEFT of the Stop/Send cluster either way.
    expect(ids[at + 1]).toBe("send-btn");
  });

  it("logout unsubscribes the announce effect: teardown flips never announce", async () => {
    await attach();
    ws.fireMessage({ type: "sessionState", sessionId: SID, key: "working", value: true });
    await tick();
    expect(el("#live-status").textContent).toBe("Working");
    // handleAuthFailure stops the chat effects BEFORE chat.disconnect(): a
    // leaked announce effect would fire on that working(false) and announce
    // ("Connection lost") mid-teardown, on a screen the user is leaving.
    // The boot socket's handlers stay attached to the instance, so the
    // leaked mutant is observable here exactly.
    ws.fireMessage({ type: "authError", message: "revoked" });
    await tick();
    expect(el("#main-ui").getAttribute("class")).toContain("hidden"); // logged out
    expect(el("#live-status").textContent).toBe("Working"); // nothing announced on the way down
  });
});

// ── Auth lifecycle: socket authError teardown, login form, Ctrl+Shift+L ─────
// Runs last: the teardown drops the chat and the login screen takes the stage
// back; the successful re-login opens a NEW FakeWebSocket, so the suites above
// must already have finished with the boot socket.

describe("auth lifecycle", () => {
  const loginHidden = () => el("#login-screen").getAttribute("class")?.includes("hidden") ?? false;
  function fillLogin(key: string): void {
    const input = el("#api-key-input");
    (input as unknown as { value: string }).value = key;
    el("#login-form").dispatchEvent(new Event("submit"));
  }

  it("socket authError tears the chat down: token cleared, login re-shown, transcript emptied", async () => {
    ws.fireMessage({ type: "authError", message: "token revoked" });
    await tick();
    expect(store.has("hotdog-webui-token")).toBe(false);
    expect(loginHidden()).toBe(false);
    expect(el("#message-list").textContent).not.toContain("cold line");
  });

  it("failed login keeps the screen up with the server's error text", async () => {
    loginReply = { status: 401, ok: false, json: async () => ({ error: "nope" }) };
    fillLogin("bad-key");
    await tick();
    expect(el(".error-message").textContent).toBe("nope");
    expect(loginHidden()).toBe(false);
  });

  it("successful login persists the token, swaps screens, and re-wires the socket", async () => {
    loginReply = { status: 200, ok: true, json: async () => ({ token: "fresh-tok" }) };
    fillLogin(" good-key ");
    await tick();
    expect(fetchLog.at(-1)?.url).toBe("/login");
    expect(JSON.parse(String(fetchLog.at(-1)!.init?.body))).toEqual({ apiKey: "good-key" });
    expect(store.get("hotdog-webui-token")).toBe("fresh-tok");
    expect(loginHidden()).toBe(true);

    const fresh = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    expect(fresh).not.toBe(ws);
    fresh.fireOpen();
    expect(JSON.parse(fresh.sent[0]!).token).toBe("fresh-tok");
    fresh.fireMessage({ type: "authOk" });
    fresh.fireMessage({
      type: "sessionCreated", sessionId: "s-after-auth", profile: "manager",
      title: null, currentModel: "m1", models: ["m1"],
    });
    await tick();
    // Re-connected through a fresh socket: still zero indicator DOM (the
    // composer never saw it come or go -- the buttons own the auto margin).
    expect(document.querySelector("#connection-status")).toBeNull();

    // Ctrl+Shift+L logs out through the same teardown.
    document.dispatchEvent({ type: "keydown", ctrlKey: true, shiftKey: true, key: "L", preventDefault: () => {} } as unknown as Event);
    await tick();
    expect(loginHidden()).toBe(false);
    expect(store.has("hotdog-webui-token")).toBe(false);
    // Idempotent: a second logout (lower-case key) changes nothing.
    document.dispatchEvent({ type: "keydown", ctrlKey: true, shiftKey: true, key: "l", preventDefault: () => {} } as unknown as Event);
    await tick();
    expect(loginHidden()).toBe(false);
  });
});

// ── Composer caret restore seam: the no-steal matrix ────────────────────────
// The boot pin above drove the mount-time hydrate end-to-end (seeded text +
// caret record landed; the CLEARED marker took the selection but no focus).
// main-ui is only class-hidden, so there is no in-file remount route -- the
// matrix runs the SAME exported seam the mount ref calls
// (seedWorkbenchStoreFromStorage precedent: the test calls the exact routine).

describe("composer caret restore seam (no-steal matrix)", () => {
  const restoreComposerCaret = appModule.restoreComposerCaret as (
    el: HTMLElement,
    caret: { start: number; end: number; focused: boolean },
  ) => void;
  const composer = () =>
    el("#chat-input") as unknown as {
      value: string;
      selectionStart: number | null;
      selectionEnd: number | null;
    };
  const active = () => document.activeElement as unknown as HTMLElement | null;
  const unfocus = () => {
    (active() as { blur?: () => void } | null)?.blur?.();
  };

  it("marker set + nobody owns focus: selection AND focus land", () => {
    unfocus();
    composer().value = "focus me please";
    restoreComposerCaret(el("#chat-input"), { start: 2, end: 6, focused: true });
    expect(composer().selectionStart).toBe(2);
    expect(composer().selectionEnd).toBe(6);
    expect(active()).toBe(el("#chat-input"));
  });

  it("marker clear: the selection lands, focus stays put", () => {
    unfocus();
    composer().value = "selection only";
    restoreComposerCaret(el("#chat-input"), { start: 4, end: 4, focused: false });
    expect(composer().selectionStart).toBe(4);
    expect(active()).not.toBe(el("#chat-input"));
  });

  it("no steal: an element holding focus keeps it, marker or not", () => {
    unfocus();
    composer().value = "stay away";
    el("#search-btn").focus();
    restoreComposerCaret(el("#chat-input"), { start: 1, end: 1, focused: true });
    expect(composer().selectionStart).toBe(1); // the selection still lands
    expect(active()).toBe(el("#search-btn"));
  });

  it("no steal while the SEARCH panel owns focus (openSearch focuses deliberately)", async () => {
    unfocus();
    composer().value = "search guard";
    el("#search-btn").click();
    await tick();
    expect(active()).toBe(el("#search-input")); // the a11y batch's own handoff
    restoreComposerCaret(el("#chat-input"), { start: 3, end: 3, focused: true });
    expect(composer().selectionStart).toBe(3);
    expect(active()).toBe(el("#search-input"));
    key(el("#search-input"), "Escape");
    await tick();
    expect(document.querySelector("#search-panel")).toBeNull();
  });

  it("no steal while the SETTINGS dialog owns focus (openSettings focuses deliberately)", async () => {
    unfocus();
    composer().value = "settings guard";
    el("#settings-btn").click();
    await tick();
    expect(active()).toBe(el("#settings-view"));
    restoreComposerCaret(el("#chat-input"), { start: 3, end: 3, focused: true });
    expect(composer().selectionStart).toBe(3);
    expect(active()).toBe(el("#settings-view"));
    key(el("#settings-view"), "Escape");
    await tick();
    expect(document.querySelector("#settings-view")).toBeNull();
    unfocus();
  });

  it("a caret past the text clamps into the value (record vs. drifted draft)", () => {
    unfocus();
    composer().value = "short";
    restoreComposerCaret(el("#chat-input"), { start: 40, end: 50, focused: false });
    expect(composer().selectionStart).toBe(5);
    expect(composer().selectionEnd).toBe(5);
  });

  it("a reversed record clamps to a sane range (e < s can never happen live)", () => {
    unfocus();
    composer().value = "abcdef";
    restoreComposerCaret(el("#chat-input"), { start: 4, end: 2, focused: false });
    expect(composer().selectionStart).toBe(4);
    expect(composer().selectionEnd).toBe(4);
  });
});
