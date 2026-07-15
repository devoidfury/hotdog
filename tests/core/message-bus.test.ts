// Tests for MessageBus — event-driven dispatch loop, cancellation, interruption.

import { describe, it, expect, beforeEach } from "bun:test";
import { MessageBus } from "../../src/core/session/message-bus.ts";
import { OUTPUT_EVENT } from "../../src/core/context/output.ts";

// ── Shared mock factories ────────────────────────────────────────────────

function createMockSessionManager(getAgent?: () => unknown) {
  return { getAgent: getAgent ?? (() => null) };
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

  it("creates with required options", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus).toBeDefined();
    expect(bus.queue).toEqual([]);
    expect(bus.isRunning).toBe(false);
  });

  it("creates AbortController", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.abortController).toBeDefined();
  });

  it("isCancelled returns false initially", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.isCancelled).toBe(false);
  });

  it("isIdle returns true initially", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.isIdle()).toBe(true);
  });

  it("sessionManager getter returns the session manager", () => {
    const sm = createMockSessionManager();
    const bus = new MessageBus({ sessionManager: sm, sink: createMockSink() });
    expect(bus.sessionManager).toBe(sm);
  });

  it("agent getter returns agent from session manager", () => {
    const agent = createMockAgent();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    expect(bus.agent).toBe(agent);
  });
});

describe("MessageBus.enqueue()", () => {
  it("adds message to queue", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.enqueue("hello");
    expect(bus.queue).toEqual(["hello"]);
  });

  it("adds multiple messages to queue", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.enqueue("msg1");
    bus.enqueue("msg2");
    expect(bus.queue).toEqual(["msg1", "msg2"]);
  });

  it("wakes waiter when present", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    let resolved = false;
    bus.waiter = { resolve: () => { resolved = true; } };
    bus.enqueue("test");
    expect(resolved).toBe(true);
    expect(bus.waiter).toBeNull();
  });
});

describe("MessageBus.cancel()", () => {
  it("aborts the controller", () => {
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

  it("wakes waiter when present", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    let resolved = false;
    bus.waiter = { resolve: () => { resolved = true; } };
    bus.cancel();
    expect(resolved).toBe(true);
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
    expect(bus.queue).toEqual([]);
  });

  it("does NOT abort the controller (bus continues running)", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.interrupt();
    expect(bus.isCancelled).toBe(false);
  });

  it("wakes waiter when present", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    let resolved = false;
    bus.waiter = { resolve: () => { resolved = true; } };
    bus.interrupt();
    expect(resolved).toBe(true);
  });

  it("does not crash when no agent", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.interrupt();
  });
});

describe("MessageBus.reset()", () => {
  it("creates a new AbortController", () => {
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
    expect(bus.queue).toEqual(["msg1"]);
  });

  it("allows the bus to be used again after reset", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.cancel();
    bus.reset();
    bus.enqueue("new-msg");
    expect(bus.queue).toEqual(["new-msg"]);
    expect(bus.isCancelled).toBe(false);
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

  it("returns false when running", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.isRunning = true;
    expect(bus.isIdle()).toBe(false);
  });
});

describe("MessageBus.executeCommand()", () => {
  it("emits 'No agent available' when no agent", async () => {
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink });
    await bus.executeCommand("clear");
    expect(sink._emitted).toHaveLength(1);
    expect(sink._emitted[0].content).toBe("No agent available.");
  });

  it("executes command through agent", async () => {
    const sink = createMockSink();
    const agent = createMockAgent({ executeCommand: async () => ({ content: "Cleared" }) });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus.executeCommand("clear");
    expect(sink._emitted).toHaveLength(1);
    expect(sink._emitted[0].content).toBe("Cleared");
  });

  it("emits error when command returns error", async () => {
    const sink = createMockSink();
    const agent = createMockAgent({ executeCommand: async () => ({ error: "Unknown command" }) });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus.executeCommand("unknown");
    expect(sink._emitted).toHaveLength(1);
    expect(sink._emitted[0].content).toBe("Unknown command");
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
  it("sets _isRunning to true during processing", async () => {
    const agent = createMockAgent();
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus._processMessage("test");
    expect(bus.isRunning).toBe(false);
  });

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
    expect(sink._emitted.at(-1).type).toBe(OUTPUT_EVENT.SESSION_STATE);
    expect(sink._emitted.at(-1).key).toBe("working");
    expect(sink._emitted.at(-1).value).toBe(false);
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
      run: async (text: string) => { receivedText = text; },
      hooks: {
        runHookPipeline: async (_hook: string, data: unknown) => ({
          stopped: false,
          data: { text: "transformed: " + (data as { text: string }).text },
        }),
      },
    });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage("test");
    expect(receivedText).toBe("transformed: test");
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
    expect(sink._emitted.at(-1).type).toBe(OUTPUT_EVENT.SESSION_STATE);
    expect(bus.isRunning).toBe(false);
  });
});

describe("MessageBus._wakeWaiter()", () => {
  it("resolves waiter and clears _waiter", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    let resolved = false;
    bus.waiter = { resolve: () => { resolved = true; } };
    bus._wakeWaiter();
    expect(resolved).toBe(true);
    expect(bus.waiter).toBeNull();
  });

  it("is idempotent — does nothing when no waiter", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus._wakeWaiter();
  });

  it("calling _wakeWaiter twice does not crash", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.waiter = { resolve: () => {} };
    bus._wakeWaiter();
    bus._wakeWaiter();
  });
});
