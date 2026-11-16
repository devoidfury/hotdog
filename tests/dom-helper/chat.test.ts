// Tests for webui/ui/chat.ts message routing and connection lifecycle, run
// against the dom-helper preload's document + a per-test FakeWebSocket global.
// The chat opens a socket at construction; tests grab it from
// FakeWebSocket.instances (reset before each test by useFakeWebSocket()).

import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { createChat, type ChatController } from "@extensions/webui/ui/chat.ts";
import { HIDE_THINKING_STORAGE_KEY } from "@extensions/webui/ui/thinking-pref.ts";
import { FakeWebSocket, useFakeWebSocket } from "../dom-helper/index.ts";

type Sent = Record<string, unknown>;

let chat: ChatController | null = null;

useFakeWebSocket();

function makeChat(overrides: Partial<Parameters<typeof createChat>[0]> = {}) {
  const container = document.createElement("div");
  const callbacks: Record<string, unknown[]> = {};
  const track = (name: string) => (...args: unknown[]) => {
    (callbacks[name] ||= []).push(args);
  };
  chat = createChat({
    token: "tok",
    host: "test.host",
    getMessageListContainer: () => container,
    onSessionCreated: track("sessionCreated"),
    onSessionsUpdate: track("sessionsUpdate"),
    onLogsUpdate: track("logsUpdate"),
    onLogViewed: track("logViewed"),
    onLogDeleted: track("logDeleted"),
    onAuthFailure: track("authFailure"),
    onWorkingMapChange: track("workingMapChange"),
    ...overrides,
  });
  const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  return { chat, ws, container, callbacks };
}

function sentTypes(ws: FakeWebSocket): string[] {
  return ws.sent.map((s) => (JSON.parse(s) as Sent).type as string);
}

// chat.ts schedules its reconnect with a real 3 s setTimeout; waiting it out
// in real time costs this file ~6 s -- the wall-clock floor of the whole
// parallel suite. These two tests swap in a setTimeout that captures long
// waits (>= 1 s) so the test fires them synchronously, and passes short ones
// (the tests' own `await setTimeout(0)` yields) to the real timer.
const realSetTimeout = globalThis.setTimeout;
function captureLongTimers() {
  const captured: Array<() => void> = [];
  let fakeId = 1000;
  globalThis.setTimeout = ((cb: () => void, ms?: number, ...rest: unknown[]) => {
    if (typeof ms === "number" && ms >= 1000) {
      captured.push(cb);
      return fakeId++;
    }
    return realSetTimeout(cb as never, ms, ...rest);
  }) as unknown as typeof setTimeout;
  return {
    fireCaptured() {
      for (const cb of captured.splice(0)) cb();
    },
    restore() {
      globalThis.setTimeout = realSetTimeout;
    },
  };
}

// Module-level atoms in chat.ts (currentProfileAtom etc.) are shared across
// createChat() calls by design (single-page app), so tests that mutate them
// must restore their own changes; "default" is the module's initial value.
afterEach(() => {
  chat?.currentProfileAtom("default");
  chat?.disconnect();
  chat = null;
});

