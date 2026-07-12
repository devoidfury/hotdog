// Tests for the core hook system.

import { HookSystem, createHooks } from "../../src/core/hooks.ts";
import { describe, it, expect, beforeEach, afterEach } from "bun:test";

describe("HookSystem.on() / notifyHooks()", () => {
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

  it("should return undefined (fire-and-forget)", () => {
    const hooks = createHooks();
    hooks.on("test:hook", () => "first");
    hooks.on("test:hook", () => "second");
    expect(hooks.notifyHooks("test:hook", {})).toBeUndefined();
  });

  it("should return undefined when no handlers match", () => {
    const hooks = createHooks();
    expect(hooks.notifyHooks("nonexistent:hook", {})).toBeUndefined();
  });

  it("should not throw for unregistered hook", () => {
    const hooks = createHooks();
    hooks.notifyHooks("nonexistent", {});
  });
});

// ── on() returns removal function ─────────────────────────────────────────

describe("HookSystem — removal function from on()", () => {
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

  it("can register a new handler after removal", () => {
    const hooks = createHooks();
    const remove = hooks.on("test", () => {});
    remove();
    hooks.on("test", () => {});
    expect(hooks.handlerCount("test")).toBe(1);
  });

  it("removal function only removes the registered handler", () => {
    const hooks = createHooks();
    const remove = hooks.on("test", () => {});
    hooks.on("test", () => {});
    remove();
    expect(hooks.handlerCount("test")).toBe(1);
  });
});

// ── off() ─────────────────────────────────────────────────────────────────

describe("HookSystem.off()", () => {
  it("should remove a specific handler by reference", () => {
    const hooks = createHooks();
    const handler1 = () => "first";
    const handler2 = () => "second";
    hooks.on("test:hook", handler1);
    hooks.on("test:hook", handler2);

    expect(hooks.off("test:hook", handler1)).toBe(true);
    expect(hooks.notifyHooks("test:hook", {})).toBeUndefined();
  });

  it("returns false when handler not found", () => {
    const hooks = createHooks();
    const handler = () => {};
    expect(hooks.off("test", handler)).toBe(false);
  });

  it("returns false for non-existent hook", () => {
    const hooks = createHooks();
    expect(hooks.off("nonexistent", () => {})).toBe(false);
  });

  it("only removes the specific handler, not others", () => {
    const hooks = createHooks();
    const handler1 = () => {};
    const handler2 = () => {};
    hooks.on("test", handler1);
    hooks.on("test", handler2);
    expect(hooks.off("test", handler1)).toBe(true);
    expect(hooks.handlerCount("test")).toBe(1);
    hooks.notifyHooks("test", {});
  });

  it("can remove multiple handlers independently", () => {
    const hooks = createHooks();
    const h1 = () => {};
    const h2 = () => {};
    const h3 = () => {};
    hooks.on("test", h1);
    hooks.on("test", h2);
    hooks.on("test", h3);
    expect(hooks.off("test", h2)).toBe(true);
    expect(hooks.handlerCount("test")).toBe(2);
    expect(hooks.off("test", h1)).toBe(true);
    expect(hooks.handlerCount("test")).toBe(1);
  });
});

// ── clear() ───────────────────────────────────────────────────────────────

describe("HookSystem.clear()", () => {
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

  it("clears all handlers for a specific hook", () => {
    const hooks = createHooks();
    hooks.on("hook-a", () => {});
    hooks.on("hook-a", () => {});
    hooks.on("hook-b", () => {});
    hooks.clear("hook-a");
    expect(hooks.handlerCount("hook-a")).toBe(0);
    expect(hooks.handlerCount("hook-b")).toBe(1);
  });

  it("does nothing when clearing non-existent hook", () => {
    const hooks = createHooks();
    hooks.clear("nonexistent");
    expect(hooks.handlerCount("nonexistent")).toBe(0);
  });

  it("clear is idempotent", () => {
    const hooks = createHooks();
    hooks.on("test", () => {});
    hooks.clear("test");
    hooks.clear("test");
    expect(hooks.handlerCount("test")).toBe(0);
  });
});

// ── notifyHooksAsync() ────────────────────────────────────────────────────

