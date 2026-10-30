// Loop-detect extension: pure detector unit tests + hook-wiring tests
// (mock core/agent, handlers invoked directly, same style as loop-extension.test.ts).

import { describe, it, expect } from "bun:test";
import { create as createLoopDetect } from "@extensions/loop-detect/index.ts";
import {
  callSignature,
  repeatRun,
  alternatingRun,
  detectLoop,
  escalationLevel,
  resultDigest,
  describeLoop,
} from "@extensions/loop-detect/detector.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";

// ── Pure detector ───────────────────────────────────────────────────────────

describe("callSignature", () => {
  it("normalizes key order and whitespace in JSON args", () => {
    expect(callSignature("read", '{"b":2,"a":1}')).toBe(
      callSignature("read", '{ "a" : 1, "b" : 2 }'),
    );
  });

  it("normalizes nested object keys", () => {
    expect(callSignature("edit", '{"x":{"b":2,"a":1}}')).toBe(
      callSignature("edit", '{"x":{"a":1,"b":2}}'),
    );
  });

  it("keeps array order (arrays are semantic)", () => {
    expect(callSignature("t", '{"x":[1,2]}')).not.toBe(callSignature("t", '{"x":[2,1]}'));
  });

  it("differs across tool names for identical args", () => {
    expect(callSignature("read", '{"p":1}')).not.toBe(callSignature("write", '{"p":1}'));
  });

  it("differs across args", () => {
    expect(callSignature("read", '{"a":1}')).not.toBe(callSignature("read", '{"a":2}'));
  });

  it("treats missing/empty args as one shape", () => {
    expect(callSignature("t", "")).toBe(callSignature("t", "   "));
  });

  it("falls back to the raw string for non-JSON args", () => {
    expect(callSignature("bash", "ls -l")).toBe(callSignature("bash", "ls -l"));
    expect(callSignature("bash", "ls -l")).not.toBe(callSignature("bash", "ls -a"));
  });

  it("folds the result digest in: same name+args, different digest -> different signature", () => {
    const a = callSignature("read", '{"p":1}', resultDigest(true, "out-1"));
    const b = callSignature("read", '{"p":1}', resultDigest(true, "out-2"));
    expect(a).not.toBe(b);
  });

  it("omitted digest is stable across calls (legacy shape)", () => {
    expect(callSignature("read", '{"p":1}')).toBe(callSignature("read", '{"p":1}'));
    // The constant empty third field keeps no-digest calls in their own space.
    expect(callSignature("read", '{"p":1}')).not.toBe(
      callSignature("read", '{"p":1}', resultDigest(true, "")),
    );
  });
});

describe("resultDigest", () => {
  it("is deterministic for the same result and success flag", () => {
    expect(resultDigest(true, { a: 1, b: "x" })).toBe(resultDigest(true, { a: 1, b: "x" }));
  });

  it("changes when content changes", () => {
    expect(resultDigest(true, "run 1: 3 passed")).not.toBe(resultDigest(true, "run 1: 4 passed"));
  });

  it("changes when length changes but the prefix does not", () => {
    expect(resultDigest(true, "output")).not.toBe(resultDigest(true, "outputAPPENDED"));
  });

  it("changes on a success flip with an identical payload", () => {
    expect(resultDigest(true, "boom")).not.toBe(resultDigest(false, "boom"));
  });

  it("does not throw on non-stringifyable input", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => resultDigest(false, cyclic)).not.toThrow();
    expect(typeof resultDigest(false, cyclic)).toBe("string");
    expect(() => resultDigest(true, 42n as unknown)).not.toThrow();
  });
});

describe("describeLoop", () => {
  it("mentions identical arguments and output for repeats", () => {
    expect(describeLoop("repeat", 9, "read")).toContain("identical arguments and output");
  });

  it("mentions repeated outputs for ping-pong", () => {
    expect(describeLoop("ping_pong", 4, "bash")).toContain("repeated outputs");
  });
});

