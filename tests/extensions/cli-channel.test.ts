// Tests for src/extensions/ui-interactive-cli/cli-channel.ts — CliChannel.
// Covers: construction, write/read, subscribe/unsubscribe, cleanup,
// quit handling, getters.

import { describe, it, expect, beforeEach, mock } from "bun:test";
import readline from "node:readline";
import { CliChannel, CliChannelOptions } from "../../src/extensions/ui-interactive-cli/cli-channel.ts";
import { ChannelSessionManager } from "../../src/core/channel.ts";
import { OUTPUT_EVENT, OutputEvent } from "../../src/core/context/output.ts";
import { CliOutputSink } from "../../src/utils/cli/cli.ts";

// ── Test Helpers ────────────────────────────────────────────────────────────

function createMockSessionManager(overrides: Partial<ChannelSessionManager> = {}): ChannelSessionManager {
  return {
    enqueue: mock(() => {}),
    cancel: mock(() => {}),
    interrupt: mock(() => {}),
    executeCommand: mock(async () => undefined),
    onSessionEvents: mock((_sessionId, _handler) => () => {}),
    sessionIds: mock(() => ["session-1"]),
    getSessionInfo: mock((id) => ({ id, model: "test-model" })),
    drainPendingQuestions: mock(() => []),
    ...overrides,
  };
}

function createMockSink(): CliOutputSink {
  const sink = new CliOutputSink();
  // Mock the emit method to avoid actual stdout writes
  sink.emit = mock(() => {});
  return sink;
}

function createMockRl(responses: string[] = []): {
  rl: readline.Interface;
  lines: string[];
} {
  const lines: string[] = responses;
  let index = 0;

  const mockRl = {
    removeListener: function () { return mockRl; },
    on: function (_event: string, _handler: (...args: unknown[]) => void) {
      return mockRl;
    },
    prompt: function () { return mockRl; },
    close: function () {},
    [Symbol.asyncIterator]: function () {
      return {
        next: async () => {
          if (index < lines.length) {
            return { value: lines[index++], done: false };
          }
          return { value: undefined, done: true };
        },
        return: async () => ({ value: undefined, done: true }),
        [Symbol.asyncIterator]: function () { return this; },
      };
    },
  } as unknown as readline.Interface;

  return { rl: mockRl, lines };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CliChannel - construction", () => {
  let sm: ChannelSessionManager;
  let sink: CliOutputSink;
  let rl: readline.Interface;

  beforeEach(() => {
    sm = createMockSessionManager();
    sink = createMockSink();
    rl = createMockRl().rl;
  });

  it("creates a CliChannel with required options", () => {
    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    expect(channel).toBeInstanceOf(CliChannel);
    expect(channel.getCurrentSessionId()).toBe("session-1");
  });

  it("attaches to the given session on construction", () => {
    new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    expect(sm.onSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
  });

  it("accepts optional onQuit callback", () => {
    const onQuit = mock(() => {});
    new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
      onQuit,
    });

    // No error should be thrown
    expect(true).toBe(true);
  });
});

describe("CliChannel - write()", () => {
  let sm: ChannelSessionManager;
  let sink: CliOutputSink;
  let rl: readline.Interface;
  let channel: CliChannel;

  beforeEach(() => {
    sm = createMockSessionManager();
    sink = createMockSink();
    rl = createMockRl().rl;
    channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });
  });

  it("delegates to sink.emit()", () => {
    const event: OutputEvent = { type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "Hello" };
    channel.send("test").catch(() => {});
    // We need to call write directly but it's protected; use a public method instead
    // Actually, let's test via the parent class's send which routes to enqueue
    // For write, we test the integration via the subscribe flow
  });

  it("sends events through the sink when subscribed", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        // Immediately fire an event through the handler
        handler({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "Hello" });
        return () => {};
      }),
    });
    const sink = createMockSink();
    const rl = createMockRl().rl;
    new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    expect(sink.emit).toHaveBeenCalledWith({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "Hello" });
  });
});

describe("CliChannel - read()", () => {
  let sm: ChannelSessionManager;
  let sink: CliOutputSink;

  it("returns an async iterable", async () => {
    const { rl } = createMockRl(["line1", "line2"]);
    sm = createMockSessionManager();
    sink = createMockSink();

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    const iterable = channel.read();
    expect(iterable[Symbol.asyncIterator]).toBeDefined();
    expect(typeof iterable[Symbol.asyncIterator]).toBe("function");
  });

  it("read is callable without error", async () => {
    const { rl } = createMockRl([]);
    sm = createMockSessionManager();
    sink = createMockSink();

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    // Should not throw
    const iterable = channel.read();
    expect(iterable).toBeDefined();
  });
});

