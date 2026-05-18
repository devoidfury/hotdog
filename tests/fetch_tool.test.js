import { describe, it, expect } from 'bun:test';
import { FetchTool } from '../src/tools/fetch.js';

describe('FetchTool', () => {
  it('has correct tool name', () => {
    expect(FetchTool.TOOL_NAME).toBe('fetch');
  });

  it('generates tool definition with all HTTP methods', () => {
    const tool = new FetchTool();
    const def = tool.toToolDef();
    expect(def.function.name).toBe('fetch');
    expect(def.function.parameters.required).toEqual(['url']);
    expect(def.function.parameters.properties).toHaveProperty('method');
    expect(def.function.parameters.properties).toHaveProperty('headers');
    expect(def.function.parameters.properties).toHaveProperty('body');
  });

  it('generates call display for GET request', () => {
    const tool = new FetchTool();
    const display = tool.callDisplay(JSON.stringify({ url: 'https://example.com', method: 'GET' }));
    expect(display).toContain('GET');
    expect(display).toContain('example.com');
  });

  it('generates call display for POST request', () => {
    const tool = new FetchTool();
    const display = tool.callDisplay(JSON.stringify({ url: 'https://api.example.com/data', method: 'POST' }));
    expect(display).toContain('POST');
  });

  it('truncates long URLs in display', () => {
    const tool = new FetchTool();
    const longUrl = 'https://example.com/' + 'a'.repeat(50);
    const display = tool.callDisplay(JSON.stringify({ url: longUrl }));
    expect(display).toContain('...');
  });

  it('returns firstUseHelp', () => {
    const tool = new FetchTool();
    expect(tool.firstUseHelp()).toContain('HTTP requests');
  });
});

// Test parseArgs via the tool's execute method
// We can't import parseArgs directly since it's not exported,
// but we can test its behavior through the tool.
describe('FetchTool parseArgs behavior', () => {
  it('returns error for missing URL', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ method: 'GET' }));
    expect(result).toContain('Missing required argument: url');
  });

  it('returns error for empty input', async () => {
    const tool = new FetchTool();
    const result = await tool.execute('');
    expect(result).toContain('Missing required argument: url');
  });

  it('returns error for null input', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(null);
    expect(result).toContain('Missing required argument: url');
  });

  it('returns error for invalid JSON', async () => {
    const tool = new FetchTool();
    const result = await tool.execute('not valid json');
    expect(result).toContain('Error parsing arguments');
  });

  it('returns error for invalid HTTP method', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com', method: 'INVALID' }));
    expect(result).toContain('Invalid HTTP method');
  });

  it('normalizes method to uppercase', async () => {
    const tool = new FetchTool();
    // We can't easily verify the normalized method without mocking fetch,
    // but we can verify the tool accepts lowercase methods
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com', method: 'get' }));
    // Should not return a parse error
    expect(result).not.toContain('Invalid HTTP method');
    expect(result).not.toContain('Error parsing arguments');
  });

  it('handles object input', async () => {
    const tool = new FetchTool();
    const result = await tool.execute({ url: 'https://example.com' });
    // Should not return a parse error
    expect(result).not.toContain('Error parsing arguments');
  });
});
