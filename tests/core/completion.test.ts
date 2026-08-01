// Tests for the completion system.

import {
  CompletionService,
  createCompletionService,
  type CompletionContext,
  type CompletionOption,
  type CompletionMatcher,
  type CompletionHandler,
} from "../../src/core/completion.ts";
import { describe, it, expect, beforeEach } from "bun:test";

// Mock agent for tests
const mockAgent = {} as unknown as import("../../src/core/agent.ts").Agent;

function makeCtx(overrides: Partial<CompletionContext> = {}): CompletionContext {
  return {
    line: "",
    cursorPos: 0,
    agent: mockAgent,
    ...overrides,
  };
}

describe("CompletionService — basic operations", () => {
  let svc: CompletionService;

  beforeEach(() => {
    svc = createCompletionService();
  });

  it("should create with no handlers", () => {
    expect(svc.handlerCount()).toBe(0);
  });

  it("should register a handler and return a removal function", () => {
    const matcher: CompletionMatcher = () => true;
    const handler: CompletionHandler = () => [{ value: "test" }];
    const remove = svc.register(matcher, handler, "test-source");
    expect(typeof remove).toBe("function");
    expect(svc.handlerCount()).toBe(1);
  });

  it("should remove a handler via the returned function", () => {
    const remove = svc.register(() => true, () => [{ value: "x" }]);
    expect(svc.handlerCount()).toBe(1);
    remove();
    expect(svc.handlerCount()).toBe(0);
  });

  it("handles double removal gracefully", () => {
    const remove = svc.register(() => true, () => []);
    remove();
    expect(() => remove()).not.toThrow();
    expect(svc.handlerCount()).toBe(0);
  });

  it("should clear all handlers", () => {
    svc.register(() => true, () => []);
    svc.register(() => true, () => []);
    svc.clear();
    expect(svc.handlerCount()).toBe(0);
  });
});

describe("CompletionService — matching", () => {
  let svc: CompletionService;

  beforeEach(() => {
    svc = createCompletionService();
  });

  it("should only invoke handlers whose matcher returns true", async () => {
    let handlerACalled = false;
    let handlerBCalled = false;

    svc.register(
      () => true,
      () => { handlerACalled = true; return [{ value: "a" }]; },
      "a",
    );
    svc.register(
      () => false,
      () => { handlerBCalled = true; return [{ value: "b" }]; },
      "b",
    );

    const results = await svc.request(makeCtx());
    expect(handlerACalled).toBe(true);
    expect(handlerBCalled).toBe(false);
    expect(results).toEqual([{ value: "a" }]);
  });

  it("should invoke all matching handlers", async () => {
    svc.register(() => true, () => [{ value: "a" }]);
    svc.register(() => true, () => [{ value: "b" }]);

    const results = await svc.request(makeCtx());
    expect(results).toEqual([{ value: "a" }, { value: "b" }]);
  });

  it("should return empty array when no handlers match", async () => {
    svc.register(() => false, () => [{ value: "x" }]);
    const results = await svc.request(makeCtx());
    expect(results).toEqual([]);
  });

  it("should return empty array when no handlers registered", async () => {
    const results = await svc.request(makeCtx());
    expect(results).toEqual([]);
  });

  it("should skip handlers that return null", async () => {
    svc.register(() => true, () => null);
    svc.register(() => true, () => [{ value: "x" }]);
    const results = await svc.request(makeCtx());
    expect(results).toEqual([{ value: "x" }]);
  });

  it("should skip handlers that return empty array", async () => {
    svc.register(() => true, () => []);
    svc.register(() => true, () => [{ value: "x" }]);
    const results = await svc.request(makeCtx());
    expect(results).toEqual([{ value: "x" }]);
  });
});

describe("CompletionService — async handlers", () => {
  let svc: CompletionService;

  beforeEach(() => {
    svc = createCompletionService();
  });

  it("should handle async handlers", async () => {
    svc.register(
      () => true,
      async () => [{ value: "async-result" }],
    );
    const results = await svc.request(makeCtx());
    expect(results).toEqual([{ value: "async-result" }]);
  });

  it("should handle mixed sync and async handlers", async () => {
    svc.register(() => true, () => [{ value: "sync" }]);
    svc.register(() => true, async () => [{ value: "async" }]);
    const results = await svc.request(makeCtx());
    expect(results).toEqual([{ value: "sync" }, { value: "async" }]);
  });

  it("should timeout slow async handlers", async () => {
    svc.register(
      () => true,
      async () => {
        await new Promise((r) => setTimeout(r, 500));
        return [{ value: "slow" }];
      },
    );
    const results = await svc.request(makeCtx(), 50);
    expect(results).toEqual([]);
  });

  it("should still return results from fast handlers when one times out", async () => {
    svc.register(
      () => true,
      async () => {
        await new Promise((r) => setTimeout(r, 500));
        return [{ value: "slow" }];
      },
    );
    svc.register(() => true, () => [{ value: "fast" }]);
    const results = await svc.request(makeCtx(), 50);
    expect(results).toEqual([{ value: "fast" }]);
  });
});

describe("CompletionService — error handling", () => {
  let svc: CompletionService;

  beforeEach(() => {
    svc = createCompletionService();
  });

  it("should not crash when a matcher throws", async () => {
    svc.register(
      () => { throw new Error("matcher boom"); },
      () => [{ value: "x" }],
    );
    svc.register(() => true, () => [{ value: "ok" }]);
    const results = await svc.request(makeCtx());
    expect(results).toEqual([{ value: "ok" }]);
  });

  it("should not crash when a sync handler throws", async () => {
    svc.register(
      () => true,
      () => { throw new Error("handler boom"); },
    );
    svc.register(() => true, () => [{ value: "ok" }]);
    const results = await svc.request(makeCtx());
    expect(results).toEqual([{ value: "ok" }]);
  });

  it("should not crash when an async handler rejects", async () => {
    svc.register(
      () => true,
      async () => { throw new Error("async boom"); },
    );
    svc.register(() => true, () => [{ value: "ok" }]);
    const results = await svc.request(makeCtx());
    expect(results).toEqual([{ value: "ok" }]);
  });
});

describe("CompletionService — CompletionOption", () => {
  let svc: CompletionService;

  beforeEach(() => {
    svc = createCompletionService();
  });

  it("should preserve display property", async () => {
    svc.register(() => true, () => [
      { value: "model-1", display: "Model 1 (fast)" },
      { value: "model-2" },
    ]);
    const results = await svc.request(makeCtx());
    expect(results).toEqual([
      { value: "model-1", display: "Model 1 (fast)" },
      { value: "model-2" },
    ]);
  });
});

describe("CompletionService — context access", () => {
  let svc: CompletionService;

  beforeEach(() => {
    svc = createCompletionService();
  });

  it("should pass context to matchers", async () => {
    let receivedCtx: CompletionContext | null = null;
    svc.register(
      (ctx) => { receivedCtx = ctx; return true; },
      () => [{ value: "x" }],
    );
    await svc.request(makeCtx({ line: "/model gpt", cursorPos: 9 }));
    expect(receivedCtx?.line).toBe("/model gpt");
    expect(receivedCtx?.cursorPos).toBe(9);
  });

  it("should pass context to handlers", async () => {
    let receivedCtx: CompletionContext | null = null;
    svc.register(
      () => true,
      (ctx) => { receivedCtx = ctx; return [{ value: "x" }]; },
    );
    await svc.request(makeCtx({ line: "/skill ", cursorPos: 7 }));
    expect(receivedCtx?.line).toBe("/skill ");
    expect(receivedCtx?.cursorPos).toBe(7);
  });
});
