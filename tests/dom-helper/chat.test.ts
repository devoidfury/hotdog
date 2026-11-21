// Tests for webui/ui/chat.ts message routing and connection lifecycle, run
// against the dom-helper preload's document + a per-test FakeWebSocket global.
// The chat opens a socket at construction; tests grab it from
// FakeWebSocket.instances (reset before each test by useFakeWebSocket()).

import { describe, it, expect, afterEach } from "bun:test";
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
    // The delta-preview capability rides the AUTH message (additive): an old
    // daemon ignores it and keeps the cumulative posture.
    expect(ws.sent).toEqual([
      JSON.stringify({ type: "auth", token: "tok", toolCallDeltas: true }),
    ]);
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

  it("a delta-posture frame accumulates through the chat routing too", () => {
    const { container, ws } = attached();
    ws.fireMessage({ type: "streamingToolCall", sessionId: "s1", index: 0, name: "bash", delta: '{"comm' });
    ws.fireMessage({ type: "streamingToolCall", sessionId: "s1", index: 0, name: "bash", delta: 'and":"ls"}' });
    expect(bubbles(container)).toHaveLength(1);
    expect(
      container.querySelector(".tool-call-stream-preview")!.textContent,
    ).toBe('{"command":"ls"}');
    ws.fireMessage({ type: "toolCall", sessionId: "s1", name: "bash", args: '{"command":"ls"}', toolCallId: "t1" });
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

// ── Worker-session view (B4: the pane IS the session) ──────────────────────
// The browse-pointer relay retired with the relay: a worker pane is the
// STANDARD session view opened by switchSession, so reload restore rides the
// ordinary last-session persistence and the view kind rides sessionCreated
// (B3's additive fields). A held question is READ-ONLY for the watcher (R3):
// the delegating manager answers, never the pane. Steering rides exactly one
// taskFollowup frame with NO optimistic row -- the drained USER_MESSAGE is the
// steer line's sole bearer, so it can never double up.

describe("worker-session view: kind, read-only question, single-frame steer", () => {
  it("sessionCreated kind rides the view state; an interactive attach resets it", () => {
    const { chat, ws } = makeChat();
    ws.fireMessage({
      type: "sessionCreated",
      sessionId: "w1",
      kind: "subagent",
      parentSessionId: "s1",
    });
    chat.setSession("w1");
    expect(chat.sessionKindAtom()).toBe("subagent");
    expect(chat.sessionParentAtom()).toBe("s1");
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    expect(chat.sessionKindAtom()).toBeNull();
    expect(chat.sessionParentAtom()).toBeNull();
  });

  it("a held question on a worker attach renders READ-ONLY (no answer control)", () => {
    const { chat, ws, container } = makeChat();
    ws.fireMessage({
      type: "sessionCreated",
      sessionId: "w1",
      kind: "subagent",
      parentSessionId: "s1",
    });
    chat.setSession("w1"); // builds the manager (the app does it in the callback)
    ws.fireMessage({
      type: "question",
      sessionId: "w1",
      questions: [{ key: "q1", message: "Which port?", options: ["3000", "8080"] }],
    });
    expect(container.textContent).toContain("asked the delegating manager");
    expect(container.textContent).toContain("Which port?");
    // No submit path to reject: the control never renders.
    expect(container.querySelectorAll("button")).toHaveLength(0);
    void chat;
  });

  it("an interactive attach keeps the question surface fully interactive", () => {
    const { chat, ws, container } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1"); // builds the manager
    ws.fireMessage({
      type: "question",
      sessionId: "s1",
      questions: [{ key: "q1", message: "Which port?", options: ["3000", "8080"] }],
    });
    expect(container.textContent).not.toContain("asked the delegating manager");
    expect(container.querySelectorAll("button").length).toBeGreaterThan(0);
    void chat;
  });

  it("taskFollowup sends exactly ONE frame and paints no optimistic row", () => {
    const { chat, ws, container } = makeChat();
    ws.fireMessage({
      type: "sessionCreated",
      sessionId: "w1",
      kind: "subagent",
      parentSessionId: "s1",
    });
    chat.setSession("w1");
    chat.taskFollowup("t1", "  left  ");
    const frames = ws
      .sent.map((s) => JSON.parse(s) as Sent)
      .filter((m) => m.type === "taskFollowup");
    expect(frames).toEqual([{ type: "taskFollowup", taskId: "t1", message: "left" }]);
    // No echo before the drain: the worker's own USER_MESSAGE event is the
    // row's sole bearer.
    expect(container.textContent).not.toContain("left");
    ws.fireMessage({ type: "userMessage", sessionId: "w1", content: "left" });
    expect(container.querySelectorAll(".message.user")).toHaveLength(1);
  });
});

// ── Lazy history windowing (chat layer, TASK W) ─────────────────────────────
// The chat owns the window state (id + oldestIndex) and the once-per-gap
// loadOlder guard; the manager owns the scroll geometry. These pins drive
// the wire pair end-to-end against the FakeWebSocket + dom-helper container.

describe("lazy history: chat layer loadOlder", () => {
  type Geo = { scrollTop: number; scrollHeight: number; clientHeight: number };

  function armed() {
    const ctx = makeChat();
    const { chat, container, ws } = ctx;
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    chat.setSession("s1"); // builds the manager (the app does this in the callback)
    const c = container as unknown as Geo;
    c.scrollHeight = 5000;
    c.clientHeight = 500;
    const olderReqs = () =>
      ws.sent.map((s) => JSON.parse(s) as Sent).filter((m) => m.type === "loadOlder");
    const scrollEdge = () => {
      c.scrollTop = 4000;
      container.dispatchEvent(new Event("scroll"));
      c.scrollTop = 80;
      container.dispatchEvent(new Event("scroll"));
    };
    return { chat, container, ws, olderReqs, scrollEdge };
  }

  it("windowed logViewed arms the trigger; a top-zone edge sends ONE loadOlder per gap", () => {
    const { ws, olderReqs, scrollEdge } = armed();
    ws.fireMessage({
      type: "logViewed", logId: "cold-1", entries: [], hasOlder: true, oldestIndex: 12,
    });
    scrollEdge();
    const reqs = olderReqs();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!).toMatchObject({ logId: "cold-1", olderThan: 12 });
    // In-flight: more edges do NOT pile up requests.
    scrollEdge();
    expect(olderReqs()).toHaveLength(1);
  });

  it("a delivered page prepends, re-targets the next page, and hasOlder=false closes the seam", () => {
    const { chat, container, ws, olderReqs, scrollEdge } = armed();
    ws.fireMessage({
      type: "logViewed", logId: "cold-1", entries: [], hasOlder: true, oldestIndex: 12,
    });
    scrollEdge();
    const reqId = olderReqs()[0]!.requestId;
    ws.fireMessage({
      type: "loadOlderResult",
      requestId: reqId,
      logId: "cold-1",
      entries: [
        { source: "input", content: "older question" },
        { source: "llm", content: "older answer" },
      ],
      oldestIndex: 6,
      hasOlder: true,
    });
    // Prepend landed in the real transcript (browse mode renders into it).
    expect(container.querySelector(".message.user")!.textContent).toContain("older question");
    scrollEdge();
    const reqs = olderReqs();
    expect(reqs).toHaveLength(2);
    expect(reqs[1]!).toMatchObject({ olderThan: 6 }); // re-targeted at the new head
    // The last page closes the window: no further requests, ever (this view).
    ws.fireMessage({
      type: "loadOlderResult", requestId: reqs[1]!.requestId, logId: "cold-1",
      entries: [], oldestIndex: 0, hasOlder: false,
    });
    scrollEdge();
    expect(olderReqs()).toHaveLength(2);
    void chat;
  });

  it("a refusal frees the in-flight slot; the next edge retries the same window (no retry loop)", () => {
    const { ws, olderReqs, scrollEdge } = armed();
    ws.fireMessage({
      type: "logViewed", logId: "cold-1", entries: [], hasOlder: true, oldestIndex: 12,
    });
    scrollEdge();
    const reqId = olderReqs()[0]!.requestId;
    ws.fireMessage({ type: "loadOlderResult", requestId: reqId, logId: "cold-1", error: "olderThan 12 is beyond log" });
    // No auto-retry scheduled -- the wire stays quiet until the user acts.
    expect(olderReqs()).toHaveLength(1);
    // The window stands; the next edge is the retry, same olderThan.
    scrollEdge();
    expect(olderReqs()).toHaveLength(2);
    expect(olderReqs()[1]!).toMatchObject({ olderThan: 12 });
  });

  it("an epoch_moved refusal CLOSES the seam: no prepend, no re-hit; navigation re-attests", () => {
    const { ws, olderReqs, scrollEdge } = armed();
    ws.fireMessage({
      type: "logViewed", logId: "cold-1", entries: [], hasOlder: true, oldestIndex: 12, epochToken: 4,
    });
    scrollEdge();
    const reqs = olderReqs();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!).toMatchObject({ olderThan: 12, epochToken: 4 });
    // A mid-socket /rewind moved the epoch; the correlated refusal is the
    // machine-readable class the seam closes on (re-hitting the stale index
    // would page the WRONG entries).
    ws.fireMessage({
      type: "loadOlderResult",
      requestId: reqs[0]!.requestId,
      logId: "cold-1",
      code: "epoch_moved",
      error: "The session's epoch moved (epochToken 4 is no longer current).",
    });
    scrollEdge();
    scrollEdge();
    expect(olderReqs()).toHaveLength(1);
    // A navigation re-attests and re-opens the seam with the NEW token.
    ws.fireMessage({
      type: "logViewed", logId: "cold-1", entries: [], hasOlder: true, oldestIndex: 30, epochToken: 9,
    });
    scrollEdge();
    const after = olderReqs();
    expect(after).toHaveLength(2);
    expect(after[1]!).toMatchObject({ olderThan: 30, epochToken: 9 });
  });

  it("a delivered page adopts the echoed epochToken for the next request", () => {
    const { ws, olderReqs, scrollEdge } = armed();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1", hasOlder: true, oldestIndex: 8 }); // no token
    scrollEdge();
    expect(olderReqs()[0]!).not.toHaveProperty("epochToken");
    ws.fireMessage({
      type: "loadOlderResult",
      requestId: olderReqs()[0]!.requestId,
      logId: "s1",
      entries: [{ source: "input", content: "older" }],
      oldestIndex: 4,
      hasOlder: true,
      epochToken: 7, // the server echoes the epoch it cut the page from
    });
    scrollEdge();
    expect(olderReqs()[1]!).toMatchObject({ olderThan: 4, epochToken: 7 });
  });

  it("stale/mismatched replies drop: wrong id, wrong log -- never a prepend, never a freed slot misfire", () => {
    const { container, ws, olderReqs, scrollEdge } = armed();
    ws.fireMessage({
      type: "logViewed", logId: "cold-1", entries: [], hasOlder: true, oldestIndex: 12,
    });
    scrollEdge();
    const reqId = olderReqs()[0]!.requestId;
    // Wrong requestId: dropped, slot still held.
    ws.fireMessage({
      type: "loadOlderResult", requestId: (reqId as number) + 99, logId: "cold-1",
      entries: [{ source: "input", content: "stale" }], oldestIndex: 6, hasOlder: true,
    });
    expect(container.textContent).not.toContain("stale");
    scrollEdge();
    expect(olderReqs()).toHaveLength(1); // still one in flight
    // Right id, wrong log (pane moved on): dropped.
    ws.fireMessage({
      type: "loadOlderResult", requestId: reqId, logId: "other-log",
      entries: [{ source: "input", content: "wrong log" }], oldestIndex: 6, hasOlder: true,
    });
    expect(container.textContent).not.toContain("wrong log");
  });

  it("jump click while a page is in flight: one request, pin survives the page, wire stays quiet", () => {
    // Jump-to-bottom exclusivity pin: the click touches only scroll/follow/
    // its own visibility -- zero wire sends, zero browse-mode side effects.
    const host = document.createElement("div");
    const { chat, container, ws } = makeChat({ getJumpHost: () => host });
    chat.setSession("s1"); // builds the manager on this host
    const btn = host.querySelector(".jump-to-bottom") as HTMLElement;
    expect(btn).not.toBeNull();
    const olderReqsOf = () =>
      ws.sent.map((s) => JSON.parse(s) as Sent).filter((m) => m.type === "loadOlder");
    let base = 0;
    Object.defineProperty(container, "scrollHeight", {
      configurable: true,
      get: () => base + container.children.length * 100,
    });
    const c = container as unknown as Geo;
    c.clientHeight = 300;
    // Windowed live session (a windowed FULL replay attests it).
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1", hasOlder: true, oldestIndex: 8 });
    // Paint the transcript tail through the live path.
    ws.fireMessage({ type: "userMessage", content: "older live tail" });
    ws.fireMessage({ type: "assistantMessage", content: "older answer" });
    base = 2000; // the tail lays out ~2000px tall (long messages)
    // Scroll up: pins drop, the top-zone edge requests the page.
    c.scrollTop = 500;
    container.dispatchEvent(new Event("scroll"));
    c.scrollTop = 100;
    container.dispatchEvent(new Event("scroll"));
    const reqs = olderReqsOf();
    expect(reqs).toHaveLength(1);
    expect(btn.hidden).toBe(false);
    // CLICK with the page still in flight: instant pin, no new wire frames.
    const sentBefore = ws.sent.length;
    btn.click();
    container.dispatchEvent(new Event("scroll")); // the browser's echo
    expect(ws.sent.length).toBe(sentBefore); // chrome only: zero sends
    expect(c.scrollTop).toBe(container.scrollHeight);
    expect(btn.hidden).toBe(true);
    expect(chat.sessionKindAtom()).toBeNull(); // the view kind rides sessionCreated only
    // The page lands on the jumped (pinned) view: anchoring restores to the
    // NEW bottom, the guarded echo swallows, follow survives.
    ws.fireMessage({
      type: "loadOlderResult", requestId: reqs[0]!.requestId, logId: "s1",
      entries: [{ source: "input", content: "older" }, { source: "llm", content: "answer" }],
      oldestIndex: 4, hasOlder: true,
    });
    container.dispatchEvent(new Event("scroll")); // the guarded restore echo
    expect(olderReqsOf()).toHaveLength(1); // no re-fire from any of this
    expect(c.scrollTop).toBe(container.scrollHeight); // STILL the bottom
    expect(btn.hidden).toBe(true); // follow pinned through the anchor
  });

  it("full replay attests the window; a delta for the same session keeps it; another session clears it", () => {
    const { chat, ws, olderReqs, scrollEdge } = armed();
    // Windowed FULL replay (sessionCreated fields, see attach.ts).
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1", hasOlder: true, oldestIndex: 8 });
    scrollEdge();
    const reqs = olderReqs();
    expect(reqs).toHaveLength(1);
    expect(reqs[0]!).toMatchObject({ logId: "s1", olderThan: 8 });
    ws.fireMessage({
      type: "loadOlderResult", requestId: reqs[0]!.requestId, logId: "s1",
      entries: [{ source: "input", content: "older live history" }], oldestIndex: 4, hasOlder: true,
    });
    // Delta reconnect for the SAME session: the held window head stays.
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1", replayDelta: true });
    scrollEdge();
    expect(olderReqs()[1]!).toMatchObject({ olderThan: 4 });
    // Attach to ANOTHER session with no window fields: the seam closes.
    ws.fireMessage({ type: "sessionCreated", sessionId: "s2" });
    chat.setSession("s2", false);
    scrollEdge();
    expect(olderReqs()).toHaveLength(2);
  });
});

