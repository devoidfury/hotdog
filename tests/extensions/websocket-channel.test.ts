// Tests for src/extensions/websocket/websocket-channel.ts — WebSocketChannel.
// Base Channel behavior (send/enqueue, attach/detach, close, command routing)
// is covered in tests/core/channel.test.ts. Only the behavior specific to this
// subclass (event-to-protocol mapping, readiness, sendJson) is tested here.
// Pending-question replay is tested in websocket-server.test.ts.

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { WebSocketChannel } from "@extensions/websocket/websocket-channel.ts";
import { ChannelSessionManager } from "@core/channel.ts";
import { OUTPUT_EVENT, OutputEvent } from "@core/context/output.ts";
import { S2C, MAX_WIRE_IMAGE_BASE64_BYTES, MAX_STREAMING_TOOL_CALL_ARGS_CHARS, wireImages } from "@extensions/websocket/protocol.ts";

// ── Test Helpers ────────────────────────────────────────────────────────────

function createMockWs(overrides: Partial<Bun.ServerWebSocket> = {}): Bun.ServerWebSocket {
  const sentMessages: string[] = [];

  return {
    readyState: WebSocket.OPEN,
    send: mock((data: string) => {
      sentMessages.push(data);
    }),
    sendText: mock((data: string) => {
      sentMessages.push(data);
    }),
    sendBinary: mock(() => {}),
    close: mock(() => {}),
    terminate: mock(() => {}),
    ping: mock(() => true),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    data: undefined,
    url: "",
    protocol: "",
    extensions: "",
    binaryType: "arraybuffer",
    _sentMessages: sentMessages,
    ...overrides,
  } as unknown as Bun.ServerWebSocket;
}

