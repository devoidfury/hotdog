// Tests for webui/ui/chat.ts session plumbing. Only the container-facing
// paths are exercised here (createChat accepts the message-list element as
// an opaque handle), which keeps this runnable under Bun without a DOM.
// The rest of chat.ts is browser-only by project convention.

import { describe, it, expect, afterEach, spyOn } from "bun:test";
import {
  createChat,
  type ChatController,
  type CompletionItem,
  type TaskActivityBlock,
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

// ── Subagent task feed ──────────────────────────────────────────────────────
// taskList/taskUpdate/taskActivity/taskActivityHistory/taskControl are
// handled before the message-list/session guard, so a container-less chat
// exercises the whole feed over the faked socket.
// NOTE: tasksAtom/taskActivity/activityVersionAtom/taskControlAtom are
// module-level state shared across createChat() instances; afterEach clears
// them via clearTasks() so runs cannot contaminate each other.

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

describe("createChat subagent task feed", () => {
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

  it("taskActivity merges consecutive deltas and appends distinct kinds", () => {
    const { chat, ws } = makeTaskChat();
    const feed = (activity: Record<string, unknown>) =>
      ws.emit({ type: "taskActivity", taskId: "t", activity });
    const v0 = chat.activityVersionAtom();

    feed({ kind: "text", content: "he" });
    feed({ kind: "text", content: "llo" });
    feed({ kind: "reasoning", content: "think" });
    feed({ kind: "reasoning", content: "ing" });
    feed({ kind: "tool_call", name: "bash", args: '{"cmd":"ls"}' });
    feed({ kind: "tool_result", name: "bash", output: "ok" });
    feed({ kind: "tool_result", name: "bash", output: "", error: "bad" });

    const blocks = chat.getTaskActivity("t");
    expect(blocks).toEqual([
      { kind: "text", text: "hello" },
      { kind: "reasoning", text: "thinking" },
      { kind: "tool_call", name: "bash", args: '{"cmd":"ls"}' },
      { kind: "tool_result", name: "bash", output: "ok" },
      { kind: "tool_result", name: "bash", output: "", error: "bad" },
    ]);
    // Every activity bumps the version, merges included.
    expect(chat.activityVersionAtom()).toBe(v0 + 7);
  });

  it("caps a task's display blocks at MAX_ACTIVITY_BLOCKS, evicting the oldest", () => {
    const { chat, ws } = makeTaskChat();
    for (let i = 1; i <= 201; i++) {
      ws.emit({
        type: "taskActivity",
        taskId: "cap",
        activity: { kind: "tool_call", name: `t${i}`, args: "" },
      });
    }
    const blocks = chat.getTaskActivity("cap");
    expect(blocks).toHaveLength(200);
    expect((blocks[0] as Extract<TaskActivityBlock, { kind: "tool_call" }>).name).toBe("t2");
    expect((blocks[199] as Extract<TaskActivityBlock, { kind: "tool_call" }>).name).toBe("t201");
  });

  it("evicts the oldest task's transcript past MAX_TRACKED_TASKS", () => {
    const { chat, ws } = makeTaskChat();
    for (let i = 0; i < 51; i++) {
      ws.emit({
        type: "taskActivity",
        taskId: `k${i}`,
        activity: { kind: "tool_call", name: `n${i}`, args: "" },
      });
    }
    expect(chat.getTaskActivity("k0")).toEqual([]);
    expect(chat.getTaskActivity("k1")).toHaveLength(1);
    expect(chat.getTaskActivity("k50")).toHaveLength(1);
  });

  it("seeds blocks from taskActivityHistory but skips already-accumulated tasks", () => {
    const { chat, ws } = makeTaskChat();
    ws.emit({
      type: "taskActivityHistory",
      taskId: "h1",
      activity: [
        { kind: "text", content: "a" },
        { kind: "tool_call", name: "n", args: "x" },
      ],
    });
    expect(chat.getTaskActivity("h1")).toEqual([
      { kind: "text", text: "a" },
      { kind: "tool_call", name: "n", args: "x" },
    ]);
    // A replay landing on top of accumulated activity must not duplicate.
    ws.emit({
      type: "taskActivityHistory",
      taskId: "h1",
      activity: [{ kind: "text", content: "ignored" }],
    });
    expect(chat.getTaskActivity("h1")).toHaveLength(2);
  });

  it("taskActivity reset drops trailing streamed blocks; tool blocks and re-seeding stay safe", () => {
    const { chat, ws } = makeTaskChat();
    const feed = (activity: Record<string, unknown>) =>
      ws.emit({ type: "taskActivity", taskId: "r", activity });

    feed({ kind: "text", content: "kept " });
    feed({ kind: "tool_call", name: "bash", args: "" });
    feed({ kind: "text", content: "dead " });
    feed({ kind: "reasoning", content: "dead-think" });
    const vBefore = chat.activityVersionAtom();
    feed({ kind: "reset" });

    // The dead attempt's streamed fragments retract; the earlier tool
    // boundary stops the trim (mirrors message-list.handleStreamReset).
    expect(chat.getTaskActivity("r")).toEqual([
      { kind: "text", text: "kept " },
      { kind: "tool_call", name: "bash", args: "" },
    ]);
    expect(chat.activityVersionAtom()).toBe(vBefore + 1);

    // The retry opens a fresh block instead of merging into dead text.
    feed({ kind: "text", content: "fresh take" });
    expect(chat.getTaskActivity("r")[2]).toEqual({ kind: "text", text: "fresh take" });
  });

  it("a taskActivity reset with nothing in flight is a pure no-op (history re-seed still lands)", () => {
    const { chat, ws } = makeTaskChat();
    const v0 = chat.activityVersionAtom();
    ws.emit({ type: "taskActivity", taskId: "z", activity: { kind: "reset" } });
    expect(chat.getTaskActivity("z")).toEqual([]);
    expect(chat.activityVersionAtom()).toBe(v0);
    // The stray reset must not have created the map entry: the seedTaskActivity
    // skip guard stays honest, so a reconnect racing a reset still gets its replay.
    ws.emit({
      type: "taskActivityHistory",
      taskId: "z",
      activity: [{ kind: "text", content: "seeded" }],
    });
    expect(chat.getTaskActivity("z")).toEqual([{ kind: "text", text: "seeded" }]);
  });

  it("getTaskActivity returns [] for unknown ids", () => {
    const { chat } = makeTaskChat();
    expect(chat.getTaskActivity("nope")).toEqual([]);
  });

  it("clearTasks empties tasks, activity, and resets the version", () => {
    const { chat, ws } = makeTaskChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("a")] });
    ws.emit({
      type: "taskActivity",
      taskId: "a",
      activity: { kind: "text", content: "x" },
    });
    chat.clearTasks();
    expect(chat.tasksAtom()).toEqual([]);
    expect(chat.getTaskActivity("a")).toEqual([]);
    expect(chat.activityVersionAtom()).toBe(0);
  });

  it("taskControl stores a readable reply per task", () => {
    const { chat, ws } = makeTaskChat();
    ws.emit({ type: "taskControl", taskId: "a", action: "interrupt", ok: true });
    ws.emit({ type: "taskControl", taskId: "b", action: "followup", ok: true });
    ws.emit({ type: "taskControl", taskId: "c", action: "interrupt", ok: false, error: "boom" });
    ws.emit({ type: "taskControl", taskId: "d", action: "followup", ok: false });
    expect(chat.taskControlAtom()).toEqual({
      a: { ok: true, text: "Task cancelled" },
      b: { ok: true, text: "Steering sent" },
      c: { ok: false, text: "boom" },
      d: { ok: false, text: "Task control failed" },
    });
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

  it("interruptTask and requestTaskActivity no-op on a blank id", () => {
    const { chat, ws } = makeChat();
    chat.interruptTask("");
    chat.requestTaskActivity("");
    expect(ws.sent).toEqual([]);
    chat.interruptTask("t1");
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: "taskInterrupt", taskId: "t1" });
    chat.requestTaskActivity("t1");
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: "taskActivityRequest", taskId: "t1" });
  });

  it("taskFollowup requires a nonblank id and message, and trims the message", () => {
    const { chat, ws } = makeChat();
    chat.taskFollowup("", "hi");
    chat.taskFollowup("t1", "   ");
    expect(ws.sent).toEqual([]);
    chat.taskFollowup("t1", "  keep going  ");
    expect(ws.sent[ws.sent.length - 1]).toEqual({
      type: "taskFollowup",
      taskId: "t1",
      message: "keep going",
    });
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
