// Tests for src/extensions/websocket/websocket-channel.ts — WebSocketChannel.
// Covers: construction, write/read, subscribe/unsubscribe, cleanup,
// event-to-protocol mapping, sendJson, getters, pending questions replay.

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { WebSocketChannel } from "../../src/extensions/websocket/websocket-channel.ts";
import { ChannelSessionManager } from "../../src/core/channel.ts";
import { OUTPUT_EVENT, OutputEvent } from "../../src/core/context/output.ts";
import { S2C } from "../../src/extensions/websocket/protocol.ts";

// ── Test Helpers ────────────────────────────────────────────────────────────

function createMockWs(overrides: Partial<WebSocket> = {}): WebSocket {
  const sentMessages: string[] = [];

  return {
    readyState: WebSocket.OPEN,
    send: mock((data: string) => {
      sentMessages.push(data);
    }),
    close: mock(() => {}),
    onopen: null,
    onclose: null,
    onerror: null,
    onmessage: null,
    _sentMessages: sentMessages,
    ...overrides,
  } as unknown as WebSocket;
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
  let ws: WebSocket;

  beforeEach(() => {
    sm = createMockSessionManager();
    ws = createMockWs();
  });

  it("creates a WebSocketChannel with required options", () => {
    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    expect(channel).toBeInstanceOf(WebSocketChannel);
    expect(channel.getCurrentSessionId()).toBe("session-1");
  });

  it("attaches to the given session on construction", () => {
    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    expect(sm.onSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
  });

  it("accepts optional broadcastCallback", () => {
    const broadcastCallback = mock(() => {});
    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
      broadcastCallback,
    });

    expect(true).toBe(true);
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
  let sm: ChannelSessionManager;
  let ws: WebSocket;

  beforeEach(() => {
    sm = createMockSessionManager();
    ws = createMockWs();
  });

  it("maps USER_MESSAGE events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.USER_MESSAGE, content: "Hello" });
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
    expect(msg.type).toBe(S2C.USER_MESSAGE);
    expect(msg.content).toBe("Hello");
    expect(msg.sessionId).toBe("session-1");
  });

  it("maps ASSISTANT_MESSAGE events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "AI response" });
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
    expect(msg.type).toBe(S2C.ASSISTANT_MESSAGE);
    expect(msg.content).toBe("AI response");
  });

  it("maps THINKING events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.THINKING, content: "Let me think..." });
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
    expect(msg.type).toBe(S2C.THINKING);
    expect(msg.content).toBe("Let me think...");
  });

  it("maps TOOL_CALL events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: { command: "ls" } });
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
    expect(msg.type).toBe(S2C.TOOL_CALL);
    expect(msg.name).toBe("bash");
    expect(msg.args).toEqual({ command: "ls" });
  });

  it("maps TOOL_RESULT events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", result: "file.txt" });
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
    expect(msg.type).toBe(S2C.TOOL_RESULT);
    expect(msg.name).toBe("bash");
    expect(msg.output).toBe("file.txt");
  });

  it("maps TOOL_RESULT with error to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", error: "Permission denied" });
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
    expect(msg.type).toBe(S2C.TOOL_RESULT);
    expect(msg.error).toBe("Permission denied");
  });

  it("maps COMPACTING events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.COMPACTING, message: "Compacting context..." });
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
    expect(msg.type).toBe(S2C.COMPACTING);
    expect(msg.message).toBe("Compacting context...");
  });

  it("maps COMMAND_RESULT events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "Command done" });
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
    expect(msg.type).toBe(S2C.COMMAND_RESULT);
    expect(msg.content).toBe("Command done");
  });

  it("maps QUESTION events to protocol", () => {
    const questions = [{ key: "q1", prompt: "What is your name?" }];
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.QUESTION, questions });
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
    expect(msg.type).toBe(S2C.QUESTION);
    expect(msg.questions).toEqual(questions);
  });

  it("maps STREAMING_CHUNK events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "partial" });
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
    expect(msg.type).toBe(S2C.STREAMING_CHUNK);
    expect(msg.content).toBe("partial");
  });

  it("maps STREAMING_REASONING_CHUNK events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "reasoning" });
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
    expect(msg.type).toBe(S2C.STREAMING_REASONING_CHUNK);
    expect(msg.content).toBe("reasoning");
  });

  it("maps TASK_PROGRESS events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({
          type: OUTPUT_EVENT.TASK_PROGRESS,
          taskId: "task-1",
          status: "running",
          message: "Processing...",
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
    expect(msg.status).toBe("running");
    expect(msg.message).toBe("Processing...");
  });

  it("maps TOKEN_USAGE events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({
          type: OUTPUT_EVENT.TOKEN_USAGE,
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          lastPromptTokens: 80,
          lastCompletionTokens: 40,
          lastTotalTokens: 120,
          lastCachedTokens: 10,
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
    expect(msg.type).toBe(S2C.TOKEN_USAGE);
    expect(msg.promptTokens).toBe(100);
    expect(msg.completionTokens).toBe(50);
    expect(msg.totalTokens).toBe(150);
    expect(msg.lastPromptTokens).toBe(80);
    expect(msg.lastCompletionTokens).toBe(40);
    expect(msg.lastTotalTokens).toBe(120);
    expect(msg.lastCachedTokens).toBe(10);
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
    expect(msg.promptTokens).toBe(0);
    expect(msg.completionTokens).toBe(0);
    expect(msg.totalTokens).toBe(0);
  });

  it("maps COMPACTION_RESULT events to protocol", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({
          type: OUTPUT_EVENT.COMPACTION_RESULT,
          summary: "Summary of conversation",
          messagesCompacted: 10,
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
    expect(msg.type).toBe(S2C.COMPACTION_RESULT);
    expect(msg.summary).toBe("Summary of conversation");
    expect(msg.messagesCompacted).toBe(10);
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
    } as unknown as WebSocket;

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

describe("WebSocketChannel - subscribe/unsubscribe", () => {
  let sm: ChannelSessionManager;
  let ws: WebSocket;
  let unsubscribeFn: () => void;

  beforeEach(() => {
    unsubscribeFn = mock(() => {});
    sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, _handler) => unsubscribeFn),
    });
    ws = createMockWs();
  });

  it("subscribes when attaching", () => {
    new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    expect(sm.onSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
  });

  it("unsubscribes when detaching", () => {
    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    channel.detach("session-1");

    expect(unsubscribeFn).toHaveBeenCalled();
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
  let ws: WebSocket;
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

  it("exposes isReady status", () => {
    const sm = createMockSessionManager();
    const ws = createMockWs();

    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    expect(channel.isReady).toBe(true);
  });
});

describe("WebSocketChannel - send regular text", () => {
  it("enqueues text to current session", async () => {
    const sm = createMockSessionManager();
    const ws = createMockWs();

    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    await channel.send("hello world");

    expect(sm.enqueue).toHaveBeenCalledWith("session-1", "hello world");
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

describe("WebSocketChannel - multiple session management", () => {
  it("can attach to multiple sessions", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock(() => () => {}),
    });
    const ws = createMockWs();

    const channel = new WebSocketChannel({
      sessionManager: sm,
      ws,
      sessionId: "session-1",
    });

    channel.attach("session-2");

    expect(channel.attachedSessions.has("session-1")).toBe(true);
    expect(channel.attachedSessions.has("session-2")).toBe(true);
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