describe("repeatRun / alternatingRun", () => {
  it("counts the identical suffix", () => {
    expect(repeatRun([])).toBe(0);
    expect(repeatRun(["a"])).toBe(1);
    expect(repeatRun(["b", "a", "a", "a"])).toBe(3);
    expect(repeatRun(["a", "a", "a", "b"])).toBe(1);
  });

  it("counts the strict-alternation suffix", () => {
    expect(alternatingRun([])).toBe(0);
    expect(alternatingRun(["a"])).toBe(1);
    expect(alternatingRun(["a", "b"])).toBe(2);
    expect(alternatingRun(["a", "b", "a", "b"])).toBe(4);
    expect(alternatingRun(["x", "a", "b", "a", "b"])).toBe(4);
    expect(alternatingRun(["a", "b", "a", "c"])).toBe(2);
  });

  it("never reports pure repeats as alternating", () => {
    expect(alternatingRun(["a", "a", "a", "a"])).toBe(1);
  });
});

describe("detectLoop / escalationLevel", () => {
  const opts = { repeatThreshold: 3, pingPongThreshold: 4 };

  it("returns null below thresholds", () => {
    expect(detectLoop(["a", "a"], opts)).toBeNull();
    expect(detectLoop(["a", "b", "a"], opts)).toBeNull();
  });

  it("detects repeats at the threshold", () => {
    const v = detectLoop(["a", "a", "a"], opts);
    expect(v).toEqual({ kind: "repeat", streak: 3, threshold: 3 });
  });

  it("detects ping-pong at the threshold", () => {
    const v = detectLoop(["a", "b", "a", "b"], opts);
    expect(v).toEqual({ kind: "ping_pong", streak: 4, threshold: 4 });
  });

  it("maps streaks onto the escalation bands", () => {
    const t = 3;
    expect(escalationLevel({ kind: "repeat", streak: 3, threshold: t })).toBe(1);
    expect(escalationLevel({ kind: "repeat", streak: 5, threshold: t })).toBe(1);
    expect(escalationLevel({ kind: "repeat", streak: 6, threshold: t })).toBe(2);
    expect(escalationLevel({ kind: "repeat", streak: 8, threshold: t })).toBe(2);
    expect(escalationLevel({ kind: "repeat", streak: 9, threshold: t })).toBe(3);
  });
});

// ── Extension wiring ────────────────────────────────────────────────────────

function createMockCore(config: Record<string, unknown> = {}) {
  return {
    hooks: new HookSystem(),
    // Resolved-block shape: loopDetect carries its schema defaults as
    // explicit literals (Centralized Defaults -- the extension consumes them
    // directly, no code-side mirrors).
    config: { loopDetect: { enabled: true, repeatThreshold: 3, pingPongThreshold: 4 }, ...config },
    resolved: {},
    toolRegistry: { getAll: () => [], register: () => {}, has: () => false, remove: () => {} },
    extensions: { get: () => undefined },
  } as any;
}

function createMockAgent(sessionId = "s1") {
  const emitted: Array<{ type: string; content: string }> = [];
  const added: any[] = [];
  return {
    sessionId,
    isRestoring: false,
    cancelled: false,
    cancel() {
      this.cancelled = true;
    },
    emitOutput: (type: string, data: Record<string, unknown>) => {
      emitted.push({ type, content: (data.content as string) ?? "" });
    },
    getEmitted: () => [...emitted],
    addMessage: (msg: any) => added.push(msg),
    getAdded: () => [...added],
  };
}

function hook(ext: { hooks?: unknown }, name: string): (payload: any) => unknown {
  const fn = (ext.hooks as Record<string, ((payload: any) => unknown) | undefined>)[name];
  if (!fn) throw new Error(`hook ${name} is not registered`);
  return fn;
}

function feed(
  ext: { hooks?: unknown },
  agent: ReturnType<typeof createMockAgent>,
  toolName: string,
  input = "{}",
  result: unknown = "ok",
  success = true,
) {
  return hook(ext, HOOKS.TOOL_RESULT)({
    toolCallId: "tc",
    toolName,
    input,
    success,
    result,
    agent,
  });
}

