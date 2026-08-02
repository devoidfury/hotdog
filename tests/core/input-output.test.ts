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

    it("silently ignores unknown event types", () => {
      let stdoutWritten = false;
      const origWrite = process.stdout.write;
      process.stdout.write = () => { stdoutWritten = true; return true; };

      try {
        const sink = new OutputSink();
        sink.emit({ type: 999 as any });
        expect(stdoutWritten).toBe(false);
      } finally {
        process.stdout.write = origWrite;
      }
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
    it("does not write to stdout for user message, tool call, tool result, compacting, question, task progress, token usage", () => {
      let stdoutWritten = false;
      const origWrite = process.stdout.write;
      process.stdout.write = () => { stdoutWritten = true; return true; };

      try {
        const sink = new OutputSink();
        sink.emitUserMessage({ type: OUTPUT_EVENT.USER_MESSAGE, content: "test" });
        sink.emitToolCall({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: "", toolCallId: "1" });
        sink.emitToolResult({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", input: "", result: "done", toolCallId: "1" });
        sink.emitCompacting({ type: OUTPUT_EVENT.COMPACTING });
        sink.emitQuestion({ type: OUTPUT_EVENT.QUESTION, questions: [] });
        sink.emitTaskProgress({ type: OUTPUT_EVENT.TASK_PROGRESS, taskId: "1", status: "running" });
        sink.emitTokenUsage({ type: OUTPUT_EVENT.TOKEN_USAGE, sessionPromptTokens: 0, sessionCachedTokens: 0, sessionCompletionTokens: 0, sessionTotalTokens: 0, turns: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0 });
        sink.reset();
        expect(stdoutWritten).toBe(false);
      } finally {
        process.stdout.write = origWrite;
      }
    });
  });

  describe("emitSystemMessage", () => {
    it("writes content with newline to stderr", () => {
      const origWrite = process.stderr.write;
      process.stderr.write = (data) => { capturedStderr.push(data as string); return true; };

      try {
        const sink = new OutputSink({ stream: false });
        sink.emitSystemMessage({ type: OUTPUT_EVENT.SYSTEM_MESSAGE, content: "System note" });
        expect(capturedStderr).toContain("System note\n");
      } finally {
        process.stderr.write = origWrite;
      }
    });
  });

  describe("emitCompactionResult", () => {
    it("is a no-op", () => {
      let stdoutWritten = false;
      let stderrWritten = false;
      const origStdout = process.stdout.write;
      const origStderr = process.stderr.write;
      process.stdout.write = () => { stdoutWritten = true; return true; };
      process.stderr.write = () => { stderrWritten = true; return true; };

      try {
        const sink = new OutputSink();
        sink.emitCompactionResult({
          type: OUTPUT_EVENT.COMPACTION_RESULT,
          messagesCompacted: 5,
          tokensBefore: 1000,
          tokensAfter: 500,
          strategy: "summarize",
        });
        expect(stdoutWritten).toBe(false);
        expect(stderrWritten).toBe(false);
      } finally {
        process.stdout.write = origStdout;
        process.stderr.write = origStderr;
      }
    });
  });

  describe("emitSessionState", () => {
    it("is a no-op", () => {
      let stdoutWritten = false;
      let stderrWritten = false;
      const origStdout = process.stdout.write;
      const origStderr = process.stderr.write;
      process.stdout.write = () => { stdoutWritten = true; return true; };
      process.stderr.write = () => { stderrWritten = true; return true; };

      try {
        const sink = new OutputSink();
        sink.emitSessionState({
          type: OUTPUT_EVENT.SESSION_STATE,
          key: "test-key",
          value: "test-value",
        });
        expect(stdoutWritten).toBe(false);
        expect(stderrWritten).toBe(false);
      } finally {
        process.stdout.write = origStdout;
        process.stderr.write = origStderr;
      }
    });
  });
});

describe("NoopSink", () => {
  it("emit never writes output", () => {
    let stdoutWritten = false;
    let stderrWritten = false;
    const origStdout = process.stdout.write;
    const origStderr = process.stderr.write;
    process.stdout.write = () => { stdoutWritten = true; return true; };
    process.stderr.write = () => { stderrWritten = true; return true; };

    try {
      const sink = new NoopSink();
      sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "test" });
      sink.emit({ type: OUTPUT_EVENT.THINKING, content: "thinking" });
      sink.emit({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "result" });
      expect(stdoutWritten).toBe(false);
      expect(stderrWritten).toBe(false);
    } finally {
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
    }
  });
});

describe("outputEvent", () => {
  it("creates event with type and data", () => {
    const event = outputEvent({ type: OUTPUT_EVENT.USER_MESSAGE, content: "Hello" });
    expect(event.type).toBe(OUTPUT_EVENT.USER_MESSAGE);
    expect(event.content).toBe("Hello");
  });

  it("creates event with default empty data", () => {
    const event = outputEvent({ type: OUTPUT_EVENT.TOKEN_USAGE, sessionPromptTokens: 0, sessionCachedTokens: 0, sessionCompletionTokens: 0, sessionTotalTokens: 0, turns: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, totalTokens: 0 });
    expect(event.type).toBe(OUTPUT_EVENT.TOKEN_USAGE);
    expect(event.promptTokens).toBe(0);
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
