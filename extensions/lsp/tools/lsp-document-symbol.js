// LSP Document Symbol tool — textDocument/documentSymbol
// Created via factory to reduce boilerplate.

import { ToolResult } from '../../core-tools/registry.js';
import { defineFileTool } from './lsp-position-tool.js';

export const LspDocumentSymbolTool = defineFileTool({
  name: 'lsp-document-symbol',
  description:
    'Get a list of all symbols in a document. Returns function, class, variable, and other symbol definitions with their locations.',
  lspMethod: 'textDocument/documentSymbol',
  requiredCapability: 'documentSymbolProvider',
  successResponse: 'No symbols found in document.',
  formatResult: (self, result, args, resolvedPath, languageId) => {
    if (!result || result.length === 0) {
      return ToolResult.ok('No symbols found in document.');
    }

    // Format symbols — compact indented format with file header
    const lines = [resolvedPath];
    for (const symbol of result) {
      self._formatSymbol(symbol, lines, 0);
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
  },
});
