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
    // SESSIONS/LOGS_LISTED broadcast is the sidebar reconcile, so unlike
    // deleteSession no optimistic re-list rides out.
    expect(ws.sent).toEqual([{ type: "dismissSession", sessionId: "sid-7" }]);
  });
});

// ── Subagent task feed ──────────────────────────────────────────────────────
// taskList/taskUpdate/taskActivity/taskActivityHistory are handled before
// the message-list/session guard, so a container-less chat exercises the
// whole buffer over the faked socket (the main-view rendering lives in the
// describe below, on a container-backed chat).
// NOTE: tasksAtom/taskActivity/viewedTaskIdAtom are module-level state
// shared across createChat() instances; afterEach clears them via
// clearTasks() so runs cannot contaminate each other.

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
    feed({ kind: "reset" });

    // The dead attempt's streamed fragments retract; the earlier tool
    // boundary stops the trim (mirrors message-list.handleStreamReset).
    expect(chat.getTaskActivity("r")).toEqual([
      { kind: "text", text: "kept " },
      { kind: "tool_call", name: "bash", args: "" },
    ]);

    // The retry opens a fresh block instead of merging into dead text.
    feed({ kind: "text", content: "fresh take" });
    expect(chat.getTaskActivity("r")[2]).toEqual({ kind: "text", text: "fresh take" });
  });

  it("a taskActivity reset with nothing in flight is a pure no-op (history re-seed still lands)", () => {
    const { chat, ws } = makeTaskChat();
    ws.emit({ type: "taskActivity", taskId: "z", activity: { kind: "reset" } });
    expect(chat.getTaskActivity("z")).toEqual([]);
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

  it("clearTasks empties tasks and activity buffers", () => {
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
  });

  it("tool activity keeps the display descriptors for replay (posture parity)", () => {
    const { chat, ws } = makeTaskChat();
    // The relayed frames carry the same ToolDisplayWire fold the session
    // TOOL_CALL frame does; the buffer must retain them so a re-opened view
    // paints the same posture (the doctrine: viewing a subagent renders
    // like any session view -- the display DSL reaches handleToolCall).
    ws.emit({
      type: "taskActivity",
      taskId: "a",
      activity: {
        kind: "tool_call",
        name: "bash",
        args: '{"command":"ls -la"}',
        argsSummary: "ls -la",
        display: [{ kind: "code", source: "args", arg: "command", lang: "shell" }],
      },
    });
    ws.emit({
      type: "taskActivity",
      taskId: "a",
      activity: { kind: "tool_result", name: "edit", output: "ok", startLine: 42 },
    });
    expect(chat.getTaskActivity("a")).toEqual([
      {
        kind: "tool_call",
        name: "bash",
        args: '{"command":"ls -la"}',
        argsSummary: "ls -la",
        display: [{ kind: "code", source: "args", arg: "command", lang: "shell" }],
      },
      { kind: "tool_result", name: "edit", output: "ok", startLine: 42 },
    ]);
  });

  it("taskFollowup sends the existing C2S frame trimmed; blanks no-op", () => {
    const { chat, ws } = makeTaskChat();
    chat.taskFollowup("t1", "  steer left  ");
    expect(ws.sent).toEqual([{ type: "taskFollowup", taskId: "t1", message: "steer left" }]);
    chat.taskFollowup("", "hi");
    chat.taskFollowup("t1", "   ");
    expect(ws.sent).toHaveLength(1);
  });

  it("interruptTask sends the existing C2S frame; blank id no-ops", () => {
    const { chat, ws } = makeTaskChat();
    chat.interruptTask("t1");
    expect(ws.sent).toEqual([{ type: "taskInterrupt", taskId: "t1" }]);
    chat.interruptTask("");
    expect(ws.sent).toHaveLength(1);
  });
});

// ── Subagent main-view transcript ───────────────────────────────────────────
// The task feed drives the MAIN transcript: viewSubagent replays the buffer
// into the MessageListManager, live taskActivity frames stream into it, the
// manager's own transcript events are suppressed while viewing (browse-view
// doctrine), and the attach (sessionCreated) ends the mode. Container-backed
// chat over the dom-helper DOM (same runtime the message-list suite uses).

