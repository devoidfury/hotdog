// Tests for src/extensions/websocket/websocket-channel.ts — WebSocketChannel.
// Base Channel behavior (send/enqueue, attach/detach, close, command routing)
// is covered in tests/core/channel.test.ts. Only the behavior specific to this
// subclass (event-to-protocol mapping, readiness, sendJson, pending question
// replay) is tested here.

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { WebSocketChannel } from "../../src/extensions/websocket/websocket-channel.ts";
import { ChannelSessionManager } from "../../src/core/channel.ts";
import { OUTPUT_EVENT, OutputEvent } from "../../src/core/context/output.ts";
import { S2C } from "../../src/extensions/websocket/protocol.ts";

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
    drainPendingQuestions: mock(() => []),
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

  it("replays pending questions on construction", () => {
    const pendingQuestions = [[{ key: "q1", prompt: "Question 1" }]];
    const sm = createMockSessionManager({
      drainPendingQuestions: mock(() => pendingQuestions),
    });
    const ws = createMockWs();

    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    expect(sm.drainPendingQuestions).toHaveBeenCalledWith("session-1");
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
      name: "TOOL_RESULT",
      event: { type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", result: "file.txt" },
      expected: (msg: any) => {
        expect(msg.type).toBe(S2C.TOOL_RESULT);
        expect(msg.name).toBe("bash");
        expect(msg.output).toBe("file.txt");
      },
    },
    {
      name: "TOOL_RESULT with error",
      event: { type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", error: "Permission denied" },
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
});

describe("WebSocketChannel - write error handling", () => {
  it("marks as not ready when send throws", () => {
    let savedHandler: ((event: OutputEvent) => void) | null = null;
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        savedHandler = handler;
        return () => {};
      }),
    });

    const ws = {
      readyState: WebSocket.OPEN,
      send: () => { throw new Error("Connection closed"); },
      close: () => {},
      onopen: null,
      onclose: null,
      onerror: null,
      onmessage: null,
    } as unknown as Bun.ServerWebSocket;

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

describe("WebSocketChannel - pending questions replay", () => {
  it("replays multiple pending question sets", () => {
    const pendingQuestions = [
      [{ key: "q1", prompt: "Question 1" }],
      [{ key: "q2", prompt: "Question 2" }],
    ];
    const sm = createMockSessionManager({
      drainPendingQuestions: mock(() => pendingQuestions),
      onSessionEvents: mock(() => () => {}),
    });
    const ws = createMockWs();

    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    const sent = (ws as any)._sentMessages;
    expect(sent.length).toBe(2);
    const msg1 = JSON.parse(sent[0]);
    const msg2 = JSON.parse(sent[1]);
    expect(msg1.type).toBe(S2C.QUESTION);
    expect(msg2.type).toBe(S2C.QUESTION);
    expect(msg1.questions[0].key).toBe("q1");
    expect(msg2.questions[0].key).toBe("q2");
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
