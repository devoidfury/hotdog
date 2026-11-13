// Subagent task-feed serialization (S2C taskActivity envelope).

import { describe, it, expect } from "bun:test";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import {
  S2C,
  MAX_TASK_ACTIVITY_CHARS,
  taskActivityFromEvent,
  taskActivityMessage,
} from "@extensions/websocket/protocol.ts";
import { s2cToolCall, s2cToolResult, taskActivityWithPosture, type TaskActivityToolMeta } from "@extensions/websocket/wire-messages.ts";
import type { ToolDisplayWire } from "@extensions/websocket/protocol.ts";

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

  it("maps STREAM_RESET to the live-only reset sentinel", () => {
    expect(taskActivityFromEvent({ type: OUTPUT_EVENT.STREAM_RESET })).toEqual({
      kind: "reset",
    });
    // Same envelope as every other activity item; carries no payload.
    expect(taskActivityMessage("task-7", { type: OUTPUT_EVENT.STREAM_RESET })).toEqual({
      type: S2C.TASK_ACTIVITY,
      taskId: "task-7",
      activity: { kind: "reset" },
    });
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

// ── Display posture enrichment (subagent view == session view) ─────────────
// The subagent transcript renders through the SAME MessageListManager a
// session rides; for the tool blocks to reach identical display-DSL
// postures (read file box, edit inline diff, bash code block) the relayed
// activity items must carry the same descriptor fields the session TOOL_CALL
// / TOOL_RESULT frames do, computed by the same calls. These pins compare
// against s2cToolCall/s2cToolResult output directly -- one computation, two
// envelopes, no drift.

describe("taskActivityWithPosture", () => {
  // The bash tool's real declarations (bash-tool/index.ts).
  const bashMeta: TaskActivityToolMeta = {
    argDisplay: { command: { preview: "first-line", syntax: "shell" } },
    headerKeys: ["timeoutMs"],
    display: [{ kind: "code", source: "args", arg: "command", lang: "shell" }],
  };
  const noMeta = (): undefined => undefined;

  it("a bash tool_call carries the same argsSummary/display fields as s2cToolCall", () => {
    const event: OutputEvent = {
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "bash",
      input: '{"command":"ls -la"}',
      toolCallId: "c1",
    };
    const enriched = taskActivityWithPosture(
      taskActivityFromEvent(event)!,
      event,
      (name) => (name === "bash" ? bashMeta : undefined),
    );
    const sessionFrame = s2cToolCall("sid-1", {
      name: "bash",
      args: event.input,
      toolCallId: "c1",
      argDisplay: bashMeta.argDisplay,
      headerKeys: bashMeta.headerKeys,
      display: bashMeta.display,
    });
    if (enriched.kind !== "tool_call") throw new Error("expected a tool_call activity item");
    expect(enriched.argsSummary).toBe(sessionFrame.argsSummary as string | undefined);
    expect(enriched.display).toEqual(sessionFrame.display as ToolDisplayWire[] | undefined);
    // The declared fold rides even when nothing hits the header keys (the
    // tri-state "" = "no summary, no fallback"): same rule, same envelope.
    const emptyFold = taskActivityWithPosture(
      taskActivityFromEvent(event)!,
      event,
      () => ({ ...bashMeta, headerKeys: ["exitCode"] }),
    );
    if (emptyFold.kind !== "tool_call") throw new Error("expected a tool_call activity item");
    expect(emptyFold.argsSummary).toBe("");
  });

  it("unmeta'd tools still ride the same fold the session frame computes (parity, not presence)", () => {
    const event: OutputEvent = {
      type: OUTPUT_EVENT.TOOL_CALL,
      toolName: "mystery",
      input: '{"a":1}',
      toolCallId: "c9",
    };
    // A session TOOL_CALL for a tool with no declared hints still rides the
    // hint-free summarizeToolArgs fold; parity means the relay carries the
    // SAME thing -- and no display parts (nothing was declared).
    const enriched = taskActivityWithPosture(taskActivityFromEvent(event)!, event, noMeta);
    const sessionFrame = s2cToolCall("sid-1", { name: "mystery", args: event.input, toolCallId: "c9" });
    expect(enriched).toEqual({
      kind: "tool_call",
      name: "mystery",
      args: '{"a":1}',
      ...(sessionFrame.argsSummary !== undefined
        ? { argsSummary: sessionFrame.argsSummary as string }
        : {}),
    });
    expect("display" in enriched).toBe(false);
  });

  it("an edit tool_result carries startLine exactly like s2cToolResult gates it", () => {
    // The tool-result part shape (see websocket-wire-messages.test.ts):
    // meta rides as [key, value] pairs; the text flattener appends the dump.
    const part = (meta: Array<[string, string]>) => ({
      type: "tool-result",
      tool: "edit",
      status: "success",
      meta,
      error: null,
      hint: null,
      output: "edited a.txt",
    });
    const event = {
      type: OUTPUT_EVENT.TOOL_RESULT,
      toolName: "edit",
      input: "{}",
      content: [part([["start_line", "42"]])],
      toolCallId: "c2",
    } as unknown as OutputEvent;
    const enriched = taskActivityWithPosture(taskActivityFromEvent(event)!, event, noMeta);
    expect(enriched.kind === "tool_result" && enriched.startLine).toBe(42);
    expect(enriched.kind === "tool_result" && enriched.output).toContain("edited a.txt");
    // Compare the field against the session frame for the same content.
    const sessionFrame = s2cToolResult("sid-1", { name: "edit", content: [part([["start_line", "42"]])] });
    expect(sessionFrame.startLine).toBe(42);
    // A garbage start_line rides nothing (s2cToolResult's positive-integer gate).
    const bad = { ...event, content: [part([["start_line", "0"]])] } as unknown as OutputEvent;
    const enrichedBad = taskActivityWithPosture(taskActivityFromEvent(bad)!, bad, noMeta);
    expect("startLine" in enrichedBad).toBe(false);
  });

  it("non-tool items pass through untouched", () => {
    const text = taskActivityFromEvent({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "hi" })!;
    expect(
      taskActivityWithPosture(text, { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "hi" }, noMeta),
    ).toEqual({ kind: "text", content: "hi" });
  });
});
