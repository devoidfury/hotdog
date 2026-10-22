import { describe, it, expect } from "bun:test";
import {
  formatCompacting,
  formatToolCall,
  formatToolResult,
  formatTokenUsage,
  formatThinking,
  formatTaskProgress,
} from "@utils/cli/cli.ts";
import { summarizeToolArgs } from "@core/extensions/tool-utils.ts";

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
    expect(formatToolCall("bash", '{"cmd":"ls"}', "  → {} {}")).toBe(
      '  → bash {"cmd":"ls"}',
    );
  });

  it("formats with custom formatter", () => {
    expect(formatToolCall("bash", '{"cmd":"ls"}', "[{}] -> {}")).toBe(
      '[bash] -> {"cmd":"ls"}',
    );
  });
});

describe("summarizeToolArgs", () => {
  it("bares the value of a single-key call", () => {
    expect(summarizeToolArgs('{"command":"ls -la"}')).toBe("ls -la");
  });

  it("renders multi-key calls as k: v pairs", () => {
    expect(summarizeToolArgs('{"path":"a.ts","limit":10}')).toBe("path: a.ts · limit: 10");
  });

  it("summarizes multi-line string values as size, not walls of text", () => {
    expect(summarizeToolArgs('{"path":"a.ts","content":"1\\n2\\n3"}')).toBe(
      "path: a.ts · content: 3 lines, 5 chars",
    );
  });

  it("first-line preview hint folds to the first non-blank line + size stub", () => {
    const hints = { command: { preview: "first-line" as const } };
    expect(summarizeToolArgs('{"command":"git status\\n&& git diff"}', undefined, hints)).toBe(
      "git status… (2 lines, 22 chars)",
    );
    // Blank leading line skipped; single-line values are already one line.
    expect(summarizeToolArgs('{"command":"\\n  echo hi"}', undefined, hints)).toBe("echo hi… (2 lines, 10 chars)");
    // Other keys keep the count stub; a hint for a different key changes nothing.
    expect(summarizeToolArgs('{"path":"a\\nb"}', undefined, hints)).toBe("2 lines, 3 chars");
  });

  it("compacts nested values and truncates long ones", () => {
    expect(summarizeToolArgs('{"opts":{"deep":true,"x":[1,2,3]}}')).toBe('{"deep":true,"x":[1,2,3]}');
    const long = JSON.stringify({ list: Array.from({ length: 40 }, (_, i) => i) });
    const out = summarizeToolArgs(long);
    expect(out.length).toBe(60);
    expect(out.endsWith("…")).toBe(true);
  });

  it("passes unparseable input through (a malformed call shows what it sent)", () => {
    expect(summarizeToolArgs("not json {{")).toBe("not json {{");
  });

  it("handles empty input and non-object JSON", () => {
    expect(summarizeToolArgs("")).toBe("");
    expect(summarizeToolArgs('"hi"')).toBe("hi");
    expect(summarizeToolArgs("42")).toBe("42");
    expect(summarizeToolArgs("null")).toBe("null");
  });

  it("accepts object and null input shapes", () => {
    expect(summarizeToolArgs({ command: "ls" })).toBe("ls");
    expect(summarizeToolArgs({ a: 1, b: 2 })).toBe("a: 1 · b: 2");
    expect(summarizeToolArgs(null)).toBe("");
  });

  it("routes entry values through the sink-side transform; chrome untouched", () => {
    const out = summarizeToolArgs('{"command":"ls -l","timeoutMs":5000}', (k, r, v) =>
      k === "command" ? `[${r}]` : `${r}<${typeof v}>`,
    );
    // Keys and the " · " separator bypass the transform; it sees each
    // value (post-fold) plus the original entry value.
    expect(out).toBe("command: [ls -l] · timeoutMs: 5000<number>");
  });

  it("bares a single key but still routes its value through the transform", () => {
    expect(summarizeToolArgs('{"command":"ls"}', (k, r) => `${k}=${r}`)).toBe("command=ls");
  });

  it("never calls the transform on passthrough, scalar, or null input", () => {
    let calls = 0;
    const t = (_k: string, r: string): string => {
      calls++;
      return r;
    };
    expect(summarizeToolArgs("not json {{", t)).toBe("not json {{");
    expect(summarizeToolArgs("42", t)).toBe("42");
    expect(summarizeToolArgs(null, t)).toBe("");
    expect(calls).toBe(0);
  });
});

describe("formatToolResult", () => {
  it("formats with default formatter", () => {
    expect(formatToolResult("output here", "----\n{}\n----")).toBe(
      "----\noutput here\n----",
    );
  });

  it("formats with custom formatter", () => {
    expect(formatToolResult("output here", "Result: {}")).toBe(
      "Result: output here",
    );
  });
});

describe("formatTokenUsage", () => {
  it("formats token usage correctly", () => {
    expect(formatTokenUsage(100, 50, 200, 350, 1000)).toBe(
      "Token usage: 50 cached, 100 processed, 200 generated. (350/1000)",
    );
  });

  it("handles large numbers", () => {
    expect(formatTokenUsage(10000, 6000, 20000, 35000, 128000)).toBe(
      "Token usage: 6000 cached, 10000 processed, 20000 generated. (35000/128000)",
    );
  });
});

describe("formatThinking", () => {
  it("formats with default formatter", () => {
    expect(formatThinking("Let me think about this", null)).toBe(
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
