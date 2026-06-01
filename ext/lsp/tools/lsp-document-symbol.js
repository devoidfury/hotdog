// LSP Document Symbol tool — textDocument/documentSymbol

import fs from 'node:fs';
import { LspBaseTool, CompletionKind, SymbolKind, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../../extensions/core-tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspDocumentSymbolTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-document-symbol';
  static DESCRIPTION = 'Get a list of all symbols in a document. Returns function, class, variable, and other symbol definitions with their locations.';

  toToolDef() {
    return toolDef(
      LspDocumentSymbolTool.TOOL_NAME,
      LspDocumentSymbolTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          file: param('string', 'Path to the file.'),
        },
        required: ['file'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `documentSymbol(${args.file})`;
  }

  _formatDocumentSymbols(symbols, filePath) {
    const lines = [filePath];
    for (const symbol of symbols) {
      this._formatSymbol(symbol, lines, 0);
    }
    return lines;
  }

  _formatSymbol(symbol, lines, depth) {
    if (!symbol) return;

    const indent = '  '.repeat(depth);
    const kind = SymbolKind[symbol.kind] || 'Unknown';
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

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const filePath = args.file;

    if (filePath === undefined || filePath === null) {
      return ToolResult.err('file is required');
    }

    // Resolve path
    const resolvedPath = this._resolvePath(filePath, ctx);

    // Check file exists
    if (!fs.existsSync(resolvedPath)) {
      return ToolResult.err(`File not found: ${resolvedPath}`);
    }

    // Get language ID and client
    const languageId = this._getLanguageId(resolvedPath);
    const client = await this._getClient(languageId, ctx, this.lspConfig);

    if (!client) {
      return ToolResult.err(
        `No language server configured for '${languageId}'. ` +
        'Configure an LSP server in your profile or defaults.json.'
      );
    }

    try {
      // Ensure document is open
      const uri = await this._ensureDocumentOpen(client, resolvedPath, languageId);

      // Check server supports document symbols
      const caps = client.getCapabilities();
      if (!caps?.documentSymbolProvider) {
        return ToolResult.err(`Server does not support document symbols (documentSymbolProvider not in capabilities)`);
      }

      // Send document symbol request
      const result = await client.request('textDocument/documentSymbol', {
        textDocument: { uri },
      });

      if (!result || result.length === 0) {
        return ToolResult.ok('No symbols found in document.');
      }

      // Format symbols — compact indented format with file header
      let lines = this._formatDocumentSymbols(result, resolvedPath);
      const maxLines = 100;
      if (lines.length > maxLines) {
        const extra = lines.length - maxLines;
        lines = lines.slice(0, maxLines);
        lines.push(`--- [${extra} more symbols, use a smaller file or filter] ---`);
      }
      lines = lines.join('\n');

      const metadata = new Map();
      metadata.set('file', resolvedPath);
      metadata.set('total_symbols', String(result.length));
      metadata.set('language', languageId);

      return ToolResult.ok(lines).withEntries(metadata);
    } catch (e) {
      return ToolResult.err(`Document symbol failed: ${formatError(e)}`);
    }
  }
}
