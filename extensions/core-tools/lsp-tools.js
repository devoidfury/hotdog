// LSP Tools factory — creates and registers LSP tools based on configuration.

import {
  LspClient,
  getServerByLanguageId,
  isLspEnabled,
  getLanguageId,
  lspClientCache,
  getCachedClient,
  deleteCachedClient,
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
} from '../../ext/lsp/index.js';

/**
 * LSP tool definitions — maps tool names to their classes.
 */
const LSP_TOOL_CLASSES = {
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
 * Get all available LSP tool names.
 */
export const LSP_TOOL_NAMES = Object.keys(LSP_TOOL_CLASSES);

/**
 * Get or create an LSP client for a given language.
 * Initializes the client with server config before returning.
 * @param {string} languageId - Language identifier
 * @param {object} lspConfig - LSP configuration
 * @returns {Promise<LspClient|null>}
 */
export async function getOrCreateClient(languageId, lspConfig) {
  // Use cached client if available
  const cached = getCachedClient(languageId);
  if (cached && cached.isReady()) {
    return cached;
  }
  // Client is dead or not found — clear
  if (cached) {
    deleteCachedClient(languageId);
  }

  const serverConfig = getServerByLanguageId(languageId, lspConfig);
  if (!serverConfig) return null;

  const client = new LspClient({
    requestTimeoutMs: serverConfig.timeoutMs || 30000,
    serverStartupTimeoutMs: 60000,
  });

  // Initialize the client with server config
  try {
    await client.initialize({
      command: serverConfig.command,
      args: serverConfig.args || [],
      initializationOptions: serverConfig.initializationOptions,
      rootPath: process.cwd(),
      env: serverConfig.env,
      timeoutMs: serverConfig.timeoutMs,
    });
  } catch (e) {
    console.error(`Failed to initialize LSP client for ${languageId}: ${e.message}`);
    return null;
  }

  lspClientCache.set(languageId, client);
  return client;
}

/**
 * Create an LSP tool instance.
 */
function createLspTool(toolName, ctx, lspConfig) {
  const ToolClass = LSP_TOOL_CLASSES[toolName];
  if (!ToolClass) return null;

  // Determine language ID from context
  let languageId = null;
  if (ctx?.currentFile) {
    languageId = getLanguageId(ctx.currentFile);
  }

  // Get or create client
  const client = getOrCreateClient(languageId, lspConfig);

  return new ToolClass({
    lspClient: client,
    languageId,
    lspConfig,
    maxOutputLines: ctx?.maxOutputLines,
  });
}

/**
 * Initialize LSP tools for a specific file.
 * This will create a client for the file's language if one doesn't exist.
 */
export async function initLspForFile(filePath, lspConfig) {
  if (!isLspEnabled(lspConfig)) return null;

  const languageId = getLanguageId(filePath);
  return getOrCreateClient(languageId, lspConfig);
}

/**
 * Shutdown all LSP clients.
 */
export async function shutdownAllLspClients() {
  const promises = [];
  for (const [languageId, client] of lspClientCache) {
    if (client.isReady()) {
      promises.push(client.shutdown().catch(() => {}));
    }
    lspClientCache.delete(languageId);
  }
  await Promise.all(promises);
}

/**
 * Get the list of LSP tool names that are available for a given file.
 */
export function getAvailableLspTools(filePath, lspConfig) {
  if (!isLspEnabled(lspConfig)) return [];

  const languageId = getLanguageId(filePath);
  const serverConfig = getServerByLanguageId(languageId, lspConfig);

  if (!serverConfig) return [];

  // Return all LSP tool names (they'll fail gracefully if server doesn't support them)
  return [...LSP_TOOL_NAMES];
}

export default {
  LSP_TOOL_NAMES,
  LSP_TOOL_CLASSES,
  createLspTool,
  getOrCreateClient,
  initLspForFile,
  shutdownAllLspClients,
  getAvailableLspTools,
};
