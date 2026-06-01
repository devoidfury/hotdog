// LSP Hover tool — textDocument/hover
// Created via factory to reduce boilerplate.

import { ToolResult } from '../../../core/tool-registry.js';
import { definePositionTool } from './lsp-position-tool.js';

export const LspHoverTool = definePositionTool({
  name: 'lsp-hover',
  description:
    'Get hover information (type, documentation) for a symbol at a given position in a file. Returns function signatures, type information, and documentation comments.',
  lspMethod: 'textDocument/hover',
  requiredCapability: 'hoverProvider',
  successResponse: 'No hover information available at this position.',
  formatResult: (self, result, args, resolvedPath, languageId, lspLine) => {
    const maxLines = 800;
    // Use inherited _formatHover from LspBaseTool
    const formatted = self._formatHover(result, maxLines);

    const metadata = new Map();
    metadata.set('file', resolvedPath);
    metadata.set('position', `${args.line}:${args.character}`);
    metadata.set('language', languageId);
    metadata.set('lsp_line', String(lspLine));

    return ToolResult.ok(formatted).withEntries(metadata);
  },
});
