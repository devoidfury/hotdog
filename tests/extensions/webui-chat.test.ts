// Tests for webui/ui/chat.ts session plumbing. Only the container-facing
// paths are exercised here (createChat accepts the message-list element as
// an opaque handle), which keeps this runnable under Bun without a DOM.
// The rest of chat.ts is browser-only by project convention.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import {
  createChat,
  composerForView,
  ATTACHED_VIEW,
  MATCH_UNREACHABLE_NOTE,
  type ChatController,
  type CompletionItem,
  type TaskInfoWire,
} from "@extensions/webui/ui/chat.ts";

function makeContainer(): { events: string[]; removed: string[]; innerHTML: string } & Record<string, unknown> {
  const events: string[] = [];
  const removed: string[] = [];
  const container = {
    events,
    removed,
    innerHTML: "",
    addEventListener: (type: string) => {
      events.push(type);
    },
    removeEventListener: (type: string) => {
      removed.push(type);
    },
  };
  // message-list appends bubbles via appendChild; accumulate innerHTML on the
  // fake so tests can assert rendered output.
  (container as Record<string, unknown>).appendChild = (el: { innerHTML: string }) => {
    container.innerHTML += el.innerHTML;
  };
  return container;
}

describe("createChat.setSession", () => {
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
  });

  it("reuses the message list manager across session switches", () => {
    const container = makeContainer();
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => container as unknown as HTMLElement,
    });
    chat.setSession("session-a");
    chat.setSession("session-b");
    // A fresh manager per switch would re-attach the scroll listener each time;
    // the container must see it attached exactly once. (Counted, not compared
    // as a full array, so unrelated listeners do not break this.)
    expect(container.events.filter((e) => e === "scroll")).toHaveLength(1);
    expect(chat.sessionIdAtom()).toBe("session-b");
  });

  it("does not create a message list or set the session when the container is unmounted", () => {
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => null,
    });
    chat.setSession("session-a");
    expect(chat.sessionIdAtom()).toBeNull();
    expect(chat.messageListAtom()).toBeNull();
  });

  it("destroy detaches the scroll listener from the container", () => {
    const container = makeContainer();
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => container as unknown as HTMLElement,
    });
    chat.setSession("session-a");
    // handleAuthFailure drops the chat but the container outlives it; the
    // owner must be able to detach the manager's listener before that.
    chat.messageListAtom()?.destroy();
    expect(container.removed).toEqual(["scroll"]);
  });
});

// ── Push-to-talk client plumbing ───────────────────────────────────────────
// The WS is faked so transcribe/transcript correlation runs under Bun.

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

describe("createChat.transcribe", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  function makeChat(): { chat: ChatController; ws: FakeWebSocket } {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => null,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    return { chat, ws };
  }

  it("sends a transcribe request and resolves with the transcript text", async () => {
    const { chat, ws } = makeChat();
    const p = chat.transcribe("audio/webm", "aGk=");
    const req = ws.sent[ws.sent.length - 1]!;
    expect(req.type).toBe("transcribe");
    expect(req.mimeType).toBe("audio/webm");
    expect(req.data).toBe("aGk=");
    ws.emit({ type: "transcript", id: req.id, ok: true, text: "hello world" });
    expect(await p).toBe("hello world");
  });

  it("rejects with the server error on ok:false", async () => {
    const { chat, ws } = makeChat();
    const p = chat.transcribe("audio/webm", "aGk=");
    const req = ws.sent[ws.sent.length - 1]!;
    ws.emit({ type: "transcript", id: req.id, ok: false, error: "audio too large" });
    await expect(p).rejects.toThrow("audio too large");
  });

  it("rejects pending transcribes when the socket closes", async () => {
    const { chat, ws } = makeChat();
    const p = chat.transcribe("audio/webm", "aGk=");
    ws.close();
    await expect(p).rejects.toThrow("connection closed");
  });

  it("ignores transcript replies with unknown ids", async () => {
    const { chat, ws } = makeChat();
    ws.emit({ type: "transcript", id: "stt-never-sent", ok: true, text: "ghost" });
    const p = chat.transcribe("audio/webm", "aGk=");
    const req = ws.sent[ws.sent.length - 1]!;
    ws.emit({ type: "transcript", id: req.id, ok: true, text: "real" });
    expect(await p).toBe("real");
  });

  it("tracks sttEnabled from the sessionCreated payload", () => {
    const { chat, ws } = makeChat();
    ws.emit({ type: "sessionCreated", sessionId: "s1", sttEnabled: true });
    expect(chat.sttEnabledAtom()).toBe(true);
    ws.emit({ type: "sessionCreated", sessionId: "s2" });
    expect(chat.sttEnabledAtom()).toBe(false);
  });

  it("follows the sttEnabled push a live endpoint write sends", () => {
    // The channel half of the affordance: sessionCreated seeds the flag (the row
    // above), and an sttUrl/sttModel write that moves enabledness pushes the
    // flip afterwards. This double needs a mounted list: a frame with nowhere to
    // render is dropped before the sessionState cases, and the push is delivered
    // cross-session (server-wide flag, no per-session variant to re-target).
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const container = makeContainer();
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => container as unknown as HTMLElement,
      onSessionCreated: (d) => chat!.setSession(d.sessionId, d.replayDelta === true),
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;

    ws.emit({ type: "sessionCreated", sessionId: "s1", sttEnabled: false });
    expect(chat.sttEnabledAtom()).toBe(false);

    ws.emit({ type: "sessionState", sessionId: "s1", key: "sttEnabled", value: true });
    expect(chat.sttEnabledAtom()).toBe(true);

    // A flip addressed to a different open session is the same server-wide truth.
    ws.emit({ type: "sessionState", sessionId: "s2", key: "sttEnabled", value: false });
    expect(chat.sttEnabledAtom()).toBe(false);

    // A sibling key on the same channel never moves it.
    ws.emit({ type: "sessionState", sessionId: "s1", key: "sttEnabled", value: true });
    ws.emit({ type: "sessionState", sessionId: "s1", key: "title", value: "renamed" });
    expect(chat.sttEnabledAtom()).toBe(true);
  });

  it("tracks the tool-exec posture from the sessionCreated payload", () => {
    const { chat, ws } = makeChat();
    expect(chat.toolExecAtom()).toBe("");
    ws.emit({ type: "sessionCreated", sessionId: "s1", toolExec: "worker (fence: none)" });
    expect(chat.toolExecAtom()).toBe("worker (fence: none)");
    ws.emit({
      type: "sessionCreated",
      sessionId: "s2",
      toolExec: "worker (fence: none) [degraded: broker respawn cap]",
    });
    // The strip reads the atom verbatim, so a degraded plane is visible.
    expect(chat.toolExecAtom()).toContain("degraded");
  });
});