function createMockSessionManager(overrides: Partial<ChannelSessionManager> = {}): ChannelSessionManager {
  return {
    enqueue: mock(() => {}),
    cancel: mock(() => {}),
    interrupt: mock(() => {}),
    executeCommand: mock(async () => undefined),
    onSessionEvents: mock((_sessionId, _handler) => () => {}),
    sessionIds: mock(() => ["session-1"]),
    getSessionInfo: mock((id) => ({ id, model: "test-model" })),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("WebSocketChannel - construction", () => {
  let sm: ChannelSessionManager;
  let ws: Bun.ServerWebSocket;

  beforeEach(() => {
    sm = createMockSessionManager();
    ws = createMockWs();
  });

  it("attaches to the given session on construction", () => {
    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    expect(channel.getCurrentSessionId()).toBe("session-1");
    expect(sm.onSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
  });
});

describe("WebSocketChannel - write()", () => {
  // Parameterized: each event type maps to the corresponding protocol message
  it.each([
    {
      name: "USER_MESSAGE",
      event: { type: OUTPUT_EVENT.USER_MESSAGE, content: "Hello" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.USER_MESSAGE);
        expect(msg.content).toBe("Hello");
        expect(msg.sessionId).toBe("session-1");
      },
    },
    {
      name: "ASSISTANT_MESSAGE",
      event: { type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "AI response" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.ASSISTANT_MESSAGE);
        expect(msg.content).toBe("AI response");
      },
    },
    {
      name: "THINKING",
      event: { type: OUTPUT_EVENT.THINKING, content: "Let me think..." },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.THINKING);
        expect(msg.content).toBe("Let me think...");
      },
    },
    {
      name: "TOOL_CALL",
      event: { type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: { command: "ls" } },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.TOOL_CALL);
        expect(msg.name).toBe("bash");
        expect(msg.args).toEqual({ command: "ls" });
      },
    },
    {
      name: "TOOL_CALL with argsSummary + toolCallId",
      event: {
        type: OUTPUT_EVENT.TOOL_CALL,
        toolName: "read",
        input: '{"path":"a.ts"}',
        toolCallId: "tc-1",
      },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.TOOL_CALL);
        expect(msg.argsSummary).toBe("a.ts");
        expect(msg.toolCallId).toBe("tc-1");
      },
    },
    {
      name: "TOOL_RESULT",
      event: { type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", content: "file.txt" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.TOOL_RESULT);
        expect(msg.name).toBe("bash");
        expect(msg.output).toBe("file.txt");
      },
    },
    {
      name: "TOOL_RESULT with toolCallId",
      event: { type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", content: "ok", toolCallId: "tc-2" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.TOOL_RESULT);
        expect(msg.toolCallId).toBe("tc-2");
      },
    },
    {
      name: "TOOL_RESULT with error",
      event: { type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", content: "", error: "Permission denied" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.TOOL_RESULT);
        expect(msg.error).toBe("Permission denied");
      },
    },
  ])("maps $name events to protocol", ({ event, expected }) => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler(event as any);
        return () => {};
      }),
    });
    const ws = createMockWs();

    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    const sent = (ws as any)._sentMessages;
    expect(sent.length).toBe(1);
    const msg = JSON.parse(sent[0]);
    expected(msg);
  });

  it("TOOL_CALL carries the hint-driven argsSummary (first-line preview)", () => {
    const event = {
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "bash",
      input: JSON.stringify({ command: "git status\n&& git diff" }),
      toolCallId: "tc-9",
    };
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler(event as any);
        return () => {};
      }),
    });
    const ws = createMockWs();
    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
      argDisplay: (name) =>
        name === "bash" ? { command: { preview: "first-line", syntax: "shell" } } : undefined,
    });
    const msg = JSON.parse((ws as any)._sentMessages[0]);
    // The shared fold, ANSI-free (the shell pass is terminal-side only).
    expect(msg.argsSummary).toBe("git status… (2 lines, 22 chars)");
  });

  it("TOOL_CALL argsSummary uses the default fold when no hints are wired", () => {
    const event = {
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "write",
      input: JSON.stringify({ path: "a.ts", content: "a\nb" }),
    };
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler(event as any);
        return () => {};
      }),
    });
    const ws = createMockWs();
    new WebSocketChannel({ sessionManager: sm, ws, sessionId: "session-1" });
    const msg = JSON.parse((ws as any)._sentMessages[0]);
    expect(msg.argsSummary).toBe("path: a.ts · content: 2 lines, 3 chars");
  });

  it("TOOL_CALL carries the forwarded display parts (file view for read)", () => {
    const event = {
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "read",
      input: JSON.stringify({ path: "a.ts", offset: 100, limit: 50 }),
      toolCallId: "tc-9",
    };
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler(event as any);
        return () => {};
      }),
    });
    const ws = createMockWs();
    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
      display: (name) =>
        name === "read"
          ? [{ kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" }]
          : undefined,
    });
    const msg = JSON.parse((ws as any)._sentMessages[0]);
    // Forwarded spec: arg parameter names, not values.
    expect(msg.display).toEqual([
      { kind: "file", pathArg: "path", offsetArg: "offset", limitArg: "limit" },
    ]);
  });

  it("TOOL_CALL rides no display field when the resolver declares nothing", () => {
    const event = {
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "bash",
      input: JSON.stringify({ command: "ls" }),
    };
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler(event as any);
        return () => {};
      }),
    });
    const ws = createMockWs();
    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
      display: () => undefined,
    });
    const msg = JSON.parse((ws as any)._sentMessages[0]);
    expect("display" in msg).toBe(false);
  });

  // More event types in the same parameterized pattern
  it.each([
    {
      name: "COMPACTING",
      event: { type: OUTPUT_EVENT.COMPACTING, message: "Compacting context..." },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.COMPACTING);
        expect(msg.message).toBe("Compacting context...");
      },
    },
    {
      name: "COMMAND_RESULT",
      event: { type: OUTPUT_EVENT.COMMAND_RESULT, content: "Command done" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.COMMAND_RESULT);
        expect(msg.content).toBe("Command done");
      },
    },
    {
      name: "QUESTION",
      event: { type: OUTPUT_EVENT.QUESTION, questions: [{ key: "q1", prompt: "What is your name?" }] },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.QUESTION);
        expect(msg.questions).toEqual([{ key: "q1", prompt: "What is your name?" }]);
      },
    },
    {
      name: "STREAMING_CHUNK",
      event: { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "partial" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.STREAMING_CHUNK);
        expect(msg.content).toBe("partial");
      },
    },
    {
      name: "STREAMING_REASONING_CHUNK",
      event: { type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "reasoning" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.STREAMING_REASONING_CHUNK);
        expect(msg.content).toBe("reasoning");
      },
    },
    {
      name: "TASK_PROGRESS",
      event: { type: OUTPUT_EVENT.TASK_PROGRESS, taskId: "task-1", status: "running", message: "Processing..." },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.TASK_PROGRESS);
        expect(msg.taskId).toBe("task-1");
        expect(msg.status).toBe("running");
        expect(msg.message).toBe("Processing...");
      },
    },
    {
      name: "TOKEN_USAGE",
      event: {
        type: OUTPUT_EVENT.TOKEN_USAGE,
        sessionPromptTokens: 100,
        sessionCompletionTokens: 50,
        sessionTotalTokens: 150,
        promptTokens: 80,
        completionTokens: 40,
        totalTokens: 120,
        cachedTokens: 10,
        contextWindow: 200000,
      },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.TOKEN_USAGE);
        expect(msg.sessionPromptTokens).toBe(100);
        expect(msg.sessionCompletionTokens).toBe(50);
        expect(msg.sessionTotalTokens).toBe(150);
        expect(msg.promptTokens).toBe(80);
        expect(msg.completionTokens).toBe(40);
        expect(msg.totalTokens).toBe(120);
        expect(msg.cachedTokens).toBe(10);
        expect(msg.contextWindow).toBe(200000);
        // Additive footer pair: same numbers the sidebar gauge caches.
        expect(msg.ctxUsed).toBe(120);
        expect(msg.ctxTotal).toBe(200000);
      },
    },
    {
      name: "COMPACTION_RESULT",
      event: { type: OUTPUT_EVENT.COMPACTION_RESULT, summary: "Summary of conversation", messagesCompacted: 10 },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.COMPACTION_RESULT);
        expect(msg.summary).toBe("Summary of conversation");
        expect(msg.messagesCompacted).toBe(10);
      },
    },
    {
      name: "SYSTEM_MESSAGE",
      event: { type: OUTPUT_EVENT.SYSTEM_MESSAGE, content: "notice", detail: "expanded detail" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.SYSTEM_MESSAGE);
        expect(msg.content).toBe("notice");
        // detail is gone from the wire: unknown fields are dropped.
        expect(msg.detail).toBeUndefined();
      },
    },
    {
      name: "USER_MESSAGE with file attachments",
      event: {
        type: OUTPUT_EVENT.USER_MESSAGE,
        content: "look at this",
        files: [{ path: "src/a.ts", content: "export const a = 1;" }],
      },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.USER_MESSAGE);
        expect(msg.content).toBe("look at this");
        expect(msg.files).toEqual([{ path: "src/a.ts", content: "export const a = 1;" }]);
      },
    },
    {
      name: "SYSTEM_MESSAGE without attachments",
      event: { type: OUTPUT_EVENT.SYSTEM_MESSAGE, content: "notice" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.SYSTEM_MESSAGE);
        expect(msg.content).toBe("notice");
        expect(msg.files).toBeUndefined();
      },
    },
  ])("maps $name events to protocol", ({ event, expected }) => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler(event as any);
        return () => {};
      }),
    });
    const ws = createMockWs();

    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    const sent = (ws as any)._sentMessages;
    expect(sent.length).toBe(1);
    const msg = JSON.parse(sent[0]);
    expected(msg);
  });

  it("maps TOKEN_USAGE with defaults", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.TOKEN_USAGE });
        return () => {};
      }),
    });
    const ws = createMockWs();

    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    const sent = (ws as any)._sentMessages;
    const msg = JSON.parse(sent[0]);
    expect(msg.sessionPromptTokens).toBe(0);
    expect(msg.sessionCompletionTokens).toBe(0);
    expect(msg.sessionTotalTokens).toBe(0);
    expect(msg.promptTokens).toBe(0);
    expect(msg.completionTokens).toBe(0);
    expect(msg.totalTokens).toBe(0);
    expect(msg.cachedTokens).toBe(0);
    expect(msg.contextWindow).toBeUndefined();
    // Zero totals attest nothing: the ctx pair is omitted, not sent as 0.
    expect("ctxUsed" in msg).toBe(false);
    expect("ctxTotal" in msg).toBe(false);
  });

  it("omits a non-finite contextWindow from TOKEN_USAGE", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.TOKEN_USAGE, totalTokens: 120, contextWindow: NaN });
        return () => {};
      }),
    });
    const ws = createMockWs();

    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    const sent = (ws as any)._sentMessages;
    const msg = JSON.parse(sent[0]);
    expect(msg.totalTokens).toBe(120);
    // Field omitted entirely, not serialized as null/NaN. Same for the
    // ctxTotal gauge field: an unattested window never reaches the footer.
    expect("contextWindow" in msg).toBe(false);
    expect("ctxTotal" in msg).toBe(false);
    expect(msg.ctxUsed).toBe(120);
  });

  it("maps SESSION_STATE events to protocol with broadcast", () => {
    const broadcastCallback = mock(() => {});
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.SESSION_STATE, key: "model", value: "gpt-4" });
        return () => {};
      }),
    });
    const ws = createMockWs();

    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
      broadcastCallback,
    });

    const sent = (ws as any)._sentMessages;
    const msg = JSON.parse(sent[0]);
    expect(msg.type).toBe(S2C.SESSION_STATE);
    expect(msg.key).toBe("model");
    expect(msg.value).toBe("gpt-4");
    expect(broadcastCallback).toHaveBeenCalledWith(msg);
  });

  it("drops the remaining frame-only event (QUEUE_UPDATE) and maps the tool-call delta live", () => {
    let savedHandler: ((event: OutputEvent) => void) | null = null;
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        savedHandler = handler;
        return () => {};
      }),
    });
    const ws = createMockWs();
    new WebSocketChannel({ sessionManager: sm, ws, sessionId: "session-1" });

    savedHandler!({ type: OUTPUT_EVENT.QUEUE_UPDATE, pending: 1, preview: "steer" });
    expect((ws as any)._sentMessages).toEqual([]);

    // The tool-call delta DOES ride now: the live-only `streamingToolCall`
    // preview frame (nothing persists or replays it).
    savedHandler!({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: '{"comm' });
    const msg = JSON.parse((ws as any)._sentMessages[0]);
    expect(msg.type).toBe(S2C.STREAMING_TOOL_CALL);
    expect(msg).toEqual({
      type: S2C.STREAMING_TOOL_CALL,
      sessionId: "session-1",
      index: 0,
      name: "bash",
      args: '{"comm',
    });
  });

  it("caps the streaming preview so a huge call cannot stream megabytes of it", () => {
    let savedHandler: ((event: OutputEvent) => void) | null = null;
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        savedHandler = handler;
        return () => {};
      }),
    });
    const ws = createMockWs();
    new WebSocketChannel({ sessionManager: sm, ws, sessionId: "session-1" });

    // A 200 KB write body streamed in deltas: the preview shows the head plus
    // the marker; the final toolCall frame still carries the complete args.
    savedHandler!({
      type: OUTPUT_EVENT.TOOL_CALL_DELTA,
      index: 0,
      name: "write",
      args: "x".repeat(MAX_STREAMING_TOOL_CALL_ARGS_CHARS + 250),
    });
    const msg = JSON.parse((ws as any)._sentMessages[0]);
    expect(msg.type).toBe(S2C.STREAMING_TOOL_CALL);
    expect(msg.args).toHaveLength(MAX_STREAMING_TOOL_CALL_ARGS_CHARS + "...[truncated]".length);
    expect(msg.args.startsWith("xxxx")).toBe(true);
    expect(msg.args.endsWith("...[truncated]")).toBe(true);
  });
});