describe("handshake", () => {
  it("sends the token as the first message on open", () => {
    const { ws } = makeChat();
    expect(ws.url).toBe("ws://test.host/ws");
    ws.fireOpen();
    expect(ws.sent).toEqual([JSON.stringify({ type: "auth", token: "tok" })]);
  });

  it("authOk flips connected and triggers listLogs; authRequired is a no-op", () => {
    const { ws, chat, callbacks } = makeChat();
    ws.fireOpen();
    ws.fireMessage({ type: "authRequired" });
    expect(chat.connectedAtom()).toBe(false);
    ws.fireMessage({ type: "authOk" });
    expect(chat.connectedAtom()).toBe(true);
    expect(sentTypes(ws)).toContain("listLogs");
    expect(callbacks.authFailure).toBeUndefined();
  });

  it("authError with code auth_required is ignored, otherwise fails auth", () => {
    const { ws, callbacks } = makeChat();
    ws.fireOpen();
    ws.fireMessage({ type: "authError", message: "race", code: "auth_required" });
    expect(callbacks.authFailure).toBeUndefined();
    ws.fireMessage({ type: "authError", message: "bad token" });
    expect(callbacks.authFailure).toHaveLength(1);
  });

  it("invalid JSON on the socket is ignored", () => {
    const { ws } = makeChat();
    ws.fireOpen();
    ws.fireMessage("{not json");
    expect(sentTypes(ws)).toEqual(["auth"]);
  });

  it("without a token, open fails auth immediately (no verify round-trip)", async () => {
    const originalFetch = globalThis.fetch;
    let called = "";
    globalThis.fetch = (async (url: string | URL) => {
      called = String(url);
      return { status: 401 } as Response;
    }) as unknown as typeof fetch;
    try {
      const { ws, callbacks } = makeChat({ token: null });
      // Nothing to auth with on the socket: open routes straight to
      // verifyTokenAndReconnect, which short-circuits to onAuthFailure.
      ws.fireOpen();
      await new Promise((r) => setTimeout(r, 0));
      expect(callbacks.authFailure).toHaveLength(1);
      expect(called).toBe(""); // no /verify fetch for the token-less path
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("close on a bad token stops reconnecting (401)", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ status: 401 }) as Response) as unknown as typeof fetch;
    try {
      const n0 = FakeWebSocket.instances.length;
      const { ws, callbacks } = makeChat();
      ws.fireOpen();
      ws.onclose?.();
      await new Promise((r) => setTimeout(r, 0));
      expect(callbacks.authFailure).toHaveLength(1);
      expect(FakeWebSocket.instances.length).toBe(n0 + 1); // no reconnect socket
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("close with a reachable server schedules one reconnect", async () => {
    const originalFetch = globalThis.fetch;
    const timers = captureLongTimers();
    // Not 401 (server may just be down or verify pending) -> reconnect anyway.
    globalThis.fetch = (async () => ({ status: 503 }) as Response) as unknown as typeof fetch;
    try {
      const n0 = FakeWebSocket.instances.length;
      const { ws, chat } = makeChat();
      ws.fireOpen();
      ws.onclose?.();
      expect(chat.connectedAtom()).toBe(false);
      await new Promise((r) => realSetTimeout(r, 0)); // let the /verify settle
      timers.fireCaptured(); // the 3 s reconnect timer, fired in zero time
      expect(FakeWebSocket.instances.length).toBe(n0 + 2);
      chat.disconnect(); // cancels any further reconnects
    } finally {
      globalThis.fetch = originalFetch;
      timers.restore();
    }
  });

  it("network error during verify also schedules a reconnect", async () => {
    const originalFetch = globalThis.fetch;
    const timers = captureLongTimers();
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    try {
      const n0 = FakeWebSocket.instances.length;
      const { ws } = makeChat();
      ws.fireOpen();
      ws.onclose?.();
      await new Promise((r) => realSetTimeout(r, 0)); // let the failed verify settle
      timers.fireCaptured();
      expect(FakeWebSocket.instances.length).toBe(n0 + 2);
    } finally {
      globalThis.fetch = originalFetch;
      timers.restore();
      chat?.disconnect();
    }
  });
});

describe("session management messages", () => {
  it("sessionCreated sets ids, model, profile and models", () => {
    const { ws, chat, callbacks } = makeChat();
    ws.fireMessage({
      type: "sessionCreated",
      sessionId: "s1",
      profile: "coder",
      title: "My chat",
      currentModel: "gpt-x",
      models: ["gpt-x", "gpt-y"],
    });
    expect(chat.sessionIdAtom()).toBe("s1");
    expect(chat.sessionTitleAtom()).toBe("My chat");
    expect(chat.currentModelAtom()).toBe("gpt-x");
    expect(chat.modelsAtom()).toEqual(["gpt-x", "gpt-y"]);
    expect(chat.currentProfileAtom()).toBe("coder");
    expect(callbacks.sessionCreated).toHaveLength(1);
  });

  it("working state arriving before sessionCreated is restored on create", () => {
    const { ws, chat } = makeChat();
    // The server can flip `working` for a session the client hasn't attached
    // yet; sessionCreated must restore the flag from the per-session map.
    chat.sessionWorkingMap.set("s1", true);
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    expect(chat.workingAtom()).toBe(true);
  });

  it("sessionDeleted clears state only for the active session", () => {
    const { ws, chat } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    ws.fireMessage({ type: "sessionDeleted", sessionId: "other" });
    expect(chat.sessionIdAtom()).toBe("s1");
    ws.fireMessage({ type: "sessionDeleted", sessionId: "s1" });
    expect(chat.sessionIdAtom()).toBeNull();
  });

  it("sessions updates profile/title for the active session", () => {
    const { ws, chat, callbacks } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    ws.fireMessage({
      type: "sessions",
      sessions: [
        { id: "other", profile: "p" },
        { id: "s1", profile: "coder", title: "renamed", messageCount: 3 },
      ],
    });
    expect(chat.currentProfileAtom()).toBe("coder");
    expect(chat.sessionTitleAtom()).toBe("renamed");
    expect(callbacks.sessionsUpdate).toHaveLength(1);
  });

  it("profiles and profileSwitched update atoms", () => {
    const { ws, chat } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    ws.fireMessage({ type: "profiles", profiles: { coder: { body: "b", model: null } } });
    expect(chat.profilesAtom().coder).toBeDefined();
    ws.fireMessage({ type: "profileSwitched", sessionId: "s1", profile: "coder", success: true });
    expect(chat.currentProfileAtom()).toBe("coder");
  });

  it("logs messages route to their callbacks", () => {
    const { ws, callbacks } = makeChat();
    ws.fireMessage({ type: "logsListed", logs: [{ id: "l1", createdAt: 1, lastActivityAt: 2, messageCount: 3 }] });
    ws.fireMessage({ type: "logViewed", logId: "l1", entries: [] });
    ws.fireMessage({ type: "logDeleted", logId: "l1" });
    expect(callbacks.logsUpdate).toHaveLength(1);
    expect(callbacks.logViewed).toHaveLength(1);
    expect(callbacks.logDeleted).toHaveLength(1);
  });
});

describe("content routing into the message list", () => {
  it("routes each content event to a rendered element", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");

    ws.fireMessage({ type: "userMessage", content: "u" });
    ws.fireMessage({ type: "assistantMessage", content: "a" });
    ws.fireMessage({ type: "thinking", content: "t" });
    ws.fireMessage({ type: "toolCall", name: "bash", args: "{}" });
    ws.fireMessage({ type: "toolResult", name: "bash", output: "out" });
    ws.fireMessage({ type: "compacting", message: "c" });
    ws.fireMessage({ type: "commandResult", content: "cr" });
    ws.fireMessage({ type: "question", questions: [{ prompt: "q?" }] });
    ws.fireMessage({ type: "streamingChunk", content: "str" });
    ws.fireMessage({ type: "streamingReasoningChunk", content: "rea" });
    ws.fireMessage({ type: "taskProgress", taskId: "t1", status: "running" });
    ws.fireMessage({ type: "tokenUsage", promptTokens: 1, cachedTokens: 0, completionTokens: 1, totalTokens: 2 });
    ws.fireMessage({ type: "compactionResult", summary: "s", messagesCompacted: 1 });

    expect(container.querySelector(".message.user")).not.toBeNull();
    expect(container.querySelectorAll(".message.assistant").length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector(".thinking-block")).not.toBeNull();
    expect(container.querySelector(".tool-call-block")).not.toBeNull();
    expect(container.querySelector(".compacting")).not.toBeNull();
    expect(container.querySelector(".command-result")).not.toBeNull();
    expect(container.querySelector(".question")).not.toBeNull();
    expect(container.querySelector(".task-progress")).not.toBeNull();
    // tokenUsage renders NO transcript bubble (retired): the numbers fold
    // into the footer's ctx segment at the next commit, and the event still
    // flows through the dispatcher to message-list to make that happen.
    expect(container.querySelector(".token-usage")).toBeNull();
    expect(container.querySelector(".compaction-result")).not.toBeNull();
  });

  it("drops content events from non-active sessions", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "userMessage", sessionId: "sneaky", content: "leak" });
    expect(container.querySelector(".message.user")).toBeNull();
  });

  it("content events before setSession are dropped", () => {
    const { ws, container } = makeChat();
    ws.fireMessage({ type: "userMessage", content: "early" });
    expect(container.children).toHaveLength(0);
  });

  it("error clears working state and renders an error bubble", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    chat.sendMessage("hi");
    expect(chat.workingAtom()).toBe(true);
    ws.fireMessage({ type: "error", message: "boom" });
    expect(chat.workingAtom()).toBe(false);
    expect(container.querySelector(".message.error")).not.toBeNull();
  });

  it("unknown message types warn but do not throw", () => {
    const { ws, chat } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "wat" });
  });

  it("questionAnswered without a session id locks the card", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "question", questions: [{ key: "k", prompt: "p" }] });
    ws.fireMessage({ type: "questionAnswered", answers: { k: "v" } });
    expect(container.querySelector(".question-card.answered")).not.toBeNull();
  });

  it("questionAnswered from another session is ignored", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "question", questions: [{ key: "k", prompt: "p" }] });
    ws.fireMessage({ type: "questionAnswered", sessionId: "other", answers: { k: "v" } });
    expect(container.querySelector(".question-card.answered")).toBeNull();
  });

  it("sessionState drives sidebar atoms and the working map", () => {
    const { ws, chat, callbacks } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "sessionState", sessionId: "other", key: "working", value: true });
    expect(chat.sessionWorkingMap.get("other")).toBe(true);
    expect(chat.workingAtom()).toBe(false); // not the active session
    expect(callbacks.workingMapChange).toHaveLength(1);
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: true });
    expect(chat.workingAtom()).toBe(true);
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "model", value: "m2" });
    expect(chat.currentModelAtom()).toBe("m2");
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "models", value: ["m2", "m3"] });
    expect(chat.modelsAtom()).toEqual(["m2", "m3"]);
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "profile", value: "p2" });
    expect(chat.currentProfileAtom()).toBe("p2");
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "title", value: "T" });
    expect(chat.sessionTitleAtom()).toBe("T");
  });
});

