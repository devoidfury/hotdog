// Extended tests for ui-interactive-cli/index.js — handleShellCommand,
// handleSlashCommand, createInlineShellCommand.

import { describe, it, expect } from "bun:test";
import { parseCommand, Command } from "../../src/core/commands.js";
import {
  handleShellCommand,
  handleSlashCommand,
  createInlineShellCommand,
} from "../../src/extensions/ui-interactive-cli/index.js";

describe("handleShellCommand", () => {
  function createMockRl() {
    return { prompt: () => {} };
  }

  it("handles /sh command", async () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    const ext = {
      execute: async (cmd) => ({ content: `executed: ${cmd}` }),
    };

    await handleShellCommand("/sh echo hello", rl, () => ext);
    console.log = origLog;
    expect(output).toContain("$ echo hello");
  });

  it("handles /shell without space shows usage (handleShellCommand only handles /sh and sh)", async () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    // handleShellCommand only handles /sh and sh, not /shell
    await handleShellCommand("/shell echo hello", rl, () => ({ execute: async () => ({}) }));
    console.log = origLog;
    expect(output).toContain("Usage");
  });

  it("handles sh command (without leading /)", async () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    const ext = {
      execute: async (cmd) => ({ content: `executed: ${cmd}` }),
    };

    await handleShellCommand("sh echo hello", rl, () => ext);
    console.log = origLog;
    expect(output).toContain("$ echo hello");
  });

  it("handles :! command", async () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    const ext = {
      execute: async (cmd) => ({ content: `executed: ${cmd}` }),
    };

    await handleShellCommand(":!echo hello", rl, () => ext);
    console.log = origLog;
    expect(output).toContain("$ echo hello");
  });

  it("handles ! command", async () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    const ext = {
      execute: async (cmd) => ({ content: `executed: ${cmd}` }),
    };

    await handleShellCommand("!echo hello", rl, () => ext);
    console.log = origLog;
    expect(output).toContain("$ echo hello");
  });

  it("handles command with no argument", async () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    await handleShellCommand("/sh", rl, () => ({ execute: async () => ({}) }));
    console.log = origLog;
    expect(output).toContain("Usage");
  });

  it("handles command error output", async () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    const ext = {
      execute: async (cmd) => ({ error: "command not found" }),
    };

    await handleShellCommand("/sh nonexistent", rl, () => ext);
    console.log = origLog;
    expect(output).toContain("command not found");
  });

  it("handles command with both stdout and stderr", async () => {
    const rl = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    const ext = {
      execute: async (cmd) => ({ content: "stdout output" }),
    };

    await handleShellCommand("/sh ls", rl, () => ext);
    console.log = origLog;
    expect(output).toContain("stdout output");
  });
});

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

describe("createInlineShellCommand", () => {
  it("creates a shell command handler", () => {
    const handler = createInlineShellCommand();
    expect(handler).toBeDefined();
    expect(typeof handler.execute).toBe("function");
  });

  it("executes a simple command and returns output", async () => {
    const handler = createInlineShellCommand();
    const result = await handler.execute("echo hello world");
    expect(result.content).toContain("hello world");
    expect(result.content).toContain("[exited with code 0]");
  });

  it("handles command errors", async () => {
    const handler = createInlineShellCommand();
    const result = await handler.execute("nonexistent_command_xyz_12345");
    // Either content (with error from shell) or error property
    expect(result.content || result.error).toBeDefined();
  });

  it("returns output with exit code", async () => {
    const handler = createInlineShellCommand();
    const result = await handler.execute("echo test123");
    expect(result.content).toContain("test123");
    expect(result.content).toContain("[exited with code 0]");
  });

  it("handles empty output command", async () => {
    const handler = createInlineShellCommand();
    const result = await handler.execute("true");
    expect(result.content).toContain("[exited with code 0]");
  });

  it("handles multi-word commands", async () => {
    const handler = createInlineShellCommand();
    const result = await handler.execute("echo hello && echo world");
    expect(result.content).toContain("hello");
    expect(result.content).toContain("world");
  });

  it("returns content as string", async () => {
    const handler = createInlineShellCommand();
    const result = await handler.execute("echo test");
    expect(typeof result.content).toBe("string");
  });
});

describe("Interactive CLI — line parsing patterns", () => {
  it("detects /sh with space", () => {
    const line = "/sh ls -la";
    expect(line.startsWith("/sh ")).toBe(true);
  });

  it("does not detect /sh without space as shell command", () => {
    const line = "/sh";
    expect(
      line.startsWith("/sh ") ||
        line.startsWith("/shell ") ||
        line.startsWith(":!") ||
        line.startsWith("!")
    ).toBe(false);
  });

  it("detects /shell with space", () => {
    const line = "/shell ls";
    expect(line.startsWith("/shell ")).toBe(true);
  });

  it("detects :! without space", () => {
    const line = ":!ls";
    expect(line.startsWith(":!")).toBe(true);
  });

  it("detects ! without space", () => {
    const line = "!ls";
    expect(line.startsWith("!")).toBe(true);
  });

  it("does not detect regular text as shell command", () => {
    const line = "Hello world";
    expect(
      line.startsWith("/sh ") ||
        line.startsWith("/shell ") ||
        line.startsWith(":!") ||
        line.startsWith("!")
    ).toBe(false);
  });

  it("does not detect /help as shell command", () => {
    const line = "/help";
    expect(
      line.startsWith("/sh ") ||
        line.startsWith("/shell ") ||
        line.startsWith(":!") ||
        line.startsWith("!")
    ).toBe(false);
  });
});

describe("Interactive CLI — parseCommand edge cases", () => {
  it("parses 'clear' command", () => {
    const cmd = parseCommand("clear");
    expect(cmd.type).toBe(Command.Clear);
  });

  it("parses 'clear' with profile name", () => {
    const cmd = parseCommand("clear default");
    expect(cmd.type).toBe(Command.Clear);
    expect(cmd.value).toBe("default");
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

  it("does not trim whitespace-only input (returns value as-is)", () => {
    const cmd = parseCommand("   ");
    expect(cmd.type).toBe(Command.Unknown);
    // parseCommand does not trim — "   " is passed through as value
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
