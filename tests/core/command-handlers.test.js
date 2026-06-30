import { describe, it, expect, mock } from "bun:test";
import { Command } from "../../src/core/commands.js";
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
} from "../../src/core/command-handlers.js";

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
  it("returns token stats placeholder", () => {
    const result = handleTokens();
    expect(result.content).toContain("not yet tracked");
  });
});

describe("handleTools", () => {
  it("toggles hideTools from false to true", () => {
    const outputs = [];
    const agent = {
      hideTools: false,
      _emitOutput: mock((type, data) => outputs.push({ type, data })),
    };
    const result = handleTools(agent);
    expect(agent.hideTools).toBe(true);
    expect(result.content).toContain("hidden");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].data.key).toBe("hideTools");
  });

  it("toggles hideTools from true to false", () => {
    const outputs = [];
    const agent = {
      hideTools: true,
      _emitOutput: mock((type, data) => outputs.push({ type, data })),
    };
    const result = handleTools(agent);
    expect(agent.hideTools).toBe(false);
    expect(result.content).toContain("shown");
  });
});

describe("handleThinking", () => {
  it("toggles hideThinking from false to true", () => {
    const outputs = [];
    const agent = {
      hideThinking: false,
      _emitOutput: mock((type, data) => outputs.push({ type, data })),
    };
    const result = handleThinking(agent);
    expect(agent.hideThinking).toBe(true);
    expect(result.content).toContain("hidden");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].data.key).toBe("hideThinking");
  });

  it("toggles hideThinking from true to false", () => {
    const outputs = [];
    const agent = {
      hideThinking: true,
      _emitOutput: mock((type, data) => outputs.push({ type, data })),
    };
    const result = handleThinking(agent);
    expect(agent.hideThinking).toBe(false);
    expect(result.content).toContain("shown");
  });
});

describe("handleRegenerate", () => {
  it("regenerates system prompt", async () => {
    const agent = {
      _systemPrompt: "old prompt",
      ensureSystemPrompt: mock(async () => {}),
    };
    const result = await handleRegenerate(agent);
    expect(agent._systemPrompt).toBeNull();
    expect(agent.ensureSystemPrompt).toHaveBeenCalled();
    expect(result.content).toBe("System prompt regenerated.");
  });
});

describe("handleReasoning", () => {
  it("shows current reasoning effort when no value given", () => {
    const agent = { _reasoningEffort: "high" };
    const result = handleReasoning(agent, "");
    expect(result.content).toContain("high");
  });

  it("shows '(not set)' when reasoning effort is undefined", () => {
    const agent = { _reasoningEffort: undefined };
    const result = handleReasoning(agent, "");
    expect(result.content).toContain("not set");
  });

  it("sets reasoning effort to valid value", () => {
    const agent = { _reasoningEffort: undefined };
    const result = handleReasoning(agent, "low");
    expect(agent._reasoningEffort).toBe("low");
    expect(result.content).toContain("low");
  });

  it("handles all valid values", () => {
    const valid = ["none", "minimal", "low", "high", "xhigh", "max"];
    for (const v of valid) {
      const agent = {};
      const result = handleReasoning(agent, v);
      expect(agent._reasoningEffort).toBe(v);
      expect(result.content).toContain(v);
    }
  });

  it("unsets reasoning effort", () => {
    const agent = { _reasoningEffort: "high" };
    const result = handleReasoning(agent, "unset");
    expect(agent._reasoningEffort).toBeUndefined();
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