// ── Message footer wiring (working edges drive the completion footer) ───────

describe("assistant footer via working edges", () => {
  it("completes the streaming row with a footer when the attached session stops", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: false }); // attach baseline
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: true }); // turn start (clocked)
    ws.fireMessage({ type: "streamingChunk", sessionId: "s1", content: "hello there" });
    // In flight: no footer yet.
    expect(container.querySelector(".message-assistant-footer")).toBeNull();
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: false });
    const footer = container.querySelector(".message-assistant-footer");
    expect(footer).not.toBeNull();
    expect(footer!.querySelector(".footer-time")!.textContent).toMatch(/\d{1,2}:\d{2} (AM|PM)/);
    // The clock saw the false->true edge, so the worked segment is measured.
    expect(footer!.querySelector(".footer-worked")!.textContent).toMatch(/^Worked for \d+s$/);
    // No longer streaming.
    expect(container.querySelector(".message.assistant.streaming")).toBeNull();
  });

  it("a turn already running at attach time renders the timestamp WITHOUT a duration", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    // First working report says running: mid-turn attach, start never observed.
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: true });
    ws.fireMessage({ type: "streamingChunk", sessionId: "s1", content: "partial" });
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: false });
    const footer = container.querySelector(".message-assistant-footer")!;
    expect(footer).not.toBeNull();
    expect(footer.querySelector(".footer-worked")).toBeNull();
  });

  it("other sessions' working flips never touch this transcript", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "streamingChunk", sessionId: "s1", content: "live" });
    ws.fireMessage({ type: "sessionState", sessionId: "other", key: "working", value: true });
    ws.fireMessage({ type: "sessionState", sessionId: "other", key: "working", value: false });
    expect(container.querySelector(".message-assistant-footer")).toBeNull();
    // The live row is still open (not finalized by another session's turn).
    expect(container.querySelector(".message.assistant.streaming")).not.toBeNull();
  });

  it("replayed assistant frames render their footer from the wire ts/duration", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    const ts = new Date("2026-05-04T00:00:00.000Z").getTime();
    ws.fireMessage({ type: "assistantMessage", sessionId: "s1", content: "from replay", ts, durationMs: 61_000 });
    const footer = container.querySelector(".message-assistant-footer")!;
    expect(footer.querySelector(".footer-worked")!.textContent).toBe("Worked for 1m 01s");
    // Frames without footer data (fork replay, live) render no footer.
    ws.fireMessage({ type: "assistantMessage", sessionId: "s1", content: "no meta" });
    expect(container.querySelectorAll(".message-assistant-footer")).toHaveLength(1);
  });
});

