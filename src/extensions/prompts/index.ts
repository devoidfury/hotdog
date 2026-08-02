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
import type { CompletionContext, CompletionOption } from "../../core/completion.ts";

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
  const resolvedPath = config.path ?? config.promptsPath;
  if (config.promptsPath != null && config.path == null) {
    logger.warn("prompts.promptsPath is deprecated; use prompts.path instead");
  }
  const loader = new PromptsLoader(resolvedPath, config.displayPrompt);
  await loader.loadPrompts();

  // Completion handler for /prompt command
  const promptCompletion = (ctx: CompletionContext): CompletionOption[] => {
    const allPrompts = loader.allPrompts();
    const promptNames = allPrompts.map((p) => p.name);

    // Extract the prompt name prefix
    let prefix = "";
    if (ctx.command === "prompt") {
      prefix = (ctx.commandArg || "").toLowerCase();
    } else if (ctx.command && ctx.command.startsWith("prompt:")) {
      // "/prompt:name" -> extract "name"
      prefix = ctx.command.slice(7).toLowerCase();
    }

    return promptNames
      .filter((name) => name.toLowerCase().startsWith(prefix))
      .map((name) => ({ value: name }));
  };

  const instance: ExtensionInstance & {
    loader: PromptsLoader;
    getAllPrompts: () => Array<{ name: string }>;
    getPrompt: (name: string) => unknown;
  } = {
    hooks: {
      /** Register commands for prompts. */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("prompt", {
          description: "Execute a prompt template (prompt:<name> [args])",
          matches: (cmd: string) =>
            cmd.startsWith("prompt:") || cmd.startsWith("prompt "),
          handler: loader.promptHandler.bind(loader),
          completion: promptCompletion,
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

  // Register completion with completion service (if available)
  if (core.completion) {
    const promptMatcher = (ctx: CompletionContext): boolean => {
      const cmd = ctx.command;
      if (!cmd) return false;
      return cmd === "prompt" || cmd.startsWith("prompt:");
    };
    core.completion.register(promptMatcher, promptCompletion, "prompts:prompt");
  }

  return instance;
}
