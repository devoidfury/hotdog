// CLI output sink — formats and displays agent output with color support.

import {
  OutputSink,
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
} from "@core/context/output.ts";
import { toolContentText } from "@utils/tool-content.ts";
import { spoofSafe } from "@utils/spoof.ts";
import { summarizeToolArgs, firstLinePreview } from "@core/extensions/tool-utils.ts";
import type { ArgDisplay } from "@core/extensions/tool-registry.ts";
import {
  ColorPalette,
  applyThinking,
  applyToolCall,
  applyToolCallArgs,
  applyShellHighlight,
  applyArgKeyHighlight,
  applyToolResult,
  applyFinalResponse,
  applyCompacting,
  applyProgress,
  resolvePalette,
  colorDisabledByEnv,
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
  toolCallDisplayFormat?: string;
  toolOutputFmt?: string;
  palette?: ColorPalette;
  hideTools?: boolean;
  hideThinking?: boolean;
  hideUserMessage?: boolean;
  showTokenUse?: boolean;
  /**
   * Resolves a tool's per-parameter display hints (its metadata's
   * argDisplay). Unwired = plain summarization for every tool. The
   * interactive UI wires this from the tool registry so tools can declare
   * value folding (first-line previews) and syntax highlighters.
   */
  argDisplay?: (toolName: string) => Record<string, ArgDisplay> | undefined;
}

/**
 * Format a compacting message.
 */
export function formatCompacting(messageCount: number, keepRecent: number): string {
  return `Compacting: removed ${messageCount} messages, keeping ${keepRecent} recent`;
}

/**
 * Visual cue for an unconfigured tool-call line. Kept in the sink (not the
 * schema) so a schema default cannot shadow the CLI's own choice:
 * template > `prefix + name args`. The value matches the historic
 * `toolCallDisplayFormat: " 🔧 {} {}"` default, so an unset knob renders
 * exactly what that template rendered.
 */
const TOOL_CALL_PREFIX = " 🔧 ";

/** Rune cap on the raw preview of an in-flight call's unparseable partial args. */
const INFLIGHT_PREVIEW_RUNES = 80;

/** True if any of these argDisplay hints asks for the shell highlighter. */
function hasShellSyntax(argDisplay?: Record<string, ArgDisplay>): boolean {
  return argDisplay !== undefined && Object.values(argDisplay).some((h) => h.syntax === "shell");
}

/**
 * Sink-side value seam for tools whose argDisplay declares `syntax:
 * "shell"` (bash's command): single-line values ride the shell pass whole;
 * multi-line values arrive from the summarizer already preview-folded, and
 * here the preview half gets shell-lit with the size stub kept plain (a
 * `5` at shell-command position would light as a red command word). The
 * preview is recomputed from the raw value with the shared
 * firstLinePreview so policy lives once; hints without shell syntax pass
 * through.
 * The value arrives from an already-spoofed input (both call sites spoof
 * before parsing), so the segments it splices are ANSI-safe to wrap.
 */
function shellArgSeam(palette: ColorPalette, argDisplay: Record<string, ArgDisplay>) {
  return (key: string, rendered: string, value: unknown): string => {
    if (argDisplay[key]?.syntax !== "shell" || typeof value !== "string") return rendered;
    const lines = value.split("\n");
    if (lines.length === 1) return applyShellHighlight(rendered, palette);
    if (argDisplay[key]?.preview !== "first-line") return rendered;
    const { preview, stub } = firstLinePreview(value, lines);
    return `${applyShellHighlight(preview, palette)} ${stub}`;
  };
}

/**
 * The in-flight tool-call row for the split frame (streaming-call display):
 * the final tool-call line's shape (prefix + name + args summary) composed
 * without the sink's mode pipeline, so the line-wide tool_call color wraps
 * here instead of in _flushText. Args: once the streamed partial parses as
 * JSON it gets the SAME summarizer the committed line uses (the row morphs
 * into the final shape before the commit lands); an unparseable partial
 * folds to one single-line preview (newlines collapsed, rune-capped).
 * Same segment invariant as emitToolCall: spoofSafe before any ANSI
 * embedding; summarized keys read cyan for every tool, and `argDisplay`
 * (the tool's metadata hints, resolved by the caller) drives value folding
 * and the shell highlighter.
 */