// ── Outbound sidebar frames ─────────────────────────────────────────────────

describe("createChat.dismissSession", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  it("sends exactly a dismissSession frame for the id", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => null,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    chat.dismissSession("sid-7");
    // The dismiss frame is the only thing on the wire: the handler's
    // SESSIONS broadcast + targeted logRowAdded push (server side) are the
    // sidebar reconcile, so unlike deleteSession no optimistic re-list
    // rides out.
    expect(ws.sent).toEqual([{ type: "dismissSession", sessionId: "sid-7" }]);
  });
});

// ── Subagent ticker ─────────────────────────────────────────────────────────
// taskList/taskUpdate are handled before the message-list/session guard, so
// a container-less chat exercises the ticker over the faked socket.
// NOTE: tasksAtom is module-level state shared across createChat()
// instances; afterEach clears it via clearTasks() so runs cannot contaminate
// each other.

function taskInfo(taskId: string, status = "running"): TaskInfoWire {
  return {
    taskId,
    description: `task ${taskId}`,
    sessionId: null,
    status,
    createdAt: 1,
    startedAt: null,
    endedAt: null,
    activeMs: 0,
    inRun: false,
    turnStartedAt: null,
  };
}

describe("createChat subagent ticker", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.clearTasks();
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  function makeTaskChat(): { chat: ChatController; ws: FakeWebSocket } {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => null,
    });
    // Belt for the shared-registry serial runs: wipe any residue another
    // file left in the module-level task state before this test's exact
    // assertions run.
    chat.clearTasks();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    return { chat, ws };
  }

  it("taskList replaces tasksAtom wholesale", () => {
    const { chat, ws } = makeTaskChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("a"), taskInfo("b")] });
    expect(chat.tasksAtom().map((t) => t.taskId)).toEqual(["a", "b"]);
    ws.emit({ type: "taskList", tasks: [taskInfo("c")] });
    expect(chat.tasksAtom().map((t) => t.taskId)).toEqual(["c"]);
  });

  it("a WORKER attach's scoped taskList does not re-attest the manager's board", () => {
    const { chat, ws } = makeTaskChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("a")] });
    // The worker-row attach (owner ruling 2026-11-18): its burst ends with
    // the socket's task snapshot, scoped to the ATTACHED id -- and task rows
    // carry the MANAGER's id, so it ships empty. Accepting it deletes the
    // sidebar's Subagents board, the menu that hops between siblings.
    ws.emit({ type: "sessionCreated", sessionId: "w-1", kind: "subagent", parentSessionId: "m-1" });
    expect(chat.sessionViewAtom().workerView).toBe(true);
    ws.emit({ type: "taskList", tasks: [] });
    expect(chat.tasksAtom().map((t) => t.taskId)).toEqual(["a"]);
    // The guard rides the worker view ONLY: a plain attach re-attests the
    // board wholesale (empty lists included) exactly as before.
    ws.emit({ type: "sessionCreated", sessionId: "m-1" });
    ws.emit({ type: "taskList", tasks: [taskInfo("c")] });
    expect(chat.tasksAtom().map((t) => t.taskId)).toEqual(["c"]);
    ws.emit({ type: "taskList", tasks: [] });
    expect(chat.tasksAtom()).toHaveLength(0);
  });

  it("taskUpdate inserts a new task and replaces one with the same id", () => {
    const { chat, ws } = makeTaskChat();
    ws.emit({ type: "taskUpdate", task: taskInfo("a", "running") });
    expect(chat.tasksAtom()).toHaveLength(1);
    ws.emit({ type: "taskUpdate", task: taskInfo("b") });
    expect(chat.tasksAtom().map((t) => t.taskId)).toEqual(["a", "b"]);
    ws.emit({ type: "taskUpdate", task: taskInfo("a", "done") });
    expect(chat.tasksAtom()).toHaveLength(2);
    expect(chat.tasksAtom()[0]!.status).toBe("done");
  });

  it("sessionCreated records the view KIND and the delegating parent", () => {
    const { chat, ws } = makeTaskChat();
    ws.emit({ type: "sessionCreated", sessionId: "s1" });
    expect(chat.sessionKindAtom()).toBeNull();
    expect(chat.sessionParentAtom()).toBeNull();
    ws.emit({
      type: "sessionCreated",
      sessionId: "w1",
      kind: "subagent",
      parentSessionId: "s1",
    });
    // The chrome reads the pane's kind straight off the attach (B4: the
    // worker-session view IS the pane).
    expect(chat.sessionKindAtom()).toBe("subagent");
    expect(chat.sessionParentAtom()).toBe("s1");
  });

  it("a refused taskControl reaches the app callback, verbatim", () => {
    const seen: Array<Record<string, unknown>> = [];
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => null,
      onTaskControl: (r) => seen.push({ ...r }),
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.emit({ type: "taskControl", taskId: "t1", action: "followup", ok: false, error: "no live turn" });
    expect(seen).toEqual([
      { type: "taskControl", taskId: "t1", action: "followup", ok: false, error: "no live turn" },
    ]);
    // The refusal paints NOTHING: the buffer and the system-row retract
    // dance are gone -- the transcript never echoed the steer.
  });

  it("clearTasks empties the ticker", () => {
    const { chat, ws } = makeTaskChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("a")] });
    chat.clearTasks();
    expect(chat.tasksAtom()).toEqual([]);
  });
});

