// Model-switch extension — provides the model tool and /model commands
// for switching AI models at runtime.
//
// Config (modelSwitch) — defined in extension.json configSchema:
//   - toolEnabled:    bool  (default: true)  — register the model tool
//   - commandEnabled: bool  (default: true)  — register /model and /models commands

import { HOOKS } from "../../core/hooks.ts";
import { ACTIONS } from "../../core/commands.ts";
import { ModelTool } from "./model.ts";
import {
  CoreContext,
  ExtensionInstance,
  ToolsRegisterPayload,
  CommandsRegisterPayload,
  getExtensionConfig,
} from "../../core/extensions/types.ts";

interface Agent {
  modelRegistry?: Record<string, unknown>;
  model?: string;
}

/**
 * Create the model-switch extension.
 */
export function create(core: CoreContext): ExtensionInstance {
  const modelRegistry = core.resolved?.modelRegistry ?? {};
  // Config defaults come from extension.json configSchema
  const config = getExtensionConfig<{ toolEnabled?: boolean; commandEnabled?: boolean }>(core, "modelSwitch");

  const modelTool = new ModelTool(modelRegistry);

  return {
    hooks: {
      /**
       * Register the model tool (if enabled).
       */
      [HOOKS.TOOLS_REGISTER]: async (registry: ToolsRegisterPayload) => {
        if (config.toolEnabled) {
          registry.register("model", modelTool);
        }
      },

      /**
       * Register /model and /models commands (if enabled).
       */
      [HOOKS.COMMANDS_REGISTER]: async (payload: CommandsRegisterPayload) => {
        const { registry } = payload;
        if (config.commandEnabled === false) return;

        // /models — list available models
        registry.register("models", {
          description: "List available models",
          matches: (cmd: string) => cmd === "models",
          handler: async (agent: Agent) => {
            const models = Object.keys(agent.modelRegistry || {});
            if (models.length === 0) {
              return {
                action: ACTIONS.DISPLAY,
                content:
                  "No models configured. Add providers to your config file.",
              };
            }
            const lines = ["Available models:"];
            for (const name of models) {
              lines.push(`  ${name}`);
            }
            lines.push(`\nCurrently using: ${agent.model}`);
            return { action: ACTIONS.DISPLAY, content: lines.join("\n") };
          },
        });

        // /model — switch model (with or without a name)
        registry.register("model", {
          description: "Switch to a different model",
          matches: (cmd: string) => cmd === "model" || cmd.startsWith("model "),
          handler: async (agent: Agent, cmdValue: string) => {
            const parts = cmdValue.split(/\s+/);
            const modelName = parts.slice(1).join(" ").trim();

            if (!modelName) {
              // No model name — show available models
              const models = Object.keys(agent.modelRegistry || {});
              return {
                action: ACTIONS.DISPLAY,
                content: `Available models: ${models.join(", ")}`,
              };
            }

            agent.model = modelName;
            return { action: ACTIONS.DISPLAY, content: `Switched to model: ${modelName}` };
          },
        });
      },
    },

    // Expose for external use
    modelTool,
  };
}

export { ModelTool } from "./model.ts";
