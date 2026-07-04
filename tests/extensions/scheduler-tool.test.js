// Scheduler tool and command tests

import { describe, it, expect, beforeEach } from "bun:test";
import { Scheduler } from "../../src/extensions/scheduler/scheduler.js";
import { createScheduleTool } from "../../src/extensions/scheduler/schedule-tool.js";
import {
  createScheduleCommand,
  createScheduleListCommand,
  createScheduleCancelCommand,
} from "../../src/extensions/scheduler/schedule-commands.js";

class MockBus {
  constructor() {
    this.messages = [];
  }
  enqueue(text) {
    this.messages.push(text);
  }
}

describe("Schedule Tool", () => {
  let scheduler;
  let tool;

  beforeEach(() => {
    const bus = new MockBus();
    scheduler = new Scheduler({ maxTasks: 50 });
    scheduler.setBus(bus);
    tool = createScheduleTool(scheduler);
  });

  describe("toToolDef()", () => {
    it("should return a valid tool definition", () => {
      const def = tool.toToolDef();
      expect(def.type).toBe("function");
      expect(def.function.name).toBe("schedule");
      expect(def.function.description).toContain("Schedule a timed or recurring task");
      expect(def.function.parameters.required).toContain("mode");
    });

    it("should have the correct parameters", () => {
      const def = tool.toToolDef();
      const props = def.function.parameters.properties;
      expect(props.mode).toBeDefined();
      expect(props.description).toBeDefined();
      expect(props.delay_secs).toBeDefined();
      expect(props.interval_secs).toBeDefined();
      expect(props.task_id).toBeDefined();
    });
  });

  describe("execute() - schedule mode", () => {
    it("should schedule a one-shot task", async () => {
      const result = await tool.execute(JSON.stringify({
        mode: "schedule",
        description: "check inbox",
        delay_secs: 300,
      }));
      expect(result.task_id).toBeDefined();
      expect(result.description).toBe("check inbox");
      expect(result.mode).toBe("one-shot in 300s");
      expect(result.next_run).toBeDefined();
    });

    it("should schedule a recurring task", async () => {
      const result = await tool.execute(JSON.stringify({
        mode: "schedule",
        description: "ping status",
        delay_secs: 10,
        interval_secs: 60,
      }));
      expect(result.mode).toBe("recurring every 60s");
    });

    it("should throw for missing description", async () => {
      await expect(tool.execute(JSON.stringify({
        mode: "schedule",
        delay_secs: 60,
      }))).rejects.toThrow("description is required");
    });

    it("should throw for invalid delay", async () => {
      await expect(tool.execute(JSON.stringify({
        mode: "schedule",
        description: "test",
        delay_secs: 0,
      }))).rejects.toThrow();
    });

    it("should accept string input", async () => {
      const result = await tool.execute('{"mode":"schedule","description":"test","delay_secs":60}');
      expect(result.task_id).toBeDefined();
    });
  });

  describe("execute() - cancel mode", () => {
    it("should cancel a task", async () => {
      const scheduled = await tool.execute(JSON.stringify({
        mode: "schedule",
        description: "cancel me",
        delay_secs: 60,
      }));
      const result = await tool.execute(JSON.stringify({
        mode: "cancel",
        task_id: scheduled.task_id,
      }));
      expect(result.cancelled).toBe(true);
    });

    it("should return error for non-existent task", async () => {
      const result = await tool.execute(JSON.stringify({
        mode: "cancel",
        task_id: "nonexistent",
      }));
      expect(result.cancelled).toBe(false);
    });

    it("should throw for missing task_id", async () => {
      await expect(tool.execute(JSON.stringify({
        mode: "cancel",
      }))).rejects.toThrow("task_id is required");
    });
  });

  describe("execute() - list mode", () => {
    it("should return empty message when no tasks", async () => {
      const result = await tool.execute(JSON.stringify({ mode: "list" }));
      expect(result).toBe("No active scheduled tasks.");
    });

    it("should list active tasks", async () => {
      await tool.execute(JSON.stringify({
        mode: "schedule",
        description: "task one",
        delay_secs: 120,
      }));
      const result = await tool.execute(JSON.stringify({ mode: "list" }));
      expect(result).toContain("task one");
      expect(result).toContain("Active scheduled tasks");
    });
  });

  describe("execute() - unknown mode", () => {
    it("should throw for unknown mode", async () => {
      await expect(tool.execute(JSON.stringify({
        mode: "unknown",
      }))).rejects.toThrow("Unknown mode");
    });
  });
});

describe("Schedule Commands", () => {
  let scheduler;
  let scheduleCmd;
  let listCmd;
  let cancelCmd;

  beforeEach(() => {
    const bus = new MockBus();
    scheduler = new Scheduler({ maxTasks: 50 });
    scheduler.setBus(bus);
    scheduleCmd = createScheduleCommand(scheduler);
    listCmd = createScheduleListCommand(scheduler);
    cancelCmd = createScheduleCancelCommand(scheduler);
  });

  describe("/schedule command", () => {
    it("should match 'schedule' prefix", () => {
      expect(scheduleCmd.matches("schedule 60 hello")).toBe(true);
      expect(scheduleCmd.matches("schedule")).toBe(true);
      expect(scheduleCmd.matches("schedule:list")).toBe(false);
    });

    it("should show usage when empty", async () => {
      const result = await scheduleCmd.handler(null, "schedule");
      expect(result.content).toContain("Usage");
    });

    it("should schedule a one-shot task", async () => {
      const result = await scheduleCmd.handler(null, 'schedule 60 "check email"');
      expect(result.content).toContain("check email");
      expect(result.content).toContain("in 60s");
      expect(result.content).toContain("Scheduled [");
    });

    it("should schedule a recurring task", async () => {
      const result = await scheduleCmd.handler(null, 'schedule 10 --every 30 "ping"');
      expect(result.content).toContain("ping");
      expect(result.content).toContain("every 30s");
    });

    it("should show error for missing description", async () => {
      const result = await scheduleCmd.handler(null, "schedule 60");
      expect(result.content).toContain("Description is required");
    });

    it("should show error for missing delay", async () => {
      const result = await scheduleCmd.handler(null, 'schedule "no delay"');
      expect(result.content).toContain("Usage");
    });
  });

  describe("/schedule:list command", () => {
    it("should match list variants", () => {
      expect(listCmd.matches("schedule:list")).toBe(true);
      expect(listCmd.matches("schedule:ls")).toBe(true);
    });

    it("should show empty message", async () => {
      const result = await listCmd.handler(null, "");
      expect(result.content).toBe("No active scheduled tasks.");
    });

    it("should list tasks", async () => {
      scheduler.schedule("test task", 120);
      const result = await listCmd.handler(null, "");
      expect(result.content).toContain("test task");
    });
  });

  describe("/schedule:cancel command", () => {
    it("should match cancel variants", () => {
      expect(cancelCmd.matches("schedule:cancel abc")).toBe(true);
      expect(cancelCmd.matches("schedule:rm abc")).toBe(true);
    });

    it("should cancel a task", async () => {
      const task = scheduler.schedule("cancel me", 60);
      const result = await cancelCmd.handler(null, `schedule:cancel ${task.id}`);
      expect(result.content).toContain("Cancelled");
    });

    it("should show error for non-existent task", async () => {
      const result = await cancelCmd.handler(null, "schedule:cancel nonexistent");
      expect(result.content).toContain("not found");
    });

    it("should show usage for missing ID", async () => {
      const result = await cancelCmd.handler(null, "schedule:cancel");
      expect(result.content).toContain("Usage");
    });
  });
});
