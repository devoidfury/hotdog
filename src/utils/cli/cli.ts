// CLI output sink — formats and displays agent output with color support.

import {
  OutputSink,
  OUTPUT_EVENT,
  type OutputEvent,
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
  StreamResetEvent,
  TaskProgressEvent,
  TokenUsageEvent,
  SessionStateEvent,
  SystemMessageEvent,
} from "@core/context/output.ts";
import { toolContentMeta, toolContentSuccess, toolContentText } from "@utils/tool-content.ts";
import { resolveCliDiff, renderCliDiff } from "@utils/cli/diff-render.ts";
import { spoofSafe } from "@utils/spoof.ts";
import { summarizeToolArgs, firstLinePreview } from "@core/extensions/tool-utils.ts";
import type { ArgDisplay, ToolDisplaySpec } from "@core/extensions/tool-registry.ts";
import {
  ColorPalette,
  applyThinking,
  applyToolCall,
  applyToolCallArgs,
  applyShellHighlight,
  applyArgKeyHighlight,
  applyArgSeparator,
  applyToolResult,
  applyFinalResponse,
  applyCompacting,
  applyProgress,
  resolvePalette,
  colorDisabledByEnv,
  type PaletteOptions,
} from "./colors.ts";

export const Modes = {
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
  /**
   * Resolves a tool's declared display parts (its metadata's `display`). The
   * sibling of `argDisplay` one level up: where the hints fold a single
   * argument, a part declares what a whole call renders as -- today only
   * kind "diff" has a terminal renderer (the core write tools declare it), and
   * a tool that declares nothing keeps the generic result posture. The sink
   * never keys off a tool name. Unwired = every result renders generically.
   */
  display?: (toolName: string) => ToolDisplaySpec[] | undefined;
  /**
   * Markdown prose highlighting (split renderer only, wired by
   * ui-interactive-cli): Default-mode text is emitted spoof-neutralized and
   * otherwise RAW (no final_response wash) and the bridge paints whole lines
   * with the markdown tokenizer -- completed lines once at the newline commit, the in-flight row on every
   * frame repaint. Never set on the legacy/one-shot path (byte-identity).
   */
  markdownHighlight?: boolean;
  /** Output-mode transition observer (same wiring as markdownHighlight). */
  onOutputMode?: (mode: string) => void;
}

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

/**
 * The stream-reset marker: one line at the duplication point, printed when a
 * mid-stream retry retracts a dead attempt that actually showed bytes. A print
 * stream cannot retract scrollback, so the repeated prose stays -- this names
 * why. Constant text (spoof-safe by construction); both CLI sinks print this
 * exact line (legacy inline in the sink, the split bridge as a committed row),
 * so tests and notes can pin one string.
 */
export const STREAM_RETRY_MARKER = "-- stream failed mid-response; retrying --";

/** True if any of these argDisplay hints asks for the shell highlighter. */
function hasShellSyntax(argDisplay?: Record<string, ArgDisplay>): boolean {
  return argDisplay !== undefined && Object.values(argDisplay).some((h) => h.syntax === "shell");
}

/**
 * Sink-side value seam for tools whose argDisplay declares `syntax:
 * "shell"` (bash's command): single-line values ride the shell pass whole;
 * multi-line values arrive from the summarizer already preview-folded, and
 * here the preview half gets shell-lit with the size stub kept plain (a
 * `5` at shell-command position would light as a command word). The
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
 * embedding; summarized keys read the palette's `arg_key` color for every
 * tool, pair separators dim via `arg_separator`, and `argDisplay`
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
    argBody = applyArgSeparator(argBody, palette);
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
 * Fill `{}` slots positionally, one pass, LITERAL substitution.
 *
 * Two hazards, both model-authored bytes in the substituted value:
 *   - `$&`, `` $` ``, `$'` and `$$` are replace-pattern tokens. A file line
 *     containing `sed $&` would splice the template's own chrome (or the match)
 *     into the middle of the printed text, so what the terminal shows is not
 *     what the tool wrote -- and with a rendered diff that is ~40 rows of raw
 *     file content per call. The replacer-function form disables the tokens.
 *   - the old two-step fill re-scanned the already-substituted name, so a tool
 *     name containing `{}` swallowed the args slot. One pass over the format
 *     string cannot: substituted text is never re-read, and a `{}` past the
 *     last slot stays literal, as it did before.
 */
