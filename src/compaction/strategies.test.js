// Tests for compaction strategies.

import { describe, it, expect, vi, beforeEach } from 'bun:test';
import {
  CompactionStrategy,
  CompactionStrategyRegistry,
} from './strategies.js';
import { SummarizeStrategy } from './strategies/summarize.js';
import { DropStrategy } from './strategies/drop.js';
import { SummarizeShortStrategy } from './strategies/summarize-short.js';
import { TokenAwareStrategy } from './strategies/token-aware.js';
import {
  estimateContextTokens,
  estimateMessageTokens,
  findFirstKeptIndex,
} from '../compaction.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeMessages(count) {
  const messages = [];
  for (let i = 0; i < count; i++) {
    const isUser = i % 2 === 0;
    messages.push({
      role: isUser ? 'user' : 'assistant',
      content: `Message ${i}: ${'x'.repeat(100)}`,
    });
  }
  return messages;
}

function mockLlmChat(summary) {
  return async (msgs, model) => {
    // Verify the LLM received the expected messages
    expect(msgs.length).toBe(2);
    expect(msgs[0].role).toBe('system');
    expect(msgs[1].role).toBe('user');
    return summary || 'Summarized context: ...';
  };
}

// ── CompactionStrategy (Base Class) ──────────────────────────────────────────

describe('CompactionStrategy base class', () => {
  it('throws on execute() when not overridden', async () => {
    const strategy = new CompactionStrategy();
    strategy.name = 'test';
    strategy.description = 'Test';
    let errorThrown = false;
    try {
      await strategy.execute([], {}, () => {}, 'test');
    } catch (e) {
      errorThrown = true;
      expect(e.message).toBe('execute() not implemented');
    }
    expect(errorThrown).toBe(true);
  });

  it('canCompact returns true when enough messages', () => {
    const strategy = new CompactionStrategy();
    strategy.name = 'test';
    const messages = makeMessages(10);
    expect(strategy.canCompact(messages, { keepRecent: 2 })).toBe(true);
  });

  it('canCompact returns false when not enough messages', () => {
    const strategy = new CompactionStrategy();
    strategy.name = 'test';
    const messages = makeMessages(2);
    expect(strategy.canCompact(messages, { keepRecent: 3 })).toBe(false);
  });
});

// ── CompactionStrategyRegistry ───────────────────────────────────────────────

describe('CompactionStrategyRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new CompactionStrategyRegistry();
  });

  it('registers and retrieves strategies', () => {
    const strategy = new SummarizeStrategy();
    registry.register(strategy);
    expect(registry.get('summarize')).toBe(strategy);
  });

  it('has() returns correct values', () => {
    registry.register(new SummarizeStrategy());
    expect(registry.has('summarize')).toBe(true);
    expect(registry.has('nonexistent')).toBe(false);
  });

  it('getAll() returns all registered strategies', () => {
    registry.register(new SummarizeStrategy());
    registry.register(new DropStrategy());
    const all = registry.getAll();
    expect(all.length).toBe(2);
    expect(all.map(s => s.name)).toEqual(['summarize', 'drop']);
  });

  it('getDefault() returns the summarize strategy', () => {
    registry.register(new SummarizeStrategy());
    registry.register(new DropStrategy());
    expect(registry.getDefault().name).toBe('summarize');
  });

  it('overwrites existing strategy with same name', () => {
    const s1 = new SummarizeStrategy();
    const s2 = new SummarizeStrategy();
    s2.description = 'Modified';
    registry.register(s1);
    registry.register(s2);
    expect(registry.get('summarize').description).toBe('Modified');
  });
});

// ── SummarizeStrategy ────────────────────────────────────────────────────────

