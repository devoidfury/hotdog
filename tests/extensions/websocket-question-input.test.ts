// Tests for WebSocketQuestionBridge — per-session question/answer bridge
// that resolves question-tool calls for WebSocket-hosted agents.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import {
  WebSocketQuestionBridge,
  type QuestionBridgeHooks,
  type QuestionPolicy,
} from "../../src/extensions/websocket/question-input.ts";

interface MockHooksState {
  policy: QuestionPolicy;
  channels: boolean;
  interrupts: string[];
}

function makeHooks(
  policy: QuestionPolicy = { strategy: "wait", timeoutSecs: 300 },
): QuestionBridgeHooks & { state: MockHooksState } {
  const state: MockHooksState = {
    policy,
    channels: true,
    interrupts: [],
  };
  return {
    getPolicy: () => state.policy,
    hasChannels: () => state.channels,
    interrupt: (sid) => state.interrupts.push(sid),
    state,
  };
}

describe("WebSocketQuestionBridge", () => {
  let bridge: WebSocketQuestionBridge;
  let hooks: QuestionBridgeHooks & { state: MockHooksState };

  beforeEach(() => {
    hooks = makeHooks();
    bridge = new WebSocketQuestionBridge(hooks);
  });

  afterEach(() => {
    bridge.clear();
  });

  it("returns a cached input per session", () => {
    const a = bridge.inputFor("s1");
    const b = bridge.inputFor("s1");
    const c = bridge.inputFor("s2");
    expect(a).toBe(b);
    expect(c).not.toBe(a);
  });

  it("isInteractive reflects channel presence", () => {
    const input = bridge.inputFor("s1");
    const state = hooks.state;
    expect(input.isInteractive()).toBe(true);
    state.channels = false;
    expect(input.isInteractive()).toBe(false);
  });

  it("collect resolves with client-provided answers", async () => {
    const input = bridge.inputFor("s1");
    const p = input.collectAnswers([
      { key: "name", prompt: "What is your name?" },
    ]);
    expect(bridge.hasPending("s1")).toBe(true);

    expect(bridge.answer("s1", { name: "Ada" })).toBe(true);
    await expect(p).resolves.toEqual({ name: "Ada" });
    expect(bridge.hasPending("s1")).toBe(false);
  });

  it("answer returns false when nothing is pending", () => {
    expect(bridge.answer("nope", { a: "b" })).toBe(false);
  });

  it("cancel resolves with defaults", async () => {
    const input = bridge.inputFor("s1");
    const p = input.collectAnswers([
      { key: "name", prompt: "Name?", default: "anon" },
      { key: "age", prompt: "Age?" },
    ]);

    expect(bridge.cancel("s1")).toBe(true);
    await expect(p).resolves.toEqual({ name: "anon", age: "" });
  });

  it("cancel returns false when nothing is pending", () => {
    expect(bridge.cancel("nope")).toBe(false);
  });

  it("default strategy resolves with defaults after timeout", async () => {
    hooks = makeHooks({ strategy: "default", timeoutSecs: 0.05 });
    bridge = new WebSocketQuestionBridge(hooks);

    const input = bridge.inputFor("s1");
    const p = input.collectAnswers([
      { key: "color", prompt: "Favorite color?", default: "blue" },
    ]);
    await expect(p).resolves.toEqual({ color: "blue" });
    expect(bridge.hasPending("s1")).toBe(false);
  });

  it("cancel strategy interrupts the session on timeout", async () => {
    hooks = makeHooks({ strategy: "cancel", timeoutSecs: 0.05 });
    bridge = new WebSocketQuestionBridge(hooks);

    const input = bridge.inputFor("s1");
    const p = input.collectAnswers([{ key: "q", prompt: "Go?" }]);
    await expect(p).resolves.toEqual({ q: "" });
    expect(hooks.state.interrupts).toEqual(["s1"]);
  });

  it("wait strategy keeps the question pending until answered", async () => {
    const input = bridge.inputFor("s1");
    const p = input.collectAnswers([{ key: "q", prompt: "Go?" }]);

    // The wait policy (timeoutSecs=300) does not auto-resolve, so the
    // question is still pending and only settles when an answer arrives.
    expect(bridge.hasPending("s1")).toBe(true);
    bridge.answer("s1", { q: "yes" });
    await expect(p).resolves.toEqual({ q: "yes" });
    expect(bridge.hasPending("s1")).toBe(false);
  });

  it("re-collecting on the same session resolves the stale question with defaults", async () => {
    const input = bridge.inputFor("s1");
    const first = input.collectAnswers([{ key: "a", prompt: "A?", default: "da" }]);
    const second = input.collectAnswers([{ key: "b", prompt: "B?" }]);

    bridge.answer("s1", { b: "2" });
    await expect(first).resolves.toEqual({ a: "da" });
    await expect(second).resolves.toEqual({ b: "2" });
  });

  it("defaults fills q.default ?? '' for every key", () => {
    const out = WebSocketQuestionBridge.defaults([
      { key: "a", prompt: "A?", default: "x" },
      { key: "b", prompt: "B?" },
      { key: "c", prompt: "C?", default: null as unknown },
    ]);
    expect(out).toEqual({ a: "x", b: "", c: "" });
  });

  it("dropSession resolves the pending question with defaults and evicts the cached input", async () => {
    const input = bridge.inputFor("s1");
    const p = input.collectAnswers([{ key: "q", prompt: "Q?", default: "fallback" }]);
    bridge.dropSession("s1");
    await expect(p).resolves.toEqual({ q: "fallback" });
    expect(bridge.hasPending("s1")).toBe(false);
    // Cached input is evicted, so a fresh one is returned.
    expect(bridge.inputFor("s1")).not.toBe(input);
    // No pending question remains, so late answers are rejected.
    expect(bridge.answer("s1", { q: "late" })).toBe(false);
  });

  it("clear drops pending questions without resolving", async () => {
    const input = bridge.inputFor("s1");
    const p = input.collectAnswers([{ key: "q", prompt: "Q?" }]);
    bridge.clear();
    expect(bridge.hasPending("s1")).toBe(false);
    // The promise stays pending (nothing resolves it after clear).
    expect(bridge.answer("s1", { q: "late" })).toBe(false);
    p.catch(() => {});
  });
});
