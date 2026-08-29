// Tests for MessageBus — event-driven dispatch loop, cancellation, interruption.

import { describe, it, expect } from "bun:test";
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
  run?: (
    content?: string | Array<Record<string, unknown>>,
    images?: unknown,
    opts?: { source?: string },
  ) => Promise<void>;
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
});

describe("MessageBus.enqueue() with content parts", () => {
  it("stores parts items verbatim; the queue getter flattens to text", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    bus.enqueue([
      { type: "text", text: "[Task t1 completed]\n" },
      { type: "untrusted", text: "raw result" },
    ], { source: "harness" });
    expect(bus.isIdle()).toBe(false);
    // Flattened text form (parts joined with newlines), never the structure.
    expect(bus.queue).toEqual(["[Task t1 completed]\n\nraw result"]);
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
    expect(() => bus.cancel()).not.toThrow();
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
    expect(() => bus.interrupt()).not.toThrow();
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

describe("MessageBus — processing behavior", () => {
  it("resets agent cancel flag before processing", async () => {
    let resetCalled = false;
    const agent = createMockAgent({ resetCancel: () => { resetCalled = true; } });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    // _processMessage is internal but needed to verify cancel flag reset behavior
    await bus._processMessage("test");
    expect(resetCalled).toBe(true);
  });

  it("passes harness provenance from queue items to agent.run", async () => {
    const runArgs: Array<unknown> = [];
    const agent = createMockAgent({
      run: async (text, images, opts) => { runArgs.push(text, images, opts); },
    });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage({ content: "[Task t1 completed]\ndone", source: "harness" });
    expect(runArgs).toEqual(["[Task t1 completed]\ndone", undefined, { source: "harness" }]);
  });

  it("passes content parts through to agent.run verbatim", async () => {
    const runArgs: Array<unknown> = [];
    const parts = [
      { type: "text", text: "[Task t1 completed]\n" },
      { type: "untrusted", text: "raw result" },
    ];
    const agent = createMockAgent({
      run: async (text, images, opts) => { runArgs.push(text, images, opts); },
    });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage({ content: parts, source: "harness" });
    expect(runArgs).toEqual([parts, undefined, { source: "harness" }]);
  });

  it("wraps hook transforms of parts content as an untrusted part", async () => {
    const runArgs: Array<unknown> = [];
    const agent = createMockAgent({
      run: async (text, images, opts) => { runArgs.push(text, images, opts); },
      hooks: {
        runHookPipeline: async () => ({ stopped: false, lastResult: { action: "transform", text: "expanded" } }),
      },
    });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage({
      content: [
        { type: "text", text: "[Task t1 completed]\n" },
        { type: "untrusted", text: "@note.md" },
      ],
      source: "harness",
    });
    // The flattened transform output must not inherit the harness exemption.
    expect(runArgs).toEqual([[{ type: "untrusted", text: "expanded" }], undefined, { source: "harness" }]);

    // Plain-string items keep the bare transformed text.
    runArgs.length = 0;
    await bus._processMessage({ content: "plain @note.md", source: undefined });
    expect(runArgs).toEqual(["expanded", undefined, undefined]);
  });

  it("omits source opts for plain user input", async () => {
    const runArgs: Array<unknown> = [];
    const agent = createMockAgent({
      run: async (text, images, opts) => { runArgs.push(text, images, opts); },
    });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage("hello");
    expect(runArgs).toEqual(["hello", undefined, undefined]);
  });

  it("exposes harness provenance on the INPUT hook payload as origin", async () => {
    let inputPayload: Record<string, unknown> | null = null;
    const agent = createMockAgent({
      hooks: {
        runHookPipeline: async (_hook: string, data: unknown) => {
          inputPayload = data as Record<string, unknown>;
          return { stopped: false, lastResult: null };
        },
      },
    });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage({
      content: [
        { type: "text", text: "harness " },
        { type: "untrusted", text: "text" },
      ],
      source: "harness",
    });
    expect(inputPayload).not.toBeNull();
    expect(inputPayload!.origin).toBe("harness");
    // Hooks see flattened text, not the parts structure.
    expect(inputPayload!.text).toBe("harness \ntext");
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

  it("queue getter/setter works", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.queue).toEqual([]);
    bus.queue = ["msg1", "msg2"];
    expect(bus.queue).toEqual(["msg1", "msg2"]);
  });

  it("isRunning getter/setter works", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.isRunning).toBe(false);
    bus.isRunning = true;
    expect(bus.isRunning).toBe(true);
  });

  it("abortController getter returns AbortController", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.abortController).toBeInstanceOf(AbortController);
  });

  it("waiter getter/setter works", () => {
    const bus = new MessageBus({ sessionManager: createMockSessionManager(), sink: createMockSink() });
    expect(bus.waiter).toBeNull();
    const resolve = () => {};
    bus.waiter = { resolve };
    expect(bus.waiter).toEqual({ resolve });
  });
});
