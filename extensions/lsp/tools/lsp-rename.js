// LSP Rename tool — textDocument/rename

import fs from 'node:fs';
import { LspBaseTool, CompletionKind, SymbolKind, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../core-tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspRenameTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-rename';
  static DESCRIPTION = 'Rename a symbol across the project. Returns the list of files that will be modified with the rename operation.';

  toToolDef() {
    return toolDef(
      LspRenameTool.TOOL_NAME,
      LspRenameTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          file: param('string', 'Path to the file containing the symbol to rename.'),
          line: param('integer', '1-indexed line number.'),
          character: param('integer', '0-indexed character offset (UTF-16).'),
          newName: param('string', 'The new name for the symbol.'),
        },
        required: ['file', 'line', 'character', 'newName'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `rename(${args.file}:${args.line}:${args.character} → ${args.newName})`;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const filePath = args.file;
    const line = args.line;
    const character = args.character;
    const newName = args.newName;

    if (filePath === undefined || filePath === null) {
      return ToolResult.err('file is required');
    }
    if (line === undefined || line === null) {
      return ToolResult.err('line is required');
    }
    if (character === undefined || character === null) {
      return ToolResult.err('character is required');
    }
    if (newName === undefined || newName === null || typeof newName !== 'string') {
      return ToolResult.err('newName is required and must be a string');
    }

    // Resolve path
    const resolvedPath = this._resolvePath(filePath, ctx);

    // Check file exists
    if (!fs.existsSync(resolvedPath)) {
      return ToolResult.err(`File not found: ${resolvedPath}`);
    }

    // Convert 1-indexed line to 0-indexed for LSP server
    const lspLine = line - 1;

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

      // Check server supports rename
      const caps = client.getCapabilities();
      if (!caps?.renameProvider) {
        return ToolResult.err(`Server does not support rename (renameProvider not in capabilities)`);
      }

      // Send rename request
      const edits = await client.request('textDocument/rename', {
        textDocument: { uri },
        position: { line: lspLine, character },
        newName,
      });

      if (!edits || !edits.changes || Object.keys(edits.changes).length === 0) {
        return ToolResult.ok('No rename edits available for this symbol.');
      }

      // Format changes
      const lines = [];
      const changes = edits.changes;
      const totalChanges = Object.values(changes).reduce((sum, arr) => sum + arr.length, 0);

      lines.push(`Rename to '${newName}' — ${totalChanges} change(s) in ${Object.keys(changes).length} file(s):`);
      lines.push('');

      for (const [fileUri, fileEdits] of Object.entries(changes)) {
        const file = this._uriToPath(fileUri);
        lines.push(`  ${file}:`);
        for (const edit of fileEdits) {
          const start = edit.range.start;
          lines.push(`    Line ${start.line + 1}:${start.character + 1} → ${edit.newText || '(empty)'}`);
        }
        lines.push('');
      }

      const metadata = new Map();
      metadata.set('file', resolvedPath);
      metadata.set('position', `${line}:${character}`);
      metadata.set('new_name', newName);
      metadata.set('total_changes', String(totalChanges));
      metadata.set('files_affected', String(Object.keys(changes).length));
      metadata.set('language', languageId);

      return ToolResult.ok(lines.join('\n')).withEntries(metadata);
    } catch (e) {
      return ToolResult.err(`Rename failed: ${formatError(e)}`);
    }
  }
}
