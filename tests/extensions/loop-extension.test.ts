import { describe, it, expect } from "bun:test";
import { create as createLoopExtension } from "@extensions/loop/index.ts";
import { create as createHandoffExtension, HandoffTool } from "@extensions/handoff-tool/index.ts";
import { HookSystem, HOOKS } from "@core/hooks.ts";
import { createCommandRegistry } from "@core/extensions/registries.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";
import { ACTIONS } from "@core/commands.ts";
import type { Agent } from "@core/agent.ts";

// ── Helpers ────────────────────────────────────────────────────────────────

// Mirrors the per-notify claim closure core builds in _emitTurnEnd: first
// caller wins, later callers lose.
function makeClaimTurn(): () => boolean {
  let claimed = false;
  return () => {
    if (claimed) return false;
    claimed = true;
    return true;
  };
}

function createMockCore(config: Record<string, unknown> = {}) {
  return {
    hooks: new HookSystem(),
    config: config.coreConfig || {},
    resolved: {},
    toolRegistry: { getAll: () => [], register: () => {}, has: () => false, remove: () => {} },
    extensions: { get: () => undefined },
  } as any;
}

function createMockAgent(sessionId?: string) {
  const enqueued: string[] = [];
  const emitted: Array<{ type: string; content?: string }> = [];
  let _cancelled = false;
  let contextCleared = false;

  return {
    sessionId,
    get cancelled() { return _cancelled; },
    set cancelled(v: boolean) { _cancelled = v; },
    clearContext: async () => { contextCleared = true; },
    wasContextCleared: () => contextCleared,
    enqueue: (text: string) => enqueued.push(text),
    getEnqueued: () => [...enqueued],
    getTokenUsage: () => ({
      sessionPromptTokens: 0, sessionCachedTokens: 0, sessionCompletionTokens: 0, sessionTotalTokens: 0,
      turns: 0, promptTokens: 0, cachedTokens: 0,
      completionTokens: 0, totalTokens: 0,
    }),
    hideTools: false,
    hideThinking: false,
    systemPrompt: null,
    reasoningEffort: undefined,
    ensureSystemPrompt: async () => {},
    emitOutput: (type: string, data: Record<string, unknown>) => {
      emitted.push({ type, content: (data.content as string) ?? "" });
    },
    getEmitted: () => [...emitted],
  };
}

/** Build a minimal TURN_END hook payload for testing. */
function turnEndPayload(opts: {
  stopped?: boolean;
  cancelled?: boolean;
  agent?: any;
  reason?: "completion" | "tool_return" | "continue" | "cancelled" | "error" | "max_iterations";
  toolResults?: Array<{ toolName: string; input: string; content: string }>;
  claimTurn?: () => boolean;
} = {}) {
  return {
    turnIndex: 0,
    message: "",
    toolResults: opts.toolResults ?? [] as Array<{ toolName: string; input: string; content: string }>,
    stopped: opts.stopped ?? true,
    cancelled: opts.cancelled,
    reason: opts.reason,
    agent: opts.agent,
    claimTurn: opts.claimTurn,
  };
}

/** Build a minimal INPUT hook payload for testing. */
function inputPayload(text: string, agent?: any) {
  return {
    text,
    agent,
  };
}

