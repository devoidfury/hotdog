// Model tool — switch the AI model at runtime.

import { toolDef, param, ToolResult, toolResult, parseToolInput, defaultCallDisplay } from "./registry.js";

export class ModelTool {
  static TOOL_NAME = "model";

  constructor(modelRegistry = {}) {
    this.modelRegistry = modelRegistry || {};
  }

  toToolDef() {
    const models = Object.keys(this.modelRegistry).sort();
    const description =
      models.length > 0
        ? `Switch to a different model. Use the \`model\` tool to switch between available models during a conversation. The new model will be used for subsequent messages in this conversation. Available models: ${models.join(", ")}.`
        : 'Switch the AI model at runtime. Pass a model name to switch to, or "list" to show available models.';

    return toolDef(ModelTool.TOOL_NAME, description, {
      schema: "https://json-schema.org/draft/2020-12/schema",
      properties: {
        name: param("string", "The name of the model to switch to", {
          enum: models,
        }),
      },
      required: ["name"],
    });
  }

  callDisplay(input) {
    return defaultCallDisplay(input, (args) => `-> ${args.name}`);
  }

  async execute(input, ctx) {
    const args = parseArgs(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }

    const name = args.name;

    if (name === "list") {
      const models = Object.keys(this.modelRegistry);
      return ToolResult.ok(
        models.length > 0 ? models.join("\n") : "No models registered.",
      ).withEntries({
        model_count: String(models.length),
      });
    }

    // Validate model exists
    if (!this.modelRegistry[name]) {
      const available = Object.keys(this.modelRegistry);
      return ToolResult.err(
        `Unknown model '${name}'. Available models: ${available.join(", ")}`,
      );
    }

    const onSwitchModel = ctx?.get('onSwitchModel');
    if (onSwitchModel) {
      try {
        await onSwitchModel(name);
        return ToolResult.ok(`Switched to model: ${name}`).withEntry(
          "model", name,
        );
      } catch (e) {
        return ToolResult.err(`Error switching model: ${e.message}`);
      }
    }

    return ToolResult.ok(
      `Model tool requires a model switch callback. Model: ${name}`,
    ).withEntry("model", name);
  }
}

/**
 * Parse model tool arguments.
 */
function parseArgs(input) {
  const json = parseToolInput(input);
  if (!json) return null;

  const name = json.name;
  if (!name || typeof name !== "string") {
    return null;
  }

  return { name };
}
