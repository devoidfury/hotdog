// LSP Diagnostics tool — textDocument/publishDiagnostics

import { LspFileTool } from './lsp-position-tool.js';
import { ToolResult } from '../../core-tools/registry.js';
import { DiagnosticSeverity } from './base.js';

export class LspDiagnosticsTool extends LspFileTool {
  static TOOL_NAME = 'lsp-diagnostics';
  static DESCRIPTION = 'Get diagnostics (errors, warnings, hints) for a document. Returns all reported issues with their severity, message, and location.';
  static LSP_METHOD = null; // Diagnostics come from publishDiagnostics notification, not a request
  static REQUIRED_CAPABILITY = 'publishDiagnostics';
  static SUCCESS_RESPONSE = null;

  // Override execute to handle diagnostics specially (they come from notifications, not requests)
  async execute(input, ctx) {
    const { resolvedPath, languageId, client, args, uri, error } = await this._prepareAndValidate(input, ctx);
    if (error) return error;

    try {
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
        const fs = require('node:fs');
        const content = fs.readFileSync(resolvedPath, 'utf-8');
        await client.didChange(uri, content);
      } catch {
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
      return ToolResult.err(`Diagnostics failed: ${e.message || String(e)}`);
    }
  }

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
