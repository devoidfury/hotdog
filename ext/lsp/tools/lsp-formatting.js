// LSP Formatting tool — textDocument/formatting

import fs from 'node:fs';
import { LspBaseTool, CompletionKind, SymbolKind, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../../extensions/core-tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspFormattingTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-formatting';
  static DESCRIPTION = 'Format an entire document using the language server. Returns the formatted document content or diff.';

  toToolDef() {
    return toolDef(
      LspFormattingTool.TOOL_NAME,
      LspFormattingTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          file: param('string', 'Path to the file to format.'),
        },
        required: ['file'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `format(${args.file})`;
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
      // Read current content
      const currentContent = fs.readFileSync(resolvedPath, 'utf-8');

      // Ensure document is open
      const uri = await this._ensureDocumentOpen(client, resolvedPath, languageId);

      // Check server supports formatting
      const caps = client.getCapabilities();
      if (!caps?.documentFormattingProvider) {
        return ToolResult.err(`Server does not support formatting (documentFormattingProvider not in capabilities)`);
      }

      // Send formatting request
      const edits = await client.request('textDocument/formatting', {
        textDocument: { uri },
        options: {
          tabSize: 2,
          insertSpaces: true,
          trimTrailingWhitespace: true,
          insertFinalNewline: true,
        },
      });

      if (!edits || edits.length === 0) {
        return ToolResult.ok('Document is already properly formatted.');
      }

      // Apply edits to get formatted content
      let newContent = currentContent;
      const changes = [];

      // Sort edits in reverse order to apply from end to start
      const sortedEdits = [...edits].sort((a, b) => {
        const aStart = a.range.start.line * 10000 + (a.range.start.character || 0);
        const bStart = b.range.start.line * 10000 + (b.range.start.character || 0);
        return bStart - aStart;
      });

      for (const edit of sortedEdits) {
        const startOffset = this._offsetAt(uri, edit.range.start, newContent);
        const endOffset = this._offsetAt(uri, edit.range.end, newContent);
        changes.push({
          file: this._uriToPath(uri),
          oldText: newContent.slice(startOffset, endOffset),
          newText: edit.newText || '',
          line: edit.range.start.line + 1,
        });
        newContent = newContent.slice(0, startOffset) + (edit.newText || '') + newContent.slice(endOffset);
      }

      // Build result
      const lines = [];
      lines.push(`Formatted ${edits.length} change(s):`);
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
      metadata.set('total_changes', String(edits.length));
      metadata.set('language', languageId);

      return ToolResult.ok(lines.join('\n')).withEntries(metadata);
    } catch (e) {
      return ToolResult.err(`Formatting failed: ${formatError(e)}`);
    }
  }
}