// ── Streaming tool-call preview postures (delta vs cumulative) ──────────────
// One builder, two postures: a socket whose C2S AUTH attested
// `toolCallDeltas: true` gets {index, name, delta} increments with per-index
// cap bookkeeping; every other socket keeps the cumulative frame BYTE-
// IDENTICAL to the pre-delta wire (the version-skew guarantee).

function postureRig(attested: boolean) {
  let savedHandler: ((event: OutputEvent) => void) | null = null;
  const sm = createMockSessionManager({
    onSessionEvents: mock((_sessionId, handler) => {
      savedHandler = handler;
      return () => {};
    }),
  });
  const ws = createMockWs() as any;
  if (attested) ws.toolCallDeltas = true;
  new WebSocketChannel({ sessionManager: sm, ws, sessionId: "session-1" });
  const raw = () => ws._sentMessages as string[];
  return {
    emit: (ev: OutputEvent) => savedHandler!(ev),
    raw,
    frames: () => raw().map((s) => JSON.parse(s)),
  };
}

describe("WebSocketChannel - streaming tool-call delta posture (attested socket)", () => {
  it("increment frames carry ONLY the delta, in the fixed field order, no args field", () => {
    const rig = postureRig(true);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: '{"comm', argsDelta: '{"comm' });
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: '{"command":"ls"}', argsDelta: 'and":"ls"}' });
    expect(rig.raw()).toEqual([
      '{"type":"streamingToolCall","sessionId":"session-1","index":0,"name":"bash","delta":"{\\"comm"}',
      '{"type":"streamingToolCall","sessionId":"session-1","index":0,"name":"bash","delta":"and\\":\\"ls\\"}"}',
    ]);
    // Defense in depth on the shape: an args field would re-open the flood.
    for (const f of rig.frames()) expect("args" in f).toBe(false);
  });

  it("a name-only event ships an empty delta (and an event without argsDelta carries no increment)", () => {
    const rig = postureRig(true);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "", args: "", argsDelta: "" });
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: "" });
    expect(rig.frames()).toEqual([
      { type: "streamingToolCall", sessionId: "session-1", index: 0, name: "", delta: "" },
      { type: "streamingToolCall", sessionId: "session-1", index: 0, name: "bash", delta: "" },
    ]);
  });

  it("parallel calls interleave without disturbing each other's slots", () => {
    const rig = postureRig(true);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "read", args: "a", argsDelta: "a" });
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 1, name: "bash", args: "L", argsDelta: "L" });
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "read", args: "ab", argsDelta: "b" });
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 1, name: "bash", args: "LM", argsDelta: "M" });
    expect(rig.frames().map((f) => [f.index, f.delta])).toEqual([
      [0, "a"],
      [1, "L"],
      [0, "b"],
      [1, "M"],
    ]);
  });

  it("the cap binds the ASSEMBLED preview: crossing frame ships head + marker once, then the slot goes silent", () => {
    const rig = postureRig(true);
    const head = "x".repeat(1500);
    const cross = "y".repeat(1500);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: head, argsDelta: head });
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: head + cross, argsDelta: cross });
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: head + cross + "z", argsDelta: "z" });
    // Another slot is untouched by index 0's silence.
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 1, name: "bash", args: "{}", argsDelta: "{}" });
    const frames = rig.frames();
    expect(frames).toHaveLength(3); // second delta truncated; third dropped
    expect(frames[1]!.delta).toBe(`${"y".repeat(500)}...[truncated]`);
    expect(frames[2]!.index).toBe(1);
  });

  it("streamReset clears the per-index bookkeeping: the retry's deltas flow again", () => {
    const rig = postureRig(true);
    const big = "x".repeat(MAX_STREAMING_TOOL_CALL_ARGS_CHARS + 10);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: big, argsDelta: big });
    expect(rig.frames()[0]!.delta.endsWith("...[truncated]")).toBe(true);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: big + "z", argsDelta: "z" });
    expect(rig.frames()).toHaveLength(1); // still latched
    rig.emit({ type: OUTPUT_EVENT.STREAM_RESET });
    expect(rig.frames()[1]!.type).toBe(S2C.STREAM_RESET);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: "fresh", argsDelta: "fresh" });
    expect(rig.frames()[2]).toEqual({
      type: "streamingToolCall",
      sessionId: "session-1",
      index: 0,
      name: "write",
      delta: "fresh",
    });
  });

  it("the final TOOL_CALL frame releases the slots for the next round", () => {
    const rig = postureRig(true);
    const big = "x".repeat(MAX_STREAMING_TOOL_CALL_ARGS_CHARS + 10);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: big, argsDelta: big });
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: big + "z", argsDelta: "z" });
    expect(rig.frames()).toHaveLength(1);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "write", input: big + "z", toolCallId: "c1" });
    // The next LLM call reuses slot 0 from zero: no marker, no silence.
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "grep", args: "q", argsDelta: "q" });
    const last = rig.frames()[rig.frames().length - 1]!;
    expect(last).toEqual({
      type: "streamingToolCall",
      sessionId: "session-1",
      index: 0,
      name: "grep",
      delta: "q",
    });
  });
});

