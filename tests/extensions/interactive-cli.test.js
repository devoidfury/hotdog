import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { HOOKS } from "../../src/core/hooks.js";
import { AsyncInteractiveCliInput } from "../../src/extensions/ui-interactive-cli/index.js";
import { parseCommand, Command } from "../../src/core/commands.js";
import { createMockCore, createMockRl } from "../helpers.js";

describe("Interactive CLI - create function", () => {
  it("registers cli subcommand via CLI_SUBCOMMANDS_REGISTER hook", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const ext = create(core);

    expect(ext).not.toBeNull();
    expect(ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER]).toBeDefined();

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    expect(core.cliSubcommandRegistry.has("cli")).toBe(true);
    const def = core.cliSubcommandRegistry.get("cli");
    expect(def.handler).toBeDefined();
  });

  it("cli subcommand has correct description", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const ext = create(core);

    await ext.hooks[HOOKS.CLI_SUBCOMMANDS_REGISTER](core.cliSubcommandRegistry);

    const def = core.cliSubcommandRegistry.get("cli");
    expect(def.description).toContain("Interactive");
  });

  it("registers AGENT_TOOL_CONTEXT hook", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const ext = create(core);

    expect(ext.hooks[HOOKS.AGENT_TOOL_CONTEXT]).toBeDefined();
  });

  it("has cleanup function", async () => {
    const core = createMockCore();
    const { create } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const ext = create(core);

    expect(ext.cleanup).toBeDefined();
    expect(typeof ext.cleanup).toBe("function");
  });
});

describe("Interactive CLI - parseCommand for slash commands", () => {
  it("parses 'help' command", () => {
    const cmd = parseCommand("help");
    expect(cmd.type).toBe(Command.Help);
  });

  it("parses 'quit' command", () => {
    const cmd = parseCommand("quit");
    expect(cmd.type).toBe(Command.Quit);
  });

  it("parses 'exit' command", () => {
    const cmd = parseCommand("exit");
    expect(cmd.type).toBe(Command.Quit);
  });

  it("parses 'clear' command", () => {
    const cmd = parseCommand("clear");
    expect(cmd.type).toBe(Command.Clear);
  });

  it("parses 'tools' command", () => {
    const cmd = parseCommand("tools");
    expect(cmd.type).toBe(Command.Tools);
  });

  it("parses 'thinking' command", () => {
    const cmd = parseCommand("thinking");
    expect(cmd.type).toBe(Command.Thinking);
  });

  it("parses 'tokens' command", () => {
    const cmd = parseCommand("tokens");
    expect(cmd.type).toBe(Command.Tokens);
  });

  it("parses 'regenerate' command", () => {
    const cmd = parseCommand("regenerate");
    expect(cmd.type).toBe(Command.Regenerate);
  });

  it("parses 'reasoning' command without value", () => {
    const cmd = parseCommand("reasoning");
    expect(cmd.type).toBe(Command.Reasoning);
    expect(cmd.value).toBeNull();
  });

  it("parses 'reasoning' command with value", () => {
    const cmd = parseCommand("reasoning high");
    expect(cmd.type).toBe(Command.Reasoning);
    expect(cmd.value).toBe("high");
  });

  it("parses unknown command", () => {
    const cmd = parseCommand("unknown-command");
    expect(cmd.type).toBe(Command.Unknown);
    expect(cmd.value).toBe("unknown-command");
  });

  it("parses null command", () => {
    const cmd = parseCommand(null);
    expect(cmd.type).toBe(Command.Unknown);
    expect(cmd.value).toBeNull();
  });

  it("parses empty string command", () => {
    const cmd = parseCommand("");
    expect(cmd.type).toBe(Command.Unknown);
    expect(cmd.value).toBeNull();
  });

  it("parses 'clear' with profile name", () => {
    const cmd = parseCommand("clear default");
    expect(cmd.type).toBe(Command.Clear);
    expect(cmd.value).toBe("default");
  });
});

describe("Interactive CLI - AsyncInteractiveCliInput", () => {
  let lineHandler;
  let origStdout;
  let origStderr;

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
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));
    expect(input.isInteractive()).toBe(true);
  });

  it("collects answers for a single question", async () => {
    const { rl } = createMockRl(["Alice"]);
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

  it("allows free text with allowOther (camelCase)", async () => {
    const { rl } = createMockRl(["purple"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      {
        key: "color",
        prompt: "Pick a color",
        options: ["red", "green", "blue"],
        allowOther: true,
      },
    ]);

    expect(answers.color).toBe("purple");
  });

  it("rejects invalid option when allow_other is false", async () => {
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

    expect(addedHandlers.length).toBe(1);
    expect(addedHandlers[0]).toBe(lineHandler);
  });

  it("restores line handler even when error occurs", async () => {
    const { rl, addedHandlers } = createMockRl([]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    // Mock readline that throws
    rl.question = function (prompt, cb) {
      throw new Error("Simulated error");
    };

    try {
      await input.collectAnswers([
        { key: "name", prompt: "Name?", required: true, default: "default" },
      ]);
    } catch (e) {
      // Expected error
    }

    // Verify line handler was re-added despite error
    expect(addedHandlers.length).toBe(1);
    expect(addedHandlers[0]).toBe(lineHandler);
  });

  it("handles option index out of range", async () => {
    // First response is out of range, second is valid
    const { rl } = createMockRl(["99", "1"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      {
        key: "color",
        prompt: "Pick a color",
        options: ["red", "green", "blue"],
        allow_other: false,
      },
    ]);

    expect(answers.color).toBe("red");
  });

  it("handles option index 0 (invalid)", async () => {
    const { rl } = createMockRl(["0", "1"]);
    const input = new AsyncInteractiveCliInput(rl, lineHandler, (h) => rl.on("line", h));

    const answers = await input.collectAnswers([
      {
        key: "color",
        prompt: "Pick a color",
        options: ["red", "green", "blue"],
        allow_other: false,
      },
    ]);

    expect(answers.color).toBe("red");
  });

  it("handles negative option index", async () => {
    const { rl } = createMockRl(["-1", "2"]);
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
});
