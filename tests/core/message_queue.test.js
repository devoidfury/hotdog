import { describe, it, expect } from 'bun:test';
import { MessageQueue } from '../src/agent/message_queue.js';

describe('MessageQueue', () => {
  it('starts empty', () => {
    const q = new MessageQueue();
    expect(q.isEmpty()).toBe(true);
  });

  it('pushes and shifts a single message', () => {
    const q = new MessageQueue();
    q.push('hello');
    expect(q.isEmpty()).toBe(false);
    expect(q.shift()).toBe('hello');
    expect(q.isEmpty()).toBe(true);
  });

  it('maintains FIFO order', () => {
    const q = new MessageQueue();
    q.push('first');
    q.push('second');
    q.push('third');
    expect(q.shift()).toBe('first');
    expect(q.shift()).toBe('second');
    expect(q.shift()).toBe('third');
    expect(q.isEmpty()).toBe(true);
  });

  it('returns undefined when shifting from empty queue', () => {
    const q = new MessageQueue();
    expect(q.shift()).toBeUndefined();
  });

  it('handles multiple push/shift cycles', () => {
    const q = new MessageQueue();
    q.push('a');
    expect(q.shift()).toBe('a');
    expect(q.isEmpty()).toBe(true);
    q.push('b');
    q.push('c');
    expect(q.shift()).toBe('b');
    expect(q.shift()).toBe('c');
    expect(q.isEmpty()).toBe(true);
  });

  it('handles empty string messages', () => {
    const q = new MessageQueue();
    q.push('');
    expect(q.shift()).toBe('');
    expect(q.isEmpty()).toBe(true);
  });

  it('handles multiline messages', () => {
    const q = new MessageQueue();
    const msg = 'line1\nline2\nline3';
    q.push(msg);
    expect(q.shift()).toBe(msg);
  });

  it('handles many messages in sequence', () => {
    const q = new MessageQueue();
    const count = 1000;
    for (let i = 0; i < count; i++) {
      q.push(`msg-${i}`);
    }
    expect(q.isEmpty()).toBe(false);
    for (let i = 0; i < count; i++) {
      expect(q.shift()).toBe(`msg-${i}`);
    }
    expect(q.isEmpty()).toBe(true);
  });
});