describe("WebSocketChannel - streaming tool-call cumulative posture (unattested socket)", () => {
  it("keeps today's frame BYTE-IDENTICAL, even when the event carries an argsDelta", () => {
    const rig = postureRig(false);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: '{"comm', argsDelta: '{"comm' });
    // Exact serialized bytes, field order included: the legacy guarantee.
    expect(rig.raw()[0]).toBe(
      '{"type":"streamingToolCall","sessionId":"session-1","index":0,"name":"bash","args":"{\\"comm"}',
    );
  });

  it("keeps the legacy cap idiom unchanged", () => {
    const rig = postureRig(false);
    const big = "x".repeat(MAX_STREAMING_TOOL_CALL_ARGS_CHARS + 250);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: big, argsDelta: "x".repeat(250) });
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "write", args: big, argsDelta: "" });
    for (const raw of rig.raw()) {
      const f = JSON.parse(raw);
      expect(f.args).toHaveLength(MAX_STREAMING_TOOL_CALL_ARGS_CHARS + "...[truncated]".length);
      expect(f.args.endsWith("...[truncated]")).toBe(true);
      expect("delta" in f).toBe(false);
    }
  });

  it("a capability that never attests never grows cap bookkeeping (junk argsDelta is inert)", () => {
    const rig = postureRig(false);
    rig.emit({ type: OUTPUT_EVENT.TOOL_CALL_DELTA, index: 0, name: "bash", args: "ab", argsDelta: "ab" });
    expect(rig.frames()[0]).toEqual({
      type: "streamingToolCall",
      sessionId: "session-1",
      index: 0,
      name: "bash",
      args: "ab",
    });
  });
});

