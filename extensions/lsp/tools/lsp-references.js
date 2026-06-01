// LSP References tool — textDocument/references

import { LspPositionTool } from './lsp-position-tool.js';
import { ToolResult } from '../../core-tools/registry.js';

export class LspReferencesTool extends LspPositionTool {
  static TOOL_NAME = 'lsp-references';
  static DESCRIPTION = 'Find all usages/references of a symbol at a given position. Returns file paths, line numbers, and context for each reference.';
  static LSP_METHOD = 'textDocument/references';
  static REQUIRED_CAPABILITY = 'referencesProvider';
  static SUCCESS_RESPONSE = null;

  _buildRequestParams(args, uri, lspLine) {
    return {
      textDocument: { uri },
      position: { line: lspLine, character: args.character },
      context: { includeDeclaration: false },
    };
  }

  _formatResult(result, args, resolvedPath, languageId, lspLine) {
    if (!result || result.length === 0) {
      return ToolResult.ok(
        `No references found at ${resolvedPath}:${args.line}:${args.character}. ` +
        'Make sure the position is on a valid identifier.'
      );
    }

    // Format references
    const lines = result.map((ref, index) => {
      const file = this._uriToPath(ref.uri);
      const start = ref.range?.start;
      return `  ${index + 1}. ${file}:${start?.line + 1 ?? 0}:${start?.character + 1 ?? 0}`;
    }).join('\n');

    const metadata = new Map();
    metadata.set('file', resolvedPath);
    metadata.set('position', `${args.line}:${args.character}`);
    metadata.set('total_references', String(result.length));
    metadata.set('language', languageId);
    metadata.set('lsp_line', String(lspLine));

    return ToolResult.ok(`Found ${result.length} reference(s):\n${lines}`).withEntries(metadata);
  }
}
