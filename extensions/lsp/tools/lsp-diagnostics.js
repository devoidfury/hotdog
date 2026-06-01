// LSP Diagnostics tool — textDocument/publishDiagnostics

import fs from 'node:fs';
import { LspBaseTool, DiagnosticSeverity } from './base.js';
import { toolDef, param, ToolResult } from '../../core-tools/registry.js';
import { formatError } from '../../../src/context/error.js';

export class LspDiagnosticsTool extends LspBaseTool {
  static TOOL_NAME = 'lsp-diagnostics';
  static DESCRIPTION = 'Get diagnostics (errors, warnings, hints) for a document. Returns all reported issues with their severity, message, and location.';

  toToolDef() {
    return toolDef(
      LspDiagnosticsTool.TOOL_NAME,
      LspDiagnosticsTool.DESCRIPTION,
      {
        schema: 'https://json-schema.org/draft/2020-12/schema',
        properties: {
          file: param('string', 'Path to the file.'),
        },
        required: ['file'],
      }
    );
  }

  callDisplay(input) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `diagnostics(${args.file})`;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const filePath = args.file;

    if (filePath === undefined || filePath === null) {
      return ToolResult.err('file is required');
    }

    // Resolve path
    const resolvedPath = this._resolvePath(filePath, ctx);

    // Check file exists
    if (!fs.existsSync(resolvedPath)) {
      return ToolResult.err(`File not found: ${resolvedPath}`);
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

      // Check server supports diagnostics
      const caps = client.getCapabilities();
      const hasDiagnostics = !!(caps?.publishDiagnostics || caps?.diagnosticProvider);

      if (!hasDiagnostics) {
        return ToolResult.ok(
          `Language server does not publish diagnostics. ` +
          `Hover and other capabilities are available.`
        );
      }

      // Send didChange to trigger re-analysis
      try {
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        await client.didChange(uri, content);
      } catch (e) {
        // Non-fatal — document may not have changed
      }

      // Wait briefly for diagnostics to be published
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Get cached diagnostics
      const diagnostics = client.getDiagnostics(uri);

      if (!diagnostics || diagnostics.length === 0) {
        return ToolResult.ok('No diagnostics for this file.');
      }

      // Format diagnostics
      const maxItems = this.lspConfig?.maxDiagnostics || 100;
      const formatted = this._formatDiagnostics(diagnostics, maxItems);

      const metadata = new Map();
      metadata.set('file', resolvedPath);
      metadata.set('language', languageId);
      metadata.set('total_diagnostics', String(diagnostics.length));

      const errors = diagnostics.filter(d => d.severity === 1);
      const warnings = diagnostics.filter(d => d.severity === 2);
      metadata.set('errors', String(errors.length));
      metadata.set('warnings', String(warnings.length));

      return ToolResult.ok(formatted).withEntries(metadata);
    } catch (e) {
      return ToolResult.err(`Diagnostics failed: ${formatError(e)}`);
    }
  }

  /**
   * Format diagnostics for display.
   * @param {object[]} diagnostics - LSP diagnostics
   * @param {number} [maxItems] - Maximum items to display
   * @returns {string}
   */
  _formatDiagnostics(diagnostics, maxItems) {
    if (!diagnostics || diagnostics.length === 0) return 'No diagnostics.';

    const limit = maxItems || diagnostics.length;
    const display = diagnostics.slice(0, limit).map((diag, index) => {
      const severity = DiagnosticSeverity[diag.severity] || 'Unknown';
      const source = diag.source ? `[${diag.source}] ` : '';
      const location = this._formatLocation({
        uri: diag.uri,
        range: diag.range,
      });
      return `  ${index + 1}. ${severity}: ${source}${diag.message} (${location})`;
    }).join('\n');

    const remaining = diagnostics.length - limit;
    return remaining > 0
      ? `${display}\n--- [${remaining} more diagnostics not shown] ---`
      : display;
  }
}
