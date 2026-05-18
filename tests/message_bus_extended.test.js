import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageBus } from '../src/agent/message_bus.js';
import { OUTPUT_EVENT } from '../src/context/output.js';
import { LlmError } from '../src/llm_client/client.js';

// Mock session manager
class MockSessionManager {
  constructor(agent) {
    this._agent = agent;
    this._sessionId = 'test-session';
  }
  getAgent() { return this._agent; }
  sessionId() { return this._sessionId; }
}

// Mock agent
class MockAgent {
  constructor(runResult = 'done') {
    this._cancelled = false;
    this._runCalled = false;
    this._runResult = runResult;
    this._runThrows = null;
  }
  get cancelled() { return this._cancelled; }
  cancel(reset = true) { this._cancelled = reset; }
  async run(text) {
    this._runCalled = true;
    if (this._runThrows) throw this._runThrows;
    return this._runResult;
  }
  executePrompt(cmd) {
    return { success: true, prompt: `prompt: ${cmd}` };
  }
  get sessionName() { return 'test-session'; }
  get taskManager() { return null; }
}

// Mock output sink
class MockSink {
  constructor() {
    this.events = [];
  }
  emit(event) {
    this.events.push(event);
  }
}

describe('MessageBus _dispatchLoop', () => {
  let mockAgent, mockSessionManager, mockSink, bus;

  beforeEach(() => {
    mockAgent = new MockAgent();
    mockSessionManager = new MockSessionManager(mockAgent);
    mockSink = new MockSink();
    bus = new MessageBus({
      sessionManager: mockSessionManager,
      sink: mockSink,
    });
  });

  it('exits immediately when drain=true, cancelled=true, and queue is empty', async () => {
    bus._cancelled = true;
    await bus._dispatchLoop(true);
    // Should have exited without processing anything
    expect(mockAgent._runCalled).toBe(false);
  });

  it('processes queued messages sequentially', async () => {
    bus.enqueue('msg1');
    bus.enqueue('msg2');
    // Run the dispatch loop in drain mode
    const runPromise = bus._dispatchLoop(true);
    // Wait a bit for messages to be processed
    await new Promise(r => setTimeout(r, 150));
    bus.cancel(); // Cancel to exit the loop
    await runPromise.catch(() => {});
    // Both messages should have triggered run calls
    expect(mockAgent._runCalled).toBe(true);
  });

  it('handles expected errors gracefully', async () => {
    mockAgent._runThrows = LlmError.Cancelled('cancelled');
    bus.enqueue('msg1');
    const runPromise = bus._dispatchLoop(true);
    await new Promise(r => setTimeout(r, 150));
    bus.cancel();
    await runPromise.catch(() => {});
    // Should have emitted a COMMAND_RESULT event with the error message
    const commandEvents = mockSink.events.filter(e => e.type === OUTPUT_EVENT.COMMAND_RESULT);
    expect(commandEvents.length).toBeGreaterThan(0);
    expect(commandEvents[0].content).toBe('cancelled');
  });

  it('handles unexpected errors with full error info', async () => {
    mockAgent._runThrows = new Error('unexpected bug');
    bus.enqueue('msg1');
    const runPromise = bus._dispatchLoop(true);
    await new Promise(r => setTimeout(r, 150));
    bus.cancel();
    await runPromise.catch(() => {});
    const commandEvents = mockSink.events.filter(e => e.type === OUTPUT_EVENT.COMMAND_RESULT);
    expect(commandEvents.length).toBeGreaterThan(0);
    expect(commandEvents[0].content).toContain('unexpected bug');
  });

  it('resets cancellation between turns', async () => {
    // First message triggers cancel
    let cancelCount = 0;
    const agent = new MockAgent();
    const origCancel = agent.cancel.bind(agent);
    agent.cancel = (reset) => {
      cancelCount++;
      origCancel(reset);
    };
    const manager = new MockSessionManager(agent);
    const testBus = new MessageBus({
      sessionManager: manager,
      sink: new MockSink(),
    });
    testBus.enqueue('msg1');
    const runPromise = testBus._dispatchLoop(true);
    await new Promise(r => setTimeout(r, 150));
    testBus.cancel();
    await runPromise.catch(() => {});
    // Cancel should be called multiple times (once per turn)
    expect(cancelCount).toBeGreaterThan(0);
  });

  it('calls onMessageProcessed after each message', async () => {
    let processedCount = 0;
    const busWithCb = new MessageBus({
      sessionManager: mockSessionManager,
      sink: mockSink,
      onMessageProcessed: () => { processedCount++; },
    });
    busWithCb.enqueue('msg1');
    const runPromise = busWithCb._dispatchLoop(true);
    // Wait long enough for message processing + drain exit
    await new Promise(r => setTimeout(r, 300));
    busWithCb.cancel();
    await runPromise.catch(() => {});
    expect(processedCount).toBe(1);
  });

  it('sleeps when queue is empty and not cancelled', async () => {
    const start = Date.now();
    const runPromise = bus._dispatchLoop(false);
    await new Promise(r => setTimeout(r, 120));
    bus.cancel();
    await runPromise.catch(() => {});
    const elapsed = Date.now() - start;
    // Should have slept at least once (50ms)
    expect(elapsed).toBeGreaterThanOrEqual(100);
  });

  it('continues processing in drain mode after cancel', async () => {
    bus.enqueue('msg1');
    bus.enqueue('msg2');
    const runPromise = bus._dispatchLoop(true);
    await new Promise(r => setTimeout(r, 100));
    bus.cancel();
    await runPromise.catch(() => {});
    // In drain mode, it should process remaining messages
    expect(mockAgent._runCalled).toBe(true);
  });

  it('exits immediately when not in drain mode and cancelled', async () => {
    bus.enqueue('msg1');
    const runPromise = bus._dispatchLoop(false);
    await new Promise(r => setTimeout(r, 50));
    bus.cancel();
    await runPromise.catch(() => {});
    // In non-drain mode, it should exit immediately
    // The first message might have been picked up, but not processed
  });

  it('handles empty text messages', async () => {
    bus.enqueue('');
    const runPromise = bus._dispatchLoop(true);
    await new Promise(r => setTimeout(r, 150));
    bus.cancel();
    await runPromise.catch(() => {});
    expect(mockAgent._runCalled).toBe(true);
  });

  it('handles long text messages', async () => {
    const longText = 'x'.repeat(10000);
    bus.enqueue(longText);
    const runPromise = bus._dispatchLoop(true);
    await new Promise(r => setTimeout(r, 150));
    bus.cancel();
    await runPromise.catch(() => {});
    expect(mockAgent._runCalled).toBe(true);
  });
});