// ── Slash-command completions ───────────────────────────────────────────────

describe("createChat.requestCompletions", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  function makeChat(withSession: boolean): { chat: ChatController; ws: FakeWebSocket } {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const container = makeContainer();
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () =>
        withSession ? (container as unknown as HTMLElement) : null,
    });
    if (withSession) chat.setSession("s1");
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    return { chat, ws };
  }

  it("is a no-op without an active session", () => {
    const { chat, ws } = makeChat(false);
    const calls: [CompletionItem[], string][] = [];
    chat.requestCompletions("/fin", 4, (o, p) => calls.push([o, p]));
    expect(ws.sent).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("sends incrementing requestIds and fires the callback once for the match", () => {
    const { chat, ws } = makeChat(true);
    const calls: [CompletionItem[], string][] = [];
    const cb = (o: CompletionItem[], p: string) => calls.push([o, p]);
    chat.requestCompletions("/fin", 4, cb);
    chat.requestCompletions("/find ", 6, cb);
    const completes = ws.sent.filter((m) => m.type === "complete");
    expect(completes).toHaveLength(2);
    expect(completes[0]!.requestId).toBe(1);
    expect(completes[1]!.requestId).toBe(2);

    // Stale requestId: superseded by the second request, must be dropped.
    ws.emit({ type: "completions", requestId: 1, options: [{ value: "--x" }], prefix: "/fin" });
    expect(calls).toHaveLength(0);

    // Matching reply with options/prefix absent: defaults to [] and "".
    ws.emit({ type: "completions", requestId: 2 });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toEqual([]);
    expect(calls[0]![1]).toBe("");

    // Callback is one-shot: a second reply with the same id is ignored.
    ws.emit({ type: "completions", requestId: 2, options: [{ value: "dup" }] });
    expect(calls).toHaveLength(1);

    // A matching reply with real payload fires the new callback verbatim.
    chat.requestCompletions("/mod", 4, cb);
    expect(ws.sent[ws.sent.length - 1]!.requestId).toBe(3);
    ws.emit({ type: "completions", requestId: 3, options: [{ value: "m1" }], prefix: "/mod" });
    expect(calls).toHaveLength(2);
    expect(calls[1]![0]).toEqual([{ value: "m1" }]);
    expect(calls[1]![1]).toBe("/mod");
  });
});

// ── systemMessage routing into the message list ─────────────────────────────

describe("createChat systemMessage", () => {
  const RealWebSocket = globalThis.WebSocket;
  const realDocument = (globalThis as Record<string, unknown>).document;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
    (globalThis as Record<string, unknown>).document = realDocument;
  });

  it("routes a server systemMessage into the message list", () => {
    // handleSystemMessage builds its bubble via document.createElement; a
    // minimal shim plus the fake container's appendChild observes it.
    (globalThis as Record<string, unknown>).document = {
      createElement: () => ({ className: "", innerHTML: "" }),
    };
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const container = makeContainer();
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => container as unknown as HTMLElement,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    chat.setSession("s1");
    ws.emit({ type: "systemMessage", content: "all systems go" });
    expect(container.innerHTML).toContain("all systems go");
    expect(container.innerHTML).toContain("System");
  });
});

// ── connect() / reconnect / disconnect ──────────────────────────────────────

describe("createChat.connect", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  it("closes the existing socket before opening a new one", () => {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => null,
    });
    const first = FakeWebSocket.instances[0]!;
    chat.connect();
    expect(first.readyState).toBe(3);
    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1]).not.toBe(first);
  });

  it("survives a throwing WebSocket constructor and reports auth failure without a token", () => {
    class ThrowingWebSocket extends FakeWebSocket {
      constructor(url: string) {
        super(url);
        throw new Error("connect refused");
      }
    }
    globalThis.WebSocket = ThrowingWebSocket as unknown as typeof WebSocket;
    let authFailures = 0;
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => null,
      onAuthFailure: () => authFailures++,
    });
    expect(chat.connectedAtom()).toBe(false);
    expect(authFailures).toBe(1);
  });
});

describe("createChat.disconnect with a pending reconnect", () => {
  const RealWebSocket = globalThis.WebSocket;
  const RealFetch = globalThis.fetch;
  let chat: ChatController | null = null;
  let stSpy: ReturnType<typeof spyOn> | null = null;
  let ctSpy: ReturnType<typeof spyOn> | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    stSpy?.mockRestore();
    ctSpy?.mockRestore();
    stSpy = ctSpy = null;
    globalThis.fetch = RealFetch;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  it("clears the scheduled reconnect timer", async () => {
    stSpy = spyOn(globalThis, "setTimeout");
    ctSpy = spyOn(globalThis, "clearTimeout");
    // Non-401 verify outcome: the chat schedules a reconnect instead of
    // giving up. (fetch is stubbed, so no network is touched.)
    globalThis.fetch = (async () => ({ status: 200 })) as unknown as typeof fetch;
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    chat = createChat({
      token: "tok",
      host: "localhost",
      getMessageListContainer: () => null,
    });
    const ws = FakeWebSocket.instances[0]!;
    ws.close(); // onclose -> verifyTokenAndReconnect -> fetch ok -> scheduleReconnect
    await new Promise((r) => setTimeout(r, 0)); // drain the fetch promise chain

    const callIdx = stSpy.mock.calls.findIndex((c: readonly unknown[]) => c[1] === 3000);
    expect(callIdx).toBeGreaterThanOrEqual(0);
    const timerId = stSpy.mock.results[callIdx]!.value;

    chat.disconnect();
    expect(ctSpy.mock.calls.some((c: readonly unknown[]) => c[0] === timerId)).toBe(true);

    // Past the reconnect delay: no new socket was constructed.
    await new Promise((r) => setTimeout(r, 20));
    expect(FakeWebSocket.instances).toHaveLength(1);
  });
});

// ── Task controls and profile switch guards ─────────────────────────────────

