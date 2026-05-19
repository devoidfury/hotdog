// LSP Workspace Symbol tool — workspace/symbol

import { LspBaseTool, CompletionKind, SymbolKind, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../../src/tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspWorkspaceSymbolTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-workspace-symbol';
  static DESCRIPTION = 'Search for symbols across the entire workspace. Returns matching symbols with their locations and kinds.';

  toToolDef() {
    return toolDef(
      LspWorkspaceSymbolTool.TOOL_NAME,
      LspWorkspaceSymbolTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          query: param('string', 'Search query string. Empty string returns all symbols.'),
        },
        required: ['query'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `workspaceSymbol('${args.query || ''}')`;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const query = args.query;

    if (query === undefined || query === null) {
      return ToolResult.err('query is required');
    }

    // Get language ID from workspace root or current file
    const languageId = ctx?.currentFile
      ? this._getLanguageId(ctx.currentFile)
      : 'typescript'; // Default to TypeScript

    const client = await this._getClient(languageId, ctx, this.lspConfig);

    if (!client) {
      return ToolResult.err(
        `No language server configured for '${languageId}'. ` +
        'Configure an LSP server in your profile or defaults.json.'
      );
    }

    try {
      // Check server supports workspace symbols
      const caps = client.getCapabilities();
      if (!caps?.workspaceSymbolProvider) {
        return ToolResult.err(`Server does not support workspace symbols (workspaceSymbolProvider not in capabilities)`);
      }

      // Send workspace symbol request
      const result = await client.request('workspace/symbol', {
        query,
      });

      if (!result || result.length === 0) {
        return ToolResult.ok(`No symbols found matching '${query}'.`);
      }

      // Format results
      const lines = result.map((symbol, index) => {
        const kind = SymbolKind[symbol.kind] || 'Unknown';
        const location = this._formatLocation(symbol.location || symbol.range);
        const container = symbol.containerName ? ` (${symbol.containerName})` : '';
        return `  ${index + 1}. ${kind}: ${symbol.name}${container} (${location})`;
      }).join('\n');

      const metadata = new Map();
      metadata.set('query', query);
      metadata.set('total_results', String(result.length));
      metadata.set('language', languageId);

      return ToolResult.ok(`Found ${result.length} workspace symbol(s) matching '${query}':\n${lines}`).withEntries(metadata);
    } catch (e) {
      return ToolResult.err(`Workspace symbol search failed: ${formatError(e)}`);
    }
  }
}