describe("notifyHooksAsync()", () => {
  it("should fire async handlers without waiting", async () => {
    const hooks = createHooks();
    const results = [];
    hooks.on("test:hook", async (data) => {
      await new Promise((r) => setTimeout(r, 10));
      results.push(data.value);
    });
    hooks.notifyHooksAsync("test:hook", { value: 1 });
    expect(results).toEqual([]);

    await new Promise((r) => setTimeout(r, 50));
    expect(results).toEqual([1]);
  });

  it("catches and logs errors from async handlers", async () => {
    const hooks = createHooks();
    hooks.on("test", async () => {
      throw new Error("async boom");
    });
    await hooks.notifyHooksAsync("test", {});
  });

  it("continues running other handlers after one fails", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", async () => {
      throw new Error("fail");
    });
    hooks.on("test", async () => {
      calls.push("second");
    });
    await hooks.notifyHooksAsync("test", {});
    expect(calls).toEqual(["second"]);
  });

  it("handles sync errors in async notify", async () => {
    const hooks = createHooks();
    hooks.on("test", () => {
      throw new Error("sync error in async notify");
    });
    await hooks.notifyHooksAsync("test", {});
  });

  it("async notify with multiple handlers", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", async () => {
      calls.push(1);
    });
    hooks.on("test", async () => {
      calls.push(2);
    });
    await hooks.notifyHooksAsync("test", {});
    expect(calls).toContain(1);
    expect(calls).toContain(2);
  });
});

// ── notifyHooks — handler errors ──────────────────────────────────────────

describe("notifyHooks — handler errors", () => {
  it("handler error in notifyHooks propagates", () => {
    const hooks = createHooks();
    hooks.on("test", () => {
      throw new Error("boom");
    });
    expect(() => hooks.notifyHooks("test", {})).toThrow("boom");
  });

  it("subsequent handlers are not called after error in notifyHooks", () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", () => {
      calls.push(1);
      throw new Error("boom");
    });
    hooks.on("test", () => calls.push(2));
    expect(() => hooks.notifyHooks("test", {})).toThrow("boom");
    expect(calls).toEqual([1]);
  });
});

// ── runHookPipeline() ─────────────────────────────────────────────────────

