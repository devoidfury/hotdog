// Tests for MessageBus — event-driven dispatch loop, cancellation, interruption.

import { describe, it, expect, beforeEach } from "bun:test";
import { MessageBus } from "../../src/core/session/message-bus.ts";
import { OUTPUT_EVENT } from "../../src/core/context/output.ts";

// ── Shared mock factories ────────────────────────────────────────────────

function createMockSessionManager(getAgent?: () => unknown) {
  return { getAgent: getAgent ?? (() => null) } as any;
}

function createMockSink(): { emit: (event: unknown) => void; _emitted: unknown[] } {
  const emitted: unknown[] = [];
  return {
    emit: (event) => emitted.push(event),
    _emitted: emitted,
  };
}

function createMockAgent(overrides: {
  cancel?: () => void;
  resetCancel?: () => void;
  run?: (text?: string) => Promise<void>;
  executeCommand?: (cmd: string) => Promise<{ content?: string; error?: string } | null>;
  getCommandRegistry?: () => unknown;
  hooks?: { runHookPipeline: (hook: string, data: unknown, opts: unknown) => Promise<unknown> };
} = {}): Record<string, unknown> {
  return {
    cancel: overrides.cancel ?? (() => {}),
    resetCancel: overrides.resetCancel ?? (() => {}),
    run: overrides.run ?? (async () => {}),
    executeCommand: overrides.executeCommand ?? (async () => null),
    getCommandRegistry: overrides.getCommandRegistry ?? (() => ({ match: () => null, get: () => null })),
    hooks: overrides.hooks,
  };
}

describe("MessageBus constructor", () => {
  it("creates with no pending messages", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.isIdle()).toBe(true);
    expect(bus.isCancelled).toBe(false);
  });
});

describe("MessageBus.enqueue()", () => {
  it("adds message to queue", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.enqueue("hello");
    expect(bus.isIdle()).toBe(false);
  });

  it("adds multiple messages to queue", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.enqueue("msg1");
    bus.enqueue("msg2");
    expect(bus.isIdle()).toBe(false);
  });

  it("dequeues messages in FIFO order", async () => {
    const received: string[] = [];
    const agent = createMockAgent({
      run: async (text?: string) => { received.push(text ?? ""); },
    });
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });

    bus.enqueue("first");
    bus.enqueue("second");
    bus.enqueue("third");

    // Process messages via the internal loop
    await bus._processMessage("first");
    await bus._processMessage("second");
    await bus._processMessage("third");

    expect(received).toEqual(["first", "second", "third"]);
  });
});

describe("MessageBus.cancel()", () => {
  it("marks bus as cancelled", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.cancel();
    expect(bus.isCancelled).toBe(true);
  });

  it("cancels the agent", () => {
    let agentCancelled = false;
    const agent = createMockAgent({ cancel: () => { agentCancelled = true; } });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    bus.cancel();
    expect(agentCancelled).toBe(true);
  });

  it("does not crash when no agent", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.cancel();
  });
});

describe("MessageBus.interrupt()", () => {
  it("cancels the agent", () => {
    let agentCancelled = false;
    const agent = createMockAgent({ cancel: () => { agentCancelled = true; } });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    bus.interrupt();
    expect(agentCancelled).toBe(true);
  });

  it("clears the queue", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.enqueue("msg1");
    bus.enqueue("msg2");
    bus.interrupt();
    expect(bus.isIdle()).toBe(true);
  });

  it("does NOT abort the controller (bus continues running)", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.interrupt();
    expect(bus.isCancelled).toBe(false);
  });

  it("does not crash when no agent", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.interrupt();
  });
});

describe("MessageBus.reset()", () => {
  it("clears cancelled state", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.cancel();
    expect(bus.isCancelled).toBe(true);
    bus.reset();
    expect(bus.isCancelled).toBe(false);
  });

  it("preserves the queue", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.enqueue("msg1");
    bus.cancel();
    bus.reset();
    expect(bus.isIdle()).toBe(false);
  });

  it("allows the bus to be used again after reset", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.cancel();
    bus.reset();
    bus.enqueue("new-msg");
    expect(bus.isCancelled).toBe(false);
    expect(bus.isIdle()).toBe(false);
  });
});

describe("MessageBus.isIdle()", () => {
  it("returns true when not running, no queue, not cancelled", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.isIdle()).toBe(true);
  });

  it("returns false when queue has messages", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.enqueue("msg");
    expect(bus.isIdle()).toBe(false);
  });

  it("returns false when cancelled", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.cancel();
    expect(bus.isIdle()).toBe(false);
  });

  it("returns false after enqueue even if previously idle", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.isIdle()).toBe(true);
    bus.enqueue("msg");
    expect(bus.isIdle()).toBe(false);
  });
});

describe("MessageBus.executeCommand()", () => {
  it("emits 'No agent available' when no agent", async () => {
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink });
    await bus.executeCommand("clear");
    expect(sink._emitted).toHaveLength(1);
    expect((sink._emitted[0] as Record<string, unknown>).content).toBe("No agent available.");
  });

  it("executes command through agent", async () => {
    const sink = createMockSink();
    const agent = createMockAgent({ executeCommand: async () => ({ content: "Cleared" }) });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus.executeCommand("clear");
    expect(sink._emitted).toHaveLength(1);
    expect((sink._emitted[0] as Record<string, unknown>).content).toBe("Cleared");
  });

  it("emits error when command returns error", async () => {
    const sink = createMockSink();
    const agent = createMockAgent({ executeCommand: async () => ({ error: "Unknown command" }) });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus.executeCommand("unknown");
    expect(sink._emitted).toHaveLength(1);
    expect((sink._emitted[0] as Record<string, unknown>).content).toBe("Unknown command");
  });

  it("does not emit when command returns null", async () => {
    const sink = createMockSink();
    const agent = createMockAgent({ executeCommand: async () => null });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus.executeCommand("noop");
    expect(sink._emitted).toEqual([]);
  });
});

