// CLI output sink — formats and displays agent output with color support.

import { OutputSink, OUTPUT_EVENT } from "../context/output.js";
import { DEFAULT_TOOL_FMT, DEFAULT_TOOL_OUTPUT_FMT } from "../config.js";
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
  return `(tokens cached:${cachedTokens} prompt:${promptTokens} completion:${completionTokens} total:${totalTokens})`;
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
    this.toolOutputFormat = options.toolOutputFormat || DEFAULT_TOOL_OUTPUT_FMT;
    this.palette = options.palette || ColorPalette.default();
    this.hideTools = options.hideTools;
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
  static resolve(useColors, theme, configPalette) {
    return resolvePalette(theme, configPalette, null, useColors);
  }

  emit(event) {
    switch (event.type) {
      case OUTPUT_EVENT.USER_MESSAGE:
        this.emitUserMessage(event.content);
        break;
      case OUTPUT_EVENT.ASSISTANT_MESSAGE:
        this.emitAssistantMessage(event.content);
        break;
      case OUTPUT_EVENT.THINKING:
        this.emitThinking(event.content);
        break;
      case OUTPUT_EVENT.TOOL_CALL:
        this.emitToolCall(event.toolName, event.input, event.toolCallId);
        break;
      case OUTPUT_EVENT.TOOL_RESULT:
        this.emitToolResult(event.toolName, event.input, event.result);
        break;
      case OUTPUT_EVENT.COMPACTING:
        this.emitCompacting(event.messageCount, event.keepRecent);
        break;
      case OUTPUT_EVENT.COMMAND_RESULT:
        this.emitCommandResult(event.content);
        break;
      case OUTPUT_EVENT.QUESTION:
        this.emitQuestion(event.questions);
        break;
      case OUTPUT_EVENT.STREAMING_CHUNK:
        this.emitStreamingChunk(event.content);
        break;
      case OUTPUT_EVENT.STREAMING_REASONING_CHUNK:
        this.emitStreamingReasoningChunk(event.content);
        break;
      case OUTPUT_EVENT.TASK_PROGRESS:
        this.emitTaskProgress(event.activeTasks, event.totalTasks);
        break;
      case OUTPUT_EVENT.TOKEN_USAGE:
        this.emitTokenUsage(
          event.promptTokens,
          event.cachedTokens,
          event.completionTokens,
          event.totalTokens,
        );
        break;
    }
  }

  emitUserMessage(content) {
    process.stdout.write(`\n${content}\n\n`);
  }

  emitAssistantMessage(content) {
    process.stdout.write(applyFinalResponse(content, this.palette));
  }

  emitThinking(content) {
    // Thinking is streamed to stderr
    const formatted = formatThinking(content, this.thinkerFormat);
    const colored = applyThinking(formatted, this.palette);
    process.stderr.write(colored + "\n");
  }

  emitToolCall(toolName, input, toolCallId) {
    const display = formatToolCall(toolName, input, this.toolFormat);
    const colored = applyToolCall(display, this.palette);
    process.stdout.write(`\n${colored}\n`);
  }

  emitToolResult(toolName, input, result) {
    if (this.hideTools) return;
    const colored = applyToolResult(
      formatToolResult(result, this.toolOutputFormat),
      this.palette,
    );
    process.stdout.write(`${colored}\n\n`);
  }

  emitCompacting(messageCount, keepRecent) {
    const display = formatCompacting(messageCount, keepRecent);
    const colored = applyCompacting(display, this.palette);
    process.stdout.write(`\n${colored}\n\n`);
  }

  emitCommandResult(content) {
    process.stdout.write(applyFinalResponse(content, this.palette) + "\n");
  }

  emitQuestion(questions) {
    for (const q of questions) {
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

  emitStreamingChunk(content) {
    if (this.stream) {
      process.stdout.write(applyFinalResponse(content, this.palette));
    }
  }

  emitStreamingReasoningChunk(content) {
    // Thinking is streamed to stderr
    if (this.stream) {
      const colored = applyThinking(content, this.palette);
      process.stderr.write(colored);
    }
  }

  emitTaskProgress(activeTasks, totalTasks) {
    const display = formatTaskProgress(activeTasks, totalTasks);
    if (!display) return;
    const colored = applyProgress(display, this.palette);
    process.stdout.write(`\n[${colored}] \n`);
  }

  emitTokenUsage(promptTokens, cachedTokens, completionTokens, totalTokens) {
    const display = formatTokenUsage(
      promptTokens,
      cachedTokens,
      completionTokens,
      totalTokens,
    );
    const colored = applyProgress(display, this.palette);
    process.stdout.write(`\n${colored}\n`);
  }

  reset() {
    process.stdout.write("\x1b[0m\n");
  }
}
