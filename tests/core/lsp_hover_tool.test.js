import { describe, it, expect, beforeEach } from 'bun:test';
import { LspHoverTool } from '../ext/lsp/tools/lsp-hover.js';
import { ToolResult } from '../extensions/core-tools/registry.js';

describe('LspHoverTool', () => {
  let tool;

  beforeEach(() => {
    tool = new LspHoverTool();
  });

  describe('toToolDef', () => {
    it('returns a valid tool definition', () => {
      const def = tool.toToolDef();
      expect(def.type).toBe('function');
      expect(def.function.name).toBe('lsp-hover');
      expect(def.function.description).toContain('hover');
      expect(def.function.parameters.properties.file).toBeDefined();
      expect(def.function.parameters.properties.line).toBeDefined();
      expect(def.function.parameters.properties.character).toBeDefined();
      expect(def.function.parameters.required).toContain('file');
      expect(def.function.parameters.required).toContain('line');
      expect(def.function.parameters.required).toContain('character');
    });
  });

  describe('callDisplay', () => {
    it('displays hover with string input', () => {
      const display = tool.callDisplay(JSON.stringify({
        file: '/test.js',
        line: 5,
        character: 10,
      }));
      expect(display).toBe('hover(/test.js:5:10)');
    });

    it('displays hover with object input', () => {
      const display = tool.callDisplay({
        file: '/test.ts',
        line: 1,
        character: 0,
      });
      expect(display).toBe('hover(/test.ts:1:0)');
    });
  });

  describe('execute', () => {
    it('returns error when file is missing', async () => {
      const result = await tool.execute({ line: 0, character: 0 }, {});
      expect(result.isErr()).toBe(true);
      expect(result.error).toContain('file is required');
    });

    it('returns error when line is missing', async () => {
      const result = await tool.execute({ file: '/test.js', character: 0 }, {});
      expect(result.isErr()).toBe(true);
      expect(result.error).toContain('line is required');
    });

    it('returns error when character is missing', async () => {
      const result = await tool.execute({ file: '/test.js', line: 0 }, {});
      expect(result.isErr()).toBe(true);
      expect(result.error).toContain('character is required');
    });

    it('returns error for non-existent file', async () => {
      const result = await tool.execute(
        { file: '/nonexistent/path/that/does/not/exist.js', line: 0, character: 0 },
        {}
      );
      expect(result.isErr()).toBe(true);
      expect(result.error).toContain('File not found');
    });

    it('returns error when no LSP server configured', async () => {
      const result = await tool.execute(
        { file: '/workspace/oa-js/extensions/core-tools/read.js', line: 1, character: 0 },
        { cwdBoundary: '/workspace/oa-js', workspaceRoot: '/workspace/oa-js' }
      );
      expect(result.isErr()).toBe(true);
      expect(result.error).toContain('No language server configured');
    });
  });

  describe('_formatHover', () => {
    it('formats string hover content', () => {
      const hover = { contents: 'This is a hover document' };
      const result = tool._formatHover(hover);
      expect(result).toBe('This is a hover document');
    });

    it('formats array hover content', () => {
      const hover = {
        contents: [
          { language: 'javascript', value: 'function foo() {}' },
          'Description text',
        ],
      };
      const result = tool._formatHover(hover);
      expect(result).toContain('function foo() {}');
      expect(result).toContain('Description text');
    });

    it('formats object hover content with value', () => {
      const hover = {
        contents: { value: 'Object hover content' },
      };
      const result = tool._formatHover(hover);
      expect(result).toBe('Object hover content');
    });

    it('formats null hover', () => {
      const result = tool._formatHover(null);
      expect(result).toBe('No hover information available.');
    });

    it('formats hover with range', () => {
      const hover = {
        contents: 'Hover text',
        range: { start: { line: 10, character: 5 } },
      };
      const result = tool._formatHover(hover);
      expect(result).toContain('[Line 11]');
    });

    it('truncates long hover content', () => {
      const longText = Array(100).fill('line').join('\n');
      const hover = { contents: longText };
      const result = tool._formatHover(hover, 10);
      expect(result).toContain('truncated');
    });
  });

  describe('_formatLocation', () => {
    it('formats a simple location', () => {
      const location = { uri: 'file:///test.js', range: { start: { line: 5, character: 10 } } };
      const result = tool._formatLocation(location);
      expect(result).toBe('/test.js:6:11');
    });

    it('formats a location link', () => {
      const location = {
        uri: 'file:///other.js',
        targetSelectionRange: { start: { line: 0, character: 0 } },
      };
      const result = tool._formatLocation(location);
      expect(result).toBe('/other.js:1:1');
    });

    it('returns null for null location', () => {
      expect(tool._formatLocation(null)).toBeNull();
    });
  });

  describe('_formatCompletions', () => {
    it('formats empty completions', () => {
      expect(tool._formatCompletions([])).toBe('No completions available.');
    });

    it('formats completion items', () => {
      const items = [
        { label: 'foo', kind: 3, detail: '() => void' },
        { label: 'bar', kind: 7, detail: 'class Bar' },
      ];
      const result = tool._formatCompletions(items);
      expect(result).toContain('foo');
      expect(result).toContain('bar');
      expect(result).toContain('Function');
      expect(result).toContain('Class');
    });

    it('respects max items limit', () => {
      const items = Array(100).fill(null).map((_, i) => ({ label: `item${i}`, kind: 1 }));
      const result = tool._formatCompletions(items, 5);
      expect(result).toContain('item0');
      expect(result).toContain('item4');
      expect(result).not.toContain('item5');
      expect(result).toContain('95 more completions');
    });
  });

  describe('_formatSymbol', () => {
    it('formats a simple symbol', () => {
      const symbol = {
        name: 'myFunction',
        kind: 12, // Function
        location: { uri: 'file:///test.js', range: { start: { line: 0, character: 0 } } },
      };
      const result = tool._formatSymbol(symbol);
      expect(result).toContain('Function');
      expect(result).toContain('myFunction');
    });

    it('formats nested symbols', () => {
      const symbol = {
        name: 'MyClass',
        kind: 5, // Class
        location: { uri: 'file:///test.js', range: { start: { line: 0, character: 0 } } },
        children: [
          {
            name: 'method',
            kind: 6, // Method
            location: { uri: 'file:///test.js', range: { start: { line: 2, character: 4 } } },
          },
        ],
      };
      const result = tool._formatSymbol(symbol);
      expect(result).toContain('MyClass');
      expect(result).toContain('method');
    });
  });

  describe('_formatDiagnostics', () => {
    it('formats empty diagnostics', () => {
      expect(tool._formatDiagnostics([])).toBe('No diagnostics.');
    });

    it('formats diagnostics', () => {
      const diagnostics = [
        {
          severity: 1, // Error
          message: 'Unused variable',
          uri: 'file:///test.js',
          range: { start: { line: 5, character: 0 } },
        },
        {
          severity: 2, // Warning
          message: 'Deprecated function',
          uri: 'file:///test.js',
          range: { start: { line: 10, character: 0 } },
          source: 'typescript',
        },
      ];
      const result = tool._formatDiagnostics(diagnostics);
      expect(result).toContain('Error');
      expect(result).toContain('Warning');
      expect(result).toContain('Unused variable');
    });

    it('respects max items limit', () => {
      const diagnostics = Array(100).fill(null).map((_, i) => ({
        severity: 1,
        message: `Diagnostic ${i}`,
        uri: 'file:///test.js',
        range: { start: { line: i, character: 0 } },
      }));
      const result = tool._formatDiagnostics(diagnostics, 5);
      expect(result).toContain('Diagnostic 0');
      expect(result).toContain('Diagnostic 4');
      expect(result).toContain('95 more diagnostics');
    });
  });
});
