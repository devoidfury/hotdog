// LSP References tool — textDocument/references

import fs from 'node:fs';
import { LspBaseTool, CompletionKind, SymbolKind, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../../src/tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspReferencesTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-references';
  static DESCRIPTION = 'Find all usages/references of a symbol at a given position. Returns file paths, line numbers, and context for each reference.';

  toToolDef() {
    return toolDef(
      LspReferencesTool.TOOL_NAME,
      LspReferencesTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          file: param('string', 'Path to the file.'),
          line: param('integer', '1-indexed line number.'),
          character: param('integer', '0-indexed character offset (UTF-16).'),
        },
        required: ['file', 'line', 'character'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `references(${args.file}:${args.line}:${args.character})`;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const filePath = args.file;
    const line = args.line;
    const character = args.character;

    if (filePath === undefined || filePath === null) {
      return ToolResult.err('file is required');
    }
    if (line === undefined || line === null) {
      return ToolResult.err('line is required');
    }
    if (character === undefined || character === null) {
      return ToolResult.err('character is required');
    }

    // Resolve path
    const resolvedPath = this._resolvePath(filePath, ctx);

    // Check file exists
    if (!fs.existsSync(resolvedPath)) {
      return ToolResult.err(`File not found: ${resolvedPath}`);
    }

    // Convert 1-indexed line to 0-indexed for LSP server
    const lspLine = line - 1;
    const posError = this._validatePosition(resolvedPath, lspLine, character);
    if (posError) {
      return ToolResult.err(`Invalid position: ${posError}`);
    }

    // Get language ID and client
    const languageId = this._getLanguageId(resolvedPath);
    const client = await this._getClient(languageId, ctx, this.lspConfig);

    if (!client) {
      return ToolResult.err(
        `No language server configured for '${languageId}'. ` +
        'Configure an LSP server in your profile or defaults.json.'
      );
    }

    try {
      // Ensure document is open
      const uri = await this._ensureDocumentOpen(client, resolvedPath, languageId);

      // Check server supports references
      const caps = client.getCapabilities();
      if (!caps?.referencesProvider) {
        return ToolResult.err(`Server does not support references (referencesProvider not in capabilities)`);
      }

      // Send references request
      const result = await client.request('textDocument/references', {
        textDocument: { uri },
        position: { line: lspLine, character },
        context: { includeDeclaration: false },
      });

      if (!result || result.length === 0) {
        return ToolResult.ok(
          `No references found at ${resolvedPath}:${line}:${character}. ` +
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
      metadata.set('position', `${line}:${character}`);
      metadata.set('total_references', String(result.length));
      metadata.set('language', languageId);
      metadata.set('lsp_line', String(lspLine));

      return ToolResult.ok(`Found ${result.length} reference(s):\n${lines}`).withEntries(metadata);
    } catch (e) {
      // Check for TypeScript server internal errors
      const msg = e.message || String(e);
      if (msg.includes('computePositionOfLineAndCharacter') || msg.includes('Debug Failure')) {
        return ToolResult.err(
          `Language server crashed at this position. ` +
          `This usually means the position is not on a valid identifier. ` +
          `Try placing the cursor directly on the symbol name.`
        );
      }
      return ToolResult.err(`References failed: ${formatError(e)}`);
    }
  }
}