function fillSlots(fmt: string, ...slots: string[]): string {
  let i = 0;
  return fmt.replace(/\{\}/g, () => (i < slots.length ? slots[i++]! : "{}"));
}

export function formatToolCall(toolName: string, input: string, toolFmt: string): string {
  return fillSlots(toolFmt, toolName, input);
}

export function formatToolResult(result: string, toolOutputFmt: string): string {
  return fillSlots(toolOutputFmt, result);
}

export function formatTokenUsage(
  sessionPromptTokens: number,
  sessionCachedTokens: number,
  sessionCompletionTokens: number,
  sessionTotalTokens: number,
  contextWindow: number,
): string {
  return `Token usage: ${sessionCachedTokens} cached, ${sessionPromptTokens} processed, ${sessionCompletionTokens} generated. (${sessionTotalTokens}/${contextWindow})`;
}

export function formatThinking(content: string, thinkerFmt: string | null | undefined): string {
  if (thinkerFmt) {
    return fillSlots(thinkerFmt, content);
  }
  return `[Thinking: ${content}]`;
}

export function formatTaskProgress(activeTasks: number, totalTasks: number): string {
  if (activeTasks === 0) return "";
  if (totalTasks === 0) {
    return `${activeTasks} task${activeTasks === 1 ? "" : "s"} running`;
  }
  return `${activeTasks}/${totalTasks} tasks`;
}

/** Runes of a call's own result text kept under a rendered diff block. */
const RESULT_ENVELOPE_RUNES = 120;

/**
 * The tool's answer as ONE line under a diff block (which edit landed, how
 * many bytes): the diff is the change, the envelope is the fact that it
 * happened. Only the result's first line rides -- what follows it is the
 * `META:` block, and the one fact that carries (start_line) is already the
 * diff's gutter. HINTs are failure guidance (every shipped `withHint` is on an
 * error path), and failures never reach this posture: they keep the full
 * generic box, HINT included. Flat, rune-capped, spoofed last so a cap can
 * never split a `[U+XXXX]` token.
 */
function resultEnvelope(text: string): string {
  const flat = text.split("\n")[0]!.replace(/\s+/g, " ").trim();
  const runes = Array.from(flat);
  return spoofSafe(
    runes.length > RESULT_ENVELOPE_RUNES ? `${runes.slice(0, RESULT_ENVELOPE_RUNES).join("")}\u2026` : flat,
  );
}

/**
 * edit's `start_line` result meta as a positive integer, else undefined: the
 * same gate the wire applies before it lets the diff rails number from the
 * file rather than the snippet.
 */
