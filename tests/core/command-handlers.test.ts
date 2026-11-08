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
import { createCommandRegistry } from "@core/extensions/registries.ts";
import { ToolRegistry } from "@core/extensions/tool-registry.ts";

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
  it("handleQuit returns the fallback message", () => {
    expect(handleQuit().content).toBe("Quit (use /quit to exit)");
  });

  it("handleHelp returns the registry-generated command list", () => {
    const agent = makeMockAgent({
      commandRegistry: {
        generateHelpText: mock(
          () => "  /help                Show help\n  /tokens              Show token usage",
        ),
      },
    });
    const result = handleHelp(agent as any);
    expect(result.action).toBe(ACTIONS.DISPLAY);
    // Content comes from the registry, not a placeholder.
    expect((agent.commandRegistry as any).generateHelpText).toHaveBeenCalled();
    expect(result.content).toContain("/help");
    expect(result.content).toContain("Show help");
    expect(result.content).toContain("Show token usage");
    expect(result.content).not.toContain("Help (use /help for commands)");
  });

  it("handleHelp lists the real core commands off a real registry", () => {
    const registry = createCommandRegistry();
    for (const [type, def] of Object.entries(CORE_COMMAND_HANDLERS)) {
      registry.register(type, def);
    }
    const agent = makeMockAgent({ commandRegistry: registry });
    const result = handleHelp(agent as any);
    for (const name of ["help", "clear", "tokens", "rewind", "fork", "reasoning"]) {
      expect(result.content).toContain(`/${name}`);
    }
    expect(result.content).toContain("Show token usage");
    expect(result.content).toContain("visible messages back");
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

  it("appends a context gauge line: last-call input vs contextLimit", () => {
    const agent = makeMockAgent({
      contextLimit: 200_000,
      context: {
        getTokenUsage: mock((): TokenUsage => ({
          sessionPromptTokens: 60_000, sessionCachedTokens: 8_000, sessionCompletionTokens: 500, sessionTotalTokens: 68_500,
          turns: 1, promptTokens: 60_000, cachedTokens: 8_000,
          completionTokens: 500, totalTokens: 68_500,
        })),
      },
    });
    const result = handleTokens(agent as any);
    expect(result.content).toContain("◔ 34% (68,000/200,000)");
  });

  it("omits the context gauge line without a positive contextLimit", () => {
    const agent = makeMockAgent({
      contextLimit: 0,
      context: {
        getTokenUsage: mock((): TokenUsage => ({
          sessionPromptTokens: 60_000, sessionCachedTokens: 8_000, sessionCompletionTokens: 500, sessionTotalTokens: 68_500,
          turns: 1, promptTokens: 60_000, cachedTokens: 8_000,
          completionTokens: 500, totalTokens: 68_500,
        })),
      },
    });
    const result = handleTokens(agent as any);
    expect(result.content).not.toContain("context:");
  });

  // ── Cost lines (opt-in `modelPricing`) ────────────────────────────────────

  // session: 1,200 net prompt / 800 cached / 400 completion; last call: 1,000 / 400 / 200.
  const PRICING_USAGE: TokenUsage = {
    sessionPromptTokens: 1200, sessionCachedTokens: 800, sessionCompletionTokens: 400, sessionTotalTokens: 2400,
    turns: 2, promptTokens: 1000, cachedTokens: 400,
    completionTokens: 200, totalTokens: 1600,
  };

  function makePricingAgent(model: string, modelPricing: unknown) {
    return makeMockAgent({
      model,
      config: modelPricing === undefined ? {} : { modelPricing },
      context: {
        clearSystemPrompt: mock(() => {}),
        getSystemPrompt: mock(() => null),
        getTokenUsage: mock((): TokenUsage => ({ ...PRICING_USAGE })),
      },
    });
  }

  const costLines = (content?: string) =>
    (content ?? "").split("\n").filter((line) => line.trimStart().startsWith("cost:"));

  it("adds a cost line to the session block and the last-call block for a priced model", () => {
    const agent = makePricingAgent("vendor/model", {
      "vendor/model": { input: 3, cachedInput: 0.3, output: 15 },
    });
    const lines = costLines(handleTokens(agent as any).content);
    // session: 1200/1e6*3 + 800/1e6*0.3 + 400/1e6*15 = 0.00984
    // last call: 1000/1e6*3 + 400/1e6*0.3 + 200/1e6*15 = 0.00612
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("$0.0098");
    expect(lines[1]).toContain("$0.0061");
  });

  it("formats amounts at or above a cent with two decimals", () => {
    const agent = makePricingAgent("vendor/model", {
      "vendor/model": { input: 3000, cachedInput: 300, output: 15000 },
    });
    expect(costLines(handleTokens(agent as any).content)[0]).toContain("$9.84");
  });

  it("keeps the display tokens-only when pricing is not configured", () => {
    const result = handleTokens(makePricingAgent("vendor/model", undefined) as any);
    expect(result.content).not.toContain("cost");
    expect(result.content).toContain("Token usage (2 turns):");
  });

  it("names the model as unpriced when pricing is configured but the model has no entry", () => {
    const result = handleTokens(makePricingAgent("vendor/other", {
      "vendor/model": { input: 3, output: 15 },
    }) as any);
    const lines = costLines(result.content);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("model 'vendor/other' has no modelPricing entry");
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

  it("/tools list prints each tool with a trailing tag list; untagged tools show nothing extra", () => {
    const registry = new ToolRegistry();
    const mk = (name: string, tags?: string[]) => ({
      metadata: { sideEffects: false, difficulty: 1, ...(tags ? { tags } : {}) },
      toToolDef: () => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } }),
      execute: async () => "ok",
    });
    registry.register("plain_tool", mk("plain_tool"));
    registry.register("tagged_tool", mk("tagged_tool", ["files"]));
    const result = handleTools({ toolRegistry: registry } as any, "list");
    expect(result.action).toBe(ACTIONS.DISPLAY);
    expect(result.content).toContain("Tools (2):");
    expect(result.content).toContain("  tagged_tool [files]");
    expect(result.content).toContain("  plain_tool\n");
    expect(result.content).not.toContain("plain_tool [");
  });

  it("/tools list tags are spoof-neutralized at print", () => {
    const registry = new ToolRegistry();
    registry.register("x", {
      metadata: { sideEffects: false, difficulty: 1, tags: ["files\u202E"] },
      toToolDef: () => ({ type: "function", function: { name: "x", description: "x", parameters: { type: "object", properties: {} } } }),
      execute: async () => "ok",
    });
    const result = handleTools({ toolRegistry: registry } as any, "list");
    expect(result.content).toContain("x [files[U+202E]]");
  });

  it("/tools with an unknown argument errors and does not toggle", () => {
    const agent = makeMockAgent({ hideTools: false });
    const result = handleTools(agent as any, "bogus");
    expect(result.action).toBe(ACTIONS.ERROR);
    expect(agent.hideTools).toBe(false);
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

  it("handleUndo drops the last turn, byte-identical turn envelope (turn-based stays)", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const result = await handleUndo(agent);
    expect(result.action).toBe(ACTIONS.DISPLAY);
    expect(result.content).toBe("Rewound 1 turn (1 turn remains).");
    expect(rewindContext).toHaveBeenCalledTimes(1);
    expect(rewindContext.mock.calls[0]![0].map((m) => m.content)).toEqual(["u1", "a1"]);
  });

  it("bare /rewind is exactly /rewind -1: same resolver, byte-identical envelope", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const bare = await handleRewind(agent, null);
    const keptBare = rewindContext.mock.calls[0]![0];

    const exp = makeRewindAgent();
    const explicit = await handleRewind(exp.agent, "-1");
    const keptExplicit = exp.rewindContext.mock.calls[0]![0];

    expect(bare).toEqual(explicit);
    expect(bare.content).toBe("Rewound 1 visible message (now at #3).");
    expect(keptBare.map((m) => m.content)).toEqual(keptExplicit.map((m) => m.content));
    expect(keptBare.map((m) => m.content)).toEqual(["u1", "a1", "u2"]);
  });

  it("/rewind N cuts to absolute visible message #N (bare N carries the index)", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const result = await handleRewind(agent, "2");
    expect(rewindContext.mock.calls[0]![0].map((m) => m.content)).toEqual(["u1", "a1"]);
    expect(result.content).toContain("Rewound to message #2 (dropped 2 visible messages)");
  });

  it("/rewind #N is sugar for /rewind N: byte-identical envelope and kept context", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const hash = await handleRewind(agent, "#2");
    const exp = makeRewindAgent();
    const plain = await handleRewind(exp.agent, "2");
    expect(hash).toEqual(plain);
    expect(rewindContext.mock.calls[0]![0].map((m) => m.content)).toEqual(["u1", "a1"]);
  });

  it("bare-N keeps the former index-N wording byte-for-byte (the index moved into bare N)", async () => {
    const { agent } = makeRewindAgent();
    expect((await handleRewind(agent, "1")).content).toBe("Rewound to message #1 (dropped 3 visible messages).");
    expect((await handleRewind(agent, "2")).content).toBe("Rewound to message #2 (dropped 2 visible messages).");
  });

  it("N at the newest visible message is an honest no-op", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const result = await handleRewind(agent, "4");
    expect(rewindContext).not.toHaveBeenCalled();
    expect(result.content).toContain("Nothing to rewind");
  });

  it("zero and out-of-range targets error, naming the valid range, cutting nothing", async () => {
    for (const arg of ["0", "9", "-0", "-9"]) {
      const { agent, rewindContext } = makeRewindAgent();
      const result = await handleRewind(agent, arg);
      expect(result.action).toBe(ACTIONS.ERROR);
      expect(result.error).toContain("#1-#4");
      expect(rewindContext).not.toHaveBeenCalled();
    }
  });

  it("the retired 'index' keyword is an invalid argument, not an alias", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const result = await handleRewind(agent, "index 2");
    expect(result.action).toBe(ACTIONS.ERROR);
    expect(result.error).toBe("Invalid argument: 'index 2'. Usage: /rewind [-N | N]");
    expect(rewindContext).not.toHaveBeenCalled();
  });

  it("rejects anything else the grammar does not name, with the usage tail", async () => {
    for (const arg of ["lots", "-1 extra", "2 please", "-x", "1.5", "index 2 please"]) {
      const { agent, rewindContext } = makeRewindAgent();
      const result = await handleRewind(agent, arg);
      expect(result.action).toBe(ACTIONS.ERROR);
      expect(result.error).toBe(`Invalid argument: '${arg}'. Usage: /rewind [-N | N]`);
      expect(rewindContext).not.toHaveBeenCalled();
    }
  });

  it("reports nothing to rewind when no user turns exist (/undo path)", async () => {
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

  // ── Message-index cuts: the visible index, not turns ──

  it("/rewind -N cuts N visible messages (messages, not turns)", async () => {
    const { agent, rewindContext } = makeRewindAgent();
    const result = await handleRewind(agent, "-1");
    expect(rewindContext).toHaveBeenCalledTimes(1);
    expect(rewindContext.mock.calls[0]![0].map((m) => m.content)).toEqual(["u1", "a1", "u2"]);
    expect(result.content).toContain("Rewound 1 visible message (now at #3)");
  });
});

