import { describe, it, expect } from 'bun:test';
import {
  stripNulls,
  LOG_SOURCE,
  createSystemPromptEntry,
  createInputEntry,
  createAssistantEntry,
  createToolResultEntry,
  createResetEntry,
  createCompactionEntry,
  createPromptEntry,
  disabledSessionLog,
  sessionExists,
} from '../src/session_log.js';

describe('stripNulls', () => {
  it('removes null fields', () => {
    const input = { a: 1, b: null, c: 'hello' };
    expect(stripNulls(input)).toEqual({ a: 1, c: 'hello' });
  });

  it('preserves zero values', () => {
    const input = { a: 0, b: false, c: '' };
    expect(stripNulls(input)).toEqual({ a: 0, b: false, c: '' });
  });

  it('preserves empty arrays', () => {
    const input = { a: [], b: null };
    expect(stripNulls(input)).toEqual({ a: [] });
  });

  it('preserves empty objects', () => {
    const input = { a: {}, b: null };
    expect(stripNulls(input)).toEqual({ a: {} });
  });

  it('handles empty object', () => {
    expect(stripNulls({})).toEqual({});
  });

  it('handles object with only null fields', () => {
    const input = { a: null, b: null };
    expect(stripNulls(input)).toEqual({});
  });

  it('handles nested objects (only strips top level)', () => {
    const input = { a: { b: null, c: 1 }, b: null };
    expect(stripNulls(input)).toEqual({ a: { b: null, c: 1 } });
  });
});

describe('LOG_SOURCE constants', () => {
  it('has all expected source types', () => {
    expect(LOG_SOURCE.SYSTEM_PROMPT).toBe('system_prompt');
    expect(LOG_SOURCE.INPUT).toBe('input');
    expect(LOG_SOURCE.LLM).toBe('llm');
    expect(LOG_SOURCE.TOOL_RESULT).toBe('tool_result');
    expect(LOG_SOURCE.RESET).toBe('reset');
    expect(LOG_SOURCE.COMPACTION).toBe('compaction');
    expect(LOG_SOURCE.PROMPT).toBe('prompt');
  });
});

describe('createSystemPromptEntry', () => {
  it('creates a system prompt entry', () => {
    const entry = createSystemPromptEntry('session-1', 'You are helpful.');
    expect(entry.session_id).toBe('session-1');
    expect(entry.role).toBe('system');
    expect(entry.source).toBe(LOG_SOURCE.SYSTEM_PROMPT);
    expect(entry.content).toBe('You are helpful.');
    expect(entry.reasoning_content).toBeNull();
    expect(entry.tool_calls).toBeNull();
    expect(entry.tool_call_id).toBeNull();
    expect(entry.tool_name).toBeNull();
    expect(entry.ts).toBeDefined();
  });

  it('has valid ISO timestamp', () => {
    const entry = createSystemPromptEntry('s1', 'content');
    expect(() => new Date(entry.ts)).not.toThrow();
  });
});

describe('createInputEntry', () => {
  it('creates a user input entry', () => {
    const entry = createInputEntry('session-1', 'Hello world');
    expect(entry.session_id).toBe('session-1');
    expect(entry.role).toBe('user');
    expect(entry.source).toBe(LOG_SOURCE.INPUT);
    expect(entry.content).toBe('Hello world');
    expect(entry.reasoning_content).toBeNull();
    expect(entry.tool_calls).toBeNull();
    expect(entry.tool_call_id).toBeNull();
    expect(entry.tool_name).toBeNull();
  });

  it('handles empty content', () => {
    const entry = createInputEntry('s1', '');
    expect(entry.content).toBe('');
  });
});

describe('createAssistantEntry', () => {
  it('creates an assistant entry without tool calls', () => {
    const entry = createAssistantEntry('session-1', 'I can help you.');
    expect(entry.session_id).toBe('session-1');
    expect(entry.role).toBe('assistant');
    expect(entry.source).toBe(LOG_SOURCE.LLM);
    expect(entry.content).toBe('I can help you.');
    expect(entry.reasoning_content).toBeNull();
    expect(entry.tool_calls).toBeNull();
  });

  it('creates an assistant entry with tool calls', () => {
    const toolCalls = [
      { id: 'tc1', function: { name: 'bash', arguments: '{}' } },
    ];
    const entry = createAssistantEntry('s1', 'Let me check.', toolCalls);
    expect(entry.tool_calls).toEqual(toolCalls);
  });

  it('creates an assistant entry with reasoning content', () => {
    const entry = createAssistantEntry('s1', 'Output', null, 'Thinking...');
    expect(entry.reasoning_content).toBe('Thinking...');
  });

  it('creates an assistant entry with both tool calls and reasoning', () => {
    const toolCalls = [{ id: 'tc1', function: { name: 'read', arguments: '{}' } }];
    const entry = createAssistantEntry('s1', 'Done', toolCalls, 'I read the file.');
    expect(entry.tool_calls).toEqual(toolCalls);
    expect(entry.reasoning_content).toBe('I read the file.');
  });
});

