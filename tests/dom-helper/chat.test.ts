// Tests for webui/ui/chat.ts message routing and connection lifecycle, run
// against the dom-helper preload's document + a per-test FakeWebSocket global.
// The chat opens a socket at construction; tests grab it from
// FakeWebSocket.instances (reset before each test by useFakeWebSocket()).

import { describe, it, expect, afterEach } from "bun:test";
import { createChat, type ChatController } from "@extensions/webui/ui/chat.ts";
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
    // Not 401 (server may just be down or verify pending) -> reconnect anyway.
    globalThis.fetch = (async () => ({ status: 503 }) as Response) as unknown as typeof fetch;
    try {
      const n0 = FakeWebSocket.instances.length;
      const { ws, chat } = makeChat();
      ws.fireOpen();
      ws.onclose?.();
      expect(chat.connectedAtom()).toBe(false);
      await new Promise((r) => setTimeout(r, 3100));
      expect(FakeWebSocket.instances.length).toBe(n0 + 2);
      chat.disconnect(); // cancels any further reconnects
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("network error during verify also schedules a reconnect", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("down");
    }) as unknown as typeof fetch;
    try {
      const n0 = FakeWebSocket.instances.length;
      const { ws } = makeChat();
      ws.fireOpen();
      ws.onclose?.();
      await new Promise((r) => setTimeout(r, 3100));
      expect(FakeWebSocket.instances.length).toBe(n0 + 2);
    } finally {
      globalThis.fetch = originalFetch;
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

  it("sessions updates profile/title/count for the active session", () => {
    const { ws, chat, callbacks } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    ws.fireMessage({
      type: "sessions",
      sessions: [
        { id: "other", profile: "p" },
        { id: "s1", profile: "coder", title: "renamed", userMessageCount: 3 },
      ],
    });
    expect(chat.currentProfileAtom()).toBe("coder");
    expect(chat.sessionTitleAtom()).toBe("renamed");
    expect(chat.getUserMessageCount()).toBe(3);
    expect(callbacks.sessionsUpdate).toHaveLength(1);
  });

  it("profiles and profileSwitched update atoms", () => {
    const { ws, chat } = makeChat();
    ws.fireMessage({ type: "sessionCreated", sessionId: "s1" });
    ws.fireMessage({ type: "profiles", profiles: { coder: { role: "r", body: "b", model: null } } });
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
    expect(container.querySelector(".token-usage")).not.toBeNull();
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
    expect(ws.lastSent()).toMatchObject({ type: "switchProfile", profileName: "coder", force: false });
    chat.switchProfile("coder", true);
    expect(ws.lastSent()).toMatchObject({ force: true });
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
