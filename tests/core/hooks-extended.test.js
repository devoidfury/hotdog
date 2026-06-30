// Extended tests for HookSystem — trace mode, error handling, edge cases.
import { HookSystem, createHooks } from "../../src/core/hooks.js";
import { describe, it, expect } from "bun:test";

describe("HookSystem — trace mode", () => {
  it("enables trace mode via _trace flag", () => {
    const hooks = createHooks();
    hooks._trace = true;
    expect(hooks._trace).toBe(true);
  });
});

describe("_summarizeResult (via runHookPipeline trace)", () => {
  it("trace captures handler source when provided", async () => {
    const hooks = new HookSystem();
    hooks._trace = true;
    hooks.on("test", () => ({ action: "handled" }), "my-extension");
    await hooks.runHookPipeline("test", {});
    // Should not throw even with trace enabled
  });

  it("trace works with array return values", async () => {
    const hooks = new HookSystem();
    hooks._trace = true;
    hooks.on("test", () => [1, 2, 3]);
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results).toHaveLength(1);
    expect(results[0].result).toEqual([1, 2, 3]);
  });

  it("trace works with null return values", async () => {
    const hooks = new HookSystem();
    hooks._trace = true;
    hooks.on("test", () => null);
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results).toHaveLength(1);
    expect(results[0].result).toBeNull();
  });

  it("trace works with empty object return", async () => {
    const hooks = new HookSystem();
    hooks._trace = true;
    hooks.on("test", () => ({}));
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results).toHaveLength(1);
  });

  it("trace works with action-containing object", async () => {
    const hooks = new HookSystem();
    hooks._trace = true;
    hooks.on("test", () => ({ action: "modify", input: {} }));
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0].result.action).toBe("modify");
  });
});

describe("notifyHooks — handler errors", () => {
  it("handler error in notifyHooks propagates", () => {
    const hooks = createHooks();
    hooks.on("test", () => { throw new Error("boom"); });
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

describe("notifyHooksAsync — error handling", () => {
  it("catches and logs errors from async handlers", async () => {
    const hooks = createHooks();
    hooks.on("test", async () => { throw new Error("async boom"); });
    // Should not throw — errors are caught
    await hooks.notifyHooksAsync("test", {});
  });

  it("continues running other handlers after one fails", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", async () => { throw new Error("fail"); });
    hooks.on("test", async () => { calls.push("second"); });
    await hooks.notifyHooksAsync("test", {});
    expect(calls).toEqual(["second"]);
  });

  it("handles sync errors in async notify", async () => {
    const hooks = createHooks();
    hooks.on("test", () => { throw new Error("sync error in async notify"); });
    await hooks.notifyHooksAsync("test", {});
  });
});

describe("runHookPipeline — edge cases", () => {
  it("handles async handlers in pipeline", async () => {
    const hooks = createHooks();
    hooks.on("test", async () => {
      await new Promise((r) => setTimeout(r, 5));
      return { async: true };
    });
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0].result.async).toBe(true);
  });

  it("handles handler error in pipeline — continues", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", () => {
      calls.push(1);
      throw new Error("fail");
    });
    hooks.on("test", () => {
      calls.push(2);
      return { ok: true };
    });
    const { results } = await hooks.runHookPipeline("test", {});
    expect(calls).toEqual([1, 2]);
    expect(results).toHaveLength(1);
    expect(results[0].result.ok).toBe(true);
  });

  it("shouldStop with null return value", async () => {
    const hooks = createHooks();
    const calls = [];
    hooks.on("test", () => {
      calls.push(1);
      return undefined;
    });
    hooks.on("test", () => {
      calls.push(2);
      return "value";
    });
    const { results } = await hooks.runHookPipeline("test", {}, {
      shouldStop: (r) => r === "value",
    });
    expect(calls).toEqual([1, 2]);
    expect(results).toHaveLength(1);
  });

  it("shouldStop with nullish value — does not stop", async () => {
    const hooks = createHooks();
    hooks.on("test", () => null);
    hooks.on("test", () => "second");
    const { results, stopped } = await hooks.runHookPipeline("test", {}, {
      shouldStop: (r) => r === null,
    });
    // null is truthy-ish in the check `resolved && opts.shouldStop(resolved)`
    // but null is falsy, so shouldStop won't be called
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

  it("source is tracked in results", async () => {
    const hooks = new HookSystem();
    hooks.on("test", () => ({ from: "ext1" }), "extension-1");
    hooks.on("test", () => ({ from: "ext2" }), "extension-2");
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0].source).toBe("extension-1");
    expect(results[1].source).toBe("extension-2");
  });

  it("source is null when not provided", async () => {
    const hooks = new HookSystem();
    hooks.on("test", () => ({ value: 1 }));
    const { results } = await hooks.runHookPipeline("test", {});
    expect(results[0].source).toBeNull();
  });
});

describe("HookSystem — handlerCount and hookNames", () => {
  it("handlerCount returns correct count", () => {
    const hooks = createHooks();
    expect(hooks.handlerCount("empty")).toBe(0);
    hooks.on("test", () => {});
    expect(hooks.handlerCount("test")).toBe(1);
    hooks.on("test", () => {});
    expect(hooks.handlerCount("test")).toBe(2);
  });

  it("hookNames returns all registered hook names", () => {
    const hooks = createHooks();
    expect(hooks.hookNames()).toEqual([]);
    hooks.on("a", () => {});
    hooks.on("b", () => {});
    const names = hooks.hookNames();
    expect(names).toContain("a");
    expect(names).toContain("b");
    expect(names).toHaveLength(2);
  });
});
