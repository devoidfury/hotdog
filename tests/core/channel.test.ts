// Tests for src/core/channel.ts — Base Channel class.
// Covers: send(), attach/detach, session switching,
// command routing, channel commands, cancel/interrupt/close.

import { describe, it, expect, beforeEach, mock } from "bun:test";
import {
  Channel,
  ChannelSessionManager,
} from "../../src/core/channel.ts";
import { OUTPUT_EVENT, OutputEvent } from "../../src/core/context/output.ts";

// ── Test Helpers ────────────────────────────────────────────────────────────

class TestChannel extends Channel {
  writeCalls: OutputEvent[] = [];
  readCalls: number = 0;
  subscribeCalls: string[] = [];
  unsubscribeCalls: string[] = [];
  cleanupCalls: number = 0;
  quitCalls: number = 0;
  helpCalls: number = 0;

  protected write(event: OutputEvent): void {
    this.writeCalls.push(event);
  }

  async *read(): AsyncIterable<string> {
    this.readCalls++;
    yield "test";
  }

  protected _subscribe(sessionId: string): void {
    this.subscribeCalls.push(sessionId);
  }

  protected _unsubscribe(sessionId: string): void {
    this.unsubscribeCalls.push(sessionId);
  }

  protected _cleanup(): void {
    this.cleanupCalls++;
  }

  protected override async handleQuit(): Promise<void> {
    this.quitCalls++;
    this.close();
  }

  protected override async handleHelp(): Promise<void> {
    this.helpCalls++;
  }
}

/**
 * Minimal channel that uses base class handleQuit/handleHelp implementations.
 */
class MinimalChannel extends Channel {
  writeCalls: OutputEvent[] = [];

  protected write(event: OutputEvent): void {
    this.writeCalls.push(event);
  }

  async *read(): AsyncIterable<string> {
    yield "test";
  }

  protected _subscribe(_sessionId: string): void {}

  protected _unsubscribe(_sessionId: string): void {}

  protected _cleanup(): void {}

  // Public wrappers for testing protected base methods
  public async testHandleQuit(): Promise<void> {
    await this.handleQuit();
  }

  public async testHandleHelp(): Promise<void> {
    await this.handleHelp();
  }
}

