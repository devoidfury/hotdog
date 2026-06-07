// LSP Extension
// Registers LSP tools (hover, definition, completion, etc.) via the tools:register hook.
// Only activates when LSP is enabled in config.
//
// Config defaults are defined in extension.json configSchema.

import extensionData from "./extension.json";
import { HOOKS } from "../../core/hooks.js";
import { isLspEnabled } from "./config.js";
import {
  getCachedClient,
  deleteCachedClient,
  shutdownAll,
} from "./client-cache.js";
import { getOrCreateLspClient } from "./client-utils.js";
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
} from "./tools/index.js";

// Default LSP server configurations for common languages
// Note: These are not in extension.json because they are runtime defaults,
// not user-configurable settings. Users can override via lsp.servers config.
const DEFAULT_LSP_SERVERS = {
  typescript: {
    name: "typescript",
    command: "typescript-language-server",
    args: ["--stdio"],
    filetypes: [
      "typescript",
      "javascript",
      "typescriptreact",
      "javascriptreact",
    ],
    timeoutMs: 30000,
    maxOutputLines: 500,
  },
  python: {
    name: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    filetypes: ["python"],
    timeoutMs: 30000,
    maxOutputLines: 500,
  },
  go: {
    name: "go",
    command: "gopls",
    args: ["serve"],
    filetypes: ["go"],
    timeoutMs: 30000,
    maxOutputLines: 500,
  },
  rust: {
    name: "rust",
    command: "rust-analyzer",
    args: [],
    filetypes: ["rust"],
    timeoutMs: 30000,
    maxOutputLines: 500,
  },
};

// LSP tool class map — maps tool names to their classes
const LSP_TOOL_MAP = {
  "lsp-hover": LspHoverTool,
  "lsp-definition": LspDefinitionTool,
  "lsp-completion": LspCompletionTool,
  "lsp-signature": LspSignatureTool,
  "lsp-document-symbol": LspDocumentSymbolTool,
  "lsp-references": LspReferencesTool,
  "lsp-code-action": LspCodeActionTool,
  "lsp-formatting": LspFormattingTool,
  "lsp-rename": LspRenameTool,
  "lsp-diagnostics": LspDiagnosticsTool,
  "lsp-workspace-symbol": LspWorkspaceSymbolTool,
  "lsp-apply-edit": LspApplyEditTool,
};

export const LSP_TOOL_NAMES = Object.keys(LSP_TOOL_MAP);
export { LSP_TOOL_MAP };

/**
 * Get or create an LSP client for a given language.
 * Delegates to shared client-utils utility.
 */
async function getOrCreateClient(languageId, lspConfig) {
  return getOrCreateLspClient(languageId, lspConfig);
}

/**
 * Create an LSP tool instance.
 */
function createLspTool(toolName, lspConfig) {
  const ToolClass = LSP_TOOL_MAP[toolName];
  if (!ToolClass) return null;

  return new ToolClass({
    languageId: null,
    lspConfig,
  });
}

/**
 * Create the LSP extension.
 */
export function create(core) {
  // Get LSP config with fallback to extension defaults from configSchema
  const rawLspConfig = core.config?.lsp || {};
  const cs = extensionData.configSchema.properties;
  const lspConfig = {
    enabled: rawLspConfig.enabled ?? cs.enabled.default,
    servers:
      rawLspConfig.servers && Object.keys(rawLspConfig.servers).length > 0
        ? rawLspConfig.servers
        : DEFAULT_LSP_SERVERS,
    maxHoverLines: rawLspConfig.maxHoverLines ?? cs.maxHoverLines.default,
    maxCompletionItems: rawLspConfig.maxCompletionItems ?? cs.maxCompletionItems.default,
    maxSymbolResults: rawLspConfig.maxSymbolResults ?? cs.maxSymbolResults.default,
    requestTimeoutMs: rawLspConfig.requestTimeoutMs ?? cs.requestTimeoutMs.default,
    serverStartupTimeoutMs: rawLspConfig.serverStartupTimeoutMs ?? cs.serverStartupTimeoutMs.default,
  };

  if (!isLspEnabled(lspConfig)) {
    return null; // Don't load if LSP is disabled
  }

  return {
    hooks: {
      /**
       * Mount LSP config on the shared context container.
       */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ toolCtx }) => {
        toolCtx.set("lspConfig", lspConfig);
      },

      /**
       * Register LSP tools when requested.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        if (!isLspEnabled(lspConfig)) return;

        for (const toolName of LSP_TOOL_NAMES) {
          try {
            const tool = createLspTool(toolName, lspConfig);
            if (tool) {
              registry.register(toolName, tool);
            }
          } catch (e) {
            console.error(
              `[lsp] Failed to create tool '${toolName}': ${e.message}`,
            );
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
