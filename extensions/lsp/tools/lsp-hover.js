// LSP Hover tool — textDocument/hover

import { LspPositionTool } from './lsp-position-tool.js';
import { ToolResult } from '../../core-tools/registry.js';

export class LspHoverTool extends LspPositionTool {
  static TOOL_NAME = 'lsp-hover';
  static DESCRIPTION = 'Get hover information (type, documentation) for a symbol at a given position in a file. Returns function signatures, type information, and documentation comments.';
  static LSP_METHOD = 'textDocument/hover';
  static REQUIRED_CAPABILITY = 'hoverProvider';
  static SUCCESS_RESPONSE = 'No hover information available at this position.';

  _formatResult(result, args, resolvedPath, languageId, lspLine) {
    const maxLines = this.maxOutputLines || 800;
    const formatted = this._formatHover(result, maxLines);

    const metadata = new Map();
    metadata.set('file', resolvedPath);
    metadata.set('position', `${args.line}:${args.character}`);
    metadata.set('language', languageId);
    metadata.set('lsp_line', String(lspLine));

    return ToolResult.ok(formatted).withEntries(metadata);
  }
}
