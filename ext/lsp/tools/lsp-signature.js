// LSP Signature Help tool — textDocument/signatureHelp

import fs from 'node:fs';
import { LspBaseTool, CompletionKind, SymbolKind, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../../extensions/core-tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspSignatureTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-signature';
  static DESCRIPTION = 'Get signature help (function parameter hints) at a given position. Returns active signature, parameter info, and documentation.';

  toToolDef() {
    return toolDef(
      LspSignatureTool.TOOL_NAME,
      LspSignatureTool.DESCRIPTION,
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
    return `signature(${args.file}:${args.line}:${args.character})`;
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

      // Check server supports signature help
      const caps = client.getCapabilities();
      if (!caps?.signatureHelpProvider) {
        return ToolResult.err(`Server does not support signature help (signatureHelpProvider not in capabilities)`);
      }

      // Send signature help request
      const result = await client.request('textDocument/signatureHelp', {
        textDocument: { uri },
        position: { line: lspLine, character },
      });

      if (!result || !result.signatures || result.signatures.length === 0) {
        return ToolResult.ok('No signature help available at this position.');
      }

      // Format signature help
      const lines = [];
      const activeSig = result.signatures[result.activeSignature ?? 0];

      lines.push(`Active signature: ${result.activeSignature ?? 0}/${result.signatures.length - 1}`);
      lines.push(`Active parameter: ${result.activeParameter ?? 0}/${(activeSig?.parameters?.length ?? 1) - 1}`);
      lines.push('');

      for (let i = 0; i < result.signatures.length; i++) {
        const sig = result.signatures[i];
        const label = sig.label || `${result.signatures.length} signatures available`;
        const isActive = i === (result.activeSignature ?? 0);
        const prefix = isActive ? '>>>' : '   ';

        lines.push(`${prefix} Signature ${i}: ${label}`);

        if (sig.documentation) {
          const doc = typeof sig.documentation === 'string'
            ? sig.documentation
            : sig.documentation?.value || '';
          if (doc) {
            lines.push(`   Doc: ${doc.slice(0, 200)}${doc.length > 200 ? '...' : ''}`);
          }
        }

        if (sig.parameters) {
          for (let j = 0; j < sig.parameters.length; j++) {
            const param = sig.parameters[j];
            const isCurrent = isActive && j === (result.activeParameter ?? 0);
            const pPrefix = isCurrent ? '  > ' : '    ';
            let pText = param.label;
            if (typeof param.label === 'object') {
              // Label with range support
              pText = param.label[0].text;
              if (param.label.length > 1) pText += param.label[1].text;
            }
            const type = param.type ? `: ${param.type}` : '';
            const doc = param.documentation;
            const docText = typeof doc === 'string' ? doc : doc?.value || '';
            lines.push(`${pPrefix}${pText}${type}${docText ? ` — ${docText.slice(0, 100)}` : ''}`);
          }
        }
        lines.push('');
      }

      const metadata = new Map();
      metadata.set('file', resolvedPath);
      metadata.set('position', `${line}:${character}`);
      metadata.set('total_signatures', String(result.signatures.length));
      metadata.set('language', languageId);
      metadata.set('lsp_line', String(lspLine));

      return ToolResult.ok(lines.join('\n')).withEntries(metadata);
    } catch (e) {
      const msg = e.message || String(e);
      if (msg.includes('computePositionOfLineAndCharacter') || msg.includes('Debug Failure')) {
        return ToolResult.err(
          `Language server crashed at this position. ` +
          `Try placing the cursor directly on the symbol name.`
        );
      }
      return ToolResult.err(`Signature help failed: ${formatError(e)}`);
    }
  }
}
