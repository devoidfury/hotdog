// LSP Workspace Symbol tool — workspace/symbol

import { LspQueryTool } from './lsp-position-tool.js';
import { ToolResult } from '../../core-tools/registry.js';
import { SymbolKind } from './base.js';

export class LspWorkspaceSymbolTool extends LspQueryTool {
  static TOOL_NAME = 'lsp-workspace-symbol';
  static DESCRIPTION = 'Search for symbols across the entire workspace. Returns matching symbols with their locations and kinds.';
  static LSP_METHOD = 'workspace/symbol';
  static REQUIRED_CAPABILITY = 'workspaceSymbolProvider';

  _formatResult(result, args, languageId) {
    if (!result || result.length === 0) {
      return ToolResult.ok(`No symbols found matching '${args.query}'.`);
    }

    // Format results
    const lines = result.map((symbol, index) => {
      const kind = SymbolKind[symbol.kind] || 'Unknown';
      const location = this._formatLocation(symbol.location || symbol.range);
      const container = symbol.containerName ? ` (${symbol.containerName})` : '';
      return `  ${index + 1}. ${kind}: ${symbol.name}${container} (${location})`;
    }).join('\n');

    const metadata = new Map();
    metadata.set('query', args.query);
    metadata.set('total_results', String(result.length));
    metadata.set('language', languageId);

    return ToolResult.ok(`Found ${result.length} workspace symbol(s) matching '${args.query}':\n${lines}`).withEntries(metadata);
  }
}
