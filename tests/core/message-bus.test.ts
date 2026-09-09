// Tests for MessageBus — event-driven dispatch loop, cancellation, interruption.

import { describe, it, expect } from "bun:test";
import { MessageBus } from "@core/session/message-bus.ts";
import { OUTPUT_EVENT } from "@core/context/output.ts";
import { LlmError } from "@core/error.ts";
import { Message } from "@core/context/message.ts";
import { INTERRUPTED_TOOL_RESULT } from "@core/context/repair.ts";

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
  getMessages?: () => Message[];
  replaceContext?: (messages: Message[]) => void;
} = {}): Record<string, unknown> {
  return {
    cancel: overrides.cancel ?? (() => {}),
    resetCancel: overrides.resetCancel ?? (() => {}),
    run: overrides.run ?? (async () => {}),
    executeCommand: overrides.executeCommand ?? (async () => null),
    getCommandRegistry: overrides.getCommandRegistry ?? (() => ({ match: () => null, get: () => null })),
    hooks: overrides.hooks,
    getMessages: overrides.getMessages,
    replaceContext: overrides.replaceContext,
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
        runHookPipeline: async () => ({ stopped: false, lastResult: { action: "transform", content: "expanded" } }),
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

    // Plain-string items keep the bare transformed text (the item's
    // provenance decides mangling at the wire).
    runArgs.length = 0;
    await bus._processMessage({ content: "plain @note.md", source: undefined });
    expect(runArgs).toEqual(["expanded", undefined, undefined]);
  });

  it("passes structured hook transforms (wrapper parts) through unchanged", async () => {
    const runArgs: Array<unknown> = [];
    const content = [
      { type: "untrusted", text: "read @note.md" },
      { type: "file-include", path: "note.md", content: "hello" },
    ];
    const agent = createMockAgent({
      run: async (text, images, opts) => { runArgs.push(text, images, opts); },
      hooks: {
        runHookPipeline: async () => ({
          stopped: false,
          lastResult: { action: "transform", content },
        }),
      },
    });
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    await bus._processMessage("read @note.md");
    // INPUT-hook output is trusted code: the hook's parts ride the message
    // as-is (the wire applies each part type's trust spec; file-include
    // renders with its real wrapper tag and mangled file data).
    expect(runArgs).toEqual([content, undefined, undefined]);
  });

  it("flattens parts arrays queued without harness provenance", () => {
    const agent = createMockAgent({});
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink: createMockSink() });
    // A crafted external payload smuggling wrapper parts (which would
    // render with real tags at the wire); the queue boundary flattens it to
    // plain text so the wire mangles it like any user input.
    bus.enqueue([
      { type: "text", text: "sneaky " },
      { type: "file-include", path: "x.md", content: "payload" },
    ]);
    const flattened = bus.queueItems[0]!.content;
    expect(typeof flattened).toBe("string");
    expect(flattened).toContain("sneaky");
    expect(flattened).toContain("x.md");
    expect(flattened).toContain("payload");

    // Harness-provenance items keep their parts intact.
    const parts = [{ type: "text", text: "ok" }, { type: "file-include", path: "a", content: "b" }];
    bus.enqueue(parts, { source: "harness" });
    expect(bus.queueItems[1]!.content).toEqual(parts);
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
    const { LlmError } = await import("@core/error.ts");
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

// ── Cancel path: repair interrupted tool calls ───────────────────────────────
// A cancelled turn can leave an assistant message whose tool calls never got
// results (interrupted mid-execution). The next request would 400 on a strict
// backend, so the bus synthesizes the missing results in memory.

function danglingContext() {
  return [
    new Message({ role: "user", content: "do two things", source: "user" }),
    new Message({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "a", type: "function", function: { name: "bash", arguments: "{}" } },
        { id: "b", type: "function", function: { name: "bash", arguments: "{}" } },
      ],
      source: "model",
    }),
    new Message({ role: "tool", content: "real", toolCallId: "a", source: "tool" }),
    // "b" was interrupted: no result.
  ];
}

