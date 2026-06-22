import { describe, it, expect } from "bun:test";
import {
  OutputSink,
  NoopSink,
  OUTPUT_EVENT,
  outputEvent,
} from "../../src/core/context/output.js";

describe("outputEvent", () => {
  it("creates event with type and data", () => {
    const event = outputEvent(OUTPUT_EVENT.USER_MESSAGE, { content: "hello" });
    expect(event.type).toBe(OUTPUT_EVENT.USER_MESSAGE);
    expect(event.content).toBe("hello");
  });
});

describe("NoopSink", () => {
  it("does nothing on emit", () => {
    const sink = new NoopSink();
    expect(() => sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE })).not.toThrow();
  });
});

describe("OutputSink", () => {
  it("creates with stream enabled by default", () => {
    const sink = new OutputSink();
    expect(sink.stream).toBe(true);
  });

  it("accepts custom stream option", () => {
    const sink = new OutputSink({ stream: false });
    expect(sink.stream).toBe(false);
  });

  it("dispatches events to correct handlers", () => {
    const handlers = [];
    const sink = new OutputSink();
    sink.emitUserMessage = () => handlers.push("user");
    sink.emitAssistantMessage = () => handlers.push("assistant");
    sink.emitThinking = () => handlers.push("thinking");
    sink.emitToolCall = () => handlers.push("tool_call");
    sink.emitToolResult = () => handlers.push("tool_result");
    sink.emitCompacting = () => handlers.push("compacting");
    sink.emitCommandResult = () => handlers.push("command");
    sink.emitQuestion = () => handlers.push("question");
    sink.emitStreamingChunk = () => handlers.push("streaming");
    sink.emitStreamingReasoningChunk = () => handlers.push("reasoning");
    sink.emitTaskProgress = () => handlers.push("task");
    sink.emitTokenUsage = () => handlers.push("token");

    sink.emit(outputEvent(OUTPUT_EVENT.USER_MESSAGE));
    sink.emit(outputEvent(OUTPUT_EVENT.ASSISTANT_MESSAGE));
    sink.emit(outputEvent(OUTPUT_EVENT.THINKING));
    sink.emit(outputEvent(OUTPUT_EVENT.TOOL_CALL));
    sink.emit(outputEvent(OUTPUT_EVENT.TOOL_RESULT));
    sink.emit(outputEvent(OUTPUT_EVENT.COMMAND_RESULT));
    sink.emit(outputEvent(OUTPUT_EVENT.QUESTION));
    sink.emit(outputEvent(OUTPUT_EVENT.STREAMING_CHUNK));
    sink.emit(outputEvent(OUTPUT_EVENT.STREAMING_REASONING_CHUNK));
    sink.emit(outputEvent(OUTPUT_EVENT.TASK_PROGRESS));
    sink.emit(outputEvent(OUTPUT_EVENT.TOKEN_USAGE));

    expect(handlers).toEqual([
      "user", "assistant", "thinking", "tool_call", "tool_result",
      "command", "question", "streaming", "reasoning", "task", "token",
    ]);
  });

  it("ignores unknown event types", () => {
    const sink = new OutputSink();
    expect(() => sink.emit({ type: 999 })).not.toThrow();
  });

  it("emitAssistantMessage writes content to stdout", () => {
    const originalStdout = process.stdout.write;
    let written = "";
    process.stdout.write = (data) => { written += data; return true; };

    const sink = new OutputSink();
    sink.emitAssistantMessage({ content: "assistant output" });

    expect(written).toBe("assistant output");
    process.stdout.write = originalStdout;
  });

  it("emitThinking writes to stderr", () => {
    const originalStderr = process.stderr.write;
    let written = "";
    process.stderr.write = (data) => { written += data; return true; };

    const sink = new OutputSink();
    sink.emitThinking({ content: "thinking content" });

    expect(written).toBe("thinking content");
    process.stderr.write = originalStderr;
  });

  it("emitStreamingChunk respects stream setting", () => {
    const originalStdout = process.stdout.write;
    let written = "";
    process.stdout.write = (data) => { written += data; return true; };

    const streamingSink = new OutputSink({ stream: true });
    streamingSink.emitStreamingChunk({ content: "chunk" });
    expect(written).toBe("chunk");

    written = "";
    const nonStreamingSink = new OutputSink({ stream: false });
    nonStreamingSink.emitStreamingChunk({ content: "chunk" });
    expect(written).toBe("");

    process.stdout.write = originalStdout;
  });

  it("handlers do not throw for valid events", () => {
    const sink = new OutputSink();
    expect(() => sink.emitToolCall({ toolName: "bash", input: "{}" })).not.toThrow();
    expect(() => sink.emitToolResult({ toolName: "bash", result: "output" })).not.toThrow();
    expect(() => sink.emitCompacting({ messageCount: 10, keepRecent: 2 })).not.toThrow();
    expect(() => sink.emitTokenUsage({ totalTokens: 100 })).not.toThrow();
    expect(() => sink.reset()).not.toThrow();
  });
});
