// Pager tool — paginate through large tool outputs.

import { toolDef, param, ToolResult, parseToolInput, defaultCallDisplay } from "../../core/extensions/tool-utils.ts";
import { ToolExecutionContext } from "../../core/extensions/types.ts";

export class PagerTool {
  static readonly TOOL_NAME = "pager";

  toToolDef(): Record<string, unknown> {
    return toolDef(
      PagerTool.TOOL_NAME,
      "Show a previously cached tool output for pagination.",
      {
        properties: {
          tool_call_id: param("string", "The tool call ID of the output to retrieve."),
        },
        required: ["tool_call_id"],
      },
    );
  }

  callDisplay(input: string | Record<string, unknown> | null): string {
    return defaultCallDisplay(input, (args: Record<string, unknown>) => `pager: ${args.tool_call_id as string}`);
  }

  async execute(input: string | Record<string, unknown> | null, ctx: ToolExecutionContext): Promise<ToolResult> {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }
    const toolCallId = args.tool_call_id as string;

    const onGetCachedToolOutput = (ctx as Record<string, unknown>)?.get?.("onGetCachedToolOutput") as ((id: string) => string | null) | undefined;
    if (onGetCachedToolOutput) {
      const cached = onGetCachedToolOutput(toolCallId);
      if (cached) {
        return ToolResult.ok(cached).withEntry("tool_call_id", toolCallId);
      }
    }

    return ToolResult.err(`No cached output found for tool call ID: ${toolCallId}`);
  }
}
