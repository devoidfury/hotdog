// LSP configuration — server configs, defaults, and resolution.

import { getLanguageId } from "./utils.js";
import {
  DEFAULT_LSP_SERVERS,
  DEFAULT_LSP_ENABLED,
  DEFAULT_LSP_MAX_HOVER_LINES,
  DEFAULT_LSP_MAX_COMPLETION_ITEMS,
  DEFAULT_LSP_MAX_SYMBOL_RESULTS,
  DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  DEFAULT_LSP_SERVER_TIMEOUT_MS,
} from "../../src/config.js";

/**
 * Default LSP server configurations
 */
export { DEFAULT_LSP_SERVERS } from "../../src/config.js";

/**
 * Default LSP settings.
 */
export const DEFAULT_LSP_CONFIG = {
  enabled: DEFAULT_LSP_ENABLED,
  defaultServers: DEFAULT_LSP_SERVERS,
  servers: {},
  documentSyncKind: "full", // 'full' or 'incremental'
  maxHoverLines: DEFAULT_LSP_MAX_HOVER_LINES,
  maxCompletionItems: DEFAULT_LSP_MAX_COMPLETION_ITEMS,
  maxSymbolResults: DEFAULT_LSP_MAX_SYMBOL_RESULTS,
  maxDiagnostics: 100,
  requestTimeoutMs: DEFAULT_LSP_REQUEST_TIMEOUT_MS,
  serverStartupTimeoutMs: DEFAULT_LSP_SERVER_TIMEOUT_MS,
};

/**
 * Get server configuration for a given file path.
 * Returns the matching server config or null.
 */
export function getServerForFile(filePath, lspConfig) {
  if (!lspConfig || !lspConfig.enabled) return null;

  const languageId = getLanguageId(filePath);
  const servers = lspConfig.servers || {};

  // Check explicit servers first
  for (const [name, server] of Object.entries(servers)) {
    if (server.filetypes && server.filetypes.includes(languageId)) {
      return { ...server, languageId };
    }
  }

  // Check default servers
  for (const [name, server] of Object.entries(DEFAULT_LSP_SERVERS)) {
    if (server.filetypes && server.filetypes.includes(languageId)) {
      return { ...server, languageId };
    }
  }

  return null;
}

/**
 * Get server configuration by language ID.
 */
export function getServerByLanguageId(languageId, lspConfig) {
  if (!lspConfig || !lspConfig.enabled) return null;

  const servers = lspConfig.servers || {};

  for (const [name, server] of Object.entries(servers)) {
    if (server.filetypes && server.filetypes.includes(languageId)) {
      return { ...server, languageId };
    }
  }

  for (const [name, server] of Object.entries(DEFAULT_LSP_SERVERS)) {
    if (server.filetypes && server.filetypes.includes(languageId)) {
      return { ...server, languageId };
    }
  }

  return null;
}

/**
 * Check if LSP is enabled.
 */
export function isLspEnabled(lspConfig) {
  return !!(lspConfig && lspConfig.enabled);
}
