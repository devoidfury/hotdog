import { describe, it, expect } from "bun:test";
import {
  formatCompacting,
  formatToolCall,
  formatToolResult,
  formatTokenUsage,
  formatThinking,
  formatTaskProgress,
} from "../../src/core/ui/cli.js";

describe("formatCompacting", () => {
  it("formats compacting message", () => {
    expect(formatCompacting(10, 5)).toBe(
      "Compacting: removed 10 messages, keeping 5 recent",
    );
  });

  it("handles zero values", () => {
    expect(formatCompacting(0, 5)).toBe(
      "Compacting: removed 0 messages, keeping 5 recent",
    );
  });
});

describe("formatToolCall", () => {
  it("formats with default formatter", () => {
    expect(formatToolCall("bash", '{"cmd":"ls"}')).toBe(
      '  → bash {"cmd":"ls"}',
    );
  });

  it("formats with custom formatter", () => {
    expect(formatToolCall("bash", '{"cmd":"ls"}', "[{}] -> {}")).toBe(
      '[bash] -> {"cmd":"ls"}',
    );
  });
});

describe("formatToolResult", () => {
  it("formats with default formatter", () => {
    expect(formatToolResult("output here")).toBe("----\noutput here\n----");
  });

  it("formats with custom formatter", () => {
    expect(formatToolResult("output here", "Result: {}")).toBe(
      "Result: output here",
    );
  });
});

describe("formatTokenUsage", () => {
  it("formats token usage correctly", () => {
    expect(formatTokenUsage(100, 50, 200, 350)).toBe(
      "(tokens cached:50 prompt:50 completion:200 total:350)\n",
    );
  });

  it("handles large numbers", () => {
    expect(formatTokenUsage(10000, 6000, 20000, 35000)).toBe(
      "(tokens cached:6000 prompt:4000 completion:20000 total:35000)\n",
    );
  });
});

describe("formatThinking", () => {
  it("formats with default formatter", () => {
    expect(formatThinking("Let me think about this")).toBe(
      "[Thinking: Let me think about this]",
    );
  });

  it("formats with custom formatter", () => {
    expect(formatThinking("Let me think", "🤔 {}")).toBe("🤔 Let me think");
  });
});

describe("formatTaskProgress", () => {
  it("returns empty for zero active tasks", () => {
    expect(formatTaskProgress(0, 0)).toBe("");
  });

  it("returns singular when one task", () => {
    expect(formatTaskProgress(1, 0)).toBe("1 task running");
  });

  it("returns plural when multiple tasks", () => {
    expect(formatTaskProgress(3, 0)).toBe("3 tasks running");
  });

  it("shows ratio when total provided", () => {
    expect(formatTaskProgress(2, 5)).toBe("2/5 tasks");
  });
});
