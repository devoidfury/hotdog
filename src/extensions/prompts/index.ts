// Prompts Extension
// Manages prompt templates loading and execution.

import { HOOKS } from "../../core/hooks.ts";
import { logger } from "../../core/logger.ts";
import { PromptsLoader } from "./loader.ts";
import {
  getExtensionConfig,
  type CoreContext,
  type ExtensionInstance,
} from "../../core/extensions/types.ts";

/**
 * Create the prompts extension.
 */
export async function create(core: CoreContext): Promise<ExtensionInstance> {
  const config = getExtensionConfig<{
    path?: string;
    promptsPath?: string;
    displayPrompt?: boolean;
  }>(core, "prompts");
  // Backward compat: support old top-level promptsPath key alongside new path key.
  const resolvedPath = config.path ?? config.promptsPath ?? "";
  if (config.promptsPath != null && config.path == null) {
    logger.warn("prompts.promptsPath is deprecated; use prompts.path instead");
  }
  const loader = new PromptsLoader(resolvedPath, config.displayPrompt ?? false);
  await loader.loadPrompts();

  return {
    hooks: {
      /** Register commands for prompts. */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("prompt", {
          description: "Execute a prompt template (prompt:<name> [args])",
          matches: (cmd: string) =>
            cmd.startsWith("prompt:") || cmd.startsWith("prompt "),
          handler: loader.promptHandler.bind(loader),
        });
      },
    },

    // Expose for external use
    loader,

    /** Get all prompts. */
    getAllPrompts() {
      return loader.allPrompts();
    },

    /** Get a prompt by name. */
    getPrompt(name: string) {
      return loader.getPrompt(name);
    },
  };
}
