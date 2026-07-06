// CLI output sink — formats and displays agent output with color support.

import { OutputSink, OUTPUT_EVENT, EVENT_HANDLERS } from "../context/output.js";
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

const Modes = {
  Default: "default",
  Question: "question",
  Progress: "progress",
  System: "system",
  Token: "token",
  ToolCall: "toolCall",
  ToolResult: "toolResult",
  Thinking: "thinking",
  User: "user",
};

const modeColorFns = {
  [Modes.Default]: applyFinalResponse,
  [Modes.Progress]: applyProgress,
  [Modes.Question]: (text) => text,
  [Modes.System]: applyCompacting,
  [Modes.Thinking]: applyThinking,
  [Modes.Token]: (text) => text,
  [Modes.ToolCall]: applyToolCall,
  [Modes.ToolResult]: applyToolResult,
  [Modes.User]: (text) => text,
};

const modeStreams = {
  [Modes.Default]: "outStream",
  [Modes.Progress]: "altStream",
  [Modes.Question]: "outStream",
  [Modes.Token]: "altStream",
  [Modes.System]: "altStream",
  [Modes.Thinking]: "altStream",
  [Modes.ToolCall]: "outStream",
  [Modes.ToolResult]: "outStream",
  [Modes.User]: "outStream",
};

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
  return toolFmt.replace("{}", toolName).replace("{}", input);
}

/**
 * Format a tool result display using the tool output formatter.
 */
export function formatToolResult(result, toolOutputFmt) {
  return toolOutputFmt.replace("{}", result);
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
  return `(tokens cached:${cachedTokens} prompt:${promptTokens} completion:${completionTokens} total:${totalTokens})\n`;
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
    this.toolFormat = options.toolFormat;
    this.toolOutputFmt = options.toolOutputFmt;
    this.palette = options.palette || ColorPalette.default();
    this.hideTools = options.hideTools;
    this.hideThinking = options.hideThinking;
    this.hideUserMessage = options.hideUserMessage;
    this.showTokenUse = options.showTokenUse !== false;

    // ── Newline buffer for streaming output ────────────────────────────────
    // Buffers trailing newlines to normalize spacing between reasoning and
    // normal output segments. Some models emit many trailing newlines, some
    // emit none — this ensures exactly 1 newline separates segments.
    this._nlBuf = 0; // trailing newline buffer
    this._textBuf = ""; // pending non-newline text (colored as batch)
    this._outputMode = null; // for transition detection

    this.outStream = process.stdout;
    this.altStream = process.stderr;
  }

  /**
   * Flush buffered newlines to the given stream.
   */
  _flushNl() {
    if (this._nlBuf > 0) {
      const stream =
        this[modeStreams[this._outputMode] ?? modeStreams[Modes.Default]];
      stream.write("\n".repeat(this._nlBuf));
      this._nlBuf = 0;
    }
  }

  /**
   * Flush the given text or pending text buffer to the given stream.
   */
  _flushText() {
    if (this._textBuf) {
      const stream =
        this[modeStreams[this._outputMode] ?? modeStreams[Modes.Default]];
      const colorFn =
        modeColorFns[this._outputMode] ?? modeColorFns[Modes.Default];
      const colored = colorFn(this._textBuf, this.palette);
      stream.write(colored);
      this._textBuf = "";
    }
  }

  /**
   * Write to output / process streaming content and handle leading/trailing newlines.
   */
  _processContent(content) {
    let startContent, endContent;

    for (endContent = content.length; endContent > 0; endContent--) {
      if (content[endContent - 1] !== "\n") break;
    }

    for (startContent = 0; startContent < endContent; startContent++) {
      if (content[startContent] !== "\n") break;
    }

    if (startContent > 0) {
      this._nlBuf += startContent;
    }

    if (endContent - startContent > 0) {
      this._flushNl();
      this._textBuf += content.substring(startContent, endContent + 1);
      this._flushText();
    }

    const trailingNewlines = content.length - endContent;
    if (trailingNewlines > 0) {
      this._nlBuf += trailingNewlines;
    }
  }

  /**
   * Called when the streaming mode changes (reasoning ↔ normal).
   * Flushes any pending text, then resets the newline buffer to contain
   * exactly one newline so the next segment gets a clean single-line separator.
   */
  _transitionTo(mode) {
    const hadPreviousMode = this._outputMode !== null;
    this._outputMode = mode;
    // Only add a separator newline when transitioning between modes,
    // not on the very first call when there's no previous segment.
    this._nlBuf = hadPreviousMode ? 1 : 0;
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
    if (this.hideUserMessage) return;
    this._transitionTo(Modes.User);
    this._processContent(event.content);
  }

  emitAssistantMessage(event) {
    this._transitionTo(Modes.Default);
    this._processContent(event.content);
  }

  emitThinking(event) {
    if (this.hideThinking) return;
    this._transitionTo(Modes.Thinking);
    this._processContent(formatThinking(event.content, this.thinkerFormat));
  }

  emitToolCall(event) {
    this._transitionTo(Modes.ToolCall);
    this._processContent(
      formatToolCall(event.toolName, event.input, this.toolFormat),
    );
  }

  emitToolResult(event) {
    if (this.hideTools) return;
    this._transitionTo(Modes.ToolResult);
    this._processContent(formatToolResult(event.result, this.toolOutputFmt));
  }

  emitCompacting(event) {
    const display = formatCompacting(event.messageCount, event.keepRecent);
    this._transitionTo(Modes.System);
    this._processContent(`${display}\n-----------`);
  }

  emitCommandResult(event) {
    this._transitionTo(Modes.System);
    this._processContent(event.content);
  }

  emitQuestion(event) {
    if (this.hideUserMessage) return;
    this._transitionTo(Modes.Question);
    for (const q of event.questions) {
      this._processContent(`\n${applyFinalResponse(q.prompt, this.palette)}\n`);
      if (q.options) {
        for (let i = 0; i < q.options.length; i++) {
          this._processContent(`    [${i + 1}] ${q.options[i]}\n`);
        }
        if (q.allowOther) {
          this._processContent("[Other] Type your own answer\n");
        } else {
          this._processContent(
            `    Choose a number 1-${q.options.length} or type one of: ${JSON.stringify(q.options)}\n`,
          );
        }
      }
      if (q.default !== undefined) {
        this._processContent(`    (default: ${q.default})\n`);
      }
    }
  }

  emitStreamingChunk(event) {
    if (this.stream) {
      // Detect transition from reasoning → normal
      if (this._outputMode !== Modes.Default) {
        this._transitionTo(Modes.Default);
      }
      this._processContent(event.content);
    }
  }

  emitStreamingReasoningChunk(event) {
    if (this.hideThinking) return;
    // Thinking is streamed to stderr
    if (this.stream) {
      // Detect transition from normal → reasoning
      if (this._outputMode !== Modes.Thinking) {
        this._transitionTo(Modes.Thinking);
      }
      this._processContent(event.content);
    }
  }

  emitTaskProgress(event) {
    const display = formatTaskProgress(event.activeTasks, event.totalTasks);
    if (!display) return;
    this._transitionTo(Modes.Progress);
    this._processContent(`[${applyProgress(display, this.palette)}]`);
  }

  emitTokenUsage(event) {
    if (!this.showTokenUse) return;
    this._transitionTo(Modes.Progress);
    const display = formatTokenUsage(
      event.lastPromptTokens,
      event.lastCachedTokens,
      event.lastCompletionTokens,
      event.lastTotalTokens,
    );
    this._processContent(display);
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
    this._flushNl();
    this.outStream.write("\x1b[0m\n");
  }
}