describe("createChat task controls", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  function makeChat(): { chat: ChatController; ws: FakeWebSocket } {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => null,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    return { chat, ws };
  }

  it("switchProfile without a session sends nothing", () => {
    const { chat, ws } = makeChat();
    chat.switchProfile("x");
    expect(ws.sent).toEqual([]);
  });

  it("taskFollowup ships exactly one frame -- no echo ledger, no buffer", () => {
    const { chat, ws } = makeChat();
    chat.taskFollowup("t1", "  steer left  ");
    // The drained steer reaches the watcher through the worker's own
    // USER_MESSAGE event (B3's live tail), exactly once; the client echoes
    // nothing and tracks nothing to retract.
    expect(ws.sent).toEqual([{ type: "taskFollowup", taskId: "t1", message: "steer left" }]);
    chat.taskFollowup("t1", "   ");
    chat.taskFollowup("", "x");
    expect(ws.sent).toHaveLength(1);
  });

  it("interruptTask ships taskInterrupt; a blank id sends nothing", () => {
    const { chat, ws } = makeChat();
    chat.interruptTask("");
    expect(ws.sent).toEqual([]);
    chat.interruptTask("t9");
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: "taskInterrupt", taskId: "t9" });
  });

});

// ── Log-view suppression (Feature B bugfix) ───────────────────────────────
// While a cold log is on screen the socket stays attached to its live
// session, and live conversation events keep arriving. They must NOT render
// into the log window, and they must NOT advance the replay-cursor
// accounting: the cursor still describes the live transcript (the events
// rendered nowhere), so the next delta attach re-delivers exactly the
// suppressed tail -- once, no duplicates, no gaps.

