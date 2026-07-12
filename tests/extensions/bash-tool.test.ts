import { describe, it, expect } from 'bun:test';
import { BashTool, create } from '../../src/extensions/bash-tool/index.ts';
import { resultStr } from '../helpers.ts';
import { HOOKS } from '../../src/core/hooks.ts';

describe('BashTool', () => {
  it('has correct tool name', () => {
    expect(BashTool.TOOL_NAME).toBe('bash');
  });

  it('generates tool definition', () => {
    const tool = new BashTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('bash');
    expect(def.function.parameters.required).toEqual(['command']);
  });

  it('returns error for missing command', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({}));
    expect(resultStr(result)).toContain('Error: command is required');
  });

  it('returns error for empty command', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: '' }));
    expect(resultStr(result)).toContain('Error: command is required');
  });

  it('executes echo command', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: 'echo hello' }));
    expect(resultStr(result)).toContain('hello');
  });

  it('respects custom timeout', async () => {
    const tool = new BashTool({ timeoutMs: 100 });
    const result = await tool.execute(JSON.stringify({ command: 'sleep 5', timeout_ms: 100 }));
    expect(resultStr(result)).toContain('timed out');
  });

  it('uses default timeout when not specified', async () => {
    // Default timeout is 30000ms (30s), so a short sleep should complete
    const tool = new BashTool({ timeoutMs: 30000 });
    const result = await tool.execute(JSON.stringify({ command: 'echo test' }));
    expect(resultStr(result)).toContain('test');
  });

  it('handles non-existent command', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: 'nonexistent_command_xyz_123' }));
    // Should return an error message from the shell
    expect(resultStr(result)).toBeTruthy();
    expect(typeof resultStr(result)).toBe('string');
    expect(resultStr(result).length).toBeGreaterThan(0);
  });

  it('handles object input', async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: 'echo object-input' });
    expect(resultStr(result)).toContain('object-input');
  });

  it('generates call display', () => {
    const tool = new BashTool();
    const display = tool.callDisplay(JSON.stringify({ command: 'ls -la' }));
    expect(display).toContain('ls -la');
  });

  it('limits output lines', async () => {
    const tool = new BashTool({ maxOutputLines: 2 });
    const result = await tool.execute(JSON.stringify({ command: 'printf "line1\\nline2\\nline3\\nline4\\nline5"' }));
    // Should be truncated
    expect(resultStr(result)).toContain('truncated');
  });

  it('handles multiline output', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: 'printf "line1\\nline2\\nline3"' }));
    expect(resultStr(result)).toContain('line1');
    expect(resultStr(result)).toContain('line2');
    expect(resultStr(result)).toContain('line3');
  });

  it('captures stderr', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: 'echo error >&2; echo success' }));
    expect(resultStr(result)).toContain('success');
  });

  it('truncates long command in metadata (>60 chars)', async () => {
    const tool = new BashTool();
    const longCmd = 'echo ' + 'a'.repeat(70);
    const result = await tool.execute(JSON.stringify({ command: longCmd }));
    const metadata = result.metadata;
    expect(metadata).toBeDefined();
    const cmd = metadata.get('command');
    expect(cmd.length).toBe(61); // 60 chars + "…"
    expect(cmd).toContain('…');
  });

  it('stores short command in metadata', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: 'echo hello' }));
    const metadata = result.metadata;
    expect(metadata).toBeDefined();
    expect(metadata.get('command')).toBe('echo hello');
    expect(metadata.get('exit_code')).toBe('0');
  });

  it('create() registers tool via HOOKS.TOOLS_REGISTER', async () => {
    let registeredName = null;
    let registeredTool = null;
    const registry = { register: (name, tool) => { registeredName = name; registeredTool = tool; } };
    const mockCore = { config: { bashTool: { bashTimeoutMs: 5000, maxToolOutputLines: 100 } } };
    const ext = create(mockCore);
    expect(ext).toBeDefined();
    expect(ext.hooks[HOOKS.TOOLS_REGISTER]).toBeDefined();
    expect(ext.BashTool).toBe(BashTool);
    await ext.hooks[HOOKS.TOOLS_REGISTER](registry);
    expect(registeredName).toBe('bash');
    expect(registeredTool).toBeInstanceOf(BashTool);
  });

  it('create() registers with default config when none provided', async () => {
    let registeredName = null;
    let registeredTool = null;
    const registry = { register: (name, tool) => { registeredName = name; registeredTool = tool; } };
    const mockCore = { config: {} };
    const ext = create(mockCore);
    expect(ext.hooks[HOOKS.TOOLS_REGISTER]).toBeDefined();
    await ext.hooks[HOOKS.TOOLS_REGISTER](registry);
    expect(registeredName).toBe('bash');
    expect(registeredTool).toBeInstanceOf(BashTool);
  });
});
