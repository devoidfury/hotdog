// CLI output sink — formats and displays agent output with color support.

import { OutputSink, OUTPUT_EVENT, EVENT_HANDLERS } from "../context/output.js";
import {
  DEFAULT_TOOL_FMT,
  DEFAULT_TOOL_OUTPUT_FMT,
} from "../config/defaults.js";
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

    // ── Newline buffer for streaming output ────────────────────────────────
    // Buffers trailing newlines to normalize spacing between reasoning and
    // normal output segments. Some models emit many trailing newlines, some
    // emit none — this ensures exactly 1 newline separates segments.
    this._nlBuf = []; // trailing newline buffer (max N)
    this._maxNlBuf = 3; // max newlines to hold
    this._textBuf = ""; // pending non-newline text (colored as batch)
    this._streamMode = null; // 'reasoning' | 'normal' | null — for transition detection
  }

  /**
   * Flush buffered newlines to the given stream.
   */
  _flushNl(stream) {
    for (const nl of this._nlBuf) {
      stream.write(nl);
    }
    this._nlBuf = [];
  }

  /**
   * Flush the pending text buffer (colored) to the given stream.
   */
  _flushText(stream, colorFn) {
    if (this._textBuf) {
      stream.write(colorFn(this._textBuf, this.palette));
      this._textBuf = "";
    }
  }

  /**
   * Process streaming content character by character through the newline buffer.
   *
   * Newlines go to _nlBuf; non-newline chars flush the newline buffer first,
   * then accumulate in _textBuf for batched coloring. At the end of the content,
   * any remaining _textBuf is flushed.
   */
  _processContent(content, stream, colorFn) {
    for (let i = 0; i < content.length; i++) {
      const ch = content[i];
      if (ch === "\n") {
        // Flush any pending text first, then buffer the newline
        this._flushText(stream, colorFn);
        if (this._nlBuf.length < this._maxNlBuf) {
          this._nlBuf.push(ch);
        }
      } else {
        // Non-newline: flush buffered newlines, then accumulate text
        this._flushNl(stream);
        this._textBuf += ch;
      }
    }
    // Flush remaining text buffer (in case content ends with non-newline)
    this._flushText(stream, colorFn);
  }

  /**
   * Called when the streaming mode changes (reasoning ↔ normal).
   * Flushes any pending text, then resets the newline buffer to contain
   * exactly one newline so the next segment gets a clean single-line separator.
   */
  _transitionTo(mode) {
    const hadPreviousMode = this._streamMode !== null;
    this._streamMode = mode;
    // Only add a separator newline when transitioning between modes,
    // not on the very first call when there's no previous segment.
    this._nlBuf = hadPreviousMode ? ["\n"] : [];
    this._textBuf = "";
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
    this._flushNl(process.stdout);
    this._flushText(process.stdout, applyFinalResponse);
    process.stdout.write(`${event.content}\n`);
  }

  emitAssistantMessage(event) {
    // Flush any remaining buffered newlines before printing the final message
    this._flushNl(process.stdout);
    this._flushText(process.stdout, applyFinalResponse);
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
    process.stdout.write(`\n${colored}`);
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
    this._flushNl(process.stdout);
    this._flushText(process.stdout, applyFinalResponse);
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
      // Detect transition from reasoning → normal
      if (this._streamMode !== "normal") {
        this._transitionTo("normal");
      }
      this._processContent(event.content, process.stdout, applyFinalResponse);
    }
  }

  emitStreamingReasoningChunk(event) {
    if (this.hideThinking) return;
    // Thinking is streamed to stderr
    if (this.stream) {
      // Detect transition from normal → reasoning
      if (this._streamMode !== "reasoning") {
        this._transitionTo("reasoning");
      }
      this._processContent(event.content, process.stderr, applyThinking);
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
    this._flushNl(process.stdout);
    this._flushText(process.stdout, applyFinalResponse);
    process.stdout.write("\x1b[0m\n");
  }
}
