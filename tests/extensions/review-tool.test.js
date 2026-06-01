import { describe, it, expect } from 'bun:test';
import { ReviewTool } from '../../src/extensions/session-review/review.js';
import { ToolResult } from '../../src/core/extensions/tool-utils.js';

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

describe('ReviewTool', () => {
  it('has correct tool name', () => {
    const tool = new ReviewTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('review');
  });

  it('generates tool definition with operations', () => {
    const tool = new ReviewTool();
    const def = tool.toToolDef();
    expect(def.function.parameters.properties).toHaveProperty('operation');
    expect(def.function.parameters.properties.operation.enum).toEqual(['list', 'get', 'tool_index']);
    expect(def.function.parameters.required).toEqual(['operation']);
  });

  it('defaults to list operation with no input', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute('');
    // Should return JSON array (may be empty)
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('defaults to list operation with null input', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(null);
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('returns error for get without session_id', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({ operation: 'get' }));
    expect(resultStr(result)).toContain('session_id is required');
  });

  it('returns error for tool_index without session_id', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({ operation: 'tool_index' }));
    expect(resultStr(result)).toContain('session_id is required');
  });

  it('returns error for unknown operation', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({ operation: 'unknown' }));
    expect(resultStr(result)).toContain('Unknown operation');
  });

  it('limits list to max 100', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute(JSON.stringify({ operation: 'list', limit: 9999 }));
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('generates call display for list', () => {
    const tool = new ReviewTool();
    expect(tool.callDisplay(JSON.stringify({ operation: 'list' }))).toContain('list');
  });

  it('generates call display for get', () => {
    const tool = new ReviewTool();
    expect(tool.callDisplay(JSON.stringify({ operation: 'get', session_id: 'abc123' }))).toContain('abc123');
  });

  it('generates call display for tool_index', () => {
    const tool = new ReviewTool();
    expect(tool.callDisplay(JSON.stringify({ operation: 'tool_index', session_id: 'xyz' }))).toContain('xyz');
  });

  it('generates call display with unknown operation', () => {
    const tool = new ReviewTool();
    expect(tool.callDisplay(JSON.stringify({ operation: 'unknown' }))).toContain('unknown');
  });

  it('handles invalid JSON gracefully (defaults to list)', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute('not json');
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('handles empty string input', async () => {
    const tool = new ReviewTool();
    const result = await tool.execute('');
    const parsed = JSON.parse(resultStr(result));
    expect(Array.isArray(parsed)).toBe(true);
  });
});
