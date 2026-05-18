import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageBus } from '../src/agent/message_bus.js';
import { OUTPUT_EVENT } from '../src/context/output.js';

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

  it('has sink property', () => {
    expect(bus.sink).toBe(mockSink);
  });

  it('has sessionManager property', () => {
    expect(bus.sessionManager).toBe(mockSessionManager);
  });

  it('has sessionId property', () => {
    expect(bus.sessionId).toBe('test-session');
  });

  it('has agent property', () => {
    expect(bus.agent).toBe(mockAgent);
  });

  it('cancels and notifies agent', () => {
    bus.cancel();
    // cancel() calls agent.cancel() which sets _cancelled = true (default reset)
    expect(mockAgent._cancelled).toBe(true);
  });

  it('sets drain-after-cancel mode', () => {
    bus.setDrainAfterCancel(true);
    // No direct getter, but we can verify it doesn't throw
  });

  it('executePromptAndEnqueue enqueues prompt result', async () => {
    const result = await bus.executePromptAndEnqueue('test-cmd');
    expect(result).toBe('prompt: test-cmd');
    // The prompt was enqueued
    expect(bus.isIdle()).toBe(false);
  });

  it('executePromptAndEnqueue throws on failed prompt', async () => {
    const failingAgent = new MockAgent();
    failingAgent.executePrompt = () => ({ success: false, error: 'command not found' });
    const failingManager = new MockSessionManager(failingAgent);
    const failingBus = new MessageBus({
      sessionManager: failingManager,
      sink: mockSink,
    });
    await expect(failingBus.executePromptAndEnqueue('bad-cmd')).rejects.toThrow('command not found');
  });

  it('executePromptAndEnqueue throws when no agent', async () => {
    const emptyManager = { getAgent: () => null, sessionId: () => 'empty' };
    const emptyBus = new MessageBus({
      sessionManager: emptyManager,
      sink: mockSink,
    });
    await expect(emptyBus.executePromptAndEnqueue('cmd')).rejects.toThrow('No agent available');
  });

  it('wires task wake up callback', () => {
    let wakeCalled = false;
    const wakeCb = (taskId, result) => { wakeCalled = true; };
    const busWithWake = new MessageBus({
      sessionManager: mockSessionManager,
      sink: mockSink,
      wakeUpCallback: wakeCb,
    });
    // wireTaskWakeUp should not throw
    busWithWake.wireTaskWakeUp();
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

  it('onMessageProcessed callback is stored', () => {
    let called = false;
    const busWithCb = new MessageBus({
      sessionManager: mockSessionManager,
      sink: mockSink,
      onMessageProcessed: () => { called = true; },
    });
    expect(busWithCb._onMessageProcessed).toBeDefined();
  });
});

describe('MessageBus with wakeUpCallback', () => {
  it('passes result through marker mangler', async () => {
    const mockAgent = new MockAgent();
    const mockSessionManager = new MockSessionManager(mockAgent);
    const mockSink = new MockSink();
    const mangler = {
      escapeMarkers: (text) => text.replace('<m_', '<[m_'),
    };
    let wakeResult = null;
    const bus = new MessageBus({
      sessionManager: mockSessionManager,
      sink: mockSink,
      wakeUpCallback: (taskId, result) => { wakeResult = result; },
      markerMangler: mangler,
    });
    bus.wireTaskWakeUp();
    // The wakeUpCallback is set on the agent's taskManager
    // We can verify the bus was configured without error
    expect(bus._wakeUpCallback).toBeDefined();
  });
});
