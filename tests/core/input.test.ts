// Tests for core/context/input.ts — NoopInput.

import { describe, it, expect } from "bun:test";
import { NoopInput } from "../../src/core/context/input.ts";

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