describe("Loop extension", () => {
  describe("create()", () => {
    it("registers /loop command via COMMANDS_REGISTER hook", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      expect(registry.has("loop")).toBe(true);
    });

    it("/loop command matches 'loop' and 'loop <prompt>'", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);

      const def = registry.get("loop")!;
      expect(def.matches!("loop")).toBe(true);
      expect(def.matches!("loop hello world")).toBe(true);
      expect(def.matches!("looping")).toBe(false);
      expect(def.matches!("loops")).toBe(false);
    });

    it("does not register hooks when disabled", () => {
      const core = createMockCore({
        coreConfig: { loop: { enabled: false } },
      });
      const ext = createLoopExtension(core);
      expect(ext.hooks).toBeUndefined();
    });
  });

  describe("/loop command handler", () => {
    it("enqueues the prompt and initializes loop state", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      const result = await def.handler!(agent as unknown as Agent, "loop write a poem");

      expect((result as any).action).toBe(ACTIONS.DISPLAY);
      expect(agent.getEnqueued()).toContain("write a poem");

      // Check that start message was emitted
      const emitted = agent.getEmitted();
      const startEvent = emitted.find((e: any) =>
        e.content?.includes("Starting loop"),
      );
      expect(startEvent).toBeDefined();
      expect(startEvent!.content).toContain("write a poem");
    });

    it("returns usage error for empty prompt", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      const result = await def.handler!(agent as unknown as Agent, "loop");

      expect((result as any).action).toBe(ACTIONS.DISPLAY);
      expect((result as any).content).toContain("Usage:");
      expect(agent.getEnqueued()).toHaveLength(0);
    });
  });

  describe("TURN_END hook — loop re-enqueue", () => {
    it("re-enqueues the prompt when stopped and loop is active", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      // Start the loop
      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test prompt");

      // Simulate TURN_END with stopped: true
      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any }));

      // Should have re-enqueued the prompt
      const enqueued = agent.getEnqueued();
      expect(enqueued).toContain("test prompt");
      expect(enqueued.filter((t: string) => t === "test prompt")).toHaveLength(2); // initial + re-enqueue

      // Context should be cleared
      expect(agent.wasContextCleared()).toBe(true);
    });

    it("does not re-enqueue when stopped is false", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const enqueuedBefore = agent.getEnqueued().length;

      // TURN_END with stopped: false — should not re-enqueue
      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: false, agent: agent as any }));

      expect(agent.getEnqueued().length).toBe(enqueuedBefore);
    });

    it("emits loop iteration markers", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any }));

      const emitted = agent.getEmitted();
      expect(emitted.find((e: any) => e.content?.includes("==== Loop 1 ===="))).toBeDefined();
      expect(emitted.find((e: any) => e.content?.includes("Loop 1 complete"))).toBeDefined();
    });

    it("stops on agent cancellation", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      // Simulate cancellation
      agent.cancelled = true;

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, cancelled: true, agent: agent as any }));

      // Should emit summary with cancelled reason
      const emitted = agent.getEmitted();
      const summary = emitted.find((e: any) => e.content?.includes("Loop ended"));
      expect(summary).toBeDefined();
      expect(summary!.content).toContain("cancelled by user");

      // Should NOT have re-enqueued
      const enqueued = agent.getEnqueued();
      expect(enqueued.filter((t: string) => t === "test")).toHaveLength(1); // only initial
    });

    it("stops on cancelled flag in TURN_END payload", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      // Simulate TURN_END from agent's finally block on Ctrl+C
      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, cancelled: true, agent: agent as any }));

      const emitted = agent.getEmitted();
      const summary = emitted.find((e: any) => e.content?.includes("Loop ended"));
      expect(summary).toBeDefined();
      expect(summary!.content).toContain("cancelled by user");
      expect(summary!.content).toMatch(/\d+\.\d+s/);
    });

    it("respects maxLoops config", async () => {
      const core = createMockCore({
        coreConfig: { loop: { maxLoops: 2 } },
      });
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;

      // First iteration
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any }));
      // Second iteration
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any }));
      // Third call — should hit max and stop
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any }));

      const emitted = agent.getEmitted();
      expect(emitted.find((e: any) => e.content?.includes("Max loops (2) reached"))).toBeDefined();
    });

    it("handles clearContext failure gracefully", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      agent.clearContext = async () => { throw new Error("clear failed"); };

      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any }));

      const emitted = agent.getEmitted();
      expect(emitted.find((e: any) => e.content?.includes("failed to clear context"))).toBeDefined();
    });

    it("does not re-enqueue on error or max_iterations turn-end", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;

      // An errored run (reason: 'error') is not a completed turn — stop without re-enqueue
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any, reason: "error" }));

      const enqueued = agent.getEnqueued();
      expect(enqueued.filter((t: string) => t === "test")).toHaveLength(1); // only initial

      // Loop should emit a summary and stop
      const emitted = agent.getEmitted();
      expect(emitted.find((e: any) => e.content?.includes("Loop ended"))).toBeDefined();
    });
  });

  describe("INPUT hook — /quit during loop", () => {
    it("intercepts /quit during active loop", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      // Start the loop
      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      // Simulate /quit input
      const inputHook = ext.hooks![HOOKS.INPUT]!;
      const result = inputHook(inputPayload("/quit", agent));

      expect((result as any)?.action).toBe("handled");

      // Loop should be stopped — verify via TURN_END not re-enqueuing
      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any }));

      const enqueued = agent.getEnqueued();
      expect(enqueued.filter((t: string) => t === "test")).toHaveLength(1); // only initial
    });

    it("intercepts /exit during active loop", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const inputHook = ext.hooks![HOOKS.INPUT]!;
      const result = inputHook(inputPayload("/exit", agent));

      expect((result as any)?.action).toBe("handled");
    });

    it("does not intercept regular input during loop", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const inputHook = ext.hooks![HOOKS.INPUT]!;
      const result = inputHook(inputPayload("hello world", agent));

      expect(result).toBeUndefined();
    });

    it("does not intercept when loop is not active", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const inputHook = ext.hooks![HOOKS.INPUT]!;
      const result = inputHook(inputPayload("/quit", agent));

      expect(result).toBeUndefined();
    });

    it("emits summary on /quit", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      // Simulate one iteration completing
      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any }));

      // Now quit
      const inputHook = ext.hooks![HOOKS.INPUT]!;
      inputHook(inputPayload("/quit", agent));

      const emitted = agent.getEmitted();
      const summary = emitted.find((e: any) => e.content?.includes("Loop ended"));
      expect(summary).toBeDefined();
      expect(summary!.content).toContain("cancelled by user");
      expect(summary!.content).toMatch(/\d+\.\d+s/);
    });
  });

  describe("per-session loop state", () => {
    it("keeps independent loops for different sessions", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agentA = createMockAgent("session-a");
      const agentB = createMockAgent("session-b");
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent: agentA } as any);

      const def = registry.get("loop")!;
      await def.handler!(agentA as unknown as Agent, "loop prompt-a");
      await def.handler!(agentB as unknown as Agent, "loop prompt-b");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;

      // Session A completes a turn: only A should re-enqueue its own prompt.
      await turnEndHook(turnEndPayload({ stopped: true, agent: agentA as any }));

      expect(agentA.getEnqueued().filter((t: string) => t === "prompt-a")).toHaveLength(2); // initial + re-enqueue
      expect(agentB.getEnqueued()).toEqual(["prompt-b"]); // untouched

      // Session B completes a turn: only B re-enqueues.
      await turnEndHook(turnEndPayload({ stopped: true, agent: agentB as any }));

      expect(agentA.getEnqueued().filter((t: string) => t === "prompt-a")).toHaveLength(2);
      expect(agentB.getEnqueued().filter((t: string) => t === "prompt-b")).toHaveLength(2);
    });

    it("ignores TURN_END from a session with no active loop", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agentA = createMockAgent("session-a");
      const agentB = createMockAgent("session-b");
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent: agentA } as any);

      const def = registry.get("loop")!;
      await def.handler!(agentA as unknown as Agent, "loop prompt-a");

      // Session B never started a loop — its turn end must not touch A's loop.
      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, agent: agentB as any }));

      expect(agentA.getEnqueued().filter((t: string) => t === "prompt-a")).toHaveLength(1); // only initial
      const emitted = agentA.getEmitted();
      expect(emitted.find((e: any) => e.content?.includes("==== Loop 1 ===="))).toBeUndefined();
    });

    it("/quit in one session does not stop another session's loop", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agentA = createMockAgent("session-a");
      const agentB = createMockAgent("session-b");
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent: agentA } as any);

      const def = registry.get("loop")!;
      await def.handler!(agentA as unknown as Agent, "loop prompt-a");
      await def.handler!(agentB as unknown as Agent, "loop prompt-b");

      // /quit from session B only stops B.
      const inputHook = ext.hooks![HOOKS.INPUT]!;
      expect((inputHook(inputPayload("/quit", agentB)) as any)?.action).toBe("handled");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, agent: agentA as any }));

      // A's loop is still alive and re-enqueued.
      expect(agentA.getEnqueued().filter((t: string) => t === "prompt-a")).toHaveLength(2);
      const emittedB = agentB.getEmitted();
      expect(emittedB.find((e: any) => e.content?.includes("Loop ended"))).toBeDefined();
    });

    it("re-running /loop on the same session restarts its loop", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent("session-a");
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop first");
      await def.handler!(agent as unknown as Agent, "loop second");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      await turnEndHook(turnEndPayload({ stopped: true, agent: agent as any }));

      // Only the latest prompt is active.
      expect(agent.getEnqueued().filter((t: string) => t === "second")).toHaveLength(2);
      expect(agent.getEnqueued().filter((t: string) => t === "first")).toHaveLength(1);
    });
  });

  describe("TURN_END hook — turn claim takes priority", () => {
    it("defers the re-enqueue when another handler claimed the turn", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      // Simulate another handler (e.g. handoff) claiming first.
      const claimTurn = makeClaimTurn();
      expect(claimTurn()).toBe(true);
      await turnEndHook(
        turnEndPayload({
          stopped: true,
          reason: "tool_return",
          toolResults: [{ toolName: "handoff", input: "{}", content: "Handoff prepared." }],
          claimTurn,
          agent: agent as any,
        }),
      );

      // The loop prompt must not pile on top of the claimer's own enqueue.
      expect(agent.getEnqueued()).toHaveLength(1); // only the initial /loop prompt
      // The claiming handler owns the context clear for this turn.
      expect(agent.wasContextCleared()).toBe(false);

      const emitted = agent.getEmitted();
      expect(emitted.find((e: any) => e.content?.includes("resumes after its run"))).toBeDefined();
      expect(emitted.find((e: any) => e.content?.includes("==== Loop 1 ===="))).toBeUndefined();
    });

    it("claims the turn when it re-enqueues", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      const claimTurn = makeClaimTurn();
      await turnEndHook(turnEndPayload({ stopped: true, reason: "completion", claimTurn, agent: agent as any }));

      expect(agent.getEnqueued()).toHaveLength(2); // initial + Loop 1
      // The loop took the claim — a later handler loses.
      expect(claimTurn()).toBe(false);
    });

    it("resumes the loop after the claimed run completes", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      const firstClaim = makeClaimTurn();
      firstClaim(); // another handler owns this turn
      await turnEndHook(
        turnEndPayload({ stopped: true, reason: "tool_return", claimTurn: firstClaim, agent: agent as any }),
      );
      // The other run finishes — a normal turn end, unclaimed.
      await turnEndHook(
        turnEndPayload({ stopped: true, reason: "completion", claimTurn: makeClaimTurn(), agent: agent as any }),
      );

      expect(agent.getEnqueued().filter((t: string) => t === "test")).toHaveLength(2); // initial + resume
      const emitted = agent.getEmitted();
      expect(emitted.find((e: any) => e.content?.includes("==== Loop 1 ===="))).toBeDefined();
    });

    it("does not count the claimed turn against maxLoops", async () => {
      const core = createMockCore({ coreConfig: { loop: { maxLoops: 1 } } });
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      // Claimed turn: deferred, budget untouched.
      const firstClaim = makeClaimTurn();
      firstClaim();
      await turnEndHook(
        turnEndPayload({ stopped: true, reason: "tool_return", claimTurn: firstClaim, agent: agent as any }),
      );
      // The claimer's run's turn end: consumes the single allowed iteration.
      await turnEndHook(
        turnEndPayload({ stopped: true, reason: "completion", claimTurn: makeClaimTurn(), agent: agent as any }),
      );
      // Next turn end: max reached, loop stops.
      await turnEndHook(
        turnEndPayload({ stopped: true, reason: "completion", claimTurn: makeClaimTurn(), agent: agent as any }),
      );

      expect(agent.getEnqueued().filter((t: string) => t === "test")).toHaveLength(2); // initial + one iteration
      const emitted = agent.getEmitted();
      expect(emitted.find((e: any) => e.content?.includes("Max loops (1) reached"))).toBeDefined();
    });

    it("still stops on cancellation even when the turn is claimed", async () => {
      const core = createMockCore();
      const ext = createLoopExtension(core);

      const registry = createCommandRegistry();
      const agent = createMockAgent();
      await ext.hooks![HOOKS.COMMANDS_REGISTER]!({ registry, agent } as any);

      const def = registry.get("loop")!;
      await def.handler!(agent as unknown as Agent, "loop test");

      const turnEndHook = ext.hooks![HOOKS.TURN_END]!;
      const claimTurn = makeClaimTurn();
      claimTurn();
      await turnEndHook(
        turnEndPayload({ stopped: true, cancelled: true, claimTurn, agent: agent as any }),
      );

      const emitted = agent.getEmitted();
      expect(emitted.find((e: any) => e.content?.includes("Loop ended"))).toBeDefined();
      expect(agent.getEnqueued()).toHaveLength(1); // only the initial prompt
    });
  });

  describe("loop + handoff extensions together", () => {
    it("handoff enqueues its plan exactly once; the loop resumes after the handoff run", async () => {
      const core = createMockCore({
        coreConfig: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
      });
      const loopExt = createLoopExtension(core);
      const handoffExt = createHandoffExtension(core);

      const hooks = core.hooks as HookSystem;
      hooks.on(HOOKS.TURN_END, loopExt.hooks![HOOKS.TURN_END]! as any);
      // Registered the way the loader does it: handoff declares a higher
      // hookPriorities entry so it claims before the loop checks.
      hooks.on(HOOKS.TURN_END, handoffExt.hooks![HOOKS.TURN_END]! as any, {
        source: "handoff",
        priority: handoffExt.hookPriorities?.[HOOKS.TURN_END] ?? 0,
      });

      const registry = createCommandRegistry();
      await loopExt.hooks![HOOKS.COMMANDS_REGISTER]!({ registry } as any);
      const registeredTools: Array<[string, HandoffTool]> = [];
      await (handoffExt.hooks![HOOKS.TOOLS_REGISTER] as Function)({
        register: (name: string, tool: HandoffTool) => registeredTools.push([name, tool]),
      });

      const agent = createMockAgent("session-a");
      (agent as any).config = {};

      // /loop starts, then mid-run the agent calls the handoff tool.
      await registry.get("loop")!.handler!(agent as unknown as Agent, "loop tick");
      const ctx = new ToolContext();
      ctx.set("agent", agent);
      await registeredTools[0]![1].execute(JSON.stringify({ content: "the plan" }), ctx);

      const basePayload = {
        turnIndex: 0,
        message: "",
        stopped: true,
        agent,
      };
      await hooks.notifyHooks(HOOKS.TURN_END, {
        ...basePayload,
        reason: "tool_return",
        toolResults: [{ toolName: "handoff", input: "{}", content: "Handoff prepared." }],
        claimTurn: makeClaimTurn(),
      } as any);

      // Queue so far: the initial /loop prompt (the turn being interrupted
      // by the handoff). Only the handoff plan is added on top — no second
      // loop prompt.
      const enqueued = agent.getEnqueued();
      expect(enqueued).toHaveLength(2);
      expect(enqueued[0]).toBe("tick");
      expect(enqueued[1]).toContain("the plan");

      // The handoff run completes: the loop re-enqueues its prompt.
      await hooks.notifyHooks(HOOKS.TURN_END, {
        ...basePayload,
        reason: "completion",
        toolResults: [],
        claimTurn: makeClaimTurn(),
      } as any);

      const afterResume = agent.getEnqueued();
      expect(afterResume).toHaveLength(3);
      expect(afterResume[2]).toBe("tick");
    });
  });
});
