// Prompts Extension
// Manages prompt templates loading and execution.

import { HOOKS } from "@core/hooks.ts";
import { logger } from "@utils/logger.ts";
import { PromptsLoader } from "./loader.ts";
import {
  getExtensionConfig,
  type CoreContext,
  type ExtensionInstance,
} from "@core/extensions/types.ts";
import { matcher, completion } from "./completions.ts";

/**
 * Create the prompts extension.
 */
export async function create(core: CoreContext): Promise<ExtensionInstance> {
  // B7 (§4.1/§4.3 prompts row): ONE split, stated honestly.
  //  - `displayPrompt` is a LIVE knob: the loader holds a reader and resolves
  //    it per prompt execution (`prompt:<name>` answers the current value).
  //  - `path` (and the deprecated top-level `promptsPath` compat below) is
  //    loader lifecycle: the fs import list is activation machinery, so a
  //    published path change reaches the NEXT session, never the running one
  //    -- the loader keeps the dirs it imported from and nothing yanks them
  //    out mid-conversation. Reading them here at create is therefore the
  //    correct scope, not a stale capture (see the no-stale-capture allow-list).
  const boot = getExtensionConfig<{
    path?: string;
    promptsPath?: string;
    displayPrompt?: boolean;
  }>(core, "prompts");
  // Backward compat: support old top-level promptsPath key alongside new path key.
  const resolvedPath = boot.path ?? boot.promptsPath;
  if (boot.promptsPath != null && boot.path == null) {
    logger.warn("prompts.promptsPath is deprecated; use prompts.path instead");
  }
  const loader = new PromptsLoader(
    resolvedPath,
    () => getExtensionConfig<{ displayPrompt?: boolean }>(core, "prompts").displayPrompt ?? true,
  );
  await loader.loadPrompts();

  const instance: ExtensionInstance & {
    loader: PromptsLoader;
    getAllPrompts: () => Array<{ name: string }>;
    getPrompt: (name: string) => unknown;
  } = {
    hooks: {
      /** Mount loader on agent for completion access. */
      [HOOKS.AGENT_TOOL_CONTEXT]: async ({ agent }) => {
        (agent as { promptsLoader?: typeof loader }).promptsLoader = loader;
      },

      /** Register commands for prompts. */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("prompt", {
          description: "Execute a prompt template (prompt:<name> [args])",
          matches: (cmd: string) =>
            cmd.startsWith("prompt:") || cmd.startsWith("prompt "),
          handler: loader.promptHandler.bind(loader),
          completion,
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
    core.completion.register(matcher, completion, "prompts:prompt");
  }

  return instance;
}