describe("outbound commands", () => {
  it("guards on missing session, then sends with the active session id", () => {
    const { ws, chat } = makeChat();
    ws.fireOpen(); // sends auth
    chat.sendMessage("nope"); // no session -> dropped
    expect(sentTypes(ws)).toEqual(["auth"]);
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });

    chat.sendMessage("hello");
    expect(ws.lastSent()).toEqual({ type: "send", sessionId: "s1", content: "hello" });
    chat.sendSlashCommand("/model x");
    expect(ws.lastSent()).toMatchObject({ type: "command", command: "/model x" });
    chat.sendCommand("/help");
    expect(ws.lastSent()!.type).toBe("command");
    chat.cancel();
    expect(ws.lastSent()).toEqual({ type: "cancel", sessionId: "s1" });
    expect(chat.workingAtom()).toBe(false);
    chat.switchProfile("coder");
    expect(ws.lastSent()).toEqual({ type: "switchProfile", sessionId: "s1", profileName: "coder" });
    chat.sendQuestionAnswer({ k: "v" });
    expect(ws.lastSent()).toMatchObject({ type: "questionAnswer", answers: { k: "v" } });
  });

  it("session CRUD and listing messages", () => {
    const { ws, chat } = makeChat();
    chat.createSession();
    expect(ws.lastSent()).toMatchObject({ type: "createSession", profile: "default" });
    chat.createSession({ profile: "coder" });
    expect(ws.lastSent()).toMatchObject({ profile: "coder" });
    chat.switchSession("s9");
    expect(chat.sessionIdAtom()).toBe("s9");
    const types = sentTypes(ws);
    expect(types).toContain("switchSession");
    expect(types[types.length - 1]).toBe("listSessions"); // refresh after switch
    chat.deleteSession("s9");
    expect(chat.sessionWorkingMap.has("s9")).toBe(false);
    chat.renameSession("s9", "new");
    const renameIdx = ws.sent.findIndex((s) => (JSON.parse(s) as Sent).type === "renameSession");
    expect(JSON.parse(ws.sent[renameIdx]!)).toMatchObject({ type: "renameSession", newName: "new" });
    chat.listProfiles();
    expect(ws.lastSent()).toEqual({ type: "listProfiles" });
    chat.loadLog("l1");
    expect(ws.lastSent()).toEqual({ type: "loadLog", logId: "l1" });
    chat.viewLog("l1");
    expect(ws.lastSent()!.type).toBe("viewLog");
    chat.deleteLog("l1");
    expect(ws.lastSent()!.type).toBe("deleteLog");
    chat.send({ type: "rawThing" });
    expect(ws.lastSent()).toEqual({ type: "rawThing" });
  });

  it("disconnect closes the socket and blocks further sends", () => {
    const { ws, chat } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.disconnect();
    expect(chat.connectedAtom()).toBe(false);
    expect(ws.closed).toBe(1);
    const before = ws.sent.length;
    chat.send({ type: "late" });
    expect(ws.sent.length).toBe(before); // readyState CLOSED -> warn, no send
  });

  it("getCurrentProfile reflects the atom", () => {
    const { ws, chat } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1", profile: "role-a" });
    expect(chat.getCurrentProfile()).toBe("role-a");
  });
});

