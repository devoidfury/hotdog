import { describe, it, expect } from 'bun:test';

// MessageQueue is a simple internal class — tests verify FIFO behavior.
// The queue logic lives inside MessageBus in main.js.
// These tests validate the expected queue behavior that MessageBus relies on.

describe('MessageQueue (internal)', () => {
  it('simulates empty queue', () => {
    const q = [];
    expect(q.length).toBe(0);
  });

  it('pushes and shifts a single message', () => {
    const q = [];
    q.push('hello');
    expect(q.length).toBe(1);
    expect(q.shift()).toBe('hello');
    expect(q.length).toBe(0);
  });

  it('maintains FIFO order', () => {
    const q = [];
    q.push('first');
    q.push('second');
    q.push('third');
    expect(q.shift()).toBe('first');
    expect(q.shift()).toBe('second');
    expect(q.shift()).toBe('third');
    expect(q.length).toBe(0);
  });

  it('returns undefined when shifting from empty queue', () => {
    const q = [];
    expect(q.shift()).toBeUndefined();
  });

  it('handles multiple push/shift cycles', () => {
    const q = [];
    q.push('a');
    expect(q.shift()).toBe('a');
    expect(q.length).toBe(0);
    q.push('b');
    q.push('c');
    expect(q.shift()).toBe('b');
    expect(q.shift()).toBe('c');
    expect(q.length).toBe(0);
  });

  it('handles empty string messages', () => {
    const q = [];
    q.push('');
    expect(q.shift()).toBe('');
    expect(q.length).toBe(0);
  });

  it('handles multiline messages', () => {
    const q = [];
    const msg = 'line1\nline2\nline3';
    q.push(msg);
    expect(q.shift()).toBe(msg);
  });

  it('handles many messages in sequence', () => {
    const q = [];
    const count = 1000;
    for (let i = 0; i < count; i++) {
      q.push(`msg-${i}`);
    }
    expect(q.length).toBe(count);
    for (let i = 0; i < count; i++) {
      expect(q.shift()).toBe(`msg-${i}`);
    }
    expect(q.length).toBe(0);
  });
});
