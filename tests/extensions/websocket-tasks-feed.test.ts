// Subagent task-feed serialization (S2C taskActivity envelope).

import { describe, it, expect } from "bun:test";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import {
  S2C,
  MAX_TASK_ACTIVITY_CHARS,
  taskActivityFromEvent,
  taskActivityMessage,
} from "@extensions/websocket/protocol.ts";

describe("taskActivityFromEvent", () => {
  it("maps streaming chunks and assistant messages to text", () => {
    expect(
      taskActivityFromEvent({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "hel" }),
    ).toEqual({ kind: "text", content: "hel" });
    expect(
      taskActivityFromEvent({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "done" }),
    ).toEqual({ kind: "text", content: "done" });
    // Empty deltas would only churn the panel.
    expect(
      taskActivityFromEvent({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "" }),
    ).toBeNull();
  });

  it("maps streaming reasoning deltas to their own lane", () => {
    expect(
      taskActivityFromEvent({
        type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK,
        content: "pondering",
      }),
    ).toEqual({ kind: "reasoning", content: "pondering" });
    expect(
      taskActivityFromEvent({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "" }),
    ).toBeNull();
  });

  it("maps tool calls and truncates oversized input", () => {
    const big = "y".repeat(MAX_TASK_ACTIVITY_CHARS + 100);
    const wire = taskActivityFromEvent({
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "write",
      input: big,
      toolCallId: "c1",
    });
    expect(wire).not.toBeNull();
    expect(wire!.kind).toBe("tool_call");
    expect(wire!.kind === "tool_call" && wire!.name).toBe("write");
    const args = wire!.kind === "tool_call" ? wire!.args : "";
    expect(args.length).toBe(MAX_TASK_ACTIVITY_CHARS + "...[truncated]".length);
    expect(args.endsWith("...[truncated]")).toBe(true);
  });

  it("flattens tool result content and carries the error field", () => {
    expect(
      taskActivityFromEvent({
        type: OUTPUT_EVENT.TOOL_RESULT,
        toolName: "bash",
        input: "ls",
        content: "file-a\nfile-b",
        toolCallId: "c1",
      }),
    ).toEqual({ kind: "tool_result", name: "bash", output: "file-a\nfile-b" });

    const err = taskActivityFromEvent({
      type: OUTPUT_EVENT.TOOL_RESULT,
      toolName: "bash",
      input: "ls",
      content: "",
      toolCallId: "c1",
      error: "nope",
    });
    expect(err!.kind === "tool_result" && err!.error).toBe("nope");
  });

  it("skips events that are not part of the panel view", () => {
    const skipped: OutputEvent[] = [
      { type: OUTPUT_EVENT.THINKING, content: "hmm" },
      { type: OUTPUT_EVENT.USER_MESSAGE, content: "hi" },
      { type: OUTPUT_EVENT.TASK_PROGRESS, taskId: "t", status: "running" },
      { type: OUTPUT_EVENT.COMPACTING },
    ];
    for (const ev of skipped) {
      expect(taskActivityFromEvent(ev)).toBeNull();
    }
  });
});

describe("taskActivityMessage", () => {
  it("tags the relayed activity with its task id", () => {
    const msg = taskActivityMessage("task-7", {
      type: OUTPUT_EVENT.STREAMING_CHUNK,
      content: "hello",
    });
    expect(msg).toEqual({
      type: S2C.TASK_ACTIVITY,
      taskId: "task-7",
      activity: { kind: "text", content: "hello" },
    });
    expect(JSON.parse(JSON.stringify(msg)).taskId).toBe("task-7");
  });

  it("returns null for un-relayed events so nothing is broadcast", () => {
    expect(
      taskActivityMessage("task-7", { type: OUTPUT_EVENT.THINKING, content: "x" }),
    ).toBeNull();
  });
});