// ── Reasoning visibility: the per-browser preference drives the list ─────────
// Owner ruling 2026-11-05. chat.ts seeds the message list from localStorage
// (thinking-pref.ts) and the header chip's toggle sweeps every thinking block;
// the SERVER's sessionState(key:"hideThinking") is dropped on purpose -- a CLI
// /thinking toggle must not repaint this browser. The message-list engine
// itself is unchanged (see the pins in message-list.test.ts), and the CLI's
// own "Thinking display: ..." notice rides the commandResult path untouched.

describe("reasoning visibility preference (chat driver)", () => {
  const win = window as unknown as Record<string, unknown>;
  const prevLocalStorage = win.localStorage;

  /** Map-backed window.localStorage; chat reads it once, at createChat. */
  function storageWith(entries: Record<string, string> = {}): Map<string, string> {
    const map = new Map<string, string>(Object.entries(entries));
    win.localStorage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, String(v)),
      removeItem: (k: string) => void map.delete(k),
    };
    return map;
  }

  /** Private-mode Safari / blocked origin: even the property access throws. */
  function storageThatThrows(): void {
    Object.defineProperty(win, "localStorage", {
      configurable: true,
      get() {
        throw new Error("SecurityError: localStorage access denied");
      },
    });
  }

  afterEach(() => {
    delete win.localStorage; // also drops a defineProperty getter
    if (prevLocalStorage !== undefined) win.localStorage = prevLocalStorage;
  });

  /** Attach, then one committed thinking block plus one still in flight. */
  function withThinkingBlocks() {
    const ctx = makeChat();
    ctx.ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    ctx.chat.setSession("s1");
    ctx.ws.fireMessage({ type: "thinking", content: "committed thought" });
    ctx.ws.fireMessage({ type: "assistantMessage", content: "the answer" });
    ctx.ws.fireMessage({ type: "thinking", content: "in-flight thought" });
    return ctx;
  }

  const hiddenFlags = (container: HTMLElement): boolean[] =>
    [...container.querySelectorAll(".thinking-block")].map((b) =>
      b.classList.contains("hidden"),
    );

  it("seeds the live list from the stored preference: thinking arrives hidden", () => {
    storageWith({ [HIDE_THINKING_STORAGE_KEY]: "1" });
    const { chat, container } = withThinkingBlocks();
    expect(chat.hideThinkingAtom()).toBe(true);
    expect(hiddenFlags(container)).toEqual([true, true]);
  });

  it("an unset or unparseable value means shown (default visible)", () => {
    storageWith({ [HIDE_THINKING_STORAGE_KEY]: "yes-please" });
    const { chat, container } = withThinkingBlocks();
    expect(chat.hideThinkingAtom()).toBe(false);
    expect(hiddenFlags(container)).toEqual([false, false]);
  });

  it("a throwing localStorage defaults to shown, and toggling still repaints", () => {
    storageThatThrows();
    const { chat, container } = withThinkingBlocks(); // no crash at createChat
    expect(chat.hideThinkingAtom()).toBe(false);
    expect(hiddenFlags(container)).toEqual([false, false]);
    chat.toggleHideThinking(); // the swallowed persist costs only the reload
    expect(hiddenFlags(container)).toEqual([true, true]);
    expect(chat.hideThinkingAtom()).toBe(true);
  });

  it("toggle sweeps committed + in-flight blocks and persists; the socket stays silent", () => {
    const map = storageWith();
    const { chat, container, ws } = withThinkingBlocks();
    const before = ws.sent.length;

    chat.toggleHideThinking();
    expect(hiddenFlags(container)).toEqual([true, true]);
    expect(chat.hideThinkingAtom()).toBe(true);
    expect(map.get(HIDE_THINKING_STORAGE_KEY)).toBe("1");

    chat.toggleHideThinking();
    expect(hiddenFlags(container)).toEqual([false, false]);
    expect(chat.hideThinkingAtom()).toBe(false);
    expect(map.get(HIDE_THINKING_STORAGE_KEY)).toBe("0");
    expect(ws.sent.length).toBe(before); // a view setting never hits the wire
  });

  it("sessionState(hideThinking) from the server no longer repaints the transcript", () => {
    storageWith();
    const { chat, container, ws } = withThinkingBlocks();
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "hideThinking", value: true });
    expect(hiddenFlags(container)).toEqual([false, false]);
    expect(chat.hideThinkingAtom()).toBe(false);
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "hideThinking", value: false });
    expect(hiddenFlags(container)).toEqual([false, false]);
    // The rest of the sessionState channel still routes.
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "model", value: "m2" });
    expect(chat.currentModelAtom()).toBe("m2");
  });

  it("the toggle works while a cold log is on screen (log view drops live events, not the sweep)", () => {
    storageWith();
    const { chat, container, ws } = withThinkingBlocks();
    // Enter log view: from here live transcript events go to LOG_VIEW_SINK, but
    // what is ON SCREEN is still the live container the sweep walks.
    ws.fireMessage({ type: "logViewed", logId: "l1", entries: [] });
    chat.toggleHideThinking();
    expect(hiddenFlags(container)).toEqual([true, true]);
    // A server toggle during log view stays inert too.
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "hideThinking", value: false });
    expect(hiddenFlags(container)).toEqual([true, true]);
  });

  it("the chip's hide flip RE-DERIVES the Thinking row mid-reasoning", () => {
    storageWith();
    const { chat, container, ws } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    // A live turn, reasoning streaming VISIBLE: the row retired when the
    // first reasoning chunk landed.
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: true });
    ws.fireMessage({ type: "streamingReasoningChunk", sessionId: "s1", content: "pondering" });
    expect(container.querySelectorAll(".thinking-live")).toHaveLength(0);
    // The header chip flips to HIDE: the row covers the reasoning phase while
    // reasoning is hidden, so the set-path re-evaluates -- call in flight, no
    // plain content streamed -- the row appears.
    chat.toggleHideThinking();
    expect(container.querySelectorAll(".thinking-live")).toHaveLength(1);
    expect(hiddenFlags(container)).toEqual([true]);
    // Toggling back ON retires it as the reasoning blocks become visible.
    chat.toggleHideThinking();
    expect(container.querySelectorAll(".thinking-live")).toHaveLength(0);
  });

  it("the chip's hide flip keeps the row down once plain text has streamed", () => {
    storageWith();
    const { chat, container, ws } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: true });
    ws.fireMessage({ type: "streamingChunk", sessionId: "s1", content: "the answer is" });
    ws.fireMessage({ type: "streamingReasoningChunk", sessionId: "s1", content: "and why" });
    chat.toggleHideThinking();
    expect(container.querySelectorAll(".thinking-live")).toHaveLength(0); // content already streaming
  });
});

