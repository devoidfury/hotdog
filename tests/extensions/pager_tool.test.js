import { describe, it, expect } from 'bun:test';
import { PagerTool } from '../../extensions/core-tools/pager.js';
import { ToolResult, ToolContext } from '../../src/core/tool-registry.js';

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

describe('PagerTool', () => {
  it('has correct tool name', () => {
    expect(PagerTool.TOOL_NAME).toBe('pager');
  });

  it('generates tool definition', () => {
    const tool = new PagerTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('pager');
    expect(def.function.parameters.required).toEqual(['tool_call_id']);
  });

  it('returns cached output when available', async () => {
    const tool = new PagerTool();
    const mockCached = 'Previously cached output data';
    const ctx = new ToolContext();
    ctx.set('onGetCachedToolOutput', (toolCallId) => {
      if (toolCallId === 'call_123') return mockCached;
      return null;
    });
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_123' }), ctx);
    expect(resultStr(result)).toBe(mockCached);
  });

  it('returns not found when no cached output', async () => {
    const tool = new PagerTool();
    const ctx = new ToolContext();
    ctx.set('onGetCachedToolOutput', () => null);
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_456' }), ctx);
    expect(resultStr(result)).toContain('No cached output found');
    expect(resultStr(result)).toContain('call_456');
  });

  it('returns not found when context has no callback', async () => {
    const tool = new PagerTool();
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_789' }));
    expect(resultStr(result)).toContain('No cached output found');
  });

  it('returns not found when context is null', async () => {
    const tool = new PagerTool();
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_789' }), null);
    expect(resultStr(result)).toContain('No cached output found');
  });

  it('generates call display', () => {
    const tool = new PagerTool();
    const display = tool.callDisplay(JSON.stringify({ tool_call_id: 'call_abc' }));
    expect(display).toBe('pager: call_abc');
  });

  it('handles object input', async () => {
    const tool = new PagerTool();
    const result = await tool.execute({ tool_call_id: 'call_obj' });
    expect(resultStr(result)).toContain('No cached output found');
    expect(resultStr(result)).toContain('call_obj');
  });
});