function contextOf(ext: { hooks?: unknown }, agent: ReturnType<typeof createMockAgent>, messages: any[] = []) {
  return hook(ext, HOOKS.CONTEXT)({ messages, agent }) as { messages: any[] } | undefined;
}

describe("loop-detect extension", () => {
  it("returns no hooks when disabled", () => {
    const ext = createLoopDetect(createMockCore({ loopDetect: { enabled: false, repeatThreshold: 3, pingPongThreshold: 4 } }));
    expect(ext.hooks).toBeUndefined();
  });

  it("nudges once at the repeat threshold, not again inside the same band", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    await feed(ext, agent, "read", '{"p":"a.txt"}');
    await feed(ext, agent, "read", '{"p":"a.txt"}');
    expect(detections).toHaveLength(0);
    // No notice may be injected during tool execution, only at CONTEXT.
    expect(agent.getAdded()).toHaveLength(0);

    await feed(ext, agent, "read", '{"p":"a.txt"}');
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({
      toolName: "read",
      kind: "repeat",
      streak: 3,
      level: 1,
    });

    // Streaks 4 and 5 stay inside band 1: no repeat firing.
    await feed(ext, agent, "read", '{"p":"a.txt"}');
    await feed(ext, agent, "read", '{"p":"a.txt"}');
    expect(detections).toHaveLength(1);

    // Streak 6 crosses into band 2.
    await feed(ext, agent, "read", '{"p":"a.txt"}');
    expect(detections).toHaveLength(2);
    expect(detections[1]).toMatchObject({ streak: 6, level: 2 });
  });

  it("CONTEXT injects the pending nudge exactly once and persists it", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();

    for (let i = 0; i < 3; i++) await feed(ext, agent, "read");

    const patched = contextOf(ext, agent, [{ role: "user", content: "hi" }]);
    expect(patched).toBeDefined();
    expect(patched!.messages).toHaveLength(2);
    const notice = patched!.messages[1];
    expect(notice.role).toBe("harness");
    expect(notice.source).toBe("harness");
    const part = notice.content[0];
    expect(part.type).toBe("system-notice");
    expect(part.text).toContain("Loop detected");
    expect(part.text).toContain("read");
    // Persisted into the context (session log records it via CONTEXT_MESSAGE).
    expect(agent.getAdded()).toHaveLength(1);

    // Consumed: the next request carries no second nudge.
    expect(contextOf(ext, agent, [])).toBeUndefined();
    expect(agent.getAdded()).toHaveLength(1);
  });

  it("the second nudge is the stronger one", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();

    for (let i = 0; i < 6; i++) await feed(ext, agent, "read");
    const patched = contextOf(ext, agent, [{ role: "user", content: "hi" }]);
    expect(patched!.messages[1].content[0].text).toContain("Loop warning");
  });

  it("cancels the run at 3x the threshold and tells the user", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    for (let i = 0; i < 8; i++) await feed(ext, agent, "read");
    expect(agent.cancelled).toBe(false);

    await feed(ext, agent, "read");
    expect(agent.cancelled).toBe(true);
    expect(detections[detections.length - 1]).toMatchObject({ streak: 9, level: 3 });

    const stop = agent.getEmitted().find((e) => e.type === "command_result");
    expect(stop).toBeDefined();
    expect(stop!.content).toContain("Loop detector");
    expect(stop!.content).toContain("Run stopped");
  });

  it("detects ping-pong", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    await feed(ext, agent, "read", '{"p":"x"}');
    await feed(ext, agent, "bash", '{"command":"ls"}');
    await feed(ext, agent, "read", '{"p":"x"}');
    expect(detections).toHaveLength(0);
    await feed(ext, agent, "bash", '{"command":"ls"}');
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ kind: "ping_pong", streak: 4, level: 1 });
  });

  it("resetting the streak restarts the ladder from the first nudge", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    for (let i = 0; i < 4; i++) await feed(ext, agent, "read"); // level 1 fired
    expect(detections).toHaveLength(1);

    await feed(ext, agent, "bash", '{"command":"echo hi"}'); // tail no longer loops
    expect(detections).toHaveLength(1);

    // Fresh spin: nothing before streak 3 again, and it fires at LEVEL 1.
    await feed(ext, agent, "read");
    await feed(ext, agent, "read");
    expect(detections).toHaveLength(1);
    await feed(ext, agent, "read");
    expect(detections).toHaveLength(2);
    expect(detections[1]).toMatchObject({ level: 1, streak: 3 });
  });

  it("keeps per-session state isolated", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const a = createMockAgent("session-a");
    const b = createMockAgent("session-b");
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    await feed(ext, a, "read");
    await feed(ext, b, "read");
    await feed(ext, a, "read");
    await feed(ext, b, "read");
    expect(detections).toHaveLength(0); // 2 each, threshold is 3

    await feed(ext, a, "read");
    expect(detections).toHaveLength(1); // a hits 3, b sits at 2
  });

  it("drops state when the context is replaced (compaction, rewind, /clear)", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    await feed(ext, agent, "read");
    await feed(ext, agent, "read");
    hook(ext, HOOKS.CONTEXT_REPLACED)({ agent, oldContext: [], newContext: [] });

    await feed(ext, agent, "read");
    await feed(ext, agent, "read");
    expect(detections).toHaveLength(0); // history was cleared; streak restarts
    await feed(ext, agent, "read");
    expect(detections).toHaveLength(1);
  });

  it("drops state on session end", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent("gone");
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    await feed(ext, agent, "read");
    await feed(ext, agent, "read");
    hook(ext, HOOKS.SESSION_END)({ sessionId: "gone" });

    await feed(ext, agent, "read");
    expect(detections).toHaveLength(0);
  });

  it("ignores tool results while restoring a session", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    agent.isRestoring = true;

    for (let i = 0; i < 5; i++) await feed(ext, agent, "read");
    expect(contextOf(ext, agent, [])).toBeUndefined();
    expect(agent.cancelled).toBe(false);
  });

  it("honors a configured threshold", async () => {
    const core = createMockCore({ loopDetect: { enabled: true, repeatThreshold: 2, pingPongThreshold: 4 } });
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    await feed(ext, agent, "read");
    await feed(ext, agent, "read");
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ level: 1, streak: 2 });
  });

  it("polling with changing output never fires, even far past the stop band", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    // Same tool, same args, 12 > 3t times -- but each result differs: progress, not a spin.
    for (let i = 0; i < 12; i++) {
      await feed(ext, agent, "bash", '{"command":"curl status"}', `tick ${i}`);
    }
    expect(detections).toHaveLength(0);
    expect(agent.cancelled).toBe(false);
    expect(contextOf(ext, agent, [])).toBeUndefined();
  });

  it("a success flip with identical args resets the episode", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    await feed(ext, agent, "bash", '{"command":"make"}', "fail", false);
    await feed(ext, agent, "bash", '{"command":"make"}', "fail", false);
    await feed(ext, agent, "bash", '{"command":"make"}', "ok", true); // error->success: new signature
    await feed(ext, agent, "bash", '{"command":"make"}', "ok", true);
    expect(detections).toHaveLength(0); // the flip broke the streak: run is 2, not 4
    await feed(ext, agent, "bash", '{"command":"make"}', "ok", true);
    expect(detections).toHaveLength(1); // fresh ladder starts at level 1
    expect(detections[0]).toMatchObject({ level: 1, streak: 3 });
  });

  it("ping-pong with changing outputs does not fire", async () => {
    const core = createMockCore();
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    for (let i = 0; i < 6; i++) {
      await feed(ext, agent, "read", '{"p":"x"}', `read ${i}`);
      await feed(ext, agent, "bash", '{"command":"ls"}', `ls ${i}`);
    }
    expect(detections).toHaveLength(0);
    expect(agent.cancelled).toBe(false);
  });
});