describe('createToolResultEntry', () => {
  it('creates a tool result entry', () => {
    const entry = createToolResultEntry('session-1', 'Result', 'tc1', 'bash');
    expect(entry.session_id).toBe('session-1');
    expect(entry.role).toBe('tool');
    expect(entry.source).toBe(LOG_SOURCE.TOOL_RESULT);
    expect(entry.content).toBe('Result');
    expect(entry.tool_call_id).toBe('tc1');
    expect(entry.tool_name).toBe('bash');
    expect(entry.reasoning_content).toBeNull();
    expect(entry.tool_calls).toBeNull();
  });

  it('handles null tool call id', () => {
    const entry = createToolResultEntry('s1', 'result', null, null);
    expect(entry.tool_call_id).toBeNull();
    expect(entry.tool_name).toBeNull();
  });
});

describe('createResetEntry', () => {
  it('creates a reset entry', () => {
    const entry = createResetEntry('session-1');
    expect(entry.session_id).toBe('session-1');
    expect(entry.role).toBe('user');
    expect(entry.source).toBe(LOG_SOURCE.RESET);
    expect(entry.content).toBe('');
    expect(entry.reasoning_content).toBeNull();
    expect(entry.tool_calls).toBeNull();
  });
});

describe('createCompactionEntry', () => {
  it('creates a compaction entry with summary', () => {
    const entry = createCompactionEntry('session-1', 5, 'Summary here');
    expect(entry.session_id).toBe('session-1');
    expect(entry.role).toBe('system');
    expect(entry.source).toBe(LOG_SOURCE.COMPACTION);
    expect(entry.content).toBe('[Compacted 5 messages]\n\nSummary here');
    expect(entry.reasoning_content).toBeNull();
    expect(entry.tool_calls).toBeNull();
  });

  it('handles zero messages compacted', () => {
    const entry = createCompactionEntry('s1', 0, 'No messages');
    expect(entry.content).toBe('[Compacted 0 messages]\n\nNo messages');
  });

  it('handles empty summary', () => {
    const entry = createCompactionEntry('s1', 10, '');
    expect(entry.content).toBe('[Compacted 10 messages]\n\n');
  });
});

describe('createPromptEntry', () => {
  it('creates a prompt expansion entry', () => {
    const entry = createPromptEntry('session-1', 'Prompt content');
    expect(entry.session_id).toBe('session-1');
    expect(entry.role).toBe('user');
    expect(entry.source).toBe(LOG_SOURCE.PROMPT);
    expect(entry.content).toBe('Prompt content');
    expect(entry.reasoning_content).toBeNull();
    expect(entry.tool_calls).toBeNull();
  });
});

describe('disabledSessionLog', () => {
  it('returns a no-op object', () => {
    const log = disabledSessionLog();
    // All methods should be no-ops (not throw)
    expect(() => log.append({})).not.toThrow();
    expect(() => log.writeSystemPrompt('content')).not.toThrow();
    expect(() => log.writeInput('input')).not.toThrow();
    expect(() => log.writeAssistant('content')).not.toThrow();
    expect(() => log.writeToolResult('result', 'id', 'name')).not.toThrow();
    expect(() => log.writeReset()).not.toThrow();
    expect(() => log.writeCompaction(5, 'summary')).not.toThrow();
    expect(() => log.writePrompt('prompt')).not.toThrow();
  });

  it('has all expected methods', () => {
    const log = disabledSessionLog();
    expect(typeof log.append).toBe('function');
    expect(typeof log.writeSystemPrompt).toBe('function');
    expect(typeof log.writeInput).toBe('function');
    expect(typeof log.writeAssistant).toBe('function');
    expect(typeof log.writeToolResult).toBe('function');
    expect(typeof log.writeReset).toBe('function');
    expect(typeof log.writeCompaction).toBe('function');
    expect(typeof log.writePrompt).toBe('function');
  });
});

describe('sessionExists', () => {
  it('returns false for non-existent session', () => {
    // Use a random UUID that almost certainly doesn't exist
    const randomId = '00000000-0000-0000-0000-000000000000';
    expect(sessionExists(randomId)).toBe(false);
  });
});