describe("WebSocketChannel - write error handling", () => {
  it("marks as not ready when an event send throws", () => {
    let savedHandler: ((event: OutputEvent) => void) | null = null;
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        savedHandler = handler;
        return () => {};
      }),
    });
    const ws = createMockWs({ send: mock(() => { throw new Error("Connection closed"); }) });

    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    // Fire an event through the saved handler
    savedHandler!({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "test" });

    expect(channel.isReady).toBe(false);
  });
});

describe("WebSocketChannel - read()", () => {
  it("yields empty string (placeholder)", async () => {
    const sm = createMockSessionManager();
    const ws = createMockWs();

    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    const results: string[] = [];
    for await (const line of channel.read()) {
      results.push(line);
    }

    expect(results).toEqual([""]);
  });
});

describe("WebSocketChannel - cleanup", () => {
  it("marks as not ready on close", () => {
    const sm = createMockSessionManager();
    const ws = createMockWs();

    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    expect(channel.isReady).toBe(true);
    channel.close();
    expect(channel.isReady).toBe(false);
  });
});

describe("WebSocketChannel - sendJson", () => {
  let sm: ChannelSessionManager;
  let ws: Bun.ServerWebSocket;
  let channel: WebSocketChannel;

  beforeEach(() => {
    sm = createMockSessionManager();
    ws = createMockWs();
    channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });
  });

  it("sends JSON message directly", () => {
    channel.sendJson({ type: "custom", data: "test" });

    const sent = (ws as any)._sentMessages;
    expect(sent.length).toBe(1);
    expect(sent[0]).toBe('{"type":"custom","data":"test"}');
  });

  it("does not send when not ready", () => {
    channel.close();
    channel.sendJson({ type: "custom", data: "test" });

    const sent = (ws as any)._sentMessages;
    expect(sent.length).toBe(0);
  });

  it("marks as not ready when send throws", () => {
    const ws = createMockWs({
      send: mock(() => { throw new Error("Connection closed"); }),
    });
    const sm = createMockSessionManager();

    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    channel.sendJson({ type: "test" });
    expect(channel.isReady).toBe(false);
  });
});

