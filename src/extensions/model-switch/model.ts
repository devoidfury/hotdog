// Model tool — switch the AI model at runtime.

import { toolDef, param, ToolResult, parseToolInput, defaultCallDisplay } from "../../core/extensions/tool-utils.ts";

interface ModelRegistry {
  [key: string]: unknown;
}

interface ToolContext {
  get(key: string): unknown;
}

interface OnSwitchModel {
  (name: string): Promise<void>;
}

export class ModelTool {
  static readonly TOOL_NAME = "model";

  private readonly modelRegistry: ModelRegistry;

  constructor(modelRegistry: ModelRegistry = {}) {
    this.modelRegistry = modelRegistry || {};
  }

  toToolDef(): Record<string, unknown> {
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

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => `-> ${args.name as string}`);
  }

  async execute(input: string | Record<string, unknown> | null, ctx?: ToolContext): Promise<ToolResult> {
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

    const onSwitchModel = ctx?.get("onSwitchModel") as OnSwitchModel | undefined;
    if (onSwitchModel) {
      try {
        await onSwitchModel(name);
        return ToolResult.ok(`Switched to model: ${name}`).withEntry(
          "model", name,
        );
      } catch (e: unknown) {
        return ToolResult.err(`Error switching model: ${(e as Error).message}`);
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
function parseArgs(input: string | Record<string, unknown> | null): { name: string } | null {
  const json = parseToolInput(input);
  if (!json) return null;

  const name = json.name as string | undefined;
  if (!name || typeof name !== "string") {
    return null;
  }

  return { name };
}
