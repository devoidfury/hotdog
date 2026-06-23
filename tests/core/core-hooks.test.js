// Tests for the core hook system.

import { HookSystem, HOOKS, createHooks } from "../../src/core/hooks.js";
import { describe, it, expect } from "bun:test";

describe("HookSystem", () => {
  describe("on() / notifyHooks()", () => {
    it("should call registered handlers on notifyHooks", () => {
      const hooks = createHooks();
      const calls = [];
      hooks.on("test:hook", (data) => calls.push(data));
      hooks.notifyHooks("test:hook", { value: 42 });
      expect(calls).toEqual([{ value: 42 }]);
    });

    it("should call multiple handlers in order", () => {
      const hooks = createHooks();
      const order = [];
      hooks.on("test:hook", () => order.push("a"));
      hooks.on("test:hook", () => order.push("b"));
      hooks.notifyHooks("test:hook", {});
      expect(order).toEqual(["a", "b"]);
    });

    it("should not return a value (fire-and-forget)", () => {
      const hooks = createHooks();
      hooks.on("test:hook", () => "first");
      hooks.on("test:hook", () => "second");
      expect(hooks.notifyHooks("test:hook", {})).toBeUndefined();
    });

    it("should return undefined when no handlers match", () => {
      const hooks = createHooks();
      expect(hooks.notifyHooks("nonexistent:hook", {})).toBeUndefined();
    });
  });

  describe("on() returns removal function", () => {
    it("should return a function that removes the handler", () => {
      const hooks = createHooks();
      const calls = [];
      const remove = hooks.on("test:hook", (data) => calls.push(data));
      hooks.notifyHooks("test:hook", { value: 1 });
      expect(calls).toEqual([{ value: 1 }]);

      remove();
      hooks.notifyHooks("test:hook", { value: 2 });
      expect(calls).toEqual([{ value: 1 }]);
    });

    it("should handle double removal gracefully", () => {
      const hooks = createHooks();
      const remove = hooks.on("test:hook", () => {});
      remove();
      expect(() => remove()).not.toThrow();
    });
  });

  describe("off()", () => {
    it("should remove a specific handler by reference", () => {
      const hooks = createHooks();
      const handler1 = () => "first";
      const handler2 = () => "second";
      hooks.on("test:hook", handler1);
      hooks.on("test:hook", handler2);

      expect(hooks.off("test:hook", handler1)).toBe(true);
      expect(hooks.notifyHooks("test:hook", {})).toBeUndefined();
    });

    it("should return false when handler not found", () => {
      const hooks = createHooks();
      expect(hooks.off("test:hook", () => {})).toBe(false);
    });
  });

  describe("notifyHooksAsync()", () => {
    it("should call async handlers", async () => {
      const hooks = createHooks();
      const results = [];
      hooks.on("test:hook", async (data) => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(data.value);
      });
      await hooks.notifyHooksAsync("test:hook", { value: 1 });
      expect(results).toEqual([1]);
    });
  });

  describe("runHookPipeline()", () => {
    it("should run handlers sequentially and collect results", async () => {
      const hooks = createHooks();
      const order = [];
      hooks.on("test:hook", (data) => {
        order.push("a");
        return { result: "a" };
      });
      hooks.on("test:hook", (data) => {
        order.push("b");
        return { result: "b" };
      });
      const { results, lastResult } = await hooks.runHookPipeline("test:hook", {});
      expect(order).toEqual(["a", "b"]);
      expect(results).toEqual([
        { result: { result: "a" }, source: null },
        { result: { result: "b" }, source: null },
      ]);
      expect(lastResult).toEqual({ result: "b" });
    });

    it("should stop early when shouldStop returns true", async () => {
      const hooks = createHooks();
      const order = [];
      hooks.on("test:hook", () => {
        order.push("a");
        return { action: "handled" };
      });
      hooks.on("test:hook", () => {
        order.push("b");
        return { action: "continue" };
      });
      const { stopped, results } = await hooks.runHookPipeline("test:hook", {}, {
        shouldStop: (r) => r?.action === "handled",
      });
      expect(stopped).toBe(true);
      expect(order).toEqual(["a"]); // second handler skipped
      expect(results).toEqual([{ result: { action: "handled" }, source: null }]);
    });

    it("should pass mutable data through handlers", async () => {
      const hooks = createHooks();
      hooks.on("test:hook", (data) => {
        data.count = (data.count || 0) + 1;
      });
      hooks.on("test:hook", (data) => {
        data.count = (data.count || 0) + 1;
      });
      const { data } = await hooks.runHookPipeline("test:hook", { count: 0 });
      expect(data.count).toBe(2);
    });
  });

  describe("clear()", () => {
    it("should clear a specific hook", () => {
      const hooks = createHooks();
      hooks.on("test:hook", () => {});
      hooks.on("other:hook", () => {});
      hooks.clear("test:hook");
      expect(hooks.handlerCount("test:hook")).toBe(0);
      expect(hooks.handlerCount("other:hook")).toBe(1);
    });

    it("should clear all hooks when no name given", () => {
      const hooks = createHooks();
      hooks.on("test:hook", () => {});
      hooks.on("other:hook", () => {});
      hooks.clear();
      expect(hooks.hookNames().length).toBe(0);
    });
  });

  describe("HOOKS constants", () => {
    it("should define standard hook names", () => {
      expect(HOOKS.SESSION_CREATE).toBe("session:create");
      expect(HOOKS.TOOLS_REGISTER).toBe("tools:register");
      expect(HOOKS.OUTPUT_EVENT).toBe("output:event");
    });
  });

  describe("backward compatibility (old emit* aliases)", () => {
    it("emit() should call notifyHooks and return undefined", () => {
      const hooks = createHooks();
      const calls = [];
      hooks.on("test:hook", (data) => calls.push(data));
      const result = hooks.emit("test:hook", { value: 42 });
      expect(calls).toEqual([{ value: 42 }]);
      expect(result).toBeUndefined(); // notifyHooks doesn't return values
    });

    it("emitAsync() should call notifyHooksAsync", async () => {
      const hooks = createHooks();
      const results = [];
      hooks.on("test:hook", async (data) => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(data.value);
      });
      await hooks.emitAsync("test:hook", { value: 1 });
      expect(results).toEqual([1]);
    });

    it("emitAsyncSeq() should return lastResult from runHookPipeline", async () => {
      const hooks = createHooks();
      hooks.on("test:hook", () => "first");
      hooks.on("test:hook", () => "second");
      const result = await hooks.emitAsyncSeq("test:hook", {});
      expect(result).toBe("second");
    });

    it("emitAsyncSeqUntil() should return { data, stopped, lastResult }", async () => {
      const hooks = createHooks();
      hooks.on("test:hook", () => ({ action: "handled" }));
      const result = await hooks.emitAsyncSeqUntil("test:hook", {}, (r) => r?.action === "handled");
      expect(result.stopped).toBe(true);
      expect(result.lastResult).toEqual({ action: "handled" });
    });

    it("emitAsyncCollect() should return results array from runHookPipeline", async () => {
      const hooks = createHooks();
      hooks.on("test:hook", () => "val1");
      hooks.on("test:hook", () => "val2");
      const results = await hooks.emitAsyncCollect("test:hook", {});
      expect(results).toEqual([
        { result: "val1", source: null },
        { result: "val2", source: null },
      ]);
    });
  });
});