describe("WebSocketChannel - getters", () => {
  it("exposes WebSocket connection", () => {
    const sm = createMockSessionManager();
    const ws = createMockWs();

    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    expect(channel.ws).toBe(ws);
  });

  it("exposes sessionId", () => {
    const sm = createMockSessionManager();
    const ws = createMockWs();

    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "my-session",
    });

    expect(channel.sessionId).toBe("my-session");
  });

});

describe("WebSocketChannel - broadcast without callback", () => {
  it("does not broadcast SESSION_STATE when no callback provided", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.SESSION_STATE, key: "model", value: "gpt-4" });
        return () => {};
      }),
    });
    const ws = createMockWs();

    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
      // No broadcastCallback
    });

    // Should not throw — broadcast is skipped when no callback
    const sent = (ws as any)._sentMessages;
    expect(sent.length).toBe(1);
  });
});

describe("WebSocketChannel - TASK_PROGRESS without message", () => {
  it("maps TASK_PROGRESS without message field", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({
          type: OUTPUT_EVENT.TASK_PROGRESS,
          taskId: "task-1",
          status: "done",
        });
        return () => {};
      }),
    });
    const ws = createMockWs();

    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    const sent = (ws as any)._sentMessages;
    const msg = JSON.parse(sent[0]);
    expect(msg.type).toBe(S2C.TASK_PROGRESS);
    expect(msg.taskId).toBe("task-1");
    expect(msg.status).toBe("done");
    expect(msg.message).toBeUndefined();
  });
});

