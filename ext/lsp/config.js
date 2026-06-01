// LSP configuration — server configs, defaults, and resolution.

import { getLanguageId } from "./utils.js";

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

  return null;
}

/**
 * Check if LSP is enabled.
 */
export function isLspEnabled(lspConfig) {
  return !!(lspConfig && lspConfig.enabled);
}
