// Tests for src/extensions/ui-one-shot/oneshot-channel.ts — OneShotChannel.
// Covers: construction, write/read, subscribe/unsubscribe, cleanup,
// event collection, getters.

import { describe, it, expect, beforeEach, mock } from "bun:test";
import { OneShotChannel } from "../../src/extensions/ui-one-shot/oneshot-channel.ts";
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
  sink.emit = mock(() => {});
  return sink;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("OneShotChannel - construction", () => {
  let sm: ChannelSessionManager;
  let sink: CliOutputSink;

  beforeEach(() => {
    sm = createMockSessionManager();
    sink = createMockSink();
  });

  it("creates a OneShotChannel with required options", () => {
    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    expect(channel).toBeInstanceOf(OneShotChannel);
    expect(channel.getCurrentSessionId()).toBe("session-1");
  });

  it("attaches to the given session on construction", () => {
    new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    expect(sm.onSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
  });

  it("initializes with empty events array", () => {
    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    expect(channel.events).toEqual([]);
  });
});

describe("OneShotChannel - write()", () => {
  let sm: ChannelSessionManager;
  let sink: CliOutputSink;
  let channel: OneShotChannel;

  beforeEach(() => {
    sm = createMockSessionManager();
    sink = createMockSink();
    channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });
  });

  it("delegates to sink.emit()", () => {
    const event: OutputEvent = { type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "Hello" };
    // Write is protected, so we test via the subscription flow
    // The events array should be populated when write is called
  });

  it("collects events when fired through subscription", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        // Fire multiple events
        handler({ type: OUTPUT_EVENT.USER_MESSAGE, content: "User input" });
        handler({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "AI response" });
        handler({ type: OUTPUT_EVENT.TOOL_CALL, toolName: "test", input: {} });
        return () => {};
      }),
    });
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    expect(channel.events.length).toBe(3);
    expect(channel.events[0]!.type).toBe(OUTPUT_EVENT.USER_MESSAGE);
    expect(channel.events[1]!.type).toBe(OUTPUT_EVENT.ASSISTANT_MESSAGE);
    expect(channel.events[2]!.type).toBe(OUTPUT_EVENT.TOOL_CALL);
  });

  it("calls sink.emit for each event", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "Hello" });
        handler({ type: OUTPUT_EVENT.COMMAND_RESULT, content: "Done" });
        return () => {};
      }),
    });
    const sink = createMockSink();

    new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    expect(sink.emit).toHaveBeenCalledTimes(2);
  });
});

describe("OneShotChannel - read()", () => {
  it("yields nothing (no input in one-shot mode)", async () => {
    const sm = createMockSessionManager();
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    const results: string[] = [];
    for await (const line of channel.read()) {
      results.push(line);
    }

    expect(results).toEqual([]);
  });
});

describe("OneShotChannel - subscribe/unsubscribe", () => {
  let sm: ChannelSessionManager;
  let sink: CliOutputSink;
  let unsubscribeFn: () => void;

  beforeEach(() => {
    unsubscribeFn = mock(() => {});
    sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, _handler) => unsubscribeFn),
    });
    sink = createMockSink();
  });

  it("subscribes when attaching", () => {
    new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    expect(sm.onSessionEvents).toHaveBeenCalledWith("session-1", expect.any(Function));
  });

  it("unsubscribes when detaching", () => {
    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    channel.detach("session-1");

    expect(unsubscribeFn).toHaveBeenCalled();
  });
});

describe("OneShotChannel - cleanup", () => {
  it("does nothing on cleanup (no resources to release)", () => {
    const sm = createMockSessionManager();
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    // Should not throw
    channel.close();
    expect(true).toBe(true);
  });
});

describe("OneShotChannel - getters", () => {
  it("exposes collected events", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        handler({ type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "Hello" });
        return () => {};
      }),
    });
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    expect(channel.events.length).toBe(1);
    expect(channel.events[0]!.content).toBe("Hello");
  });

  it("exposes output sink", () => {
    const sm = createMockSessionManager();
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    expect(channel.sink).toBe(sink);
  });
});

describe("OneShotChannel - send regular text", () => {
  it("enqueues text to current session", async () => {
    const sm = createMockSessionManager();
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    await channel.send("hello world");

    expect(sm.enqueue).toHaveBeenCalledWith("session-1", "hello world");
  });
});

describe("OneShotChannel - multiple session management", () => {
  it("can attach to multiple sessions", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock(() => () => {}),
    });
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    channel.attach("session-2");

    expect(channel.attachedSessions.has("session-1")).toBe(true);
    expect(channel.attachedSessions.has("session-2")).toBe(true);
  });
});

describe("OneShotChannel - event types", () => {
  it("collects all event types", () => {
    const eventsToFire: OutputEvent[] = [
      { type: OUTPUT_EVENT.USER_MESSAGE, content: "user" },
      { type: OUTPUT_EVENT.ASSISTANT_MESSAGE, content: "assistant" },
      { type: OUTPUT_EVENT.THINKING, content: "thinking" },
      { type: OUTPUT_EVENT.TOOL_CALL, toolName: "test", input: {} },
      { type: OUTPUT_EVENT.TOOL_RESULT, toolName: "test", result: "ok" },
      { type: OUTPUT_EVENT.COMPACTING, message: "compacting" },
      { type: OUTPUT_EVENT.COMMAND_RESULT, content: "result" },
      { type: OUTPUT_EVENT.QUESTION, questions: [] },
      { type: OUTPUT_EVENT.STREAMING_CHUNK, content: "chunk" },
      { type: OUTPUT_EVENT.STREAMING_REASONING_CHUNK, content: "reasoning" },
      { type: OUTPUT_EVENT.TASK_PROGRESS, taskId: "1", status: "running" },
      { type: OUTPUT_EVENT.TOKEN_USAGE, promptTokens: 10, completionTokens: 5, totalTokens: 15 },
      { type: OUTPUT_EVENT.COMPACTION_RESULT, summary: "summary", messagesCompacted: 5 },
      { type: OUTPUT_EVENT.SESSION_STATE, key: "state", value: "val" },
    ];

    const sm = createMockSessionManager({
      onSessionEvents: mock((_sessionId, handler) => {
        for (const event of eventsToFire) {
          handler(event);
        }
        return () => {};
      }),
    });
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    expect(channel.events.length).toBe(eventsToFire.length);
    for (let i = 0; i < eventsToFire.length; i++) {
      expect(channel.events[i]!.type).toBe(eventsToFire[i]!.type);
    }
  });
});

describe("OneShotChannel - close behavior", () => {
  it("detaches from sessions on close", () => {
    const sm = createMockSessionManager({
      onSessionEvents: mock(() => () => {}),
    });
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    channel.attach("session-2");
    expect(channel.attachedSessions.size).toBe(2);

    channel.close();
    expect(channel.attachedSessions.size).toBe(0);
  });

  it("does not send when closed", async () => {
    const sm = createMockSessionManager();
    const sink = createMockSink();

    const channel = new OneShotChannel({
      sessionManager: sm,
      sessionId: "session-1",
      sink,
    });

    channel.close();
    await channel.send("should not send");

    expect(sm.enqueue).not.toHaveBeenCalled();
  });
});
