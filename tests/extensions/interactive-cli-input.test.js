// Tests for AsyncInteractiveCliInput — the Input interface for interactive CLI.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { AsyncInteractiveCliInput } from "../../src/extensions/ui-interactive-cli/index.js";
import { NoopInput } from "../../src/core/context/input.js";

describe("NoopInput", () => {
  it("is not interactive", () => {
    const input = new NoopInput();
    expect(input.isInteractive()).toBe(false);
  });

  it("returns defaults for all questions", () => {
    const input = new NoopInput();
    const answers = input.collectAnswers([
      { key: "name", prompt: "Name?", default: "Anonymous" },
      { key: "notes", prompt: "Notes?" },
    ]);
    expect(answers.name).toBe("Anonymous");
    expect(answers.notes).toBe("");
  });
});

/**
 * Create a mock readline that queues responses.
 * Each call to rl.question will consume the next response from the queue.
 */
function createMockRl(responses = []) {
  let responseIndex = 0;
  const addedHandlers = [];

  const rl = {
    removeListener: function () {},
    question: function (prompt, cb) {
      // Immediately invoke callback with next queued response
      if (responseIndex < responses.length) {
        cb(responses[responseIndex]);
        responseIndex++;
      }
    },
    on: function (event, handler) {
      if (event === "line") addedHandlers.push(handler);
    },
  };

  return { rl, addedHandlers };
}

describe("AsyncInteractiveCliInput", () => {
  let lineHandler;

  beforeEach(() => {
    lineHandler = function () {};
  });

  it("is interactive", () => {
    const { rl } = createMockRl();
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));
    expect(input.isInteractive()).toBe(true);
  });

  it("collects answers for a single question", async () => {
    const { rl, addedHandlers } = createMockRl(["Alice"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      { key: "name", prompt: "What is your name?", default: "Anonymous" },
    ]);

    expect(answers.name).toBe("Alice");
  });

  it("uses default when user presses enter", async () => {
    const { rl } = createMockRl([""]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      { key: "name", prompt: "What is your name?", default: "Anonymous" },
    ]);

    expect(answers.name).toBe("Anonymous");
  });

  it("collects answers for multiple questions", async () => {
    const { rl } = createMockRl(["Alice", "30"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      { key: "name", prompt: "Name?" },
      { key: "age", prompt: "Age?" },
    ]);

    expect(answers.name).toBe("Alice");
    expect(answers.age).toBe("30");
  });

  it("handles option selection by number", async () => {
    const { rl } = createMockRl(["2"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      {
        key: "color",
        prompt: "Pick a color",
        options: ["red", "green", "blue"],
      },
    ]);

    expect(answers.color).toBe("green");
  });

  it("handles option selection by text", async () => {
    const { rl } = createMockRl(["blue"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      {
        key: "color",
        prompt: "Pick a color",
        options: ["red", "green", "blue"],
      },
    ]);

    expect(answers.color).toBe("blue");
  });

  it("allows free text with allow_other (default)", async () => {
    const { rl } = createMockRl(["purple"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      {
        key: "color",
        prompt: "Pick a color",
        options: ["red", "green", "blue"],
        allow_other: true,
      },
    ]);

    expect(answers.color).toBe("purple");
  });

  it("rejects invalid option when allow_other is false", async () => {
    // First response is invalid, second is valid
    const { rl } = createMockRl(["purple", "2"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      {
        key: "color",
        prompt: "Pick a color",
        options: ["red", "green", "blue"],
        allow_other: false,
      },
    ]);

    expect(answers.color).toBe("green");
  });

  it("requires answer when required is true", async () => {
    // First response is empty (rejected), second is valid
    const { rl } = createMockRl(["", "Alice"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      { key: "name", prompt: "Name?", required: true },
    ]);

    expect(answers.name).toBe("Alice");
  });

  it("allows empty answer when required is false", async () => {
    const { rl } = createMockRl([""]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      { key: "notes", prompt: "Notes?", required: false },
    ]);

    expect(answers.notes).toBe("");
  });

  it("restores line handler after collecting answers", async () => {
    const { rl, addedHandlers } = createMockRl(["answer"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    await input.collectAnswers([{ key: "a", prompt: "Q?" }]);

    // Verify line handler was re-added
    expect(addedHandlers.length).toBe(1);
    expect(addedHandlers[0]).toBe(lineHandler);
  });
});
