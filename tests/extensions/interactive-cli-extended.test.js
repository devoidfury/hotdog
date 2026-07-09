// Extended tests for ui-interactive-cli/index.js — handleSlashCommand.

import { describe, it, expect } from "bun:test";
import { parseCommand, Command } from "../../src/core/commands.js";
import {
  handleSlashCommand,
} from "../../src/extensions/ui-interactive-cli/index.js";

describe("handleSlashCommand", () => {
  function createMockRl() {
    return { prompt: () => {} };
  }

  function createMockBus() {
    return {
      executeCommand: async (cmd) => {},
    };
  }

  it("handles /help command", () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    handleSlashCommand("help", createMockBus(), rl);
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

    handleSlashCommand("quit", createMockBus(), rl);
    console.log = origLog;
    process.exit = origExit;
    expect(output).toContain("Goodbye!");
    expect(closed).toBe(true);
  });

  it("handles /exit command", () => {
    const rl = createMockRl();
    let output = "";
    let closed = false;
    const origLog = console.log;
    const origExit = process.exit;
    console.log = (...args) => { output += args.join(" "); };
    process.exit = () => {};

    rl.close = () => { closed = true; };

    handleSlashCommand("exit", createMockBus(), rl);
    console.log = origLog;
    process.exit = origExit;
    expect(output).toContain("Goodbye!");
    expect(closed).toBe(true);
  });

  it("delegates other commands to bus.executeCommand", async () => {
    const rl = createMockRl();
    let executedCmd = null;
    const bus = {
      executeCommand: async (cmd) => { executedCmd = cmd; },
    };

    handleSlashCommand("clear", bus, rl);
    // Wait for the promise to resolve
    await new Promise((r) => setTimeout(r, 10));
    expect(executedCmd).toBe("clear");
  });

  it("delegates /tokens command to bus", async () => {
    const rl = createMockRl();
    let executedCmd = null;
    const bus = {
      executeCommand: async (cmd) => { executedCmd = cmd; },
    };

    handleSlashCommand("tokens", bus, rl);
    await new Promise((r) => setTimeout(r, 10));
    expect(executedCmd).toBe("tokens");
  });

  it("delegates /tools command to bus", async () => {
    const rl = createMockRl();
    let executedCmd = null;
    const bus = {
      executeCommand: async (cmd) => { executedCmd = cmd; },
    };

    handleSlashCommand("tools", bus, rl);
    await new Promise((r) => setTimeout(r, 10));
    expect(executedCmd).toBe("tools");
  });

  it("delegates /thinking command to bus", async () => {
    const rl = createMockRl();
    let executedCmd = null;
    const bus = {
      executeCommand: async (cmd) => { executedCmd = cmd; },
    };

    handleSlashCommand("thinking", bus, rl);
    await new Promise((r) => setTimeout(r, 10));
    expect(executedCmd).toBe("thinking");
  });

  it("delegates /regenerate command to bus", async () => {
    const rl = createMockRl();
    let executedCmd = null;
    const bus = {
      executeCommand: async (cmd) => { executedCmd = cmd; },
    };

    handleSlashCommand("regenerate", bus, rl);
    await new Promise((r) => setTimeout(r, 10));
    expect(executedCmd).toBe("regenerate");
  });

  it("delegates /reasoning command to bus", async () => {
    const rl = createMockRl();
    let executedCmd = null;
    const bus = {
      executeCommand: async (cmd) => { executedCmd = cmd; },
    };

    handleSlashCommand("reasoning high", bus, rl);
    await new Promise((r) => setTimeout(r, 10));
    expect(executedCmd).toBe("reasoning high");
  });

  it("delegates unknown commands to bus", async () => {
    const rl = createMockRl();
    let executedCmd = null;
    const bus = {
      executeCommand: async (cmd) => { executedCmd = cmd; },
    };

    handleSlashCommand("compact", bus, rl);
    await new Promise((r) => setTimeout(r, 10));
    expect(executedCmd).toBe("compact");
  });

  it("delegates /prompt:name command to bus", async () => {
    const rl = createMockRl();
    let executedCmd = null;
    const bus = {
      executeCommand: async (cmd) => { executedCmd = cmd; },
    };

    handleSlashCommand("prompt:explainer", bus, rl);
    await new Promise((r) => setTimeout(r, 10));
    expect(executedCmd).toBe("prompt:explainer");
  });
});

describe("parseCommand edge cases not covered by interactive-cli.test.js", () => {
  it("does not trim whitespace-only input (returns value as-is)", () => {
    const cmd = parseCommand("   ");
    expect(cmd.type).toBe(Command.Unknown);
    expect(cmd.value).toBe("   ");
  });

  it("parses case-sensitive commands (HELP is unknown)", () => {
    const cmd = parseCommand("HELP");
    expect(cmd.type).toBe(Command.Unknown);
  });

  it("does not trim trailing whitespace", () => {
    const cmd = parseCommand("help   ");
    expect(cmd.type).toBe(Command.Unknown);
  });

  it("handles compact command as unknown (handled by bus)", () => {
    const cmd = parseCommand("compact");
    expect(cmd.type).toBe(Command.Unknown);
    expect(cmd.value).toBe("compact");
  });

  it("handles model command as unknown (handled by bus)", () => {
    const cmd = parseCommand("model gpt-4");
    expect(cmd.type).toBe(Command.Unknown);
    expect(cmd.value).toBe("model gpt-4");
  });

  it("handles cancel command as unknown (handled by bus)", () => {
    const cmd = parseCommand("cancel");
    expect(cmd.type).toBe(Command.Unknown);
    expect(cmd.value).toBe("cancel");
  });
});

describe("isSystemCommand", () => {
  it("returns true for a known system command", async () => {
    const { isSystemCommand } = await import("../../src/extensions/ui-interactive-cli/index.js");
    expect(await isSystemCommand("echo")).toBe(true);
  });

  it("returns true for ls", async () => {
    const { isSystemCommand } = await import("../../src/extensions/ui-interactive-cli/index.js");
    expect(await isSystemCommand("ls")).toBe(true);
  });

  it("returns false for a non-existent command", async () => {
    const { isSystemCommand } = await import("../../src/extensions/ui-interactive-cli/index.js");
    expect(await isSystemCommand("nonexistent_command_xyz_12345")).toBe(false);
  });

  it("returns false for empty string", async () => {
    const { isSystemCommand } = await import("../../src/extensions/ui-interactive-cli/index.js");
    expect(await isSystemCommand("")).toBe(false);
  });
});

describe("executeShellCommand", () => {
  it("executes a simple command and returns output", async () => {
    const { executeShellCommand } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const result = await executeShellCommand("echo hello world");
    expect(result.content).toContain("hello world");
    expect(result.content).toContain("[exited with code 0]");
  });

  it("handles command errors", async () => {
    const { executeShellCommand } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const result = await executeShellCommand("nonexistent_command_xyz_12345");
    expect(result.content || result.error).toBeDefined();
  });

  it("handles empty output command", async () => {
    const { executeShellCommand } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const result = await executeShellCommand("true");
    expect(result.content).toContain("[exited with code 0]");
  });

  it("returns content as string", async () => {
    const { executeShellCommand } = await import("../../src/extensions/ui-interactive-cli/index.js");
    const result = await executeShellCommand("echo test");
    expect(typeof result.content).toBe("string");
  });
});