describe("createChat log-view suppression", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  function makeSuppressionChat(): { chat: ChatController; ws: FakeWebSocket; workingChanges: { n: number } } {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const container = makeContainer();
    const workingChanges = { n: 0 };
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => container as unknown as HTMLElement,
      // Same wiring as app.tsx: the attach path owns the transcript.
      onSessionCreated: (d) => chat!.setSession(d.sessionId, d.replayDelta === true),
      onWorkingMapChange: () => workingChanges.n++,
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    return { chat, ws, workingChanges };
  }

  /** Live attach with a cursor report: transcript ends exactly at the cursor. */
  function attachAtCursor(ws: FakeWebSocket, cursor: number): void {
    ws.emit({ type: "sessionCreated", sessionId: "s1" });
    ws.emit({ type: "userMessage", sessionId: "s1", content: "seed" });
    ws.emit({ type: "sessionState", sessionId: "s1", key: "cursor", value: cursor });
  }

  /** Enter log view and wait for the server's logViewed frame. */
  function enterLogView(ws: FakeWebSocket, logId = "log-9"): void {
    chat!.viewLog(logId);
    ws.emit({ type: "logViewed", logId, entries: [] });
  }

  /** Spies on every transcript write the suppression must cover. */
  function spyTranscriptWrites() {
    const list = chat!.messageListAtom()!;
    return {
      userMessage: spyOn(list, "handleUserMessage").mockImplementation(() => {}),
      assistantMessage: spyOn(list, "handleAssistantMessage").mockImplementation(() => {}),
      streamingChunk: spyOn(list, "handleStreamingChunk").mockImplementation(() => {}),
      systemMessage: spyOn(list, "handleSystemMessage").mockImplementation(() => {}),
      tokenUsage: spyOn(list, "handleTokenUsage").mockImplementation(() => {}),
      error: spyOn(list, "handleError").mockImplementation(() => {}),
    };
  }

  it("drops live transcript events while a cold log is open, keeps sidebar state live", () => {
    const { chat, ws, workingChanges } = makeSuppressionChat();
    attachAtCursor(ws, 2);
    enterLogView(ws);
    const spies = spyTranscriptWrites();

    ws.emit({ type: "assistantMessage", sessionId: "s1", content: "suppressed" });
    ws.emit({ type: "streamingChunk", sessionId: "s1", content: "tok" });
    ws.emit({ type: "systemMessage", content: "server notice" });
    ws.emit({ type: "tokenUsage", promptTokens: 1, cachedTokens: 0, completionTokens: 1, totalTokens: 2 });
    ws.emit({ type: "error", message: "boom" });

    expect(spies.assistantMessage).not.toHaveBeenCalled();
    expect(spies.streamingChunk).not.toHaveBeenCalled();
    expect(spies.systemMessage).not.toHaveBeenCalled();
    expect(spies.tokenUsage).not.toHaveBeenCalled();
    expect(spies.error).not.toHaveBeenCalled();
    expect(workingChanges.n).toBe(0);

    // The spinner plumbing is NOT suppressed: working pushes keep updating
    // the per-session map, the header atom, and the app's re-poll hook.
    ws.emit({ type: "sessionState", sessionId: "s1", key: "working", value: true });
    expect(chat.sessionWorkingMap.get("s1")).toBe(true);
    expect(chat.workingAtom()).toBe(true);
    expect(workingChanges.n).toBe(1);
  });

  it("every switch branch routes through the sink while a log is open", () => {
    // Pins the FULL MessageListManager surface: any transcript-writing case
    // added to the dispatch later must resolve to the no-op sink, not the
    // live manager. One event per switch arm (chat.ts dispatch), each with a
    // matching sessionId so it clears the orphan guard and reaches the sink.
    const { chat, ws } = makeSuppressionChat();
    attachAtCursor(ws, 2);
    enterLogView(ws);
    const list = chat.messageListAtom()!;
    const all = [
      "handleUserMessage", "handleAssistantMessage", "handleThinking",
      "handleToolCall", "handleToolResult", "handleCompacting",
      "handleCommandResult", "handleQuestion", "handleQuestionAnswered",
      "handleStreamingChunk", "handleStreamingReasoningChunk", "handleStreamReset",
      "handleTaskProgress", "handleTokenUsage", "handleCompactionResult",
      "handleError", "addSystemMessage",
    ] as const;
    const spies = all.map((m) => spyOn(list, m).mockImplementation(() => {}));

    ws.emit({ type: "userMessage", sessionId: "s1", content: "u" });
    ws.emit({ type: "assistantMessage", sessionId: "s1", content: "a" });
    ws.emit({ type: "thinking", sessionId: "s1", content: "t" });
    ws.emit({ type: "toolCall", sessionId: "s1", name: "bash", toolCallId: "c1", arguments: "{}" });
    ws.emit({ type: "toolResult", sessionId: "s1", toolCallId: "c1", content: "ok" });
    ws.emit({ type: "compacting", sessionId: "s1" });
    ws.emit({ type: "commandResult", sessionId: "s1", content: "cmd" });
    ws.emit({ type: "question", sessionId: "s1", toolCallId: "q1", questions: [] });
    ws.emit({ type: "questionAnswered", sessionId: "s1", toolCallId: "q1", answers: [] });
    ws.emit({ type: "streamingChunk", sessionId: "s1", content: "c" });
    ws.emit({ type: "streamingReasoningChunk", sessionId: "s1", content: "r" });
    ws.emit({ type: "streamReset", sessionId: "s1" });
    ws.emit({ type: "taskProgress", sessionId: "s1", taskId: "t1", activity: [] });
    ws.emit({ type: "tokenUsage", sessionId: "s1", promptTokens: 1, cachedTokens: 0, completionTokens: 1, totalTokens: 2 });
    ws.emit({ type: "compactionResult", sessionId: "s1", content: "summary" });
    ws.emit({ type: "error", sessionId: "s1", message: "boom" });
    ws.emit({ type: "systemMessage", sessionId: "s1", content: "sys" });

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("suppressed events leave the cursor clean: the reconnect delta replays exactly the tail", () => {
    const { chat, ws } = makeSuppressionChat();
    attachAtCursor(ws, 5);
    enterLogView(ws);

    // Three suppressed conversation events.
    ws.emit({ type: "assistantMessage", sessionId: "s1", content: "a" });
    ws.emit({ type: "userMessage", sessionId: "s1", content: "b" });
    ws.emit({ type: "systemMessage", content: "c" });

    // The reconnect URL must STILL carry cursor=5: the client transcript for
    // the live session still ends exactly there, so the server's delta
    // attach re-delivers exactly the suppressed tail, once.
    chat.disconnect();
    chat.connect();
    const params = new URL(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.url).searchParams;
    expect(params.get("session")).toBe("s1");
    expect(params.get("cursor")).toBe("5");
  });

  it("switch-back ends suppression; the replayed tail renders once, live events dirty again", () => {
    const { chat, ws } = makeSuppressionChat();
    attachAtCursor(ws, 5);
    enterLogView(ws);
    const spies = spyTranscriptWrites();

    ws.emit({ type: "assistantMessage", sessionId: "s1", content: "suppressed" });
    expect(spies.assistantMessage).not.toHaveBeenCalled();

    // Switch back (the app's onCloseLogView path): the switchSession frame
    // goes out (followed by the sidebar refresh), and the server answers
    // with a fresh attach + replay.
    chat.switchSession("s1");
    expect(ws.sent).toContainEqual({ type: "switchSession", sessionId: "s1" });
    ws.emit({ type: "sessionCreated", sessionId: "s1" });
    ws.emit({ type: "assistantMessage", sessionId: "s1", content: "suppressed" });
    // Rendered exactly once -- on the replay, not on the live push.
    expect(spies.assistantMessage).toHaveBeenCalledTimes(1);

    // After the switch-back attach, live conversation events are visible and
    // dirty the transcript again (full replay on the next reconnect).
    ws.emit({ type: "sessionState", sessionId: "s1", key: "cursor", value: 6 });
    ws.emit({ type: "userMessage", sessionId: "s1", content: "fresh" });
    expect(spies.userMessage).toHaveBeenCalledTimes(1);
    chat.disconnect();
    chat.connect();
    expect(
      new URL(FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!.url).searchParams.get("cursor"),
    ).toBeNull();
  });

  it("deleting the viewed log ends suppression; deleting another log does not", () => {
    const { ws } = makeSuppressionChat();
    attachAtCursor(ws, 2);
    enterLogView(ws);
    const spies = spyTranscriptWrites();

    ws.emit({ type: "logDeleted", logId: "other-log" });
    ws.emit({ type: "assistantMessage", sessionId: "s1", content: "still hidden" });
    expect(spies.assistantMessage).not.toHaveBeenCalled();

    ws.emit({ type: "logDeleted", logId: "log-9" });
    ws.emit({ type: "assistantMessage", sessionId: "s1", content: "visible again" });
    expect(spies.assistantMessage).toHaveBeenCalledTimes(1);
  });
});

// ── Reconnect identity (session durability part 3) ────────────────────────
// The client remembers its session across socket drops (sessionStorage in the
// browser; the in-memory fallback under Bun) and rides it on the upgrade
// URL, with its replay cursor only when the transcript is clean.

describe("createChat reconnect identity", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;
  let createdCalls: Array<{ sessionId: string; replayDelta?: boolean }> = [];

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    createdCalls = [];
    globalThis.WebSocket = RealWebSocket;
  });

  function makeChat(): ChatController {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => makeContainer() as unknown as HTMLElement,
      // Same wiring as app.tsx: setSession keeps the transcript on deltas.
      onSessionCreated: (d) => {
        createdCalls.push(d);
        chat!.setSession(d.sessionId, d.replayDelta === true);
      },
    });
    return chat!;
  }

  function lastWs(): FakeWebSocket {
    return FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
  }

  /** The attach's replay burst: sessionCreated, a delta message, cursor. */
  function emitDeltaAttach(ws: FakeWebSocket, sessionId: string, cursor: number): void {
    ws.emit({ type: "sessionCreated", sessionId, replayDelta: true });
    ws.emit({ type: "userMessage", sessionId, content: "one" });
    ws.emit({ type: "sessionState", sessionId, key: "cursor", value: cursor });
  }

  it("first connect carries no session; a clean transcript reconnects with the cursor", () => {
    makeChat();
    const ws1 = lastWs();
    expect(new URL(ws1.url).searchParams.get("session")).toBeNull();

    emitDeltaAttach(ws1, "s1", 2);
    expect(createdCalls).toEqual([{ sessionId: "s1", replayDelta: true }]);

    chat!.disconnect();
    chat!.connect();
    const ws2 = lastWs();
    const p2 = new URL(ws2.url).searchParams;
    expect(p2.get("session")).toBe("s1");
    expect(p2.get("cursor")).toBe("2");
  });

  it("omits the cursor when a live event dirtied the transcript", () => {
    makeChat();
    const ws1 = lastWs();
    emitDeltaAttach(ws1, "s1", 2);

    // A live event after the cursor report: the stored cursor no longer
    // matches the transcript, so the next reconnect takes a full replay.
    ws1.emit({ type: "assistantMessage", sessionId: "s1", content: "hi" });

    chat!.disconnect();
    chat!.connect();
    const p2 = new URL(lastWs().url).searchParams;
    expect(p2.get("session")).toBe("s1");
    expect(p2.get("cursor")).toBeNull();
  });

  it("a live streamingToolCall preview leaves the cursor clean (transient render state)", () => {
    makeChat();
    const ws1 = lastWs();
    emitDeltaAttach(ws1, "s1", 2);
    // The preview renders in-flight args and appends NOTHING to the
    // transcript (the committed toolCall frame is the durable row, and that
    // one marks the cursor dirty), so the stored cursor still describes it.
    ws1.emit({ type: "streamingToolCall", sessionId: "s1", index: 0, name: "bash", args: '{"comm' });

    chat!.disconnect();
    chat!.connect();
    const p2 = new URL(lastWs().url).searchParams;
    expect(p2.get("session")).toBe("s1");
    expect(p2.get("cursor")).toBe("2");
  });

  it("replay-burst events do not dirty the transcript", () => {
    makeChat();
    const ws1 = lastWs();

    // The whole burst, including the tail's own events, stays clean.
    ws1.emit({ type: "sessionCreated", sessionId: "s1", replayDelta: true });
    ws1.emit({ type: "assistantMessage", sessionId: "s1", content: "tail" });
    ws1.emit({ type: "sessionState", sessionId: "s1", key: "cursor", value: 3 });

    chat!.disconnect();
    chat!.connect();
    const p2 = new URL(lastWs().url).searchParams;
    expect(p2.get("session")).toBe("s1");
    expect(p2.get("cursor")).toBe("3");
  });

  it("a full attach (no replayDelta) still reconnects with the cursor once clean", () => {
    makeChat();
    const ws1 = lastWs();

    ws1.emit({ type: "sessionCreated", sessionId: "s1" });
    expect(createdCalls).toEqual([{ sessionId: "s1", replayDelta: false }]);
    ws1.emit({ type: "userMessage", sessionId: "s1", content: "one" });
    ws1.emit({ type: "sessionState", sessionId: "s1", key: "cursor", value: 1 });

    chat!.disconnect();
    chat!.connect();
    const p2 = new URL(lastWs().url).searchParams;
    expect(p2.get("session")).toBe("s1");
    expect(p2.get("cursor")).toBe("1");
  });

  it("a deleted session drops the remembered id (default attach next)", () => {
    makeChat();
    const ws1 = lastWs();
    ws1.emit({ type: "sessionCreated", sessionId: "s1" });
    ws1.emit({ type: "sessionState", sessionId: "s1", key: "cursor", value: 1 });
    ws1.emit({ type: "sessionDeleted", sessionId: "s1" });

    chat!.disconnect();
    chat!.connect();
    expect(new URL(lastWs().url).searchParams.get("session")).toBeNull();
  });
});

