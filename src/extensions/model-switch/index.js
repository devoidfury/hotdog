// Model-switch extension — provides the model tool and /model commands
// for switching AI models at runtime.
//
// Config (modelSwitch) — defined in extension.json configSchema:
//   - toolEnabled:    bool  (default: true)  — register the model tool
//   - commandEnabled: bool  (default: true)  — register /model and /models commands

import { HOOKS } from "../../core/hooks.js";
import { ModelTool } from "./model.js";

/**
 * Create the model-switch extension.
 *
 * @param {Object} core - The core object with hooks, resolved config, etc.
 * @returns {Object} The extension instance.
 */
export function create(core) {
  const modelRegistry = core.resolved?.modelRegistry || {};
  // Config defaults come from extension.json configSchema
  const config = core.config?.modelSwitch || {};

  const modelTool = new ModelTool(modelRegistry);

  return {
    hooks: {
      /**
       * Register the model tool (if enabled).
       */
      [HOOKS.TOOLS_REGISTER]: async (registry) => {
        if (config.toolEnabled) {
          registry.register("model", modelTool);
        }
      },

      /**
       * Register /model and /models commands (if enabled).
       */
      [HOOKS.COMMANDS_REGISTER]: async ({ registry }) => {
        if (!config.commandEnabled) return;

        // /models — list available models
        registry.register("models", {
          description: "List available models",
          matches: (cmd) => cmd === "models",
          handler: async (agent) => {
            const models = Object.keys(agent._modelRegistry || {});
            if (models.length === 0) {
              return {
                content:
                  "No models configured. Add providers to your config file.",
              };
            }
            const lines = ["Available models:"];
            for (const name of models) {
              const m = agent._modelRegistry[name];
              lines.push(`  ${name}`);
            }
            lines.push(`\nCurrently using: ${agent.model}`);
            return { content: lines.join("\n") };
          },
        });

        // /model — switch model (with or without a name)
        registry.register("model", {
          description: "Switch to a different model",
          matches: (cmd) => cmd === "model" || cmd.startsWith("model "),
          handler: async (agent, cmdValue) => {
            const parts = cmdValue.split(/\s+/);
            const modelName = parts.slice(1).join(" ").trim();

            if (!modelName) {
              // No model name — show available models
              const models = Object.keys(agent._modelRegistry || {});
              return {
                content: `Available models: ${models.join(", ")}`,
              };
            }

            agent.model = modelName;
            return { content: `Switched to model: ${modelName}` };
          },
        });
      },
    },

    // Expose for external use
    modelTool,
  };
}

export { ModelTool } from "./model.js";
