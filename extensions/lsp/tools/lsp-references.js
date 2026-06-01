// LSP References tool — textDocument/references
// Created via factory to reduce boilerplate.

import { ToolResult } from '../../core-tools/registry.js';
import { definePositionTool } from './lsp-position-tool.js';

export const LspReferencesTool = definePositionTool({
  name: 'lsp-references',
  description:
    'Find all usages/references of a symbol at a given position. Returns file paths, line numbers, and context for each reference.',
  lspMethod: 'textDocument/references',
  requiredCapability: 'referencesProvider',
  successResponse: null,
  formatResult: (self, result, args, resolvedPath, languageId, lspLine) => {
    if (!result || result.length === 0) {
      return ToolResult.ok(
        `No references found at ${resolvedPath}:${args.line}:${args.character}. ` +
          'Make sure the position is on a valid identifier.',
      );
    }

    // Format references
    const lines = result.map((ref, index) => {
      const file = self._uriToPath(ref.uri);
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
  },
});
