import { describe, it, expect } from 'bun:test';
import { parseCommand, Command, isUiCommand } from '../../src/core/commands.js';

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

  it('parses compact without args', () => {
    expect(parseCommand('compact')).toEqual({ type: Command.Compact, value: { keep: null, debug: false } });
  });

  it('parses compact with keep count', () => {
    expect(parseCommand('compact 10')).toEqual({ type: Command.Compact, value: { keep: 10, debug: false } });
  });

  it('parses compact with debug flag', () => {
    expect(parseCommand('compact 5 --compact-debug')).toEqual({ type: Command.Compact, value: { keep: 5, debug: true } });
  });

  it('parses prompt with args', () => {
    expect(parseCommand('prompt:my-prompt some args')).toEqual({
      type: Command.Prompt,
      value: { name: 'my-prompt', args: 'some args' },
    });
  });

  it('parses prompt without args', () => {
    expect(parseCommand('prompt:my-prompt')).toEqual({
      type: Command.Prompt,
      value: { name: 'my-prompt', args: undefined },
    });
  });

  it('parses regenerate', () => {
    expect(parseCommand('regenerate')).toEqual({ type: Command.Regenerate, value: null });
  });

  it('parses skill:name', () => {
    expect(parseCommand('skill:rust-guidelines')).toEqual({ type: Command.Skill, value: 'rust-guidelines' });
  });

  it('parses skill: with spaces', () => {
    expect(parseCommand('skill:  stripe-integration  ')).toEqual({ type: Command.Skill, value: 'stripe-integration' });
  });

  it('parses skill: (empty) as list', () => {
    expect(parseCommand('skill:')).toEqual({ type: Command.Skill, value: null });
  });

  it('parses skill: (space) as list', () => {
    expect(parseCommand('skill: ')).toEqual({ type: Command.Skill, value: null });
  });

  it('parses sh with command', () => {
    expect(parseCommand('sh ls -la')).toEqual({ type: Command.Shell, value: 'ls -la' });
  });

  it('parses sh with complex command', () => {
    expect(parseCommand('sh echo "hello world" && cat file.txt')).toEqual({
      type: Command.Shell,
      value: 'echo "hello world" && cat file.txt',
    });
  });

  it('parses sh with trailing space as empty value', () => {
    expect(parseCommand('sh ')).toEqual({ type: Command.Shell, value: null });
  });

  it('parses :! vim-like shell escape', () => {
    expect(parseCommand(':!ls -la')).toEqual({ type: Command.Shell, value: 'ls -la' });
  });

  it('parses ! vim-like shell escape', () => {
    expect(parseCommand('!ls')).toEqual({ type: Command.Shell, value: 'ls' });
  });

  it('parses :! with complex command', () => {
    expect(parseCommand(':!echo "hello" && cat file.txt')).toEqual({
      type: Command.Shell,
      value: 'echo "hello" && cat file.txt',
    });
  });

  it('parses :! with trailing space as empty value', () => {
    expect(parseCommand(':! ')).toEqual({ type: Command.Shell, value: null });
  });

  it('parses unknown commands', () => {
    expect(parseCommand('foobar')).toEqual({ type: Command.Unknown, value: 'foobar' });
  });

  it('parses empty string as unknown', () => {
    expect(parseCommand('')).toEqual({ type: Command.Unknown, value: null });
  });
});

describe('isUiCommand', () => {
  it('returns true for UI commands', () => {
    expect(isUiCommand(Command.Help)).toBe(true);
    expect(isUiCommand(Command.Quit)).toBe(true);
    expect(isUiCommand(Command.Tools)).toBe(true);
    expect(isUiCommand(Command.Thinking)).toBe(true);
    expect(isUiCommand(Command.Shell)).toBe(true);
  });

  it('returns false for agent commands', () => {
    expect(isUiCommand(Command.Clear)).toBe(false);
    expect(isUiCommand(Command.Model)).toBe(false);
    expect(isUiCommand(Command.Skill)).toBe(false);
  });
});
