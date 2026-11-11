/// <reference lib="dom" />
// THE app-wiring suite: app.tsx mounted on the dom-helper DOM with a
// FakeWebSocket standing in for the server. Covers the interactive surface
// (composer send/draft, tab completion, attachments, push-to-talk, selects,
// sidebar glue: create/switch/cancel/resize, context menus, the subagent
// strip and task panels, log-view header controls) plus the auth lifecycle
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
import { FakeWebSocket, SVG_NS } from "./index.ts";
import { DRAFT_STORAGE_KEY } from "@extensions/webui/ui/draft.ts";
import { ATTACHMENTS_STORAGE_KEY } from "@extensions/webui/ui/attachment-store.ts";
import { HIDE_THINKING_STORAGE_KEY } from "@extensions/webui/ui/thinking-pref.ts";
import { workbenchStore } from "@extensions/webui/ui/workbench.tsx";

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

const store = new Map<string, string>([
  ["hotdog-webui-token", "tok"],
  // The composer mounts with this draft restored (ref contract).
  [DRAFT_STORAGE_KEY, "restored draft"],
  // ...and with one attachment staged by the previous page load.
  [
    ATTACHMENTS_STORAGE_KEY,
    JSON.stringify([{ name: "kept.png", mimeType: "image/png", size: 4, data: "QUJDRA==" }]),
  ],
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
await import("@extensions/webui/ui/app.tsx");
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

  it("auto-login opens main-ui with the composer draft restored", () => {
    expect(el("#main-ui").getAttribute("class")).not.toContain("hidden");
    expect(el("#login-screen").getAttribute("class")).toContain("hidden");
    expect(el("#connection-status").textContent).toBe("Connected");
    // chatInputRef brought the stored draft back and autoResized.
    expect((el("#chat-input") as unknown as { value: string }).value).toBe("restored draft");
    expect(el("#steer-checkbox").hasAttribute("checked")).toBe(true);
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
    expect(el("#profile-select").querySelectorAll("option")).toHaveLength(2);
    expect((el("#profile-select") as unknown as { value: string }).value).toBe("manager");
    expect(el("#model-select").querySelectorAll("option")).toHaveLength(2);
    expect((el("#model-select") as unknown as { value: string }).value).toBe("m1");
    expect(els(".session-item")).toHaveLength(1);
    expect(els(".log-item")).toHaveLength(1);
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
    expect(msg?.content).toBe("restored draft");
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
    expect(el("#mic-btn").textContent).toBe("Mic");
  });

  it("empty recording: back to idle with no transcribe", async () => {
    stubMic({ chunkSize: 0 });
    mousedownMic();
    await tick(2);
    expect(el("#mic-btn").textContent).toBe("● Recording");
    release();
    await tick(3);
    expect(el("#mic-btn").textContent).toBe("Mic");
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
    expect(el("#mic-btn").textContent).toBe("Mic");
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
    expect(el("#mic-btn").textContent).toBe("Mic");
  });
});

// ── Selects & steer ─────────────────────────────────────────────────────────

