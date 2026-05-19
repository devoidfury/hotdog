// ext/lsp/index.js — LSP Extension Entry Point
// Provides a clean API for the core codebase to interact with LSP functionality.

// Re-export core classes
export { LspClient, LspError } from './client.js';

// Re-export the cache (shared state)
export { lspClientCache, getCachedClient, setCachedClient, deleteCachedClient, clearCache, getAllClients, shutdownAll } from './client-cache.js';

// Re-export config utilities
export { getServerByLanguageId, getServerForFile, isLspEnabled } from './config.js';

// Re-export utilities
export { getLanguageId, pathToUri, uriToPath, estimateLspTokenCount, truncateLines, safeStringify } from './utils.js';

// Re-export all LSP tool classes
import {
  LspHoverTool,
  LspDefinitionTool,
  LspCompletionTool,
  LspSignatureTool,
  LspDocumentSymbolTool,
  LspReferencesTool,
  LspCodeActionTool,
  LspFormattingTool,
  LspRenameTool,
  LspDiagnosticsTool,
  LspWorkspaceSymbolTool,
  LspApplyEditTool,
  LspBaseTool,
  CompletionKind,
  SymbolKind,
  DiagnosticSeverity,
} from './tools/index.js';

export {
  LspHoverTool,
  LspDefinitionTool,
  LspCompletionTool,
  LspSignatureTool,
  LspDocumentSymbolTool,
  LspReferencesTool,
  LspCodeActionTool,
  LspFormattingTool,
  LspRenameTool,
  LspDiagnosticsTool,
  LspWorkspaceSymbolTool,
  LspApplyEditTool,
  LspBaseTool,
  CompletionKind,
  SymbolKind,
  DiagnosticSeverity,
};

// LSP tool class map for conditional registration
const LSP_TOOL_MAP = {
  'lsp-hover': LspHoverTool,
  'lsp-definition': LspDefinitionTool,
  'lsp-completion': LspCompletionTool,
  'lsp-signature': LspSignatureTool,
  'lsp-document-symbol': LspDocumentSymbolTool,
  'lsp-references': LspReferencesTool,
  'lsp-code-action': LspCodeActionTool,
  'lsp-formatting': LspFormattingTool,
  'lsp-rename': LspRenameTool,
  'lsp-diagnostics': LspDiagnosticsTool,
  'lsp-workspace-symbol': LspWorkspaceSymbolTool,
  'lsp-apply-edit': LspApplyEditTool,
};

/**
 * Get the list of LSP tool names.
 */
export const LSP_TOOL_NAMES = Object.keys(LSP_TOOL_MAP);

/**
 * Create an LSP tool instance with proper client setup.
 * @param {string} toolName - Tool name
 * @param {object} ctx - Tool context
 * @param {object} lspConfig - LSP configuration
 * @returns {object|null} Tool instance or null
 */
function createLspInstance(toolName, ctx, lspConfig) {
  const ToolClass = LSP_TOOL_MAP[toolName];
  if (!ToolClass) return null;

  let languageId = null;
  if (ctx?.currentFile) {
    languageId = getLanguageId(ctx.currentFile);
  }

  return new ToolClass({
    languageId,
    lspConfig,
  });
}

/**
 * Register all LSP tools with a registry when LSP is enabled.
 * Factory method that creates and registers all LSP tools.
 * Returns the number of tools registered (0 if LSP is disabled or no server configured).
 *
 * @param {object} registry - The tool registry to register tools with
 * @param {object} ctx - Tool context (provides lspConfig, currentFile, etc.)
 * @returns {Promise<number>} Number of tools registered
 */
export async function registerLspTools(registry, ctx) {
  const lspConfig = ctx?.lspConfig || null;
  if (!isLspEnabled(lspConfig)) {
    return 0;
  }

  let registered = 0;

  for (const toolName of LSP_TOOL_NAMES) {
    const tool = createLspInstance(toolName, ctx, lspConfig);
    if (tool) {
      registry.register(toolName, tool);
      registered++;
    }
  }

  return registered;
}
