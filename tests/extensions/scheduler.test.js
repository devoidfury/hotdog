// Scheduler extension tests

import { describe, it, expect, beforeEach } from "bun:test";
import { Scheduler, ScheduledTask } from "../../src/extensions/scheduler/scheduler.js";

/**
 * Mock MessageBus with enqueue tracking.
 */
class MockBus {
  constructor() {
    this.messages = [];
  }

  enqueue(text) {
    this.messages.push(text);
  }
}

describe("Scheduler", () => {
  let scheduler;
  let bus;

  beforeEach(() => {
    bus = new MockBus();
    scheduler = new Scheduler({ maxTasks: 10, logActivity: false });
    scheduler.setBus(bus);
  });

  describe("schedule()", () => {
    it("should schedule a one-shot task", () => {
      const task = scheduler.schedule("do something", 5);
      expect(task.id).toBeDefined();
      expect(task.description).toBe("do something");
      expect(task.delaySecs).toBe(5);
      expect(task.intervalSecs).toBe(0);
      expect(task.repeat).toBe(false);
      expect(task.active).toBe(true);
      expect(task.nextRun).toBeCloseTo(Date.now() + 5000, -2);
    });

    it("should schedule a recurring task", () => {
      const task = scheduler.schedule("check status", 2, 10);
      expect(task.repeat).toBe(true);
      expect(task.intervalSecs).toBe(10);
      expect(task.delaySecs).toBe(2);
    });

    it("should throw when bus is not set", () => {
      const noBus = new Scheduler();
      expect(() => noBus.schedule("test", 5)).toThrow("no message bus connected");
    });

    it("should throw for empty description", () => {
      expect(() => scheduler.schedule("", 5)).toThrow("description is required");
      expect(() => scheduler.schedule("   ", 5)).toThrow("description is required");
    });

    it("should throw for non-positive delay", () => {
      expect(() => scheduler.schedule("test", 0)).toThrow("positive number");
      expect(() => scheduler.schedule("test", -1)).toThrow("positive number");
    });

    it("should throw for negative interval", () => {
      expect(() => scheduler.schedule("test", 5, -1)).toThrow("positive number");
    });

    it("should throw when max tasks exceeded", () => {
      const limited = new Scheduler({ maxTasks: 2 });
      limited.setBus(bus);
      limited.schedule("task 1", 60);
      limited.schedule("task 2", 60);
      expect(() => limited.schedule("task 3", 60)).toThrow("maximum task count");
      limited.cleanup();
    });

    it("should trim whitespace from description", () => {
      const task = scheduler.schedule("  hello world  ", 5);
      expect(task.description).toBe("hello world");
    });
  });

  describe("cancel()", () => {
    it("should cancel an active task", () => {
      const task = scheduler.schedule("do something", 60);
      const result = scheduler.cancel(task.id);
      expect(result).toBe(true);
      expect(scheduler.list()).toHaveLength(0);
    });

    it("should return false for non-existent task", () => {
      const result = scheduler.cancel("nonexistent");
      expect(result).toBe(false);
    });

    it("should return false when cancelling already-cancelled task", () => {
      const task = scheduler.schedule("do something", 60);
      scheduler.cancel(task.id);
      const result = scheduler.cancel(task.id);
      expect(result).toBe(false);
    });
  });

  describe("list()", () => {
    it("should return empty array when no tasks", () => {
      expect(scheduler.list()).toEqual([]);
    });

    it("should return active tasks", () => {
      scheduler.schedule("task 1", 30);
      scheduler.schedule("task 2", 60);
      const tasks = scheduler.list();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].description).toBe("task 1");
      expect(tasks[1].description).toBe("task 2");
    });

    it("should not include cancelled tasks", () => {
      const task1 = scheduler.schedule("task 1", 30);
      scheduler.schedule("task 2", 60);
      scheduler.cancel(task1.id);
      const tasks = scheduler.list();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].description).toBe("task 2");
    });
  });

  describe("get()", () => {
    it("should return a task by ID", () => {
      const task = scheduler.schedule("find me", 30);
      const found = scheduler.get(task.id);
      expect(found).toBe(task);
    });

    it("should return undefined for non-existent task", () => {
      expect(scheduler.get("nonexistent")).toBeUndefined();
    });
  });

  describe("fire()", () => {
    it("should enqueue message when task fires", async () => {
      scheduler.schedule("fire me", 0.1);
      await new Promise((r) => setTimeout(r, 200));
      expect(bus.messages).toContain("fire me");
      scheduler.cleanup();
    });

    it("should reschedule recurring tasks", async () => {
      scheduler.schedule("repeat me", 0.1, 0.1);
      await new Promise((r) => setTimeout(r, 350));
      // Should have fired at least 3 times (at 0.1s, 0.2s, 0.3s)
      const count = bus.messages.filter((m) => m === "repeat me").length;
      expect(count).toBeGreaterThanOrEqual(3);
      scheduler.cleanup();
    });

    it("should not fire cancelled tasks", async () => {
      const task = scheduler.schedule("dont fire", 0.1);
      scheduler.cancel(task.id);
      await new Promise((r) => setTimeout(r, 200));
      expect(bus.messages).not.toContain("dont fire");
    });

    it("should not keep process alive (unref)", () => {
      // This is tested implicitly — if unref wasn't called,
      // the test runner would hang. The fact that tests complete
      // proves unref works.
      const task = scheduler.schedule("unref test", 0.05);
      expect(task._timeout).toBeDefined();
      scheduler.cleanup();
    });
  });

  describe("cleanup()", () => {
    it("should clear all tasks", () => {
      scheduler.schedule("task 1", 60);
      scheduler.schedule("task 2", 60);
      scheduler.cleanup();
      expect(scheduler.list()).toHaveLength(0);
    });

    it("should clear all timeouts", () => {
      const task = scheduler.schedule("task", 60);
      expect(task._timeout).toBeDefined();
      scheduler.cleanup();
      expect(task._timeout).toBeNull();
    });

    it("should be safe to call multiple times", () => {
      scheduler.cleanup();
      scheduler.cleanup(); // should not throw
      expect(scheduler.list()).toHaveLength(0);
    });
  });

  describe("ScheduledTask", () => {
    it("should have correct initial state", () => {
      const task = new ScheduledTask("test-id", "description", 10, 0);
      expect(task.id).toBe("test-id");
      expect(task.description).toBe("description");
      expect(task.delaySecs).toBe(10);
      expect(task.intervalSecs).toBe(0);
      expect(task.repeat).toBe(false);
      expect(task.active).toBe(true);
      expect(task.createdAt).toBeCloseTo(Date.now(), -2);
      expect(task.nextRun).toBeCloseTo(Date.now() + 10000, -2);
    });

    it("should mark as repeating when interval > 0", () => {
      const task = new ScheduledTask("id", "desc", 5, 30);
      expect(task.repeat).toBe(true);
    });
  });
});

describe("Scheduler edge cases", () => {
  it("should handle rapid schedule/cancel", () => {
    const bus = new MockBus();
    const scheduler = new Scheduler({ maxTasks: 100 });
    scheduler.setBus(bus);

    for (let i = 0; i < 50; i++) {
      const task = scheduler.schedule(`task ${i}`, 60);
      scheduler.cancel(task.id);
    }
    expect(scheduler.list()).toHaveLength(0);
  });

  it("should handle special characters in description", () => {
    const bus = new MockBus();
    const scheduler = new Scheduler();
    scheduler.setBus(bus);
    const task = scheduler.schedule('test "with" <special> & chars', 5);
    expect(task.description).toBe('test "with" <special> & chars');
    scheduler.cleanup();
  });

  it("should not fire if bus is removed after scheduling", () => {
    const bus = new MockBus();
    const scheduler = new Scheduler();
    scheduler.setBus(bus);
    scheduler.schedule("no bus", 0.1);
    scheduler._bus = null; // simulate bus removal
    // _fire checks for bus existence
    // This tests that the scheduler doesn't crash when bus is null
    expect(() => {
      const task = scheduler.list()[0];
      scheduler._fire(task);
    }).not.toThrow();
    scheduler.cleanup();
  });
});
