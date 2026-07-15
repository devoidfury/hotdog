// Tests for websocket/sinks.ts — FanoutSink, WebSocketOutputSink, BackgroundSink.

import { describe, it, expect } from "bun:test";
import { OUTPUT_EVENT, OutputEvent } from "../../src/core/context/output.ts";
import { FanoutSink, WebSocketOutputSink, BackgroundSink } from "../../src/extensions/websocket/sinks.ts";

describe("FanoutSink", () => {
  function createCapturingSink() {
    const events: OutputEvent[] = [];
    return {
      emit: (event: OutputEvent) => { events.push(event); },
      events,
    };
  }

  it("distributes events to all registered sinks", () => {
    const sink1 = createCapturingSink();
    const sink2 = createCapturingSink();

    const fanout = new FanoutSink();
    fanout.add(sink1);
    fanout.add(sink2);

    const event: OutputEvent = { type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" };
    fanout.emit(event);

    expect(sink1.events).toHaveLength(1);
    expect(sink2.events).toHaveLength(1);
  });

  it("removes sinks correctly", () => {
    const sink1 = createCapturingSink();
    const sink2 = createCapturingSink();

    const fanout = new FanoutSink();
    fanout.add(sink1);
    fanout.add(sink2);
    fanout.remove(sink1);

    const event: OutputEvent = { type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" };
    fanout.emit(event);

    expect(sink1.events).toHaveLength(0);
    expect(sink2.events).toHaveLength(1);
  });

  it("reports correct size", () => {
    const fanout = new FanoutSink();
    expect(fanout.size).toBe(0);

    const sink = { emit: () => {} };
    fanout.add(sink);
    expect(fanout.size).toBe(1);

    fanout.remove(sink);
    expect(fanout.size).toBe(0);
  });

  it("continues emitting to other sinks if one throws", () => {
    const sink1 = createCapturingSink();
    const sink2 = {
      emit: () => { throw new Error("sink error"); },
    };
    const sink3 = createCapturingSink();

    const fanout = new FanoutSink();
    fanout.add(sink1);
    fanout.add(sink2);
    fanout.add(sink3);

    const event: OutputEvent = { type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" };
    fanout.emit(event);

    expect(sink1.events).toHaveLength(1);
    expect(sink3.events).toHaveLength(1);
  });
});

describe("BackgroundSink", () => {
  it("silently drops streaming chunks", () => {
    const sink = new BackgroundSink();
    let errorCaught = false;

    try {
      sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "chunk" });
      sink.emit({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "reasoning" });
    } catch {
      errorCaught = true;
    }

    expect(errorCaught).toBe(false);
  });

  it("buffers QUESTION events", () => {
    const sink = new BackgroundSink();

    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [
        { key: "name", prompt: "What is your name?" },
        { key: "age", prompt: "How old are you?" },
      ],
    });

    const pending = sink.drainPendingQuestions();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toEqual([
      { key: "name", prompt: "What is your name?" },
      { key: "age", prompt: "How old are you?" },
    ]);
  });

  it("drainPendingQuestions clears the buffer", () => {
    const sink = new BackgroundSink();

    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{ key: "q1", prompt: "Q1?" }],
    });

    sink.drainPendingQuestions();
    const afterDrain = sink.drainPendingQuestions();
    expect(afterDrain).toEqual([]);
  });

  it("silently handles other event types", () => {
    const sink = new BackgroundSink();

    // These should all be no-ops
    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" });
    sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "hi" });
    sink.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: "{}" });
    sink.emit({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", result: "done" });
    sink.emit({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "result" });
    sink.emit({ type: OUTPUT_EVENT.TASK_PROGRESS, taskId: "t1", status: "running" });
    sink.emit({ type: OUTPUT_EVENT.TOKEN_USAGE, promptTokens: 10, completionTokens: 20, totalTokens: 30, lastPromptTokens: 0, lastCompletionTokens: 0, lastTotalTokens: 0, lastCachedTokens: 0 });
    sink.emit({ type: OUTPUT_EVENT.SESSION_STATE, key: "working", value: false });
    // No errors should be thrown
  });
});