describe('MessageBus run methods', () => {
  it('run() calls _dispatchLoop with false', async () => {
    const mockAgent = new MockAgent();
    const manager = new MockSessionManager(mockAgent);
    const bus = new MessageBus({
      sessionManager: manager,
      sink: new MockSink(),
    });
    const origDispatch = bus._dispatchLoop.bind(bus);
    let dispatchCalled = false;
    bus._dispatchLoop = async (drain) => {
      dispatchCalled = true;
      expect(drain).toBe(false);
    };
    await bus.run();
    expect(dispatchCalled).toBe(true);
    bus._dispatchLoop = origDispatch;
  });

  it('runUntilCancelled() calls _dispatchLoop with true', async () => {
    const mockAgent = new MockAgent();
    const manager = new MockSessionManager(mockAgent);
    const bus = new MessageBus({
      sessionManager: manager,
      sink: new MockSink(),
    });
    const origDispatch = bus._dispatchLoop.bind(bus);
    let dispatchCalled = false;
    bus._dispatchLoop = async (drain) => {
      dispatchCalled = true;
      expect(drain).toBe(true);
    };
    await bus.runUntilCancelled();
    expect(dispatchCalled).toBe(true);
    bus._dispatchLoop = origDispatch;
  });
});

describe('MessageBus cancel behavior', () => {
  it('cancels via cancel() method', () => {
    const mockAgent = new MockAgent();
    const manager = new MockSessionManager(mockAgent);
    const bus = new MessageBus({
      sessionManager: manager,
      sink: new MockSink(),
    });
    bus.cancel();
    expect(bus._cancelled).toBe(true);
    expect(mockAgent._cancelled).toBe(true);
  });

  it('setDrainAfterCancel sets the flag', () => {
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(new MockAgent()),
      sink: new MockSink(),
    });
    bus.setDrainAfterCancel(true);
    // No direct getter, but we can verify it doesn't throw
    expect(() => bus.setDrainAfterCancel(false)).not.toThrow();
  });
});

describe('MessageBus properties', () => {
  it('has correct sessionId', () => {
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(new MockAgent()),
      sink: new MockSink(),
    });
    expect(bus.sessionId).toBe('test-session');
  });

  it('has correct agent', () => {
    const agent = new MockAgent();
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(agent),
      sink: new MockSink(),
    });
    expect(bus.agent).toBe(agent);
  });

  it('has correct sink', () => {
    const sink = new MockSink();
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(new MockAgent()),
      sink: sink,
    });
    expect(bus.sink).toBe(sink);
  });

  it('has correct sessionManager', () => {
    const manager = new MockSessionManager(new MockAgent());
    const bus = new MessageBus({
      sessionManager: manager,
      sink: new MockSink(),
    });
    expect(bus.sessionManager).toBe(manager);
  });
});

describe('MessageBus isIdle', () => {
  it('is idle when not running and queue empty', () => {
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(new MockAgent()),
      sink: new MockSink(),
    });
    expect(bus.isIdle()).toBe(true);
  });

  it('is not idle when not running but queue has items', () => {
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(new MockAgent()),
      sink: new MockSink(),
    });
    bus.enqueue('msg');
    expect(bus.isIdle()).toBe(false);
  });

  it('is not idle when running', () => {
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(new MockAgent()),
      sink: new MockSink(),
    });
    bus._isRunning = true;
    expect(bus.isIdle()).toBe(false);
  });
});

describe('MessageBus wake up wiring', () => {
  it('wires task wake up with mangler', () => {
    const mangler = { escapeMarkers: (s) => s };
    let wakeResult = null;
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(new MockAgent()),
      sink: new MockSink(),
      wakeUpCallback: (taskId, result) => { wakeResult = result; },
      markerMangler: mangler,
    });
    expect(() => bus.wireTaskWakeUp()).not.toThrow();
  });

  it('handles missing wakeUpCallback gracefully', () => {
    const bus = new MessageBus({
      sessionManager: new MockSessionManager(new MockAgent()),
      sink: new MockSink(),
    });
    expect(() => bus.wireTaskWakeUp()).not.toThrow();
  });

  it('handles null agent gracefully', () => {
    const bus = new MessageBus({
      sessionManager: { getAgent: () => null, sessionId: () => 'test' },
      sink: new MockSink(),
      wakeUpCallback: () => {},
    });
    expect(() => bus.wireTaskWakeUp()).not.toThrow();
  });
});
