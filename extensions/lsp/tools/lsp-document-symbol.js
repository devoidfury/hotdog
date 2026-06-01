// LSP Document Symbol tool — textDocument/documentSymbol

import { LspFileTool } from './lsp-position-tool.js';
import { ToolResult } from '../../core-tools/registry.js';

export class LspDocumentSymbolTool extends LspFileTool {
  static TOOL_NAME = 'lsp-document-symbol';
  static DESCRIPTION = 'Get a list of all symbols in a document. Returns function, class, variable, and other symbol definitions with their locations.';
  static LSP_METHOD = 'textDocument/documentSymbol';
  static REQUIRED_CAPABILITY = 'documentSymbolProvider';
  static SUCCESS_RESPONSE = 'No symbols found in document.';

  _formatResult(result, args, resolvedPath, languageId) {
    if (!result || result.length === 0) {
      return ToolResult.ok('No symbols found in document.');
    }

    // Format symbols — compact indented format with file header
    const lines = [resolvedPath];
    for (const symbol of result) {
      this._formatSymbol(symbol, lines, 0);
    }

    const maxLines = 100;
    if (lines.length > maxLines) {
      const extra = lines.length - maxLines;
      lines.splice(maxLines, 0, `--- [${extra} more symbols, use a smaller file or filter] ---`);
    }

    const metadata = new Map();
    metadata.set('file', resolvedPath);
    metadata.set('total_symbols', String(result.length));
    metadata.set('language', languageId);

    return ToolResult.ok(lines.join('\n')).withEntries(metadata);
  }

  _formatSymbol(symbol, lines, depth) {
    if (!symbol) return;

    const indent = '  '.repeat(depth);
    const kind = symbol.kind !== undefined ? (['', 'File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter'][symbol.kind] || 'Unknown') : 'Unknown';
    const location = this._formatLocation(symbol.location || symbol.range);
    const lineNum = location ? `:${location.split(':').slice(1, 3).join(':')}` : '';
    const detail = symbol.detail ? ` ${symbol.detail}` : '';

    lines.push(`${indent}${kind} ${symbol.name}${detail}${lineNum ? ` [L${lineNum}]` : ''}`);

    // Recurse into children
    if (symbol.children && symbol.children.length > 0) {
      for (const child of symbol.children) {
        this._formatSymbol(child, lines, depth + 1);
      }
    }
  }
}
