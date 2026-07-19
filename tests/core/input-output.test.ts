// Tests for context/output.ts — OutputSink, NoopSink, outputEvent, EVENT_HANDLERS.
// parseInput and NoopInput are tested in input.test.ts.

import { describe, it, expect, beforeEach } from "bun:test";
import {
  OutputSink,
  NoopSink,
  OUTPUT_EVENT,
  outputEvent,
  EVENT_HANDLERS,
} from "../../src/core/context/output.ts";

describe("OutputSink", () => {
  let capturedStdout: string[] = [];
  let capturedStderr: string[] = [];

  beforeEach(() => {
    capturedStdout.length = 0;
    capturedStderr.length = 0;
  });

  describe("constructor", () => {
    it("defaults stream to true", () => {
      expect(new OutputSink().stream).toBe(true);
    });

    it("respects stream option", () => {
      expect(new OutputSink({ stream: false }).stream).toBe(false);
    });
  });

  describe("emit", () => {
    it("dispatches events to correct handlers", () => {
      const sink = new OutputSink({ stream: false });
      let callCount = 0;
      sink.emitAssistantMessage = () => { callCount++; };

      sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "test" });
      expect(callCount).toBe(1);
    });

    it("ignores unknown event types", () => {
      const sink = new OutputSink();
      expect(() => sink.emit({ type: 999 as any })).not.toThrow();
    });
  });

  describe("emitAssistantMessage", () => {
    it("writes content to stdout", () => {
      const origWrite = process.stdout.write;
      process.stdout.write = (data) => { capturedStdout.push(data as string); return true; };

      try {
        const sink = new OutputSink({ stream: false });
        sink.emitAssistantMessage({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "Hello" });
        expect(capturedStdout).toContain("Hello");
      } finally {
        process.stdout.write = origWrite;
      }
    });
  });

  describe("emitThinking", () => {
    it("writes content to stderr", () => {
      const origWrite = process.stderr.write;
      process.stderr.write = (data) => { capturedStderr.push(data as string); return true; };

      try {
        const sink = new OutputSink({ stream: false });
        sink.emitThinking({ type: OUTPUT_EVENT.THINKING, content: "Thinking..." });
        expect(capturedStderr).toContain("Thinking...");
      } finally {
        process.stderr.write = origWrite;
      }
    });
  });

  describe("emitCommandResult", () => {
    it("writes content with newline to stdout", () => {
      const origWrite = process.stdout.write;
      process.stdout.write = (data) => { capturedStdout.push(data as string); return true; };

      try {
        const sink = new OutputSink({ stream: false });
        sink.emitCommandResult({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "Result" });
        expect(capturedStdout).toContain("Result\n");
      } finally {
        process.stdout.write = origWrite;
      }
    });
  });

  describe("emitStreamingChunk", () => {
    it("writes content when stream is true", () => {
      const origWrite = process.stdout.write;
      process.stdout.write = (data) => { capturedStdout.push(data as string); return true; };

      try {
        const sink = new OutputSink({ stream: true });
        sink.emitStreamingChunk({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "chunk" });
        expect(capturedStdout).toContain("chunk");
      } finally {
        process.stdout.write = origWrite;
      }
    });

    it("does not write when stream is false", () => {
      const origWrite = process.stdout.write;
      let writeCalled = false;
      process.stdout.write = () => { writeCalled = true; return true; };

      try {
        const sink = new OutputSink({ stream: false });
        sink.emitStreamingChunk({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "chunk" });
        expect(writeCalled).toBe(false);
      } finally {
        process.stdout.write = origWrite;
      }
    });
  });

  describe("emitStreamingReasoningChunk", () => {
    it("writes content to stderr when stream is true", () => {
      const origWrite = process.stderr.write;
      process.stderr.write = (data) => { capturedStderr.push(data as string); return true; };

      try {
        const sink = new OutputSink({ stream: true });
        sink.emitStreamingReasoningChunk({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "reasoning" });
        expect(capturedStderr).toContain("reasoning");
      } finally {
        process.stderr.write = origWrite;
      }
    });
  });

  describe("no-op handlers", () => {
    it("user message, tool call, tool result, compacting, question, task progress, token usage, and reset are no-ops", () => {
      const sink = new OutputSink();
      // All these handlers should be no-ops that don't throw
      expect(() => sink.emitUserMessage({ type: OUTPUT_EVENT.USER_MESSAGE, content: "test" })).not.toThrow();
      expect(() => sink.emitToolCall({ type: OUTPUT_EVENT.TOOL_CALL, tool: "bash" })).not.toThrow();
      expect(() => sink.emitToolResult({ type: OUTPUT_EVENT.TOOL_RESULT, output: "done" })).not.toThrow();
      expect(() => sink.emitCompacting({ type: OUTPUT_EVENT.COMPACTING } as any)).not.toThrow();
      expect(() => sink.emitQuestion({ type: OUTPUT_EVENT.QUESTION, questions: [] })).not.toThrow();
      expect(() => sink.emitTaskProgress({ type: OUTPUT_EVENT.TASK_PROGRESS } as any)).not.toThrow();
      expect(() => sink.emitTokenUsage({ type: OUTPUT_EVENT.TOKEN_USAGE } as any)).not.toThrow();
      expect(() => sink.reset()).not.toThrow();
    });
  });
});

describe("NoopSink", () => {
  it("emit is a no-op for any input", () => {
    const sink = new NoopSink();
    expect(() => sink.emit({ type: 1, content: "test" })).not.toThrow();
    expect(() => sink.emit(null as any)).not.toThrow();
    expect(() => sink.emit(undefined as any)).not.toThrow();
  });
});

describe("outputEvent", () => {
  it("creates event with type and data", () => {
    const event = outputEvent(OUTPUT_EVENT.USER_MESSAGE, { content: "Hello" });
    expect(event.type).toBe(OUTPUT_EVENT.USER_MESSAGE);
    expect(event.content).toBe("Hello");
  });

  it("creates event with default empty data", () => {
    const event = outputEvent(OUTPUT_EVENT.TOKEN_USAGE);
    expect(event.type).toBe(OUTPUT_EVENT.TOKEN_USAGE);
    expect(Object.keys(event)).toEqual(["type"]);
  });
});

describe("EVENT_HANDLERS", () => {
  it("maps all output event types to handler names", () => {
    expect(EVENT_HANDLERS[OUTPUT_EVENT.USER_MESSAGE]).toBe("emitUserMessage");
    expect(EVENT_HANDLERS[OUTPUT_EVENT.ASSISTANT_MESSAGE]).toBe("emitAssistantMessage");
    expect(EVENT_HANDLERS[OUTPUT_EVENT.THINKING]).toBe("emitThinking");
    expect(EVENT_HANDLERS[OUTPUT_EVENT.TOOL_CALL]).toBe("emitToolCall");
    expect(EVENT_HANDLERS[OUTPUT_EVENT.STREAMING_CHUNK]).toBe("emitStreamingChunk");
    expect(EVENT_HANDLERS[OUTPUT_EVENT.COMPACTION_RESULT]).toBe("emitCompactionResult");
    expect(EVENT_HANDLERS[OUTPUT_EVENT.SESSION_STATE]).toBe("emitSessionState");
  });

  it("has a handler for every OUTPUT_EVENT type", () => {
    for (const [, value] of Object.entries(OUTPUT_EVENT)) {
      expect(EVENT_HANDLERS[value]).toBeDefined();
    }
  });
});
