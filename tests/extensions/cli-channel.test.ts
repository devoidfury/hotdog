// Tests for src/extensions/ui-interactive-cli/cli-channel.ts — CliChannel.
// Base Channel behavior (send/enqueue, attach/detach, switchSession, close,
// command routing) is covered in tests/core/channel.test.ts. Only the
// readline/sink wiring specific to this subclass is tested here.

import { describe, it, expect, mock } from "bun:test";
import readline from "node:readline";
import { CliChannel } from "../../src/extensions/ui-interactive-cli/cli-channel.ts";
import { ChannelSessionManager } from "../../src/core/channel.ts";
import { OUTPUT_EVENT } from "../../src/core/context/output.ts";
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

function createMockRl(responses: string[] = []): { rl: readline.Interface; close: ReturnType<typeof mock> } {
  let index = 0;
  const close = mock(() => {});

  const mockRl = {
    removeListener: function () { return mockRl; },
    on: function (_event: string, _handler: (...args: unknown[]) => void) {
      return mockRl;
    },
    prompt: function () { return mockRl; },
    close,
    [Symbol.asyncIterator]: function () {
      const iterator = {
        next: async () => {
          if (index < responses.length) {
            return { value: responses[index++], done: false };
          }
          return { value: undefined, done: true };
        },
        return: async () => ({ value: undefined, done: true }),
        [Symbol.asyncIterator]() {
          return this;
        },
      };
      return iterator;
    },
  } as unknown as readline.Interface;

  return { rl: mockRl, close };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("CliChannel - construction", () => {
  it("attaches to the given session and routes its events through the sink", () => {
    const { rl } = createMockRl();
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        // Fire an event through the handler to verify the wiring
        handler({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "Hello" });
        return () => {};
      }),
    });
    const sink = createMockSink();

    new CliChannel({ sessionManager: sm, sessionId: "session-1", sink, rl });

    expect(sm.onSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
    expect(sink.emit).toHaveBeenCalledWith({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "Hello" });
  });
});

describe("CliChannel - read()", () => {
  it("yields lines from readline", async () => {
    const lines: string[] = [];
    const { rl } = createMockRl(["line1", "line2"]);
    const channel = new CliChannel({
      sessionManager: createMockSessionManager(),
      sessionId: "session-1",
      sink: createMockSink(),
      rl,
    });

    for await (const line of channel.read()) {
      lines.push(line);
    }
    expect(lines).toEqual(["line1", "line2"]);
  });
});

describe("CliChannel - cleanup", () => {
  it("closes readline on close", () => {
    const { rl, close } = createMockRl();
    const channel = new CliChannel({
      sessionManager: createMockSessionManager(),
      sessionId: "session-1",
      sink: createMockSink(),
      rl,
    });

    channel.close();
    expect(close).toHaveBeenCalled();
  });
});

describe("CliChannel - handleQuit", () => {
  it("closes readline and calls onQuit callback", async () => {
    const onQuitFn = mock(() => {});
    const { rl, close } = createMockRl();
    const channel = new CliChannel({
      sessionManager: createMockSessionManager(),
      sessionId: "session-1",
      sink: createMockSink(),
      rl,
      onQuit: onQuitFn,
    });

    await channel.send("/quit");

    expect(close).toHaveBeenCalled();
    expect(onQuitFn).toHaveBeenCalled();
  });

  it("handles quit without onQuit callback", async () => {
    const { rl, close } = createMockRl();
    const channel = new CliChannel({
      sessionManager: createMockSessionManager(),
      sessionId: "session-1",
      sink: createMockSink(),
      rl,
    });

    await expect(channel.send("/quit")).resolves.toBeUndefined();
    expect(close).toHaveBeenCalled();
  });
});
