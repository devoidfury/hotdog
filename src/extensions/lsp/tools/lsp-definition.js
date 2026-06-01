// LSP Definition tool — textDocument/definition
// Created via factory to reduce boilerplate.

import { ToolResult } from '../../../core/extensions/tool-utils.js';
import { definePositionTool } from './lsp-position-tool.js';

export const LspDefinitionTool = definePositionTool({
  name: 'lsp-definition',
  description:
    'Find the definition location of a symbol at a given position. Returns file path, line, and character of the definition.',
  lspMethod: 'textDocument/definition',
  requiredCapability: 'definitionProvider',
  successResponse: 'No definition found at this position.',
  formatResult: (self, result, args, resolvedPath, languageId, lspLine) => {
    // Handle Location | Location[] | LocationLink[]
    const locations = Array.isArray(result) ? result : [result];
    const lines = locations.map((loc) => {
      const file = self._uriToPath(loc.uri);
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
  },
});