// ── Session view state (attached / peeking / observing) ───────────────────
// The ONE named state (owner ruling 2026-11-18): a peek NEVER moves the socket, the
// composer's posture is a pure function of the state, take-over is exactly
// one attach, and the search seek paginates the loadOlder seam until the
// match renders -- terminating on found / exhausted / refused, never
// looping.

describe("composerForView (pure composer capability)", () => {
  const attached = { ...ATTACHED_VIEW, attachedId: "s1" };

  it("attached: interactive composer, everything offered", () => {
    const c = composerForView(attached);
    expect(c.enabled).toBe(true);
    expect(c.placeholder).toBe("Type a message...");
    expect(c.actions).toEqual({ send: true, stop: true, attach: true, takeover: false });
  });

  it("attached worker row: live steer, no attachments", () => {
    const c = composerForView({ ...attached, workerView: true });
    expect(c.enabled).toBe(true);
    expect(c.placeholder).toBe("Steer the subagent...");
    expect(c.actions.send).toBe(true);
    expect(c.actions.attach).toBe(false);
    expect(c.actions.takeover).toBe(false);
  });

  it("peeking: locked, but the explicit claim is offered", () => {
    const c = composerForView({
      mode: "peeking",
      attachedId: "s1",
      subjectId: "s2",
      workerView: false,
      note: null,
    });
    expect(c.enabled).toBe(false);
    expect(c.actions.send).toBe(false);
    expect(c.actions.attach).toBe(false);
    expect(c.actions.takeover).toBe(true);
  });

  it("observing: locked, nothing offered (a cold log cannot be claimed)", () => {
    const c = composerForView({
      mode: "observing",
      attachedId: "s1",
      subjectId: "log-9",
      workerView: false,
      note: null,
    });
    expect(c.enabled).toBe(false);
    expect(c.actions.takeover).toBe(false);
  });
});

