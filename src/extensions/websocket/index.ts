import { HOOKS } from "@core/hooks.ts";
import {
  registerCommandCompletions,
  registerSlashCommandNameCompletion,
} from "@core/completion.ts";
import type { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";

// Config defaults come from extension.json configSchema.
export function create(core: CoreContext): ExtensionInstance {
  // Chat UIs over this socket share the core completion system with the
  // interactive CLI (minus shell mode, which is CLI-only). Registered at
  // extension load so the hook catches COMMANDS_REGISTER from the very
  // first agent build.
  const completion = core.completion;
  if (completion) {
    registerSlashCommandNameCompletion(completion);
    // COMMANDS_REGISTER fires per agent build (one per session); dedupe by
    // command name so long-lived servers do not accumulate duplicate
    // handlers.
    const argCompletionsRegistered = new Set<string>();
    core.hooks.on(
      HOOKS.COMMANDS_REGISTER,
      ({ registry }) => {
        registerCommandCompletions(
          completion,
          registry,
          "websocket",
          argCompletionsRegistered,
        );
      },
      "websocket",
    );
  }
  return {};
}
