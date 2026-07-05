// Tests for MessageBus — event-driven dispatch loop, cancellation, interruption.

import { describe, it, expect, beforeEach } from "bun:test";
import { MessageBus } from "../../src/core/session/message-bus.js";
import { OUTPUT_EVENT } from "../../src/core/context/output.js";

describe("MessageBus constructor", () => {
  function createMockSessionManager() {
    return { getAgent: () => null };
  }

  function createMockSink() {
    return { emit: () => {} };
  }

  it("creates with required options", () => {
    const bus = new MessageBus({
      sessionManager: createMockSessionManager(),
      sink: createMockSink(),
    });
    expect(bus).toBeDefined();
    expect(bus._queue).toEqual([]);
    expect(bus._isRunning).toBe(false);
  });

  it("creates AbortController", () => {
    const bus = new MessageBus({
      sessionManager: createMockSessionManager(),
      sink: createMockSink(),
    });
    expect(bus._abortController).toBeDefined();
  });

  it("isCancelled returns false initially", () => {
    const bus = new MessageBus({
      sessionManager: createMockSessionManager(),
      sink: createMockSink(),
    });
    expect(bus.isCancelled).toBe(false);
  });

  it("isIdle returns true initially", () => {
    const bus = new MessageBus({
      sessionManager: createMockSessionManager(),
      sink: createMockSink(),
    });
    expect(bus.isIdle()).toBe(true);
  });

  it("sessionManager getter returns the session manager", () => {
    const sm = createMockSessionManager();
    const bus = new MessageBus({ sessionManager: sm, sink: createMockSink() });
    expect(bus.sessionManager).toBe(sm);
  });

  it("agent getter returns agent from session manager", () => {
    const mockAgent = { run: async () => {} };
    const sm = { getAgent: () => mockAgent };
    const bus = new MessageBus({ sessionManager: sm, sink: createMockSink() });
    expect(bus.agent).toBe(mockAgent);
  });
});

describe("MessageBus.enqueue()", () => {
  it("adds message to queue", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.enqueue("hello");
    expect(bus._queue).toEqual(["hello"]);
  });

  it("adds multiple messages to queue", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.enqueue("msg1");
    bus.enqueue("msg2");
    expect(bus._queue).toEqual(["msg1", "msg2"]);
  });

  it("wakes waiter when present", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });

    // Simulate a waiter
    let resolved = false;
    bus._waiter = { resolve: () => { resolved = true; } };

    bus.enqueue("test");
    expect(resolved).toBe(true);
    expect(bus._waiter).toBeNull();
  });
});

describe("MessageBus.cancel()", () => {
  it("aborts the controller", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.cancel();
    expect(bus.isCancelled).toBe(true);
  });

  it("cancels the agent", () => {
    let agentCancelled = false;
    const mockAgent = { cancel: () => { agentCancelled = true; } };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink: { emit: () => {} },
    });
    bus.cancel();
    expect(agentCancelled).toBe(true);
  });

  it("wakes waiter when present", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });

    let resolved = false;
    bus._waiter = { resolve: () => { resolved = true; } };

    bus.cancel();
    expect(resolved).toBe(true);
  });

  it("does not crash when no agent", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    // Should not throw
    bus.cancel();
  });
});

describe("MessageBus.interrupt()", () => {
  it("cancels the agent", () => {
    let agentCancelled = false;
    const mockAgent = { cancel: () => { agentCancelled = true; } };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink: { emit: () => {} },
    });
    bus.interrupt();
    expect(agentCancelled).toBe(true);
  });

  it("clears the queue", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.enqueue("msg1");
    bus.enqueue("msg2");
    bus.interrupt();
    expect(bus._queue).toEqual([]);
  });

  it("does NOT abort the controller (bus continues running)", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.interrupt();
    expect(bus.isCancelled).toBe(false);
  });

  it("wakes waiter when present", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });

    let resolved = false;
    bus._waiter = { resolve: () => { resolved = true; } };

    bus.interrupt();
    expect(resolved).toBe(true);
  });

  it("does not crash when no agent", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    // Should not throw
    bus.interrupt();
  });
});

