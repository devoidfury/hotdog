import { describe, it, expect, mock } from "bun:test";
import { Command, ACTIONS } from "@core/commands.ts";
import {
  handleClear,
  handleQuit,
  handleHelp,
  handleTokens,
  handleTools,
  handleThinking,
  handleRegenerate,
  handleReasoning,
  handleUndo,
  handleRewind,
  handleFork,
  parseForkArg,
  CORE_COMMAND_HANDLERS,
} from "@core/command-handlers.ts";

type TokenUsage = {
  turns: number;
  sessionPromptTokens: number;
  sessionCachedTokens: number;
  sessionCompletionTokens: number;
  sessionTotalTokens: number;
  promptTokens?: number;
  cachedTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
};

// ── Mock Agent Factory ────────────────────────────────────────────────

function makeMockAgent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    cancelled: false,
    clearContext: mock(async () => {}),
    enqueue: mock(() => {}),
    hideTools: false,
    hideThinking: false,
    context: {
      clearSystemPrompt: mock(() => {}),
      getSystemPrompt: mock(() => null),
      getTokenUsage: mock((): TokenUsage => ({
        sessionPromptTokens: 0, sessionCachedTokens: 0, sessionCompletionTokens: 0, sessionTotalTokens: 0,
        turns: 0, promptTokens: 0, cachedTokens: 0,
        completionTokens: 0, totalTokens: 0,
      })),
    },
    reasoningEffort: undefined,
    ensureSystemPrompt: mock(async () => {}),
    emitOutput: mock(() => {}),
    ...overrides,
  };
}

// ── Handler Tests ──────────────────────────────────────────────────────

describe("handleQuit / handleHelp", () => {
  it("return fallback messages", () => {
    expect(handleQuit().content).toBe("Quit (use /quit to exit)");
    expect(handleHelp().content).toBe("Help (use /help for commands)");
  });
});

describe("handleClear", () => {
  it("clears context and returns message", async () => {
    const agent = makeMockAgent();
    const result = await handleClear(agent as any, null);
    expect(result.content).toBe("Context cleared.");
    expect(agent.clearContext).toHaveBeenCalled();
  });
});

describe("handleTokens", () => {
  it("returns no-usage message when no turns recorded", () => {
    const agent = makeMockAgent();
    const result = handleTokens(agent as any);
    expect(result.content).toContain("No token usage recorded");
  });

  it("displays accumulated totals and cache hit percentage", () => {
    const agent = makeMockAgent({
      context: {
        getTokenUsage: mock((): TokenUsage => ({
          sessionPromptTokens: 1200, sessionCachedTokens: 800, sessionCompletionTokens: 400, sessionTotalTokens: 2400,
          turns: 2, promptTokens: 1000, cachedTokens: 400,
          completionTokens: 200, totalTokens: 1600,
        })),
      },
    });
    const result = handleTokens(agent as any);
    expect(result.content).toContain("Token usage (2 turns):");
    expect(result.content).toMatch(/prompt.*1,200 tokens/);
    expect(result.content).toMatch(/completion.*400 tokens/);
    expect(result.content).toMatch(/total.*2,400 tokens/);
    expect(result.content).toMatch(/cache hit.*40\.0%/);
    expect(result.content).toContain("Last call:");
  });

  it("handles single turn (no plural)", () => {
    const agent = makeMockAgent({
      context: {
        getTokenUsage: mock((): TokenUsage => ({
          sessionPromptTokens: 100, sessionCachedTokens: 0, sessionCompletionTokens: 50, sessionTotalTokens: 150,
          turns: 1, promptTokens: 100, cachedTokens: 0,
          completionTokens: 50, totalTokens: 150,
        })),
      },
    });
    const result = handleTokens(agent as any);
    expect(result.content).toContain("Token usage (1 turn):");
  });

  it("omits cache hit line when real prompt tokens are zero", () => {
    const agent = makeMockAgent({
      context: {
        getTokenUsage: mock((): TokenUsage => ({
          sessionPromptTokens: 0, sessionCachedTokens: 100, sessionCompletionTokens: 50, sessionTotalTokens: 150,
          turns: 1, promptTokens: 100, cachedTokens: 100,
          completionTokens: 50, totalTokens: 150,
        })),
      },
    });
    const result = handleTokens(agent as any);
    expect(result.content).not.toContain("cache hit");
  });
});

