// Tests for the handoff tool — plan-execute handoff extension.

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { HandoffTool, create } from "../../src/extensions/handoff-tool/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import { ToolContext } from "../../src/core/extensions/tool-context.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

interface TestPayload {
  content: string;
  title?: string;
  instructions?: string;
  files?: string[];
}

describe("HandoffTool", () => {
  let pending: Map<string, TestPayload>;
  let tool: HandoffTool;

  beforeEach(() => {
    pending = new Map();
    tool = new HandoffTool(pending);
  });

  describe("toToolDef", () => {
    it("has correct name and description", () => {
      const def = tool.toToolDef();
      expect(def.function.name).toBe("handoff");
      expect(def.function.description).toContain("Transition to a new phase");
      expect(def.function.description).toContain("clearing context");
    });

    it("requires content parameter", () => {
      const def = tool.toToolDef();
      expect(def.function.parameters.required).toContain("content");
    });

    it("defines all expected parameters", () => {
      const def = tool.toToolDef();
      const props = def.function.parameters.properties as Record<string, { type: string }>;
      expect(props.content).toEqual(expect.objectContaining({ type: "string" }));
      expect(props.title).toEqual(expect.objectContaining({ type: "string" }));
      expect(props.instructions).toEqual(expect.objectContaining({ type: "string" }));
      expect(props.files).toEqual(expect.objectContaining({ type: "array" }));
    });

    it("defines files as string array", () => {
      const def = tool.toToolDef();
      const filesParam = (def.function.parameters.properties as Record<string, unknown>).files as { items: { type: string } };
      expect(filesParam.items.type).toBe("string");
    });
  });

  describe("callDisplay", () => {
    it("shows title when provided", () => {
      const input = JSON.stringify({
        content: "My plan",
        title: "Implementation Phase",
      });
      expect(tool.callDisplay(input)).toBe("handoff: Implementation Phase");
    });

    it("shows default when no title", () => {
      const input = JSON.stringify({
        content: "My plan",
      });
      expect(tool.callDisplay(input)).toBe("handoff: handoff");
    });

    it("handles empty input with fallback", () => {
      expect(tool.callDisplay("")).toContain("handoff");
    });

    it("handles invalid JSON with fallback", () => {
      expect(tool.callDisplay("not json")).toContain("handoff");
    });
  });

  describe("execute", () => {
    it("stores handoff payload in state", async () => {
      const input = JSON.stringify({
        content: "Implement the feature",
        title: "Execution Phase",
        instructions: "Go step by step",
        files: ["src/main.ts"],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      expect(pending.get("default")).toEqual({
        content: "Implement the feature",
        title: "Execution Phase",
        instructions: "Go step by step",
        files: ["src/main.ts"],
      });
    });

    it("handles minimal input (content only)", async () => {
      const input = JSON.stringify({
        content: "Just the plan",
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      expect(pending.get("default")).toEqual({
        content: "Just the plan",
      });
    });

    it("filters non-string items from files array", async () => {
      const input = JSON.stringify({
        content: "Plan",
        files: ["src/main.ts", 123, null],
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      expect(pending.get("default")?.files).toEqual(["src/main.ts"]);
    });

    it("keys the payload by the agent's session id from the tool context", async () => {
      const ctx = new ToolContext();
      ctx.set("agent", { sessionId: "session-a" });
      const result = await tool.execute(JSON.stringify({ content: "Plan A" }), ctx);
      expect(result.success).toBe(true);
      expect(pending.get("session-a")).toEqual({ content: "Plan A" });
      expect(pending.has("default")).toBe(false);
    });

    it("keeps concurrent sessions' payloads independent", async () => {
      const ctxA = new ToolContext();
      ctxA.set("agent", { sessionId: "session-a" });
      const ctxB = new ToolContext();
      ctxB.set("agent", { sessionId: "session-b" });

      await tool.execute(JSON.stringify({ content: "Plan A" }), ctxA);
      await tool.execute(JSON.stringify({ content: "Plan B" }), ctxB);

      expect(pending.get("session-a")).toEqual({ content: "Plan A" });
      expect(pending.get("session-b")).toEqual({ content: "Plan B" });
    });

    it("returns error for missing content", async () => {
      const input = JSON.stringify({
        title: "No content here",
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(false);
      expect(result.error).toContain("requires a non-empty 'content'");
    });

    it("returns error for empty content", async () => {
      const input = JSON.stringify({
        content: "",
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(false);
    });

    it("returns error for non-string content", async () => {
      const input = JSON.stringify({
        content: 123,
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(false);
    });

    it("returns error for invalid JSON", async () => {
      const result = await tool.execute("not json", null!);
      expect(result.success).toBe(false);
    });

    it("includes handoff_ready status in metadata", async () => {
      const input = JSON.stringify({
        content: "Plan",
        title: "Test",
      });
      const result = await tool.execute(input, null!);
      expect(result.success).toBe(true);
      expect(result.metadata!.get("status")).toBe("handoff_ready");
      expect(result.metadata!.get("title")).toBe("Test");
    });
  });
});

describe("handoff-tool create() extension", () => {
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns extension with all expected hooks", async () => {
    const ext = create({
      config: { handoffTool: {} },
    } as unknown as CoreContext);
    expect(ext).toBeDefined();
    expect(ext.hooks).toBeDefined();
    expect(ext.hooks!['tools:register']).toBeDefined();
    expect(ext.hooks!['turn:end']).toBeDefined();
    expect(ext.HandoffTool).toBe(HandoffTool);
  });

  it("returns empty extension when disabled", async () => {
    const ext = create({
      config: { handoffTool: { enabled: false } },
    } as unknown as CoreContext);
    expect(ext.hooks).toBeUndefined();
  });

  it("registers handoff tool via hook", async () => {
    const ext = create({
      config: { handoffTool: {} },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;
    const registered: Array<[string, unknown]> = [];
    const registry = {
      register: (name: string, tool: unknown) => registered.push([name, tool]),
      getAll: () => [],
    };
    await (hooks[HOOKS.TOOLS_REGISTER] as Function)(registry);
    expect(registered).toHaveLength(1);
    expect(registered[0]![0]).toBe("handoff");
    expect(registered[0]![1]).toBeInstanceOf(HandoffTool);
  });

  it("TURN_END hook clears context and enqueues handoff content", async () => {
    const ext = create({
      config: { handoffTool: {} },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;

    // First, trigger the tool to set pending state
    const registered: Array<[string, unknown]> = [];
    const registry = {
      register: (name: string, tool: unknown) => registered.push([name, tool]),
      getAll: () => [],
    };
    await (hooks[HOOKS.TOOLS_REGISTER] as Function)(registry);
    const handoffTool = registered[0]![1] as HandoffTool;

    // Execute the handoff tool to set pending state
    await handoffTool.execute(
      JSON.stringify({
        content: "Execute the plan",
        title: "Execution Phase",
        instructions: "Be careful",
        files: ["src/main.ts"],
      }),
      null!,
    );

    // Mock agent
    const enqueuedMessages: string[] = [];
    const mockAgent = {
      clearContext: vi.fn().mockResolvedValue(undefined),
      ensureSystemPrompt: vi.fn().mockResolvedValue(undefined),
      enqueue: (text: string) => enqueuedMessages.push(text),
      emitOutput: vi.fn(),
    };

    // Trigger TURN_END with handoff tool in results
    await (hooks[HOOKS.TURN_END] as Function)({
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults: [
        { toolName: "handoff", input: "{}", result: "ok" },
      ],
    });

    // Verify context was cleared and system prompt rebuilt
    expect(mockAgent.clearContext).toHaveBeenCalledTimes(1);
    expect(mockAgent.ensureSystemPrompt).toHaveBeenCalledTimes(1);

    // Verify handoff message was enqueued with proper structure
    expect(enqueuedMessages).toHaveLength(1);
    const message = enqueuedMessages[0];
    expect(message).toContain("# Execution Phase");
    expect(message).toContain("## Instructions");
    expect(message).toContain("Be careful");
    expect(message).toContain("## Plan");
    expect(message).toContain("Execute the plan");
    expect(message).toContain("## Relevant Files");
    expect(message).toContain("src/main.ts");
    expect(message).toContain("started from a handoff");
  });

  it("TURN_END hook consumes only the matching session's pending handoff", async () => {
    const ext = create({
      config: { handoffTool: {} },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;

    const registered: Array<[string, unknown]> = [];
    const registry = {
      register: (name: string, tool: unknown) => registered.push([name, tool]),
      getAll: () => [],
    };
    await (hooks[HOOKS.TOOLS_REGISTER] as Function)(registry);
    const handoffTool = registered[0]![1] as HandoffTool;

    // Two concurrent sessions each call handoff.
    const ctxA = new ToolContext();
    ctxA.set("agent", { sessionId: "session-a" });
    const ctxB = new ToolContext();
    ctxB.set("agent", { sessionId: "session-b" });
    await handoffTool.execute(JSON.stringify({ content: "Plan A", title: "A" }), ctxA);
    await handoffTool.execute(JSON.stringify({ content: "Plan B", title: "B" }), ctxB);

    const enqueuedA: string[] = [];
    const enqueuedB: string[] = [];
    const makeAgent = (sessionId: string, enqueued: string[]) => ({
      sessionId,
      clearContext: vi.fn().mockResolvedValue(undefined),
      ensureSystemPrompt: vi.fn().mockResolvedValue(undefined),
      enqueue: (text: string) => enqueued.push(text),
      emitOutput: vi.fn(),
    });
    const agentA = makeAgent("session-a", enqueuedA);
    const agentB = makeAgent("session-b", enqueuedB);
    const handoffResults = [{ toolName: "handoff", input: "{}", result: "ok" }];

    // Session A's turn ends: only A is cleared, with A's content.
    await (hooks[HOOKS.TURN_END] as Function)({
      stopped: true,
      cancelled: false,
      agent: agentA,
      toolResults: handoffResults,
    });
    expect(agentA.clearContext).toHaveBeenCalledTimes(1);
    expect(enqueuedA).toHaveLength(1);
    expect(enqueuedA[0]).toContain("Plan A");
    expect(agentB.clearContext).not.toHaveBeenCalled();
    expect(enqueuedB).toHaveLength(0);

    // Session B's turn ends: its own payload was not clobbered by A's.
    await (hooks[HOOKS.TURN_END] as Function)({
      stopped: true,
      cancelled: false,
      agent: agentB,
      toolResults: handoffResults,
    });
    expect(agentB.clearContext).toHaveBeenCalledTimes(1);
    expect(enqueuedB).toHaveLength(1);
    expect(enqueuedB[0]).toContain("Plan B");

    // A consumed turn must not replay on a later turn end for A.
    await (hooks[HOOKS.TURN_END] as Function)({
      stopped: true,
      cancelled: false,
      agent: agentA,
      toolResults: handoffResults,
    });
    expect(agentA.clearContext).toHaveBeenCalledTimes(1);
    expect(enqueuedA).toHaveLength(1);
  });

  it("TURN_END hook does nothing when not stopped", async () => {
    const ext = create({
      config: { handoffTool: {} },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;

    // Set up tool and pending state
    const registered: Array<[string, unknown]> = [];
    const registry = {
      register: (name: string, tool: unknown) => registered.push([name, tool]),
      getAll: () => [],
    };
    await (hooks[HOOKS.TOOLS_REGISTER] as Function)(registry);
    const handoffTool = registered[0]![1] as HandoffTool;
    await handoffTool.execute(JSON.stringify({ content: "Plan" }), null!);

    const mockAgent = {
      clearContext: vi.fn().mockResolvedValue(undefined),
      ensureSystemPrompt: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
    };

    // stopped=false should not trigger handoff
    await (hooks[HOOKS.TURN_END] as Function)({
      stopped: false,
      cancelled: false,
      agent: mockAgent,
      toolResults: [{ toolName: "handoff", input: "{}", result: "ok" }],
    });

    expect(mockAgent.clearContext).not.toHaveBeenCalled();
  });

  it("TURN_END hook does nothing when cancelled", async () => {
    const ext = create({
      config: { handoffTool: {} },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;

    const registered: Array<[string, unknown]> = [];
    const registry = {
      register: (name: string, tool: unknown) => registered.push([name, tool]),
      getAll: () => [],
    };
    await (hooks[HOOKS.TOOLS_REGISTER] as Function)(registry);
    const handoffTool = registered[0]![1] as HandoffTool;
    await handoffTool.execute(JSON.stringify({ content: "Plan" }), null!);

    const mockAgent = {
      clearContext: vi.fn().mockResolvedValue(undefined),
      ensureSystemPrompt: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
    };

    await (hooks[HOOKS.TURN_END] as Function)({
      stopped: true,
      cancelled: true,
      agent: mockAgent,
      toolResults: [{ toolName: "handoff", input: "{}", result: "ok" }],
    });

    expect(mockAgent.clearContext).not.toHaveBeenCalled();
  });

  it("TURN_END hook does nothing when handoff tool was not called", async () => {
    const ext = create({
      config: { handoffTool: {} },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;

    const registered: Array<[string, unknown]> = [];
    const registry = {
      register: (name: string, tool: unknown) => registered.push([name, tool]),
      getAll: () => [],
    };
    await (hooks[HOOKS.TOOLS_REGISTER] as Function)(registry);
    const handoffTool = registered[0]![1] as HandoffTool;
    await handoffTool.execute(JSON.stringify({ content: "Plan" }), null!);

    const mockAgent = {
      clearContext: vi.fn().mockResolvedValue(undefined),
      ensureSystemPrompt: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
    };

    // Different tool was called, not handoff
    await (hooks[HOOKS.TURN_END] as Function)({
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults: [{ toolName: "read", input: "{}", result: "file content" }],
    });

    expect(mockAgent.clearContext).not.toHaveBeenCalled();
  });

  it("TURN_END hook handles errors gracefully", async () => {
    const ext = create({
      config: { handoffTool: {} },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;

    const registered: Array<[string, unknown]> = [];
    const registry = {
      register: (name: string, tool: unknown) => registered.push([name, tool]),
      getAll: () => [],
    };
    await (hooks[HOOKS.TOOLS_REGISTER] as Function)(registry);
    const handoffTool = registered[0]![1] as HandoffTool;
    await handoffTool.execute(JSON.stringify({ content: "Plan" }), null!);

    const emitCalls: Array<{ type: string; data: unknown }> = [];
    const mockAgent = {
      clearContext: vi.fn().mockRejectedValue(new Error("Clear failed")),
      ensureSystemPrompt: vi.fn().mockResolvedValue(undefined),
      enqueue: vi.fn(),
      emitOutput: (type: string, data: unknown) => emitCalls.push({ type, data }),
    };

    await (hooks[HOOKS.TURN_END] as Function)({
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults: [{ toolName: "handoff", input: "{}", result: "ok" }],
    });

    // Should emit error but not throw
    expect(emitCalls).toHaveLength(1);
    expect(emitCalls[0]!.type).toBe("command_result");
    expect(emitCalls[0]!.data).toHaveProperty("content");
    expect((emitCalls[0]!.data as { content: string }).content).toContain("Handoff error");
  });
});