function resultStartLine(content: ToolResultEvent["content"]): number | undefined {
  const n = Number(toolContentMeta(content, "start_line"));
  return Number.isInteger(n) && n > 0 ? n : undefined;
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
  display?: (toolName: string) => ToolDisplaySpec[] | undefined;
  /** Markdown split path: Default-mode text rides raw; the bridge paints. */
  markdownHighlight = false;
  /** Output-mode transition observer (set when markdownHighlight is on). */
  onOutputMode: ((mode: Mode) => void) | null = null;
  [key: string]: unknown;

  // ── Newline buffer for streaming output ────────────────────────────────
  #nlBuf: number;
  #textBuf: string;
  #outputMode: Mode | null;

  /**
   * True once the current streaming attempt has written real bytes to the
   * terminal (a prose/thinking flush; a pending newline is not yet visible).
   * Any printed row that is not stream bytes clears it -- those bytes settled
   * as live output and no later reset may claim them -- and emitStreamReset
   * consumes it: the marker prints exactly when the dead attempt showed
   * something the retry will duplicate.
   */
  #attemptFlushed: boolean;

  outStream: NodeJS.WriteStream;
  altStream: NodeJS.WriteStream;

  /**
   * Split renderer commit channel, installed by the
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
    this.display = options.display;
    this.markdownHighlight = options.markdownHighlight === true;
    this.onOutputMode = options.onOutputMode ?? null;

    // ── Newline buffer for streaming output ────────────────────────────────
    // Buffers trailing newlines to normalize spacing between reasoning and
    // normal output segments. Some models emit many trailing newlines, some
    // emit none — this ensures exactly 1 newline separates segments.
    this.#nlBuf = 0; // trailing newline buffer
    this.#textBuf = ""; // pending non-newline text (colored as batch)
    this.#outputMode = null; // for transition detection
    this.#attemptFlushed = false; // dead-bytes claim for the stream-reset marker

    this.outStream = process.stdout;
    this.altStream = process.stderr;
  }

  /**
   * Flush buffered newlines to the given stream.
   */
  _flushNl(): void {
    if (this.#nlBuf > 0) {
      const mode = this.#outputMode ?? Modes.Default;
      const stream =
        (this as Record<string, unknown>)[modeStreams[mode]] as NodeJS.WriteStream;
      stream.write("\n".repeat(this.#nlBuf));
      this.#nlBuf = 0;
      if (mode === Modes.Default || mode === Modes.Thinking) this.#attemptFlushed = true;
    }
  }

  /**
   * Flush the given text or pending text buffer to the given stream.
   */
  _flushText(): void {
    if (this.#textBuf) {
      const mode = this.#outputMode ?? Modes.Default;
      const stream =
        (this as Record<string, unknown>)[modeStreams[mode]] as NodeJS.WriteStream;
      const colorFn =
        // Markdown split path: Default-mode prose rides to the bridge with
        // only spoof neutralization (no wash); the bridge paints whole lines
        // (commit + live repaint). Neutralize HERE, at the render seam of the
        // model's bytes, not in the painter: the same out channel also
        // carries locally-generated rows (sink.log/uiOut during a Default
        // mode edge) whose ANSI is legitimate and must never be shredded.
        // Benign text passes through unchanged, so the live row and the
        // committed line spoof to identical bytes and the repaint skip holds.
        // Every other mode keeps its legacy wash.
        this.markdownHighlight && mode === Modes.Default
          ? (text: string): string => spoofSafe(text)
          : modeColorFns[mode];
      const colored = colorFn(this.#textBuf, this.palette);
      stream.write(colored);
      this.#textBuf = "";
      if (mode === Modes.Default || mode === Modes.Thinking) this.#attemptFlushed = true;
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
    // The split bridge's markdown painter follows the prose mode (v1: only
    // the Default mode carries assistant markdown).
    this.onOutputMode?.(mode);
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
  // routed to the emitXxx() overrides below -- with one bookkeeping rule
  // layered on top:

  /**
   * Any event that is not this attempt's own stream bytes -- and not the
   * invisible plumbing that renders nothing on this sink -- proves the last
   * printed segment settled as live output, so the stream-reset marker no
   * longer owns it (see #attemptFlushed / emitStreamReset). TOOL_CALL_DELTA
   * belongs to the in-flight attempt, and QUEUE_UPDATE / SESSION_STATE render
   * nothing here (frame rows and toggles, the base sink ignores both), so
   * none of them is a boundary.
   */
  override emit(event: OutputEvent): void {
    if (
      event.type !== OUTPUT_EVENT.STREAMING_CHUNK &&
      event.type !== OUTPUT_EVENT.STREAMING_REASONING_CHUNK &&
      event.type !== OUTPUT_EVENT.TOOL_CALL_DELTA &&
      event.type !== OUTPUT_EVENT.QUEUE_UPDATE &&
      event.type !== OUTPUT_EVENT.SESSION_STATE &&
      event.type !== OUTPUT_EVENT.STREAM_RESET
    ) {
      this.#attemptFlushed = false;
    }
    super.emit(event);
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
    // `(^| · ) key: ` anchors cannot match inside shell segments; the
    // separator dim runs last, once no anchor needs the bare ` · `; all
    // passes are post-spoof).
    const hints = this.argDisplay?.(event.toolName);
    const shell = hasShellSyntax(hints);
    const summarized = shell
      ? summarizeToolArgs(spoofSafe(event.input), shellArgSeam(this.palette, hints!), hints)
      : spoofSafe(summarizeToolArgs(event.input, undefined, hints));
    const args = applyToolCallArgs(
      applyArgSeparator(applyArgKeyHighlight(summarized, this.palette), this.palette),
      this.palette,
    );
    const text = this.toolCallDisplayFormat
      ? formatToolCall(spoofSafe(event.toolName), args, this.toolCallDisplayFormat)
      : formatToolCall(spoofSafe(event.toolName), args, `${TOOL_CALL_PREFIX}{} {}`);
    this._processContent(text);
  }

  override emitToolResult(event: ToolResultEvent): void {
    if (this.hideTools) return;
    this._transitionTo(Modes.ToolResult);
    // The event carries the stored content (harness text or a tool-result
    // part) and the call's args; the terminal decides how to show it. A tool
    // that DECLARES a kind "diff" part gets the change itself: the folded
    // args preview and a size-confirmation envelope never said what moved,
    // and the declaration (never a tool-name table) is what opts a call in.
    // The gate is POSITIVE: the part must attest the call succeeded. Failure
    // reaches the sink in too many shapes to recognize by absence -- a thrown
    // tool error, a gate block and a handled verdict all land as
    // {status:"error", error:null, output:<failure text}> (formatToolResult),
    // ToolResult.err() lands as {status:"failure", error:...}, and the
    // harness's own failures are bare strings ("Parameter validation error:",
    // "Skipped due to maxToolCallsPerIteration limit (N)",
    // "[skipped: loop stop requested]", "Tool execution failed: ..."). A denied
    // or failed write showing its diff with the real path and gutter as if it
    // landed is the worst thing this surface can print, so anything that is not
    // an attested success keeps the generic box (which also keeps the tool's
    // HINT line). Undeclared tools, unknown kinds and missing arg keys skip in
    // the resolver for the same effect: today's behavior is the fallback.
    // The block rides the same toolOutputFmt box and the same mode pipeline as
    // any other result: legacy stdout and the split bridge's commit channel
    // both see one multi-line text, as before.
    const diff = resolveCliDiff(this.display?.(event.toolName), event.input, {
      failed: event.error !== undefined || !toolContentSuccess(event.content),
      startLine: resultStartLine(event.content),
    });
    let text: string;
    if (diff) {
      const envelope = resultEnvelope(toolContentText(event.content));
      text = renderCliDiff(diff, { palette: this.palette });
      // The tool's own answer keeps the result color the generic box would
      // have given it (the block's rows each close their own SGR, so nothing
      // inherits it).
      if (envelope !== "") text += "\n" + applyToolResult(envelope, this.palette);
    } else {
      text = toolContentText(event.content);
    }
    this._processContent(formatToolResult(text, this.toolOutputFmt || "{}"));
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

  override emitStreamReset(_event: StreamResetEvent): void {
    // The transport re-issued the request after a mid-stream failure: the
    // dead attempt's buffering is dead formatting. Drop the pending
    // separator newlines it left behind and reset transition detection so
    // the retry's first segment starts from a clean mode boundary. Bytes
    // already written to the terminal live in scrollback and cannot be
    // retracted -- that is the honest, accepted ceiling of a print stream;
    // the assembled response never contains them (the processor cleared it).
    const deadShown = this.#attemptFlushed;
    this.#attemptFlushed = false;
    this.#nlBuf = 0;
    this.#outputMode = null;
    // The duplication point: when the dead attempt actually flushed bytes,
    // print one marker line so the retry's re-streamed prose is explained
    // rather than mysterious. Legacy surface only: a split session (logRouter
    // installed) commits the same line from the bridge's own honest signal
    // (split-bridge.ts resetStream), and printing from both would double it.
    // Direct write, not the newline pipeline: the dead attempt's trailing
    // separator was just (deliberately) dropped, so the marker starts right
    // after the dead bytes on that line and its own terminator closes it
    // before the retry streams; the separator-drop contract (no buffered "\n"
    // surviving a reset) is untouched.
    if (deadShown && this.logRouter === null) {
      this.altStream.write(` ${applyCompacting(STREAM_RETRY_MARKER, this.palette)}\n`);
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
