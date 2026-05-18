// Pager tool — paginate through large tool outputs.

import { toolDef, param, toolResult } from './registry.js';

export class PagerTool {
  static TOOL_NAME = 'pager';

  static tryNewFromContext(ctx) {
    return new PagerTool();
  }

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
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    return `pager: ${args.tool_call_id}`;
  }

  async execute(input, ctx) {
    const args = typeof input === 'string' ? JSON.parse(input) : input;
    const toolCallId = args.tool_call_id;

    if (ctx?.onGetCachedToolOutput) {
      const cached = ctx.onGetCachedToolOutput(toolCallId);
      if (cached) return toolResult(cached);
    }

    return toolResult(`No cached output found for tool call ID: ${toolCallId}`);
  }
}