describe("handleTools", () => {
  it("toggles hideTools from false to true", () => {
    const outputs: Array<{type: string; data: Record<string, unknown>}> = [];
    const agent = makeMockAgent({
      hideTools: false,
      emitOutput: mock((type: string, data: Record<string, unknown>) => outputs.push({ type, data })),
    });
    const result = handleTools(agent as any);
    expect(agent.hideTools).toBe(true);
    expect(result.content).toContain("hidden");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.data.key).toBe("hideTools");
  });

  it("toggles hideTools from true to false", () => {
    const outputs: Array<{type: string; data: Record<string, unknown>}> = [];
    const agent = makeMockAgent({
      hideTools: true,
      emitOutput: mock((type: string, data: Record<string, unknown>) => outputs.push({ type, data })),
    });
    const result = handleTools(agent as any);
    expect(agent.hideTools).toBe(false);
    expect(result.content).toContain("shown");
  });
});

describe("handleThinking", () => {
  it("toggles hideThinking from false to true", () => {
    const outputs: Array<{type: string; data: Record<string, unknown>}> = [];
    const agent = makeMockAgent({
      hideThinking: false,
      emitOutput: mock((type: string, data: Record<string, unknown>) => outputs.push({ type, data })),
    });
    const result = handleThinking(agent as any);
    expect(agent.hideThinking).toBe(true);
    expect(result.content).toContain("hidden");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]!.data.key).toBe("hideThinking");
  });

  it("toggles hideThinking from true to false", () => {
    const outputs: Array<{type: string; data: Record<string, unknown>}> = [];
    const agent = makeMockAgent({
      hideThinking: true,
      emitOutput: mock((type: string, data: Record<string, unknown>) => outputs.push({ type, data })),
    });
    const result = handleThinking(agent as any);
    expect(agent.hideThinking).toBe(false);
    expect(result.content).toContain("shown");
  });
});

describe("handleRegenerate", () => {
  it("regenerates system prompt", async () => {
    const agent = makeMockAgent({
      context: {
        clearSystemPrompt: mock(() => {}),
        getSystemPrompt: mock(() => "old prompt"),
      },
    });
    const result = await handleRegenerate(agent as any);
    expect((agent.context as any).clearSystemPrompt).toHaveBeenCalled();
    expect(agent.ensureSystemPrompt).toHaveBeenCalled();
    expect(result.content).toBe("System prompt regenerated.");
  });
});

describe("handleReasoning", () => {
  it("shows current reasoning effort when no value given", () => {
    const agent = makeMockAgent({ reasoningEffort: "high" });
    const result = handleReasoning(agent as any, "");
    expect(result.content).toContain("high");
  });

  it("shows '(not set)' when reasoning effort is undefined", () => {
    const agent = makeMockAgent({ reasoningEffort: undefined });
    const result = handleReasoning(agent as any, "");
    expect(result.content).toContain("not set");
  });

  it("sets reasoning effort to valid value", () => {
    const agent = makeMockAgent({ reasoningEffort: undefined });
    const result = handleReasoning(agent as any, "low");
    expect(agent.reasoningEffort).toBe("low");
    expect(result.content).toContain("low");
  });

  it("handles all valid values", () => {
    const valid = ["none", "minimal", "low", "high", "xhigh", "max"] as const;
    for (const v of valid) {
      const agent = makeMockAgent({ reasoningEffort: undefined });
      const result = handleReasoning(agent as any, v);
      expect(agent.reasoningEffort).toBe(v);
      expect(result.content).toContain(v);
    }
  });

  it("unsets reasoning effort", () => {
    const agent = makeMockAgent({ reasoningEffort: "high" });
    const result = handleReasoning(agent as any, "unset");
    expect(agent.reasoningEffort).toBeUndefined();
    expect(result.content).toContain("unset");
  });

  it("returns error for invalid value", () => {
    const agent = makeMockAgent({});
    const result = handleReasoning(agent as any, "invalid");
    expect(result.error).toContain("Invalid reasoning effort");
    expect(result.error).toContain("invalid");
    expect(result.error).toContain("none");
  });
});

