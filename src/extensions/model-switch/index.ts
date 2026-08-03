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
  getExtensionConfig,
} from "../../core/extensions/types.ts";
import { type Agent } from "../../core/agent.ts";
import { matcher, completion } from "./completions.ts";

interface ModelSwitchExtConfig {
  toolEnabled?: boolean;
  commandEnabled?: boolean;
}

const MODEL_TOOL_NAME = "model";
const MODEL_CMD_NAME = "model";
const LIST_CMD_NAME = "models";

function listModels(agent: Agent) {
  // No model name — show available models
  const models = Object.keys(agent.modelRegistry);
  if (models.length === 0) {
    return {
      action: ACTIONS.DISPLAY,
      content: "No models configured. Add providers to your config file.",
    };
  }

  const lines = ["Available models:"];
  for (const name of models) {
    lines.push(`  ${name}`);
  }
  lines.push(`\nCurrently using: ${agent.model}`);
  return { action: ACTIONS.DISPLAY, content: lines.join("\n") };
}

/**
 * Create the model-switch extension.
 */
export function create(core: CoreContext): ExtensionInstance {
  const config = getExtensionConfig<ModelSwitchExtConfig>(core, "modelSwitch");
  const modelTool = new ModelTool(core.resolved?.modelRegistry);

  const instance: ExtensionInstance & { modelTool: ModelTool } = {
    hooks: {
      /**
       * Register the model tool (if enabled).
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        if (config.toolEnabled === true) {
          registry.register(MODEL_TOOL_NAME, modelTool);
        }
      },

      /**
       * Register /model and /models commands (if enabled).
       */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        if (config.commandEnabled === false) return;

        // /models — list available models
        registry.register(LIST_CMD_NAME, {
          description: "List available models",
          matches: (cmd: string) => cmd.trim() === LIST_CMD_NAME,
          handler: listModels,
        });

        // /model — switch model (with or without a name)
        registry.register(MODEL_CMD_NAME, {
          description: "Switch to a different model",
          matches: (cmd: string) =>
            cmd === MODEL_CMD_NAME ||
            cmd.startsWith(`${MODEL_CMD_NAME} `) ||
            cmd.startsWith(`${MODEL_CMD_NAME}:`),
          handler: async (agent: Agent, cmdValue: string | null) => {
            const modelName = (cmdValue ?? "")
              .substring(MODEL_CMD_NAME.length + 1)
              .trim();

            if (!modelName) {
              return listModels(agent);
            }

            if (!agent.modelRegistry[modelName]) {
              return {
                action: ACTIONS.DISPLAY,
                content: `Error: model "${modelName}" not found in registry. Use /models to see available models.`,
              };
            }

            agent.model = modelName;
            return {
              action: ACTIONS.DISPLAY,
              content: `Switched to model: ${modelName}`,
            };
          },
          completion,
        });
      },
    },

    // Expose for external use
    modelTool,
  };

  // Register completion with completion service (if available)
  if (core.completion) {
    core.completion.register(matcher, completion, "model-switch:model");
  }

  return instance;
}

export { ModelTool } from "./model.ts";
