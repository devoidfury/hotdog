import { describe, it, expect } from 'bun:test';
import {
  estimateMessageTokens,
  estimateContextTokens,
  shouldCompact,
  findFirstKeptIndex,
} from '../src/compaction.js';

describe('estimateMessageTokens', () => {
  it('estimates tokens for user message', () => {
    const msg = { role: 'user', content: 'Hello world'.repeat(4) };
    const tokens = estimateMessageTokens(msg);
    expect(tokens).toBe(Math.ceil(msg.content.length / 4));
  });

  it('estimates tokens for system message', () => {
    const msg = { role: 'system', content: 'You are a helper' };
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(msg.content.length / 4));
  });

  it('estimates tokens for assistant with content only', () => {
    const msg = { role: 'assistant', content: 'Response text' };
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(msg.content.length / 4));
  });

  it('includes reasoning content in estimation', () => {
    const msg = { role: 'assistant', content: 'Hi', reasoning_content: 'Thinking about it' };
    const totalChars = msg.content.length + msg.reasoning_content.length;
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(totalChars / 4));
  });

  it('includes tool call info in estimation', () => {
    const msg = {
      role: 'assistant',
      content: '',
      tool_calls: [{ function: { name: 'bash', arguments: '{"cmd":"ls"}' } }],
    };
    const nameLen = (msg.tool_calls[0].function?.name || '').length;
    const argsLen = (msg.tool_calls[0].function?.arguments || '').length;
    const expected = Math.ceil((msg.content.length + nameLen + argsLen) / 4);
    expect(estimateMessageTokens(msg)).toBe(expected);
  });

  it('estimates tokens for tool message', () => {
    const msg = { role: 'tool', content: 'Output here' };
    expect(estimateMessageTokens(msg)).toBe(Math.ceil(msg.content.length / 4));
  });

  it('handles empty content', () => {
    expect(estimateMessageTokens({ role: 'user', content: '' })).toBe(0);
  });
});

describe('estimateContextTokens', () => {
  it('sums tokens for all messages', () => {
    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const total = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    expect(estimateContextTokens(messages)).toBe(total);
  });

  it('returns 0 for empty array', () => {
    expect(estimateContextTokens([])).toBe(0);
  });

  it('handles mixed message types', () => {
    const messages = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Question' },
      { role: 'assistant', content: 'Answer', reasoning_content: 'Thoughts' },
      { role: 'tool', content: 'Result' },
    ];
    const expected = messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    expect(estimateContextTokens(messages)).toBe(expected);
  });
});

describe('shouldCompact', () => {
  it('returns true when over limit', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(1000) }];
    expect(shouldCompact(messages, 100, 50)).toBe(true);
  });

  it('returns false when under limit', () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    expect(shouldCompact(messages, 100, 50)).toBe(false);
  });

  it('accounts for reserve tokens', () => {
    const messages = [{ role: 'user', content: 'x'.repeat(60) }];
    expect(shouldCompact(messages, 100, 50)).toBe(false);
  });

  it('returns true at exact boundary', () => {
    const msgChars = (100 - 10 + 1) * 4;
    const messages = [{ role: 'user', content: 'x'.repeat(msgChars) }];
    expect(shouldCompact(messages, 100, 10)).toBe(true);
  });
});

describe('findFirstKeptIndex', () => {
  it('returns 0 when keepRecent is 0', () => {
    const messages = [{ role: 'user', content: 'Hi' }];
    expect(findFirstKeptIndex(messages, 0)).toBe(0);
  });

  it('keeps recent messages', () => {
    const messages = [
      { role: 'system', content: 'System' },
      { role: 'user', content: '1' },
      { role: 'assistant', content: '2' },
      { role: 'user', content: '3' },
      { role: 'assistant', content: '4' },
    ];
    // keepRecent=1, target=2 non-system from end
    // From end: assistant4(1), user3(2) → return 3+1 = 4
    expect(findFirstKeptIndex(messages, 1)).toBe(4);
  });

  it('skips system messages when counting', () => {
    const messages = [
      { role: 'system', content: 'S1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'U1' },
      { role: 'assistant', content: 'A1' },
    ];
    // From end: A1(1), U1(2) → return 2+1 = 3
    expect(findFirstKeptIndex(messages, 1)).toBe(3);
  });

  it('returns 0 when not enough messages', () => {
    const messages = [{ role: 'user', content: '1' }];
    // keepRecent=2, target=4, only 1 non-system message
    expect(findFirstKeptIndex(messages, 2)).toBe(0);
  });

  it('returns correct index for large keepRecent', () => {
    const messages = [
      { role: 'system', content: 'S' },
      ...Array.from({ length: 10 }, (_, i) => ({ role: 'user', content: `${i}` })),
    ];
    // keepRecent=3, target=6, count from end: u9(1)..u4(6) → return 5+1 = 6
    expect(findFirstKeptIndex(messages, 3)).toBe(6);
  });
});