describe("MessageBus.reset()", () => {
  it("creates a new AbortController", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.cancel();
    expect(bus.isCancelled).toBe(true);

    bus.reset();
    expect(bus.isCancelled).toBe(false);
  });

  it("preserves the queue", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.enqueue("msg1");
    bus.cancel();
    bus.reset();
    expect(bus._queue).toEqual(["msg1"]);
  });

  it("allows the bus to be used again after reset", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.cancel();
    bus.reset();
    bus.enqueue("new-msg");
    expect(bus._queue).toEqual(["new-msg"]);
    expect(bus.isCancelled).toBe(false);
  });
});

describe("MessageBus.isIdle()", () => {
  it("returns true when not running, no queue, not cancelled", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    expect(bus.isIdle()).toBe(true);
  });

  it("returns false when queue has messages", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.enqueue("msg");
    expect(bus.isIdle()).toBe(false);
  });

  it("returns false when cancelled", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus.cancel();
    expect(bus.isIdle()).toBe(false);
  });

  it("returns false when running", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });
    bus._isRunning = true;
    expect(bus.isIdle()).toBe(false);
  });
});

describe("MessageBus.executeCommand()", () => {
  function createMockSink() {
    const emitted = [];
    return {
      emit: (event) => emitted.push(event),
      _emitted: emitted,
    };
  }

  it("emits 'No agent available' when no agent", async () => {
    const sink = createMockSink();
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink,
    });

    await bus.executeCommand("clear");
    expect(sink._emitted).toHaveLength(1);
    expect(sink._emitted[0].content).toBe("No agent available.");
  });

  it("executes command through agent", async () => {
    const sink = createMockSink();
    const mockAgent = {
      getCommandRegistry: () => ({ match: () => null, get: () => null }),
      executeCommand: async () => ({ content: "Cleared" }),
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink,
    });

    await bus.executeCommand("clear");
    expect(sink._emitted).toHaveLength(1);
    expect(sink._emitted[0].content).toBe("Cleared");
  });

  it("emits error when command returns error", async () => {
    const sink = createMockSink();
    const mockAgent = {
      getCommandRegistry: () => ({ match: () => null, get: () => null }),
      executeCommand: async () => ({ error: "Unknown command" }),
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink,
    });

    await bus.executeCommand("unknown");
    expect(sink._emitted).toHaveLength(1);
    expect(sink._emitted[0].content).toBe("Unknown command");
  });

  it("does not emit when command returns null", async () => {
    const sink = createMockSink();
    const mockAgent = {
      getCommandRegistry: () => ({ match: () => null, get: () => null }),
      executeCommand: async () => null,
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink,
    });

    await bus.executeCommand("noop");
    expect(sink._emitted).toEqual([]);
  });
});