describe("CORE_COMMAND_HANDLERS", () => {
  it("maps all command types to handlers", () => {
    expect(CORE_COMMAND_HANDLERS[Command.Clear]).toBeDefined();
    expect(CORE_COMMAND_HANDLERS[Command.Quit]).toBeDefined();
    expect(CORE_COMMAND_HANDLERS[Command.Help]).toBeDefined();
    expect(CORE_COMMAND_HANDLERS[Command.Tokens]).toBeDefined();
    expect(CORE_COMMAND_HANDLERS[Command.Tools]).toBeDefined();
    expect(CORE_COMMAND_HANDLERS[Command.Thinking]).toBeDefined();
    expect(CORE_COMMAND_HANDLERS[Command.Regenerate]).toBeDefined();
    expect(CORE_COMMAND_HANDLERS[Command.Reasoning]).toBeDefined();
  });

  it("/reasoning completes the effort levels, prefix-filtered", () => {
    const completion = CORE_COMMAND_HANDLERS[Command.Reasoning]!.completion!;
    const ctx = (commandArg = "") =>
      ({ line: "/reasoning " + commandArg, cursorPos: 0, command: "reasoning", commandArg, agent: {} }) as never;
    const values = (arg?: string) =>
      (completion(ctx(arg)) as Array<{ value: string }>).map((o) => o.value);
    expect(values()).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max", "unset"]);
    // Filter is case-insensitive on the arg; levels keep their canonical order.
    expect(values("M")).toEqual(["minimal", "medium", "max"]);
    expect(values("x")).toEqual(["xhigh"]);
    expect(values("z")).toEqual([]);
  });

  it("quit and help are channel-level commands (no isUiCommand)", () => {
    const quitDef = CORE_COMMAND_HANDLERS[Command.Quit]! as unknown as Record<string, unknown>;
    const helpDef = CORE_COMMAND_HANDLERS[Command.Help]! as unknown as Record<string, unknown>;
    expect(quitDef.isUiCommand).toBeUndefined();
    expect(helpDef.isUiCommand).toBeUndefined();
  });

  it("handlers have descriptions", () => {
    for (const [, entry] of Object.entries(CORE_COMMAND_HANDLERS)) {
      expect(entry.description).toBeDefined();
      expect(typeof entry.description).toBe("string");
    }
  });
});

// ── Undo / Rewind ─────────────────────────────────────────────────────

function convoMessages() {
  return [
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a2" },
  ];
}

describe("handleUndo / handleRewind", () => {
  function makeRewindAgent() {
    const rewindContext = mock((kept: Array<{ content: unknown }>) => {
      void kept;
    });
    const agent = makeMockAgent({
      getMessages: () => convoMessages(),
      rewindContext,
    }) as never;
    return { agent, rewindContext };
  }

  it("handleUndo drops the last turn", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const result = await handleUndo(agent);
    expect(result.action).toBe(ACTIONS.DISPLAY);
    expect(result.content).toContain("Rewound 1 turn (1 turn remains)");
    expect(rewindContext).toHaveBeenCalledTimes(1);
    expect(rewindContext.mock.calls[0]![0].map((m) => m.content)).toEqual(["u1", "a1"]);
  });

  it("bare /rewind defaults to one turn", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    await handleRewind(agent, null);
    expect(rewindContext.mock.calls[0]![0].map((m) => m.content)).toEqual(["u1", "a1"]);
  });

  it("/rewind N drops N turns", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const result = await handleRewind(agent, "2");
    expect(rewindContext.mock.calls[0]![0]).toHaveLength(0);
    expect(result.content).toContain("Rewound 2 turns");
  });

  it("clamps N larger than the turn count", async () => {
    const { agent } = makeRewindAgent();
    const result = await handleRewind(agent, "99");
    expect(result.content).toContain("Rewound 2 turns");
  });

  it("rejects a non-numeric argument", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const result = await handleRewind(agent, "lots");
    expect(result.action).toBe(ACTIONS.ERROR);
    expect(result.error).toContain("Invalid turn count");
    expect(rewindContext).not.toHaveBeenCalled();
  });

  it("rejects zero", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const result = await handleRewind(agent, "0");
    expect(result.action).toBe(ACTIONS.ERROR);
    expect(rewindContext).not.toHaveBeenCalled();
  });

  it("reports nothing to rewind when no user turns exist", async () => {
    const rewindContext = mock(() => {});
    const agent = makeMockAgent({
      getMessages: () => [{ role: "assistant", content: "a1" }],
      rewindContext,
    }) as never;
    const result = await handleUndo(agent);
    expect(result.action).toBe(ACTIONS.DISPLAY);
    expect(result.content).toContain("Nothing to rewind");
    expect(rewindContext).not.toHaveBeenCalled();
  });
});

