import { describe, it, expect } from 'bun:test';
import { Message } from '../../src/core/context/message.js';

describe('Message', () => {
  it('creates a message with all fields', () => {
    const msg = new Message({
      role: 'assistant',
      content: 'Hello',
      reasoningContent: 'Thinking',
      toolCalls: [{ id: '1' }],
      toolCallId: '1',
    });
    expect(msg.role).toBe('assistant');
    expect(msg.content).toBe('Hello');
    expect(msg.reasoningContent).toBe('Thinking');
    expect(msg.toolCalls).toEqual([{ id: '1' }]);
    expect(msg.toolCallId).toBe('1');
  });

  it('creates a minimal message', () => {
    const msg = new Message({ role: 'user', content: 'Hi' });
    expect(msg.role).toBe('user');
    expect(msg.content).toBe('Hi');
    expect(msg.reasoningContent).toBeNull();
    expect(msg.toolCalls).toBeNull();
    expect(msg.toolCallId).toBeNull();
  });

  it('defaults to empty object', () => {
    const msg = new Message();
    expect(msg.role).toBeUndefined();
    expect(msg.content).toBeUndefined();
  });

  it('serializes to JSON with all fields', () => {
    const msg = new Message({
      role: 'assistant',
      content: 'Hi',
      reasoningContent: 'Thoughts',
      toolCalls: [{ id: '1' }],
      toolCallId: '1',
    });
    const json = msg.toJSON();
    expect(json).toEqual({
      role: 'assistant',
      content: 'Hi',
      reasoning_content: 'Thoughts',
      tool_calls: [{ id: '1' }],
      tool_call_id: '1',
    });
  });

  it('serializes minimal message', () => {
    const msg = new Message({ role: 'user', content: 'Hi' });
    const json = msg.toJSON();
    expect(json).toEqual({ role: 'user', content: 'Hi' });
  });

  it('omits null fields from JSON', () => {
    const msg = new Message({ role: 'user', content: 'Hi' });
    const json = msg.toJSON();
    expect(json).not.toHaveProperty('reasoning_content');
    expect(json).not.toHaveProperty('tool_calls');
    expect(json).not.toHaveProperty('tool_call_id');
  });

  it('includes empty/null content as empty string in JSON', () => {
    const msg = new Message({ role: 'user', content: null });
    const json = msg.toJSON();
    expect(json).toHaveProperty('content', '');
  });
});
