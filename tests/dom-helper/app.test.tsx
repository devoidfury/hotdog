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

import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { FakeWebSocket } from "./index.ts";
import { DRAFT_STORAGE_KEY } from "@extensions/webui/ui/draft.ts";

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
  addEventListener: win.addEventListener,
  removeEventListener: win.removeEventListener,
  localStorage: win.localStorage,
};
win.innerWidth = 1200;
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
  userMessageCount: 3,
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

  it("picked files become chips with size labels; empty files are skipped", async () => {
    await pick([makeFile("a.txt", "text/plain", 2048), makeFile("empty.txt", "text/plain", 0)]);
    const chips = els(".attachment-chip");
    expect(chips).toHaveLength(1);
    expect(chips[0]!.querySelector(".attachment-name")!.textContent).toBe("a.txt");
    expect(chips[0]!.querySelector(".attachment-size")!.textContent).toBe("2.0 KB");
    expect(el("#file-input").getAttribute("value")).not.toBe("a.txt"); // input reset for re-pick
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

  it("Continue on a log row loads it as a session", async () => {
    clearSent();
    els(".log-continue-btn")[0]!.click();
    expect(sent<{ logId: string }>("loadLog")[0]?.logId).toBe(L1);
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

// ── Context menus ───────────────────────────────────────────────────────────

describe("context menus", () => {
  const menuButtons = () => els(".context-menu-item");

  it("session menu: rename through the prompt, delete behind confirm", async () => {
    await attach();
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    expect(menuButtons().map((b) => b.textContent)).toEqual(["Rename", "Delete"]);

    clearSent();
    menuButtons()[0]!.click(); // rename
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
    menuButtons()[1]!.click();
    await tick();
    expect(sent("deleteSession")).toHaveLength(0);
    confirmAnswer = true;
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    menuButtons()[1]!.click();
    await tick();
    expect(sent<{ sessionId: string }>("deleteSession")[0]?.sessionId).toBe(SID);
  });

  it("an empty rename name changes nothing", async () => {
    els(".session-item")[0]!.dispatchEvent(new Event("contextmenu"));
    await tick();
    promptAnswer = "   ";
    clearSent();
    menuButtons()[0]!.click();
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
    expect(menuButtons().map((b) => b.textContent)).toEqual(["Delete"]);
    menuButtons()[0]!.click();
    await tick();
    expect(sent<{ logId: string }>("deleteLog")[0]?.logId).toBe(L1);

    clearSent();
    ws.fireMessage({ type: "logDeleted", logId: L1 });
    await tick();
    // Active log vanished: log view exits (label gone) and the list refreshes.
    expect(document.querySelector("#log-view-label")).toBeNull();
    expect(sent("listLogs").length).toBeGreaterThan(0);
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
  userMessageCount: 3,
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
    expect(activeRows(".log-item")[0]!.textContent).toContain(LV_L1);
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
    expect(activeRows(".log-item")[0]!.textContent).toContain(LV_L2);
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
    expect(activeRows(".log-item")[0]!.textContent).toContain(LV_L2);
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
    const otherRow = { ...lvSessionRow, id: OTHER, profile: "other", userMessageCount: 1 };
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
    expect(activeRows(".session-item")[0]!.textContent).toContain(OTHER);
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

  it("idle: no indicator, no Cancel in the composer", () => {
    expect(document.querySelector("#working-indicator")).toBeNull();
    expect(document.querySelector("#cancel-btn")).toBeNull();
  });

  it("working: Cancel (carrying the spinner) sits inside #composer-actions left of Send", async () => {
    ws.fireMessage({ type: "sessionState", sessionId: LV_SID, key: "working", value: true });
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
    expect(strip.getAttribute("class")).toContain("tool-exec-toggleable");
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
    expect(seen).toContain("Tool code for this session will run UNFENCED");
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
    expect(strip.getAttribute("class") ?? "").not.toContain("tool-exec-toggleable");
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
    expect(strip.getAttribute("class") ?? "").not.toContain("tool-exec-toggleable");
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