describe("createChat session view state (wire side)", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  /** A chat parked on a live interactive attach (cursor reported, sent
   *  log cleared so each test counts only its own frames). */
  function makeViewChat(): { ws: FakeWebSocket } {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const container = makeContainer();
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => container as unknown as HTMLElement,
      onSessionCreated: (d) => chat!.setSession(d.sessionId, d.replayDelta === true),
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.emit({ type: "sessionCreated", sessionId: "manager-1" });
    ws.emit({ type: "sessionState", sessionId: "manager-1", key: "cursor", value: 3 });
    ws.sent.length = 0;
    return { ws };
  }

  const sentOfType = (ws: FakeWebSocket, type: string): Array<Record<string, unknown>> =>
    ws.sent.filter((m) => m.type === type);

  it("NEGATIVE (a): peeking a live session does not change the manager's attached session", () => {
    const { ws } = makeViewChat();
    chat!.peekSession("live-2");
    // The peek rides the durable-log READ; the attach frame never fires.
    expect(sentOfType(ws, "viewLog")).toEqual([{ type: "viewLog", logId: "live-2" }]);
    expect(sentOfType(ws, "switchSession")).toHaveLength(0);
    ws.emit({ type: "logViewed", logId: "live-2", entries: [] });
    const view = chat!.sessionViewAtom();
    expect(view.mode).toBe("peeking");
    expect(view.subjectId).toBe("live-2");
    expect(view.attachedId).toBe("manager-1");
    // The manager itself never moved.
    expect(chat!.sessionIdAtom()).toBe("manager-1");
  });

  it("NEGATIVE (b): composer disabled in peeking AND observing, enabled in attached", () => {
    const { ws } = makeViewChat();
    expect(composerForView(chat!.sessionViewAtom()).enabled).toBe(true); // attached
    chat!.viewLog("log-9");
    ws.emit({ type: "logViewed", logId: "log-9", entries: [] });
    expect(chat!.sessionViewAtom().mode).toBe("observing");
    expect(composerForView(chat!.sessionViewAtom()).enabled).toBe(false);
    chat!.peekSession("live-2");
    ws.emit({ type: "logViewed", logId: "live-2", entries: [] });
    expect(chat!.sessionViewAtom().mode).toBe("peeking");
    expect(composerForView(chat!.sessionViewAtom()).enabled).toBe(false);
    // The close control's optimistic flip + the re-attach unlock it again.
    chat!.clearView();
    ws.emit({ type: "sessionCreated", sessionId: "manager-1" });
    ws.emit({ type: "sessionState", sessionId: "manager-1", key: "cursor", value: 4 });
    expect(chat!.sessionViewAtom().mode).toBe("attached");
    expect(chat!.sessionViewAtom().subjectId).toBeNull();
    expect(composerForView(chat!.sessionViewAtom()).enabled).toBe(true);
  });

  it("worker-row attach stays ATTACHED with the steer capability (not a lock)", () => {
    makeViewChat();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.sent.length = 0;
    ws.emit({
      type: "sessionCreated",
      sessionId: "worker-1",
      kind: "subagent",
      parentSessionId: "manager-1",
    });
    const view = chat!.sessionViewAtom();
    expect(view.mode).toBe("attached");
    expect(view.workerView).toBe(true);
    const c = composerForView(view);
    expect(c.enabled).toBe(true);
    expect(c.placeholder).toBe("Steer the subagent...");
  });

  it("NEGATIVE (c): take-over performs exactly one attach and returns to attached", () => {
    const { ws } = makeViewChat();
    chat!.peekSession("live-2");
    ws.emit({ type: "logViewed", logId: "live-2", entries: [] });
    ws.sent.length = 0;
    chat!.takeOver();
    chat!.takeOver(); // a double-click cannot double-attach
    expect(sentOfType(ws, "switchSession")).toEqual([
      { type: "switchSession", sessionId: "live-2" },
    ]);
    ws.emit({ type: "sessionCreated", sessionId: "live-2" });
    ws.emit({ type: "sessionState", sessionId: "live-2", key: "cursor", value: 9 });
    const view = chat!.sessionViewAtom();
    expect(view.mode).toBe("attached");
    expect(view.attachedId).toBe("live-2");
    expect(view.subjectId).toBeNull();
    expect(composerForView(view).enabled).toBe(true);
  });

  it("take-over is a no-op outside peeking (an observing view cannot claim)", () => {
    const { ws } = makeViewChat();
    chat!.viewLog("log-9");
    ws.emit({ type: "logViewed", logId: "log-9", entries: [] });
    ws.sent.length = 0;
    chat!.takeOver();
    expect(sentOfType(ws, "switchSession")).toHaveLength(0);
  });

  it("NEGATIVE (d): search seek pages the loadOlder seam and STOPS when the match lands", () => {
    const { ws } = makeViewChat();
    const list = chat!.messageListAtom()!;
    const reveal = spyOn(list, "revealMatch").mockImplementation(() => false);
    chat!.peekSession("live-2", "needle");
    ws.sent.length = 0;
    // First page: no match, older history exists -> exactly ONE page ask.
    ws.emit({
      type: "logViewed",
      logId: "live-2",
      entries: [],
      hasOlder: true,
      oldestIndex: 12,
      epochToken: 0,
    });
    expect(sentOfType(ws, "loadOlder")).toEqual([
      { type: "loadOlder", requestId: 1, logId: "live-2", olderThan: 12, epochToken: 0 },
    ]);
    // The next page carries the match -> land, and NEVER page again even
    // though older history still existed.
    reveal.mockImplementation(() => true);
    ws.emit({
      type: "loadOlderResult",
      requestId: 1,
      logId: "live-2",
      entries: [],
      oldestIndex: 6,
      hasOlder: true,
    });
    expect(sentOfType(ws, "loadOlder")).toHaveLength(1);
    expect(chat!.sessionViewAtom().note).toBeNull();
    expect(reveal).toHaveBeenCalledTimes(2);
  });

  it("NEGATIVE (d): seek TERMINATES on exhausted history and notes it honestly", () => {
    const { ws } = makeViewChat();
    chat!.peekSession("live-2", "ghost");
    ws.sent.length = 0;
    ws.emit({
      type: "logViewed",
      logId: "live-2",
      entries: [],
      hasOlder: true,
      oldestIndex: 12,
      epochToken: 0,
    });
    ws.emit({
      type: "loadOlderResult",
      requestId: 1,
      logId: "live-2",
      entries: [],
      oldestIndex: 6,
      hasOlder: true,
    });
    ws.emit({
      type: "loadOlderResult",
      requestId: 2,
      logId: "live-2",
      entries: [],
      oldestIndex: 0,
      hasOlder: false,
    });
    // Two pages asked, seam closed -- silence, never a third request.
    expect(sentOfType(ws, "loadOlder")).toHaveLength(2);
    const view = chat!.sessionViewAtom();
    expect(view.mode).toBe("peeking"); // the peek stays open...
    expect(view.note).toBe(MATCH_UNREACHABLE_NOTE); // ...with the honest word
  });

  it("a refusal mid-seek ends the seek honestly (no retry loop)", () => {
    const { ws } = makeViewChat();
    chat!.peekSession("live-2", "ghost");
    ws.sent.length = 0;
    ws.emit({
      type: "logViewed",
      logId: "live-2",
      entries: [],
      hasOlder: true,
      oldestIndex: 12,
      epochToken: 0,
    });
    ws.emit({
      type: "loadOlderResult",
      requestId: 1,
      logId: "live-2",
      code: "epoch_moved",
      error: "the epoch moved",
    });
    expect(sentOfType(ws, "loadOlder")).toHaveLength(1);
    expect(chat!.sessionViewAtom().note).toBe(MATCH_UNREACHABLE_NOTE);
  });

  it("a first page with no older history and no match notes it at once", () => {
    const { ws } = makeViewChat();
    chat!.peekSession("live-2", "ghost");
    ws.sent.length = 0;
    // Real revealMatch on the headless container (no children collection):
    // must not throw, must miss, must end the seek with the note.
    ws.emit({ type: "logViewed", logId: "live-2", entries: [] });
    expect(sentOfType(ws, "loadOlder")).toHaveLength(0);
    expect(chat!.sessionViewAtom().note).toBe(MATCH_UNREACHABLE_NOTE);
  });

  it("deleting the viewed log falls the state back to attached", () => {
    const { ws } = makeViewChat();
    chat!.peekSession("live-2");
    ws.emit({ type: "logViewed", logId: "live-2", entries: [] });
    ws.emit({ type: "logDeleted", logId: "live-2" });
    const view = chat!.sessionViewAtom();
    expect(view.mode).toBe("attached");
    expect(view.attachedId).toBe("manager-1");
    expect(composerForView(view).enabled).toBe(true);
  });
});