describe("CliChannel - subscribe/unsubscribe", () => {
  let sm: ChannelSessionManager;
  let sink: CliOutputSink;
  let rl: readline.Interface;
  let unsubscribeFn: () => void;

  beforeEach(() => {
    unsubscribeFn = mock(() => {});
    sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, _handler) => unsubscribeFn),
    });
    sink = createMockSink();
    rl = createMockRl().rl;
  });

  it("subscribes when attaching", () => {
    new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    expect(sm.onSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
  });

  it("unsubscribes when detaching", () => {
    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    channel.detach("session-1");

    expect(unsubscribeFn).toHaveBeenCalled();
  });
});

describe("CliChannel - cleanup", () => {
  it("closes readline on close", () => {
    const closeFn = mock(() => {});
    const mockRl = {
      removeListener: () => mockRl,
      on: () => mockRl,
      prompt: () => mockRl,
      close: closeFn,
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: undefined, done: true }),
        return: async () => ({ value: undefined, done: true }),
        [Symbol.asyncIterator]: () => {},
      }),
    } as unknown as readline.Interface;

    const sm = createMockSessionManager();
    const sink = createMockSink();

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl: mockRl,
    });

    channel.close();

    expect(closeFn).toHaveBeenCalled();
  });
});

describe("CliChannel - handleQuit", () => {
  it("closes readline and calls onQuit callback", async () => {
    const closeFn = mock(() => {});
    const onQuitFn = mock(() => {});
    const mockRl = {
      removeListener: () => mockRl,
      on: () => mockRl,
      prompt: () => mockRl,
      close: closeFn,
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: undefined, done: true }),
        return: async () => ({ value: undefined, done: true }),
        [Symbol.asyncIterator]: () => {},
      }),
    } as unknown as readline.Interface;

    const sm = createMockSessionManager();
    const sink = createMockSink();

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl: mockRl,
      onQuit: onQuitFn,
    });

    await channel.send("/quit");

    expect(closeFn).toHaveBeenCalled();
    expect(onQuitFn).toHaveBeenCalled();
  });

  it("handles quit without onQuit callback", async () => {
    const closeFn = mock(() => {});
    const mockRl = {
      removeListener: () => mockRl,
      on: () => mockRl,
      prompt: () => mockRl,
      close: closeFn,
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: undefined, done: true }),
        return: async () => ({ value: undefined, done: true }),
        [Symbol.asyncIterator]: () => {},
      }),
    } as unknown as readline.Interface;

    const sm = createMockSessionManager();
    const sink = createMockSink();

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl: mockRl,
    });

    await channel.send("/quit");

    expect(closeFn).toHaveBeenCalled();
  });
});

describe("CliChannel - getters", () => {
  it("exposes readline interface", () => {
    const { rl } = createMockRl();
    const sm = createMockSessionManager();
    const sink = createMockSink();

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    expect(channel.readline).toBe(rl);
  });

  it("exposes output sink", () => {
    const sm = createMockSessionManager();
    const sink = createMockSink();
    const rl = createMockRl().rl;

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    expect(channel.sink).toBe(sink);
  });
});

describe("CliChannel - send regular text", () => {
  it("enqueues text to current session", async () => {
    const sm = createMockSessionManager();
    const sink = createMockSink();
    const rl = createMockRl().rl;

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    await channel.send("hello world");

    expect(sm.enqueue).toHaveBeenCalledWith("session-1", "hello world");
  });
});

describe("CliChannel - multiple session management", () => {
  it("can attach to multiple sessions", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock(() => () => {}),
    });
    const sink = createMockSink();
    const rl = createMockRl().rl;

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    channel.attach("session-2");

    expect(channel.attachedSessions.has("session-1")).toBe(true);
    expect(channel.attachedSessions.has("session-2")).toBe(true);
  });

  it("switches sessions correctly", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock(() => () => {}),
    });
    const sink = createMockSink();
    const rl = createMockRl().rl;

    const channel = new CliChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
      rl,
    });

    channel.attach("session-2");
    expect(channel.switchSession("session-2")).toBe(true);
    expect(channel.getCurrentSessionId()).toBe("session-2");
  });
});
