// LSP Completion tool — textDocument/completion

import fs from 'node:fs';
import { LspBaseTool, CompletionKind, SymbolKind, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../../src/tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspCompletionTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-completion';
  static DESCRIPTION = 'Get auto-completion suggestions at a given position. Returns completion items with labels, kinds, and optional snippets.';

  toToolDef() {
    return toolDef(
      LspCompletionTool.TOOL_NAME,
      LspCompletionTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          file: param('string', 'Path to the file.'),
          line: param('integer', '1-indexed line number.'),
          character: param('integer', '0-indexed character offset (UTF-16).'),
          limit: param('integer', 'Maximum number of results to return (default: 50).', { minimum: 1, maximum: 500 }),
        },
        required: ['file', 'line', 'character'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `completion(${args.file}:${args.line}:${args.character}, limit=${args.limit || 50})`;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const filePath = args.file;
    const line = args.line;
    const character = args.character;
    const limit = args.limit || 50;

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

      // Check server supports completion
      const caps = client.getCapabilities();
      if (!caps?.completionProvider) {
        return ToolResult.err(`Server does not support completion (completionProvider not in capabilities)`);
      }

      // Send completion request
      const result = await client.request('textDocument/completion', {
        textDocument: { uri },
        position: { line: lspLine, character },
      });

      if (!result) {
        return ToolResult.ok('No completions available at this position.');
      }

      const items = Array.isArray(result) ? result : (result.items || []);

      if (items.length === 0) {
        return ToolResult.ok('No completions available.');
      }

      // Format completions
      const display = this._formatCompletions(items, limit);

      const metadata = new Map();
      metadata.set('file', resolvedPath);
      metadata.set('position', `${line}:${character}`);
      metadata.set('total_items', String(items.length));
      metadata.set('showing', String(Math.min(items.length, limit)));
      metadata.set('language', languageId);

      if (items.length > limit) {
        metadata.set('truncated', 'true');
      }

      return ToolResult.ok(display).withEntries(metadata);
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('computePositionOfLineAndCharacter') || msg.includes('Debug Failure')) {
        return ToolResult.err(
          `Language server crashed at this position. ` +
          `Try placing the cursor directly on the symbol name.`
        );
      }
      return ToolResult.err(`Completion failed: ${formatError(e)}`);
    }
  }
}
