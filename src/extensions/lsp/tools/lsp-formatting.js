// LSP Formatting tool — textDocument/formatting
// Created via factory to reduce boilerplate.

import fs from 'node:fs';
import { ToolResult } from '../../../core/tool-registry.js';
import { defineFileTool } from './lsp-position-tool.js';

export const LspFormattingTool = defineFileTool({
  name: 'lsp-formatting',
  description:
    'Format an entire document using the language server. Returns the formatted document content or diff.',
  lspMethod: 'textDocument/formatting',
  requiredCapability: 'documentFormattingProvider',
  successResponse: 'Document is already properly formatted.',
  formatResult: (self, result, args, resolvedPath, languageId) => {
    if (!result || result.length === 0) {
      return ToolResult.ok('Document is already properly formatted.');
    }

    // Read current content
    const currentContent = fs.readFileSync(resolvedPath, 'utf-8');

    // Apply edits to get formatted content
    let newContent = currentContent;
    const changes = [];

    // Sort edits in reverse order to apply from end to start
    const sortedEdits = [...result].sort((a, b) => {
      const aStart = a.range.start.line * 10000 + (a.range.start.character || 0);
      const bStart = b.range.start.line * 10000 + (b.range.start.character || 0);
      return bStart - aStart;
    });

    for (const edit of sortedEdits) {
      const startOffset = self._offsetAt('', edit.range.start, newContent);
      const endOffset = self._offsetAt('', edit.range.end, newContent);
      changes.push({
        file: self._uriToPath(args.uri || `file://${resolvedPath}`),
        oldText: newContent.slice(startOffset, endOffset),
        newText: edit.newText || '',
        line: edit.range.start.line + 1,
      });
      newContent = newContent.slice(0, startOffset) + (edit.newText || '') + newContent.slice(endOffset);
    }

    // Build result
    const lines = [];
    lines.push(`Formatted ${result.length} change(s):`);
    lines.push('');

    for (const change of changes) {
      lines.push(`  Line ${change.line}: ${change.oldText.length} → ${change.newText.length} chars`);
      if (change.oldText !== change.newText) {
        lines.push(`    - ${change.oldText.slice(0, 80)}${change.oldText.length > 80 ? '...' : ''}`);
        lines.push(`    + ${change.newText.slice(0, 80)}${change.newText.length > 80 ? '...' : ''}`);
      }
    }

    const metadata = new Map();
    metadata.set('file', resolvedPath);
    metadata.set('total_changes', String(result.length));
    metadata.set('language', languageId);

    return ToolResult.ok(lines.join('\n')).withEntries(metadata);
  },
});
