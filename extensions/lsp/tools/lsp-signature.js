// LSP Signature Help tool — textDocument/signatureHelp

import { LspPositionTool } from './lsp-position-tool.js';
import { ToolResult } from '../../core-tools/registry.js';

export class LspSignatureTool extends LspPositionTool {
  static TOOL_NAME = 'lsp-signature';
  static DESCRIPTION = 'Get signature help (function parameter hints) at a given position. Returns active signature, parameter info, and documentation.';
  static LSP_METHOD = 'textDocument/signatureHelp';
  static REQUIRED_CAPABILITY = 'signatureHelpProvider';
  static SUCCESS_RESPONSE = 'No signature help available at this position.';

  _formatResult(result, args, resolvedPath, languageId, lspLine) {
    if (!result || !result.signatures || result.signatures.length === 0) {
      return ToolResult.ok('No signature help available at this position.');
    }

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
    metadata.set('position', `${args.line}:${args.character}`);
    metadata.set('total_signatures', String(result.signatures.length));
    metadata.set('language', languageId);
    metadata.set('lsp_line', String(lspLine));

    return ToolResult.ok(lines.join('\n')).withEntries(metadata);
  }
}
