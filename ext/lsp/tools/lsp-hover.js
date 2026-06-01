// LSP Hover tool — textDocument/hover

import path from 'node:path';
import fs from 'node:fs';
import { LspBaseTool, CompletionKind, SymbolKind, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../../extensions/core-tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspHoverTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-hover';
  static DESCRIPTION = 'Get hover information (type, documentation) for a symbol at a given position in a file. Returns function signatures, type information, and documentation comments.';

  toToolDef() {
    return toolDef(
      LspHoverTool.TOOL_NAME,
      LspHoverTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          file: param('string', 'Path to the file.'),
          line: param('integer', '1-indexed line number.'),
          character: param('integer', '0-indexed character offset (UTF-16).'),
        },
        required: ['file', 'line', 'character'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `hover(${args.file}:${args.line}:${args.character})`;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const filePath = args.file;
    const line = args.line;
    const character = args.character;

    if (filePath === undefined || filePath === null) {
      return ToolResult.err('file is required');
    }
    if (line === undefined || line === null) {
      return ToolResult.err('line is required');
    }
    if (character === undefined || character === null) {
      return ToolResult.err('character is required');
    }

    // Resolve path
    const resolvedPath = this._resolvePath(filePath, ctx);

    // Check file exists
    if (!fs.existsSync(resolvedPath)) {
      return ToolResult.err(`File not found: ${resolvedPath}`);
    }

    // Convert 1-indexed line to 0-indexed for LSP server
    const lspLine = line - 1;
    const posError = this._validatePosition(resolvedPath, lspLine, character);
    if (posError) {
      return ToolResult.err(`Invalid position: ${posError}`);
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

      // Check server supports hover
      const caps = client.getCapabilities();
      if (!caps?.hoverProvider) {
        return ToolResult.err(`Server does not support hover (hoverProvider not in capabilities)`);
      }

      // Send hover request
      const result = await client.request('textDocument/hover', {
        textDocument: { uri },
        position: { line: lspLine, character },
      });

      // Format result
      const maxLines = this.maxOutputLines || 800;
      const formatted = this._formatHover(result, maxLines);

      const metadata = new Map();
      metadata.set('file', resolvedPath);
      metadata.set('position', `${line}:${character}`);
      metadata.set('language', languageId);
      metadata.set('lsp_line', String(lspLine));

      return ToolResult.ok(formatted).withEntries(metadata);
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('computePositionOfLineAndCharacter') || msg.includes('Debug Failure')) {
        return ToolResult.err(
          `Language server crashed at this position. ` +
          `Try placing the cursor directly on the symbol name.`
        );
      }
      return ToolResult.err(`Hover failed: ${formatError(e)}`);
    }
  }
}