describe("profile / model / steer controls", () => {
  it("profile change switches the attached session's profile", async () => {
    await attach();
    const select = el("#profile-select");
    (select as unknown as { value: string }).value = "coder";
    select.dispatchEvent({ type: "change", currentTarget: select } as unknown as Event);
    await tick();
    const [msg] = sent<{ profileName: string }>("switchProfile");
    expect(msg?.profileName).toBe("coder");
  });

  it("model change rides the slash command; empty selection is inert", async () => {
    const select = el("#model-select");
    (select as unknown as { value: string }).value = "m2";
    select.dispatchEvent({ type: "change", currentTarget: select } as unknown as Event);
    await tick();
    expect(sent<{ command: string }>("command").at(-1)?.command).toBe("/model m2");
    clearSent();
    (select as unknown as { value: string }).value = "";
    select.dispatchEvent({ type: "change", currentTarget: select } as unknown as Event);
    expect(sent("command")).toHaveLength(0);
  });

  it("the steer checkbox flips future sends", async () => {
    const box = el("#steer-checkbox");
    (box as unknown as { checked: boolean }).checked = false;
    box.dispatchEvent({ type: "change", target: box } as unknown as Event);
    await tick();
    setComposer("queued please");
    clearSent();
    await submitComposer();
    expect(sent<{ steering?: boolean }>("send")[0]?.steering).toBeUndefined(); // steer off: field omitted
    (box as unknown as { checked: boolean }).checked = true;
    box.dispatchEvent({ type: "change", target: box } as unknown as Event);
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
    expect(ariaNow()).toBe("520");
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

// ── Subagents strip + panels ────────────────────────────────────────────────

describe("subagents strip and task panels", () => {
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
    ...over,
  });

  async function openPanel(): Promise<void> {
    ws.fireMessage({ type: "taskList", tasks: [task()] });
    await tick();
    els(".subagent-chip")[0]!.click();
    await tick();
  }

  it("chips scope to the attached session; null-parent tasks never show", async () => {
    await attach();
    ws.fireMessage({
      type: "taskList",
      tasks: [task(), task({ taskId: "task-2", sessionId: "other-session" }), task({ taskId: "task-3", sessionId: null })],
    });
    await tick();
    expect(els(".subagent-chip")).toHaveLength(1);
    // chipLabel falls back to the description words when the id has no ":".
    expect(els(".subagent-chip")[0]!.textContent).toContain("do the thing");
  });

  it("opening fetches buffered activity and renders the panel", async () => {
    await openPanel();
    expect(sent<{ taskId: string }>("taskActivityRequest")[0]?.taskId).toBe("task-1");
    const panel = el(".task-overlay");
    expect(panel.getAttribute("data-task-id")).toBe("task-1");
    expect(el(".task-overlay-desc").textContent).toBe("do the thing");

    ws.fireMessage({
      type: "taskActivityHistory",
      taskId: "task-1",
      activity: [
        { kind: "text", content: "thinking out loud" },
        { kind: "tool_call", name: "bash", args: "{\"cmd\":\"ls\"}" },
        { kind: "tool_result", name: "bash", output: "file.txt", error: undefined },
      ],
    });
    await sleep(40); // activity views flush on the rAF-style coalescer
    expect(el(".task-overlay-body").textContent).toContain("thinking out loud");
    expect(el(".task-overlay-body").textContent).toContain("tool: bash");
  });

  it("re-opening the same task does not stack a second panel", async () => {
    els(".subagent-chip")[0]!.click();
    await tick();
    expect(els(".task-overlay")).toHaveLength(1);
  });

  it("followup steering ships and clears the input", async () => {
    const field = el(".task-followup-input");
    (field as unknown as { value: string }).value = " steer text ";
    el(".task-followup-form").dispatchEvent(new Event("submit"));
    await tick();
    const [msg] = sent<{ taskId: string; message: string }>("taskFollowup");
    expect(msg).toMatchObject({ taskId: "task-1", message: "steer text" });
    expect((el(".task-followup-input") as unknown as { value: string }).value).toBe("");
    clearSent();
    el(".task-followup-form").dispatchEvent(new Event("submit")); // blank -> nothing
    expect(sent("taskFollowup")).toHaveLength(0);
  });

  it("a control reply shows in the panel note", async () => {
    ws.fireMessage({ type: "taskControl", taskId: "task-1", action: "steer", ok: true });
    await tick();
    expect(el(".task-control-note").textContent).toBe("Steering sent");
    ws.fireMessage({ type: "taskControl", taskId: "task-1", action: "steer", ok: false, error: "no seam" });
    await tick();
    expect(el(".task-control-note").textContent).toBe("no seam");
  });

  it("live tasks drive the elapsed tick; the last one ending stops it", async () => {
    const before = el(".task-overlay-elapsed").textContent;
    await sleep(1100); // the once-per-second nowAtom tick while a task is live
    expect(el(".task-overlay-elapsed").textContent).not.toBe(before);

    confirmSeen = [];
    clearSent();
    confirmAnswer = false;
    el(".task-overlay-cancel").click(); // confirm declined -> nothing sent
    expect(sent("taskInterrupt")).toHaveLength(0);
    confirmAnswer = true;
    el(".task-overlay-cancel").click();
    expect(sent<{ taskId: string }>("taskInterrupt")[0]?.taskId).toBe("task-1");
    expect(confirmSeen.join()).toContain("Cancel task task-1");

    // Settle the task: the tick timer stops and the followup form disables.
    ws.fireMessage({ type: "taskUpdate", task: task({ status: "done", endedAt: Date.now(), inRun: false }) });
    await tick();
    expect(el(".task-followup-input").hasAttribute("disabled")).toBe(true);
    const after = el(".task-overlay-elapsed").textContent;
    await sleep(1100);
    expect(el(".task-overlay-elapsed").textContent).toBe(after); // no more ticking
  });

  it("the close button dismisses the panel", async () => {
    el(".task-overlay-close").click();
    await tick();
    expect(document.querySelector(".task-overlay")).toBeNull();
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
  });

  it("overflow past the strip cap gets a +N chip that expands and collapses", async () => {
    const many = Array.from({ length: 9 }, (_, i) => task({ taskId: `t${i}`, sessionId: SID, status: "done", inRun: false }));
    ws.fireMessage({ type: "taskList", tasks: many });
    await tick();
    const more = el(".subagent-more");
    expect(more.textContent).toBe("+1");
    more.click();
    await tick();
    expect(el("#subagents-strip").classList.contains("expanded")).toBe(true);
    expect(els(".subagent-chip")).toHaveLength(10); // 9 tasks + collapse chip
    el(".subagent-more").click();
    await tick();
    expect(el("#subagents-strip").classList.contains("expanded")).toBe(false);
    ws.fireMessage({ type: "taskList", tasks: [] });
    await tick();
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

// ── Log-view round trip, working Cancel, fence matrix ───────────────────────
// Merged from the standalone log-view suite so app.tsx has exactly ONE booting
// test file: bun attributes the module's coverage per source file under the
// serial `bun test --coverage` run, and a second import-time booter would both
// fight for that attribution and inherit this file's browser stubs.

const LV_SID = "s-live-0001";
const LV_L1 = "l-log-0001";
const LV_L2 = "l-log-0002";

const lvLogRow = (id: string) => ({ id, createdAt: 1, lastActivityAt: 2, messageCount: 5 });
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
    expect(strip.textContent).toContain("worker (fence: bwrap)");
    expect(strip.getAttribute("class")).toContain("toggleable");
    // Button chrome lives in the class, not an inline style attribute.
    expect(strip.getAttribute("style")).toBeNull();
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
    expect(el("#tool-exec-status").textContent).toContain("fence: off");
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
    // The strip still carries OUR last server-pushed posture.
    expect(el("#tool-exec-status").textContent).toContain("fence: off");
    expect(el("#tool-exec-status").textContent).not.toContain("seatbelt");
  });

  it("inline posture: inert strip, no class, no click effect", async () => {
    stubConfirm(true);
    await attachWithPosture("inline (unfenced)");
    const strip = el("#tool-exec-status");
    expect(strip.getAttribute("class") ?? "").not.toContain("toggleable");
    expect(strip.getAttribute("style")).toBeNull();
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
});

// ── Client plug on live cards (bottom-right, from the sessions payload) ─────
// The count renders as the card's trailing plug icon (see sessions.test.tsx
// for the row grammar); through real app wiring that means every live row's
// figure comes straight from the payload's connectedClients. Render rules:
// 0/unattested renders nothing; 1 is icon-only (the plug lives in the CSS
// mask, so textContent stays empty); 2+ appends the number; native title is
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
    expect(chip.textContent).toBe("reasoning shown");
    expect(chip.getAttribute("title")).toContain("view setting only");
    expect(chip.getAttribute("title")).toContain("/thinking");
    const group = els(".header-status-group");
    expect(group).toHaveLength(1);
    expect(group[0]!.children[0]!.getAttribute("id")).toBe("thinking-toggle");
    expect(group[0]!.children[1]!.getAttribute("id")).toBe("tool-exec-status");
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
    expect(el("#thinking-toggle").textContent).toBe("reasoning hidden");
    expect(store.get(HIDE_THINKING_STORAGE_KEY)).toBe("1");

    el("#thinking-toggle").click();
    await tick();
    expect(hiddenFlags()).toEqual([false, false]);
    expect(el("#thinking-toggle").textContent).toBe("reasoning shown");
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
    expect(el("#thinking-toggle").textContent).toBe("reasoning shown");
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
    expect(el("#thinking-toggle").textContent).toBe("reasoning hidden");

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
    expect(store.get("hotdog.workbenchCollapsed")).toBe("0");
    const h = wbHandle();
    expect(h.getAttribute("role")).toBe("separator");
    expect(h.getAttribute("aria-orientation")).toBe("vertical");
    // Stubbed viewport 1200: max = max(320, min(900, 1200 - 300 - 480)) = 420.
    expect(h.getAttribute("aria-valuenow")).toBe("420");
    expect(h.getAttribute("aria-valuemin")).toBe("320");
    expect(h.getAttribute("aria-valuemax")).toBe("420");
  });

  it("dragging RIGHT shrinks (nearEdge) and release writes hotdog.workbenchWidth", () => {
    wbPointer("pointerdown", { pointerId: 1, clientX: 900 });
    wbPointer("pointermove", { pointerId: 1, clientX: 960 });
    const docStyle = (document.documentElement as unknown as { style: { getPropertyValue: (n: string) => string } }).style;
    expect(docStyle.getPropertyValue("--workbench-width")).toBe("360px");
    wbPointer("pointerup", { pointerId: 1, clientX: 960 });
    expect(store.get("hotdog.workbenchWidth")).toBe("360");
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
    const refresh = els(".settings-btn").find((b) => b.textContent === "Refresh")!;
    refresh.click();
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
    els(".settings-btn").find((b) => b.textContent === "Refresh")!.click();
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
    const refreshBtn = els(".settings-btn").find((b) => b.textContent === "Refresh")!;
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
    // Mid-flight the affordances are busy-disabled (the dom-helper still fires
    // the handler; the STATE queue is the belt that keeps the wire serial).
    const remove2 = provCard("providers[1]").querySelector(".settings-provider-remove") as unknown as HTMLElement;
    expect(addBtn().hasAttribute("disabled")).toBe(true);
    expect(remove2.hasAttribute("disabled")).toBe(true);
    remove2.click();
    await tick();
    (provCard("providers[1]").querySelector(".settings-provider-remove-yes") as unknown as HTMLElement).click();
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
    expect(els(".file-line").map((r) => r.getAttribute("data-line"))).toEqual(["1", "2"]);
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

    // Right-click the root row: the app's Copy-path menu (ContextMenu idiom).
    const rowBtn = el(".ft-root .ft-row-btn");
    rowBtn.dispatchEvent({ type: "contextmenu", currentTarget: rowBtn, clientX: 50, clientY: 50 } as unknown as Event);
    await tick();
    const items = els(".context-menu-item").map((i) => i.textContent);
    expect(items).toEqual(["Copy path"]);
    const copied: string[] = [];
    document.execCommand = (): boolean => {
      const ta = document.querySelector("textarea[readonly]") as unknown as { value: string } | null;
      if (ta) copied.push(ta.value);
      return true;
    };
    els(".context-menu-item")[0]!.click();
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
    clearSent();
    el(".file-view-more").click();
    await tick();
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
    expect(el("#connection-status").textContent).toBe("Connected");

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