describe("MessageBus._processMessage()", () => {
  it("resets agent cancel flag before processing", async () => {
    let resetCalled = false;
    const agent = createMockAgent({ resetCancel: () => { resetCalled = true; } });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage("test");
    expect(resetCalled).toBe(true);
  });

  it("emits SESSION_STATE working=false after processing", async () => {
    const agent = createMockAgent();
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus._processMessage("test");
    expect((sink._emitted.at(-1) as Record<string, unknown>).type).toBe(OUTPUT_EVENT.SESSION_STATE);
    expect((sink._emitted.at(-1) as Record<string, unknown>).key).toBe("working");
    expect((sink._emitted.at(-1) as Record<string, unknown>).value).toBe(false);
  });

  it("handles input hook that short-circuits", async () => {
    let runCalled = false;
    const agent = createMockAgent({
      run: async () => { runCalled = true; },
      hooks: {
        runHookPipeline: async (_hook: string, data: unknown) => ({
          stopped: true,
          data: { text: (data as { text: string }).text },
        }),
      },
    });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage("test");
    expect(runCalled).toBe(false);
  });

  it("handles input hook that transforms text", async () => {
    let receivedText: string | null = null;
    const agent = createMockAgent({
      run: async (text?: string) => { receivedText = text ?? null; },
      hooks: {
        runHookPipeline: async (_hook: string, data: unknown) => ({
          stopped: false,
          lastResult: { action: "transform" as const, text: "transformed: " + (data as { text: string }).text },
        }),
      },
    });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage("test");
    expect(receivedText as unknown as string).toBe("transformed: test");
  });

  it("handles cancellation error silently", async () => {
    const { LlmError } = await import("../../src/core/error.ts");
    const agent = createMockAgent({ run: async () => { throw LlmError.Cancelled("cancelled"); } });
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus._processMessage("test");
    const commandResults = sink._emitted.filter((e: any) => e.type === OUTPUT_EVENT.COMMAND_RESULT);
    expect(commandResults).toHaveLength(0);
  });

  it("handles AbortError silently", async () => {
    const agent = createMockAgent({
      run: async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    });
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus._processMessage("test");
    const commandResults = sink._emitted.filter((e: any) => e.type === OUTPUT_EVENT.COMMAND_RESULT);
    expect(commandResults).toHaveLength(0);
  });

  it("emits non-cancellation errors", async () => {
    const agent = createMockAgent({ run: async () => { throw new Error("Something went wrong"); } });
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus._processMessage("test");
    const commandResults = sink._emitted.filter((e: any) => e.type === OUTPUT_EVENT.COMMAND_RESULT);
    expect(commandResults).not.toHaveLength(0);
  });

  it("handles agent being null", async () => {
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink });
    await bus._processMessage("test");
    expect((sink._emitted.at(-1) as Record<string, unknown>).type).toBe(OUTPUT_EVENT.SESSION_STATE);
    expect(bus.isRunning).toBe(false);
  });
});

describe("MessageBus getters", () => {
  it("sessionManager returns the injected session manager", () => {
    const mockManager = { getAgent: () => null } as any;
    const bus = new MessageBus({ sessionManager: mockManager, sink: createMockSink() });
    expect(bus.sessionManager).toBe(mockManager);
  });

  it("agent returns the agent from session manager", () => {
    const mockAgent = { cancel: () => {}, run: async () => {} } as any;
    const mockManager = { getAgent: () => mockAgent } as any;
    const bus = new MessageBus({ sessionManager: mockManager, sink: createMockSink() });
    expect(bus.agent).toBe(mockAgent);
  });

  it("agent returns undefined when no agent", () => {
    const mockManager = { getAgent: () => undefined } as any;
    const bus = new MessageBus({ sessionManager: mockManager, sink: createMockSink() });
    expect(bus.agent).toBeUndefined();
  });
});

describe("MessageBus test-only accessors", () => {
  it("queue accessor allows reading and setting the queue", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.enqueue("msg1");
    expect(bus.queue).toEqual(["msg1"]);

    bus.queue = ["msg2", "msg3"];
    expect(bus.queue).toEqual(["msg2", "msg3"]);
  });

  it("isRunning accessor allows reading and setting running state", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.isRunning).toBe(false);

    bus.isRunning = true;
    expect(bus.isRunning).toBe(true);
  });

  it("abortController accessor returns the internal controller", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    const ctrl = bus.abortController;
    expect(ctrl).toBeInstanceOf(AbortController);
    expect(ctrl.signal.aborted).toBe(false);
  });

  it("waiter accessor allows reading and setting the waiter", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.waiter).toBeNull();

    const waiter = { resolve: () => {} };
    bus.waiter = waiter;
    expect(bus.waiter).toBe(waiter);
  });
});
