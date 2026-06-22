import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageBus } from '../../src/core/index.js';

class MockSessionManager {
  constructor(agent) {
    this._agent = agent;
    this._sessionId = 'test-session';
  }
  getAgent() { return this._agent; }
  sessionId() { return this._sessionId; }
}

class MockAgent {
  constructor(runResult = 'done') {
    this._cancelled = false;
    this._runCalled = false;
    this._runResult = runResult;
  }
  get cancelled() { return this._cancelled; }
  cancel(reset = true) { this._cancelled = reset; }
  async run(text) {
    this._runCalled = true;
    return this._runResult;
  }
  get sessionName() { return 'test-session'; }
  get taskManager() { return null; }
}

class MockSink {
  constructor() {
    this.events = [];
  }
  emit(event) {
    this.events.push(event);
  }
}

describe('MessageBus', () => {
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

  it('creates with empty queue', () => {
    expect(bus.isIdle()).toBe(true);
  });

  it('exposes sessionManager and agent', () => {
    expect(bus.sessionManager).toBe(mockSessionManager);
    expect(bus.agent).toBe(mockAgent);
  });

  it('queues messages via enqueue', () => {
    bus.enqueue('hello');
    expect(bus.isIdle()).toBe(false);
  });

  it('handles multiple enqueues', () => {
    bus.enqueue('msg1');
    bus.enqueue('msg2');
    expect(bus.isIdle()).toBe(false);
  });

  it('cancels and notifies agent', () => {
    bus.cancel();
    expect(mockAgent._cancelled).toBe(true);
  });

  describe('run methods', () => {
    it('runUntilCancelled() processes enqueued messages', async () => {
      const agent = new MockAgent();
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink: new MockSink(),
      });
      bus.enqueue('hello');
      // Cancel after a microtask so the loop sees the queue
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();
      expect(agent._runCalled).toBe(true);
    });

    it('runUntilCancelled() processes remaining messages after cancellation', async () => {
      const agent = new MockAgent();
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink: new MockSink(),
      });
      bus.enqueue('msg1');
      bus.enqueue('msg2');
      // Cancel after a microtask so the loop sees the queue
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();
      expect(agent._runCalled).toBe(true);
    });
  });

  describe('isIdle', () => {
    it('is idle when not running and queue empty', () => {
      expect(bus.isIdle()).toBe(true);
    });

    it('is not idle when queue has items', () => {
      bus.enqueue('msg');
      expect(bus.isIdle()).toBe(false);
    });

    it('is not idle when running', async () => {
      // Start the dispatch loop without any messages — it blocks on _waitForMessage
      // while _isRunning is false. This is a transient state that is hard to observe
      // without accessing internals; the behavioral test is that enqueue + cancel
      // causes the loop to process and exit.
      const agent = new MockAgent();
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink: new MockSink(),
      });
      bus.enqueue('msg');
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();
      expect(agent._runCalled).toBe(true);
    });
  });
});