describe("createChat subagent main-view", () => {
  const RealWebSocket = globalThis.WebSocket;
  let chat: ChatController | null = null;

  afterEach(() => {
    chat?.clearTasks();
    chat?.disconnect();
    chat = null;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = RealWebSocket;
  });

  function makeViewChat(): { chat: ChatController; ws: FakeWebSocket; pane: Element } {
    globalThis.WebSocket = FakeWebSocket as unknown as typeof WebSocket;
    const host = document.createElement("div");
    chat = createChat({
      token: null,
      host: "localhost",
      getMessageListContainer: () => host as unknown as HTMLElement,
      // The app's own attach contract: sessionCreated binds (reuses) the
      // MessageListManager and clears the transcript unless it is a delta.
      onSessionCreated: ({ sessionId, replayDelta }) =>
        chat!.setSession(sessionId, replayDelta === true),
      // ...and the app's log-view paint (clear + render entries) rides here
      // too, so the browse-mode exclusivity pin sees the real handover.
      onLogViewed: (_logId, entries) => {
        const list = chat!.messageListAtom();
        if (list) {
          list.clear();
          list.renderLogEntries(entries);
        }
      },
    });
    chat.clearTasks();
    const ws = FakeWebSocket.instances[FakeWebSocket.instances.length - 1]!;
    ws.emit({ type: "sessionCreated", sessionId: "mgr-1", profile: "manager" });
    return { chat, ws, pane: host };
  }

  it("viewSubagent replays the buffered activity into the main pane", () => {
    const { chat, ws, pane } = makeViewChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("t1", "running")] });
    ws.emit({ type: "taskActivity", taskId: "t1", activity: { kind: "text", content: "thinking out loud" } });
    ws.emit({ type: "taskActivity", taskId: "t1", activity: { kind: "tool_call", name: "bash", args: '{"cmd":"ls"}' } });
    ws.emit({ type: "taskActivity", taskId: "t1", activity: { kind: "tool_result", name: "bash", output: "file.txt" } });

    chat.viewSubagent("t1");
    expect(chat.viewedTaskIdAtom()).toBe("t1");
    // A populated buffer opens WITHOUT a history request (the panel idiom).
    expect(ws.sent.some((m) => m.type === "taskActivityRequest")).toBe(false);
    expect(pane.textContent).toContain("thinking out loud");
    expect(pane.textContent).toContain("bash");
  });

  it("an empty buffer fetches the replay, and the history paints when it lands", () => {
    const { chat, ws, pane } = makeViewChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("t2", "completed")] });
    chat.viewSubagent("t2");
    const req = ws.sent[ws.sent.length - 1]!;
    expect(req).toEqual({ type: "taskActivityRequest", taskId: "t2" });
    ws.emit({
      type: "taskActivityHistory",
      taskId: "t2",
      activity: [{ kind: "text", content: "seeded tail" }],
    });
    expect(pane.textContent).toContain("seeded tail");
  });

  it("live deltas stream into the transcript while manager events stay suppressed", () => {
    const { chat, ws, pane } = makeViewChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("t3", "running")] });
    chat.viewSubagent("t3");

    ws.emit({ type: "taskActivity", taskId: "t3", activity: { kind: "text", content: "partial" } });
    expect(pane.textContent).toContain("partial");
    const streaming = pane.querySelectorAll(".message.assistant.streaming");
    expect(streaming).toHaveLength(1);

    // The manager keeps talking underneath: dropped, never appended.
    ws.emit({ type: "assistantMessage", sessionId: "mgr-1", content: "MANAGER LEAK" });
    expect(pane.textContent).not.toContain("MANAGER LEAK");

    // Another delta merges into the SAME streaming row (parser accumulates).
    ws.emit({ type: "taskActivity", taskId: "t3", activity: { kind: "text", content: " done speaking" } });
    expect(streaming[0]!.textContent).toContain("partial done speaking");

    // A foreign task's deltas never touch this view.
    ws.emit({ type: "taskActivity", taskId: "other", activity: { kind: "text", content: "ELSEWHERE" } });
    expect(pane.textContent).not.toContain("ELSEWHERE");

    // Turn boundary: inRun=false commits the row (streaming class gone).
    ws.emit({ type: "taskUpdate", task: { ...taskInfo("t3", "running"), inRun: false } });
    expect(pane.querySelectorAll(".message.assistant.streaming")).toHaveLength(0);
    expect(pane.textContent).toContain("partial done speaking");

    // Re-attach ends the mode: manager transcript flows again.
    ws.emit({ type: "sessionCreated", sessionId: "mgr-1", profile: "manager" });
    expect(chat.viewedTaskIdAtom()).toBeNull();
    ws.emit({ type: "assistantMessage", sessionId: "mgr-1", content: "back live" });
    expect(pane.textContent).toContain("back live");
  });

  it("the reset sentinel retracts the dead attempt's streamed row", () => {
    const { chat, ws, pane } = makeViewChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("t4", "running")] });
    chat.viewSubagent("t4");
    ws.emit({ type: "taskActivity", taskId: "t4", activity: { kind: "text", content: "dead attempt " } });
    expect(pane.querySelectorAll(".message.assistant.streaming")).toHaveLength(1);
    ws.emit({ type: "taskActivity", taskId: "t4", activity: { kind: "reset" } });
    expect(pane.textContent).not.toContain("dead attempt");
    ws.emit({ type: "taskActivity", taskId: "t4", activity: { kind: "text", content: "retry text" } });
    expect(pane.textContent).toContain("retry text");
  });

  it("a terminal task's trailing row commits quiet (no footer to invent)", () => {
    const { chat, ws, pane } = makeViewChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("t5", "completed")] });
    ws.emit({ type: "taskActivity", taskId: "t5", activity: { kind: "text", content: "final words" } });
    chat.viewSubagent("t5");
    expect(pane.textContent).toContain("final words");
    // Committed: no in-flight streaming row remains...
    expect(pane.querySelectorAll(".message.assistant.streaming")).toHaveLength(0);
    // ...and no footer row (no ts was ever observed for the settled task).
    expect(pane.querySelectorAll(".message-assistant-footer")).toHaveLength(0);
  });

  it("opening a cold log ends the subagent mode (browse views are exclusive)", () => {
    const { chat, ws, pane } = makeViewChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("t6", "running")] });
    chat.viewSubagent("t6");
    ws.emit({ type: "taskActivity", taskId: "t6", activity: { kind: "text", content: "task words" } });
    expect(pane.textContent).toContain("task words");

    ws.emit({ type: "logViewed", logId: "log-9", entries: [{ source: "prompt", content: "cold line" }] });
    expect(chat.viewedTaskIdAtom()).toBeNull();
    expect(pane.textContent).toContain("cold line");
    // The task feed no longer paints into the log window.
    ws.emit({ type: "taskActivity", taskId: "t6", activity: { kind: "text", content: "MORE TASK NOISE" } });
    expect(pane.textContent).not.toContain("MORE TASK NOISE");
  });

  it("task tool frames render the SAME posture as session tool frames (display DSL)", () => {
    const { chat, ws, pane } = makeViewChat();
    // Bash declares (bash-tool/index.ts): argDisplay first-line + a code
    // display part; the session channel resolves these server-side.
    const display = [{ kind: "code", source: "args", arg: "command", lang: "shell" }];
    // 1) The session baseline: the live TOOL_CALL frame path.
    ws.emit({
      type: "toolCall",
      sessionId: "mgr-1",
      name: "bash",
      args: '{"command":"ls -la"}',
      argsSummary: "ls -la",
      display,
      toolCallId: "c1",
    });
    ws.emit({
      type: "toolResult",
      sessionId: "mgr-1",
      name: "bash",
      output: "file.txt",
      toolCallId: "c1",
    });
    const sessionPre = pane.querySelector(".tool-code");
    expect(sessionPre).not.toBeNull();
    const sessionHtml = sessionPre!.innerHTML;

    // 2) The same call through the task relay into the subagent view: the
    // descriptors must reach handleToolCall/handleToolResult, so the block
    // reaches the identical code posture (not the generic fallback).
    ws.emit({ type: "taskList", tasks: [taskInfo("t7", "running")] });
    ws.emit({
      type: "taskActivity",
      taskId: "t7",
      activity: {
        kind: "tool_call",
        name: "bash",
        args: '{"command":"ls -la"}',
        argsSummary: "ls -la",
        display,
      },
    });
    ws.emit({
      type: "taskActivity",
      taskId: "t7",
      activity: { kind: "tool_result", name: "bash", output: "file.txt" },
    });
    chat.viewSubagent("t7");
    const taskPre = pane.querySelector(".tool-code");
    expect(taskPre).not.toBeNull();
    expect(taskPre!.innerHTML).toBe(sessionHtml);

    // An edit result's start_line rides too: the diff gutters number from
    // the real file line, exactly like the session frame path.
    ws.emit({ type: "taskActivity", taskId: "t7", activity: {
      kind: "tool_call",
      name: "edit",
      args: '{"path":"a.txt","oldString":"one","newString":"two"}',
      display: [{ kind: "diff", oldArg: "oldString", newArg: "newString", pathArg: "path" }],
    } });
    ws.emit({ type: "taskActivity", taskId: "t7", activity: {
      kind: "tool_result", name: "edit", output: "edited a.txt", startLine: 42,
    } });
    const diff = pane.querySelectorAll(".tool-diff");
    expect(diff).toHaveLength(1);
    expect(diff[0]!.textContent).toContain("42");
  });

  it("steering the viewed task echoes the user row; a refused followup says so", () => {
    const { chat, ws, pane } = makeViewChat();
    ws.emit({ type: "taskList", tasks: [taskInfo("t8", "running")] });
    chat.viewSubagent("t8");
    chat.taskFollowup("t8", "look at the tests instead");
    // The frame rides the socket addressed to the task, and the pane shows
    // the steering right away (the task relay has no userMessage lane).
    expect(ws.sent).toContainEqual({
      type: "taskFollowup",
      taskId: "t8",
      message: "look at the tests instead",
    });
    expect(pane.querySelector(".message.user")).toBeTruthy();
    expect(pane.textContent).toContain("look at the tests instead");

    // A refusal (the server's taskControl reply) lands as an honest notice.
    ws.emit({
      type: "taskControl",
      taskId: "t8",
      action: "followup",
      ok: false,
      error: "Steering needs a running task with a live turn",
    });
    expect(pane.textContent).toContain("Steering needs a running task with a live turn");

    // An accept adds nothing (no double echo) and never warns.
    const before = pane.textContent;
    ws.emit({ type: "taskControl", taskId: "t8", action: "followup", ok: true });
    expect(pane.textContent).toBe(before);
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

  it("requestTaskActivity no-ops on a blank id and ships the request otherwise", () => {
    const { chat, ws } = makeChat();
    chat.requestTaskActivity("");
    expect(ws.sent).toEqual([]);
    chat.requestTaskActivity("t1");
    expect(ws.sent[ws.sent.length - 1]).toEqual({ type: "taskActivityRequest", taskId: "t1" });
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
