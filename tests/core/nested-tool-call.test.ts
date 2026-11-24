// Nested tool-call dispatch: one call through the real executor pipeline,
// finalized by returning to the caller instead of appending to the
// conversation, attributed as "<parentCallId>/<n>" on events and hook payloads.

import { describe, it, expect } from "bun:test";
import { createToolExecutor, type ToolExecutorDeps } from "@core/tool-executor.ts";
import { createToolRegistry, type ToolRegistry } from "@core/extensions/tool-registry.ts";
import { createHooks, HOOKS, type HookSystem } from "@core/hooks.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";
import type { Agent } from "@core/agent.ts";
import type { Message } from "@core/context/message.ts";
import type { ToolDef } from "@core/extensions/tool-registry.ts";
import type { ToolExecLink } from "@core/tool-exec-protocol.ts";
import type { HookPayloads } from "@core/extensions/types.ts";
import { createFixture, MockLLMClient, buildStreamResponse, simpleTool, MockTool } from "../helpers.ts";
import { expectCompletion } from "../test-helpers.ts";
import { toolContentText } from "@utils/tool-content.ts";

function text(content: string | Array<unknown> | null | undefined): string {
  return toolContentText(content);
}

function baseDeps(
  toolRegistry: ToolRegistry,
  hooks: HookSystem,
  events: Array<Record<string, unknown>>,
  addedMessages: Message[],
): ToolExecutorDeps {
  const agent = {
    sessionId: "nested-test",
    addMessage: (msg: Message) => {
      addedMessages.push(msg);
    },
    getToolDefs: async (): Promise<ToolDef[]> =>
      Array.from(toolRegistry.tools.keys()).map((name) => ({
        type: "function",
        function: { name, description: "", parameters: { type: "object", properties: {}, required: [] } },
      })),
  } as unknown as Agent;
  return {
    toolRegistry,
    hooks,
    emitOutput: (type, data) => {
      events.push({ type, ...data });
    },
    workspaceRoots: null,
    workspaceDeny: null,
    maxRetries: 0,
    toolRetryDelay: 0,
    isRestoring: () => false,
    agent,
  };
}

/** Standalone executor over a fake agent (caps, gates, events fully observable). */
function makeHarness(overrides: Partial<ToolExecutorDeps> = {}) {
  const toolRegistry = createToolRegistry();
  const hooks = createHooks();
  const events: Array<Record<string, unknown>> = [];
  const addedMessages: Message[] = [];
  const executor = createToolExecutor({
    ...baseDeps(toolRegistry, hooks, events, addedMessages),
    ...overrides,
  });
  return { executor, toolRegistry, hooks, events, addedMessages };
}

/** Executor wired to a real fixture agent (policy filtering, context, mounts). */
function executorForFixture(agent: Agent, hooks: HookSystem, toolRegistry: ToolRegistry) {
  return createToolExecutor({
    ...baseDeps(toolRegistry, hooks, [], []),
    agent,
  });
}

