// Pager tool — paginate through large tool outputs.

import { toolDef, param, ToolResult, toolResult, parseToolInput, defaultCallDisplay } from '../../core/extensions/tool-utils.js';

export class PagerTool {
  static TOOL_NAME = 'pager';

  toToolDef() {
    return toolDef(
      PagerTool.TOOL_NAME,
      'Show a previously cached tool output for pagination.',
      {
        properties: {
          tool_call_id: param('string', 'The tool call ID of the output to retrieve.'),
        },
        required: ['tool_call_id'],
      }
    );
  }

  callDisplay(input) {
    return defaultCallDisplay(input, (args) => `pager: ${args.tool_call_id}`);
  }

  async execute(input, ctx) {
    const args = parseToolInput(input);
    if (!args) {
      return ToolResult.err("Error parsing arguments");
    }
    const toolCallId = args.tool_call_id;

    const onGetCachedToolOutput = ctx?.get('onGetCachedToolOutput');
    if (onGetCachedToolOutput) {
      const cached = onGetCachedToolOutput(toolCallId);
      if (cached) {
        return ToolResult.ok(cached).withEntry('tool_call_id', toolCallId);
      }
    }

    return ToolResult.err(`No cached output found for tool call ID: ${toolCallId}`);
  }
}
