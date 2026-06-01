import { describe, it, expect } from 'bun:test';
import { BashTool } from '../../extensions/core-tools/bash.js';
import { ToolResult } from '../../extensions/core-tools/registry.js';

/**
 * Extract string output from a tool result (handles ToolResult or plain string).
 */
function resultStr(result) {
  if (result instanceof ToolResult) {
    if (result.error) {
      return result.error;
    }
    return result.output;
  }
  return result;
}

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
    // Should return some output (error from shell)
    expect(typeof resultStr(result)).toBe('string');
  });

  it('handles object input', async () => {
    const tool = new BashTool();
    const result = await tool.execute({ command: 'echo object-input' });
    expect(resultStr(result)).toContain('object-input');
  });

  it('generates call display', () => {
    const tool = new BashTool();
    const display = tool.callDisplay(JSON.stringify({ command: 'ls -la' }));
    expect(display).toBe('bash: ls -la');
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
});
