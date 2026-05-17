import { describe, it, expect } from 'bun:test';
import {
  LOG_SOURCE,
  createSystemPromptEntry,
  createInputEntry,
  createAssistantEntry,
  createToolResultEntry,
  createResetEntry,
  createCompactionEntry,
  createPromptEntry,
  disabledSessionLog,
} from '../src/session_log.js';

describe('LOG_SOURCE', () => {
  it('has all expected sources', () => {
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
    const entry = createSystemPromptEntry('sess-1', 'You are helpful');
    expect(entry.session_id).toBe('sess-1');
    expect(entry.role).toBe('system');
    expect(entry.source).toBe(LOG_SOURCE.SYSTEM_PROMPT);
    expect(entry.content).toBe('You are helpful');
    expect(entry.ts).toBeDefined();
    expect(entry.reasoning_content).toBeNull();
    expect(entry.tool_calls).toBeNull();
  });
});

describe('createInputEntry', () => {
  it('creates an input entry', () => {
    const entry = createInputEntry('sess-1', 'Hello');
    expect(entry.session_id).toBe('sess-1');
    expect(entry.role).toBe('user');
    expect(entry.source).toBe(LOG_SOURCE.INPUT);
    expect(entry.content).toBe('Hello');
  });
});

describe('createAssistantEntry', () => {
  it('creates an assistant entry', () => {
    const entry = createAssistantEntry('sess-1', 'Hi there');
    expect(entry.session_id).toBe('sess-1');
    expect(entry.role).toBe('assistant');
    expect(entry.source).toBe(LOG_SOURCE.LLM);
    expect(entry.content).toBe('Hi there');
  });

  it('includes tool_calls when provided', () => {
    const toolCalls = [{ id: '1', function: { name: 'bash', arguments: '{}' } }];
    const entry = createAssistantEntry('sess-1', 'Hi', toolCalls);
    expect(entry.tool_calls).toBe(toolCalls);
  });

  it('includes reasoning_content when provided', () => {
    const entry = createAssistantEntry('sess-1', 'Hi', null, 'Thinking...');
    expect(entry.reasoning_content).toBe('Thinking...');
  });
});

describe('createToolResultEntry', () => {
  it('creates a tool result entry', () => {
    const entry = createToolResultEntry('sess-1', 'Output', 'call-1', 'bash');
    expect(entry.session_id).toBe('sess-1');
    expect(entry.role).toBe('tool');
    expect(entry.source).toBe(LOG_SOURCE.TOOL_RESULT);
    expect(entry.content).toBe('Output');
    expect(entry.tool_call_id).toBe('call-1');
    expect(entry.tool_name).toBe('bash');
  });

  it('creates entry without optional fields', () => {
    const entry = createToolResultEntry('sess-1', 'Output');
    expect(entry.tool_call_id).toBeNull();
    expect(entry.tool_name).toBeNull();
  });
});

describe('createResetEntry', () => {
  it('creates a reset entry', () => {
    const entry = createResetEntry('sess-1');
    expect(entry.session_id).toBe('sess-1');
    expect(entry.role).toBe('user');
    expect(entry.source).toBe(LOG_SOURCE.RESET);
    expect(entry.content).toBe('');
  });
});

describe('createCompactionEntry', () => {
  it('creates a compaction entry', () => {
    const entry = createCompactionEntry('sess-1', 10, 'Summarized 10 messages');
    expect(entry.session_id).toBe('sess-1');
    expect(entry.role).toBe('system');
    expect(entry.source).toBe(LOG_SOURCE.COMPACTION);
    expect(entry.content).toContain('[Compacted 10 messages]');
    expect(entry.content).toContain('Summarized 10 messages');
  });
});

describe('createPromptEntry', () => {
  it('creates a prompt entry', () => {
    const entry = createPromptEntry('sess-1', 'Expanded prompt');
    expect(entry.session_id).toBe('sess-1');
    expect(entry.role).toBe('user');
    expect(entry.source).toBe(LOG_SOURCE.PROMPT);
    expect(entry.content).toBe('Expanded prompt');
  });
});

describe('disabledSessionLog', () => {
  it('creates a no-op session log', () => {
    const log = disabledSessionLog();
    expect(log.append).toBeDefined();
    expect(log.writeSystemPrompt).toBeDefined();
    expect(log.writeInput).toBeDefined();
    expect(log.writeAssistant).toBeDefined();
    expect(log.writeToolResult).toBeDefined();
    expect(log.writeReset).toBeDefined();
    expect(log.writeCompaction).toBeDefined();
    expect(log.writePrompt).toBeDefined();
  });

  it('all methods are no-ops', () => {
    const log = disabledSessionLog();
    expect(() => {
      log.append({});
      log.writeSystemPrompt('test');
      log.writeInput('test');
      log.writeAssistant('test');
      log.writeToolResult('test');
      log.writeReset();
      log.writeCompaction(1, 'summary');
      log.writePrompt('test');
    }).not.toThrow();
  });
});