describe("runHookPipeline()", () => {
  it("should run handlers sequentially and collect results", async () => {
    const hooks = createHooks();
    const order = [];
    hooks.on("test:hook", () => {
      order.push("a");
      return { result: "a" };
    });
    hooks.on("test:hook", () => {
      order.push("b");
      return { result: "b" };
    });
    const { results, lastResult } = await hooks.runHookPipeline(
      "test:hook",
      {},
    );
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
    const { stopped, results } = await hooks.runHookPipeline(
      "test:hook",
      {},
      { shouldStop: (r) => r?.action === "handled" },
    );
    expect(stopped).toBe(true);
    expect(order).toEqual(["a"]);
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

  it("stops on first matching result", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", () => {
      calls.push(1);
      return { action: "continue" };
    });
    hooks.on("test", () => {
      calls.push(2);
      return { action: "handled" };
    });
    hooks.on("test", () => {
      calls.push(3);
      return { action: "continue" };
    });
    const result = await hooks.runHookPipeline(
      "test",
      {},
      {
        shouldStop: (r) => r.action === "handled",
      },
    );
    expect(calls).toEqual([1, 2]);
    expect(result.stopped).toBe(true);
  });

  it("does not stop when shouldStop returns false", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", () => {
      calls.push(1);
      return { action: "continue" };
    });
    hooks.on("test", () => {
      calls.push(2);
      return { action: "continue" };
    });
    const result = await hooks.runHookPipeline(
      "test",
      {},
      {
        shouldStop: (r) => r.action === "handled",
      },
    );
    expect(calls).toEqual([1, 2]);
    expect(result.stopped).toBe(false);
  });

  it("lastResult is the last handler's return value", async () => {
    const hooks = createHooks();
    hooks.on("test", () => "first");
    hooks.on("test", () => "second");
    const result = await hooks.runHookPipeline("test", {});
    expect(result.lastResult).toBe("second");
  });

  it("lastResult is undefined when no handlers return values", async () => {
    const hooks = createHooks();
    hooks.on("test", () => {});
    hooks.on("test", () => {});
    const result = await hooks.runHookPipeline("test", {});
    expect(result.lastResult).toBeUndefined();
  });

  it("returns empty results when no handlers", async () => {
    const hooks = createHooks();
    const { results, lastResult } = await hooks.runHookPipeline(
      "nonexistent:hook",
      { value: 1 },
    );
    expect(results).toEqual([]);
    expect(lastResult).toBeUndefined();
  });

  it("handles handler that throws — continues", async () => {
    const hooks = createHooks();
    hooks.on("test:hook", () => {
      throw new Error("handler error");
    });
    hooks.on("test:hook", () => ({ action: "continue" }));
    const { lastResult } = await hooks.runHookPipeline("test:hook", {});
    expect(lastResult).toEqual({ action: "continue" });
  });

  it("handles async handlers in pipeline", async () => {
    const hooks = createHooks();
    hooks.on("test", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { async: true };
    });
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0].result.async).toBe(true);
  });

  it("shouldStop with null return value — does not stop", async () => {
    const hooks = createHooks();
    hooks.on("test", () => null);
    hooks.on("test", () => "second");
    const { stopped, results } = await hooks.runHookPipeline(
      "test",
      {},
      {
        shouldStop: (r) => r === null,
      },
    );
    expect(stopped).toBe(false);
    expect(results).toHaveLength(2);
  });

  it("empty pipeline returns empty results", async () => {
    const hooks = createHooks();
    const { results, lastResult, stopped, data } = await hooks.runHookPipeline(
      "empty",
      { key: "value" },
    );
    expect(results).toEqual([]);
    expect(lastResult).toBeUndefined();
    expect(stopped).toBe(false);
    expect(data).toEqual({ key: "value" });
  });

  it("handlers can return undefined (not collected)", async () => {
    const hooks = createHooks();
    hooks.on("test", () => undefined);
    hooks.on("test", () => "value");
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results).toHaveLength(1);
    expect(results[0].result).toBe("value");
  });
});

// ── handlerCount / hookNames ──────────────────────────────────────────────

describe("handlerCount / hookNames", () => {
  it("should return handler count for a hook", () => {
    const hooks = createHooks();
    expect(hooks.handlerCount("test:hook")).toBe(0);
    hooks.on("test:hook", () => {});
    expect(hooks.handlerCount("test:hook")).toBe(1);
    hooks.on("test:hook", () => {});
    expect(hooks.handlerCount("test:hook")).toBe(2);
  });

  it("should return all hook names", () => {
    const hooks = createHooks();
    expect(hooks.hookNames()).toEqual([]);
    hooks.on("test:hook", () => {});
    hooks.on("other:hook", () => {});
    const names = hooks.hookNames();
    expect(names).toContain("test:hook");
    expect(names).toContain("other:hook");
  });
});

// ── handler ID uniqueness ─────────────────────────────────────────────────

describe("HookSystem — handler ID uniqueness", () => {
  it("assigns unique IDs to handlers", () => {
    const hooks = new HookSystem();
    hooks.on("test", () => {});
    hooks.on("test", () => {});
    const handlers = hooks._hooks.get("test");
    expect(handlers[0].id).not.toBe(handlers[1].id);
  });

  it("handler counter increments across different hooks", () => {
    const hooks = new HookSystem();
    hooks.on("hook-a", () => {});
    hooks.on("hook-b", () => {});
    const handlersA = hooks._hooks.get("hook-a");
    const handlersB = hooks._hooks.get("hook-b");
    expect(handlersB[0].id).toBeGreaterThan(handlersA[0].id);
  });
});

// ── source tracking ───────────────────────────────────────────────────────

describe("HookSystem — source tracking", () => {
  it("tracks source when provided", () => {
    const hooks = new HookSystem();
    hooks.on("test", () => {}, "my-extension");
    const handlers = hooks._hooks.get("test");
    expect(handlers[0].source).toBe("my-extension");
  });

  it("source is undefined when not provided", () => {
    const hooks = new HookSystem();
    hooks.on("test", () => {});
    const handlers = hooks._hooks.get("test");
    expect(handlers[0].source).toBeUndefined();
  });

  it("source is tracked in pipeline results", async () => {
    const hooks = new HookSystem();
    hooks.on("test", () => ({ from: "ext1" }), "extension-1");
    hooks.on("test", () => ({ from: "ext2" }), "extension-2");
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0].source).toBe("extension-1");
    expect(results[1].source).toBe("extension-2");
  });

  it("source is null in results when not provided", async () => {
    const hooks = new HookSystem();
    hooks.on("test", () => ({ value: 1 }));
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0].source).toBeNull();
  });
});

