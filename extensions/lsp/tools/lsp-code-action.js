// LSP Code Action tool — textDocument/codeAction

import { LspPositionTool } from './lsp-position-tool.js';
import { ToolResult } from '../../core-tools/registry.js';

export class LspCodeActionTool extends LspPositionTool {
  static TOOL_NAME = 'lsp-code-action';
  static DESCRIPTION = 'Get available code actions (quick fixes, refactoring options) at a given position. Returns actions with titles, descriptions, and edit operations.';
  static LSP_METHOD = 'textDocument/codeAction';
  static REQUIRED_CAPABILITY = 'codeActionProvider';
  static SUCCESS_RESPONSE = 'No code actions available at this position.';

  _buildRequestParams(args, uri, lspLine) {
    return {
      textDocument: { uri },
      range: {
        start: { line: lspLine, character: args.character },
        end: { line: lspLine, character: args.character },
      },
      context: {
        diagnostics: [],
        only: ['quickfix', 'refactor'],
      },
    };
  }

  _formatResult(result, args, resolvedPath, languageId) {
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
  }
}
