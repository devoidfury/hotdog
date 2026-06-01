import { describe, it, expect } from 'bun:test';
import { Message, SystemMessage, MessageLog } from '../../src/context/message.js';

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

describe('SystemMessage', () => {
  it('creates a system message', () => {
    const msg = new SystemMessage('You are helpful');
    expect(msg.role).toBe('system');
    expect(msg.content).toBe('You are helpful');
  });

  it('serializes to JSON', () => {
    const msg = new SystemMessage('System prompt');
    expect(msg.toJSON()).toEqual({ role: 'system', content: 'System prompt' });
  });
});

describe('MessageLog', () => {
  it('starts empty', () => {
    const log = new MessageLog();
    expect(log.size()).toBe(0);
    expect(log.getMessages()).toEqual([]);
    expect(log.getMessagesAsJSON()).toEqual([]);
  });

  it('adds user messages', () => {
    const log = new MessageLog();
    log.addUserMessage('Hello');
    expect(log.size()).toBe(1);
    const msgs = log.getMessages();
    expect(msgs[0].role).toBe('user');
    expect(msgs[0].content).toBe('Hello');
  });

  it('adds assistant messages', () => {
    const log = new MessageLog();
    log.addAssistantMessage('Hi', 'Thinking about it');
    expect(log.size()).toBe(1);
    const msgs = log.getMessages();
    expect(msgs[0].role).toBe('assistant');
    expect(msgs[0].content).toBe('Hi');
    expect(msgs[0].reasoningContent).toBe('Thinking about it');
  });

  it('adds system messages separately', () => {
    const log = new MessageLog();
    log.addSystemMessage('You are helpful');
    log.addUserMessage('Hello');
    expect(log.size()).toBe(1);
    const msgs = log.getMessages();
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
  });

  it('includes system messages in getMessages', () => {
    const log = new MessageLog();
    log.addSystemMessage('S1');
    log.addSystemMessage('S2');
    log.addUserMessage('U1');
    const msgs = log.getMessages();
    expect(msgs).toHaveLength(3);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('system');
    expect(msgs[2].role).toBe('user');
  });

  it('serializes all messages to JSON', () => {
    const log = new MessageLog();
    log.addSystemMessage('System');
    log.addUserMessage('Hello');
    const json = log.getMessagesAsJSON();
    expect(json).toHaveLength(2);
    expect(json[0]).toEqual({ role: 'system', content: 'System' });
    expect(json[1]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('clears messages', () => {
    const log = new MessageLog();
    log.addUserMessage('Hello');
    log.addSystemMessage('System');
    log.clear();
    expect(log.size()).toBe(0);
    expect(log.getMessages()).toEqual([]);
  });

  it('returns a copy of messages', () => {
    const log = new MessageLog();
    log.addUserMessage('Hello');
    const msgs = log.getMessages();
    msgs.push({});
    expect(log.size()).toBe(1);
  });
});
