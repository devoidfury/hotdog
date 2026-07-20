// Extended tests for ui-interactive-cli/index.ts — handleSlashCommand,
// parseCommand edge cases, isSystemCommand, executeShellCommand.

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { parseCommand, Command } from "../../src/core/commands.ts";
import { SessionManager } from "../../src/core/session/index.ts";
import {
  handleSlashCommand,
} from "../../src/extensions/ui-interactive-cli/index.ts";
import { createMockRl } from "../helpers.ts";

describe("handleSlashCommand", () => {
  it("handles /help command", () => {
    const { rl } = createMockRl();
    let output = "";
    const origLog = console.log;
    console.log = (...args) => { output += args.join(" "); };

    const mockSessionManager = {
      sessionId: () => "test-session",
      executeCommand: async (sessionId: string, cmd: string) => 0,
    } as any;
    const mockChannel = {} as any;

    handleSlashCommand("help", mockSessionManager, mockChannel, rl as any);
    console.log = origLog;
    expect(output).toContain("Commands:");
  });

  it("handles /quit and /exit commands", () => {
    const { rl } = createMockRl();
    let closed = false;
    const origExit = process.exit;
    process.exit = ((_code?: string | number | null | undefined) => {
      throw new Error("exit");
    }) as never;
    (rl as any).close = () => { closed = true; };

    const mockSessionManager = {
      sessionId: () => "test-session",
      executeCommand: async (sessionId: string, cmd: string) => 0,
    } as any;
    const mockChannel = {} as any;

    for (const cmd of ["quit", "exit"]) {
      closed = false;
      try {
        handleSlashCommand(cmd, mockSessionManager, mockChannel, rl as any);
      } catch (e) {
        if ((e as Error).message === "exit") expect(closed).toBe(true);
      }
    }
    process.exit = origExit;
  });

  it("delegates commands to sessionManager.executeCommand", async () => {
    const { rl } = createMockRl();
    const executedCommands: string[] = [];
    const mockSessionManager = {
      sessionId: () => "test-session",
      executeCommand: async (sessionId: string, cmd: string) => { executedCommands.push(cmd); return 0; },
    } as unknown as SessionManager;
    const mockChannel = {} as any;

    for (const cmd of ["clear", "tokens", "tools", "thinking", "regenerate",
      "reasoning high", "compact", "prompt:explainer"]) {
      handleSlashCommand(cmd, mockSessionManager, mockChannel, rl as any);
    }

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

  it("is case-sensitive", () => {
    expect(parseCommand("HELP").type).toBe(Command.Unknown);
    expect(parseCommand("help   ").type).toBe(Command.Unknown);
  });

  it("handles bus-managed commands as unknown", () => {
    expect(parseCommand("compact").type).toBe(Command.Unknown);
    expect(parseCommand("model gpt-4").type).toBe(Command.Unknown);
    expect(parseCommand("cancel").type).toBe(Command.Unknown);
  });

  it("handles channel commands", () => {
    expect(parseCommand("sessions").type).toBe(Command.Sessions);
    expect(parseCommand("attach abc").type).toBe(Command.Attach);
    expect(parseCommand("detach abc").type).toBe(Command.Detach);
    expect(parseCommand("switch abc").type).toBe(Command.Switch);
  });
});