function createMockSessionManager(overrides: Partial<ChannelSessionManager> = {}): ChannelSessionManager {
  return {
    enqueue: mock(() => {}),
    cancel: mock(() => {}),
    interrupt: mock(() => {}),
    executeCommand: mock(async () => undefined),
    onSessionEvents: mock((_sessionId, _handler) => () => {}),
    sessionIds: mock(() => ["session-1", "session-2"]),
    getSessionInfo: mock((id) => ({ id, model: "test-model", profile: "default" })),
    drainPendingQuestions: mock(() => []),
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("Channel - send()", () => {
  let sm: ChannelSessionManager;
  let channel: TestChannel;

  beforeEach(() => {
    sm = createMockSessionManager();
    channel = new TestChannel({ sessionManager: sm });
    channel.attach("session-1");
  });

  it("enqueues regular text to current session", async () => {
    await channel.send("hello world");
    expect(sm.enqueue).toHaveBeenCalledWith("session-1", "hello world");
  });

  it("trims whitespace from input", async () => {
    await channel.send("  hello world  ");
    expect(sm.enqueue).toHaveBeenCalledWith("session-1", "hello world");
  });

  it("ignores empty input", async () => {
    await channel.send("");
    await channel.send("   ");
    expect(sm.enqueue).not.toHaveBeenCalled();
  });

  it("does not send when no current session", async () => {
    const channel = new TestChannel({ sessionManager: createMockSessionManager() });
    await channel.send("hello");
    expect(sm.enqueue).not.toHaveBeenCalled();
  });

  it("does not send when channel is closed", async () => {
    channel.close();
    await channel.send("hello");
    expect(sm.enqueue).not.toHaveBeenCalled();
  });

  it("routes commands starting with /", async () => {
    await channel.send("/help");
    expect(channel.helpCalls).toBe(1);
    expect(sm.enqueue).not.toHaveBeenCalled();
  });
});

describe("Channel - attach/detach", () => {
  let sm: ChannelSessionManager;
  let channel: TestChannel;

  beforeEach(() => {
    sm = createMockSessionManager();
    channel = new TestChannel({ sessionManager: sm });
  });

  it("attaches to a session and subscribes", () => {
    channel.attach("session-1");
    expect(channel.attachedSessions.has("session-1")).toBe(true);
    expect(channel.getCurrentSessionId()).toBe("session-1");
    expect(channel.subscribeCalls).toContain("session-1");
  });

  it("does not re-attach to already attached session", () => {
    channel.attach("session-1");
    channel.attach("session-1");
    expect(channel.subscribeCalls.filter(c => c === "session-1").length).toBe(1);
  });

  it("does not attach when closed", () => {
    channel.close();
    channel.attach("session-1");
    expect(channel.attachedSessions.size).toBe(0);
  });

  it("detaches from a session and unsubscribes", () => {
    channel.attach("session-1");
    channel.detach("session-1");
    expect(channel.attachedSessions.has("session-1")).toBe(false);
    expect(channel.unsubscribeCalls).toContain("session-1");
  });

  it("switches current session when detaching current", () => {
    channel.attach("session-1");
    channel.attach("session-2");
    channel.detach("session-1");
    expect(channel.getCurrentSessionId()).toBe("session-2");
  });

  it("sets current session to null when detaching last session", () => {
    channel.attach("session-1");
    channel.detach("session-1");
    expect(channel.getCurrentSessionId()).toBeNull();
  });

  it("does nothing when detaching non-attached session", () => {
    channel.detach("non-existent");
    expect(channel.unsubscribeCalls.length).toBe(0);
  });
});

describe("Channel - switchSession", () => {
  let sm: ChannelSessionManager;
  let channel: TestChannel;

  beforeEach(() => {
    sm = createMockSessionManager();
    channel = new TestChannel({ sessionManager: sm });
    channel.attach("session-1");
    channel.attach("session-2");
  });

  it("switches to an attached session", () => {
    const result = channel.switchSession("session-2");
    expect(result).toBe(true);
    expect(channel.getCurrentSessionId()).toBe("session-2");
  });

  it("returns false for non-attached session", () => {
    const result = channel.switchSession("non-existent");
    expect(result).toBe(false);
    expect(channel.getCurrentSessionId()).toBe("session-1");
  });
});

describe("Channel - command routing", () => {
  let sm: ChannelSessionManager;
  let channel: TestChannel;

  beforeEach(() => {
    sm = createMockSessionManager();
    channel = new TestChannel({ sessionManager: sm });
    channel.attach("session-1");
  });

  it("handles /quit command", async () => {
    await channel.send("/quit");
    expect(channel.quitCalls).toBe(1);
  });

  it("handles /help command", async () => {
    await channel.send("/help");
    expect(channel.helpCalls).toBe(1);
  });

  it("handles /sessions command", async () => {
    await channel.send("/sessions");
    expect(channel.writeCalls.length).toBe(1);
    expect(channel.writeCalls[0]!.type).toBe(OUTPUT_EVENT.COMMAND_RESULT);
    expect((channel.writeCalls[0]! as any).content).toContain("Available sessions:");
  });

  it("handles /attach command", async () => {
    await channel.send("/attach session-2");
    expect(channel.attachedSessions.has("session-2")).toBe(true);
    expect((channel.writeCalls[channel.writeCalls.length - 1]! as any).content).toContain("Attached to session session-2");
  });

  it("handles /attach with non-existent session", async () => {
    const sm = createMockSessionManager({
      getSessionInfo: mock(() => null),
    });
    const channel = new TestChannel({ sessionManager: sm });
    channel.attach("session-1");
    await channel.send("/attach non-existent");
    const lastWrite = channel.writeCalls[channel.writeCalls.length - 1]!;
    expect((lastWrite as any).content).toContain("Session not found");
  });

  it("handles /detach command", async () => {
    channel.attach("session-2");
    await channel.send("/detach session-2");
    expect(channel.attachedSessions.has("session-2")).toBe(false);
    expect((channel.writeCalls[channel.writeCalls.length - 1]! as any).content).toContain("Detached from session session-2");
  });

  it("handles /switch command", async () => {
    channel.attach("session-2");
    await channel.send("/switch session-2");
    expect(channel.getCurrentSessionId()).toBe("session-2");
    expect((channel.writeCalls[channel.writeCalls.length - 1]! as any).content).toContain("Switched to session session-2");
  });

  it("handles /switch to non-attached session", async () => {
    await channel.send("/switch non-existent");
    expect((channel.writeCalls[channel.writeCalls.length - 1]! as any).content).toContain("not attached");
  });

  it("passes non-channel commands to session", async () => {
    await channel.send("/some-agent-command");
    expect(sm.executeCommand).toHaveBeenCalledWith("session-1", "some-agent-command");
  });
});

describe("Channel - isChannelCommand", () => {
  let channel: TestChannel;

  beforeEach(() => {
    const sm = createMockSessionManager();
    channel = new TestChannel({ sessionManager: sm });
  });

  it("recognizes known channel commands", () => {
    for (const cmd of ["quit", "help", "sessions", "attach", "detach", "switch"]) {
      expect(channel.isChannelCommand(cmd)).toBe(true);
    }
  });

  it("recognizes channel commands with arguments", () => {
    expect(channel.isChannelCommand("attach session-1")).toBe(true);
    expect(channel.isChannelCommand("detach session-1")).toBe(true);
    expect(channel.isChannelCommand("switch session-1")).toBe(true);
  });

  it("returns false for unknown commands", () => {
    expect(channel.isChannelCommand("unknown")).toBe(false);
    expect(channel.isChannelCommand("foo")).toBe(false);
  });
});

describe("Channel - control methods", () => {
  let sm: ChannelSessionManager;
  let channel: TestChannel;

  beforeEach(() => {
    sm = createMockSessionManager();
    channel = new TestChannel({ sessionManager: sm });
    channel.attach("session-1");
  });

  it("cancels current session", () => {
    channel.cancel();
    expect(sm.cancel).toHaveBeenCalledWith("session-1");
  });

  it("does not cancel when no current session", () => {
    const channel = new TestChannel({ sessionManager: createMockSessionManager() });
    channel.cancel();
    expect(sm.cancel).not.toHaveBeenCalled();
  });

  it("interrupts current session", () => {
    channel.interrupt();
    expect(sm.interrupt).toHaveBeenCalledWith("session-1");
  });

  it("does not interrupt when no current session", () => {
    const channel = new TestChannel({ sessionManager: createMockSessionManager() });
    channel.interrupt();
    expect(sm.interrupt).not.toHaveBeenCalled();
  });

  it("closes channel and detaches from all sessions", () => {
    channel.attach("session-2");
    channel.close();
    expect(channel.cleanupCalls).toBe(1);
    expect(channel.attachedSessions.size).toBe(0);
  });

  it("close is idempotent", () => {
    channel.close();
    channel.close();
    expect(channel.cleanupCalls).toBe(1);
  });
});

describe("Channel - handleSessions output format", () => {
  let sm: ChannelSessionManager;
  let channel: TestChannel;

  beforeEach(() => {
    sm = createMockSessionManager({
      sessionIds: mock(() => ["session-1", "session-2"]),
      getSessionInfo: mock((id) => ({
        id,
        model: id === "session-1" ? "gpt-4" : "claude",
        profile: "default",
      })),
    });
    channel = new TestChannel({ sessionManager: sm });
    channel.attach("session-1");
    channel.attach("session-2");
  });

  it("formats session list with model and profile info", async () => {
    await channel.handleSessions();
    const content = (channel.writeCalls[0]! as any).content as string;
    expect(content).toContain("Available sessions:");
    expect(content).toContain("session-1");
    expect(content).toContain("session-2");
    expect(content).toContain("[gpt-4]");
    expect(content).toContain("[claude]");
    expect(content).toContain("(current)");
  });
});

describe("Channel - command usage messages", () => {
  it("shows usage when session ID is empty", async () => {
    const sm = createMockSessionManager();
    const channel = new TestChannel({ sessionManager: sm });
    channel.attach("session-1");

    await channel.handleAttach("attach ");
    expect((channel.writeCalls[channel.writeCalls.length - 1]! as any).content).toContain("Usage:");

    await channel.handleDetach("detach ");
    expect((channel.writeCalls[channel.writeCalls.length - 1]! as any).content).toContain("Usage:");

    await channel.handleSwitch("switch ");
    expect((channel.writeCalls[channel.writeCalls.length - 1]! as any).content).toContain("Usage:");
  });
});

describe("Channel - handleUnknown", () => {
  it("writes unknown command message", async () => {
    const sm = createMockSessionManager();
    const channel = new TestChannel({ sessionManager: sm });
    channel.attach("session-1");
    await channel.handleUnknown("foo");
    const lastWrite = channel.writeCalls[channel.writeCalls.length - 1]!;
    expect((lastWrite as any).content).toContain("Unknown command: foo");
  });
});

describe("Channel - read()", () => {
  it("is an async iterable", async () => {
    const sm = createMockSessionManager();
    const channel = new TestChannel({ sessionManager: sm });
    const results: string[] = [];
    for await (const text of channel.read()) {
      results.push(text);
    }
    expect(results).toContain("test");
  });
});

describe("Channel - base class default handlers", () => {
  it("base handleQuit closes the channel", async () => {
    const sm = createMockSessionManager();
    const channel = new MinimalChannel({ sessionManager: sm });
    expect(channel.isClosed).toBe(false);
    await channel.testHandleQuit();
    expect(channel.isClosed).toBe(true);
  });

  it("base handleHelp is a no-op", async () => {
    const sm = createMockSessionManager();
    const channel = new MinimalChannel({ sessionManager: sm });
    await channel.testHandleHelp();
    // Should not throw and produce no output
    expect(channel.writeCalls.length).toBe(0);
  });
});