// ── Stray-free cut (owner ruling): nothing trails the kept boundary ────────
// A transcript loaded with everything that can dangle: answered tool blocks,
// harness notices between turns, and traffic after the newest message.
// Visible: u1#1 a1#2 a2#3 u2#4 a3#5.

function strayConvo() {
  const call = (id: string) => ({ id, type: "function", function: { name: "t", arguments: "{}" } });
  return [
    { role: "system", content: "sys" },
    { role: "user", content: "u1" },
    { role: "assistant", content: "a1", toolCalls: [call("c1")] },
    { role: "tool", content: "t1", toolCallId: "c1" },
    { role: "harness", content: "nudge" },
    { role: "assistant", content: "a2", toolCalls: [call("c2")] },
    { role: "tool", content: "t2", toolCallId: "c2" },
    { role: "harness", content: "loop-detect" },
    { role: "user", content: "u2" },
    { role: "assistant", content: "a3" },
    { role: "harness", content: "trailing notice" },
  ];
}

describe("stray-free cut: kept ends at the documented boundary", () => {
  function makeStrayAgent() {
    const rewindContext = mock((kept: Array<{ role: string; content: unknown }>) => {
      void kept;
    });
    const agent = makeMockAgent({
      getMessages: () => strayConvo(),
      rewindContext,
    }) as never;
    return { agent, rewindContext };
  }

  const keptContents = (rewindContext: ReturnType<typeof mock>) =>
    (rewindContext.mock.calls[0]![0] as Array<{ content: string }>).map((m) => m.content);

  it("/rewind N keeps the addressed message's answered block and sweeps the rest", async () => {
    const { agent, rewindContext } = makeStrayAgent();
    await handleRewind(agent, "2");
    // a1's answered result t1 rides with it; the harness nudge after the
    // block, the second call chain, u2, a3 and the trailing notice all go.
    expect(keptContents(rewindContext)).toEqual(["sys", "u1", "a1", "t1"]);
  });

  it("/rewind -N sweeps trailing harness entries off the back-cut boundary", async () => {
    const { agent, rewindContext } = makeStrayAgent();
    await handleRewind(agent, "-3");
    expect(keptContents(rewindContext)).toEqual(["sys", "u1", "a1", "t1"]);
  });

  it("bare /rewind keeps the context ending exactly at the last visible message", async () => {
    const { agent, rewindContext } = makeStrayAgent();
    await handleRewind(agent, null);
    const kept = rewindContext.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    expect(kept.map((m) => m.content)).toEqual([
      "sys", "u1", "a1", "t1", "nudge", "a2", "t2", "loop-detect", "u2",
    ]);
    expect(kept[kept.length - 1]!.content).toBe("u2");
    expect(kept[kept.length - 1]!.role).toBe("user");
  });

  it("/undo sweeps the same trailing cruft off the dropped turn", async () => {
    const { agent, rewindContext } = makeStrayAgent();
    const result = await handleUndo(agent);
    expect(result.content).toBe("Rewound 1 turn (1 turn remains).");
    const kept = rewindContext.mock.calls[0]![0] as Array<{ role: string; content: string }>;
    // The turn walk cut before u2; the "loop-detect" harness entry that sat
    // between a2's answered block and u2 is swept too: kept ends at t2.
    expect(kept.map((m) => m.content)).toEqual([
      "sys", "u1", "a1", "t1", "nudge", "a2", "t2",
    ]);
    expect(kept[kept.length - 1]!.role).toBe("tool");
    expect(kept.some((m) => m.role === "harness" && m.content === "loop-detect")).toBe(false);
  });

  it("an orphan tool result and notice after the target never survive the cut", async () => {
    const rewindContext = mock((kept: Array<{ content: unknown }>) => {
      void kept;
    });
    const agent = makeMockAgent({
      getMessages: () => [
        { role: "user", content: "u1" }, //                #1
        { role: "assistant", content: "a1" }, //           #2 (no calls)
        { role: "tool", content: "orphan", toolCallId: "gone" },
        { role: "harness", content: "reminder" },
      ],
      rewindContext,
    }) as never;
    await handleRewind(agent, "1");
    expect((rewindContext.mock.calls[0]![0] as Array<{ content: string }>).map((m) => m.content)).toEqual(["u1"]);
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

  it("parses a leading index plus prompt (bare N = visible message #N)", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", branchAfter: 2 }));
    const result = await handleFork(makeForkAgent(forkSession), "2   try this thing");
    expect(forkSession).toHaveBeenCalledWith({ cut: { kind: "index", index: 2 } });
    expect(result.content).toContain("src-session → new-session");
    expect(result.content).toContain("branched after message #2");
    expect(result.content).toContain("Prompt sent");
  });

  it("a digit-first prompt parses as the index spec (accepted limitation)", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", branchAfter: 404 }));
    const result = await handleFork(makeForkAgent(forkSession), "404 handling");
    expect(forkSession).toHaveBeenCalledWith({ cut: { kind: "index", index: 404 } });
    expect(result.content).toContain("branched after message #404");
    expect(result.content).toContain("Prompt sent");
  });

  it("treats a non-numeric first token as the prompt", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", branchAfter: null }));
    await handleFork(makeForkAgent(forkSession), "go deeper 2");
    expect(forkSession).toHaveBeenCalledWith({ cut: { kind: "head" } });
  });

  it("supports a bare fork (full copy, no prompt)", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", branchAfter: null }));
    const result = await handleFork(makeForkAgent(forkSession), null);
    expect(forkSession).toHaveBeenCalledWith({ cut: { kind: "head" } });
    expect(result.content).toContain("branched the full context");
    expect(result.content).not.toContain("Prompt sent");
  });

  it("an index count alone is not treated as a prompt", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", branchAfter: 3 }));
    await handleFork(makeForkAgent(forkSession), "3");
    expect(forkSession).toHaveBeenCalledWith({ cut: { kind: "index", index: 3 } });
  });

  it("message cuts (-N, bare N) carry the prompt half and report the boundary", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", branchAfter: 5 }));
    const r1 = await handleFork(makeForkAgent(forkSession), "-3 investigate this");
    expect(forkSession).toHaveBeenLastCalledWith({ cut: { kind: "back", messages: 3 } });
    expect(r1.content).toContain("branched 3 messages back, after #5");
    expect(r1.content).toContain("Prompt sent");

    const r2 = await handleFork(makeForkAgent(forkSession), "5");
    expect(forkSession).toHaveBeenLastCalledWith({ cut: { kind: "index", index: 5 } });
    expect(r2.content).toContain("branched after message #5");
    expect(r2.content).not.toContain("Prompt sent");
  });

  it("a back cut that drops every visible message reports it honestly", async () => {
    const forkSession = mock(async () => ({ sessionId: "new-session", branchAfter: null }));
    const result = await handleFork(makeForkAgent(forkSession), "-9");
    expect(forkSession).toHaveBeenCalledWith({ cut: { kind: "back", messages: 9 } });
    expect(result.content).toContain("every visible message dropped");
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
  it("splits a leading index from the prompt (bare N = visible message #N)", () => {
    expect(parseForkArg("2 try this")).toEqual({ cut: { kind: "index", index: 2 }, prompt: "try this" });
  });

  it("#N is sugar for the absolute form: identical cut, prompt split intact", () => {
    expect(parseForkArg("#5")).toEqual(parseForkArg("5"));
    expect(parseForkArg("#5 try this")).toEqual(parseForkArg("5 try this"));
    expect(parseForkArg("#5 try this")).toEqual({ cut: { kind: "index", index: 5 }, prompt: "try this" });
    // The hash only heads the absolute form: "-#5" and a hash without a
    // number stay prompt bytes on fork, never a spec.
    expect(parseForkArg("-#5 go")).toEqual({ cut: { kind: "head" }, prompt: "-#5 go" });
    expect(parseForkArg("# go")).toEqual({ cut: { kind: "head" }, prompt: "# go" });
    expect(parseForkArg("#5x")).toEqual({ cut: { kind: "head" }, prompt: "#5x" });
  });

  it("a prompt whose first token is a digit parses as the index spec", () => {
    // Accepted, documented consequence of the bare-N grammar: "/fork 404
    // handling" is index 404 with prompt "handling", not a prompt
    // "404 handling" (docs/cli-reference.md).
    expect(parseForkArg("404 handling")).toEqual({ cut: { kind: "index", index: 404 }, prompt: "handling" });
  });

  it("treats a bare count as an index target with no prompt", () => {
    expect(parseForkArg("3")).toEqual({ cut: { kind: "index", index: 3 }, prompt: undefined });
  });

  it("takes -N as a messages-back cut with the rest as prompt", () => {
    expect(parseForkArg("-2 try this")).toEqual({ cut: { kind: "back", messages: 2 }, prompt: "try this" });
    expect(parseForkArg("-2")).toEqual({ cut: { kind: "back", messages: 2 }, prompt: undefined });
  });

  it("the retired 'index' keyword is ordinary prompt text now", () => {
    expect(parseForkArg("index 7 try this")).toEqual({ cut: { kind: "head" }, prompt: "index 7 try this" });
    expect(parseForkArg("index 7")).toEqual({ cut: { kind: "head" }, prompt: "index 7" });
  });

  it("defaults to a head fork for a prompt-only arg", () => {
    expect(parseForkArg("go deeper 2")).toEqual({ cut: { kind: "head" }, prompt: "go deeper 2" });
  });

  it("empty arg yields a head fork and no prompt", () => {
    expect(parseForkArg("   ")).toEqual({ cut: { kind: "head" }, prompt: undefined });
  });

  it("keeps multi-line prompts verbatim (trimmed)", () => {
    expect(parseForkArg("1  do a\n b").prompt).toBe("do a\n b");
    expect(parseForkArg("-1  do a\n b")).toEqual({ cut: { kind: "back", messages: 1 }, prompt: "do a\n b" });
  });
});