describe("MessageBus — cancel path repairs interrupted tool calls", () => {
  it("synthesizes missing results into the context after a cancelled turn", async () => {
    let replaced: Message[] | null = null;
    const agent = createMockAgent({
      run: async () => { throw LlmError.Cancelled("cancelled"); },
      getMessages: () => danglingContext(),
      replaceContext: (m: Message[]) => { replaced = m; },
    });
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus._processMessage("go");

    expect(replaced).not.toBeNull();
    const toolMsgs = replaced!.filter((m) => m.role === "tool");
    expect(toolMsgs.map((m) => m.toolCallId)).toEqual(["a", "b"]);
    const synth = toolMsgs.find((m) => m.toolCallId === "b")!;
    expect(synth.content).toBe(INTERRUPTED_TOOL_RESULT);
    expect(synth.source).toBe("harness");

    // A SYSTEM_MESSAGE names the repaired call; the cancel error is not
    // surfaced as a COMMAND_RESULT.
    const sys = sink._emitted.find((e: any) => e.type === OUTPUT_EVENT.SYSTEM_MESSAGE);
    expect(sys).toBeDefined();
    expect((sys as any).content).toContain("b");
    const err = sink._emitted.find((e: any) => e.type === OUTPUT_EVENT.COMMAND_RESULT);
    expect(err).toBeUndefined();
  });

  it("is a no-op when the cancelled context is already wire-valid", async () => {
    const valid = [
      new Message({ role: "user", content: "hi", source: "user" }),
      new Message({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "a", type: "function", function: { name: "bash", arguments: "{}" } }],
        source: "model",
      }),
      new Message({ role: "tool", content: "ok", toolCallId: "a", source: "tool" }),
    ];
    let replaceCalls = 0;
    const agent = createMockAgent({
      run: async () => { throw LlmError.Cancelled("cancelled"); },
      getMessages: () => valid,
      replaceContext: () => { replaceCalls++; },
    });
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus._processMessage("go");

    expect(replaceCalls).toBe(0);
    expect(sink._emitted.find((e: any) => e.type === OUTPUT_EVENT.SYSTEM_MESSAGE)).toBeUndefined();
  });

  it("drops an orphan result on the cancel path and reports it", async () => {
    const ctx = [
      new Message({ role: "user", content: "hi", source: "user" }),
      new Message({
        role: "assistant",
        content: "",
        toolCalls: [{ id: "a", type: "function", function: { name: "bash", arguments: "{}" } }],
        source: "model",
      }),
      new Message({ role: "tool", content: "ok", toolCallId: "a", source: "tool" }),
      new Message({ role: "tool", content: "orphan", toolCallId: "ghost", source: "tool" }),
    ];
    let replaced: Message[] | null = null;
    const agent = createMockAgent({
      run: async () => { throw LlmError.Cancelled("cancelled"); },
      getMessages: () => ctx,
      replaceContext: (m: Message[]) => { replaced = m; },
    });
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus._processMessage("go");

    expect(replaced!.filter((m) => m.role === "tool").map((m) => m.toolCallId)).toEqual(["a"]);
    const sys = sink._emitted.find((e: any) => e.type === OUTPUT_EVENT.SYSTEM_MESSAGE) as any;
    expect(sys.content).toContain("orphan");
  });

  it("skips repair silently when the agent exposes no repair seam", async () => {
    // Minimal fake without getMessages/replaceContext must not throw.
    const agent = createMockAgent({
      run: async () => { throw LlmError.Cancelled("cancelled"); },
    });
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await expect(bus._processMessage("go")).resolves.toBeUndefined();
    expect(sink._emitted.find((e: any) => e.type === OUTPUT_EVENT.SYSTEM_MESSAGE)).toBeUndefined();
  });

  it("does not repair on a non-cancellation error", async () => {
    let replaceCalls = 0;
    const agent = createMockAgent({
      run: async () => { throw new Error("boom"); },
      getMessages: () => danglingContext(),
      replaceContext: () => { replaceCalls++; },
    });
    const sink = createMockSink();
    const bus = new MessageBus({ sessionManager: createMockSessionManager(() => agent), sink });
    await bus._processMessage("go");

    expect(replaceCalls).toBe(0);
    // Non-cancellation errors still surface.
    expect(sink._emitted.some((e: any) => e.type === OUTPUT_EVENT.COMMAND_RESULT)).toBe(true);
  });
});