export function inflightCallText(
  name: string,
  args: string,
  palette: ColorPalette,
  argDisplay?: Record<string, ArgDisplay>,
): string {
  const shell = hasShellSyntax(argDisplay);
  let argBody: string;
  try {
    JSON.parse(args);
    // Complete args: the committed line's summarizer and seams (only
    // shell-syntax values see the shell pass; preview folding comes from
    // the hints).
    argBody = summarizeToolArgs(
      spoofSafe(args),
      shell && argDisplay ? shellArgSeam(palette, argDisplay) : undefined,
      argDisplay,
    );
    argBody = applyArgKeyHighlight(argBody, palette);
  } catch {
    // Partial JSON: one-line preview. Raw JSON chrome is not shell text
    // (and not `k: v` summary shape either), so the fold rides plain.
    const runes = Array.from(args.replace(/\s+/g, " ").trim());
    argBody =
      runes.length > INFLIGHT_PREVIEW_RUNES
        ? `${runes.slice(0, INFLIGHT_PREVIEW_RUNES).join("")}\u2026`
        : runes.join("");
    argBody = spoofSafe(argBody);
  }
  const argSeg = applyToolCallArgs(argBody, palette);
  const body = argSeg === "" ? spoofSafe(name) : `${spoofSafe(name)} ${argSeg}`;
  return applyToolCall(`${TOOL_CALL_PREFIX}${body}`, palette);
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
  contextWindow: number,
): string {
  return `Token usage: ${sessionCachedTokens} cached, ${sessionPromptTokens} processed, ${sessionCompletionTokens} generated. (${sessionTotalTokens}/${contextWindow})`;
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
  toolCallDisplayFormat?: string;
  toolOutputFmt?: string;
  palette: ColorPalette;
  hideTools?: boolean;
  hideThinking?: boolean;
  hideUserMessage?: boolean;
  showTokenUse: boolean;
  argDisplay?: (toolName: string) => Record<string, ArgDisplay> | undefined;
  [key: string]: unknown;

  // ── Newline buffer for streaming output ────────────────────────────────
  #nlBuf: number;
  #textBuf: string;
  #outputMode: Mode | null;

  outStream: NodeJS.WriteStream;
  altStream: NodeJS.WriteStream;

  /**
   * Split renderer commit channel (design note §2 rubric 1), installed by the
   * ui-interactive-cli split bridge. Null = legacy mode: sink.log() falls back
   * to plain console.log, byte-identical to today's behavior.
   */
  logRouter: ((message: string) => void) | null = null;

  constructor(options: CliOutputSinkOptions = {}) {
    super();
    this.thinkerFormat = options.thinkerFormat || "[Thinking: {}]";
    this.toolCallDisplayFormat = options.toolCallDisplayFormat;
    this.toolOutputFmt = options.toolOutputFmt;
    this.palette = options.palette || ColorPalette.default();
    this.hideTools = options.hideTools;
    this.hideThinking = options.hideThinking;
    this.hideUserMessage = options.hideUserMessage;
    this.showTokenUse = options.showTokenUse !== false;
    this.argDisplay = options.argDisplay;

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
   * Permanent output row (banner, goodbye, shell-mode results, notices).
   * Legacy mode: plain console.log -- identical bytes and call shape.
   * Split mode: handed to the renderer as committed clean rows.
   */
  log(message: string): void {
    if (this.logRouter) {
      this.logRouter(message);
    } else {
      console.log(message);
    }
  }

  /**
   * Resolve a palette from CLI args, config, and theme.
   * NO_COLOR / TERM=dumb force a disabled palette regardless of config.
   */
  static async resolve(
    useColors: boolean,
    theme: string | null | undefined,
    configPalette: PaletteOptions | null | undefined,
  ): Promise<ColorPalette> {
    if (colorDisabledByEnv()) {
      return new ColorPalette({ use_colors: false });
    }
    return resolvePalette(theme, configPalette, null, useColors);
  }

  // Event dispatch is inherited from OutputSink.emit(); each event type is
  // routed to the emitXxx() overrides below.

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
    // Precedence: explicit user template (the schema carries no default for
    // toolCallDisplayFormat, so an unset option really means "user chose
    // nothing") > `TOOL_CALL_PREFIX + name + args`, which is byte-identical
    // to the historic " 🔧 {} {}" template default. The template is LAYOUT
    // only -- its args slot always carries the human-readable summary,
    // never raw JSON.
    // Segments get the spoof pass individually and the grey args wrap rides
    // AFTER it (spoofSafe neutralizes ESC); the line-wide tool_call color
    // lands later via the mode applier in _flushText. Summarized arg keys
    // read cyan for every tool. The tool's metadata argDisplay hints drive
    // value folding (preview: "first-line", resolved by the summarizer,
    // ANSI-free) and the sink-side shell highlighter (syntax: "shell",
    // shellArgSeam): shell tools spoof BEFORE parsing so the seam composes
    // from already-spoofed values; every other tool keeps the legacy
    // spoof-after-summarize byte path. Unparseable input passes through
    // plain. The key pass runs after the shell ANSI injected here (its
    // `(^| · ) key: ` anchors cannot match inside shell segments; both
    // passes are post-spoof).
    const hints = this.argDisplay?.(event.toolName);
    const shell = hasShellSyntax(hints);
    const summarized = shell
      ? summarizeToolArgs(spoofSafe(event.input), shellArgSeam(this.palette, hints!), hints)
      : spoofSafe(summarizeToolArgs(event.input, undefined, hints));
    const args = applyToolCallArgs(applyArgKeyHighlight(summarized, this.palette), this.palette);
    const text = this.toolCallDisplayFormat
      ? formatToolCall(spoofSafe(event.toolName), args, this.toolCallDisplayFormat)
      : formatToolCall(spoofSafe(event.toolName), args, `${TOOL_CALL_PREFIX}{} {}`);
    this._processContent(text);
  }

  override emitToolResult(event: ToolResultEvent): void {
    if (this.hideTools) return;
    this._transitionTo(Modes.ToolResult);
    // The event carries the stored content (harness text or a tool-result
    // part); the terminal decides how to show it.
    this._processContent(formatToolResult(toolContentText(event.content), this.toolOutputFmt || "{}"));
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
      this._processContent(`\n${applyFinalResponse(spoofSafe(q.prompt), this.palette)}\n`);
      if (q.options) {
        for (let i = 0; i < q.options.length; i++) {
          this._processContent(`    [${i + 1}] ${spoofSafe(q.options[i] ?? "")}\n`);
        }
        if (q.allowOther !== false) {
          this._processContent("[Other] Type your own answer\n");
        } else {
          this._processContent(
            spoofSafe(
              `    Choose a number 1-${q.options.length} or type one of: ${JSON.stringify(q.options)}\n`,
            ),
          );
        }
      }
      if (q.default !== undefined) {
        this._processContent(`    (default: ${spoofSafe(String(q.default))})\n`);
      }
    }
  }

  override emitStreamingChunk(event: StreamingChunkEvent): void {
    // Detect transition from reasoning → normal
    if (this.#outputMode !== Modes.Default) {
      this._transitionTo(Modes.Default);
    }
    this._processContent(event.content);
  }

  override emitStreamingReasoningChunk(event: StreamingReasoningChunkEvent): void {
    if (this.hideThinking) return;
    // Thinking is streamed to stderr
    // Detect transition from normal → reasoning
    if (this.#outputMode !== Modes.Thinking) {
      this._transitionTo(Modes.Thinking);
    }
    this._processContent(event.content);
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
      event.contextWindow,
    );
    this._processContent(display);
  }

  override emitSessionState(event: SessionStateEvent): void {
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
  }

  override reset(): void {
    this._flushNl();
    this.outStream.write("\x1b[0m\n");
  }
}
