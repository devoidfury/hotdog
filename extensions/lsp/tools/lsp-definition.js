// LSP Definition tool — textDocument/definition

import { LspPositionTool } from './lsp-position-tool.js';
import { ToolResult } from '../../core-tools/registry.js';

export class LspDefinitionTool extends LspPositionTool {
  static TOOL_NAME = 'lsp-definition';
  static DESCRIPTION = 'Find the definition location of a symbol at a given position. Returns file path, line, and character of the definition.';
  static LSP_METHOD = 'textDocument/definition';
  static REQUIRED_CAPABILITY = 'definitionProvider';
  static SUCCESS_RESPONSE = 'No definition found at this position.';

  _formatResult(result, args, resolvedPath, languageId, lspLine) {
    // Handle Location | Location[] | LocationLink[]
    const locations = Array.isArray(result) ? result : [result];
    const lines = locations.map(loc => {
      const file = this._uriToPath(loc.uri);
      let pos;
      if ('targetSelectionRange' in loc) {
        pos = loc.targetSelectionRange?.start;
      } else {
        pos = loc.range?.start;
      }
      return `  ${file}:${(pos?.line ?? 0) + 1}:${(pos?.character ?? 0) + 1}`;
    }).join('\n');

    const metadata = new Map();
    metadata.set('file', resolvedPath);
    metadata.set('position', `${args.line}:${args.character}`);
    metadata.set('locations', String(locations.length));
    metadata.set('language', languageId);
    metadata.set('lsp_line', String(lspLine));

    return ToolResult.ok(`Definition found:\n${lines}`).withEntries(metadata);
  }
}