describe('SummarizeStrategy', () => {
  it('produces a summary and compacts correct messages', async () => {
    const strategy = new SummarizeStrategy();
    const messages = makeMessages(10); // 5 user + 5 assistant pairs
    const llmChat = mockLlmChat('Summarized context');
    const settings = { enabled: true, keepRecent: 2, reserveTokens: 16384 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).not.toBeNull();
    expect(result.summary).toBe('Summarized context');
    // With 10 messages and keepRecent=2, findFirstKeptIndex returns 7
    // (keeps last 3 messages at indices 7,8,9; compacts first 7)
    expect(result.messagesCompacted).toBe(7);
    expect(result.metadata.strategyName).toBe('summarize');
    expect(result.metadata.tokensBefore).toBeGreaterThan(0);
    expect(result.metadata.tokensAfter).toBeGreaterThan(0);
  });

  it('returns null when firstKept is 0', async () => {
    const strategy = new SummarizeStrategy();
    const messages = makeMessages(2); // Only 1 pair
    const llmChat = vi.fn();
    const settings = { enabled: true, keepRecent: 3, reserveTokens: 16384 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).toBeNull();
    expect(llmChat).not.toHaveBeenCalled();
  });

  it('throws on LLM failure', async () => {
    const strategy = new SummarizeStrategy();
    const messages = makeMessages(10);
    const llmChat = async () => { throw new Error('API error'); };
    const settings = { enabled: true, keepRecent: 2, reserveTokens: 16384 };

    let errorThrown = false;
    try {
      await strategy.execute(messages, settings, llmChat, 'test-model');
    } catch (e) {
      errorThrown = true;
      expect(e.message).toBe('Summarization failed: API error');
    }
    expect(errorThrown).toBe(true);
  });

  it('skips system messages in counting', async () => {
    const strategy = new SummarizeStrategy();
    const messages = [
      { role: 'system', content: 'You are a helpful assistant.' },
      ...makeMessages(8),
    ];
    const llmChat = mockLlmChat('Summary');
    const settings = { enabled: true, keepRecent: 2, reserveTokens: 16384 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).not.toBeNull();
    // With 9 non-system messages and keepRecent=2, compacts 6
    expect(result.messagesCompacted).toBe(6);
  });
});

// ── DropStrategy ─────────────────────────────────────────────────────────────

describe('DropStrategy', () => {
  it('returns null summary and compacts correct messages', async () => {
    const strategy = new DropStrategy();
    const messages = makeMessages(10);
    const llmChat = vi.fn();
    const settings = { enabled: true, keepRecent: 2, reserveTokens: 16384 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).not.toBeNull();
    expect(result.summary).toBeNull();
    // With 10 messages and keepRecent=2, compacts 7
    expect(result.messagesCompacted).toBe(7);
    expect(result.metadata.strategyName).toBe('drop');
    expect(llmChat).not.toHaveBeenCalled(); // No LLM call!
  });

  it('returns null when firstKept is 0', async () => {
    const strategy = new DropStrategy();
    const messages = makeMessages(2);
    const llmChat = vi.fn();
    const settings = { enabled: true, keepRecent: 3, reserveTokens: 16384 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).toBeNull();
  });

  it('canCompact requires minimum message count', () => {
    const strategy = new DropStrategy();
    const messages = makeMessages(2); // Only 1 pair
    expect(strategy.canCompact(messages, { keepRecent: 3 })).toBe(false);
  });

  it('canCompact returns true with enough messages', () => {
    const strategy = new DropStrategy();
    const messages = makeMessages(10);
    expect(strategy.canCompact(messages, { keepRecent: 2 })).toBe(true);
  });
});

// ── SummarizeShortStrategy ───────────────────────────────────────────────────

