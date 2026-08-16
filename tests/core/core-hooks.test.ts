// Tests for the core hook system.

import {
  HookSystem,
  createHooks,
  isGateActionBlock,
  isGateActionModify,
  isGateActionContinue,
  isGateActionHandled,
  isInputTransform,
  isInputHandled,
  type GateAction,
  type InputHookResult,
} from "../../src/core/hooks.ts";
import { describe, it, expect } from "bun:test";

describe("HookSystem.on() / notifyHooks()", () => {
  it("should call registered handlers on notifyHooks", () => {
    const hooks = createHooks();
    const calls: unknown[] = [];
    hooks.on("test:hook", (data) => calls.push(data));
    hooks.notifyHooks("test:hook", { value: 42 });
    expect(calls).toEqual([{ value: 42 }]);
  });

  it("should call multiple handlers in order", () => {
    const hooks = createHooks();
    const order: string[] = [];
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

  it("returns undefined and does not throw for unregistered hook", () => {
    const hooks = createHooks();
    expect(hooks.notifyHooks("nonexistent:hook", {})).toBeUndefined();
  });
});

// ── on() returns removal function ─────────────────────────────────────────

describe("HookSystem — removal function from on()", () => {
  it("should return a function that removes the handler", () => {
    const hooks = createHooks();
    const calls: unknown[] = [];
    const remove = hooks.on("test:hook", (data) => calls.push(data));
    hooks.notifyHooks("test:hook", { value: 1 });
    expect(calls).toEqual([{ value: 1 }]);

    remove();
    hooks.notifyHooks("test:hook", { value: 2 });
    expect(calls).toEqual([{ value: 1 }]);
  });

  it("handles double removal gracefully and only removes its own handler", () => {
    const hooks = createHooks();
    const remove = hooks.on("test", () => {});
    hooks.on("test", () => {});
    remove();
    expect(() => remove()).not.toThrow();
    expect(hooks.handlerCount("test")).toBe(1);
  });
});

// ── off() ─────────────────────────────────────────────────────────────────

describe("HookSystem.off()", () => {
  it("removes a specific handler by reference", () => {
    const hooks = createHooks();
    const handler1 = () => "first";
    const handler2 = () => "second";
    hooks.on("test:hook", handler1);
    hooks.on("test:hook", handler2);

    expect(hooks.off("test:hook", handler1)).toBe(true);
    expect(hooks.handlerCount("test:hook")).toBe(1);
  });

  it("returns false when handler not found or hook does not exist", () => {
    const hooks = createHooks();
    const handler = () => {};
    expect(hooks.off("test", handler)).toBe(false);
    expect(hooks.off("nonexistent", () => {})).toBe(false);
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
  it("clears a specific hook (including all handlers for it)", () => {
    const hooks = createHooks();
    hooks.on("test:hook", () => {});
    hooks.on("test:hook", () => {});
    hooks.on("other:hook", () => {});
    hooks.clear("test:hook");
    expect(hooks.handlerCount("test:hook")).toBe(0);
    expect(hooks.handlerCount("other:hook")).toBe(1);
  });

  it("clears all hooks when no name given", () => {
    const hooks = createHooks();
    hooks.on("test:hook", () => {});
    hooks.on("other:hook", () => {});
    hooks.clear();
    expect(hooks.hookNames().length).toBe(0);
  });

  it("is idempotent and safe on non-existent hooks", () => {
    const hooks = createHooks();
    hooks.clear("nonexistent");
    hooks.on("test", () => {});
    hooks.clear("test");
    hooks.clear("test");
    expect(hooks.handlerCount("test")).toBe(0);
    expect(hooks.handlerCount("nonexistent")).toBe(0);
  });
});

// ── notifyHooks() — unified fire-and-forget (handles both sync and async) ──

describe("notifyHooks()", () => {
  it("should fire async handlers without waiting", async () => {
    const hooks = createHooks();
    const results: unknown[] = [];
    hooks.on("test:hook", async (data) => {
      await new Promise((r) => setTimeout(r, 10));
      results.push((data as any).value);
    });
    hooks.notifyHooks("test:hook", { value: 1 });
    expect(results).toEqual([]);

    await new Promise((r) => setTimeout(r, 50));
    expect(results).toEqual([1]);
  });

  it("continues running other handlers after one fails", async () => {
    const hooks = createHooks();
    const calls: string[] = [];
    hooks.on("test", async () => {
      throw new Error("fail");
    });
    hooks.on("test", async () => {
      calls.push("second");
    });
    hooks.notifyHooks("test", {});
    // Wait for async handlers to settle
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toEqual(["second"]);
  });

  it("handles sync errors in notifyHooks by catching and logging", async () => {
    const hooks = createHooks();
    const calls: string[] = [];
    hooks.on("test", () => {
      throw new Error("sync error in notifyHooks");
    });
    hooks.on("test", () => {
      calls.push("after");
    });
    // Errors are caught and logged, not thrown; later handlers still run
    hooks.notifyHooks("test", {});
    expect(calls).toEqual(["after"]);
  });

  it("handles both sync and async handlers together", async () => {
    const hooks = createHooks();
    const calls: string[] = [];
    hooks.on("test", () => {
      calls.push("sync");
    });
    hooks.on("test", async () => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push("async");
    });
    hooks.notifyHooks("test", {});
    expect(calls).toContain("sync");
    // Wait for async to complete
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toContain("async");
  });

  it("processes handlers in order", async () => {
    const hooks = createHooks();
    const calls: string[] = [];
    hooks.on("test", () => {
      calls.push("first");
    });
    hooks.on("test", async () => {
      await new Promise((r) => setTimeout(r, 10));
      calls.push("second");
    });
    hooks.on("test", () => {
      calls.push("third");
    });
    hooks.notifyHooks("test", {});
    // Sync handlers run in order immediately
    expect(calls).toEqual(["first", "third"]);
    // Wait for async
    await new Promise((r) => setTimeout(r, 50));
    // Async handlers were started in order
    expect(calls).toContain("second");
  });
});

// ── runHookPipeline() ─────────────────────────────────────────────────────

describe("runHookPipeline()", () => {
  it("should run handlers sequentially and collect results", async () => {
    const hooks = createHooks();
    const order: string[] = [];
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
    const calls: number[] = [];
    hooks.on("test", () => { calls.push(1); return { action: "continue" }; });
    hooks.on("test", () => { calls.push(2); return { action: "handled" }; });
    hooks.on("test", () => { calls.push(3); }); // never called
    const { stopped, results } = await hooks.runHookPipeline(
      "test",
      {},
      { shouldStop: (r: any) => r?.action === "handled" },
    );
    expect(stopped).toBe(true);
    expect(calls).toEqual([1, 2]);
    // Results include all handlers that ran before the stop
    expect(results).toHaveLength(2);
    expect(results[0]!.result).toEqual({ action: "continue" });
    expect(results[1]!.result).toEqual({ action: "handled" });
  });

  it("should pass mutable data through handlers", async () => {
    const hooks = createHooks();
    hooks.on("test:hook", (data: any) => {
      data.count = (data.count || 0) + 1;
    });
    hooks.on("test:hook", (data: any) => {
      data.count = (data.count || 0) + 1;
    });
    const { data } = await hooks.runHookPipeline("test:hook", { count: 0 });
    expect((data as any).count).toBe(2);
  });

  it("does not stop when shouldStop returns false", async () => {
    const hooks = createHooks();
    const calls: number[] = [];
    hooks.on("test", () => { calls.push(1); return { action: "continue" }; });
    hooks.on("test", () => { calls.push(2); return { action: "continue" }; });
    const result = await hooks.runHookPipeline(
      "test",
      {},
      { shouldStop: (r: any) => r.action === "handled" },
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
    expect((results[0]!.result as any).async).toBe(true);
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
    expect(results[0]!.result).toBe("value");
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

// ── source tracking via pipeline results ──────────────────────────────────

describe("HookSystem — source tracking", () => {
  it("source is tracked in pipeline results when provided", async () => {
    const hooks = new HookSystem();
    hooks.on("test", () => ({ from: "ext1" }), "extension-1");
    hooks.on("test", () => ({ from: "ext2" }), "extension-2");
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0]!.source).toBe("extension-1");
    expect(results[1]!.source).toBe("extension-2");
  });

  it("source is null in results when not provided", async () => {
    const hooks = new HookSystem();
    hooks.on("test", () => ({ value: 1 }));
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0]!.source).toBeNull();
  });
});

// ── trace mode ────────────────────────────────────────────────────────────

describe("trace mode", () => {
  it("trace mode with stopped pipeline captures results and source", async () => {
    const hooks = createHooks();
    hooks.trace = true;
    hooks.on("test", () => ({ action: "handled" }), "ext1");
    const result = await hooks.runHookPipeline(
      "test",
      {},
      {
        shouldStop: (r: any) => r.action === "handled",
      },
    );
    expect(result.stopped).toBe(true);
    expect(result.results[0]!.source).toBe("ext1");
  });

  it("trace mode handles errors in handlers gracefully", async () => {
    const hooks = createHooks();
    hooks.trace = true;
    hooks.on(
      "test",
      () => {
        throw new Error("fail");
      },
      "ext1",
    );
    hooks.on("test", () => "recovered", "ext2");
    const { results } = await hooks.runHookPipeline("test", {});
    // First handler threw, second recovered - only second result captured
    expect(results).toHaveLength(1);
    expect(results[0]!.result).toBe("recovered");
  });

  it("trace getter/setter works", () => {
    const hooks = createHooks();
    expect(hooks.trace).toBe(false);
    hooks.trace = true;
    expect(hooks.trace).toBe(true);
    hooks.trace = { enabled: true };
    expect(hooks.trace).toEqual({ enabled: true });
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

describe("HookSystem — Priority", () => {
  it("should call handlers based on priority (higher first)", () => {
    const hooks = createHooks();
    const order: string[] = [];
    hooks.on("test:hook", () => order.push("low"), { priority: 0 });
    hooks.on("test:hook", () => order.push("high"), { priority: 100 });
    hooks.on("test:hook", () => order.push("mid"), { priority: 50 });
    hooks.notifyHooks("test:hook", {});
    expect(order).toEqual(["high", "mid", "low"]);
  });

  it("should preserve registration order for equal priority", () => {
    const hooks = createHooks();
    const order: string[] = [];
    hooks.on("test:hook", () => order.push("first"), { priority: 10 });
    hooks.on("test:hook", () => order.push("second"), { priority: 10 });
    hooks.notifyHooks("test:hook", {});
    expect(order).toEqual(["first", "second"]);
  });

  it("should maintain priority after removing a handler", () => {
    const hooks = createHooks();
    const order: string[] = [];
    const remove = hooks.on("test:hook", () => order.push("mid"), { priority: 50 });
    hooks.on("test:hook", () => order.push("low"), { priority: 0 });
    hooks.on("test:hook", () => order.push("high"), { priority: 100 });
    
    remove();
    hooks.notifyHooks("test:hook", {});
    expect(order).toEqual(["high", "low"]);
  });
});

// ── Type guard functions ─────────────────────────────────────────────────

describe("GateAction type guards", () => {
  const actions = [
    { name: "block", guard: isGateActionBlock, value: { action: "block" as const, result: "denied" } },
    { name: "modify", guard: isGateActionModify, value: { action: "modify" as const, input: "new" } },
    { name: "continue", guard: isGateActionContinue, value: { action: "continue" as const } },
    { name: "handled", guard: isGateActionHandled, value: { action: "handled" as const } },
  ];

  it.each(actions)("correctly identifies $name action", ({ guard, value }) => {
    expect(guard(value)).toBe(true);
  });

  it.each(actions)("rejects other action types for $name", ({ guard, name }) => {
    for (const other of actions) {
      if (other.name !== name) expect(guard(other.value)).toBe(false);
    }
  });

  it("rejects null/undefined/non-object input", () => {
    for (const val of [null, undefined, 42, "block", {}] as unknown[]) {
      expect(isGateActionBlock(val as GateAction | null | undefined)).toBe(false);
      expect(isGateActionModify(val as GateAction | null | undefined)).toBe(false);
      expect(isGateActionContinue(val as GateAction | null | undefined)).toBe(false);
      expect(isGateActionHandled(val as GateAction | null | undefined)).toBe(false);
    }
  });
});

describe("InputHookResult type guards", () => {
  const results = [
    { name: "transform", guard: isInputTransform, value: { action: "transform" as const, text: "modified" } },
    { name: "handled", guard: isInputHandled, value: { action: "handled" as const } },
  ];

  it.each(results)("correctly identifies $name result", ({ guard, value }) => {
    expect(guard(value)).toBe(true);
  });

  it.each(results)("rejects other result types for $name", ({ guard, name }) => {
    for (const other of results) {
      if (other.name !== name) expect(guard(other.value)).toBe(false);
    }
  });

  it("rejects null/undefined/non-object input", () => {
    for (const val of [null, undefined, 42, "block", {}] as unknown[]) {
      expect(isInputTransform(val as InputHookResult | null | undefined)).toBe(false);
      expect(isInputHandled(val as InputHookResult | null | undefined)).toBe(false);
    }
  });
});

// ── hooksMap (exposed for testing) ────────────────────────────────────────

describe("hooksMap", () => {
  it("returns the internal handler map", () => {
    const hooks = new HookSystem();
    expect(hooks.hooksMap).toBeInstanceOf(Map);
    expect(hooks.hooksMap.size).toBe(0);

    hooks.on("test", () => "a");
    hooks.on("test", () => "b");
    hooks.on("other", () => "c");

    expect(hooks.hooksMap.size).toBe(2);
    expect(hooks.hooksMap.get("test")!.length).toBe(2);
    expect(hooks.hooksMap.get("other")!.length).toBe(1);
  });
});

