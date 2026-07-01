// Tests for input.js parseInput() and output.js OutputSink/NoopSink.

import { describe, it, expect, beforeEach } from "bun:test";
import { parseInput, INPUT_EVENT, NoopInput } from "../../src/core/context/input.js";
import {
  OutputSink,
  NoopSink,
  OUTPUT_EVENT,
  outputEvent,
  EVENT_HANDLERS,
} from "../../src/core/context/output.js";

describe("parseInput", () => {
  it("parses command input starting with /", () => {
    expect(parseInput("/quit")).toEqual({ type: INPUT_EVENT.COMMAND, value: "quit" });
    expect(parseInput("/help")).toEqual({ type: INPUT_EVENT.COMMAND, value: "help" });
    expect(parseInput("/compact 5")).toEqual({ type: INPUT_EVENT.COMMAND, value: "compact 5" });
  });

  it("parses regular text input", () => {
    expect(parseInput("hello world")).toEqual({ type: INPUT_EVENT.TEXT, value: "hello world" });
    expect(parseInput("What is 2+2?")).toEqual({ type: INPUT_EVENT.TEXT, value: "What is 2+2?" });
  });

  it("handles bare / as text (empty command)", () => {
    expect(parseInput("/")).toEqual({ type: INPUT_EVENT.TEXT, value: "/" });
    // / followed by spaces is trimmed to empty command, so treated as text
    expect(parseInput("/  ")).toEqual({ type: INPUT_EVENT.TEXT, value: "/" });
  });

  it("trims input", () => {
    expect(parseInput("  hello  ")).toEqual({ type: INPUT_EVENT.TEXT, value: "hello" });
    expect(parseInput("  /help  ")).toEqual({ type: INPUT_EVENT.COMMAND, value: "help" });
  });

  it("handles empty string", () => {
    expect(parseInput("")).toEqual({ type: INPUT_EVENT.TEXT, value: "" });
    expect(parseInput("   ")).toEqual({ type: INPUT_EVENT.TEXT, value: "" });
  });
});

describe("NoopInput", () => {
  it("returns false for isInteractive", () => {
    const input = new NoopInput();
    expect(input.isInteractive()).toBe(false);
  });

  it("collects default answers", () => {
    const input = new NoopInput();
    const answers = input.collectAnswers([
      { key: "name", default: "Anonymous" },
      { key: "age", default: "25" },
      { key: "notes" }, // no default
    ]);
    expect(answers).toEqual({ name: "Anonymous", age: "25", notes: "" });
  });

  it("collects answers for empty question list", () => {
    const input = new NoopInput();
    expect(input.collectAnswers([])).toEqual({});
  });
});

describe("OutputSink", () => {
  let capturedStdout = [];
  let capturedStderr = [];

  describe("constructor", () => {
    it("defaults stream to true", () => {
      const sink = new OutputSink();
      expect(sink.stream).toBe(true);
    });

    it("respects stream option", () => {
      expect(new OutputSink({ stream: false }).stream).toBe(false);
      expect(new OutputSink({ stream: true }).stream).toBe(true);
    });
  });

  describe("emit", () => {
    it("dispatches events to correct handlers", () => {
      const sink = new OutputSink({ stream: false });
      let callCount = 0;

      // Override a handler to verify it's called
      sink.emitAssistantMessage = () => { callCount++; };

      const event = { type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "test" };
      sink.emit(event);
      expect(callCount).toBe(1);
    });

    it("ignores unknown event types", () => {
      const sink = new OutputSink();
      expect(() => sink.emit({ type: 999 })).not.toThrow();
    });
  });

  describe("emitAssistantMessage", () => {
    beforeEach(() => {
      capturedStdout.length = 0;
      capturedStderr.length = 0;
    });

    it("writes content to stdout", () => {
      const origWrite = process.stdout.write;
      process.stdout.write = (data) => { capturedStdout.push(data); return true; };

      try {
        const sink = new OutputSink({ stream: false });
        sink.emitAssistantMessage({ content: "Hello" });
        expect(capturedStdout).toContain("Hello");
      } finally {
        process.stdout.write = origWrite;
      }
    });
  });

  describe("emitThinking", () => {
    it("writes content to stderr", () => {
      const origWrite = process.stderr.write;
      process.stderr.write = (data) => { capturedStderr.push(data); return true; };

      try {
        const sink = new OutputSink({ stream: false });
        sink.emitThinking({ content: "Thinking..." });
        expect(capturedStderr).toContain("Thinking...");
      } finally {
        process.stderr.write = origWrite;
      }
    });
  });

  describe("emitCommandResult", () => {
    it("writes content with newline to stdout", () => {
      const origWrite = process.stdout.write;
      process.stdout.write = (data) => { capturedStdout.push(data); return true; };

      try {
        const sink = new OutputSink({ stream: false });
        sink.emitCommandResult({ content: "Result" });
        expect(capturedStdout).toContain("Result\n");
      } finally {
        process.stdout.write = origWrite;
      }
    });
  });

  describe("emitStreamingChunk", () => {
    it("writes content when stream is true", () => {
      const origWrite = process.stdout.write;
      process.stdout.write = (data) => { capturedStdout.push(data); return true; };

      try {
        const sink = new OutputSink({ stream: true });
        sink.emitStreamingChunk({ content: "chunk" });
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
        sink.emitStreamingChunk({ content: "chunk" });
        expect(writeCalled).toBe(false);
      } finally {
        process.stdout.write = origWrite;
      }
    });
  });

  describe("emitStreamingReasoningChunk", () => {
    it("writes content to stderr when stream is true", () => {
      const origWrite = process.stderr.write;
      process.stderr.write = (data) => { capturedStderr.push(data); return true; };

      try {
        const sink = new OutputSink({ stream: true });
        sink.emitStreamingReasoningChunk({ content: "reasoning" });
        expect(capturedStderr).toContain("reasoning");
      } finally {
        process.stderr.write = origWrite;
      }
    });
  });

  describe("no-op handlers", () => {
    it("emitUserMessage is a no-op", () => {
      const sink = new OutputSink();
      expect(() => sink.emitUserMessage({ content: "test" })).not.toThrow();
    });

    it("emitToolCall is a no-op", () => {
      const sink = new OutputSink();
      expect(() => sink.emitToolCall({ tool: "bash" })).not.toThrow();
    });

    it("emitToolResult is a no-op", () => {
      const sink = new OutputSink();
      expect(() => sink.emitToolResult({ output: "done" })).not.toThrow();
    });

    it("emitCompacting is a no-op", () => {
      const sink = new OutputSink();
      expect(() => sink.emitCompacting({})).not.toThrow();
    });

    it("emitQuestion is a no-op", () => {
      const sink = new OutputSink();
      expect(() => sink.emitQuestion({ questions: [] })).not.toThrow();
    });

    it("emitTaskProgress is a no-op", () => {
      const sink = new OutputSink();
      expect(() => sink.emitTaskProgress({})).not.toThrow();
    });

    it("emitTokenUsage is a no-op", () => {
      const sink = new OutputSink();
      expect(() => sink.emitTokenUsage({})).not.toThrow();
    });

    it("reset is a no-op", () => {
      const sink = new OutputSink();
      expect(() => sink.reset()).not.toThrow();
    });
  });
});

describe("NoopSink", () => {
  it("emit is a no-op", () => {
    const sink = new NoopSink();
    expect(() => sink.emit({ type: 1, content: "test" })).not.toThrow();
  });

  it("handles any event without error", () => {
    const sink = new NoopSink();
    sink.emit({ type: 999 });
    sink.emit(null);
    sink.emit(undefined);
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