// ── Live activity: the Thinking row and the in-flight tool preview ──────────
// chat.ts owns the two edges the row answers (the send click, the wire's
// working frames) and routes the live-only streamingToolCall frame; the
// browse-mode sink must swallow both, or a cold log gets a live tell.

describe("live activity tell + in-flight tool preview routing", () => {
  function attached() {
    const h = makeChat();
    h.ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    h.chat.setSession("s1");
    return h;
  }
  const rows = (c: HTMLElement) => c.querySelectorAll(".thinking-live");
  const bubbles = (c: HTMLElement) => c.querySelectorAll(".tool-call-streaming");

  it("the send click answers with the row; the working edge keeps it, the first chunk retires it", () => {
    const { chat, container, ws } = attached();
    chat.sendMessage("hello");
    expect(rows(container)).toHaveLength(1);
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: true });
    expect(rows(container)).toHaveLength(1); // re-attested, not cloned
    ws.fireMessage({ type: "streamingChunk", sessionId: "s1", content: "here" });
    expect(rows(container)).toHaveLength(0);
  });

  it("Stop clears the row and every in-flight preview on the same click", () => {
    const { chat, container, ws } = attached();
    chat.sendMessage("hello");
    ws.fireMessage({ type: "streamingToolCall", sessionId: "s1", index: 0, name: "bash", args: '{"command":"ls"' });
    expect(bubbles(container)).toHaveLength(1);
    chat.cancel();
    expect(rows(container)).toHaveLength(0);
    expect(bubbles(container)).toHaveLength(0);
  });

  it("a streamingToolCall frame renders the preview, and the toolCall frame upgrades it once", () => {
    const { container, ws } = attached();
    ws.fireMessage({ type: "streamingToolCall", sessionId: "s1", index: 0, name: "bash", args: '{"comm' });
    const bubble = container.querySelector(".tool-call-streaming")!;
    expect(bubble.querySelector(".tool-call-name")!.textContent).toBe("🛠 bash");
    expect(bubble.querySelector(".tool-call-stream-preview")!.textContent).toBe('{"comm');
    ws.fireMessage({
      type: "toolCall", sessionId: "s1", name: "bash", args: '{"command":"ls"}', toolCallId: "t1",
    });
    expect(bubbles(container)).toHaveLength(0);
    expect(container.querySelectorAll(".tool-call-block")).toHaveLength(1);
    // A frame from another session never touches this transcript.
    ws.fireMessage({ type: "streamingToolCall", sessionId: "other", index: 0, name: "read", args: "{}" });
    expect(bubbles(container)).toHaveLength(0);
  });

  it("browse mode swallows both: no tell and no preview over a cold log", () => {
    const { container, ws } = attached();
    ws.fireMessage({ type: "logViewed", logId: "l1", entries: [] });
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: true });
    ws.fireMessage({ type: "streamingToolCall", sessionId: "s1", index: 0, name: "bash", args: "{}" });
    ws.fireMessage({ type: "streamingChunk", sessionId: "s1", content: "not in the log window" });
    expect(rows(container)).toHaveLength(0);
    expect(bubbles(container)).toHaveLength(0);
  });
});

