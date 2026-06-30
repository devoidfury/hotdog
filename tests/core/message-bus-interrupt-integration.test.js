// Integration test: MessageBus interrupt() behavior.
// Simulates what happens when Ctrl-C is pressed during agent processing:
//   - interrupt() cancels the agent and clears the queue
//   - cancellation errors are suppressed
//   - the bus continues running (does not exit)

import { describe, it, expect } from 'bun:test';
import { MessageBus } from '../../src/core/index.js';
import { LlmError } from '../../src/core/error.js';
import { OUTPUT_EVENT } from '../../src/core/context/output.js';

// ── Mocks ───────────────────────────────────────────────────────────────────

class MockSessionManager {
  constructor(agent) {
    this._agent = agent;
    this._sessionId = 'integ-test';
  }
  getAgent() { return this._agent; }
  sessionId() { return this._sessionId; }
}

class TrackingSink {
  constructor() {
    this.events = [];
  }
  emit(event) {
    this.events.push(event);
  }
  commandResults() {
    return this.events.filter(e => e.type === OUTPUT_EVENT.COMMAND_RESULT);
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('MessageBus interrupt integration', () => {

  it('interrupt() cancels agent and clears queue without ending the loop', async () => {
    const agent = {
      _cancelled: false,
      cancel() { this._cancelled = true; },
      resetCancel() { this._cancelled = false; },
      run: async () => 'done',
      get cancelled() { return this._cancelled; },
      get sessionName() { return 'test'; },
      get taskManager() { return null; },
    };
    const sink = new TrackingSink();
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(agent),
      sink,
    });

    bus.enqueue('msg1');
    bus.enqueue('msg2');
    expect(bus.isIdle()).toBe(false);

    // interrupt() should clear queue and cancel agent
    bus.interrupt();
    expect(agent._cancelled).toBe(true);
    expect(bus.isIdle()).toBe(true);

    // After interrupt, bus should still accept new messages
    bus.enqueue('msg3');
    expect(bus.isIdle()).toBe(false);
  });

  it('bus processes messages normally after interrupt + reset', async () => {
    let runCount = 0;
    const agent = {
      _cancelled: false,
      cancel() { this._cancelled = true; },
      resetCancel() { this._cancelled = false; },
      run: async (text) => {
        runCount++;
        return `processed: ${text}`;
      },
      get cancelled() { return this._cancelled; },
      get sessionName() { return 'test'; },
      get taskManager() { return null; },
    };
    const sink = new TrackingSink();
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(agent),
      sink,
    });

    // Interrupt when idle
    bus.interrupt();

    // Enqueue and process normally
    bus.enqueue('hello');
    await Promise.resolve();
    bus.cancel();
    await bus.runUntilCancelled();

    expect(runCount).toBe(1);
    expect(sink.commandResults().length).toBe(0);
  });

  it('suppresses LlmError.Cancelled during message processing', async () => {
    let resolveRun;
    const agent = {
      _cancelled: false,
      cancel() {
        this._cancelled = true;
        if (resolveRun) {
          resolveRun();
        }
      },
      resetCancel() { this._cancelled = false; },
      async run(text) {
        await new Promise((r) => { resolveRun = r; });
        if (this._cancelled) throw LlmError.Cancelled('Agent cancelled');
        return 'done';
      },
      get cancelled() { return this._cancelled; },
      get sessionName() { return 'test'; },
      get taskManager() { return null; },
    };
    const sink = new TrackingSink();
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(agent),
      sink,
    });

    // Start loop in background
    const loop = bus.runUntilCancelled();

    // Wait for loop to be ready
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Enqueue message
    bus.enqueue('hello');

    // Wait for agent.run() to start (the await inside run())
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // Simulate Ctrl-C: interrupt the bus
    bus.interrupt();

    // Wait for _processMessage to catch the cancellation and finish
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // No COMMAND_RESULT should be emitted for cancellation
    expect(sink.commandResults().length).toBe(0);

    // Agent cancelled flag is NOT reset here — it's reset at the start
    // of the next message processing, not after catching cancellation.
    expect(agent._cancelled).toBe(true);

    // End the loop
    bus.cancel();
    await loop;
  });

  it('still emits non-cancellation errors', async () => {
    const agent = {
      _cancelled: false,
      cancel() { this._cancelled = true; },
      resetCancel() { this._cancelled = false; },
      async run(text) { throw new Error('Real error'); },
      get cancelled() { return this._cancelled; },
      get sessionName() { return 'test'; },
      get taskManager() { return null; },
    };
    const sink = new TrackingSink();
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(agent),
      sink,
    });

    bus.enqueue('hello');
    await Promise.resolve();
    bus.cancel();
    await bus.runUntilCancelled();

    const cmdResults = sink.commandResults();
    expect(cmdResults.length).toBe(1);
    expect(cmdResults[0].content).toContain('Real error');
  });

});
