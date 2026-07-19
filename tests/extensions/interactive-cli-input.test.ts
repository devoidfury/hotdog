// Tests for AsyncInteractiveCliInput — the Input interface for interactive CLI.
// NoopInput is tested in core/input.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import readline from "readline";
import { AsyncInteractiveCliInput } from "../../src/extensions/ui-interactive-cli/index.ts";
import { createMockRl } from "../helpers.ts";

describe("AsyncInteractiveCliInput", () => {
  let lineHandler: (line: string) => void;
  let origStdout: typeof process.stdout.write;
  let origStderr: typeof process.stderr.write;

  beforeEach(() => {
    lineHandler = function () {};
    origStdout = process.stdout.write;
    origStderr = process.stderr.write;
    process.stdout.write = () => true;
    process.stderr.write = () => true;
  });

  afterEach(() => {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  });

  it("is interactive", () => {
    const { rl } = createMockRl();
    expect(new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h)).isInteractive()).toBe(true);
  });

  it("collects answers for a single question", async () => {
    const { rl } = createMockRl(["Alice"]);
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "name", prompt: "What is your name?", default: "Anonymous" }]);
    expect(answers.name).toBe("Alice");
  });

  it("uses default when user presses enter", async () => {
    const { rl } = createMockRl([""]);
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "name", prompt: "What is your name?", default: "Anonymous" }]);
    expect(answers.name).toBe("Anonymous");
  });

  it("collects answers for multiple questions", async () => {
    const { rl } = createMockRl(["Alice", "30"]);
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([
        { key: "name", prompt: "Name?" },
        { key: "age", prompt: "Age?" },
      ]);
    expect(answers.name).toBe("Alice");
    expect(answers.age).toBe("30");
  });

  it("handles option selection by number and text", async () => {
    const { rl: rl1 } = createMockRl(["2"]);
    const answers1 = await new AsyncInteractiveCliInput(rl1, lineHandler, (h) => rl1.on("line", h))
      .collectAnswers([{ key: "color", prompt: "Pick a color", options: ["red", "green", "blue"] }]);
    expect(answers1.color).toBe("green");

    const { rl: rl2 } = createMockRl(["blue"]);
    const answers2 = await new AsyncInteractiveCliInput(rl2, lineHandler, (h) => rl2.on("line", h))
      .collectAnswers([{ key: "color", prompt: "Pick a color", options: ["red", "green", "blue"] }]);
    expect(answers2.color).toBe("blue");
  });

  it("allows free text with allow_other (default)", async () => {
    const { rl } = createMockRl(["purple"]);
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "color", prompt: "Pick a color", options: ["red", "green", "blue"], allow_other: true }]);
    expect(answers.color).toBe("purple");
  });

  it("rejects invalid option when allow_other is false", async () => {
    const { rl } = createMockRl(["purple", "2"]); // first rejected, second valid
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "color", prompt: "Pick a color", options: ["red", "green", "blue"], allow_other: false }]);
    expect(answers.color).toBe("green");
  });

  it("requires answer when required is true", async () => {
    const { rl } = createMockRl(["", "Alice"]); // first empty rejected, second valid
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "name", prompt: "Name?", required: true }]);
    expect(answers.name).toBe("Alice");
  });

  it("allows empty answer when required is false", async () => {
    const { rl } = createMockRl([""]);
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "notes", prompt: "Notes?", required: false }]);
    expect(answers.notes).toBe("");
  });

  it("restores line handler after collecting answers", async () => {
    const { rl, addedHandlers } = createMockRl(["answer"]);
    await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "a", prompt: "Q?" }]);
    expect(addedHandlers.length).toBe(1);
    expect(addedHandlers[0]).toBe(lineHandler);
  });
});
