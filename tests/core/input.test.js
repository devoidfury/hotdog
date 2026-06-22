import { describe, it, expect } from 'bun:test';
import { parseInput, INPUT_EVENT, NoopInput } from '../../src/core/context/input.js';

describe('parseInput', () => {
  it('parses plain text', () => {
    expect(parseInput('hello world')).toEqual({ type: INPUT_EVENT.TEXT, value: 'hello world' });
  });

  it('trims input', () => {
    expect(parseInput('  hello  ')).toEqual({ type: INPUT_EVENT.TEXT, value: 'hello' });
  });

  it('parses command with slash', () => {
    expect(parseInput('/exit')).toEqual({ type: INPUT_EVENT.COMMAND, value: 'exit' });
    expect(parseInput('/model gpt-4')).toEqual({ type: INPUT_EVENT.COMMAND, value: 'model gpt-4' });
  });

  it('treats bare slash as text', () => {
    expect(parseInput('/')).toEqual({ type: INPUT_EVENT.TEXT, value: '/' });
  });

  it('handles empty input', () => {
    expect(parseInput('')).toEqual({ type: INPUT_EVENT.TEXT, value: '' });
  });
});

describe('NoopInput', () => {
  it('is not interactive', () => {
    const input = new NoopInput();
    expect(input.isInteractive()).toBe(false);
  });

  it('returns defaults for collectAnswers', () => {
    const input = new NoopInput();
    const answers = input.collectAnswers([
      { key: 'name', default: 'John' },
      { key: 'age', default: 25 },
    ]);
    expect(answers).toEqual({ name: 'John', age: 25 });
  });

  it('uses empty string when no default', () => {
    const input = new NoopInput();
    const answers = input.collectAnswers([{ key: 'opt' }]);
    expect(answers.opt).toBe('');
  });
});