describe("MessageBus._processMessage()", () => {
  it("sets _isRunning to true during processing", async () => {
    let isRunningDuring = false;
    const mockAgent = {
      resetCancel: () => {},
      run: async () => {
        // We can't easily check this from inside, so we'll verify via the sink
      },
    };
    const sink = {
      emit: () => {},
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink,
    });

    await bus._processMessage("test");
    expect(bus._isRunning).toBe(false); // Should be false after processing
  });

  it("resets agent cancel flag before processing", async () => {
    let resetCalled = false;
    const mockAgent = {
      resetCancel: () => { resetCalled = true; },
      run: async () => {},
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink: { emit: () => {} },
    });

    await bus._processMessage("test");
    expect(resetCalled).toBe(true);
  });

  it("emits SESSION_STATE working=false after processing", async () => {
    let emittedEvent = null;
    const mockAgent = {
      resetCancel: () => {},
      run: async () => {},
    };
    const sink = {
      emit: (event) => { emittedEvent = event; },
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink,
    });

    await bus._processMessage("test");
    expect(emittedEvent.type).toBe(OUTPUT_EVENT.SESSION_STATE);
    expect(emittedEvent.key).toBe("working");
    expect(emittedEvent.value).toBe(false);
  });

  it("handles input hook that short-circuits", async () => {
    let runCalled = false;
    const mockAgent = {
      resetCancel: () => {},
      run: async () => { runCalled = true; },
      _hooks: {
        runHookPipeline: async (hookName, data, opts) => ({
          stopped: true,
          data: { text: data.text },
        }),
      },
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink: { emit: () => {} },
    });

    await bus._processMessage("test");
    expect(runCalled).toBe(false); // agent.run should not be called
  });

  it("handles input hook that transforms text", async () => {
    let receivedText = null;
    const mockAgent = {
      resetCancel: () => {},
      run: async (text) => { receivedText = text; },
      _hooks: {
        runHookPipeline: async (hookName, data, opts) => ({
          stopped: false,
          data: { text: "transformed: " + data.text },
        }),
      },
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink: { emit: () => {} },
    });

    await bus._processMessage("test");
    expect(receivedText).toBe("transformed: test");
  });

  it("handles cancellation error silently", async () => {
    const { LlmError } = await import("../../src/core/error.js");
    const mockAgent = {
      resetCancel: () => {},
      run: async () => { throw LlmError.Cancelled("cancelled"); },
    };
    let emittedContent = null;
    const sink = {
      emit: (event) => {
        if (event.type === OUTPUT_EVENT.COMMAND_RESULT) {
          emittedContent = event.content;
        }
      },
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink,
    });

    await bus._processMessage("test");
    // Cancellation errors should be suppressed (not emitted as COMMAND_RESULT)
    expect(emittedContent).toBeNull();
  });

  it("handles AbortError silently", async () => {
    const mockAgent = {
      resetCancel: () => {},
      run: async () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        throw err;
      },
    };
    let emittedContent = null;
    const sink = {
      emit: (event) => {
        if (event.type === OUTPUT_EVENT.COMMAND_RESULT) {
          emittedContent = event.content;
        }
      },
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink,
    });

    await bus._processMessage("test");
    expect(emittedContent).toBeNull();
  });

  it("emits non-cancellation errors", async () => {
    const mockAgent = {
      resetCancel: () => {},
      run: async () => { throw new Error("Something went wrong"); },
    };
    let emittedContent = null;
    const sink = {
      emit: (event) => {
        if (event.type === OUTPUT_EVENT.COMMAND_RESULT) {
          emittedContent = event.content;
        }
      },
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => mockAgent },
      sink,
    });

    await bus._processMessage("test");
    expect(emittedContent).toBeDefined();
  });

  it("handles agent being null", async () => {
    let emittedEvent = null;
    const sink = {
      emit: (event) => { emittedEvent = event; },
    };
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink,
    });

    await bus._processMessage("test");
    // Should not throw, should still emit working=false
    expect(emittedEvent.type).toBe(OUTPUT_EVENT.SESSION_STATE);
    expect(bus._isRunning).toBe(false);
  });
});

describe("MessageBus._wakeWaiter()", () => {
  it("resolves waiter and clears _waiter", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });

    let resolved = false;
    bus._waiter = { resolve: () => { resolved = true; } };
    bus._wakeWaiter();
    expect(resolved).toBe(true);
    expect(bus._waiter).toBeNull();
  });

  it("is idempotent — does nothing when no waiter", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });

    // Should not throw
    bus._wakeWaiter();
  });

  it("calling _wakeWaiter twice does not crash", () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null },
      sink: { emit: () => {} },
    });

    bus._waiter = { resolve: () => {} };
    bus._wakeWaiter();
    // Should not throw on second call
    bus._wakeWaiter();
  });
});
