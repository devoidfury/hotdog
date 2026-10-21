// Tests for AsyncInteractiveCliInput — the Input interface for interactive CLI.
// NoopInput is tested in core/input.test.ts.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AsyncInteractiveCliInput } from "@extensions/ui-interactive-cli/index.ts";
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

  it("allows free text with allowOther (default)", async () => {
    const { rl } = createMockRl(["purple"]);
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "color", prompt: "Pick a color", options: ["red", "green", "blue"], allowOther: true }]);
    expect(answers.color).toBe("purple");
  });

  it("rejects invalid option when allowOther is false", async () => {
    const { rl } = createMockRl(["purple", "2"]); // first rejected, second valid
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "color", prompt: "Pick a color", options: ["red", "green", "blue"], allowOther: false }]);
    expect(answers.color).toBe("green");
  });

  it("strict options reject an out-of-range number", async () => {
    const { rl } = createMockRl(["9", "1"]); // "9" is neither an index nor an option
    const answers = await new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h))
      .collectAnswers([{ key: "color", prompt: "Pick a color", options: ["red", "green"], allowOther: false }]);
    expect(answers.color).toBe("red");
  });

  it("strict options still resolve a valid index and option text", async () => {
    const { rl: rl1 } = createMockRl(["2"]);
    const a1 = await new AsyncInteractiveCliInput(rl1, lineHandler, (h) => rl1.on("line", h))
      .collectAnswers([{ key: "c", prompt: "Pick", options: ["red", "green"], allowOther: false }]);
    expect(a1.c).toBe("green");

    const { rl: rl2 } = createMockRl(["red"]);
    const a2 = await new AsyncInteractiveCliInput(rl2, lineHandler, (h) => rl2.on("line", h))
      .collectAnswers([{ key: "c", prompt: "Pick", options: ["red", "green"], allowOther: false }]);
    expect(a2.c).toBe("red");
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

  it("Q-CANCEL-1: abort mid-question releases the takeover; the next line reaches the main handler", async () => {
    const { rl, addedHandlers } = createMockRl([]); // nothing queued: the question hangs
    const received: string[] = [];
    const main = (line: string) => {
      received.push(line);
    };
    const ac = new AbortController();

    const pending = new AsyncInteractiveCliInput(rl, main, (h) => rl.on("line", h))
      .collectAnswers([{ key: "q", prompt: "Q?", required: false }], ac.signal);
    await new Promise((r) => setTimeout(r, 5)); // let the wait register its one-shot listener

    ac.abort(); // the interrupt: abort must win the race
    const answers = await pending; // partial answers resolve, never reject
    expect(answers).toEqual({});
    // The pending one-shot detached and the main handler re-attached:
    // exactly one line listener remains, the session's own.
    expect(addedHandlers.length).toBe(1);
    expect(addedHandlers[0]).toBe(main);

    // The line typed after the interrupt flows to the normal handler,
    // never into the dead question loop.
    (addedHandlers[0] as (line: string) => void)("/quit");
    expect(received).toEqual(["/quit"]);
  });
});
