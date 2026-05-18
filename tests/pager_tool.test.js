import { describe, it, expect } from 'bun:test';
import { PagerTool } from '../src/tools/pager.js';

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
    const ctx = {
      onGetCachedToolOutput: (toolCallId) => {
        if (toolCallId === 'call_123') return mockCached;
        return null;
      },
    };
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_123' }), ctx);
    expect(result).toBe(mockCached);
  });

  it('returns not found when no cached output', async () => {
    const tool = new PagerTool();
    const ctx = {
      onGetCachedToolOutput: () => null,
    };
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_456' }), ctx);
    expect(result).toContain('No cached output found');
    expect(result).toContain('call_456');
  });

  it('returns not found when context has no callback', async () => {
    const tool = new PagerTool();
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_789' }));
    expect(result).toContain('No cached output found');
  });

  it('returns not found when context is null', async () => {
    const tool = new PagerTool();
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_789' }), null);
    expect(result).toContain('No cached output found');
  });

  it('generates call display', () => {
    const tool = new PagerTool();
    const display = tool.callDisplay(JSON.stringify({ tool_call_id: 'call_abc' }));
    expect(display).toBe('pager: call_abc');
  });

  it('handles object input', async () => {
    const tool = new PagerTool();
    const result = await tool.execute({ tool_call_id: 'call_obj' });
    expect(result).toContain('No cached output found');
    expect(result).toContain('call_obj');
  });
});
