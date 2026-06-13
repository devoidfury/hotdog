// CLI output sink — formats and displays agent output with color support.

import { OutputSink, OUTPUT_EVENT, EVENT_HANDLERS } from "../context/output.js";
import { DEFAULT_TOOL_FMT, DEFAULT_TOOL_OUTPUT_FMT } from "../config/defaults.js";
import {
  ColorPalette,
  applyThinking,
  applyToolCall,
  applyToolResult,
  applyFinalResponse,
  applyCompacting,
  applyProgress,
  resolvePalette,
} from "./colors.js";

/**
 * Format a compacting message.
 */
export function formatCompacting(messageCount, keepRecent) {
  return `Compacting: removed ${messageCount} messages, keeping ${keepRecent} recent`;
}

/**
 * Format a tool call display using the tool formatter.
 */
export function formatToolCall(toolName, input, toolFmt) {
  if (toolFmt) {
    return toolFmt.replace("{}", toolName).replace("{}", input);
  }
  return DEFAULT_TOOL_FMT.replace("{}", toolName).replace("{}", input);
}

/**
 * Format a tool result display using the tool output formatter.
 */
export function formatToolResult(result, toolOutputFmt) {
  if (toolOutputFmt) {
    return toolOutputFmt.replace("{}", result);
  }
  return DEFAULT_TOOL_OUTPUT_FMT.replace("{}", result);
}

/**
 * Format token usage display.
 */
export function formatTokenUsage(
  promptTokens,
  cachedTokens,
  completionTokens,
  totalTokens,
) {
  return `(tokens cached:${cachedTokens} prompt:${promptTokens - cachedTokens} completion:${completionTokens} total:${totalTokens})`;
}

/**
 * Format a thinking message using the thinker formatter.
 */
export function formatThinking(content, thinkerFmt) {
  if (thinkerFmt) {
    return thinkerFmt.replace("{}", content);
  }
  return `[Thinking: ${content}]`;
}

/**
 * Format task progress display.
 */
export function formatTaskProgress(activeTasks, totalTasks) {
  if (activeTasks === 0) return "";
  if (totalTasks === 0) {
    return `${activeTasks} task${activeTasks === 1 ? "" : "s"} running`;
  }
  return `${activeTasks}/${totalTasks} tasks`;
}

/**
 * CLI output sink — extends OutputSink with formatting and color support.
 */
export class CliOutputSink extends OutputSink {
  constructor(options = {}) {
    super(options);
    this.thinkerFormat = options.thinkerFormat || "[Thinking: {}]";
    this.toolFormat = options.toolFormat || DEFAULT_TOOL_FMT;
    this.toolOutputFmt = options.toolOutputFmt || DEFAULT_TOOL_OUTPUT_FMT;
    this.palette = options.palette || ColorPalette.default();
    this.hideTools = options.hideTools;
    this.hideThinking = options.hideThinking;
  }

  /**
   * Resolve and set a color palette.
   */
  setPalette(palette) {
    this.palette = palette;
  }

  /**
   * Resolve a palette from CLI args, config, and theme.
   */
  static async resolve(useColors, theme, configPalette) {
    return resolvePalette(theme, configPalette, null, useColors);
  }

  emit(event) {
    const handler = EVENT_HANDLERS[event.type];
    if (handler) this[handler](event);
  }

  emitUserMessage(event) {
    process.stdout.write(`\n${event.content}\n\n`);
  }

  emitAssistantMessage(event) {
    process.stdout.write(applyFinalResponse(event.content, this.palette));
  }

  emitThinking(event) {
    if (this.hideThinking) return;
    // Thinking is streamed to stderr
    const formatted = formatThinking(event.content, this.thinkerFormat);
    const colored = applyThinking(formatted, this.palette);
    process.stderr.write(colored + "\n");
  }

  emitToolCall(event) {
    const display = formatToolCall(
      event.toolName,
      event.input,
      this.toolFormat,
    );
    const colored = applyToolCall(display, this.palette);
    process.stdout.write(`\n${colored}\n`);
  }

  emitToolResult(event) {
    if (this.hideTools) return;
    const colored = applyToolResult(
      formatToolResult(event.result, this.toolOutputFmt),
      this.palette,
    );
    process.stdout.write(`${colored}\n\n`);
  }

  emitCompacting(event) {
    const display = formatCompacting(event.messageCount, event.keepRecent);
    const colored = applyCompacting(display, this.palette);
    process.stdout.write(`\n${colored}\n\n`);
  }

  emitCommandResult(event) {
    process.stdout.write(
      applyFinalResponse(event.content, this.palette) + "\n",
    );
  }

  emitQuestion(event) {
    for (const q of event.questions) {
      process.stdout.write(`\n${applyFinalResponse(q.prompt, this.palette)}\n`);
      if (q.options) {
        for (let i = 0; i < q.options.length; i++) {
          process.stdout.write(`    [${i + 1}] ${q.options[i]}\n`);
        }
        if (q.allowOther) {
          process.stdout.write("[Other] Type your own answer\n");
        } else {
          process.stdout.write(
            `    Choose a number 1-${q.options.length} or type one of: ${JSON.stringify(q.options)}\n`,
          );
        }
      }
      if (q.default !== undefined) {
        process.stdout.write(`    (default: ${q.default})\n`);
      }
    }
  }

  emitStreamingChunk(event) {
    if (this.stream) {
      process.stdout.write(applyFinalResponse(event.content, this.palette));
    }
  }

  emitStreamingReasoningChunk(event) {
    if (this.hideThinking) return;
    // Thinking is streamed to stderr
    if (this.stream) {
      const colored = applyThinking(event.content, this.palette);
      process.stderr.write(colored);
    }
  }

  emitTaskProgress(event) {
    const display = formatTaskProgress(event.activeTasks, event.totalTasks);
    if (!display) return;
    const colored = applyProgress(display, this.palette);
    process.stdout.write(`\n[${colored}] \n`);
  }

  emitTokenUsage(event) {
    const display = formatTokenUsage(
      event.promptTokens,
      event.cachedTokens,
      event.completionTokens,
      event.totalTokens,
    );
    const colored = applyProgress(display, this.palette);
    process.stdout.write(`\n${colored}\n`);
  }

  emitSessionState(event) {
    // React to agent state changes emitted by the agent
    switch (event.key) {
      case "hideTools":
        this.hideTools = event.value;
        break;
      case "hideThinking":
        this.hideThinking = event.value;
        break;
    }
  }

  reset() {
    process.stdout.write("\x1b[0m\n");
  }
}
