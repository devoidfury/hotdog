import { describe, it, expect } from 'bun:test';
import { parseCommand, Command } from '../../src/core/commands.js';
import { createCommandRegistry } from '../../src/core/extensions/registries.js';

describe('parseCommand', () => {
  it('parses help, quit, exit, clear commands', () => {
    expect(parseCommand('help')).toEqual({ type: Command.Help, value: null });
    expect(parseCommand('quit')).toEqual({ type: Command.Quit, value: null });
    expect(parseCommand('exit')).toEqual({ type: Command.Quit, value: null });
    expect(parseCommand('clear')).toEqual({ type: Command.Clear, value: null });
  });

  it('parses clear with profile name', () => {
    expect(parseCommand('clear explorer')).toEqual({ type: Command.Clear, value: 'explorer' });
    expect(parseCommand('clear ')).toEqual({ type: Command.Clear, value: null });
    expect(parseCommand('clear  coding  ')).toEqual({ type: Command.Clear, value: 'coding' });
  });

  it('parses toggle commands', () => {
    expect(parseCommand('tools')).toEqual({ type: Command.Tools, value: null });
    expect(parseCommand('thinking')).toEqual({ type: Command.Thinking, value: null });
    expect(parseCommand('tokens')).toEqual({ type: Command.Tokens, value: null });
    expect(parseCommand('regenerate')).toEqual({ type: Command.Regenerate, value: null });
  });

  it('parses reasoning command', () => {
    expect(parseCommand('reasoning')).toEqual({ type: Command.Reasoning, value: null });
    expect(parseCommand('reasoning high')).toEqual({ type: Command.Reasoning, value: 'high' });
    expect(parseCommand('reasoning none')).toEqual({ type: Command.Reasoning, value: 'none' });
    expect(parseCommand('reasoning minimal')).toEqual({ type: Command.Reasoning, value: 'minimal' });
    expect(parseCommand('reasoning low')).toEqual({ type: Command.Reasoning, value: 'low' });
    expect(parseCommand('reasoning xhigh')).toEqual({ type: Command.Reasoning, value: 'xhigh' });
    expect(parseCommand('reasoning max')).toEqual({ type: Command.Reasoning, value: 'max' });
    expect(parseCommand('reasoning unset')).toEqual({ type: Command.Reasoning, value: 'unset' });
  });

  it('parses extension-handled commands as unknown', () => {
    // These are handled by extensions, not core
    expect(parseCommand('models')).toEqual({ type: Command.Unknown, value: 'models' });
    expect(parseCommand('model qwen3.5')).toEqual({ type: Command.Unknown, value: 'model qwen3.5' });
    expect(parseCommand('compact')).toEqual({ type: Command.Unknown, value: 'compact' });
    expect(parseCommand('sh ls')).toEqual({ type: Command.Unknown, value: 'sh ls' });
    expect(parseCommand('!ls')).toEqual({ type: Command.Unknown, value: '!ls' });
  });

  it('parses unknown commands and empty string', () => {
    expect(parseCommand('foobar')).toEqual({ type: Command.Unknown, value: 'foobar' });
    expect(parseCommand('')).toEqual({ type: Command.Unknown, value: null });
  });
});

describe('parseCommand with registry', () => {
  it('returns custom command when registered', () => {
    const registry = createCommandRegistry();
    registry.register('skill', { matches: (cmd) => cmd.startsWith('skill:') });
    registry.register('compact', { matches: (cmd) => cmd.startsWith('compact') && !cmd.startsWith('compact:') });

    const result1 = parseCommand('skill:rust-guidelines', registry);
    expect(result1.type).toBe('skill');
    expect(result1._customCommand).toBe('skill');

    const result2 = parseCommand('compact 10', registry);
    expect(result2.type).toBe('compact');
    expect(result2._customCommand).toBe('compact');
  });

  it('passes full command value to custom commands', () => {
    const registry = createCommandRegistry();
    registry.register('prompt', { matches: (cmd) => cmd.startsWith('prompt:') });

    const result = parseCommand('prompt:my-prompt some args', registry);
    expect(result.type).toBe('prompt');
    expect(result.value).toBe('prompt:my-prompt some args');
  });
});
