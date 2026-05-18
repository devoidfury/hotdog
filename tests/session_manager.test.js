import { describe, it, expect, beforeEach } from 'bun:test';
import { SessionManager } from '../src/agent/session_manager.js';

// Mock agent
class MockAgent {
  static _counter = 0;
  constructor(sessionId) {
    this.sessionId = sessionId || `session-${++MockAgent._counter}`;
    this._sink = null;
  }
  setSink(sink) { this._sink = sink; }
  getSink() { return this._sink; }
}

// Mock session builder
class MockBuilder {
  async buildAgent(sink) {
    const agent = new MockAgent();
    agent.setSink(sink);
    return agent;
  }
}

// Mock output sink
class MockSink {
  constructor() { this.events = []; }
  emit(event) { this.events.push(event); }
}

describe('SessionManager', () => {
  let builder, sink, manager;

  beforeEach(async () => {
    builder = new MockBuilder();
    sink = new MockSink();
    manager = await SessionManager.create(builder, sink);
  });

  it('creates with an initial agent', async () => {
    const agent = manager.getAgent();
    expect(agent).not.toBeNull();
    expect(agent).toBeInstanceOf(MockAgent);
  });

  it('has a session ID', () => {
    const sessionId = manager.sessionId();
    expect(sessionId).toBeDefined();
    expect(typeof sessionId).toBe('string');
  });

  it('gets agent by session ID', () => {
    const agent = manager.getAgent();
    const byId = manager.getAgentBySessionId(agent.sessionId);
    expect(byId).toBe(agent);
  });

  it('returns null for unknown session ID', () => {
    expect(manager.getAgentBySessionId('unknown-session')).toBeNull();
  });

  it('creates a new session', async () => {
    const newSink = new MockSink();
    const newSessionId = await manager.newSession(newSink);
    expect(newSessionId).toBeDefined();

    // The new session becomes current
    expect(manager.sessionId()).toBe(newSessionId);

    // Can get the agent for the new session
    const newAgent = manager.getAgentBySessionId(newSessionId);
    expect(newAgent).not.toBeNull();
    expect(newAgent.getSink()).toBe(newSink);
  });

  it('switches to a different session', async () => {
    const agent1 = manager.getAgent();
    const sessionId1 = agent1.sessionId;

    // Create a second session
    const sessionId2 = await manager.newSession(new MockSink());
    expect(sessionId2).not.toBe(sessionId1);
    expect(manager.sessionId()).toBe(sessionId2);

    // Switch back
    const switchedAgent = manager.switchSession(sessionId1);
    expect(switchedAgent).toBe(agent1);
    expect(manager.sessionId()).toBe(sessionId1);
  });

  it('returns null when switching to unknown session', () => {
    const result = manager.switchSession('unknown-session');
    expect(result).toBeNull();
  });

  it('sets sink on current agent', () => {
    const newSink = new MockSink();
    manager.setSink(newSink);
    const agent = manager.getAgent();
    expect(agent.getSink()).toBe(newSink);
  });

  it('returns the builder', () => {
    const b = manager.builder();
    expect(b).toBeInstanceOf(MockBuilder);
  });
});

describe('SessionManager with multiple sessions', () => {
  let builder, sink, manager;

  beforeEach(async () => {
    builder = new MockBuilder();
    sink = new MockSink();
    manager = await SessionManager.create(builder, sink);
  });

  it('tracks multiple sessions', async () => {
    const id1 = await manager.newSession(new MockSink());
    expect(id1).not.toBeNull();

    const id2 = await manager.newSession(new MockSink());
    expect(id2).not.toBeNull();
    expect(id1).not.toBe(id2);
  });

  it('switches between sessions correctly', async () => {
    const agent1 = manager.getAgent();
    const id1 = agent1.sessionId;

    const id2 = await manager.newSession(new MockSink());
    const agent2 = manager.getAgent();

    expect(id1).not.toBe(id2);

    // Switch back to first
    manager.switchSession(id1);
    expect(manager.sessionId()).toBe(id1);
    expect(manager.getAgent()).toBe(agent1);

    // Switch to second
    manager.switchSession(id2);
    expect(manager.sessionId()).toBe(id2);
    expect(manager.getAgent()).toBe(agent2);
  });

  it('swapAgent replaces current agent', async () => {
    const originalAgent = manager.getAgent();

    const newAgent = await manager.swapAgent(async (b) => {
      const agent = new MockAgent('swapped-session');
      agent.setSink(new MockSink());
      return agent;
    });

    expect(newAgent).not.toBe(originalAgent);
    expect(newAgent.sessionId).toBe('swapped-session');
    expect(manager.sessionId()).toBe('swapped-session');
  });
});
