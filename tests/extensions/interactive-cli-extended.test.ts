// Extended tests for ui-interactive-cli/index.ts — handleSlashCommand,
// parseCommand edge cases, isSystemCommand, executeShellCommand.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { parseCommand, Command } from "../../src/core/commands.ts";
import {
  handleSlashCommand,
} from "../../src/extensions/ui-interactive-cli/index.ts";

describe("handleSlashCommand", () => {
  function createMockRl() {
    return { prompt: () => {} };
  }

  it("handles /help command", () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    handleSlashCommand("help", { executeCommand: async () => {} }, rl);
    console.log = origLog;
    expect(output).toContain("Commands:");
  });

  it("handles /quit command", () => {
    const rl = createMockRl();
    let output = "";
    let closed = false;
    const origLog = console.log;
    const origExit = process.exit;
    console.log = (...args) => { output += args.join(" "); };
    process.exit = () => {};
    rl.close = () => { closed = true; };

    handleSlashCommand("quit", { executeCommand: async () => {} }, rl);
    console.log = origLog;
    process.exit = origExit;
    expect(output).toContain("Goodbye!");
    expect(closed).toBe(true);
  });

  it("handles /exit command", () => {
    const rl = createMockRl();
    let closed = false;
    const origExit = process.exit;
    process.exit = () => {};
    rl.close = () => { closed = true; };

    handleSlashCommand("exit", { executeCommand: async () => {} }, rl);
    process.exit = origExit;
    expect(closed).toBe(true);
  });

  it("delegates commands to bus.executeCommand", async () => {
    const rl = createMockRl();
    const executedCommands = [];
    const bus = {
      executeCommand: async (cmd) => { executedCommands.push(cmd); },
    };

    // Test multiple commands in one test to reduce verbosity
    handleSlashCommand("clear", bus, rl);
    handleSlashCommand("tokens", bus, rl);
    handleSlashCommand("tools", bus, rl);
    handleSlashCommand("thinking", bus, rl);
    handleSlashCommand("regenerate", bus, rl);
    handleSlashCommand("reasoning high", bus, rl);
    handleSlashCommand("compact", bus, rl);
    handleSlashCommand("prompt:explainer", bus, rl);

    await new Promise((r) => setTimeout(r, 50));
    expect(executedCommands).toEqual([
      "clear", "tokens", "tools", "thinking", "regenerate",
      "reasoning high", "compact", "prompt:explainer",
    ]);
  });
});

describe("parseCommand edge cases", () => {
  it("does not trim whitespace-only input", () => {
    const cmd = parseCommand("   ");
    expect(cmd.type).toBe(Command.Unknown);
    expect(cmd.value).toBe("   ");
  });

  it("is case-sensitive (HELP is unknown)", () => {
    expect(parseCommand("HELP").type).toBe(Command.Unknown);
  });

  it("does not trim trailing whitespace", () => {
    expect(parseCommand("help   ").type).toBe(Command.Unknown);
  });

  it("handles bus-managed commands as unknown", () => {
    expect(parseCommand("compact").type).toBe(Command.Unknown);
    expect(parseCommand("model gpt-4").type).toBe(Command.Unknown);
    expect(parseCommand("cancel").type).toBe(Command.Unknown);
  });
});

describe("isSystemCommand", () => {
  it("returns true for known system commands", async () => {
    const { isSystemCommand } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    expect(await isSystemCommand("echo")).toBe(true);
    expect(await isSystemCommand("ls")).toBe(true);
  });

  it("returns false for non-existent commands", async () => {
    const { isSystemCommand } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    expect(await isSystemCommand("nonexistent_command_xyz_12345")).toBe(false);
    expect(await isSystemCommand("")).toBe(false);
  });
});

describe("executeShellCommand", () => {
  it("executes a simple command and returns output", async () => {
    const { executeShellCommand } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const result = await executeShellCommand("echo hello world");
    expect(result.content).toContain("hello world");
    expect(result.content).toContain("[exited with code 0]");
  });

  it("handles command errors", async () => {
    const { executeShellCommand } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const result = await executeShellCommand("nonexistent_command_xyz_12345");
    expect(result.content || result.error).toBeDefined();
  });

  it("handles empty output command", async () => {
    const { executeShellCommand } = await import("../../src/extensions/ui-interactive-cli/index.ts");
    const result = await executeShellCommand("true");
    expect(result.content).toContain("[exited with code 0]");
  });
});
