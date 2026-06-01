// LSP Extension
// Registers LSP tools (hover, definition, completion, etc.) via the tools:register hook.
// Only activates when LSP is enabled in config.

import { HOOKS } from "../../src/hooks.js";
import { isLspEnabled, getServerByLanguageId } from "./config.js";
import { LspClient } from "./client.js";
import {
  lspClientCache,
  getCachedClient,
  deleteCachedClient,
  shutdownAll,
} from "./client-cache.js";
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

// LSP defaults — canonical values, also declared in extension.json configSchema
const DEFAULT_LSP_ENABLED = false;
const DEFAULT_LSP_MAX_HOVER_LINES = 200;
const DEFAULT_LSP_MAX_COMPLETION_ITEMS = 50;
const DEFAULT_LSP_MAX_SYMBOL_RESULTS = 100;
const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_LSP_SERVER_TIMEOUT_MS = 60000;

// Default LSP server configurations for common languages
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
    timeoutMs: DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    maxOutputLines: 500,
  },
  python: {
    name: "python",
    command: "pyright-langserver",
    args: ["--stdio"],
    filetypes: ["python"],
    timeoutMs: DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    maxOutputLines: 500,
  },
  go: {
    name: "go",
    command: "gopls",
    args: ["serve"],
    filetypes: ["go"],
    timeoutMs: DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    maxOutputLines: 500,
  },
  rust: {
    name: "rust",
    command: "rust-analyzer",
    args: [],
    filetypes: ["rust"],
    timeoutMs: DEFAULT_LSP_REQUEST_TIMEOUT_MS,
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
    console.error(
      `[lsp] Failed to initialize client for ${languageId}: ${e.message}`,
    );
    return null;
  }

  lspClientCache.set(languageId, client);
  return client;
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
  // Get LSP config with fallback to extension defaults
  // Note: extension config params are registered AFTER buildConfig runs,
  // so lspConfig may be undefined. The extension applies its own defaults.
  const rawLspConfig = core.config?.lsp || {};
  const lspConfig = {
    enabled: rawLspConfig.enabled ?? DEFAULT_LSP_ENABLED,
    servers: (rawLspConfig.servers && Object.keys(rawLspConfig.servers).length > 0)
      ? rawLspConfig.servers
      : DEFAULT_LSP_SERVERS,
    maxHoverLines: rawLspConfig.maxHoverLines ?? DEFAULT_LSP_MAX_HOVER_LINES,
    maxCompletionItems: rawLspConfig.maxCompletionItems ?? DEFAULT_LSP_MAX_COMPLETION_ITEMS,
    maxSymbolResults: rawLspConfig.maxSymbolResults ?? DEFAULT_LSP_MAX_SYMBOL_RESULTS,
    requestTimeoutMs: rawLspConfig.requestTimeoutMs ?? DEFAULT_LSP_REQUEST_TIMEOUT_MS,
    serverStartupTimeoutMs: rawLspConfig.serverStartupTimeoutMs ?? DEFAULT_LSP_SERVER_TIMEOUT_MS,
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

      /**
       * Register config params for LSP defaults.
       * These get merged into the base config so tools can access them.
       */
      [HOOKS.CONFIG_PARAMS_REGISTER]: () => [
        {
          key: "lsp",
          description: "LSP (Language Server Protocol) configuration",
          defaults: {
            enabled: DEFAULT_LSP_ENABLED,
            servers: DEFAULT_LSP_SERVERS,
            maxHoverLines: DEFAULT_LSP_MAX_HOVER_LINES,
            maxCompletionItems: DEFAULT_LSP_MAX_COMPLETION_ITEMS,
            maxSymbolResults: DEFAULT_LSP_MAX_SYMBOL_RESULTS,
            requestTimeoutMs: DEFAULT_LSP_REQUEST_TIMEOUT_MS,
            serverStartupTimeoutMs: DEFAULT_LSP_SERVER_TIMEOUT_MS,
          },
        },
      ],
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
