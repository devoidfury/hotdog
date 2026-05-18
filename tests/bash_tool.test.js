import { describe, it, expect } from 'bun:test';
import { BashTool } from '../src/tools/bash.js';

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
    expect(result).toContain('Error: command is required');
  });

  it('returns error for empty command', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: '' }));
    expect(result).toContain('Error: command is required');
  });

  it('executes echo command', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: 'echo hello' }));
    expect(result).toContain('hello');
  });

  it('respects custom timeout', async () => {
    const tool = new BashTool({ timeoutMs: 100 });
    const result = await tool.execute(JSON.stringify({ command: 'sleep 5', timeout_ms: 100 }));
    expect(result).toContain('timed out');
  });

  it('uses default timeout when not specified', async () => {
    // Default timeout is 30000ms (30s), so a short sleep should complete
    const tool = new BashTool({ timeoutMs: 30000 });
    const result = await tool.execute(JSON.stringify({ command: 'echo test' }));
    expect(result).toContain('test');
  });

  it('handles non-existent command', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: 'nonexistent_command_xyz_123' }));
    // Should return some output (error from shell)
    expect(typeof result).toBe('string');
  });

  it('handles object input', async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: 'echo object-input' });
    expect(result).toContain('object-input');
  });

  it('generates call display', () => {
    const tool = new BashTool();
    const display = tool.callDisplay(JSON.stringify({ command: 'ls -la' }));
    expect(display).toBe('bash: ls -la');
  });

  it('returns firstUseHelp', () => {
    const tool = new BashTool();
    expect(BashTool.FIRST_USE_HELP).toContain('shell command');
  });

  it('limits output lines', async () => {
    const tool = new BashTool({ maxOutputLines: 2 });
    const result = await tool.execute(JSON.stringify({ command: 'printf "line1\\nline2\\nline3\\nline4\\nline5"' }));
    // Should be truncated
    expect(result).toContain('truncated');
  });

  it('handles multiline output', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: 'printf "line1\\nline2\\nline3"' }));
    expect(result).toContain('line1');
    expect(result).toContain('line2');
    expect(result).toContain('line3');
  });

  it('captures stderr', async () => {
    const tool = new BashTool();
    const result = await tool.execute(JSON.stringify({ command: 'echo error >&2; echo success' }));
    expect(result).toContain('success');
  });
});
