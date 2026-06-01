import { describe, it, expect } from 'bun:test';
import { SessionStore } from '../../src/core/session.js';

// Mock agent factory for testing
class MockAgent {
  constructor(sessionId) {
    this.sessionId = sessionId;
  }
}

describe('SessionStore', () => {
  it('initializes empty', () => {
    const store = new SessionStore();
    expect(store.size()).toBe(0);
  });

  it('stores and retrieves agent by session ID', () => {
    const agent = new MockAgent('session-1');
    const store = new SessionStore();
    store.addAgent(agent);
    const retrieved = store.getAgent('session-1');
    expect(retrieved).toBe(agent);
  });

  it('returns undefined for unknown session ID', () => {
    const store = new SessionStore();
    expect(store.getAgent('unknown-session')).toBeUndefined();
  });

  it('adds a new agent', () => {
    const store = new SessionStore();
    const agent1 = new MockAgent('session-1');
    store.addAgent(agent1);
    const agent2 = new MockAgent('session-2');
    const sessionId = store.addAgent(agent2);
    expect(sessionId).toBe('session-2');
    expect(store.size()).toBe(2);
  });

  it('removes an agent', () => {
    const store = new SessionStore();
    const agent1 = new MockAgent('session-1');
    store.addAgent(agent1);
    const agent2 = new MockAgent('session-2');
    store.addAgent(agent2);
    expect(store.size()).toBe(2);
    const removed = store.removeAgent('session-1');
    expect(removed).toBe(true);
    expect(store.size()).toBe(1);
    expect(store.getAgent('session-1')).toBeUndefined();
  });

  it('returns false when removing non-existent agent', () => {
    const store = new SessionStore();
    expect(store.removeAgent('non-existent')).toBe(false);
  });

  it('returns all agents', () => {
    const store = new SessionStore();
    const agent1 = new MockAgent('session-1');
    const agent2 = new MockAgent('session-2');
    const agent3 = new MockAgent('session-3');
    store.addAgent(agent1);
    store.addAgent(agent2);
    store.addAgent(agent3);
    const agents = store.agents();
    expect(agents).toHaveLength(3);
    expect(agents).toContain(agent1);
    expect(agents).toContain(agent2);
    expect(agents).toContain(agent3);
  });

  it('handles multiple sessions correctly', () => {
    const store = new SessionStore();
    store.addAgent(new MockAgent('a'));
    store.addAgent(new MockAgent('b'));
    store.addAgent(new MockAgent('c'));
    expect(store.getAgent('a')).toBeDefined();
    expect(store.getAgent('b')).toBeDefined();
    expect(store.getAgent('c')).toBeDefined();
    expect(store.getAgent('d')).toBeUndefined();
  });

  it('updates existing agent when addAgent is called with same session ID', () => {
    const store = new SessionStore();
    const agent1 = new MockAgent('session-1');
    store.addAgent(agent1);
    const agent2 = new MockAgent('session-1');
    store.addAgent(agent2);
    expect(store.size()).toBe(1);
    expect(store.getAgent('session-1')).toBe(agent2);
  });
});
