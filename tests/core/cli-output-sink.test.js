import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import {
  CliOutputSink,
  formatCompacting,
  formatToolCall,
  formatToolResult,
  formatTokenUsage,
  formatThinking,
  formatTaskProgress,
} from "../../src/core/ui/cli.js";
import { OUTPUT_EVENT } from "../../src/core/context/output.js";

describe("CliOutputSink", () => {
  let sink;
  let stdoutWrites = [];
  let stderrWrites = [];

  beforeEach(() => {
    stdoutWrites = [];
    stderrWrites = [];
    spyOn(process.stdout, "write").mockImplementation((s) => {
      stdoutWrites.push(s);
      return true;
    });
    spyOn(process.stderr, "write").mockImplementation((s) => {
      stderrWrites.push(s);
      return true;
    });
    sink = new CliOutputSink({ useColors: false, showTokenUse: true });
  });

  afterEach(() => {
    process.stdout.write.mockRestore();
    process.stderr.write.mockRestore();
  });

  it("emitUserMessage writes to stdout", () => {
    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" });
    expect(stdoutWrites.some((w) => w.includes("hello"))).toBe(true);
  });

  it("emitUserMessage is suppressed when hideUserMessage is true", () => {
    sink.hideUserMessage = true;
    sink.emit({ type: OUTPUT_EVENT.USER_MESSAGE, content: "hello" });
    expect(stdoutWrites).toHaveLength(0);
  });

  it("emitAssistantMessage writes to stdout", () => {
    sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "answer" });
    expect(stdoutWrites.some((w) => w.includes("answer"))).toBe(true);
  });

  it("emitThinking writes to stderr", () => {
    sink.emit({ type: OUTPUT_EVENT.THINKING, content: "thinking..." });
    expect(stderrWrites.some((w) => w.includes("thinking"))).toBe(true);
  });

  it("emitThinking is suppressed when hideThinking is true", () => {
    sink.hideThinking = true;
    sink.emit({ type: OUTPUT_EVENT.THINKING, content: "thinking..." });
    expect(stderrWrites).toHaveLength(0);
  });

  it("emitToolCall writes to stdout", () => {
    sink.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash", input: '{"cmd":"ls"}' });
    expect(stdoutWrites.some((w) => w.includes("bash"))).toBe(true);
  });

  it("emitToolResult writes to stdout", () => {
    sink.emit({ type: OUTPUT_EVENT.TOOL_RESULT, result: "output" });
    expect(stdoutWrites.some((w) => w.includes("output"))).toBe(true);
  });

  it("emitToolResult is suppressed when hideTools is true", () => {
    sink.hideTools = true;
    sink.emit({ type: OUTPUT_EVENT.TOOL_RESULT, result: "output" });
    expect(stdoutWrites).toHaveLength(0);
  });

  it("emitCompacting writes to stderr", () => {
    sink.emit({ type: OUTPUT_EVENT.COMPACTING, messageCount: 10, keepRecent: 5 });
    expect(stderrWrites.some((w) => w.includes("Compacting"))).toBe(true);
  });

  it("emitCommandResult writes to stderr", () => {
    sink.emit({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "command done" });
    expect(stderrWrites.some((w) => w.includes("command done"))).toBe(true);
  });

  it("emitQuestion writes questions to stdout", () => {
    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{ prompt: "What is your name?", key: "name" }],
    });
    expect(stdoutWrites.some((w) => w.includes("What is your name?"))).toBe(true);
  });

  it("emitQuestion with options writes option list", () => {
    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{
        prompt: "Choose",
        key: "choice",
        options: ["a", "b"],
        allowOther: true,
      }],
    });
    const allOutput = stdoutWrites.join("");
    expect(allOutput).toContain("[1] a");
    expect(allOutput).toContain("[2] b");
    expect(allOutput).toContain("[Other]");
  });

  it("emitQuestion without allowOther shows strict options", () => {
    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{
        prompt: "Choose",
        key: "choice",
        options: ["a", "b"],
        allowOther: false,
      }],
    });
    const allOutput = stdoutWrites.join("");
    expect(allOutput).toContain("Choose a number");
  });

  it("emitQuestion with default value shows default", () => {
    sink.emit({
      type: OUTPUT_EVENT.QUESTION,
      questions: [{
        prompt: "Name?",
        key: "name",
        default: "Alice",
      }],
    });
    const allOutput = stdoutWrites.join("");
    expect(allOutput).toContain("default: Alice");
  });

  it("emitStreamingChunk writes when stream is enabled", () => {
    sink.stream = true;
    sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "chunk" });
    expect(stdoutWrites.some((w) => w.includes("chunk"))).toBe(true);
  });

  it("emitStreamingChunk is suppressed when stream is disabled", () => {
    sink.stream = false;
    sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "chunk" });
    expect(stdoutWrites).toHaveLength(0);
  });

  it("emitStreamingReasoningChunk writes to stderr when stream enabled", () => {
    sink.stream = true;
    sink.emit({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "reasoning" });
    expect(stderrWrites.some((w) => w.includes("reasoning"))).toBe(true);
  });

  it("emitStreamingReasoningChunk suppressed when hideThinking true", () => {
    sink.stream = true;
    sink.hideThinking = true;
    sink.emit({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "reasoning" });
    expect(stderrWrites).toHaveLength(0);
  });

  it("emitTaskProgress writes progress to stderr", () => {
    sink.emit({ type: OUTPUT_EVENT.TASK_PROGRESS, activeTasks: 2, totalTasks: 5 });
    expect(stderrWrites.some((w) => w.includes("2/5"))).toBe(true);
  });

  it("emitTaskProgress suppressed when no active tasks", () => {
    sink.emit({ type: OUTPUT_EVENT.TASK_PROGRESS, activeTasks: 0, totalTasks: 5 });
    expect(stdoutWrites).toHaveLength(0);
  });

  it("emitTokenUsage writes to stderr", () => {
    sink.emit({
      type: OUTPUT_EVENT.TOKEN_USAGE,
      promptTokens: 100,
      cachedTokens: 50,
      completionTokens: 200,
      totalTokens: 350,
    });
    expect(stderrWrites.some((w) => w.includes("tokens"))).toBe(true);
  });

  it("emitSessionState updates hideTools", () => {
    expect(sink.hideTools).toBeUndefined();
    sink.emit({ type: OUTPUT_EVENT.SESSION_STATE, key: "hideTools", value: true });
    expect(sink.hideTools).toBe(true);
  });

  it("emitSessionState updates hideThinking", () => {
    expect(sink.hideThinking).toBeUndefined();
    sink.emit({ type: OUTPUT_EVENT.SESSION_STATE, key: "hideThinking", value: true });
    expect(sink.hideThinking).toBe(true);
  });

  it("reset writes reset code to stdout", () => {
    sink.reset();
    expect(stdoutWrites.some((w) => w.includes("\x1b[0m"))).toBe(true);
  });

  it("setPalette updates the palette", () => {
    const palette = { thinking: "red", use_colors: false };
    sink.setPalette(palette);
    expect(sink.palette).toBe(palette);
  });

  it("static resolve returns palette", async () => {
    const palette = await CliOutputSink.resolve(false, null, null);
    expect(palette.use_colors).toBe(false);
  });
});
