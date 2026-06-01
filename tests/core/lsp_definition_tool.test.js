import { describe, it, expect, beforeEach } from 'bun:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
// tests/core/ -> tests/ -> project root
const PROJECT_ROOT = path.resolve(__dirname, '../..');
import { LspDefinitionTool } from '../../extensions/lsp/tools/lsp-definition.js';
import { ToolContext } from '../../extensions/core-tools/registry.js';

describe('LspDefinitionTool', () => {
  let tool;

  beforeEach(() => {
    tool = new LspDefinitionTool();
  });

  describe('toToolDef', () => {
    it('returns a valid tool definition', () => {
      const def = tool.toToolDef();
      expect(def.type).toBe('function');
      expect(def.function.name).toBe('lsp-definition');
      expect(def.function.description).toContain('definition');
      expect(def.function.parameters.properties.file).toBeDefined();
      expect(def.function.parameters.properties.line).toBeDefined();
      expect(def.function.parameters.properties.character).toBeDefined();
      expect(def.function.parameters.required).toContain('file');
      expect(def.function.parameters.required).toContain('line');
      expect(def.function.parameters.required).toContain('character');
    });
  });

  describe('callDisplay', () => {
    it('displays definition with string input', () => {
      const display = tool.callDisplay(JSON.stringify({
        file: '/test.js',
        line: 5,
        character: 10,
      }));
      expect(display).toBe('lsp-definition(/test.js:5:10)');
    });

    it('displays definition with object input', () => {
      const display = tool.callDisplay({
        file: '/test.ts',
        line: 1,
        character: 0,
      });
      expect(display).toBe('lsp-definition(/test.ts:1:0)');
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
        { file: path.join(PROJECT_ROOT, 'extensions/core-tools/read.js'), line: 1, character: 0 },
        new ToolContext({ cwdBoundary: PROJECT_ROOT, workspaceRoot: PROJECT_ROOT })
      );
      expect(result.isErr()).toBe(true);
      expect(result.error).toContain('No language server configured');
    });
  });

  describe('_formatLocation', () => {
    it('formats a single location', () => {
      const location = { uri: 'file:///src/utils.js', range: { start: { line: 42, character: 10 } } };
      const result = tool._formatLocation(location);
      expect(result).toBe('/src/utils.js:43:11');
    });

    it('formats a location link', () => {
      const location = {
        uri: 'file:///src/types.ts',
        targetRange: { start: { line: 15, character: 0 } },
      };
      const result = tool._formatLocation(location);
      expect(result).toBe('/src/types.ts:16:1');
    });

    it('returns null for null location', () => {
      expect(tool._formatLocation(null)).toBeNull();
    });

    it('handles missing range gracefully', () => {
      const location = { uri: 'file:///test.js' };
      const result = tool._formatLocation(location);
      expect(result).toBe('/test.js:1:1');
    });
  });

  describe('_formatHover', () => {
    it('formats string hover content', () => {
      const hover = { contents: 'function foo(): number' };
      const result = tool._formatHover(hover);
      expect(result).toBe('function foo(): number');
    });

    it('formats markdown hover content', () => {
      const hover = {
        contents: [
          { language: 'typescript', value: 'function foo(x: number): number' },
        ],
      };
      const result = tool._formatHover(hover);
      expect(result).toContain('typescript');
      expect(result).toContain('function foo');
    });

    it('handles null hover', () => {
      expect(tool._formatHover(null)).toBe('No hover information available.');
    });
  });
});
