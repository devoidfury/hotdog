// Shared LSP client utilities — get/create client logic shared across the extension.

import { LspClient } from './client.js';
import { getServerByLanguageId } from './config.js';
import {
  getCachedClient,
  deleteCachedClient,
  setCachedClient,
} from './client-cache.js';
import { formatError } from '../../src/context/error.js';

/**
 * Get or create an LSP client for the given language.
 * Checks the cache first, then looks up server config and creates a new client.
 *
 * @param {string} languageId — Language identifier
 * @param {object} lspConfig — LSP configuration (may be null)
 * @param {object} [ctx] — Tool context (for workspaceRoot)
 * @param {number} [defaultTimeoutMs=30000] — Default request timeout
 * @param {number} [defaultStartupTimeoutMs=60000] — Default server startup timeout
 * @returns {Promise<LspClient|null>}
 */
export async function getOrCreateLspClient(
  languageId,
  lspConfig,
  ctx = null,
  defaultTimeoutMs = 30000,
  defaultStartupTimeoutMs = 60000,
) {
  // Check cache first
  const cached = getCachedClient(languageId);
  if (cached && cached.isReady()) {
    return cached;
  }
  // Client is dead or not found — clear stale entry
  if (cached) {
    deleteCachedClient(languageId);
  }

  // Look up server config
  const serverConfig = getServerByLanguageId(languageId, lspConfig);
  if (!serverConfig) {
    return null;
  }

  // Create new client
  const client = new LspClient({
    requestTimeoutMs: serverConfig.timeoutMs || defaultTimeoutMs,
    serverStartupTimeoutMs: defaultStartupTimeoutMs,
  });

  // Initialize the client
  try {
    await client.initialize({
      command: serverConfig.command,
      args: serverConfig.args || [],
      initializationOptions: serverConfig.initializationOptions,
      rootPath: ctx?.get('workspaceRoot') || process.cwd(),
      env: serverConfig.env,
      timeoutMs: serverConfig.timeoutMs,
    });
  } catch (e) {
    console.error(`[lsp] Failed to initialize client for '${languageId}': ${formatError(e)}`);
    return null;
  }

  setCachedClient(languageId, client);
  return client;
}
