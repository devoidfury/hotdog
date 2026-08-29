// Tests for ui-interactive-cli/index.ts — handleSlashCommand and
// command delegation. Other areas:
//   - parseCommand (core): tests/core/commands.test.ts
//   - AsyncInteractiveCliInput: interactive-cli-input.test.ts
//   - executeShellCommand, completions, session wiring: ui-interactive-cli.test.ts

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SessionManager } from "../../src/core/session/index.ts";
import { ACTIONS } from "../../src/core/commands.ts";
import {
  handleSlashCommand,
} from "../../src/extensions/ui-interactive-cli/index.ts";
import { createMockRl } from "../helpers.ts";

describe("handleSlashCommand", () => {
  let originalExit: typeof process.exit;
  let exitCalledWith: number | null = null;
  let capturedOutput = "";
  let originalLog: typeof console.log;

  beforeEach(() => {
    originalExit = process.exit;
    originalLog = console.log;
    exitCalledWith = null;
    capturedOutput = "";
    process.exit = ((code: number) => { exitCalledWith = code; }) as never;
    console.log = (...args) => { capturedOutput += args.join(" "); };
  });

  afterEach(() => {
    process.exit = originalExit;
    console.log = originalLog;
  });

  it("handles /help command", () => {
    const { rl } = createMockRl();

    const mockSessionManager = {
      sessionId: () => "test-session",
      executeCommand: async () => 0,
    } as any;
    const mockChannel = {} as any;

    handleSlashCommand("help", mockSessionManager, mockChannel, rl as any);
    expect(capturedOutput).toContain("Commands:");
  });

  it("handles /quit and /exit commands", () => {
    const { rl } = createMockRl();
    let closed = false;
    (rl as any).close = () => { closed = true; };

    const mockSessionManager = {
      sessionId: () => "test-session",
      executeCommand: async () => 0,
    } as any;
    const mockChannel = {} as any;

    for (const cmd of ["quit", "exit"]) {
      closed = false;
      exitCalledWith = null;
      capturedOutput = "";
      handleSlashCommand(cmd, mockSessionManager, mockChannel, rl as any);
      expect(closed).toBe(true);
      expect(exitCalledWith as unknown as number).toBe(0);
      expect(capturedOutput).toContain("Goodbye!");
    }
  });

  it("delegates commands to sessionManager.executeCommand", async () => {
    const { rl } = createMockRl();
    const executedCommands: string[] = [];
    const mockSessionManager = {
      sessionId: () => "test-session",
      executeCommand: async (_sessionId: string, cmd: string) => { executedCommands.push(cmd); return 0; },
    } as unknown as SessionManager;
    const mockChannel = {} as any;

    for (const cmd of ["clear", "tokens", "tools", "thinking", "regenerate",
      "reasoning high", "compact", "prompt:explainer"]) {
      handleSlashCommand(cmd, mockSessionManager, mockChannel, rl as any);
    }

    // executeCommand is called synchronously by handleSlashCommand, and the
    // mock records the command before any await, so no wait is needed.
    expect(executedCommands).toEqual([
      "clear", "tokens", "tools", "thinking", "regenerate",
      "reasoning high", "compact", "prompt:explainer",
    ]);
  });

  it("does not redraw the prompt after a command that enqueues LLM work", async () => {
    const { rl } = createMockRl();
    let prompted = false;
    (rl as any).prompt = () => { prompted = true; };
    const mockSessionManager = {
      sessionId: () => "test-session",
      executeCommand: async () => ACTIONS.PROMPT,
    } as unknown as SessionManager;
    const mockChannel = {} as any;

    handleSlashCommand("prompt:explainer", mockSessionManager, mockChannel, rl as any);
    // The PROMPT action is resolved through the .then handler (one microtask).
    await Promise.resolve();
    expect(prompted).toBe(false);
  });
});