// ── Images on the wire ──────────────────────────────────────────────────────

describe("WebSocketChannel - image payloads", () => {
  function sendEvent(event: Record<string, unknown>): any {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler(event as any);
        return () => {};
      }),
    });
    const ws = createMockWs();
    new WebSocketChannel({ sessionManager: sm, ws, sessionId: "session-1" });
    const sent = (ws as any)._sentMessages;
    return sent.length > 0 ? JSON.parse(sent[0]) : undefined;
  }

  it("serializes toolResult images as { mimeType, data }", () => {
    const msg = sendEvent({
      type: OUTPUT_EVENT.TOOL_RESULT,
      toolName: "read",
      content: "Image: photo.png (image/png, 1.0KB)",
      toolCallId: "tc-1",
      images: [{ type: "image_url", mimeType: "image/png", data: "aGVsbG8=" }],
    });
    expect(msg.type).toBe(S2C.TOOL_RESULT);
    expect(msg.images).toEqual([{ mimeType: "image/png", data: "aGVsbG8=" }]);
  });

  it("serializes userMessage images (file-attachment)", () => {
    const msg = sendEvent({
      type: OUTPUT_EVENT.USER_MESSAGE,
      content: "look at @pic.jpg",
      images: [{ type: "image_url", mimeType: "image/jpeg", data: "aW1hZ2U=" }],
    });
    expect(msg.type).toBe(S2C.USER_MESSAGE);
    expect(msg.images).toEqual([{ mimeType: "image/jpeg", data: "aW1hZ2U=" }]);
  });

  it("omits the images field when there are no images", () => {
    const msg = sendEvent({
      type: OUTPUT_EVENT.TOOL_RESULT,
      toolName: "bash",
      content: "ok",
      toolCallId: "tc-2",
    });
    expect(msg.images).toBeUndefined();
  });

  it("caps oversized base64 with a placeholder note instead of the payload", () => {
    const huge = "A".repeat(MAX_WIRE_IMAGE_BASE64_BYTES + 1);
    const msg = sendEvent({
      type: OUTPUT_EVENT.TOOL_RESULT,
      toolName: "read",
      content: "Image: big.png",
      toolCallId: "tc-3",
      images: [{ type: "image_url", mimeType: "image/png", data: huge }],
    });
    expect(msg.images).toHaveLength(1);
    expect(msg.images[0].skipped).toBe(true);
    expect(msg.images[0].data).toBeUndefined();
    expect(msg.images[0].note).toContain("too large");
  });
});

