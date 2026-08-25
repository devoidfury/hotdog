// Tests for src/extensions/ui-one-shot/oneshot-channel.ts — OneShotChannel.
// Base Channel behavior (send/enqueue, attach/detach, close, command routing)
// is covered in tests/core/channel.test.ts. Only the behavior specific to this
// subclass (sink routing, no-input read) is tested here.

import { describe, it, expect, mock } from "bun:test";
import { OneShotChannel } from "../../src/extensions/ui-one-shot/oneshot-channel.ts";
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
  sink.emit = mock(() => {});
  return sink;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OneShotChannel - construction", () => {
  it("attaches to the given session and emits its events through the sink", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        // Fire events through the handler to verify the wiring
        handler({ type: OUTPUT_EVENT.USER_MESSAGE, content: "User input" });
        handler({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "AI response" });
        return () => {};
      }),
    });
    const sink = createMockSink();

    new OneShotChannel({ sessionManager: sm, sessionId: "session-1", sink });

    expect(sm.onSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
    expect(sink.emit).toHaveBeenCalledTimes(2);
    expect(sink.emit).toHaveBeenNthCalledWith(1, { type: OUTPUT_EVENT.USER_MESSAGE, content: "User input" });
    expect(sink.emit).toHaveBeenNthCalledWith(2, { type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "AI response" });
  });
});

describe("OneShotChannel - read()", () => {
  it("yields nothing (no input in one-shot mode)", async () => {
    const channel = new OneShotChannel({
      sessionManager: createMockSessionManager(),
      sessionId: "session-1",
      sink: createMockSink(),
    });

    const results: string[] = [];
    for await (const line of channel.read()) {
      results.push(line);
    }
    expect(results).toEqual([]);
  });
});
