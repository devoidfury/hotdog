import { describe, it, expect } from 'bun:test';
import { FetchTool } from '../../extensions/core-tools/fetch.js';
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
    expect(def.function.parameters.properties).toHaveProperty('showOriginal');
    expect(def.function.parameters.properties.showOriginal.type).toBe('boolean');
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

});

// Test parseArgs via the tool's execute method
// We can't import parseArgs directly since it's not exported,
// but we can test its behavior through the tool.
describe('FetchTool parseArgs behavior', () => {
  function getResultStr(result) {
    if (result?.toDisplay) {
      return result.toDisplay();
    }
    return String(result);
  }

  it('returns error for missing URL', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ method: 'GET' }));
    expect(getResultStr(result)).toContain('Missing required argument: url');
  });

  it('returns error for empty input', async () => {
    const tool = new FetchTool();
    const result = await tool.execute('');
    expect(getResultStr(result)).toContain('Missing required argument: url');
  });

  it('returns error for null input', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(null);
    expect(getResultStr(result)).toContain('Missing required argument: url');
  });

  it('returns error for invalid JSON', async () => {
    const tool = new FetchTool();
    const result = await tool.execute('not valid json');
    expect(getResultStr(result)).toContain('Error parsing arguments');
  });

  it('returns error for invalid HTTP method', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com', method: 'INVALID' }));
    expect(getResultStr(result)).toContain('Invalid HTTP method');
  });

  it('normalizes method to uppercase', async () => {
    const tool = new FetchTool();
    // We can't easily verify the normalized method without mocking fetch,
    // but we can verify the tool accepts lowercase methods
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com', method: 'get' }));
    const str = getResultStr(result);
    // Should not return a parse error
    expect(str).not.toContain('Invalid HTTP method');
    expect(str).not.toContain('Error parsing arguments');
  });

  it('handles object input', async () => {
    const tool = new FetchTool();
    const result = await tool.execute({ url: 'https://example.com' });
    const str = getResultStr(result);
    // Should not return a parse error
    expect(str).not.toContain('Error parsing arguments');
  });

  it('accepts showOriginal: true without parse error', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com', showOriginal: true }));
    const str = getResultStr(result);
    expect(str).not.toContain('Error parsing arguments');
    expect(str).not.toContain('Invalid');
  });

  it('accepts showOriginal: false without parse error', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com', showOriginal: false }));
    const str = getResultStr(result);
    expect(str).not.toContain('Error parsing arguments');
    expect(str).not.toContain('Invalid');
  });

  it('accepts showOriginal: 0 without parse error (falsy but not true)', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com', showOriginal: 0 }));
    const str = getResultStr(result);
    expect(str).not.toContain('Error parsing arguments');
    expect(str).not.toContain('Invalid');
  });

  it('accepts showOriginal: "true" (string) without parse error', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com', showOriginal: 'true' }));
    const str = getResultStr(result);
    expect(str).not.toContain('Error parsing arguments');
    expect(str).not.toContain('Invalid');
  });
});

// Integration tests for pandoc HTML-to-GFM conversion
describe('FetchTool pandoc conversion', () => {
  function getResultData(result) {
    // ToolResult stores output in .output for success
    // For objects, it's stored directly; for strings, it's the raw output
    if (result?.output !== undefined) {
      return result.output;
    }
    if (result?.toDisplay) {
      return result.toDisplay();
    }
    return String(result);
  }

  it('converts HTML to GFM when showOriginal is not true', async () => {
    const tool = new FetchTool();
    // Fetch a real HTML page - pandoc should convert it
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com' }));
    const data = getResultData(result);
    // data is an object (ToolResult.ok({...}))
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    expect(parsed.content_type).toContain('text/html');
    // The body should be the pandoc-converted GFM (or original HTML if pandoc fails)
    expect(parsed.body).toBeDefined();
    expect(typeof parsed.body).toBe('string');
  });

  it('returns original HTML when showOriginal is true', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: 'https://example.com', showOriginal: true }));
    const data = getResultData(result);
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    expect(parsed.content_type).toContain('text/html');
    expect(typeof parsed.body).toBe('string');
    // Body should contain HTML tags (not converted to GFM)
    expect(parsed.body.toLowerCase()).toContain('<!doctype html>');
  });

  it('returns non-HTML content unchanged when showOriginal is false', async () => {
    const tool = new FetchTool();
    const result = await tool.execute(JSON.stringify({ url: 'https://jsonplaceholder.typicode.com/posts/1' }));
    const data = getResultData(result);
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    expect(parsed.content_type).toContain('application/json');
    // JSON should be parsed as an object, not a string
    expect(typeof parsed.body).toBe('object');
  });
});
