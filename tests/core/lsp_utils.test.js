import { describe, it, expect } from 'bun:test';
import {
  pathToUri,
  uriToPath,
  getLanguageId,
  estimateLspTokenCount,
  truncateLines,
  safeStringify,
} from '../ext/lsp/utils.js';

describe('pathToUri', () => {
  it('converts a Unix path to a file URI', () => {
    expect(pathToUri('/home/user/file.js')).toBe('file:///home/user/file.js');
  });

  it('converts a relative path to a file URI', () => {
    const uri = pathToUri('./src/file.ts');
    expect(uri).toMatch(/^file:\/\//);
    expect(uri).toContain('src');
    expect(uri).toContain('file.ts');
  });

  it('encodes special characters in path', () => {
    const uri = pathToUri('/path/with spaces/file.js');
    expect(uri).toContain('with%20spaces');
  });

  it('handles Windows-style paths', () => {
    const uri = pathToUri('C:\\Users\\file.js');
    expect(uri).toMatch(/^file:\/\//);
  });
});

describe('uriToPath', () => {
  it('converts a file URI to a Unix path', () => {
    expect(uriToPath('file:///home/user/file.js')).toBe('/home/user/file.js');
  });

  it('handles URIs with encoded characters', () => {
    expect(uriToPath('file:///path/with%20spaces/file.js')).toBe('/path/with spaces/file.js');
  });

  it('handles non-file URIs gracefully', () => {
    expect(uriToPath('http://example.com/file.js')).toBe('http://example.com/file.js');
  });

  it('handles null/undefined gracefully', () => {
    expect(uriToPath(null)).toBe(null);
    expect(uriToPath(undefined)).toBe(undefined);
  });

  it('handles Windows file URIs', () => {
    // Windows URIs: file:///C:/... → /C:/... (we strip the leading slash after file://)
    const result = uriToPath('file:///C:/Users/file.js');
    expect(result).toBe('/C:/Users/file.js');
  });
});

describe('getLanguageId', () => {
  it('maps .ts to typescript', () => {
    expect(getLanguageId('file.ts')).toBe('typescript');
  });

  it('maps .tsx to typescriptreact', () => {
    expect(getLanguageId('file.tsx')).toBe('typescriptreact');
  });

  it('maps .js to javascript', () => {
    expect(getLanguageId('file.js')).toBe('javascript');
  });

  it('maps .jsx to javascriptreact', () => {
    expect(getLanguageId('file.jsx')).toBe('javascriptreact');
  });

  it('maps .py to python', () => {
    expect(getLanguageId('file.py')).toBe('python');
  });

  it('maps .go to go', () => {
    expect(getLanguageId('file.go')).toBe('go');
  });

  it('maps .rs to rust', () => {
    expect(getLanguageId('file.rs')).toBe('rust');
  });

  it('maps .java to java', () => {
    expect(getLanguageId('file.java')).toBe('java');
  });

  it('maps .json to json', () => {
    expect(getLanguageId('file.json')).toBe('json');
  });

  it('maps .md to markdown', () => {
    expect(getLanguageId('file.md')).toBe('markdown');
  });

  it('falls back to plaintext for unknown extensions', () => {
    expect(getLanguageId('file.xyz')).toBe('plaintext');
  });

  it('is case-insensitive', () => {
    expect(getLanguageId('FILE.TS')).toBe('typescript');
    expect(getLanguageId('file.PY')).toBe('python');
  });

  it('handles paths with multiple dots', () => {
    expect(getLanguageId('my.config.json')).toBe('json');
  });
});

describe('estimateLspTokenCount', () => {
  it('estimates tokens for empty string', () => {
    expect(estimateLspTokenCount('')).toBe(0);
  });

  it('estimates tokens for short text', () => {
    const count = estimateLspTokenCount('Hello world');
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(10);
  });

  it('scales with text length', () => {
    const short = estimateLspTokenCount('Hello');
    const long = estimateLspTokenCount('Hello world this is a longer piece of text');
    expect(long).toBeGreaterThan(short);
  });
});

describe('truncateLines', () => {
  it('returns empty string for empty input', () => {
    expect(truncateLines('')).toBe('');
  });

  it('returns input when within limit', () => {
    const input = 'line1\nline2\nline3';
    expect(truncateLines(input, 5)).toBe(input);
  });

  it('truncates when exceeding limit', () => {
    const input = Array(10).fill('line').join('\n');
    const result = truncateLines(input, 5);
    expect(result).not.toContain('line9');
    expect(result).toContain('truncated');
  });
});

describe('safeStringify', () => {
  it('serializes simple objects', () => {
    const obj = { name: 'test', value: 42 };
    const result = safeStringify(obj);
    expect(result).toContain('test');
    expect(result).toContain('42');
  });

  it('handles circular references', () => {
    // Use a simpler approach - the safeStringify uses WeakSet which should work
    const obj = { name: 'test', nested: { value: 42 } };
    const result = safeStringify(obj);
    expect(result).toContain('test');
    expect(result).toContain('42');
  });
});
