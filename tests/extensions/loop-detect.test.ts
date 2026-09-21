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
    config,
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

function feed(ext: { hooks?: unknown }, agent: ReturnType<typeof createMockAgent>, toolName: string, input = "{}") {
  return hook(ext, HOOKS.TOOL_RESULT)({
    toolCallId: "tc",
    toolName,
    input,
    success: true,
    result: "ok",
    agent,
  });
}

function contextOf(ext: { hooks?: unknown }, agent: ReturnType<typeof createMockAgent>, messages: any[] = []) {
  return hook(ext, HOOKS.CONTEXT)({ messages, agent }) as { messages: any[] } | undefined;
}

describe("loop-detect extension", () => {
  it("returns no hooks when disabled", () => {
    const ext = createLoopDetect(createMockCore({ loopDetect: { enabled: false } }));
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
    const core = createMockCore({ loopDetect: { repeatThreshold: 2 } });
    const ext = createLoopDetect(core);
    const agent = createMockAgent();
    const detections: any[] = [];
    core.hooks.on(HOOKS.LOOP_DETECTED, ((p: any) => detections.push(p)) as any);

    await feed(ext, agent, "read");
    await feed(ext, agent, "read");
    expect(detections).toHaveLength(1);
    expect(detections[0]).toMatchObject({ level: 1, streak: 2 });
  });
});
