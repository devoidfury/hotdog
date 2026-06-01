import { describe, it, expect } from 'bun:test';
import {
  estimateMessageTokens,
  estimateContextTokens,
  shouldCompact,
  findFirstKeptIndex,
  compactMessages,
} from '../../extensions/compaction/index.js';

describe('estimateMessageTokens', () => {
  it('estimates tokens for user message', () => {
    const msg = { role: 'user', content: 'Hello world' };
    expect(estimateMessageTokens(msg)).toBe(Math.ceil('Hello world'.length / 4));
  });

  it('estimates tokens for assistant with reasoning', () => {
    const msg = { role: 'assistant', content: 'Hi', reasoning_content: 'Thinking about it' };
    const totalChars = 'Hi'.length + 'Thinking about it'.length;
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(totalChars / 4));
  });

  it('estimates tokens for assistant with tool calls', () => {
    const msg = {
      role: 'assistant',
      content: 'Done',
      tool_calls: [
        { function: { name: 'bash', arguments: '{"cmd": "ls"}' } },
      ],
    };
    const chars = 'Done'.length + 'bash'.length + '{"cmd": "ls"}'.length;
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(chars / 4));
  });

  it('estimates tokens for tool message', () => {
    const msg = { role: 'tool', content: 'Output here' };
    expect(estimateMessageTokens(msg)).toBe(Math.ceil('Output here'.length / 4));
  });

  it('estimates tokens for system message', () => {
    const msg = { role: 'system', content: 'You are helpful' };
    expect(estimateMessageTokens(msg)).toBe(Math.ceil('You are helpful'.length / 4));
  });
});

describe('estimateContextTokens', () => {
  it('sums tokens for all messages', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const total = messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
    expect(estimateContextTokens(messages)).toBe(total);
  });

  it('returns 0 for empty array', () => {
    expect(estimateContextTokens([])).toBe(0);
  });
});

describe('shouldCompact', () => {
  it('returns true when over limit', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(200) },
      { role: 'assistant', content: 'y'.repeat(200) },
    ];
    expect(shouldCompact(messages, 100, 50)).toBe(true);
  });

  it('returns false when under limit', () => {
    const messages = [
      { role: 'user', content: 'Hi' },
    ];
    expect(shouldCompact(messages, 1000, 100)).toBe(false);
  });

  it('accounts for reserve tokens', () => {
    const messages = [
      { role: 'user', content: 'x'.repeat(200) },
      { role: 'assistant', content: 'y'.repeat(200) },
    ];
    // Estimated ~100 tokens, limit 100, reserve 50 => 50 available => should compact
    expect(shouldCompact(messages, 100, 50)).toBe(true);
  });
});

describe('findFirstKeptIndex', () => {
  it('returns 0 when keepRecent is 0', () => {
    const messages = [{ role: 'user', content: 'test' }];
    expect(findFirstKeptIndex(messages, 0)).toBe(0);
  });

  it('returns 0 when not enough messages', () => {
    const messages = [
      { role: 'user', content: 'test' },
    ];
    // Need 2 messages for keepRecent=1, only have 1
    expect(findFirstKeptIndex(messages, 1)).toBe(0);
  });

  it('skips system messages', () => {
    const messages = [
      { role: 'system', content: 'prompt' },
      { role: 'user', content: 'test1' },
      { role: 'assistant', content: 'test2' },
      { role: 'user', content: 'test3' },
      { role: 'assistant', content: 'test4' },
    ];
    // 4 non-system messages, keepRecent=1 => need 2 from end => keep index 4 onward => return 4
    expect(findFirstKeptIndex(messages, 1)).toBe(4);
  });

  it('returns correct index for keepRecent=2', () => {
    const messages = [
      { role: 'user', content: '1' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' },
      { role: 'assistant', content: '4' },
      { role: 'user', content: '5' },
      { role: 'assistant', content: '6' },
    ];
    // Need 4 messages for keepRecent=2, have 6 => keep indices 3,4,5 => return 3
    expect(findFirstKeptIndex(messages, 2)).toBe(3);
  });

  it('returns 0 when all messages are system', () => {
    const messages = [
      { role: 'system', content: 'a' },
      { role: 'system', content: 'b' },
    ];
    expect(findFirstKeptIndex(messages, 1)).toBe(0);
  });
});

describe('compactMessages', () => {
  it('returns null when compaction is disabled', async () => {
    const messages = [
      { role: 'user', content: 'test' },
    ];
    const result = await compactMessages(messages, async () => 'summary', 'model', { enabled: false });
    expect(result).toBeNull();
  });

  it('returns null when not enough messages to compact', async () => {
    const messages = [
      { role: 'user', content: 'test' },
    ];
    const llmChat = async () => { throw new Error('Should not be called'); };
    const result = await compactMessages(messages, llmChat, 'model', { enabled: true, keepRecent: 1 });
    expect(result).toBeNull();
  });

  it('calls LLM with summary prompt and serializes conversation', async () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
      { role: 'user', content: 'How are you?' },
    ];

    let capturedMessages = null;
    const llmChat = async (msgs, model) => {
      capturedMessages = msgs;
      return 'Summarized conversation';
    };

    const result = await compactMessages(messages, llmChat, 'test-model', { enabled: true, keepRecent: 1 });

    expect(result).toEqual({ summary: 'Summarized conversation', messagesCompacted: 2 });
    expect(capturedMessages).toHaveLength(2);
    expect(capturedMessages[0].role).toBe('system');
    expect(capturedMessages[1].role).toBe('user');
    expect(capturedMessages[1].content).toContain('[User]: Hello');
    expect(capturedMessages[1].content).toContain('[Assistant]: Hi there');
  });

  it('includes tool calls in serialized conversation', async () => {
    const messages = [
      { role: 'assistant', content: 'I will run a command', tool_calls: [{ function: { name: 'bash', arguments: '{"cmd": "ls"}' } }] },
      { role: 'user', content: 'Next message' },
    ];

    let capturedContent = '';
    const llmChat = async (msgs) => {
      capturedContent = msgs[1].content;
      return 'Summary';
    };

    await compactMessages(messages, llmChat, 'model', { enabled: true, keepRecent: 1 });

    expect(capturedContent).toContain('[Assistant tool calls]');
    expect(capturedContent).toContain('bash');
  });

  it('truncates long tool results', async () => {
    const longContent = 'x'.repeat(3000);
    const messages = [
      { role: 'tool', content: longContent },
      { role: 'user', content: 'Next message' },
    ];

    let capturedContent = '';
    const llmChat = async (msgs) => {
      capturedContent = msgs[1].content;
      return 'Summary';
    };

    await compactMessages(messages, llmChat, 'model', { enabled: true, keepRecent: 1 });

    expect(capturedContent).toContain('more characters truncated');
    expect(capturedContent.length).toBeLessThan(longContent.length);
  });

  it('throws on LLM chat failure', async () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
      { role: 'user', content: 'How?' },
    ];

    const llmChat = async () => { throw new Error('API error'); };

    await expect(compactMessages(messages, llmChat, 'model', { enabled: true, keepRecent: 1 }))
      .rejects.toThrow('Summarization failed: API error');
  });

  it('skips system messages in serialization', async () => {
    const messages = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];

    let capturedContent = '';
    const llmChat = async (msgs) => {
      capturedContent = msgs[1].content;
      return 'Summary';
    };

    await compactMessages(messages, llmChat, 'model', { enabled: true, keepRecent: 1 });

    expect(capturedContent).not.toContain('[System]');
    expect(capturedContent).toContain('[User]: Hello');
  });
});
