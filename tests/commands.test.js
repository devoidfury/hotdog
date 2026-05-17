import { describe, it, expect } from 'bun:test';
import { parseCommand, executeCommand, Command, isUiCommand } from '../src/agent/commands.js';

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
  });

  it('returns false for agent commands', () => {
    expect(isUiCommand(Command.Clear)).toBe(false);
    expect(isUiCommand(Command.Model)).toBe(false);
    expect(isUiCommand(Command.Skill)).toBe(false);
  });
});

describe('executeCommand', () => {
  const makeAgent = (overrides = {}) => ({
    context: {
      clear: () => {},
      systemMessages: [],
    },
    modelRegistry: { 'qwen3.5-0.8b': { name: 'qwen3.5-0.8b' } },
    model: 'qwen3.5-0.8b',
    tokenStatsDisplay: () => 'Token stats',
    executePrompt: (name, args) => ({ success: true, prompt: `prompt:${name} ${args || ''}` }),
    regenerateSystemPrompt: () => 'system prompt content',
    allSkills: () => [
      { name: 'rust-guidelines', description: 'Rust best practices', loaded: true, visible: true },
      { name: 'stripe-integration', description: 'Stripe payments', loaded: false, visible: true },
    ],
    activateSkill: (name) => ({ success: name === 'rust-guidelines' }),
    ...overrides,
  });

  it('clears context', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Clear, value: null });
    expect(result.success).toBe(true);
    expect(result.message).toBe('Conversation cleared.');
  });

  it('lists models', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Models, value: null });
    expect(result.success).toBe(true);
    expect(result.message).toBe('qwen3.5-0.8b');
  });

  it('switches model', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Model, value: 'qwen3.5-4b' });
    expect(result.success).toBe(true);
    expect(result.message).toBe('Switched to model: qwen3.5-4b');
    expect(agent.model).toBe('qwen3.5-4b');
  });

  it('shows tokens', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Tokens, value: null });
    expect(result.success).toBe(true);
    expect(result.message).toBe('Token stats');
  });

  it('executes prompt', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Prompt, value: { name: 'test', args: 'hello' } });
    expect(result.success).toBe(true);
    expect(result.message).toBe("Prompt 'test' executed.");
  });

  it('fails on unknown prompt', () => {
    const agent = makeAgent({ executePrompt: () => ({ success: false, error: 'not found' }) });
    const result = executeCommand(agent, { type: Command.Prompt, value: { name: 'bad', args: undefined } });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Failed to execute prompt');
  });

  it('regenerates system prompt', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Regenerate, value: null });
    expect(result.success).toBe(true);
    expect(result.message).toContain('System prompt regenerated.');
  });

  it('lists skills', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Skill, value: null });
    expect(result.success).toBe(true);
    expect(result.message).toContain('Available skills:');
    expect(result.message).toContain('rust-guidelines');
  });

  it('activates skill', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Skill, value: 'rust-guidelines' });
    expect(result.success).toBe(true);
    expect(result.message).toContain("Skill 'rust-guidelines' activated.");
  });

  it('fails on unknown skill', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Skill, value: 'nonexistent' });
    expect(result.success).toBe(false);
  });

  it('handles unknown command', () => {
    const agent = makeAgent();
    const result = executeCommand(agent, { type: Command.Unknown, value: 'foobar' });
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown command: foobar');
  });
});
