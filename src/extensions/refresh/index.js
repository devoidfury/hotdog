/**
 * Refresh Extension
 *
 * Provides hot-reload capabilities for the agent to debug and modify itself
 * in real time. Reloads extensions by busting the module cache while keeping
 * agent state (context, messages, model, etc.) intact.
 *
 * Hooks:
 *   - tools:register  → registers the refresh tool
 *   - commands:register → handles /refresh command
 *
 * Features:
 *   - Selective reload of specific extensions by name
 *   - Full reload of all extensions via "all"
 *   - Module cache inspection and clearing
 *   - Preserves agent state during reload
 *   - Auto-re-registers tools after reload
 */

import { HOOKS } from '../../core/hooks.js';
import { RefreshTool } from './refresh-tool.js';

// ── Extension Creator ─────────────────────────────────────────────────────────

/**
 * Create the refresh extension.
 *
 * @param {Object} core - The core object with hooks, extensions, etc.
 * @returns {Object|null} The extension instance, or null if disabled.
 */
export function create(core) {
  const { hooks, extensions } = core;

  // Create the refresh tool
  const refreshTool = new RefreshTool({
    core,
    extensionLoader: extensions,
    reRegisterTools: () => _reRegisterAllTools(core),
  });

  return {
    hooks: {
      /**
       * Register the refresh tool.
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        registry.register('refresh', refreshTool);
      },

      /**
       * Register /refresh command.
       *
       * Usage:
       *   /refresh list          — Show loaded modules and extensions
       *   /refresh all           — Reload all extensions
       *   /refresh <name>        — Reload a specific extension
       *   /refresh cache-clear   — Clear the module cache
       */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register('refresh', {
          description: 'Hot-reload extensions and modules',
          matches: (cmd) => cmd.startsWith('refresh'),
          handler: async (agent, cmdValue) => {
            const parts = cmdValue.split(/\s+/);
            const target = parts.slice(1).filter(p => !p.startsWith('--')).join(' ') || 'list';
            const force = parts.some(p => p === '--force');

            // Simulate tool input for reuse
            const input = {
              action: target === 'list' ? 'list'
                    : target === 'cache-clear' ? 'cache-clear'
                    : 'reload',
              target,
              force,
            };

            const result = await refreshTool.execute(input, { agent });
            return { content: result.toDisplay() };
          },
        });
      },
    },

    // Expose for external use
    refreshTool,

    /**
     * Get the list of reloadable extensions (those loaded from file paths).
     */
    getReloadableExtensions() {
      const entryPoints = extensions.entryPoints();
      return Array.from(entryPoints.keys());
    },

    /**
     * Get the module paths for reloadable extensions.
     */
    getExtensionPaths() {
      return extensions.entryPoints();
    },
  };
}

// ── Tool Re-registration ──────────────────────────────────────────────────────

/**
 * Re-register all tools across all extensions.
 * This is called after a reload to ensure the tool registry is up to date.
 *
 * @param {Object} core - The core object.
 * @returns {Promise<void>}
 */
async function _reRegisterAllTools(core) {
  const { hooks, toolRegistry } = core;

  // Clear existing tools (but keep the refresh tool)
  const allTools = toolRegistry.getAll();
  const refreshTool = toolRegistry.get('refresh');
  toolRegistry.clear();

  // Re-register the refresh tool first
  if (refreshTool) {
    toolRegistry.register('refresh', refreshTool);
  }

  // Re-dispatch the tools:register hook to all extensions
  // Each extension's handler will re-register its tools
  await hooks.emitAsync(HOOKS.TOOLS_REGISTER, toolRegistry);
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export { RefreshTool } from './refresh-tool.js';
