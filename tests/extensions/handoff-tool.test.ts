// Tests for the handoff tool — plan-execute handoff extension.

import { describe, it, expect, beforeEach, afterEach, vi } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HandoffTool, create } from "@extensions/handoff-tool/index.ts";
import { HOOKS } from "@core/hooks.ts";
import { ToolContext } from "@core/extensions/tool-context.ts";
import { contentToText } from "@core/context/message.ts";
import type { CoreContext } from "@core/extensions/types.ts";

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
      config: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
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
      config: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
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
      config: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
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
    const enqueuedMessages: Array<{
      content: Array<Record<string, unknown>>;
      opts: { source?: string } | undefined;
    }> = [];
    const mockAgent = {
      clearContext: vi.fn().mockResolvedValue(undefined),
      ensureSystemPrompt: vi.fn().mockResolvedValue(undefined),
      enqueue: (content: Array<Record<string, unknown>>, opts: { source?: string } | undefined) =>
        enqueuedMessages.push({ content, opts }),
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

    // Verify handoff message was enqueued with proper structure: parts
    // (harness provenance is the only way they survive the queue boundary).
    expect(enqueuedMessages).toHaveLength(1);
    const { content, opts } = enqueuedMessages[0]!;
    expect(opts?.source).toBe("harness");
    const message = contentToText(content);
    expect(message).toContain("# Execution Phase");
    expect(message).toContain("## Instructions");
    expect(message).toContain("Be careful");
    expect(message).toContain("## Plan");
    expect(message).toContain("Execute the plan");
    expect(message).toContain("## Relevant Files");
    expect(message).toContain("src/main.ts");
    expect(message).toContain("started from a handoff");

    // Model-authored prose rides `untrusted` parts, never harness-trusted text.
    const untrusted = content
      .filter((p) => p.type === "untrusted")
      .map((p) => String(p.text))
      .join("\n");
    expect(untrusted).toContain("Execution Phase");
    expect(untrusted).toContain("Be careful");
    expect(untrusted).toContain("Execute the plan");
    // Structural framing is harness text.
    const trustedText = content
      .filter((p) => p.type === "text")
      .map((p) => String(p.text))
      .join("\n");
    expect(trustedText).toContain("## Plan");
    expect(trustedText).toContain("## Relevant Files");
    expect(trustedText).toContain("started from a handoff");
  });

  it("TURN_END hook takes the turn claim and defers (keeping pending) when it is lost", async () => {
    const ext = create({
      config: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;

    const registered: Array<[string, unknown]> = [];
    const registry = {
      register: (name: string, tool: unknown) => registered.push([name, tool]),
      getAll: () => [],
    };
    await (hooks[HOOKS.TOOLS_REGISTER] as Function)(registry);
    const handoffTool = registered[0]![1] as HandoffTool;
    await handoffTool.execute(JSON.stringify({ content: "the plan" }), null!);

    const enqueuedMessages: string[] = [];
    const mockAgent = {
      clearContext: vi.fn().mockResolvedValue(undefined),
      ensureSystemPrompt: vi.fn().mockResolvedValue(undefined),
      enqueue: (content: Array<Record<string, unknown>>) => enqueuedMessages.push(contentToText(content)),
      emitOutput: vi.fn(),
    };
    const base = {
      stopped: true,
      cancelled: false,
      agent: mockAgent,
      toolResults: [{ toolName: "handoff", input: "{}", result: "ok" }],
    };

    // Another handler claimed first: no clear, no enqueue, pending survives.
    await (hooks[HOOKS.TURN_END] as Function)({ ...base, claimTurn: () => false });
    expect(enqueuedMessages).toHaveLength(0);
    expect(mockAgent.clearContext).not.toHaveBeenCalled();

    // A later turn end with the claim free: the pending handoff fires, and
    // handoff takes the claim itself (subsequent claimers lose).
    let claimed = false;
    const claimTurn = () => {
      if (claimed) return false;
      claimed = true;
      return true;
    };
    await (hooks[HOOKS.TURN_END] as Function)({ ...base, claimTurn });
    expect(enqueuedMessages).toHaveLength(1);
    expect(claimTurn()).toBe(false);
  });

  it("TURN_END hook consumes only the matching session's pending handoff", async () => {
    const ext = create({
      config: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
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
      enqueue: (content: Array<Record<string, unknown>>) => enqueued.push(contentToText(content)),
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
      config: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
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
      config: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
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
      config: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
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
      config: { handoffTool: { autoIncludeFilesUnderBytes: 24576 } },
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

describe("handoff auto-inline files", () => {
  let tmpDir: string;

  interface RunResult {
    parts: Array<Record<string, unknown>>;
    text: string;
    source: string | undefined;
  }

  /** The file-include parts of a run result, in order. */
  function includesOf(result: RunResult): Array<{ path: string; content: string }> {
    return result.parts
      .filter((p) => p.type === "file-include")
      .map((p) => ({ path: String(p.path), content: String(p.content) }));
  }

  async function runHandoff(
    handoffConfig: Record<string, unknown>,
    files: string[],
    agentConfig: Record<string, unknown> = {},
  ): Promise<RunResult> {
    const ext = create({
      config: { handoffTool: handoffConfig },
    } as unknown as CoreContext);
    const hooks = ext.hooks! as Record<string, unknown>;

    let tool: unknown;
    const registry = {
      register: (_name: string, t: unknown) => {
        tool = t;
      },
      getAll: () => [],
    };
    await (hooks[HOOKS.TOOLS_REGISTER] as Function)(registry);
    await (tool as HandoffTool).execute(
      JSON.stringify({ content: "Plan", files }),
      null!,
    );

    const enqueued: Array<{ content: Array<Record<string, unknown>>; source: string | undefined }> = [];
    const agent = {
      clearContext: vi.fn().mockResolvedValue(undefined),
      ensureSystemPrompt: vi.fn().mockResolvedValue(undefined),
      enqueue: (content: Array<Record<string, unknown>>, opts?: { source?: string }) =>
        enqueued.push({ content, source: opts?.source }),
      emitOutput: vi.fn(),
      config: agentConfig,
    };

    await (hooks[HOOKS.TURN_END] as Function)({
      stopped: true,
      cancelled: false,
      agent,
      toolResults: [{ toolName: "handoff", input: "{}", result: "ok" }],
    });

    expect(enqueued).toHaveLength(1);
    return {
      parts: enqueued[0]!.content,
      text: contentToText(enqueued[0]!.content),
      source: enqueued[0]!.source,
    };
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "hotdog-handoff-test-"));
    writeFileSync(join(tmpDir, "small.txt"), "hello world\n"); // 12B
    writeFileSync(join(tmpDir, "big.txt"), "x".repeat(300)); // 300B
    writeFileSync(join(tmpDir, "kb.txt"), "y".repeat(5120)); // 5.0KB
    writeFileSync(join(tmpDir, "bin.dat"), Buffer.from([0x61, 0x00, 0x62])); // 3B, binary
    writeFileSync(join(tmpDir, "fence.md"), "before\n```\ncode\n```\nafter\n");
    writeFileSync(join(tmpDir, "fence5.md"), "a\n`````\nb\n`````\nc\n");
    mkdirSync(join(tmpDir, "sub"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("inlines files under the limit, lists oversized and missing files with notes", async () => {
    const result = await runHandoff(
      { autoIncludeFilesUnderBytes: 100 },
      ["small.txt", "big.txt", "kb.txt", "missing.txt"],
      { workspaceRoots: [tmpDir] },
    );

    // Harness provenance: the only way wrapper parts survive the queue boundary.
    expect(result.source).toBe("harness");
    expect(result.text).toContain("## Relevant Files");
    // small.txt inlined as a file-include wrapper part, not fenced prose.
    expect(includesOf(result)).toEqual([{ path: "small.txt", content: "hello world\n" }]);
    expect(result.text).not.toContain("### small.txt");
    expect(result.text).not.toContain("- small.txt");
    // oversized files listed with human sizes
    expect(result.text).toContain("- big.txt (300B)");
    expect(result.text).toContain("- kb.txt (5.0KB)");
    // missing files listed as not found (may be a file to create)
    expect(result.text).toContain("- missing.txt (not found)");
  });

  it("inlines everything at a generous limit with nothing left over", async () => {
    const result = await runHandoff(
      { autoIncludeFilesUnderBytes: 24576 },
      ["small.txt", "big.txt", "kb.txt"],
      { workspaceRoots: [tmpDir] },
    );

    expect(includesOf(result).map((f) => f.path)).toEqual(["small.txt", "big.txt", "kb.txt"]);
    // nothing left over
    expect(result.text).not.toContain("(not found)");
    expect(result.text).not.toContain("(300B)");
  });

  it("throws ConfigError when autoIncludeFilesUnderBytes is missing or invalid", () => {
    // The resolved config always carries the schema default from
    // extension.json; without the registry the raw block is used as-is,
    // so a missing or bad value must fail loudly in create().
    expect(() =>
      create({ config: { handoffTool: {} } } as unknown as CoreContext),
    ).toThrow("autoIncludeFilesUnderBytes");
    expect(() =>
      create({
        config: { handoffTool: { autoIncludeFilesUnderBytes: -1 } },
      } as unknown as CoreContext),
    ).toThrow("non-negative");
    expect(() =>
      create({
        config: { handoffTool: { autoIncludeFilesUnderBytes: "24576" } },
      } as unknown as CoreContext),
    ).toThrow("non-negative");
  });

  it("lists everything when autoIncludeFilesUnderBytes is 0", async () => {
    const result = await runHandoff(
      { autoIncludeFilesUnderBytes: 0 },
      ["small.txt"],
      { workspaceRoots: [tmpDir] },
    );

    expect(includesOf(result)).toHaveLength(0);
    expect(result.text).not.toContain("hello world");
    expect(result.text).toContain("- small.txt (12B)");
  });

  it("does not inline 0-byte files when autoIncludeFilesUnderBytes is 0", async () => {
    writeFileSync(join(tmpDir, "empty.txt"), "");
    const result = await runHandoff(
      { autoIncludeFilesUnderBytes: 0 },
      ["empty.txt"],
      { workspaceRoots: [tmpDir] },
    );

    expect(includesOf(result)).toHaveLength(0);
    expect(result.text).toContain("- empty.txt (0B)");
  });

  it("does not inline binary files even under the limit", async () => {
    const result = await runHandoff(
      { autoIncludeFilesUnderBytes: 100 },
      ["bin.dat"],
      { workspaceRoots: [tmpDir] },
    );

    expect(includesOf(result)).toHaveLength(0);
    expect(result.text).toContain("- bin.dat (3B, binary)");
  });

  it("notes directories and workspace-rejected paths", async () => {
    const result = await runHandoff(
      { autoIncludeFilesUnderBytes: 100 },
      ["sub", "../escape.txt"],
      { workspaceRoots: [tmpDir] },
    );

    expect(includesOf(result)).toHaveLength(0);
    expect(result.text).toContain("- sub (directory)");
    expect(result.text).toContain("- ../escape.txt (path rejected)");
  });

  it("rides file content verbatim in the part; framing is the wire's job", async () => {
    // Backtick runs need no fence widening: the content is data inside a
    // file-include wrapper, not fenced markdown prose.
    const result = await runHandoff(
      { autoIncludeFilesUnderBytes: 100 },
      ["fence.md", "fence5.md"],
      { workspaceRoots: [tmpDir] },
    );

    expect(includesOf(result)).toEqual([
      { path: "fence.md", content: "before\n```\ncode\n```\nafter\n" },
      { path: "fence5.md", content: "a\n`````\nb\n`````\nc\n" },
    ]);
  });

  it("inlines a duplicate path only once", async () => {
    const result = await runHandoff(
      { autoIncludeFilesUnderBytes: 100 },
      ["small.txt", "small.txt"],
      { workspaceRoots: [tmpDir] },
    );

    expect(includesOf(result)).toEqual([{ path: "small.txt", content: "hello world\n" }]);
  });

  it("inlines the same file only once across different path notations", async () => {
    const result = await runHandoff(
      { autoIncludeFilesUnderBytes: 100 },
      ["small.txt", "./small.txt", join(tmpDir, "small.txt")],
      { workspaceRoots: [tmpDir] },
    );

    expect(includesOf(result)).toEqual([{ path: "small.txt", content: "hello world\n" }]);
  });
});
