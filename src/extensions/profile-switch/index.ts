// Profile-switch extension
// `/profile`, `/profile <name>`, `/profile:<name>` slash commands.

import { HOOKS } from "@core/hooks.ts";
import { ACTIONS } from "@core/commands.ts";
import { CoreContext, ExtensionInstance } from "@core/extensions/types.ts";
import type { Agent } from "@core/agent.ts";
import type { SwitchProfile } from "@core/config/profiles.ts";
import type { CompletionContext, CompletionOption } from "@core/completion.ts";

const CMD_NAME = "profile";

function getProfiles(core: CoreContext): Record<string, SwitchProfile> {
  return core.resolved?.profileManager?.getProfilesForSwitch() ?? {};
}

function listProfiles(
  agent: Agent,
  profiles: Record<string, SwitchProfile>,
) {
  const names = Object.keys(profiles);
  if (names.length === 0) {
    return { action: ACTIONS.DISPLAY, content: "No profiles configured." };
  }
  const lines = ["Available profiles:"];
  for (const name of names) {
    lines.push(`  ${name}${name === agent.profileName ? " (current)" : ""}`);
  }
  return { action: ACTIONS.DISPLAY, content: lines.join("\n") };
}

export function create(core: CoreContext): ExtensionInstance {
  return {
    hooks: {
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        registry.register(CMD_NAME, {
          description: "List profiles or switch to one",
          matches: (cmd: string) =>
            cmd === CMD_NAME ||
            cmd.startsWith(`${CMD_NAME} `) ||
            cmd.startsWith(`${CMD_NAME}:`),
          handler: (agent: Agent, cmdValue: string | null) => {
            const profiles = getProfiles(core);
            const name =
              cmdValue && cmdValue.length > CMD_NAME.length
                ? cmdValue.substring(CMD_NAME.length + 1).trim()
                : "";

            if (!name) return listProfiles(agent, profiles);

            const profile = profiles[name];
            if (!profile) {
              return {
                action: ACTIONS.ERROR,
                error: `Profile "${name}" not found. Use /profile to list profiles.`,
              };
            }

            // Context is preserved (unlike the webui switch flow, which
            // wipes after asking); use /clear for a fresh start.
            agent.applyProfile(name, profile);
            agent.emitOutput("session_state", { key: "profile", value: name });
            return {
              action: ACTIONS.DISPLAY,
              content: `Switched to profile: ${name}`,
            };
          },
          completion: (ctx: CompletionContext): CompletionOption[] => {
            const prefix = (ctx.commandArg || "").toLowerCase();
            return Object.keys(getProfiles(core))
              .filter((p) => p.toLowerCase().startsWith(prefix))
              .map((p) => ({ value: p }));
          },
        });
      },
    },
  };
}