// ── Reload recovery of the "Thinking" row (chat routing)
// The row answers the ATTACHED state: the attach burst ends by re-posting
// this session's working value, and a view whose replay burst committed only
// EARLIER calls must take the tell back (message-list owns the derivation;
// this pins the chat-side routing of that state).

describe("thinking row recovery from the attach's working state", () => {
  it("a mid-turn reload re-arms the row after the replayed committed rows", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    // The burst replays the turn's earlier committed prose, then the burst's
    // working frame says: still running. No bytes of the RUNNING call have
    // landed in this view -- the row recovers.
    ws.fireMessage({ type: "userMessage", sessionId: "s1", content: "go" });
    ws.fireMessage({ type: "assistantMessage", sessionId: "s1", content: "thinking out loud earlier" });
    expect(container.querySelectorAll(".thinking-live")).toHaveLength(0);
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: true });
    expect(container.querySelectorAll(".thinking-live")).toHaveLength(1);
    // The running call's first chunk retires it, exactly like a live turn.
    ws.fireMessage({ type: "streamingChunk", sessionId: "s1", content: "now streaming" });
    expect(container.querySelectorAll(".thinking-live")).toHaveLength(0);
  });

  it("attaching to an idle session never fabricates the row", () => {
    const { ws, chat, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "assistantMessage", sessionId: "s1", content: "done a while ago" });
    // The attach's honest working:false -- between calls, nothing in flight.
    ws.fireMessage({ type: "sessionState", sessionId: "s1", key: "working", value: false });
    expect(container.querySelectorAll(".thinking-live")).toHaveLength(0);
  });
});

// ── Viewed-subagent pointer persistence (sessionStorage, per TAB) ──────────
// hotdog-viewed-task records the main-pane browse pointer. A reload re-plays
// it EXACTLY ONCE, through the same viewSubagent open, once the task hydrates
// into the feed; a full snapshot without the id clears the key (unknown/gone
// degrades to today's boot); navigation writes the NEW pointer, never a stale
// one. Storage is the workbench-tab stub idiom -- installed before createChat,
// resolved per call, no mock.module.

