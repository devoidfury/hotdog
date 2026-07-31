// Tests for the handoff tool — plan-execute handoff extension.

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { HandoffTool, create } from "../../src/extensions/handoff-tool/index.ts";
import { HOOKS } from "../../src/core/hooks.ts";
import type { CoreContext } from "../../src/core/extensions/types.ts";

describe("HandoffTool", () => {
  let state: { pending: { content: string; title?: string; instructions?: string; files?: string[] } | null };
  let tool: HandoffTool;

  beforeEach(() => {
    state = { pending: null };
    tool = new HandoffTool(state);
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
      const props = def.function.parameters.properties as Record<string, unknown>;
      expect(props.content).toBeDefined();
      expect(props.title).toBeDefined();
      expect(props.instructions).toBeDefined();
      expect(props.files).toBeDefined();
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
      expect(state.pending).toEqual({
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
      expect(state.pending).toEqual({
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
      expect(state.pending?.files).toEqual(["src/main.ts"]);
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
    expect(ext.hooks!['systemPrompt:build']).toBeDefined();
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

  it("system prompt hook includes handoff instructions when tool is registered", async () => {
    const ext = create({
      config: { handoffTool: { systemPrompt: true } },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;
    const mockAgent = {
      getToolNames: () => ["handoff", "read", "write"],
    };
    const chunk = (hooks[HOOKS.SYSTEM_PROMPT_BUILD] as Function)({ agent: mockAgent });
    expect(chunk.name).toBe("handoff-tool-instructions");
    expect(chunk.content).toContain("tool: handoff");
    expect(chunk.content).toContain("transitioning work phase");
  });

  it("system prompt hook returns empty when tool is not registered", async () => {
    const ext = create({
      config: { handoffTool: { systemPrompt: true } },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;
    const mockAgent = {
      getToolNames: () => ["read", "write"], // no "handoff"
    };
    const chunk = (hooks[HOOKS.SYSTEM_PROMPT_BUILD] as Function)({ agent: mockAgent });
    expect(chunk.name).toBe("handoff-tool-instructions");
    expect(chunk.content).toBe("");
  });

  it("system prompt hook returns empty when disabled", async () => {
    const ext = create({
      config: { handoffTool: { systemPrompt: false } },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;
    const chunk = (hooks[HOOKS.SYSTEM_PROMPT_BUILD] as Function)({ agent: null });
    expect(chunk.name).toBe("handoff-tool-instructions");
    expect(chunk.content).toBe("");
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
