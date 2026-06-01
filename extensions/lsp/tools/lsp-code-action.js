// LSP Code Action tool — textDocument/codeAction
// Created via factory to reduce boilerplate.

import { ToolResult } from '../../core-tools/registry.js';
import { definePositionTool } from './lsp-position-tool.js';

export const LspCodeActionTool = definePositionTool({
  name: 'lsp-code-action',
  description:
    'Get available code actions (quick fixes, refactoring options) at a given position. Returns actions with titles, descriptions, and edit operations.',
  lspMethod: 'textDocument/codeAction',
  requiredCapability: 'codeActionProvider',
  successResponse: 'No code actions available at this position.',
  formatResult: (self, result, args, resolvedPath, languageId) => {
    if (!result || result.length === 0) {
      return ToolResult.ok('No code actions available at this position.');
    }

    // Format code actions
    const lines = result
      .map((action, index) => {
        const title = action.title || action.command?.title || 'Untitled';
        const kind = action.kind ? ` [${action.kind}]` : '';
        const edit = action.edit ? ' [has edit]' : '';
        const command = action.command ? ' [has command]' : '';
        return `  ${index + 1}. ${title}${kind}${edit}${command}`;
      })
      .join('\n');

    const metadata = new Map();
    metadata.set('file', resolvedPath);
    metadata.set('position', `${args.line}:${args.character}`);
    metadata.set('total_actions', String(result.length));
    metadata.set('language', languageId);

    return ToolResult.ok(`Found ${result.length} code action(s):\n${lines}`).withEntries(metadata);
  },
});
