import { describe, it, expect, mock } from "bun:test";
import { Command } from "../../src/core/commands.ts";
import {
  handleClear,
  handleQuit,
  handleHelp,
  handleTokens,
  handleTools,
  handleThinking,
  handleRegenerate,
  handleReasoning,
  CORE_COMMAND_HANDLERS,
} from "../../src/core/command-handlers.ts";

// ── Handler Tests ──────────────────────────────────────────────────────

describe("handleClear", () => {
  it("clears context and returns message", async () => {
    const agent = {
      clearContext: mock(async () => {}),
    };
    const result = await handleClear(agent, null);
    expect(result.content).toBe("Context cleared.");
    expect(agent.clearContext).toHaveBeenCalled();
  });
});

describe("handleQuit", () => {
  it("returns UI quit command error", () => {
    const result = handleQuit();
    expect(result.error).toBe("UI command: quit");
  });
});

describe("handleHelp", () => {
  it("returns UI help command error", () => {
    const result = handleHelp();
    expect(result.error).toBe("UI command: help");
  });
});

describe("handleTokens", () => {
  it("returns no-usage message when no turns recorded", () => {
    const agent = {
      getTokenUsage: mock(() => ({
        promptTokens: 0,
        cachedTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        turns: 0,
        lastPromptTokens: 0,
        lastCachedTokens: 0,
        lastCompletionTokens: 0,
        lastTotalTokens: 0,
      })),
    };
    const result = handleTokens(agent);
    expect(result.content).toContain("No token usage recorded");
  });

  it("displays accumulated totals with real prompt (prompt - cached)", () => {
    const agent = {
      getTokenUsage: mock(() => ({
        // Accumulated: 2 calls, each with prompt=1000, cached=400, completion=200
        promptTokens: 1200, // (1000-400) + (1000-400) = 1200 real prompt
        cachedTokens: 800, // 400 + 400
        completionTokens: 400, // 200 + 200
        totalTokens: 2400, // 1200 + 800 + 400
        turns: 2,
        // Last-reported from the most recent provider call
        lastPromptTokens: 1000,
        lastCachedTokens: 400,
        lastCompletionTokens: 200,
        lastTotalTokens: 1600,
      })),
    };
    const result = handleTokens(agent);
    expect(result.content).toContain("Token usage (2 turns):");
    expect(result.content).toContain("prompt:      1,200 tokens");
    expect(result.content).toContain("cached:      800 tokens");
    expect(result.content).toContain("completion:  400 tokens");
    expect(result.content).toContain("total:       2,400 tokens");
    // cache hit: 800 / (1200 + 800) = 40.0%
    expect(result.content).toContain("cache hit:   40.0% of prompt tokens");
    expect(result.content).toContain("Last call:");
    expect(result.content).toContain("prompt:      1,000 tokens");
    expect(result.content).toContain("cached:      400 tokens");
    expect(result.content).toContain("completion:  200 tokens");
    expect(result.content).toContain("total:       1,600 tokens");
  });

  it("handles single turn (no plural)", () => {
    const agent = {
      getTokenUsage: mock(() => ({
        promptTokens: 100,
        cachedTokens: 0,
        completionTokens: 50,
        totalTokens: 150,
        turns: 1,
        lastPromptTokens: 100,
        lastCachedTokens: 0,
        lastCompletionTokens: 50,
        lastTotalTokens: 150,
      })),
    };
    const result = handleTokens(agent);
    expect(result.content).toContain("Token usage (1 turn):");
  });

  it("omits cache hit line when real prompt tokens are zero", () => {
    const agent = {
      getTokenUsage: mock(() => ({
        promptTokens: 0, // all prompt was cached
        cachedTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        turns: 1,
        lastPromptTokens: 100,
        lastCachedTokens: 100,
        lastCompletionTokens: 50,
        lastTotalTokens: 150,
      })),
    };
    const result = handleTokens(agent);
    expect(result.content).not.toContain("cache hit");
  });
});

