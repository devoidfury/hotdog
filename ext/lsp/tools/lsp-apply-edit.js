// LSP Apply Edit tool — workspace/applyEdit

import fs from 'node:fs';
import { LspBaseTool, CompletionKind, SymbolKind, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../../extensions/core-tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspApplyEditTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-apply-edit';
  static DESCRIPTION = 'Apply a workspace edit (multiple file changes) atomically. Accepts a WorkspaceEdit object with document changes and/or file operations.';

  toToolDef() {
    return toolDef(
      LspApplyEditTool.TOOL_NAME,
      LspApplyEditTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          edit: param('string', 'A JSON string representing a WorkspaceEdit object. Must contain either "documentChanges" (preferred) or "changes". Document changes is an array of TextDocumentEdit objects.'),
        },
        required: ['edit'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const edit = typeof args.edit === 'string' ? JSON.parse(args.edit) : args.edit;
    const docChanges = edit?.documentChanges || edit?.changes || {};
    const totalChanges = Array.isArray(docChanges)
      ? docChanges.reduce((sum, dc) => sum + (dc.edits?.length || 0), 0)
      : Object.values(docChanges).reduce((sum, arr) => sum + arr.length, 0);
    return `applyEdit(${totalChanges} changes)`;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const editInput = args.edit;

    if (editInput === undefined || editInput === null) {
      return ToolResult.err('edit is required');
    }

    // Parse edit object
    let edit;
    try {
      edit = typeof editInput === 'string' ? JSON.parse(editInput) : editInput;
    } catch (e) {
      return ToolResult.err(`Invalid edit JSON: ${e.message}`);
    }

    if (!edit || (!edit.documentChanges && !edit.changes)) {
      return ToolResult.err('Edit must contain either "documentChanges" or "changes"');
    }

    // Get language ID from first document in the edit
    let languageId = 'typescript';
    if (Array.isArray(edit.documentChanges) && edit.documentChanges.length > 0) {
      const firstDoc = edit.documentChanges[0];
      if (firstDoc.textDocument?.uri) {
        languageId = this._getLanguageId(this._uriToPath(firstDoc.textDocument.uri));
      }
    } else if (edit.changes) {
      const firstUri = Object.keys(edit.changes)[0];
      if (firstUri) {
        languageId = this._getLanguageId(this._uriToPath(firstUri));
      }
    }

    const client = await this._getClient(languageId, ctx, this.lspConfig);

    if (!client) {
      return ToolResult.err(
        `No language server configured for '${languageId}'. ` +
        'Configure an LSP server in your profile or defaults.json.'
      );
    }

    try {
      // Check server supports applyEdit
      const caps = client.getCapabilities();
      if (!caps?.workspace?.applyEdit) {
        return ToolResult.err(`Server does not support workspace/applyEdit`);
      }

      // Send applyEdit request
      const result = await client.request('workspace/applyEdit', edit);

      if (!result) {
        return ToolResult.err('Apply edit returned no result.');
      }

      // Format result
      const lines = [];
      lines.push(`Edit applied: ${result.success ? 'success' : 'failure'}`);

      if (result.success) {
        // Count changes
        let totalChanges = 0;
        if (Array.isArray(edit.documentChanges)) {
          totalChanges = edit.documentChanges.reduce((sum, dc) => sum + (dc.edits?.length || 0), 0);
        } else if (edit.changes) {
          totalChanges = Object.values(edit.changes).reduce((sum, arr) => sum + arr.length, 0);
        }
        lines.push(`Total changes: ${totalChanges}`);
      } else {
        lines.push(`Error: ${result.error || 'Unknown error'}`);
      }

      const metadata = new Map();
      metadata.set('success', String(result.success));
      metadata.set('language', languageId);

      return ToolResult.ok(lines.join('\n')).withEntries(metadata);
    } catch (e) {
      return ToolResult.err(`Apply edit failed: ${formatError(e)}`);
    }
  }
}
