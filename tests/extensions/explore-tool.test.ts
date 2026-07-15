import { describe, it, expect } from 'bun:test';
import { ExploreTool } from '../../src/extensions/core-tools/explore.ts';
import { ToolContext } from '../../src/core/extensions/tool-context.ts';
import { resultStr } from '../helpers.ts';

describe('ExploreTool', () => {
  it('has correct TOOL_NAME', () => {
    expect(ExploreTool.TOOL_NAME).toBe('explore');
  });

  it('has valid tool definition', () => {
    const tool = new ExploreTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('explore');
    expect(def.function.description.length).toBeGreaterThan(0);
    expect(def.function.parameters.properties).toHaveProperty('path');
    expect(def.function.parameters.properties).toHaveProperty('outline');
    expect(def.function.parameters.required).toEqual(['path', 'outline']);
  });
});

describe('ExploreTool > callDisplay', () => {
  const tool = new ExploreTool();

  it('returns path=. for empty input', () => {
    expect(tool.callDisplay('')).toBe('path=.');
    expect(tool.callDisplay('  ')).toBe('path=.');
    expect(tool.callDisplay(null)).toBe('path=.');
  });

  it('formats path and outline', () => {
    expect(
      tool.callDisplay(JSON.stringify({ path: '/tmp', outline: 'src files' }))
    ).toBe('path=/tmp -> src files');
  });

  it('handles malformed JSON gracefully', () => {
    const result = tool.callDisplay('not-json');
    expect(result).toBe('not-json');
  });
});

describe('ExploreTool > _parseArgs', () => {
  const tool = new ExploreTool();

  it('returns defaults for empty input', () => {
    const args = (tool as any)._parseArgs('');
    expect(args).toEqual({ path: '.', outline: '' });
  });

  it('parses path and outline from JSON', () => {
    const args = (tool as any)._parseArgs(JSON.stringify({ path: '/var', outline: 'check structure' }));
    expect(args).toEqual({ path: '/var', outline: 'check structure' });
  });

  it('defaults unknown fields', () => {
    const args = (tool as any)._parseArgs(JSON.stringify({ path: '/tmp', unknown: true }));
    expect(args).toEqual({ path: '/tmp', outline: '' });
  });

  it('handles non-string input', () => {
    const args = (tool as any)._parseArgs({ path: '/home', outline: 'test' });
    expect(args).toEqual({ path: '/home', outline: 'test' });
  });
});

describe('ExploreTool > execute', () => {
  it('rejects missing outline', async () => {
    const tool = new ExploreTool();
    const result = await tool.execute(JSON.stringify({ path: '/tmp' }), new ToolContext());
    const output = resultStr(result);
    // resultStr returns the error string directly for error results
    expect(output).toContain("The 'outline' argument is required");
  });

  it('rejects empty input', async () => {
    const tool = new ExploreTool();
    const result = await tool.execute('', new ToolContext());
    const output = resultStr(result);
    expect(output).toContain("The 'outline' argument is required");
  });
});