describe("WebSocketOutputSink", () => {
  function createMockWs() {
    const messages: string[] = [];
    return {
      send: (data: string) => { messages.push(data); },
      messages,
    } as unknown as WebSocket;
  }

  it("maps USER_MESSAGE to protocol", () => {
    const ws = createMockWs();
    const sink = new WebSocketOutputSink(ws as unknown as WebSocket, "session-1");

    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" });

    const msg = JSON.parse((ws as any).messages[0]);
    expect(msg.type).toBe("userMessage");
    expect(msg.sessionId).toBe("session-1");
    expect(msg.content).toBe("hello");
  });

  it("maps ASSISTANT_MESSAGE to protocol", () => {
    const ws = createMockWs();
    const sink = new WebSocketOutputSink(ws as unknown as WebSocket, "session-1");

    sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "hi there" });

    const msg = JSON.parse((ws as any).messages[0]);
    expect(msg.type).toBe("assistantMessage");
    expect(msg.content).toBe("hi there");
  });

  it("maps TOOL_CALL to protocol", () => {
    const ws = createMockWs();
    const sink = new WebSocketOutputSink(ws as unknown as WebSocket, "session-1");

    sink.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: '{"cmd":"ls"}' });

    const msg = JSON.parse((ws as any).messages[0]);
    expect(msg.type).toBe("toolCall");
    expect(msg.name).toBe("bash");
    expect(msg.args).toBe('{"cmd":"ls"}');
  });

  it("maps TOOL_RESULT to protocol", () => {
    const ws = createMockWs();
    const sink = new WebSocketOutputSink(ws as unknown as WebSocket, "session-1");

    sink.emit({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", result: "output here" });

    const msg = JSON.parse((ws as any).messages[0]);
    expect(msg.type).toBe("toolResult");
    expect(msg.name).toBe("bash");
    expect(msg.output).toBe("output here");
  });

  it("maps TOOL_RESULT with error to protocol", () => {
    const ws = createMockWs();
    const sink = new WebSocketOutputSink(ws as unknown as WebSocket, "session-1");

    sink.emit({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", error: "command not found" });

    const msg = JSON.parse((ws as any).messages[0]);
    expect(msg.error).toBe("command not found");
  });

  it("maps TOKEN_USAGE to protocol", () => {
    const ws = createMockWs();
    const sink = new WebSocketOutputSink(ws as unknown as WebSocket, "session-1");

    sink.emit({
      type: OUTPUT_EVENT.TOKEN_USAGE,
      promptTokens: 100,
      completionTokens: 50,
      totalTokens: 150,
      lastPromptTokens: 80,
      lastCompletionTokens: 30,
      lastTotalTokens: 110,
      lastCachedTokens: 10,
    });

    const msg = JSON.parse((ws as any).messages[0]);
    expect(msg.type).toBe("tokenUsage");
    expect(msg.promptTokens).toBe(100);
    expect(msg.completionTokens).toBe(50);
    expect(msg.totalTokens).toBe(150);
    expect(msg.lastPromptTokens).toBe(80);
    expect(msg.lastCompletionTokens).toBe(30);
    expect(msg.lastTotalTokens).toBe(110);
    expect(msg.lastCachedTokens).toBe(10);
  });

  it("maps TASK_PROGRESS to protocol", () => {
    const ws = createMockWs();
    const sink = new WebSocketOutputSink(ws as unknown as WebSocket, "session-1");

    sink.emit({
      type: OUTPUT_EVENT.TASK_PROGRESS,
      taskId: "task-1",
      status: "running",
      message: "processing",
    });

    const msg = JSON.parse((ws as any).messages[0]);
    expect(msg.type).toBe("taskProgress");
    expect(msg.taskId).toBe("task-1");
    expect(msg.status).toBe("running");
    expect(msg.message).toBe("processing");
  });

  it("maps QUESTION to protocol", () => {
    const ws = createMockWs();
    const sink = new WebSocketOutputSink(ws as unknown as WebSocket, "session-1");

    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{ key: "name", prompt: "Name?" }],
    });

    const msg = JSON.parse((ws as any).messages[0]);
    expect(msg.type).toBe("question");
    expect(msg.questions).toEqual([{ key: "name", prompt: "Name?" }]);
  });

  it("disconnects stops emitting", () => {
    const ws = createMockWs();
    const sink = new WebSocketOutputSink(ws as unknown as WebSocket, "session-1");

    sink.disconnect();
    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" });

    expect((ws as any).messages).toHaveLength(0);
  });

  it("reconnects with new WebSocket", () => {
    const ws1 = createMockWs();
    const ws2 = createMockWs();
    const sink = new WebSocketOutputSink(ws1 as unknown as WebSocket, "session-1");

    sink.disconnect();
    sink.reconnect(ws2 as unknown as WebSocket);

    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" });

    expect((ws1 as any).messages).toHaveLength(0);
    expect((ws2 as any).messages).toHaveLength(1);
  });

  it("handles WebSocket send error gracefully", () => {
    const ws = {
      send: () => { throw new Error("connection closed"); },
      messages: [],
    } as unknown as WebSocket;

    const sink = new WebSocketOutputSink(ws, "session-1");
    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" });

    // Should not throw, should mark as disconnected
    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "after error" });
    expect((ws as any).messages).toHaveLength(0);
  });
});
