import { describe, it, expect } from 'bun:test';
import { PagerTool } from '../../src/extensions/core-tools/pager.ts';
import { ToolContext } from '../../src/core/extensions/tool-context.ts';
import { resultStr } from '../helpers.ts';

describe('PagerTool', () => {
  it('has correct tool name', () => {
    expect(PagerTool.TOOL_NAME).toBe('pager');
  });

  it('generates tool definition', () => {
    const tool = new PagerTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('pager');
    expect(def.function.parameters.required).toEqual(['tool_call_id']);
    expect(def.function.description).toContain('pagination');
  });

  it('returns cached output when available', async () => {
    const tool = new PagerTool();
    const mockCached = 'Previously cached output data';
    const ctx = new ToolContext();
    ctx.set('onGetCachedToolOutput', (toolCallId: string) => {
      if (toolCallId === 'call_123') return mockCached;
      return null;
    });
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_123' }), ctx);
    expect(resultStr(result)).toContain('cached output');
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
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_789' }), new ToolContext());
    expect(resultStr(result)).toContain('No cached output found');
  });

  it('generates call display', () => {
    const tool = new PagerTool();
    const display = tool.callDisplay(JSON.stringify({ tool_call_id: 'call_abc' }));
    expect(display).toBe('pager: call_abc');
  });

  it('handles object input', async () => {
    const tool = new PagerTool();
    const result = await tool.execute({ tool_call_id: 'call_obj' }, new ToolContext());
    expect(resultStr(result)).toContain('No cached output found');
    expect(resultStr(result)).toContain('call_obj');
  });

  it('handles null input', async () => {
    const tool = new PagerTool();
    const result = await tool.execute(null, new ToolContext());
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('handles empty string input', async () => {
    const tool = new PagerTool();
    const result = await tool.execute('', new ToolContext());
    expect(resultStr(result)).toContain('Error parsing arguments');
  });

  it('handles missing tool_call_id', async () => {
    const tool = new PagerTool();
    const result = await tool.execute(JSON.stringify({}), new ToolContext());
    expect(resultStr(result)).toContain('No cached output found');
  });

  it('returns cached output with correct tool_call_id metadata', async () => {
    const tool = new PagerTool();
    const ctx = new ToolContext();
    ctx.set('onGetCachedToolOutput', (toolCallId: string) => {
      if (toolCallId === 'call_entry') return 'entry data';
      return null;
    });
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'call_entry' }), ctx);
    expect(result.metadata).toBeDefined();
    expect(result.metadata?.get('tool_call_id')).toBe('call_entry');
  });

  it('handles undefined tool_call_id', async () => {
    const tool = new PagerTool();
    const result = await tool.execute(JSON.stringify({ tool_call_id: undefined }), new ToolContext());
    expect(resultStr(result)).toContain('No cached output found');
  });

  it('handles numeric tool_call_id', async () => {
    const tool = new PagerTool();
    const ctx = new ToolContext();
    ctx.set('onGetCachedToolOutput', (toolCallId: string) => {
      if (toolCallId === '12345') return 'numeric id data';
      return null;
    });
    const result = await tool.execute(JSON.stringify({ tool_call_id: 12345 }), ctx);
    expect(resultStr(result)).toBeDefined();
  });

  it('callDisplay handles null input', () => {
    const tool = new PagerTool();
    const display = tool.callDisplay(null);
    expect(display).toBeDefined();
  });

  it('callDisplay handles empty string', () => {
    const tool = new PagerTool();
    const display = tool.callDisplay('');
    expect(display).toBeDefined();
  });

  it('callDisplay handles malformed JSON', () => {
    const tool = new PagerTool();
    const display = tool.callDisplay('not-json');
    expect(display).toBe('not-json');
  });

  it('returns success for valid cached output', async () => {
    const tool = new PagerTool();
    const ctx = new ToolContext();
    ctx.set('onGetCachedToolOutput', () => 'valid cached content');
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'any-id' }), ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBe('valid cached content');
  });

  it('returns error for missing cached output', async () => {
    const tool = new PagerTool();
    const ctx = new ToolContext();
    ctx.set('onGetCachedToolOutput', () => null);
    const result = await tool.execute(JSON.stringify({ tool_call_id: 'missing' }), ctx);
    expect(result.success).toBe(false);
    expect(result.error).not.toBeNull();
  });
});