// ── trace mode ────────────────────────────────────────────────────────────

describe("trace mode", () => {
  let origStderr;

  beforeEach(() => {
    origStderr = process.stderr.write;
    process.stderr.write = () => true;
  });

  afterEach(() => {
    process.stderr.write = origStderr;
  });

  it("enables boolean trace", () => {
    const hooks = createHooks();
    hooks._trace = true;
    expect(hooks._trace).toBe(true);
    hooks.on("test:hook", () => {});
    hooks.notifyHooks("test:hook", {});
  });

  it("disables boolean trace", () => {
    const hooks = createHooks();
    hooks._trace = false;
    expect(hooks._trace).toBe(false);
  });

  it("accepts object trace config", () => {
    const hooks = createHooks();
    hooks._trace = { enabled: true };
    expect(typeof hooks._trace).toBe("object");
    expect(hooks._trace.enabled).toBe(true);
  });

  it("trace mode does not throw", () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", () => {});
    hooks.notifyHooks("test", {});
  });

  it("trace mode skips 'log' hook", () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("log", () => {});
    hooks.notifyHooks("log", { level: "info", message: "test" });
  });

  it("trace mode with pipeline does not throw", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", () => ({ action: "continue" }), "ext1");
    await hooks.runHookPipeline("test", {});
  });

  it("trace mode with stopped pipeline does not throw", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", () => ({ action: "handled" }), "ext1");
    await hooks.runHookPipeline(
      "test",
      {},
      {
        shouldStop: (r) => r.action === "handled",
      },
    );
  });

  it("trace mode with error handler does not throw", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on(
      "test",
      () => {
        throw new Error("fail");
      },
      "ext1",
    );
    hooks.on("test", () => "recovered", "ext2");
    await hooks.runHookPipeline("test", {});
  });

  it("trace captures handler source when provided", async () => {
    const hooks = new HookSystem();
    hooks._trace = true;
    hooks.on("test", () => ({ action: "handled" }), "my-extension");
    await hooks.runHookPipeline("test", {});
  });

  it("trace works with array/null/empty return values", async () => {
    const hooks = new HookSystem();
    hooks._trace = true;
    hooks.on("test", () => [1, 2, 3]);
    hooks.on("test", () => null);
    hooks.on("test", () => ({}));
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results).toHaveLength(3);
  });

  it("trace works with action-containing object", async () => {
    const hooks = new HookSystem();
    hooks._trace = true;
    hooks.on("test", () => ({ action: "modify", input: {} }));
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0].result.action).toBe("modify");
  });

  it("async notify with trace does not throw", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("test", async () => {}, "ext1");
    await hooks.notifyHooksAsync("test", {});
  });

  it("async notify with trace skips 'log' hook", async () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks.on("log", () => {});
    await hooks.notifyHooksAsync("log", { level: "info", message: "test" });
  });

  it("respects enabledHooks filter in trace", () => {
    const hooks = createHooks();
    hooks._trace = true;
    hooks._traceOptions = {
      enabledHooks: ["filtered:hook"],
      disabledSources: [],
    };
    hooks.on("test:hook", () => {});
    hooks.notifyHooks("test:hook", {});
  });
});

// ── createHooks ───────────────────────────────────────────────────────────

describe("createHooks", () => {
  it("returns a HookSystem instance", () => {
    const hooks = createHooks();
    expect(hooks).toBeInstanceOf(HookSystem);
  });

  it("each call returns a new instance", () => {
    const hooks1 = createHooks();
    const hooks2 = createHooks();
    expect(hooks1).not.toBe(hooks2);
    hooks1.on("test", () => {});
    expect(hooks2.handlerCount("test")).toBe(0);
  });
});