// ── History image stub fetch ────────────────────────────────────────────────
// The chat layer owns the socket half: a rendered stub box asks for its ONE
// image through C2S fetchImage (correlated requestId, the transcribe
// doctrine), addressed by the transcript CURRENTLY on screen -- the attached
// session, or the cold log while one is open. S2C fetchImageResult settles
// the waiting box (pixels or honest error).

describe("history image stub fetch (ruling C)", () => {
  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const stubImgs = [{ mimeType: "image/png", omitted: true, bytes: 614_400, entryIndex: 4, imageIndex: 0 }];

  it("a stubbed replay frame fetches through the socket and swaps in pixels", async () => {
    const { chat, ws, container } = makeChat();
    chat.setSession("s1");
    ws.fireMessage({ type: "userMessage", sessionId: "s1", content: "x", images: stubImgs });
    expect(container.querySelector(".image-stub")).not.toBeNull();
    const req = ws.sent.map((s) => JSON.parse(s) as Sent).find((m) => m.type === "fetchImage");
    expect(req).toBeDefined();
    expect(req!.logId).toBe("s1");
    expect(req!.entryIndex).toBe(4);
    expect(req!.imageIndex).toBe(0);
    expect(typeof req!.requestId).toBe("number");
    ws.fireMessage({
      type: "fetchImageResult",
      requestId: req!.requestId,
      logId: "s1",
      entryIndex: 4,
      imageIndex: 0,
      image: { mimeType: "image/png", data: "QUJD" },
    });
    await flush();
    expect(container.querySelector("img")!.getAttribute("src")).toBe("data:image/png;base64,QUJD");
    expect(container.querySelector(".image-stub")).toBeNull();
  });

  it("an honest refusal lands in the box", async () => {
    const { chat, ws, container } = makeChat();
    chat.setSession("s1");
    ws.fireMessage({ type: "toolCall", sessionId: "s1", name: "read", args: "{}" });
    ws.fireMessage({ type: "toolResult", sessionId: "s1", name: "read", output: "pic", images: stubImgs });
    const req = ws.sent.map((s) => JSON.parse(s) as Sent).find((m) => m.type === "fetchImage")!;
    ws.fireMessage({
      type: "fetchImageResult",
      requestId: req!.requestId,
      logId: "s1",
      entryIndex: 4,
      imageIndex: 0,
      error: "entryIndex 4 is beyond log \"s1\" (2 entries).",
    });
    await flush();
    expect(container.querySelector(".image-stub")!.textContent).toContain("beyond log");
    expect(container.querySelector("img")).toBeNull();
  });

  it("while a cold log is on screen the fetch names the LOG, not the attached session", () => {
    const { chat, ws } = makeChat();
    chat.setSession("s1");
    ws.fireMessage({ type: "logViewed", logId: "cold-1", entries: [] });
    // The app renders the viewed entries through the manager; the fetch seam
    // must follow the transcript ON SCREEN (viewedLogId), not the socket's
    // attached session.
    chat.messageListAtom()!.renderLogEntries([
      { source: "input", content: "old", images: stubImgs },
    ] as never);
    const req = ws.sent.map((s) => JSON.parse(s) as Sent).find((m) => m.type === "fetchImage");
    expect(req!.logId).toBe("cold-1");
  });

  it("a stale or unknown requestId reply is silently dropped (transcribe doctrine)", async () => {
    const { chat, ws, container } = makeChat();
    chat.setSession("s1");
    ws.fireMessage({ type: "userMessage", sessionId: "s1", content: "x", images: stubImgs });
    ws.fireMessage({ type: "fetchImageResult", requestId: 9999, logId: "s1", image: { mimeType: "image/png", data: "QUJD" } });
    await flush();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".image-stub")).not.toBeNull();
  });

  it("a socket death rejects waiting boxes honestly (no dangling promise)", async () => {
    // The close routes through /verify; stub it and capture the 3 s
    // reconnect timer (the handshake suite's trick) so this costs no wall
    // clock and no network.
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({ status: 503 }) as Response) as unknown as typeof fetch;
    const timers = captureLongTimers();
    try {
      const { chat, ws, container } = makeChat();
      chat.setSession("s1");
      ws.fireMessage({ type: "userMessage", sessionId: "s1", content: "x", images: stubImgs });
      ws.onclose?.();
      await new Promise((r) => realSetTimeout(r, 0)); // let the verify settle
      expect(container.querySelector(".image-stub")!.textContent).toContain("connection closed");
      expect(container.querySelector("img")).toBeNull();
      timers.fireCaptured(); // drain the reconnect timer
    } finally {
      globalThis.fetch = originalFetch;
      timers.restore();
    }
  });
});