describe("viewed-subagent pointer persistence (reload restore)", () => {
  let session: Map<string, string>;
  let prevSessionStorage: unknown;

  beforeEach(() => {
    session = new Map([["hotdog-viewed-task", "task-9"]]);
    prevSessionStorage = (window as unknown as Record<string, unknown>).sessionStorage;
    (window as unknown as Record<string, unknown>).sessionStorage = {
      getItem: (k: string) => session.get(k) ?? null,
      setItem: (k: string, v: string) => void session.set(k, String(v)),
      removeItem: (k: string) => void session.delete(k),
    };
  });
  afterEach(() => {
    if (prevSessionStorage === undefined) {
      delete (window as unknown as Record<string, unknown>).sessionStorage;
    } else {
      (window as unknown as Record<string, unknown>).sessionStorage = prevSessionStorage;
    }
  });

  const task = (over: Record<string, unknown> = {}) => ({
    taskId: "task-9",
    description: "do the delegated thing",
    sessionId: "s1",
    status: "running",
    createdAt: 1,
    startedAt: 1,
    endedAt: null,
    activeMs: 0,
    inRun: true,
    turnStartedAt: 1,
    ...over,
  });

  it("pointer applied exactly once, through viewSubagent, when the task hydrates", () => {
    const { chat, ws, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    // The attach cleared the live pointer; the candidate waits in memory.
    expect(chat.viewedTaskIdAtom()).toBeNull();
    expect(session.get("hotdog-viewed-task")).toBe("task-9");

    // Hydration WITHOUT the id must not apply anything yet... and a full
    // snapshot that DENIES the id is handled in its own test. Here the
    // snapshot carries the task: the pointer lands.
    ws.fireMessage({ type: "taskList", tasks: [task()] });
    expect(chat.viewedTaskIdAtom()).toBe("task-9");
    // Same open path: the delegated-prompt seed paints, and the transcript
    // request rides (open semantics, not a bare pointer write).
    expect(container.textContent).toContain("do the delegated thing");
    expect(ws.sent.some((s) => (JSON.parse(s) as Sent).type === "taskActivityRequest")).toBe(true);

    // Exactly once: a later snapshot containing the id never re-opens (no
    // second clear, no second request).
    const requestsBefore = ws.sent.filter((s) => (JSON.parse(s) as Sent).type === "taskActivityRequest").length;
    ws.fireMessage({ type: "taskList", tasks: [task()] });
    const requestsAfter = ws.sent.filter((s) => (JSON.parse(s) as Sent).type === "taskActivityRequest").length;
    expect(requestsAfter).toBe(requestsBefore);
    expect(chat.viewedTaskIdAtom()).toBe("task-9");
  });

  it("a taskActivity or taskUpdate frame for the candidate also hydrates it (once)", () => {
    const { chat, ws } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({
      type: "taskActivity",
      taskId: "task-9",
      activity: { kind: "text", content: "streamed bytes" },
    });
    expect(chat.viewedTaskIdAtom()).toBe("task-9");
    expect(session.get("hotdog-viewed-task")).toBe("task-9");
    // The restore paints this frame's block via the buffer -- and a later
    // taskUpdate never re-opens.
    ws.fireMessage({ type: "taskUpdate", task: task({ status: "completed", inRun: false }) });
    expect(chat.viewedTaskIdAtom()).toBe("task-9");
  });

  it("a full snapshot WITHOUT the id clears the key and behaves as today", () => {
    const { chat, ws, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "assistantMessage", sessionId: "s1", content: "the parent transcript" });
    ws.fireMessage({ type: "taskList", tasks: [task({ taskId: "other-task" })] });
    expect(chat.viewedTaskIdAtom()).toBeNull();
    expect(session.has("hotdog-viewed-task")).toBe(false);
    // The parent's transcript paints un-suppressed, exactly as a boot that
    // never had a pointer.
    ws.fireMessage({ type: "streamingChunk", sessionId: "s1", content: "live into the log" });
    expect(container.textContent).toContain("live into the log");
  });

  it("a candidate whose manager is not built yet waits for the next feed frame", () => {
    // taskList broadcast can beat the attach: no manager, no open, candidate
    // intact -- the burst's own snapshot (after sessionCreated/setSession)
    // decides.
    const { chat, ws } = makeChat();
    ws.fireMessage({ type: "taskList", tasks: [task()] });
    expect(chat.viewedTaskIdAtom()).toBeNull();
    expect(session.get("hotdog-viewed-task")).toBe("task-9");
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "taskList", tasks: [task()] });
    expect(chat.viewedTaskIdAtom()).toBe("task-9");
  });

  it("navigation persists the NEW pointer, never a stale one", () => {
    const { chat, ws } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    ws.fireMessage({ type: "taskList", tasks: [task()] });
    expect(session.get("hotdog-viewed-task")).toBe("task-9");

    // Open ANOTHER task: the key moves with the pointer.
    ws.fireMessage({ type: "taskList", tasks: [task(), task({ taskId: "task-10" })] });
    chat.viewSubagent("task-10");
    expect(chat.viewedTaskIdAtom()).toBe("task-10");
    expect(session.get("hotdog-viewed-task")).toBe("task-10");

    // Close the view: the key goes.
    chat.closeSubagentView();
    expect(chat.viewedTaskIdAtom()).toBeNull();
    expect(session.has("hotdog-viewed-task")).toBe(false);

    // Re-open, then navigate to another session / a cold log / a fresh one:
    // each route persists "no pointer".
    chat.viewSubagent("task-9");
    expect(session.get("hotdog-viewed-task")).toBe("task-9");
    chat.switchSession("s2");
    expect(chat.viewedTaskIdAtom()).toBeNull();
    expect(session.has("hotdog-viewed-task")).toBe(false);

    chat.viewSubagent("task-9");
    ws.fireMessage({ type: "logViewed", logId: "l1", entries: [] });
    expect(chat.viewedTaskIdAtom()).toBeNull();
    expect(session.has("hotdog-viewed-task")).toBe(false);

    chat.viewSubagent("task-9");
    chat.createSession();
    expect(chat.viewedTaskIdAtom()).toBeNull();
    expect(session.has("hotdog-viewed-task")).toBe(false);
  });

  it("clearTasks (logout) kills the candidate and the key", () => {
    const { chat, ws } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1");
    // Candidate pending, never hydrated: logout must not leave it for the
    // next login's taskList to resurrect.
    chat.clearTasks();
    expect(session.has("hotdog-viewed-task")).toBe(false);
    ws.fireMessage({ type: "taskList", tasks: [task()] });
    // A fresh taskList after logout never restores the old candidate.
    expect(chat.viewedTaskIdAtom()).toBeNull();
  });
});