// ── Adopted-worker return navigation ──────────────────────────────────────
// Away from the worker via sessionParentAtom (the adoption payload's
// parentSessionId), back through the live card's switchSession route. The
// card's click routing is pinned in openTargetFor
// (webui-subagents-sidebar.test.tsx); the view state each landing leaves
// behind is pinned here.

describe("createChat adopted-worker return navigation", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  function makeNavChat(): { ws: FakeWebSocket } {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const container = makeContainer();
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => container as unknown as HTMLElement,
      onSessionCreated: (d) => chat!.setSession(d.sessionId, d.replayDelta === true),
    });
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.emit({ type: "sessionCreated", sessionId: "mgr-1" });
    ws.sent.length = 0;
    return { ws };
  }

  it("worker view -> parent -> worker again: the live round trip lands with the right posture", () => {
    const { ws } = makeNavChat();
    // The adoptedLive card press: switchSession with the subagent hint.
    chat!.switchSession("wk-1", { subagent: true });
    expect(ws.sent.filter((m) => m.type === "switchSession" && m.sessionId === "wk-1")).toHaveLength(1);
    // The adoption payload stamps the pane: attached worker + parent join.
    ws.emit({
      type: "sessionCreated",
      sessionId: "wk-1",
      kind: "subagent",
      parentSessionId: "mgr-1",
      adopted: true,
    });
    let v = chat!.sessionViewAtom();
    expect(v.mode).toBe("attached");
    expect(v.attachedId).toBe("wk-1");
    expect(v.workerView).toBe(true);
    expect(chat!.sessionParentAtom()).toBe("mgr-1");

    // Away from the worker: onCloseSubagentView switches to
    // sessionParentAtom() (the revived manager, a plain live attach).
    chat!.switchSession(chat!.sessionParentAtom()!);
    ws.emit({ type: "sessionCreated", sessionId: "mgr-1" });
    v = chat!.sessionViewAtom();
    expect(v.mode).toBe("attached");
    expect(v.attachedId).toBe("mgr-1");
    expect(v.workerView).toBe(false);

    // Back to the worker through the still-live card's route.
    chat!.switchSession("wk-1", { subagent: true });
    ws.emit({
      type: "sessionCreated",
      sessionId: "wk-1",
      kind: "subagent",
      parentSessionId: "mgr-1",
      adopted: true,
    });
    v = chat!.sessionViewAtom();
    expect(v.mode).toBe("attached");
    expect(v.workerView).toBe(true);
    expect(v.subjectId).toBeNull();
    expect(composerForView(v).placeholder).toBe("Steer the subagent...");
  });

  it("settled card -> observing log; the close control returns to the attached session", () => {
    const { ws } = makeNavChat();
    // The SETTLED card press: viewLog (adoptedLive dropped with the row).
    chat!.viewLog("wk-1");
    expect(ws.sent.filter((m) => m.type === "viewLog" && m.logId === "wk-1")).toHaveLength(1);
    ws.emit({ type: "logViewed", logId: "wk-1", entries: [] });
    let v = chat!.sessionViewAtom();
    expect(v.mode).toBe("observing");
    expect(v.subjectId).toBe("wk-1");
    expect(v.attachedId).toBe("mgr-1");
    // The composer never claims the observed log.
    expect(composerForView(v).enabled).toBe(false);
    // Close (the app pairs clearView with the re-attach switch).
    chat!.clearView();
    chat!.switchSession("mgr-1");
    v = chat!.sessionViewAtom();
    expect(v.mode).toBe("attached");
    expect(v.subjectId).toBeNull();
    expect(v.attachedId).toBe("mgr-1");
    expect(composerForView(v).enabled).toBe(true);
  });
});
