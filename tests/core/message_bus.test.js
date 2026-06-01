import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageBus } from '../../src/main.js';

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
  constructor() {
    this._cancelled = false;
    this._runCalled = false;
    this._runResult = undefined;
  }
  get cancelled() { return this._cancelled; }
  cancel(reset = true) { this._cancelled = reset; }
  async run(text) {
    this._runCalled = true;
    this._runResult = text;
    return this._runResult;
  }
  executePrompt(cmd) {
    return { success: true, prompt: `prompt: ${cmd}` };
  }
  get sessionName() { return 'test-session'; }
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

  it('queues messages via enqueue', () => {
    bus.enqueue('hello');
    // Queue is no longer empty
    expect(bus.isIdle()).toBe(false);
  });

  it('has sessionManager property', () => {
    expect(bus.sessionManager).toBe(mockSessionManager);
  });

  it('has agent property', () => {
    expect(bus.agent).toBe(mockAgent);
  });

  it('cancels and notifies agent', () => {
    bus.cancel();
    // cancel() calls agent.cancel() which sets _cancelled = true (default reset)
    expect(mockAgent._cancelled).toBe(true);
  });

  it('sleep returns a promise', () => {
    const sleepPromise = bus._sleep(10);
    expect(sleepPromise).toBeInstanceOf(Promise);
  });

  it('handles multiple enqueues', () => {
    bus.enqueue('msg1');
    bus.enqueue('msg2');
    bus.enqueue('msg3');
    expect(bus.isIdle()).toBe(false);
  });
});
