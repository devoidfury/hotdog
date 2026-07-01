// Prompts Extension
// Manages prompt templates loading and execution.
// Hooks: tools:register, commands:register

import extensionData from "./extension.json";
import { HOOKS } from "../../core/hooks.js";
import { PromptsLoader } from "./loader.js";

/**
 * Create the prompts extension.
 */
export async function create(core) {
  // Config defaults come from extension.json configSchema
  const config = core.config?.prompts || {};
  const promptsPath =
    config.promptsPath ??
    extensionData.configSchema.prompts.properties.promptsPath.default;
  const loader = new PromptsLoader(promptsPath);
  await loader.loadPrompts();

  return {
    hooks: {
      /**
       * Register commands for prompts.
       */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("prompt", {
          description: "Execute a prompt template (prompt:<name> [args])",
          matches: (cmd) => cmd.startsWith("prompt:"),
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
