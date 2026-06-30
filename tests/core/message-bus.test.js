import { describe, it, expect, beforeEach } from 'bun:test';
import { MessageBus } from '../../src/core/index.js';
import { LlmError } from '../../src/core/error.js';
import { HookSystem } from '../../src/core/hooks.js';

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
    this._runError = null; // if set, run() throws this error
  }
  get cancelled() { return this._cancelled; }
  cancel() { this._cancelled = true; }
  resetCancel() { this._cancelled = false; }
  async run(text) {
    this._runCalled = true;
    if (this._runError) throw this._runError;
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
      expect(bus.isCancelled).toBe(true);
    });

  describe('interrupt()', () => {
    it('cancels agent and clears queue', () => {
      bus.enqueue('msg1');
      bus.enqueue('msg2');
      bus.interrupt();
      expect(mockAgent._cancelled).toBe(true);
      expect(bus.isIdle()).toBe(true);
      // interrupt does NOT cancel the bus — bus continues running
      expect(bus.isCancelled).toBe(false);
    });

    it('does not end the run loop — bus continues after interrupt', async () => {
      const agent = new MockAgent();
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink: new MockSink(),
      });

      bus.enqueue('msg1');
      bus.interrupt();  // clears queue, cancels agent

      // After interrupt, bus should still accept new messages
      expect(bus.isIdle()).toBe(true);
      bus.enqueue('msg2');
      expect(bus.isIdle()).toBe(false);

      // Run the loop — it should process the post-interrupt message
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();
      expect(agent._runCalled).toBe(true);
    });

    it('agent cancelled flag is reset before next run', async () => {
      const agent = new MockAgent();
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink: new MockSink(),
      });

      bus.interrupt();  // sets agent._cancelled = true
      expect(agent._cancelled).toBe(true);

      // Enqueue and process — _processMessage calls agent.resetCancel() at start
      bus.enqueue('msg');
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();
      // After processing, agent._cancelled is false (reset at start of processing)
      expect(agent._cancelled).toBe(false);
    });
  });

  describe('cancellation error suppression', () => {
    it('suppresses LlmError.Cancelled from agent.run()', async () => {
      const sink = new MockSink();
      const agent = new MockAgent();
      agent._runError = LlmError.Cancelled('Agent cancelled');
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink,
      });

      bus.enqueue('msg');
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();

      // No COMMAND_RESULT events should be emitted for cancellation
      const cmdResults = sink.events.filter(e => e.type === 7);
      expect(cmdResults.length).toBe(0);
    });

    it('suppresses AbortError from agent.run()', async () => {
      const sink = new MockSink();
      const agent = new MockAgent();
      // Simulate a DOMException AbortError
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      agent._runError = abortError;
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink,
      });

      bus.enqueue('msg');
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();

      const cmdResults = sink.events.filter(e => e.type === 7);
      expect(cmdResults.length).toBe(0);
    });

    it('still emits non-cancellation errors', async () => {
      const sink = new MockSink();
      const agent = new MockAgent();
      agent._runError = new Error('Real error');
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink,
      });

      bus.enqueue('msg');
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();

      const cmdResults = sink.events.filter(e => e.type === 7);
      expect(cmdResults.length).toBe(1);
      expect(cmdResults[0].content).toContain('Real error');
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

  describe('isCancelled', () => {
    it('is false before cancel', () => {
      expect(bus.isCancelled).toBe(false);
    });

    it('is true after cancel', () => {
      bus.cancel();
      expect(bus.isCancelled).toBe(true);
    });

    it('is false after reset', () => {
      bus.cancel();
      expect(bus.isCancelled).toBe(true);
      bus.reset();
      expect(bus.isCancelled).toBe(false);
    });

    it('bus is not idle when cancelled', () => {
      bus.cancel();
      expect(bus.isIdle()).toBe(false);
    });
  });

  describe('reset()', () => {
    it('creates a new AbortController after cancel', () => {
      bus.cancel();
      expect(bus.isCancelled).toBe(true);
      bus.reset();
      expect(bus.isCancelled).toBe(false);
    });

    it('allows reuse after cancel + reset', async () => {
      bus.cancel();
      bus.reset();
      bus.enqueue('msg');
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();
      expect(mockAgent._runCalled).toBe(true);
    });
  });

  describe('executeCommand()', () => {
    it('emits error when no agent', async () => {
      const noAgentManager = { getAgent: () => null };
      const sink = new MockSink();
      const bus = new MessageBus({ sessionManager: noAgentManager, sink });
      await bus.executeCommand('/help');
      const results = sink.events.filter(e => e.type === 7);
      expect(results.length).toBe(1);
      expect(results[0].content).toBe('No agent available.');
    });
  });

  describe('input hook handling', () => {
    it('processes messages when input hook returns continue', async () => {
      const hooks = new HookSystem();
      const agent = new MockAgent();
      agent._hooks = hooks;
      hooks.on('input', (data) => { return { action: 'continue' }; });
      const sink = new MockSink();
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink,
      });

      bus.enqueue('hello');
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();
      expect(agent._runCalled).toBe(true);
    });

    it('skips agent run when input hook returns handled', async () => {
      const hooks = new HookSystem();
      const agent = new MockAgent();
      agent._hooks = hooks;
      hooks.on('input', (data) => { return { action: 'handled' }; });
      const sink = new MockSink();
      const bus = new MessageBus({
        sessionManager: new MockSessionManager(agent),
        sink,
      });

      bus.enqueue('hello');
      await Promise.resolve();
      bus.cancel();
      await bus.runUntilCancelled();
      // Agent should NOT have been run
      expect(agent._runCalled).toBe(false);
      // But should emit working=false session state
      const states = sink.events.filter(e => e.type === 14);
      expect(states.length).toBe(1);
      expect(states[0].key).toBe('working');
      expect(states[0].value).toBe(false);
    });
  });
});