describe("wireImages()", () => {
  it("passes well-formed ImageAttachments through (type field dropped)", () => {
    expect(
      wireImages([{ type: "image_url", mimeType: "image/webp", data: "eA==" }]),
    ).toEqual([{ mimeType: "image/webp", data: "eA==" }]);
  });

  it("normalizes the legacy data-URL form", () => {
    expect(wireImages([{ url: "data:image/gif;base64,R0lGOD" }])).toEqual([
      { mimeType: "image/gif", data: "R0lGOD" },
    ]);
  });

  it("defaults a missing mimeType to image/png and drops entries without data", () => {
    expect(wireImages([{ type: "image_url", data: "YQ==" }])).toEqual([
      { mimeType: "image/png", data: "YQ==" },
    ]);
    expect(wireImages([{ type: "image_url", mimeType: "image/png" }])).toBeUndefined();
    expect(wireImages([])).toBeUndefined();
    expect(wireImages(undefined)).toBeUndefined();
    expect(wireImages("nonsense")).toBeUndefined();
  });

  it("skips images over the cap with a note", () => {
    const out = wireImages([{ mimeType: "image/png", data: "x".repeat(100) }], 50);
    expect(out).toEqual([
      { mimeType: "image/png", skipped: true, note: expect.stringContaining("too large") },
    ]);
  });
});

// ── Mid-stream reset wire contract (finding H-3) ─────────────────────────────
// The additive S2C `streamReset` message and, critically, its WIRE ORDER: a
// browser must receive the clear strictly before the retry's deltas, so its
// in-flight assistant/thinking accumulators never show a dead attempt.

describe("WebSocketChannel - streamReset (mid-stream retry)", () => {
  function makeLiveChannel(): { emit: (event: OutputEvent) => void; sent: () => any[] } {
    let savedHandler: ((event: OutputEvent) => void) | null = null;
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        savedHandler = handler;
        return () => {};
      }),
    });
    const ws = createMockWs();
    new WebSocketChannel({ sessionManager: sm, ws, sessionId: "session-1" });
    return {
      emit: (event) => savedHandler!(event),
      // Live view: JSON-parsed on read, since sends happen after construction.
      sent: () => (ws as any)._sentMessages.map((s: string) => JSON.parse(s)),
    };
  }

  it("maps STREAM_RESET to a payload-free streamReset carrying only type + sessionId", () => {
    const { emit, sent } = makeLiveChannel();
    emit({ type: OUTPUT_EVENT.STREAM_RESET });
    const msgs = sent();
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toEqual({ type: S2C.STREAM_RESET, sessionId: "session-1" });
    // No content/name/etc. ride along -- the event IS the instruction.
    expect(Object.keys(msgs[0]).sort()).toEqual(["sessionId", "type"]);
  });

  it("the S2C sequence clears before the retry's deltas (browser receives reset between dead and live chunks)", () => {
    const { emit, sent } = makeLiveChannel();
    emit({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "DEAD-T" });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "DEAD" });
    emit({ type: OUTPUT_EVENT.STREAM_RESET });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "clean " });
    emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "answer" });

    const msgs = sent();
    expect(msgs.map((m) => m.type)).toEqual([
      S2C.STREAMING_REASONING_CHUNK,
      S2C.STREAMING_CHUNK,
      S2C.STREAM_RESET,
      S2C.STREAMING_CHUNK,
      S2C.STREAMING_CHUNK,
    ]);
    // The reset sits at index 2: every dead chunk precedes it, every live
    // chunk follows. A client that drops state on reset shows only "clean answer".
    const resetIdx = msgs.findIndex((m) => m.type === S2C.STREAM_RESET);
    const liveIdx = msgs.findIndex((m) => m.type === S2C.STREAMING_CHUNK && m.content === "clean ");
    expect(resetIdx).toBeLessThan(liveIdx);
    expect(msgs.slice(resetIdx + 1).some((m) => typeof m.content === "string" && m.content.includes("DEAD"))).toBe(false);
  });
});
