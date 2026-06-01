import { describe, it, expect } from 'bun:test';
import { parseCommand, Command, isUiCommand } from '../../src/core/commands.js';
import { createSlashCommandRegistry } from '../../src/core/slash-command-registry.js';

describe('parseCommand', () => {
  it('parses help', () => {
    expect(parseCommand('help')).toEqual({ type: Command.Help, value: null });
  });

  it('parses quit/exit', () => {
    expect(parseCommand('quit')).toEqual({ type: Command.Quit, value: null });
    expect(parseCommand('exit')).toEqual({ type: Command.Quit, value: null });
  });

  it('parses clear', () => {
    expect(parseCommand('clear')).toEqual({ type: Command.Clear, value: null });
  });

  it('parses clear with profile', () => {
    expect(parseCommand('clear explorer')).toEqual({ type: Command.ClearProfile, value: 'explorer' });
  });

  it('parses clear with trailing space as plain clear', () => {
    expect(parseCommand('clear ')).toEqual({ type: Command.Clear, value: null });
  });

  it('parses clear with extra spaces', () => {
    expect(parseCommand('clear  coding  ')).toEqual({ type: Command.ClearProfile, value: 'coding' });
  });

  it('parses tools', () => {
    expect(parseCommand('tools')).toEqual({ type: Command.Tools, value: null });
  });

  it('parses thinking', () => {
    expect(parseCommand('thinking')).toEqual({ type: Command.Thinking, value: null });
  });

  it('parses models', () => {
    expect(parseCommand('models')).toEqual({ type: Command.Models, value: null });
  });

  it('parses model (no name) as models', () => {
    expect(parseCommand('model')).toEqual({ type: Command.Models, value: null });
  });

  it('parses model with name', () => {
    expect(parseCommand('model qwen3.5-0.8b')).toEqual({ type: Command.Model, value: 'qwen3.5-0.8b' });
  });

  it('parses tokens', () => {
    expect(parseCommand('tokens')).toEqual({ type: Command.Tokens, value: null });
  });

  it('parses compact as unknown (handled by extension)', () => {
    // compact is now handled by the compaction extension via slash command registry
    expect(parseCommand('compact')).toEqual({ type: Command.Unknown, value: 'compact' });
  });

  it('parses compact:strategy as unknown (handled by extension)', () => {
    // compact:strategy is now handled by the compaction extension via slash command registry
    expect(parseCommand('compact:strategy list')).toEqual({ type: Command.Unknown, value: 'compact:strategy list' });
  });

  it('parses regenerate', () => {
    expect(parseCommand('regenerate')).toEqual({ type: Command.Regenerate, value: null });
  });

 it('parses sh as unknown (handled by extension)', () => {
    // sh is now handled by the run-shell-command extension
    expect(parseCommand('sh ls -la')).toEqual({ type: Command.Unknown, value: 'sh ls -la' });
  });

  it('parses ! as unknown (handled by extension)', () => {
    // ! is now handled by the run-shell-command extension
    expect(parseCommand('!ls')).toEqual({ type: Command.Unknown, value: '!ls' });
  });

  it('parses :! as unknown (handled by extension)', () => {
    // :! is now handled by the run-shell-command extension
    expect(parseCommand(':!ls -la')).toEqual({ type: Command.Unknown, value: ':!ls -la' });
  });

  it('parses unknown commands', () => {
    expect(parseCommand('foobar')).toEqual({ type: Command.Unknown, value: 'foobar' });
  });

  it('parses empty string as unknown', () => {
    expect(parseCommand('')).toEqual({ type: Command.Unknown, value: null });
  });
});

describe('parseCommand with registry', () => {
  it('returns custom command for skill: via registry', () => {
    const registry = createSlashCommandRegistry();
    registry.register('skill', {
      matches: (cmd) => cmd.startsWith('skill:'),
    });
    const result = parseCommand('skill:rust-guidelines', registry);
    expect(result.type).toBe('skill');
    expect(result.value).toBe('skill:rust-guidelines');
    expect(result._customCommand).toBe('skill');
  });

  it('returns custom command for prompt: via registry', () => {
    const registry = createSlashCommandRegistry();
    registry.register('prompt', {
      matches: (cmd) => cmd.startsWith('prompt:'),
    });
    const result = parseCommand('prompt:my-prompt some args', registry);
    expect(result.type).toBe('prompt');
    expect(result.value).toBe('prompt:my-prompt some args');
    expect(result._customCommand).toBe('prompt');
  });

  it('returns custom command for refresh via registry', () => {
    const registry = createSlashCommandRegistry();
    registry.register('refresh', {
      matches: (cmd) => cmd.startsWith('refresh'),
    });
    const result = parseCommand('refresh all', registry);
    expect(result.type).toBe('refresh');
    expect(result.value).toBe('refresh all');
    expect(result._customCommand).toBe('refresh');
  });

  it('returns custom command for compact via registry', () => {
    const registry = createSlashCommandRegistry();
    registry.register('compact', {
      matches: (cmd) => cmd.startsWith('compact') && !cmd.startsWith('compact:'),
    });
    const result = parseCommand('compact 10', registry);
    expect(result.type).toBe('compact');
    expect(result.value).toBe('compact 10');
    expect(result._customCommand).toBe('compact');
  });

  it('returns custom command for compact:strategy via registry', () => {
    const registry = createSlashCommandRegistry();
    registry.register('compact:strategy', {
      matches: (cmd) => cmd.startsWith('compact:strategy'),
    });
    const result = parseCommand('compact:strategy list', registry);
    expect(result.type).toBe('compact:strategy');
    expect(result.value).toBe('compact:strategy list');
    expect(result._customCommand).toBe('compact:strategy');
  });
});

describe('isUiCommand', () => {
  it('returns true for UI commands', () => {
    expect(isUiCommand(Command.Help)).toBe(true);
    expect(isUiCommand(Command.Quit)).toBe(true);
    expect(isUiCommand(Command.Tools)).toBe(true);
    expect(isUiCommand(Command.Thinking)).toBe(true);
  });

  it('returns false for agent commands', () => {
    expect(isUiCommand(Command.Clear)).toBe(false);
    expect(isUiCommand(Command.Model)).toBe(false);
  });
});
