// Prompts Extension
// Manages prompt templates loading and execution.
// Hooks: tools:register, commands:register

import extensionData from "./extension.json";
import { HOOKS } from "../../core/hooks.js";
import { logger } from "../../core/logger.js";
import { PromptsLoader } from "./loader.js";

/**
 * Create the prompts extension.
 */
export async function create(core) {
  const config = core.config?.prompts || {};
  // Backward compat: support old top-level promptsPath key alongside new path key.
  const resolvedPath = config.path ?? config.promptsPath;
  if (config.promptsPath !== undefined && config.path === undefined) {
    logger.warn(
      "prompts.promptsPath is deprecated; use prompts.path instead",
    );
  }
  const loader = new PromptsLoader(resolvedPath, config.displayPrompt);
  await loader.loadPrompts();

  return {
    hooks: {
      /**
       * Register commands for prompts.
       */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("prompt", {
          description: "Execute a prompt template (prompt:<name> [args])",
          matches: (cmd) =>
            cmd.startsWith("prompt:") || cmd.startsWith("prompt "),
          handler: loader.promptHandler.bind(loader),
        });
      },
    },

    // Expose for external use
    loader,

    /**
     * Get all prompts.
     */
    getAllPrompts() {
      return loader.allPrompts();
    },

    /**
     * Get a prompt by name.
     */
    getPrompt(name) {
      return loader.getPrompt(name);
    },
  };
}
