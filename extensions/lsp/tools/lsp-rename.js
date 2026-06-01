// LSP Rename tool — textDocument/rename
// Created via factory to reduce boilerplate.

import { ToolResult } from '../../core-tools/registry.js';
import { definePositionTool } from './lsp-position-tool.js';

export const LspRenameTool = definePositionTool({
  name: 'lsp-rename',
  description:
    'Rename a symbol across the project. Returns the list of files that will be modified with the rename operation.',
  lspMethod: 'textDocument/rename',
  requiredCapability: 'renameProvider',
  successResponse: 'No rename edits available for this symbol.',
  formatResult: (self, result, args, resolvedPath, languageId, lspLine) => {
    if (!result || !result.changes || Object.keys(result.changes).length === 0) {
      return ToolResult.ok('No rename edits available for this symbol.');
    }

    // Format changes
    const lines = [];
    const changes = result.changes;
    const totalChanges = Object.values(changes).reduce((sum, arr) => sum + arr.length, 0);

    lines.push(`Rename to '${args.newName}' — ${totalChanges} change(s) in ${Object.keys(changes).length} file(s):`);
    lines.push('');

    for (const [fileUri, fileEdits] of Object.entries(changes)) {
      const file = self._uriToPath(fileUri);
      lines.push(`  ${file}:`);
      for (const edit of fileEdits) {
        const start = edit.range.start;
        lines.push(`    Line ${start.line + 1}:${start.character + 1} → ${edit.newText || '(empty)'}`);
      }
      lines.push('');
    }

    const metadata = new Map();
    metadata.set('file', resolvedPath);
    metadata.set('position', `${args.line}:${args.character}`);
    metadata.set('new_name', args.newName);
    metadata.set('total_changes', String(totalChanges));
    metadata.set('files_affected', String(Object.keys(changes).length));
    metadata.set('language', languageId);

    return ToolResult.ok(lines.join('\n')).withEntries(metadata);
  },
});
