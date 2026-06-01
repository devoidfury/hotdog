import { describe, it, expect } from 'bun:test';
import {
  formatCompacting,
  formatToolCall,
  formatToolResult,
  formatTokenUsage,
  formatThinking,
  formatTaskProgress,
} from '../src/ui/cli.js';

describe('formatCompacting', () => {
  it('formats compacting message', () => {
    const result = formatCompacting(10, 5);
    expect(result).toBe('Compacting: removed 10 messages, keeping 5 recent');
  });

  it('handles singular', () => {
    const result = formatCompacting(1, 1);
    expect(result).toBe('Compacting: removed 1 messages, keeping 1 recent');
  });

  it('handles zero', () => {
    const result = formatCompacting(0, 5);
    expect(result).toBe('Compacting: removed 0 messages, keeping 5 recent');
  });
});

describe('formatToolCall', () => {
  it('formats with default formatter (  → {} {})', () => {
    const result = formatToolCall('bash', '{"cmd":"ls"}');
    expect(result).toBe('  → bash {"cmd":"ls"}');
  });

  it('formats with custom formatter', () => {
    const result = formatToolCall('bash', '{"cmd":"ls"}', '[{}] -> {}');
    expect(result).toBe('[bash] -> {"cmd":"ls"}');
  });

  it('handles empty input', () => {
    const result = formatToolCall('bash', '');
    expect(result).toBe('  → bash ');
  });

  it('handles multiline input', () => {
    const result = formatToolCall('bash', 'line1\nline2');
    expect(result).toBe('  → bash line1\nline2');
  });
});

describe('formatToolResult', () => {
  it('formats with default formatter (----\n{}\n----)', () => {
    const result = formatToolResult('output here');
    expect(result).toBe('----\noutput here\n----');
  });

  it('formats with custom formatter', () => {
    const result = formatToolResult('output here', 'Result: {}');
    expect(result).toBe('Result: output here');
  });

  it('handles empty result', () => {
    const result = formatToolResult('');
    expect(result).toBe('----\n\n----');
  });

  it('handles multiline result', () => {
    const result = formatToolResult('line1\nline2\nline3');
    expect(result).toBe('----\nline1\nline2\nline3\n----');
  });
});

describe('formatTokenUsage', () => {
  it('formats token usage', () => {
    const result = formatTokenUsage(100, 50, 200, 350);
    expect(result).toBe('(tokens cached:50 prompt:100 completion:200 total:350)');
  });

  it('handles zero tokens', () => {
    const result = formatTokenUsage(0, 0, 0, 0);
    expect(result).toBe('(tokens cached:0 prompt:0 completion:0 total:0)');
  });

  it('handles large numbers', () => {
    const result = formatTokenUsage(10000, 5000, 20000, 35000);
    expect(result).toBe('(tokens cached:5000 prompt:10000 completion:20000 total:35000)');
  });
});

describe('formatThinking', () => {
  it('formats with default formatter', () => {
    const result = formatThinking('Let me think about this');
    expect(result).toBe('[Thinking: Let me think about this]');
  });

  it('formats with custom formatter', () => {
    const result = formatThinking('Let me think', '🤔 {}');
    expect(result).toBe('🤔 Let me think');
  });

  it('handles empty content', () => {
    const result = formatThinking('');
    expect(result).toBe('[Thinking: ]');
  });

  it('handles multiline content', () => {
    const result = formatThinking('line1\nline2');
    expect(result).toBe('[Thinking: line1\nline2]');
  });
});

describe('formatTaskProgress', () => {
  it('returns empty for zero active tasks', () => {
    expect(formatTaskProgress(0, 0)).toBe('');
  });

  it('returns singular when one task', () => {
    expect(formatTaskProgress(1, 0)).toBe('1 task running');
  });

  it('returns plural when multiple tasks', () => {
    expect(formatTaskProgress(3, 0)).toBe('3 tasks running');
  });

  it('shows ratio when total provided', () => {
    expect(formatTaskProgress(2, 5)).toBe('2/5 tasks');
  });

  it('handles single task with total', () => {
    expect(formatTaskProgress(1, 3)).toBe('1/3 tasks');
  });

  it('handles all tasks complete', () => {
    expect(formatTaskProgress(0, 5)).toBe('');
  });
});
