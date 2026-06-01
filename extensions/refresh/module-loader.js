/**
 * Module loader with cache-busting dynamic imports.
 *
 * Supports hot-reloading of ESM modules by appending a timestamp query string
 * to bust the V8/module graph cache while preserving application state.
 *
 * Usage:
 *   const mod = await importModule('./path/to/module.js');
 *   // Subsequent calls with the same path return the cached module.
 *   const fresh = await importModule('./path/to/module.js', true); // force reload
 */

// ── Module cache ──────────────────────────────────────────────────────────────

/**
 * Map of resolved module paths → { module, timestamp }.
 * Used to deduplicate imports and track reloads.
 */
const _moduleCache = new Map();

/**
 * Resolve a module path to a canonical form.
 * Handles relative paths by prepending the base directory.
 */
function resolveModulePath(path, base = import.meta.url) {
  // If already absolute (file:// or http://), return as-is
  if (path.startsWith('file://') || path.startsWith('http://')) {
    return path;
  }
  // If it's an absolute file path (starts with /), convert to file://
  if (path.startsWith('/') && !path.startsWith('//')) {
    return `file://${path}`;
  }
  // Otherwise, it's a relative path — resolve against base
  const baseDir = base.replace(/[^/]+$/, '');
  const resolved = new URL(path, baseDir).href;
  return resolved;
}

/**
 * Import a module, using cache if available.
 *
 * @param {string} modulePath - The module path to import.
 * @param {boolean} forceReload - If true, bypass cache and force a fresh import.
 * @param {string} [base] - Base URL for resolving relative paths.
 * @returns {Promise<Object>} The imported module.
 */
export async function importModule(modulePath, forceReload = false, base) {
  const resolved = resolveModulePath(modulePath, base);

  // Force reload: remove from cache and bust import cache
  if (forceReload) {
    _moduleCache.delete(resolved);
  } else if (_moduleCache.has(resolved)) {
    const cached = _moduleCache.get(resolved);
    return cached.module;
  }

  // Bust cache by appending timestamp
  const cacheBust = `?_${Date.now()}`;
  const importPath = resolved + cacheBust;

  try {
    const mod = await import(importPath);
    _moduleCache.set(resolved, { module: mod, timestamp: Date.now() });
    return mod;
  } catch (e) {
    // If the import fails (e.g., file doesn't exist), remove from cache
    _moduleCache.delete(resolved);
    throw e;
  }
}

/**
 * Get the list of all loaded modules.
 * @returns {Array<{path: string, timestamp: number}>}
 */
export function getLoadedModules() {
  const result = [];
  for (const [path, { timestamp }] of _moduleCache) {
    result.push({ path, timestamp });
  }
  return result;
}

/**
 * Clear the module cache (for full reset scenarios).
 */
export function clearModuleCache() {
  _moduleCache.clear();
}