describe("nested tool calls (D1 dispatcher)", () => {
  it("gate block: the inner tool never executes and the entry answers ok:false", async () => {
    const h = makeHarness();
    const inner = new MockTool({ name: "inner", execute: async () => "ran" });
    h.toolRegistry.register("inner", inner);
    h.hooks.on(HOOKS.TOOL_CALL, () => ({ action: "block" as const, result: "denied by policy" }));

    const res = await h.executor.executeToolCall("inner", {}, { parentToolCallId: "parent-1" });

    expect(res.ok).toBe(false);
    expect(res.output).toContain("denied by policy");
    expect(res.error).toBeTruthy();
    expect(inner.executeCount).toBe(0);
    expect(h.addedMessages.length).toBe(0);
  });

  it("gate handler and output events carry parentToolCallId and the inner id", async () => {
    const h = makeHarness();
    h.toolRegistry.register(
      "inner",
      new MockTool({ name: "inner", execute: async () => "ok-out" }),
    );
    const seen: { gate?: HookPayloads["tool:call"] } = {};
    h.hooks.on(HOOKS.TOOL_CALL, (p) => {
      seen.gate = p;
    });

    const res = await h.executor.executeToolCall("inner", { a: 1 }, { parentToolCallId: "parent-1" });

    expect(res.ok).toBe(true);
    expect(seen.gate).toBeTruthy();
    expect(seen.gate!.parentToolCallId).toBe("parent-1");
    expect(seen.gate!.toolCallId).toBe("parent-1/1");
    expect(seen.gate!.input).toBe('{"a":1}');

    const callEvent = h.events.find((e) => e.type === "tool_call");
    expect(callEvent).toBeTruthy();
    expect(callEvent!.parentToolCallId).toBe("parent-1");
    expect(callEvent!.toolCallId).toBe("parent-1/1");
    const resultEvent = h.events.find((e) => e.type === "tool_result");
    expect(resultEvent).toBeTruthy();
    expect(resultEvent!.parentToolCallId).toBe("parent-1");
    expect(resultEvent!.toolCallId).toBe("parent-1/1");
  });

  it("returns the finalized result to the caller and appends nothing to the conversation", async () => {
    const { agent, hooks, toolRegistry } = createFixture();
    toolRegistry.register("inner", simpleTool("inner", "inner-result"));
    const executor = executorForFixture(agent, hooks, toolRegistry);
    let contextMessages = 0;
    hooks.on(HOOKS.CONTEXT_MESSAGE, () => {
      contextMessages++;
    });

    const before = agent.context.log.getAll().length;
    const res = await executor.executeToolCall("inner", null, { parentToolCallId: "parent-3" });

    expect(res.ok).toBe(true);
    expect(res.output).toBe("inner-result");
    expect(agent.context.log.getAll().length).toBe(before);
    expect(contextMessages).toBe(0);
  });

  it("maxToolResultChars applies to the inner output", async () => {
    const h = makeHarness({ maxToolResultChars: 200 });
    h.toolRegistry.register(
      "big",
      new MockTool({ name: "big", execute: async () => "x".repeat(1000) }),
    );

    const res = await h.executor.executeToolCall("big", {});

    expect(res.ok).toBe(true);
    expect(res.output.length).toBeLessThanOrEqual(200);
    expect(res.output).toContain("output truncated");
    expect(res.output).toContain("x".repeat(100));
  });

  it("TOOL_BEFORE_EXECUTE fires with the inner id", async () => {
    const h = makeHarness();
    h.toolRegistry.register("inner", new MockTool({ name: "inner" }));
    const ids: string[] = [];
    const parents: Array<string | undefined> = [];
    h.hooks.on(HOOKS.TOOL_BEFORE_EXECUTE, (p) => {
      ids.push(p.toolCallId);
      parents.push(p.parentToolCallId);
    });

    await h.executor.executeToolCall("inner", {}, { parentToolCallId: "parent-5" });
    await h.executor.executeToolCall("inner", {}, { parentToolCallId: "parent-5" });

    expect(ids).toEqual(["parent-5/1", "parent-5/2"]);
    expect(parents).toEqual(["parent-5", "parent-5"]);
  });

  it("unavailable name answers ok:false with the availability message and nothing executes", async () => {
    const h = makeHarness();

    const res = await h.executor.executeToolCall("ghost_tool", {}, { parentToolCallId: "parent-6" });

    expect(res.ok).toBe(false);
    expect(res.output).toContain("'ghost_tool' is not available for this agent");
    expect(h.addedMessages.length).toBe(0);
  });

  it("plane-tagged tool still forks to the worker plane", async () => {
    const invocations: Array<Record<string, unknown>> = [];
    // Fake link: pins the fork point itself, no pool.
    const link = {
      invoke: async (req: { tool: string; toolCallId?: string }) => {
        invocations.push(req as unknown as Record<string, unknown>);
        return { kind: "value" as const, value: "from-plane" };
      },
    } as unknown as ToolExecLink;
    const local = new MockTool({
      name: "wg",
      metadata: { sideEffects: false, difficulty: 1, execution: "worker" },
      execute: async () => "inline-ran",
    });
    const h = makeHarness({ toolExec: "worker", toolExecLink: link });
    h.toolRegistry.register("wg", local);

    const res = await h.executor.executeToolCall("wg", { q: 1 }, { parentToolCallId: "parent-7" });

    expect(local.executeCount).toBe(0);
    expect(invocations.length).toBe(1);
    expect(invocations[0]!.tool).toBe("wg");
    expect(invocations[0]!.toolCallId).toBe("parent-7/1");
    expect(res.ok).toBe(true);
    expect(res.output).toBe("from-plane");
  });

  it("PROVIDER_REQUEST-filtered name: the model-side call bounces, the nested dispatch executes", async () => {
    const secret = simpleTool("secret_tool", "secret result");
    const relay = new MockTool({
      name: "relay",
      execute: async (_input, ctx) => {
        const dispatch = (ctx as ToolContext).get("executeToolCall");
        if (typeof dispatch !== "function") return "nested dispatch MISSING";
        const r = await dispatch("secret_tool", {});
        return `nested:${JSON.stringify(r)}`;
      },
    });
    const mockLLM = new MockLLMClient({
      responseSequences: [
        buildStreamResponse({
          content: "relaying",
          toolCalls: [{ index: 0, name: "relay", arguments: "{}", id: "call_relay" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        buildStreamResponse({
          content: "asking directly",
          toolCalls: [{ index: 0, name: "secret_tool", arguments: "{}", id: "call_direct" }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }),
        buildStreamResponse({
          content: "done",
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        }),
      ],
    });

    const { agent, toolRegistry, hooks } = createFixture({ mockLLM });
    toolRegistry.register("secret_tool", secret);
    toolRegistry.register("relay", relay);

    // A request-layer hook removes secret_tool from the wire defs: the
    // model-side call must bounce ("not available", never executes), while
    // the same name through the nested entry runs -- nested availability
    // derives from agent.getToolDefs(), never the post-PROVIDER_REQUEST set.
    hooks.on(HOOKS.PROVIDER_REQUEST, ({ toolDefs }) => ({
      toolDefs: toolDefs.filter((d) => d.function.name !== "secret_tool"),
    }));

    const result = await agent.run("go");
    expect(expectCompletion(result).content).toBe("done");
    expect(secret.executeCount).toBe(1);

    const toolMsgs = agent.context.log.getAll().filter((m) => m.role === "tool");
    expect(toolMsgs.length).toBe(2);
    expect(text(toolMsgs[0]!.content)).toContain('"ok":true');
    expect(text(toolMsgs[0]!.content)).toContain("secret result");
    expect(text(toolMsgs[1]!.content)).toContain("not available");
  });

  it("a throwing TOOL_CALL handler fails closed: ok:false, no execution, no throw", async () => {
    const h = makeHarness();
    const inner = new MockTool({ name: "inner", execute: async () => "ran" });
    h.toolRegistry.register("inner", inner);
    h.hooks.on(HOOKS.TOOL_CALL, () => {
      throw new Error("gate exploded");
    });

    const res = await h.executor.executeToolCall("inner", {}, { parentToolCallId: "parent-9" });

    expect(res.ok).toBe(false);
    expect(res.error).toContain("gate exploded");
    expect(inner.executeCount).toBe(0);
    expect(h.addedMessages.length).toBe(0);
  });

  it("inner call against a sandboxMode-filtered name is refused", async () => {
    const { agent, hooks, toolRegistry } = createFixture({ config: { sandboxMode: true } });
    const danger = simpleTool("danger", "boom", { sideEffects: true, difficulty: 1 });
    toolRegistry.register("danger", danger);
    const executor = executorForFixture(agent, hooks, toolRegistry);

    const res = await executor.executeToolCall("danger", {}, { parentToolCallId: "parent-10" });

    expect(res.ok).toBe(false);
    expect(res.output).toContain("not available");
    expect(danger.executeCount).toBe(0);
  });

  it("abort mid-inner releases the promise", async () => {
    const h = makeHarness();
    h.toolRegistry.register(
      "sleeper",
      new MockTool({
        name: "sleeper",
        execute: (
          _input: string | Record<string, unknown> | null,
          ctx: unknown,
        ) =>
          new Promise<never>((_resolve, reject) => {
            const signal = (ctx as ToolContext).get("abortSignal");
            const timer = setTimeout(() => reject(new Error("timer ran to end")), 5000);
            signal?.addEventListener(
              "abort",
              () => {
                clearTimeout(timer);
                reject(new Error("inner call aborted"));
              },
              { once: true },
            );
          }),
      }),
    );

    const ac = new AbortController();
    const dispatch = h.executor.executeToolCall("sleeper", {}, {
      parentToolCallId: "parent-11",
      signal: ac.signal,
    });
    setTimeout(() => ac.abort(), 20);

    const released = await Promise.race([
      dispatch,
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 3000)),
    ]);

    expect(released).not.toBeNull();
    expect(released!.ok).toBe(false);
    expect(released!.output).toContain("inner call aborted");
  });

  it("the per-parent sequence counter is released at outer finalization (all paths) and stays unique while in flight", async () => {
    const h = makeHarness();
    h.toolRegistry.register("inner", new MockTool({ name: "inner", execute: async () => "ran" }));
    const seq = (h.executor as unknown as { nestedSeq: Map<string, number> }).nestedSeq;
    // relay dispatches two inner calls then optionally throws (error path);
    // it also samples the live counter mid-call (through the test seam)
    // under its own parent id, passed in as an argument.
    const midCounter: Array<number | undefined> = [];
    const parentOf = (input: unknown): string =>
      String((JSON.parse(String(input ?? "{}")) as { parent?: string }).parent ?? "");
    h.toolRegistry.register(
      "relay",
      new MockTool({
        name: "relay",
        execute: async (input, ctx) => {
          const dispatch = (ctx as ToolContext).get("executeToolCall");
          if (typeof dispatch !== "function") return "nested dispatch MISSING";
          await dispatch("inner", {});
          midCounter.push(seq.get(parentOf(input)));
          await dispatch("inner", {});
          return "relayed";
        },
      }),
    );
    const innerIds: string[] = [];
    h.hooks.on(HOOKS.TOOL_BEFORE_EXECUTE, (p) => {
      if (p.toolCallId.includes("/")) innerIds.push(p.toolCallId);
    });

    // Many rounds: each outer call gets its own entry while in flight and
    // leaves nothing behind; without the release the map would accumulate
    // one entry per attribution id for the executor's lifetime.
    for (const outerId of ["live-parent", "outer-2", "outer-3", "outer-4", "outer-5"]) {
      const { toolResults } = await h.executor.execute([
        {
          id: outerId,
          type: "function",
          function: { name: "relay", arguments: JSON.stringify({ parent: outerId }) },
        },
      ]);
      expect(text(toolResults[0]!.content)).toContain("relayed");
      // Finalized (success path): the counter entry left with its call.
      expect(seq.has(outerId)).toBe(false);
    }
    expect(seq.size).toBe(0); // nothing accumulated across the rounds
    expect(midCounter).toEqual([1, 1, 1, 1, 1]); // alive while the parent ran...
    // ...and inner ids chained monotonically under each live parent.
    expect(innerIds).toEqual([
      "live-parent/1", "live-parent/2",
      "outer-2/1", "outer-2/2",
      "outer-3/1", "outer-3/2",
      "outer-4/1", "outer-4/2",
      "outer-5/1", "outer-5/2",
    ]);

    // Error path: the outer call throws AFTER dispatching; its entry is
    // still gone once the call is finalized (with the error result).
    h.toolRegistry.register(
      "thrower",
      new MockTool({
        name: "thrower",
        execute: async (_input, ctx) => {
          const dispatch = (ctx as ToolContext).get("executeToolCall");
          if (typeof dispatch !== "function") return "nested dispatch MISSING";
          await dispatch("inner", {});
          throw new Error("tool exploded mid-call");
        },
      }),
    );
    const { toolResults } = await h.executor.execute([
      { id: "outer-err", type: "function", function: { name: "thrower", arguments: "{}" } },
    ]);
    expect(text(toolResults[0]!.content)).toContain("tool exploded mid-call");
    expect(seq.size).toBe(0); // the error path finalizes too; nothing lingers
  });
});

// Drift pin for the codemode validation-hint soft coupling. The bridge in
// src/experimental/codemode decorates an inner rejection that starts with
// VALIDATION_REJECTION_PREFIX by appending the run's parameter signature
// (the shadowed set means the direct schema is NOT in the model's context,
// so the rejection must carry the parameter names). That matcher lives in
// experimental (its suite pins the constant to this exact literal); the
// emitted shape lives HERE. If core ever rewords the wrapper, the
// decoration detaches (a plain error, never a wrong one), and this is where
// that drift fails loudly.
const CORE_VALIDATION_PREFIX = "Parameter validation error:";

describe("validation rejection shape (codemode hint drift pin)", () => {
  it("the executor answers a bad-args nested call with the exact recognized prefix", async () => {
    const h = makeHarness();
    const writer = new MockTool({
      name: "writer",
      toToolDef: () => ({
        type: "function",
        function: {
          name: "writer",
          description: "writes a file",
          parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
          },
        },
      }),
      execute: async () => "ran",
    });
    h.toolRegistry.register("writer", writer);

    const res = await h.executor.executeToolCall(
      "writer",
      { file_path: "a.ts" },
      { parentToolCallId: "parent-drift" },
    );

    expect(res.ok).toBe(false);
    expect(writer.executeCount).toBe(0); // refused before execution, as before
    // startsWith: the bridge matches with the SAME predicate it decorates on.
    expect(res.error?.startsWith(CORE_VALIDATION_PREFIX)).toBe(true);
    expect(res.output?.startsWith(CORE_VALIDATION_PREFIX)).toBe(true);
    expect(res.error).toContain("path");
  });
});