// ── Fork ──────────────────────────────────────────────────────────────

describe("handleFork", () => {
  function makeForkAgent(forkSession: unknown) {
    return makeMockAgent({
      forkSession,
      sessionId: "src-session",
    }) as never;
  }

  it("errors when no fork seam is wired", async () => {
    const result = await handleFork(makeMockAgent() as never, "hello");
    expect(result.action).toBe(ACTIONS.ERROR);
    expect(result.error).toContain("not available");
  });

  it("parses a leading turns count plus prompt", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", droppedTurns: 2 }));
    const result = await handleFork(makeForkAgent(forkSession), "2   try this thing");
    expect(forkSession).toHaveBeenCalledWith({ turnsBack: 2 });
    expect(result.content).toContain("src-session → new-session");
    expect(result.content).toContain("dropped 2 turns");
    expect(result.content).toContain("Prompt sent");
  });

  it("reports the actual (clamped) drop count, not the requested one", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", droppedTurns: 2 }));
    const result = await handleFork(makeForkAgent(forkSession), "99");
    expect(forkSession).toHaveBeenCalledWith({ turnsBack: 99 });
    expect(result.content).toContain("dropped 2 turns");
    expect(result.content).not.toContain("dropped 99");
  });

  it("treats a non-numeric first token as the prompt", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", droppedTurns: 0 }));
    await handleFork(makeForkAgent(forkSession), "go deeper 2");
    expect(forkSession).toHaveBeenCalledWith({ turnsBack: 0 });
  });

  it("supports a bare fork (full copy, no prompt)", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", droppedTurns: 0 }));
    const result = await handleFork(makeForkAgent(forkSession), null);
    expect(forkSession).toHaveBeenCalledWith({ turnsBack: 0 });
    expect(result.content).not.toContain("Prompt sent");
  });

  it("turns count alone is not treated as a prompt", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", droppedTurns: 0 }));
    await handleFork(makeForkAgent(forkSession), "3");
    expect(forkSession).toHaveBeenCalledWith({ turnsBack: 3 });
  });

  it("surfaces fork failures as command errors", async () => {
    const forkSession = mock(async () => {
      throw new Error("boom");
    });
    const result = await handleFork(makeForkAgent(forkSession), "");
    expect(result.action).toBe(ACTIONS.ERROR);
    expect(result.error).toContain("boom");
  });
});

describe("CORE_COMMAND_HANDLERS registration", () => {
  it("registers undo, rewind and fork", () => {
    expect(CORE_COMMAND_HANDLERS[Command.Undo]?.handler).toBe(handleUndo);
    expect(CORE_COMMAND_HANDLERS[Command.Rewind]?.handler).toBe(handleRewind);
    expect(CORE_COMMAND_HANDLERS[Command.Fork]?.handler).toBe(handleFork);
  });
});

describe("parseForkArg", () => {
  it("splits a leading turn count from the prompt", () => {
    expect(parseForkArg("2 try this")).toEqual({ turnsBack: 2, prompt: "try this" });
  });

  it("treats a bare count as turns with no prompt", () => {
    expect(parseForkArg("3")).toEqual({ turnsBack: 3, prompt: undefined });
  });

  it("defaults turnsBack to 0 for a prompt-only arg", () => {
    expect(parseForkArg("go deeper 2")).toEqual({ turnsBack: 0, prompt: "go deeper 2" });
  });

  it("empty arg yields no turns and no prompt", () => {
    expect(parseForkArg("   ")).toEqual({ turnsBack: 0, prompt: undefined });
  });

  it("keeps multi-line prompts verbatim (trimmed)", () => {
    expect(parseForkArg("1  do a\n b").prompt).toBe("do a\n b");
  });
});
