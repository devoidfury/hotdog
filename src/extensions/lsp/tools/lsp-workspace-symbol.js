// LSP Workspace Symbol tool — workspace/symbol
// Created via factory to reduce boilerplate.

import { ToolResult } from '../../../core/tool-registry.js';
import { SymbolKind } from './base.js';
import { defineQueryTool } from './lsp-position-tool.js';

export const LspWorkspaceSymbolTool = defineQueryTool({
  name: 'lsp-workspace-symbol',
  description:
    'Search for symbols across the entire workspace. Returns matching symbols with their locations and kinds.',
  lspMethod: 'workspace/symbol',
  requiredCapability: 'workspaceSymbolProvider',
  formatResult: (self, result, args, languageId) => {
    if (!result || result.length === 0) {
      return ToolResult.ok(`No symbols found matching '${args.query}'.`);
    }

    // Format results
    const lines = result.map((symbol, index) => {
      const kind = SymbolKind[symbol.kind] || 'Unknown';
      const location = self._formatLocation(symbol.location || symbol.range);
      const container = symbol.containerName ? ` (${symbol.containerName})` : '';
      return `  ${index + 1}. ${kind}: ${symbol.name}${container} (${location})`;
    }).join('\n');

    const metadata = new Map();
    metadata.set('query', args.query);
    metadata.set('total_results', String(result.length));
    metadata.set('language', languageId);

    return ToolResult.ok(`Found ${result.length} workspace symbol(s) matching '${args.query}':\n${lines}`).withEntries(metadata);
  },
});
