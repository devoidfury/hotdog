// CLI output sink — formats and displays agent output with color support.

import {
  OutputSink,
  OUTPUT_EVENT,
  OutputEvent,
  UserMessageEvent,
  AssistantMessageEvent,
  ThinkingEvent,
  ToolCallEvent,
  ToolResultEvent,
  CompactingEvent,
  CommandResultEvent,
  QuestionEvent,
  StreamingChunkEvent,
  StreamingReasoningChunkEvent,
  TaskProgressEvent,
  TokenUsageEvent,
  SessionStateEvent,
  SystemMessageEvent,
} from "../../core/context/output.ts";
import {
  ColorPalette,
  applyThinking,
  applyToolCall,
  applyToolResult,
  applyFinalResponse,
  applyCompacting,
  applyProgress,
  resolvePalette,
  type PaletteOptions,
} from "./colors.ts";

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
} as const;

type Mode = (typeof Modes)[keyof typeof Modes];

const modeColorFns: Record<Mode, (text: string, palette: ColorPalette) => string> = {
  [Modes.Default]: applyFinalResponse,
  [Modes.Progress]: applyProgress,
  [Modes.Question]: (text: string) => text,
  [Modes.System]: applyCompacting,
  [Modes.Thinking]: applyThinking,
  [Modes.Token]: (text: string) => text,
  [Modes.ToolCall]: applyToolCall,
  [Modes.ToolResult]: applyToolResult,
  [Modes.User]: (text: string) => text,
};

