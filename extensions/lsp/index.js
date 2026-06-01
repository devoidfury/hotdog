// LSP Extension
// Registers LSP tools (hover, definition, completion, etc.) via the tools:register hook.
// Only activates when LSP is enabled in config.

import { HOOKS } from '../../src/hooks.js';
import { isLspEnabled, getServerByLanguageId } from './config.js';
import { getLanguageId } from './utils.js';
import { LspClient, LspError } from './client.js';
import {
  lspClientCache,
  getCachedClient,
  deleteCachedClient,
  shutdownAll,
} from './client-cache.js';
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
} from './tools/index.js';

// LSP tool class map — maps tool names to their classes
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

export const LSP_TOOL_NAMES = Object.keys(LSP_TOOL_MAP);
export { LSP_TOOL_MAP };

/**
 * Get or create an LSP client for a given language.
 */
async function getOrCreateClient(languageId, lspConfig) {
  const cached = getCachedClient(languageId);
  if (cached && cached.isReady()) {
    return cached;
  }
  if (cached) {
    deleteCachedClient(languageId);
  }

  const serverConfig = getServerByLanguageId(languageId, lspConfig);
  if (!serverConfig) return null;

  const client = new LspClient({
    requestTimeoutMs: serverConfig.timeoutMs || 30000,
    serverStartupTimeoutMs: 60000,
  });

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
    console.error(`[lsp] Failed to initialize client for ${languageId}: ${e.message}`);
    return null;
  }

  lspClientCache.set(languageId, client);
  return client;
}

/**
 * Create an LSP tool instance.
 */
function createLspTool(toolName, ctx, lspConfig) {
  const ToolClass = LSP_TOOL_MAP[toolName];
  if (!ToolClass) return null;

  let languageId = null;
  const currentFile = ctx?.get('currentFile');
  if (currentFile) {
    languageId = getLanguageId(currentFile);
  }

  return new ToolClass({
    languageId,
    lspConfig,
  });
}

/**
 * Create the LSP extension.
 */
export function create(core) {
  const lspConfig = core.config?.lsp;
  if (!isLspEnabled(lspConfig)) {
    return null; // Don't load if LSP is disabled
  }

  return {
    hooks: {
      /**
       * Mount LSP config on the shared context container.
       */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx }) => {
        toolCtx.set('lspConfig', lspConfig);
      },

      /**
       * Register LSP tools when requested.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        if (!isLspEnabled(lspConfig)) return;

        for (const toolName of LSP_TOOL_NAMES) {
          try {
            const tool = createLspTool(toolName, { lspConfig }, lspConfig);
            if (tool) {
              registry.register(toolName, tool);
            }
          } catch (e) {
            console.error(`[lsp] Failed to create tool '${toolName}': ${e.message}`);
          }
        }
      },

      /**
       * Clean up LSP clients on shutdown.
       */
      [HOOKS.SHUTDOWN_CLEANUP]: async () => {
        await shutdownAll();
      },
    },

    // Expose for external use
    LSP_TOOL_NAMES,
    LSP_TOOL_MAP,

    /**
     * Get or create an LSP client.
     */
    getOrCreateClient,

    /**
     * Shutdown all LSP clients.
     */
    async shutdown() {
      await shutdownAll();
    },
  };
}

// Re-export for backward compatibility
export { LspClient, LspError, lspClientCache, getCachedClient, deleteCachedClient, shutdownAll };
export { getServerByLanguageId, getServerForFile, isLspEnabled } from './config.js';
export { getLanguageId, estimateLspTokenCount, truncateLines, safeStringify } from './utils.js';

// Re-export LSP tool classes
export {
  LspHoverTool, LspDefinitionTool, LspCompletionTool, LspSignatureTool,
  LspDocumentSymbolTool, LspReferencesTool, LspCodeActionTool,
  LspFormattingTool, LspRenameTool, LspDiagnosticsTool,
  LspWorkspaceSymbolTool, LspApplyEditTool,
};

// Re-export base classes for extension authors
export {
  LspPositionTool,
  LspFileTool,
  LspQueryTool,
  LspBaseTool,
  // Factory functions for creating new LSP tools
  definePositionTool,
  createLspPositionTool,
  defineFileTool,
  createLspFileTool,
  defineQueryTool,
  createLspQueryTool,
} from './tools/index.js';
