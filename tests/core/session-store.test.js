import { describe, it, expect } from 'bun:test';
import { SessionStore } from '../../src/core/session/index.ts';
import { MockAgent } from '../helpers.js';

describe('SessionStore', () => {
  it('stores, retrieves, and removes agents by session ID', () => {
    const store = new SessionStore();
    const agent1 = new MockAgent('done', 'session-1');
    const agent2 = new MockAgent('done', 'session-2');

    expect(store.addAgent(agent1)).toBe('session-1');
    expect(store.addAgent(agent2)).toBe('session-2');
    expect(store.size()).toBe(2);

    expect(store.getAgent('session-1')).toBe(agent1);
    expect(store.getAgent('unknown')).toBeUndefined();

    expect(store.removeAgent('session-1')).toBe(true);
    expect(store.removeAgent('non-existent')).toBe(false);
    expect(store.size()).toBe(1);
    expect(store.getAgent('session-1')).toBeUndefined();
  });

  it('returns all agents', () => {
    const store = new SessionStore();
    const agent1 = new MockAgent('done', 'session-1');
    const agent2 = new MockAgent('done', 'session-2');
    store.addAgent(agent1);
    store.addAgent(agent2);
    const agents = store.agents();
    expect(agents).toHaveLength(2);
    expect(agents).toContain(agent1);
    expect(agents).toContain(agent2);
  });

  it('replaces existing agent when addAgent is called with same session ID', () => {
    const store = new SessionStore();
    const agent1 = new MockAgent('done', 'session-1');
    const agent2 = new MockAgent('done', 'session-1');
    store.addAgent(agent1);
    store.addAgent(agent2);
    expect(store.size()).toBe(1);
    expect(store.getAgent('session-1')).toBe(agent2);
  });

  it('tracks the initial session ID', () => {
    const store = new SessionStore();
    expect(store.initialSessionId()).toBeNull();

    const agent1 = new MockAgent('done', 'session-1');
    store.addAgent(agent1);
    expect(store.initialSessionId()).toBe('session-1');

    const agent2 = new MockAgent('done', 'session-2');
    store.addAgent(agent2);
    // initialSessionId should remain the first one added
    expect(store.initialSessionId()).toBe('session-1');
  });
});