const modeStreams: Record<Mode, string> = {
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

export interface CliOutputSinkOptions {
  thinkerFormat?: string;
  toolFormat?: string;
  toolOutputFmt?: string;
  palette?: ColorPalette;
  hideTools?: boolean;
  hideThinking?: boolean;
  hideUserMessage?: boolean;
  showTokenUse?: boolean;
  stream?: boolean;
}

/**
 * Format a compacting message.
 */
export function formatCompacting(messageCount: number, keepRecent: number): string {
  return `Compacting: removed ${messageCount} messages, keeping ${keepRecent} recent`;
}

/**
 * Format a tool call display using the tool formatter.
 */
export function formatToolCall(toolName: string, input: string, toolFmt: string): string {
  return toolFmt.replace("{}", toolName).replace("{}", input);
}

/**
 * Format a tool result display using the tool output formatter.
 */
export function formatToolResult(result: string, toolOutputFmt: string): string {
  return toolOutputFmt.replace("{}", result);
}

/**
 * Format token usage display.
 */
export function formatTokenUsage(
  sessionPromptTokens: number,
  sessionCachedTokens: number,
  sessionCompletionTokens: number,
  sessionTotalTokens: number,
): string {
  return `(tokens cached:${sessionCachedTokens} prompt:${sessionPromptTokens} completion:${sessionCompletionTokens} total:${sessionTotalTokens})`;
}

/**
 * Format a thinking message using the thinker formatter.
 */
export function formatThinking(content: string, thinkerFmt: string | null | undefined): string {
  if (thinkerFmt) {
    return thinkerFmt.replace("{}", content);
  }
  return `[Thinking: ${content}]`;
}

/**
 * Format task progress display.
 */
export function formatTaskProgress(activeTasks: number, totalTasks: number): string {
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
  thinkerFormat: string;
  toolFormat?: string;
  toolOutputFmt?: string;
  palette: ColorPalette;
  hideTools?: boolean;
  hideThinking?: boolean;
  hideUserMessage?: boolean;
  showTokenUse: boolean;
  [key: string]: unknown;

  // ── Newline buffer for streaming output ────────────────────────────────
  #nlBuf: number;
  #textBuf: string;
  #outputMode: Mode | null;

  outStream: NodeJS.WriteStream;
  altStream: NodeJS.WriteStream;

  constructor(options: CliOutputSinkOptions = {}) {
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
    this.#nlBuf = 0; // trailing newline buffer
    this.#textBuf = ""; // pending non-newline text (colored as batch)
    this.#outputMode = null; // for transition detection

    this.outStream = process.stdout;
    this.altStream = process.stderr;
  }

  /**
   * Flush buffered newlines to the given stream.
   */
  _flushNl(): void {
    if (this.#nlBuf > 0) {
      const stream =
        (this as Record<string, unknown>)[modeStreams[this.#outputMode ?? Modes.Default]] as NodeJS.WriteStream;
      stream.write("\n".repeat(this.#nlBuf));
      this.#nlBuf = 0;
    }
  }

  /**
   * Flush the given text or pending text buffer to the given stream.
   */
  _flushText(): void {
    if (this.#textBuf) {
      const stream =
        (this as Record<string, unknown>)[modeStreams[this.#outputMode ?? Modes.Default]] as NodeJS.WriteStream;
      const colorFn =
        modeColorFns[this.#outputMode ?? Modes.Default];
      const colored = colorFn(this.#textBuf, this.palette);
      stream.write(colored);
      this.#textBuf = "";
    }
  }

  /**
   * Write to output / process streaming content and handle leading/trailing newlines.
   */
  _processContent(content: string): void {
    let startContent: number;
    let endContent: number;

    for (endContent = content.length; endContent > 0; endContent--) {
      if (content[endContent - 1] !== "\n") break;
    }

    for (startContent = 0; startContent < endContent; startContent++) {
      if (content[startContent] !== "\n") break;
    }

    if (startContent > 0) {
      this.#nlBuf += startContent;
    }

    if (endContent - startContent > 0) {
      this._flushNl();
      this.#textBuf += content.substring(startContent, endContent);
      this._flushText();
    }

    const trailingNewlines = content.length - endContent;
    if (trailingNewlines > 0) {
      this.#nlBuf += trailingNewlines;
    }
  }

  /**
   * Called when the streaming mode changes (reasoning ↔ normal).
   * Flushes any pending text, then resets the newline buffer to contain
   * exactly one newline so the next segment gets a clean single-line separator.
   */
  _transitionTo(mode: Mode): void {
    const hadPreviousMode = this.#outputMode !== null;
    this.#outputMode = mode;
    // Only add a separator newline when transitioning between modes,
    // not on the very first call when there's no previous segment.
    this.#nlBuf = hadPreviousMode ? 1 : 0;
    this.#textBuf = "";
  }

  /**
   * Resolve and set a color palette.
   */
  setPalette(palette: ColorPalette): void {
    this.palette = palette;
  }

  /**
   * Resolve a palette from CLI args, config, and theme.
   */
  static async resolve(
    useColors: boolean,
    theme: string | null | undefined,
    configPalette: PaletteOptions | null | undefined,
  ): Promise<ColorPalette> {
    return resolvePalette(theme, configPalette, null, useColors);
  }

  override emit(event: OutputEvent): void {
    switch (event.type) {
      case OUTPUT_EVENT.USER_MESSAGE:
        this.emitUserMessage(event);
        break;
      case OUTPUT_EVENT.ASSISTANT_MESSAGE:
        this.emitAssistantMessage(event);
        break;
      case OUTPUT_EVENT.THINKING:
        this.emitThinking(event);
        break;
      case OUTPUT_EVENT.TOOL_CALL:
        this.emitToolCall(event);
        break;
      case OUTPUT_EVENT.TOOL_RESULT:
        this.emitToolResult(event);
        break;
      case OUTPUT_EVENT.COMPACTING:
        this.emitCompacting(event);
        break;
      case OUTPUT_EVENT.COMMAND_RESULT:
        this.emitCommandResult(event);
        break;
      case OUTPUT_EVENT.QUESTION:
        this.emitQuestion(event);
        break;
      case OUTPUT_EVENT.STREAMING_CHUNK:
        this.emitStreamingChunk(event);
        break;
      case OUTPUT_EVENT.STREAMING_REASONING_CHUNK:
        this.emitStreamingReasoningChunk(event);
        break;
      case OUTPUT_EVENT.TASK_PROGRESS:
        this.emitTaskProgress(event);
        break;
      case OUTPUT_EVENT.TOKEN_USAGE:
        this.emitTokenUsage(event);
        break;
      case OUTPUT_EVENT.SESSION_STATE:
        this.emitSessionState(event);
        break;
      case OUTPUT_EVENT.SYSTEM_MESSAGE:
        this.emitSystemMessage(event);
        break;
    }
  }

  override emitUserMessage(event: UserMessageEvent): void {
    if (this.hideUserMessage) return;
    this._transitionTo(Modes.User);
    this._processContent(event.content);
  }

  override emitAssistantMessage(event: AssistantMessageEvent): void {
    this._transitionTo(Modes.Default);
    this._processContent(event.content);
  }

  override emitThinking(event: ThinkingEvent): void {
    if (this.hideThinking) return;
    this._transitionTo(Modes.Thinking);
    this._processContent(formatThinking(event.content, this.thinkerFormat));
  }

  override emitToolCall(event: ToolCallEvent): void {
    this._transitionTo(Modes.ToolCall);
    this._processContent(
      formatToolCall(event.toolName, event.input, this.toolFormat || "{}: {}"),
    );
  }

  override emitToolResult(event: ToolResultEvent): void {
    if (this.hideTools) return;
    this._transitionTo(Modes.ToolResult);
    this._processContent(formatToolResult(event.result, this.toolOutputFmt || "{}"));
  }

  override emitCompacting(event: CompactingEvent): void {
    const display = event.message || "Compacting context...";
    this._transitionTo(Modes.System);
    this._processContent(`${display}\n-----------`);
  }

  override emitCommandResult(event: CommandResultEvent): void {
    this._transitionTo(Modes.System);
    this._processContent(event.content);
  }

  override emitQuestion(event: QuestionEvent): void {
    if (this.hideUserMessage) return;
    this._transitionTo(Modes.Question);
    for (const q of event.questions) {
      this._processContent(`\n${applyFinalResponse(q.prompt, this.palette)}\n`);
      if (q.options) {
        for (let i = 0; i < q.options.length; i++) {
          this._processContent(`    [${i + 1}] ${q.options[i]}\n`);
        }
        if (q.allow_other) {
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

  override emitStreamingChunk(event: StreamingChunkEvent): void {
    if (this.stream) {
      // Detect transition from reasoning → normal
      if (this.#outputMode !== Modes.Default) {
        this._transitionTo(Modes.Default);
      }
      this._processContent(event.content);
    }
  }

  override emitStreamingReasoningChunk(event: StreamingReasoningChunkEvent): void {
    if (this.hideThinking) return;
    // Thinking is streamed to stderr
    if (this.stream) {
      // Detect transition from normal → reasoning
      if (this.#outputMode !== Modes.Thinking) {
        this._transitionTo(Modes.Thinking);
      }
      this._processContent(event.content);
    }
  }

  override emitTaskProgress(event: TaskProgressEvent): void {
    // TaskProgressEvent doesn't have activeTasks/totalTasks — use message if available
    const display = event.message || "";
    if (!display) return;
    this._transitionTo(Modes.Progress);
    this._processContent(`[${applyProgress(display, this.palette)}]`);
  }

  override emitTokenUsage(event: TokenUsageEvent): void {
    if (!this.showTokenUse) return;
    this._transitionTo(Modes.Progress);
    const display = formatTokenUsage(
      event.promptTokens,
      event.cachedTokens,
      event.completionTokens,
      event.totalTokens,
    );
    this._processContent(display);
  }

  override emitSessionState(event: SessionStateEvent): void {
    // React to agent state changes emitted by the agent
    switch (event.key) {
      case "hideTools":
        this.hideTools = event.value as boolean;
        break;
      case "hideThinking":
        this.hideThinking = event.value as boolean;
        break;
    }
  }

  override emitSystemMessage(event: SystemMessageEvent): void {
    this._transitionTo(Modes.System);
    this._processContent(`${applyCompacting(event.content, this.palette)}\n`);
    if (event.detail) {
      this._processContent(
        `${applyCompacting("> " + event.detail.split("\n").join("\n> "), this.palette)}\n`,
      );
    }
  }

  override reset(): void {
    this._flushNl();
    this.outStream.write("\x1b[0m\n");
  }
}
