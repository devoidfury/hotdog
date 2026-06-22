// Tests for the core hook system.

import { HookSystem, HOOKS, createHooks } from "../../src/core/hooks.js";
import { describe, it, expect } from "bun:test";

describe("HookSystem", () => {
  describe("on() / emit()", () => {
    it("should call registered handlers on emit", () => {
      const hooks = createHooks();
      const calls = [];
      hooks.on("test:hook", (data) => calls.push(data));
      hooks.emit("test:hook", { value: 42 });
      expect(calls).toEqual([{ value: 42 }]);
    });

    it("should call multiple handlers in order", () => {
      const hooks = createHooks();
      const order = [];
      hooks.on("test:hook", () => order.push("a"));
      hooks.on("test:hook", () => order.push("b"));
      hooks.emit("test:hook", {});
      expect(order).toEqual(["a", "b"]);
    });

    it("should return last handler result", () => {
      const hooks = createHooks();
      hooks.on("test:hook", () => "first");
      hooks.on("test:hook", () => "second");
      expect(hooks.emit("test:hook", {})).toBe("second");
    });

    it("should return undefined when no handlers match", () => {
      const hooks = createHooks();
      expect(hooks.emit("nonexistent:hook", {})).toBeUndefined();
    });
  });

  describe("on() returns removal function", () => {
    it("should return a function that removes the handler", () => {
      const hooks = createHooks();
      const calls = [];
      const remove = hooks.on("test:hook", (data) => calls.push(data));
      hooks.emit("test:hook", { value: 1 });
      expect(calls).toEqual([{ value: 1 }]);

      remove();
      hooks.emit("test:hook", { value: 2 });
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
      expect(hooks.emit("test:hook", {})).toBe("second");
    });

    it("should return false when handler not found", () => {
      const hooks = createHooks();
      expect(hooks.off("test:hook", () => {})).toBe(false);
    });
  });

  describe("emitAsync()", () => {
    it("should call async handlers", async () => {
      const hooks = createHooks();
      const results = [];
      hooks.on("test:hook", async (data) => {
        await new Promise((r) => setTimeout(r, 10));
        results.push(data.value);
      });
      await hooks.emitAsync("test:hook", { value: 1 });
      expect(results).toEqual([1]);
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
});