describe('SummarizeShortStrategy', () => {
  it('produces a summary with shorter prompt', async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = makeMessages(10);
    let receivedPrompt = '';
    const llmChat = async (msgs, model) => {
      receivedPrompt = msgs[1].content;
      return 'Concise summary';
    };
    const settings = { enabled: true, keepRecent: 2, reserveTokens: 16384 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).not.toBeNull();
    expect(result.summary).toBe('Concise summary');
    // With 10 messages and keepRecent=2, compacts 7
    expect(result.messagesCompacted).toBe(7);
    expect(receivedPrompt).toContain('CONCISE');
    expect(receivedPrompt).not.toContain('## Blocked'); // Short version doesn't have this
  });

  it('returns null when firstKept is 0', async () => {
    const strategy = new SummarizeShortStrategy();
    const messages = makeMessages(2);
    const llmChat = vi.fn();
    const settings = { enabled: true, keepRecent: 3, reserveTokens: 16384 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).toBeNull();
  });
});

// ── TokenAwareStrategy ───────────────────────────────────────────────────────

describe('TokenAwareStrategy', () => {
  it('compacts based on token budget', async () => {
    const strategy = new TokenAwareStrategy();
    // Create messages with known token counts (~25 tokens each)
    const messages = makeMessages(200); // ~5000 tokens total
    const llmChat = mockLlmChat('Token-aware summary');
    // Use a very small context budget to force compaction
    // contextLimit=128000, targetTokens=100000, maxKeepTokens=28000
    // But we want to test compaction, so use a very small maxKeepTokens
    const settings = { enabled: true, keepRecent: 100, reserveTokens: 16384, targetTokens: 127900 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).not.toBeNull();
    expect(result.summary).toBe('Token-aware summary');
    expect(result.messagesCompacted).toBeGreaterThan(0);
    expect(result.metadata.strategyName).toBe('token-aware');
    expect(result.metadata.targetTokens).toBe(127900);
  });

  it('canCompact only returns true when over token limit', () => {
    const strategy = new TokenAwareStrategy();
    const messages = makeMessages(4); // Small number of messages
    const settings = { enabled: true, reserveTokens: 16384 };

    // With a small context, we should be under the limit
    const nonSystem = messages.filter(m => m.role !== 'system');
    const tokens = estimateContextTokens(nonSystem);
    const maxKeepTokens = 128000 - 16384;
    expect(tokens).toBeLessThan(maxKeepTokens);
    expect(strategy.canCompact(messages, settings)).toBe(false);
  });

  it('returns null when nothing to compact', async () => {
    const strategy = new TokenAwareStrategy();
    const messages = makeMessages(2); // Very few messages
    const llmChat = vi.fn();
    const settings = { enabled: true, reserveTokens: 16384 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).toBeNull();
    expect(llmChat).not.toHaveBeenCalled();
  });

  it('skips system messages when calculating token budget', async () => {
    const strategy = new TokenAwareStrategy();
    const messages = [
      { role: 'system', content: 'You are a helpful assistant. '.repeat(100) },
      ...makeMessages(10),
    ];
    const llmChat = mockLlmChat('Summary');
    const settings = { enabled: true, keepRecent: 3, reserveTokens: 16384, targetTokens: 100000 };

    const result = await strategy.execute(messages, settings, llmChat, 'test-model');

    expect(result).not.toBeNull();
  });
});

// ── Integration: Registry with all built-in strategies ───────────────────────

describe('Built-in strategies registration', () => {
  it('all strategies can be registered together', () => {
    const registry = new CompactionStrategyRegistry();
    registry.register(new SummarizeStrategy());
    registry.register(new DropStrategy());
    registry.register(new SummarizeShortStrategy());
    registry.register(new TokenAwareStrategy());

    expect(registry.getAll().length).toBe(4);
    expect(registry.has('summarize')).toBe(true);
    expect(registry.has('drop')).toBe(true);
    expect(registry.has('summarize-short')).toBe(true);
    expect(registry.has('token-aware')).toBe(true);
    expect(registry.getDefault().name).toBe('summarize');
  });

  it('strategies have distinct names', () => {
    const names = new Set([
      new SummarizeStrategy().name,
      new DropStrategy().name,
      new SummarizeShortStrategy().name,
      new TokenAwareStrategy().name,
    ]);
    expect(names.size).toBe(4);
  });
});
