// Structured output for one-shot mode (`--json-schema`).
//
// A synthetic terminal tool: its arguments are validated against the user's schema;
// the first valid call captures the payload and ends the run (TOOL_STOP_LOOP), so the one-shot flow can print bare JSON to stdout.

import fs from "node:fs/promises";
import { ToolResult, parseToolInput } from "@core/extensions/tool-utils.ts";
import { validateParams, formatValidationErrors } from "@utils/json-schema.ts";
import type { ToolDef, ToolMetadata } from "@core/extensions/tool-registry.ts";

export const STRUCTURED_OUTPUT_TOOL_NAME = "structured_output";

/**
 * Resolve the `--json-schema` value: inline JSON or a path to a schema file.
 * Tool arguments are an object, so the schema must be `type: "object"`.
 */
export async function resolveOutputSchema(
  arg: string,
): Promise<{ schema?: Record<string, unknown>; error?: string }> {
  const trimmed = arg.trim();
  let raw: string;
  if (trimmed.startsWith("{")) {
    raw = trimmed;
  } else {
    try {
      raw = await fs.readFile(trimmed, "utf-8");
    } catch (e: unknown) {
      return { error: `Cannot read schema file: ${(e as Error).message}` };
    }
  }

  let schema: unknown;
  try {
    schema = JSON.parse(raw);
  } catch (e: unknown) {
    return { error: `Invalid JSON schema: ${(e as Error).message}` };
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return { error: "Schema must be a JSON object" };
  }
  if ((schema as Record<string, unknown>).type !== "object") {
    return { error: 'Schema must have "type": "object" (tool arguments are an object)' };
  }
  return { schema: schema as Record<string, unknown> };
}

export class StructuredOutputTool {
  static readonly TOOL_NAME = STRUCTURED_OUTPUT_TOOL_NAME;
  metadata: ToolMetadata = { sideEffects: false, difficulty: 1 };

  private readonly schema: Record<string, unknown>;
  private readonly onOutput: (payload: Record<string, unknown>) => void;
  private captured = false;

  constructor(
    schema: Record<string, unknown>,
    onOutput: (payload: Record<string, unknown>) => void,
  ) {
    this.schema = schema;
    this.onOutput = onOutput;
  }

  toToolDef(): ToolDef {
    return {
      type: "function",
      function: {
        name: STRUCTURED_OUTPUT_TOOL_NAME,
        description:
          "Return the final answer for this run. Call exactly once with the " +
          "complete result as the arguments; they must validate against the " +
          "schema and the call ends the run.",
        // The user's schema passes through verbatim (the toolDef() helper
        // would strip keywords like additionalProperties).
        parameters: this.schema,
      },
    };
  }

  callDisplay(): string {
    return `${STRUCTURED_OUTPUT_TOOL_NAME} called`;
  }

  async execute(input: string | Record<string, unknown> | null): Promise<ToolResult> {
    if (this.captured) {
      return ToolResult.err("Final output was already provided; nothing more to do.");
    }

    const args = parseToolInput(input);
    const result = validateParams(args, this.schema);
    if (!result.valid) {
      return ToolResult.err(formatValidationErrors(result.errors));
    }

    this.captured = true;
    this.onOutput(args as Record<string, unknown>);
    return ToolResult.stop("Final output captured.");
  }
}
