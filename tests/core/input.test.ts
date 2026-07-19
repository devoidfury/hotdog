// Tests for core/context/input.ts — parseInput, NoopInput.

import { describe, it, expect } from "bun:test";
import { parseInput, NoopInput } from "../../src/core/context/input.ts";

describe("parseInput", () => {
  it("parses plain text input", () => {
    expect(parseInput("hello world")).toEqual({ type: "text", value: "hello world" });
    expect(parseInput("  hello world  ")).toEqual({ type: "text", value: "hello world" });
  });

  it("parses slash commands", () => {
    expect(parseInput("/help")).toEqual({ type: "command", value: "help" });
    expect(parseInput("/quit")).toEqual({ type: "command", value: "quit" });
    expect(parseInput("/clear explorer")).toEqual({ type: "command", value: "clear explorer" });
    expect(parseInput("/  help  ")).toEqual({ type: "command", value: "help" });
  });

  it("handles edge cases", () => {
    expect(parseInput("/")).toEqual({ type: "text", value: "/" });
    expect(parseInput("/ ")).toEqual({ type: "text", value: "/" });
    expect(parseInput("")).toEqual({ type: "text", value: "" });
    expect(parseInput("//not-a-command")).toEqual({ type: "command", value: "/not-a-command" });
    expect(parseInput("hello/world")).toEqual({ type: "text", value: "hello/world" });
  });
});

describe("NoopInput", () => {
  it("returns false for isInteractive", () => {
    expect(new NoopInput().isInteractive()).toBe(false);
  });

  it("collects default answers", () => {
    const answers = new NoopInput().collectAnswers([
      { key: "name", default: "Anonymous" },
      { key: "age", default: "25" },
      { key: "notes" }, // no default
    ]);
    expect(answers).toEqual({ name: "Anonymous", age: "25", notes: "" });
  });

  it("collects answers for empty question list", () => {
    expect(new NoopInput().collectAnswers([])).toEqual({});
  });
});
