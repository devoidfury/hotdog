// Extension registrar: wires the info / show-prompt / profiles subcommands
// and the /show-prompt slash command. The feature code lives one concern per
// file: info.ts (diagnostics + renderers), config-trace.ts (the layer trace),
// show-prompt.ts (prompt rendering), profiles.ts (profile listing).
import { HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { Agent } from "@core/agent.ts";
import type { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import { runInfo } from "./info.ts";
import { renderPrompt, runShowPrompt } from "./show-prompt.ts";
import { runProfileList } from "./profiles.ts";

export function create(_core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.CLI_SUBCOMMANDS_REGISTER]: async (registry) => {
        registry.register("info", {
          description: "Show system info and diagnostics",
          handler: runInfo,
        });

        registry.register("show-prompt", {
          description: "Show rendered system prompt with tool definitions",
          handler: runShowPrompt,
        });

        registry.register("profiles", {
          description: "List all available profiles with their tool restrictions",
          handler: runProfileList,
        });
      },

      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register("show-prompt", {
          description: "Show the rendered system prompt with tool definitions",
          matches: (cmd: string) => cmd.trim() === "show-prompt",
          handler: async (agent: Agent) => ({
            action: ACTIONS.DISPLAY,
            content: await renderPrompt(agent),
          }),
        });
      },
    },
  };
}
