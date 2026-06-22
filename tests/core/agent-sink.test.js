// Tests for AgentSink — bridges Agent output to the Session Core.

import { describe, it, expect } from "bun:test";
import { AgentSink } from "../../src/core/session/agent-sink.js";
import { OUTPUT_EVENT } from "../../src/core/context/output.js";

describe("AgentSink", () => {
  describe("constructor", () => {
    it("creates with defaults", () => {
      const sink = new AgentSink();
      expect(sink.isTaskAgent).toBe(false);
    });

    it("accepts isTaskAgent flag", () => {
      const sink = new AgentSink({ isTaskAgent: true });
      expect(sink.isTaskAgent).toBe(true);
    });
  });

  describe("setTaskAgentId", () => {
    it("sets the task ID for later completion", () => {
      const sink = new AgentSink({ isTaskAgent: true });
      sink.setTaskAgentId("task-123");

      const events = [];
      const parent = { emit: (e) => events.push(e) };
      sink._parentSink = parent;

      sink.onTaskComplete("done");

      expect(events[0].taskId).toBe("task-123");
    });
  });

  describe("normal agent mode (isTaskAgent=false)", () => {
    it("forwards all events to parent sink", () => {
      const events = [];
      const parent = { emit: (e) => events.push(e) };
      const sink = new AgentSink({ parentSink: parent });

      sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "chunk" });
      sink.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash" });
      sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "hi" });
      sink.emit({ type: OUTPUT_EVENT.TOKEN_USAGE, totalTokens: 100 });

      expect(events).toHaveLength(4);
    });

    it("handles null parent sink without error", () => {
      const sink = new AgentSink();
      expect(() => sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK })).not.toThrow();
    });
  });

  describe("task agent mode (isTaskAgent=true)", () => {
    it("filters verbose events (streaming, tool, assistant, thinking)", () => {
      const events = [];
      const parent = { emit: (e) => events.push(e) };
      const sink = new AgentSink({ parentSink: parent, isTaskAgent: true });

      // These should all be filtered
      sink.emit({ type: OUTPUT_EVENT.STREAMING_CHUNK, content: "chunk" });
      sink.emit({ type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "thinking" });
      sink.emit({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "bash" });
      sink.emit({ type: OUTPUT_EVENT.TOOL_RESULT, toolName: "bash", result: "out" });
      sink.emit({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "hi" });
      sink.emit({ type: OUTPUT_EVENT.THINKING, content: "thinking" });
      sink.emit({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "cmd" });

      expect(events).toHaveLength(0);
    });

    it("forwards TASK_PROGRESS and TOKEN_USAGE events", () => {
      const events = [];
      const parent = { emit: (e) => events.push(e) };
      const sink = new AgentSink({ parentSink: parent, isTaskAgent: true });

      sink.emit({ type: OUTPUT_EVENT.TASK_PROGRESS, status: "running" });
      sink.emit({ type: OUTPUT_EVENT.TOKEN_USAGE, totalTokens: 100 });

      expect(events).toHaveLength(2);
      expect(events[0].type).toBe(OUTPUT_EVENT.TASK_PROGRESS);
      expect(events[1].type).toBe(OUTPUT_EVENT.TOKEN_USAGE);
    });

    it("handles unknown event types silently", () => {
      const events = [];
      const parent = { emit: (e) => events.push(e) };
      const sink = new AgentSink({ parentSink: parent, isTaskAgent: true });

      sink.emit({ type: 999, data: "unknown" });
      expect(events).toHaveLength(0);
    });
  });

  describe("onTaskComplete", () => {
    it("emits TASK_PROGRESS to parent sink", () => {
      const events = [];
      const parent = { emit: (e) => events.push(e) };
      const sink = new AgentSink({ parentSink: parent, isTaskAgent: true });
      sink.setTaskAgentId("task-1");

      sink.onTaskComplete("Result text");

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe(OUTPUT_EVENT.TASK_PROGRESS);
      expect(events[0].taskId).toBe("task-1");
    });

    it("calls onTaskComplete callback with task id and result", () => {
      let capturedId = null;
      let capturedResult = null;
      const onTaskComplete = (id, result) => {
        capturedId = id;
        capturedResult = result;
      };
      const sink = new AgentSink({ isTaskAgent: true, onTaskComplete });
      sink.setTaskAgentId("task-2");

      sink.onTaskComplete("Done!");

      expect(capturedId).toBe("task-2");
      expect(capturedResult).toBe("Done!");
    });

    it("handles null parent sink and callback gracefully", () => {
      const sink = new AgentSink({ isTaskAgent: true });
      sink.setTaskAgentId("task-3");
      expect(() => sink.onTaskComplete("result")).not.toThrow();
    });
  });
});
