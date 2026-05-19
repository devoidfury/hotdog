// Shared LSP client cache — single source of truth for all LSP clients.
// One client per language ID, cached across all code paths.

/** @type {Map<string, import('./client.js').LspClient>} */
export const lspClientCache = new Map();

/**
 * Get a cached client or null if not found.
 * @param {string} languageId
 * @returns {import('./client.js').LspClient | null}
 */
export function getCachedClient(languageId) {
  return lspClientCache.get(languageId) || null;
}

/**
 * Set a client in the cache.
 * @param {string} languageId
 * @param {import('./client.js').LspClient} client
 */
export function setCachedClient(languageId, client) {
  lspClientCache.set(languageId, client);
}

/**
 * Delete a client from the cache.
 * @param {string} languageId
 */
export function deleteCachedClient(languageId) {
  lspClientCache.delete(languageId);
}

/**
 * Clear the entire cache (for shutdown/restart).
 */
export function clearCache() {
  lspClientCache.clear();
}

/**
 * Get all cached clients.
 * @returns {Iterable<[string, import('./client.js').LspClient]>}
 */
export function getAllClients() {
  return lspClientCache.entries();
}

/**
 * Gracefully shutdown all cached LSP clients and clear the cache.
 * @returns {Promise<void>}
 */
export async function shutdownAll() {
  const promises = [];
  for (const [langId, client] of lspClientCache) {
    if (client.isReady()) {
      promises.push(client.shutdown().catch(() => {}));
    }
    lspClientCache.delete(langId);
  }
  await Promise.allSettled(promises);
}