describe("handleTools", () => {
  it("toggles hideTools from false to true", () => {
    const outputs: Array<{type: string; data: Record<string, unknown>}> = [];
    const agent = {
      hideTools: false,
      emitOutput: mock((type: string, data: Record<string, unknown>) => outputs.push({ type, data })),
    };
    const result = handleTools(agent);
    expect(agent.hideTools).toBe(true);
    expect(result.content).toContain("hidden");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].data.key).toBe("hideTools");
  });

  it("toggles hideTools from true to false", () => {
    const outputs: Array<{type: string; data: Record<string, unknown>}> = [];
    const agent = {
      hideTools: true,
      emitOutput: mock((type: string, data: Record<string, unknown>) => outputs.push({ type, data })),
    };
    const result = handleTools(agent);
    expect(agent.hideTools).toBe(false);
    expect(result.content).toContain("shown");
  });
});

describe("handleThinking", () => {
  it("toggles hideThinking from false to true", () => {
    const outputs: Array<{type: string; data: Record<string, unknown>}> = [];
    const agent = {
      hideThinking: false,
      emitOutput: mock((type: string, data: Record<string, unknown>) => outputs.push({ type, data })),
    };
    const result = handleThinking(agent);
    expect(agent.hideThinking).toBe(true);
    expect(result.content).toContain("hidden");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].data.key).toBe("hideThinking");
  });

  it("toggles hideThinking from true to false", () => {
    const outputs: Array<{type: string; data: Record<string, unknown>}> = [];
    const agent = {
      hideThinking: true,
      emitOutput: mock((type: string, data: Record<string, unknown>) => outputs.push({ type, data })),
    };
    const result = handleThinking(agent);
    expect(agent.hideThinking).toBe(false);
    expect(result.content).toContain("shown");
  });
});

describe("handleRegenerate", () => {
  it("regenerates system prompt", async () => {
    const agent = {
      systemPrompt: "old prompt",
      ensureSystemPrompt: mock(async () => {}),
    };
    const result = await handleRegenerate(agent);
    expect(agent.systemPrompt).toBeNull();
    expect(agent.ensureSystemPrompt).toHaveBeenCalled();
    expect(result.content).toBe("System prompt regenerated.");
  });
});

describe("handleReasoning", () => {
  it("shows current reasoning effort when no value given", () => {
    const agent = { reasoningEffort: "high" };
    const result = handleReasoning(agent, "");
    expect(result.content).toContain("high");
  });

  it("shows '(not set)' when reasoning effort is undefined", () => {
    const agent = { reasoningEffort: undefined };
    const result = handleReasoning(agent, "");
    expect(result.content).toContain("not set");
  });

  it("sets reasoning effort to valid value", () => {
    const agent = { reasoningEffort: undefined };
    const result = handleReasoning(agent, "low");
    expect(agent.reasoningEffort).toBe("low");
    expect(result.content).toContain("low");
  });

  it("handles all valid values", () => {
    const valid = ["none", "minimal", "low", "high", "xhigh", "max"];
    for (const v of valid) {
      const agent = {};
      const result = handleReasoning(agent, v);
      expect(agent.reasoningEffort).toBe(v);
      expect(result.content).toContain(v);
    }
  });

  it("unsets reasoning effort", () => {
    const agent = { reasoningEffort: "high" };
    const result = handleReasoning(agent, "unset");
    expect(agent.reasoningEffort).toBeUndefined();
    expect(result.content).toContain("unset");
  });

  it("returns error for invalid value", () => {
    const agent = {};
    const result = handleReasoning(agent, "invalid");
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

  it("UI commands are marked as isUiCommand", () => {
    expect(CORE_COMMAND_HANDLERS[Command.Quit].isUiCommand).toBe(true);
    expect(CORE_COMMAND_HANDLERS[Command.Help].isUiCommand).toBe(true);
    expect(CORE_COMMAND_HANDLERS[Command.Clear].isUiCommand).toBeUndefined();
  });

  it("handlers have descriptions", () => {
    for (const [, entry] of Object.entries(CORE_COMMAND_HANDLERS)) {
      expect(entry.description).toBeDefined();
      expect(typeof entry.description).toBe("string");
    }
  });
});
