import { describe, it, expect } from "bun:test";
import {
  OutputSink,
  NoopSink,
  OUTPUT_EVENT,
  EVENT_HANDLERS,
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
    // Temporarily suppress stdout/stderr writes to avoid TypeError when content is missing
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
    try {
      const sink = new OutputSink();
      // Verify that each event type maps to a valid handler method
      const eventTypes = Object.keys(EVENT_HANDLERS).map(Number).filter(k => EVENT_HANDLERS[k]);
      for (const type of eventTypes) {
        const handler = EVENT_HANDLERS[type];
        expect(typeof sink[handler]).toBe("function");
      }
      // Verify dispatch by checking that emit calls the expected handler
      const calledHandlers = [];
      for (const type of eventTypes) {
        const handler = EVENT_HANDLERS[type];
        const original = sink[handler];
        sink[handler] = (event) => calledHandlers.push(handler);
        sink.emit(outputEvent(type));
        sink[handler] = original;
      }
      expect(calledHandlers).toEqual(Object.values(EVENT_HANDLERS));
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }
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
