/**
 * Example Config Extension
 *
 * Demonstrates how extensions can register their own CLI flags
 * and config parameters dynamically.
 *
 * Usage:
 *   1. Register CLI flags via CONFIG_CLI_FLAGS_REGISTER hook
 *   2. Register config params via CONFIG_PARAMS_REGISTER hook
 *   3. Access the config values from core.config
 */

import { HOOKS } from '../../src/hooks.js';

/**
 * Create the example-config extension.
 *
 * @param {Object} core - The core object with hooks, extensions, etc.
 * @returns {Object} The extension instance.
 */
export function create(core) {
  return {
    hooks: {
      /**
       * Register CLI flags for this extension.
       *
       * This hook is called during extension loading. The extension
       * can register CLI flags that will be recognized by the parser.
       *
       * @param {import('../../src/config-registry.js').ConfigRegistry} configRegistry
       */
      [HOOKS.CONFIG_CLI_FLAGS_REGISTER]: function(configRegistry) {
        configRegistry.registerCliFlags([
          {
            short: '-e',
            long: '--example-mode',
            description: 'Example extension mode (debug, normal, quiet)',
            type: 'string',
            default: 'normal',
            parse: (value) => {
              const modes = ['debug', 'normal', 'quiet'];
              if (!modes.includes(value)) {
                console.warn(`Warning: unknown example-mode '${value}', using 'normal'`);
                return 'normal';
              }
              return value;
            },
          },
          {
            short: null,
            long: '--example-retries',
            description: 'Number of retries for example operations',
            type: 'number',
            default: 3,
          },
          {
            short: null,
            long: '--example-tags',
            description: 'Comma-separated tags for filtering',
            type: 'array',
            default: [],
          },
          {
            short: null,
            long: '--example-verbose',
            description: 'Enable verbose output for this extension',
            type: 'boolean',
            default: false,
          },
        ]);
      },

      /**
       * Register config parameters for this extension.
       *
       * This hook is called during extension loading. The extension
       * can register config parameters that will be merged into the
       * default config and can be set in the config file.
       *
       * @param {import('../../src/config-registry.js').ConfigRegistry} configRegistry
       */
      [HOOKS.CONFIG_PARAMS_REGISTER]: function(configRegistry) {
        configRegistry.registerConfigParams([
          {
            key: 'exampleConfig',
            description: 'Example extension configuration',
            defaults: {
              enabled: true,
              mode: 'normal',
              retries: 3,
              tags: [],
              verbose: false,
              timeout: 30,
              endpoints: [],
            },
          },
        ]);
      },
    },

    // Expose for external use
    getMode() {
      return core.config?.exampleConfig?.mode || 'normal';
    },

    getConfig() {
      return core.config?.exampleConfig || {};
    },
  };
}
