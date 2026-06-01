// LSP Completion tool — textDocument/completion
// Created via factory to reduce boilerplate.

import { ToolResult } from '../../core-tools/registry.js';
import { definePositionTool } from './lsp-position-tool.js';

export const LspCompletionTool = definePositionTool({
  name: 'lsp-completion',
  description:
    'Get auto-completion suggestions at a given position. Returns completion items with labels, kinds, and optional snippets.',
  lspMethod: 'textDocument/completion',
  requiredCapability: 'completionProvider',
  successResponse: 'No completions available at this position.',
  formatResult: (self, result, args, resolvedPath, languageId, lspLine) => {
    const items = Array.isArray(result) ? result : result.items || [];

    if (items.length === 0) {
      return ToolResult.ok('No completions available.');
    }

    const limit = args.limit || 50;
    const display = self._formatCompletions(items, limit);

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
  },
});
