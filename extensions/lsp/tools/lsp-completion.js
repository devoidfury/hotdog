// LSP Completion tool — textDocument/completion

import { LspPositionTool } from './lsp-position-tool.js';
import { ToolResult } from '../../core-tools/registry.js';

export class LspCompletionTool extends LspPositionTool {
  static TOOL_NAME = 'lsp-completion';
  static DESCRIPTION = 'Get auto-completion suggestions at a given position. Returns completion items with labels, kinds, and optional snippets.';
  static LSP_METHOD = 'textDocument/completion';
  static REQUIRED_CAPABILITY = 'completionProvider';
  static SUCCESS_RESPONSE = 'No completions available at this position.';

  // Extend base PARAMS with the limit parameter
  static PARAMS = {
    ...LspPositionTool.PARAMS,
    limit: { type: 'integer', description: 'Maximum number of results to return (default: 50).', minimum: 1, maximum: 500 },
  };

  _buildRequestParams(args, uri, lspLine) {
    const params = super._buildRequestParams(args, uri, lspLine);
    if (args.limit) {
      params.context = { includeCompletionsWithInsertText: true };
    }
    return params;
  }

  _formatResult(result, args, resolvedPath, languageId, lspLine) {
    const items = Array.isArray(result) ? result : (result.items || []);

    if (items.length === 0) {
      return ToolResult.ok('No completions available.');
    }

    const limit = args.limit || 50;
    const display = this._formatCompletions(items, limit);

    const metadata = new Map();
    metadata.set('file', resolvedPath);
    metadata.set('position', `${args.line}:${args.character}`);
    metadata.set('total_items', String(items.length));
    metadata.set('showing', String(Math.min(items.length, limit)));
    metadata.set('language', languageId);

    if (items.length > limit) {
      metadata.set('truncated', 'true');
    }

    return ToolResult.ok(display).withEntries(metadata);
  }
}
