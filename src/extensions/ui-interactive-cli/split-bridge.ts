// Split-mode bridge: the wiring between the renderer core
// (src/utils/cli/renderer) and the interactive CLI.
//
// This file owns POLICY-FREE plumbing only: mount decision, line framing of
// the routed channels, the readline capture stream (kept as a bridge-level
// capability; the editor-input swap means the interactive session no longer
// constructs readline at all, so on a mounted session the editor path is the
// only frame source), the editor input mount, and process-level
// install/restore. Every terminal byte goes through the core's TerminalModes
// (teardown.ts is the sole byte home); the bridge never embeds
// ?2026/?2004/?25/raw sequences itself.

import { EventEmitter } from "node:events";
import { formatError } from "@core/error.ts";
import { STREAM_RETRY_MARKER } from "@utils/cli/cli.ts";
import { applyMarkdown, type ColorPalette } from "@utils/cli/colors.ts";
import {
  newMdStreamState,
  tokenizeMarkdownLine,
  tokenizeMarkdownLive,
  type MdStreamState,
} from "@utils/syntax/markdown.ts";
import { RendererCore } from "@utils/cli/renderer/commit.ts";
import { Grid } from "@utils/cli/renderer/grid.ts";
import { ProcessTerminal } from "@utils/cli/renderer/terminal.ts";
import { SystemClock } from "@utils/cli/renderer/clock.ts";
import { TeardownGuard } from "@utils/cli/renderer/teardown.ts";
import { StdinBuffer } from "@utils/cli/renderer/stdin-buffer.ts";
import { wrapToWidth } from "@utils/cli/renderer/width.ts";
import { EditorView, type EditorEvent } from "@utils/cli/renderer/editor-view.ts";
import type { Completion } from "@utils/cli/renderer/popup.ts";
import type { Clock, KeySource, SignalHost, Terminal } from "@utils/cli/renderer/seams.ts";

/**
 * Mount rule (default-on since the flip): the renderer
 * attaches iff the knob is NOT "legacy" AND stdin.isTTY AND stdout.isTTY AND
 * the environment does not name itself a dumb terminal. Any other combination
 * runs today's passthrough path -- non-TTY is a code path that never mounts,
 * not a set of conditionals inside the renderer. The knob is a kill-switch:
 * only the explicit "legacy" value turns the renderer off, and legacy is then
 * never mounted, byte-identical.
 *
 * The dumb check mirrors the EXACT comparison colors.ts makes in
 * colorDisabledByEnv(): `env.TERM === "dumb"` -- strict equality against the
 * lowercase terminfo convention string. That comparison is deliberately
 * case-sensitive and substring-free here too: "DUMB", "dumb-" or " xterm"
 * are not the convention and do not decline. NO_COLOR is NOT consulted at
 * this gate: frames are geometry, not color; a
 * NO_COLOR TTY mounts the split renderer and renders with color disabled,
 * which colors.ts already does for the transcript channels. TERM=dumb
 * declines because a dumb terminal cannot host cursor-addressed geometry at
 * all; the session then runs the legacy path unchanged.
 */
export function shouldMountRenderer(
  knob: unknown,
  stdinIsTTY: unknown,
  stdoutIsTTY: unknown,
  term: unknown = undefined,
): boolean {
  // Default-on: the knob is a kill-switch, only the explicit "legacy" value
  // turns the renderer off (unset reads as the "split" default).
  return knob !== "legacy" && stdinIsTTY === true && stdoutIsTTY === true && term !== "dumb";
}

/** What mountSplitRenderer's gate would decide, with the "why" attached. */
export interface RendererPosture {
  /** The knob reading: "legacy", or anything else (the default) = "split". */
  mode: "split" | "legacy";
  /** True only when EVERY gate is open for this exact environment. */
  mount: boolean;
  /** Short honest reason for the decision, shaped for `hotdog info`. */
  reason: string;
}

/**
 * The mount gate as a pure decision with a reason. It re-derives each condition
 * of shouldMountRenderer to attach its "why", in the same order; the test
 * matrix pins mount === shouldMountRenderer on every combination, so the two
 * can never drift silently. `hotdog info` prints
 * this projection because info runs OUTSIDE any session: nothing is mounted
 * at report time, and since the gate reads only knob + TTY + TERM, the
 * projection is exactly what the next interactive session in this same
 * environment would do.
 */
export function rendererMountPosture(
  knob: unknown,
  stdinIsTTY: unknown,
  stdoutIsTTY: unknown,
  term: unknown,
): RendererPosture {
  if (knob === "legacy") {
    return { mode: "legacy", mount: false, reason: "knob off (legacy); split renderer never mounts" };
  }
  if (stdinIsTTY !== true || stdoutIsTTY !== true) {
    return { mode: "split", mount: false, reason: "declines here: stdin/stdout not both a TTY; passthrough" };
  }
  if (term === "dumb") {
    return { mode: "split", mount: false, reason: "declines here: TERM=dumb; session runs the legacy path" };
  }
  return { mode: "split", mount: true, reason: "mounts here: TTY pair, TERM not dumb" };
}

/** SignalHost seam over the real process (TeardownGuard step 7 removes). */
export const processSignalHost: SignalHost = {
  on(signal: "SIGTERM" | "SIGHUP", cb: () => void): () => void {
    process.on(signal, cb);
    return () => void process.off(signal, cb);
  },
  exit(code: number): void {
    process.exit(code);
  },
};

function coerce(chunk: unknown): string {
  if (typeof chunk === "string") return chunk;
  if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
  if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString("utf8");
  return String(chunk);
}

/**
 * Split escape sequences must never reach the capture Grid half-fed (the Grid
 * documents no reassembly). Returns the start index of a trailing incomplete
 * escape, or -1 when the text is safe to feed whole.
 */
export function incompleteEscapeStart(data: string): number {
  const i = data.lastIndexOf("\x1b");
  if (i < 0) return -1;
  const rest = data.slice(i);
  if (rest.length === 1) return i; // lone ESC: SS3 body or ST second byte
  if (rest[1] === "[") {
    // CSI: parameter/intermediate bytes 0x30-0x3F, final byte 0x40-0x7E.
    return /^[0-?]*$/.test(rest.slice(2)) ? i : -1;
  }
  if (rest[1] === "]") {
    // OSC: terminated by BEL or ST (ESC \). A trailing lone ESC inside was
    // already ruled out by lastIndexOf picking the LAST ESC.
    return /\x07/.test(rest) ? -1 : i;
  }
  return -1; // two-byte escapes complete as given
}

/** Buffers writes and hands complete lines downstream; trailing partial waits. */
class LineChannel {
  #partial = "";

  constructor(
    private readonly onLines: (lines: string[]) => void,
    private readonly onChange: () => void = () => {},
  ) {}

  get hasPartial(): boolean {
    return this.#partial !== "";
  }

  /** The unterminated trailing row -- the line being written right now. */
  get partial(): string {
    return this.#partial;
  }

  write(text: string): void {
    const parts = (this.#partial + text).split("\n");
    this.#partial = parts.pop() ?? "";
    // Repaint the frame to the NEW partial BEFORE committing the completed
    // rows: the commit's frozen-frame paint then already shows the right
    // in-progress line, so the finished row never appears twice and the old
    // partial never flashes stale. A chunk that only grows the line commits
    // nothing and just repaints.
    this.onChange();
    if (parts.length > 0) this.onLines(parts);
  }

  flush(): void {
    if (this.#partial === "") return;
    const line = this.#partial;
    this.#partial = "";
    this.onChange();
    this.onLines([line]);
  }

  /**
   * Throw away the unterminated row WITHOUT committing it (stream reset:
   * the bytes belong to a failed attempt the transport already re-issued;
   * committing them would put dead text in permanent scrollback). No
   * repaint here -- the caller repaints once for the whole reset.
   */
  discardPartial(): void {
    this.#partial = "";
  }
}

/**
 * readline's output stream, redirected into the frame (kilocode
 * capture-stdout pattern): every byte readline paints is fed to an
 * in-memory Grid and the visible rows become the frame content. readline
 * keeps interpreting input -- only its output destination changes.
 */
export class CaptureStream extends EventEmitter {
  readonly isTTY = true;
  #grid: Grid;
  #pending = "";

  constructor(
    private readonly onPaint: (rows: string[]) => void,
    rows: number,
    cols: number,
  ) {
    super();
    this.#grid = new Grid(rows, cols);
  }

  get columns(): number {
    return this.#grid.cols;
  }

  get rows(): number {
    return this.#grid.rows;
  }

  write(chunk: unknown): boolean {
    const text = this.#pending + coerce(chunk);
    this.#pending = "";
    const cut = incompleteEscapeStart(text);
    const feed = cut < 0 ? text : text.slice(0, cut);
    if (cut >= 0) this.#pending = text.slice(cut);
    if (feed.length > 0) {
      this.#grid.feed(feed);
      this.onPaint(this.frameRows());
    }
    return true;
  }

  /** Visible rows: screen rows with trailing blanks trimmed (INV-4 blank is the core's job). */
  frameRows(): string[] {
    const screen = this.#grid.snapshot().screen;
    let last = screen.length - 1;
    while (last >= 0 && screen[last] === "") last--;
    return screen.slice(0, last + 1);
  }

  /**
   * Where the model cursor sits inside the frame (0-based, relative to the
   * frame's top row) -- readline's believed edit position, projected onto the
   * physical terminal by the core after each paint.
   */
  cursor(): { row: number; col: number } {
    return { row: this.#grid.cursorRow, col: this.#grid.cursorCol };
  }

  reset(rows?: number, cols?: number): void {
    this.#grid = new Grid(rows ?? this.#grid.rows, cols ?? this.#grid.cols);
    this.#pending = "";
    this.onPaint([]);
  }

  /** Viewport change: rebuild at the new geometry, then tell readline to repaint. */
  setGeometry(rows: number, cols: number): void {
    this.reset(rows, cols);
    this.emit("resize");
  }

  // readline calls output.end() on close; a frame must not gain a newline there.
  end(): void {}
}

export interface OutputBridgeOptions {
  terminal: Terminal;
  clock: Clock;
  signalHost: SignalHost;
}

/** The stdin slice suspend() needs; process.stdin satisfies it structurally. */
export interface StdinHandoffHost {
  rawListeners(event: "data"): ((chunk: unknown) => void)[];
  removeAllListeners(event: "data"): unknown;
  on(event: "data", listener: (chunk: unknown) => void): unknown;
  /** Real (never neutered) resume(); the resume thunk calls it explicitly
   * rather than trusting on("data") to restart the poller under Bun. */
  resume(): unknown;
}

/**
 * The owner's responses to editor input. submit/interrupt/quit
 * fire AFTER the bridge has settled the frame (echo committed, buffer
 * cleared); popup is the synchronous Tab-request hook (async provider wiring
 * is the next 3b increment); unhandled carries keys outside the editor's map
 * (ctrl-x dictation toggle binds there).
 */
export interface EditorInputHandlers {
  submit(line: string): void;
  interrupt(): void;
  quit(): void;
  popup?(word: string, from: number, to: number): Completion[] | undefined;
  unhandled?(key: string): void;
}

/** What a blank answer echoes as: the trace that says an
 * answer arrived and it was empty, distinct from ordinary vertical spacing. */
const NO_ANSWER_MARK = "(no answer)";

/**
 * Status-line state: the visible-message index (`#N`, the newest message's
 * number in the owner's USER_INPUT + ASSISTANT_RESPONSE counting -- see
 * @core/context/message-index.ts, the number /rewind N and /fork N address
 * address), the activity words, plus the footer-style segments the webui
 * footer carries under each assistant message (last-response clock, ctx
 * used/total, the producing call's wall time, the worked-for turn total,
 * cost). The old TURN counter stays dropped (owner ruling); `messageIndex`
 * returns as the row's number under the owner's later ruling that it count
 * all user-input + assistant-response messages. Every segment rides only on
 * real attestation: `cost` is a preformatted USD string that exists only
 * when `modelPricing` is configured; ctx/call come from the in-process
 * TOKEN_USAGE frames (totalTokens/contextWindow/durationMs -- the same pair
 * the sidebar gauge caches, see @extensions/websocket/session-registry.ts
 * #trackUsage) and clear on the working edge that opens a new turn, so a row
 * never wears last turn's numbers as this turn's; `lastAtMs`/`workedMs` are
 * written by the CLOSING working edge -- the same honest basis as the webui's
 * stopped row, so an interrupt's worked time is the observed span to stop.
 * `turnStartMs`/`tickMs` exist only while working: the edge records the
 * start, the bridge's 1s tick advances `tickMs` for the live elapsed timer.
 */
export interface FrameStatus {
  /** Latest visible message's index (#N); null until the lineage has one. */
  messageIndex?: number | null;
  working: boolean;
  laneWait: boolean;
  cost: string | null;
  lastAtMs?: number | null;
  workedMs?: number | null;
  ctxUsed?: number | null;
  ctxTotal?: number | null;
  callMs?: number | null;
  turnStartMs?: number | null;
  tickMs?: number | null;
}

/**
 * Compact clock face for the terminal row: 24-hour HH:MM, local time (the
 * webui footer's 12-hour "1:35 AM" costs four cells a terminal row does not
 * have to give). Exported so wiring tests can build TZ-neutral expectations
 * against values the fake clock stamps.
 */
export function formatStatusClock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Compact token count (mirrors the webui footer's formatTokenCount). */
function formatStatusTokens(n: number): string {
  if (n < 1_000) return String(Math.round(n));
  if (n < 10_000) return (n / 1_000).toFixed(1).replace(/\.0$/, "") + "k";
  if (n < 1_000_000) return Math.round(n / 1_000) + "k";
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, "") + "M";
}

/** Per-call wall time (mirrors formatCallDuration: a 4.2s call is not a 4s call). */
function formatStatusCall(ms: number): string {
  if (ms < 10_000) return `${(ms / 1_000).toFixed(1)}s`;
  return formatStatusWorked(ms);
}

/** Turn-total duration: "42s", "16m 21s", "1h 05m 09s". */
function formatStatusWorked(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1_000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3_600);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}m ${String(s).padStart(2, "0")}s`;
  if (m > 0) return `${m}m ${String(s).padStart(2, "0")}s`;
  return `${s}s`;
}

/** The live elapsed timer: zero-padded mm:ss, h:mm:ss past an hour. FLOOR,
 *  never round -- a turn that has not crossed a second never shows it. */
function formatStatusElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1_000));
  const s = String(total % 60).padStart(2, "0");
  const m = String(Math.floor(total / 60) % 60).padStart(2, "0");
  const h = Math.floor(total / 3_600);
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

/**
 * The status row text, or null for nothing-to-show (no attested segment and
 * no activity: the frame is just the editor then). Segments render
 * independently and every one is gated on its attestation -- no usage frame
 * means no ctx segment, no closing working edge means no clock or worked-for,
 * an unmeasured call renders no call time. The visible-message number leads
 * (the lineage's newest #N, once there is one); the state word follows
 * (lane-wait beats working -- waiting for a provider lane IS the current
 * activity) and carries the live elapsed timer while a turn is in flight; the
 * footer mirror (clock, worked-for) renders idle only, so a working row never
 * shows the PREVIOUS turn's finish time or total as if they were current.
 * Cost keeps the tail (modelPricing-gated upstream).
 */
export function statusRowText(s: FrameStatus): string | null {
  const parts: string[] = [];
  if (typeof s.messageIndex === "number" && Number.isFinite(s.messageIndex) && s.messageIndex >= 1) {
    parts.push(`#${Math.trunc(s.messageIndex)}`);
  }
  const state = s.laneWait ? "waiting for lane" : s.working ? "working" : null;
  if (state) {
    parts.push(state);
    if (
      typeof s.turnStartMs === "number" && Number.isFinite(s.turnStartMs) &&
      typeof s.tickMs === "number" && Number.isFinite(s.tickMs) && s.tickMs >= s.turnStartMs
    ) {
      parts.push(formatStatusElapsed(s.tickMs - s.turnStartMs));
    }
  }
  if (!s.working && typeof s.lastAtMs === "number" && Number.isFinite(s.lastAtMs)) {
    parts.push(formatStatusClock(s.lastAtMs));
  }
  if (typeof s.ctxUsed === "number" && Number.isFinite(s.ctxUsed) && s.ctxUsed > 0) {
    const total = s.ctxTotal;
    parts.push(
      formatStatusTokens(s.ctxUsed) +
        (typeof total === "number" && Number.isFinite(total) && total > 0
          ? "/" + formatStatusTokens(total)
          : ""),
    );
  }
  if (typeof s.callMs === "number" && Number.isFinite(s.callMs) && s.callMs >= 0) {
    parts.push(formatStatusCall(s.callMs));
  }
  if (!s.working && typeof s.workedMs === "number" && Number.isFinite(s.workedMs) && s.workedMs >= 0) {
    parts.push(`worked ${formatStatusWorked(s.workedMs)}`);
  }
  if (s.cost) parts.push(s.cost);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * The queue-chip row text (steer affordance): `↑ queued: <first 40 runes>`
 * plus the extra count. Null when nothing is pending. Rune-safe truncation
 * (codepoints, surrogate-safe via Array.from); newlines collapse so the chip
 * is always one frame row.
 */
export function queueChipText(pending: number, preview: string): string | null {
  if (pending <= 0) return null;
  const runes = Array.from(preview.replace(/[\r\n]+/g, " ").trim());
  const shown = runes.length === 0 ? "item" : runes.length > 40 ? `${runes.slice(0, 40).join("")}…` : runes.join("");
  return pending > 1 ? `↑ queued: ${shown} (+${pending - 1})` : `↑ queued: ${shown}`;
}

/**
 * The mounted side of the split session: commit/arbiter line channels over
 * the core's FIFO, the readline capture stream, and the TeardownGuard
 * paired enable/restore of raw mode + bracketed paste.
 */
export class OutputBridge {
  readonly core: RendererCore;
  readonly guard: TeardownGuard;
  readonly capture: CaptureStream;
  /** Re-emittable transcript log for purge-and-reprint (day-1 requirement). */
  readonly transcriptLog: string[] = [];

  readonly #outChannel: LineChannel;
  readonly #errChannel: LineChannel;
  /** Last streaming row composition painted, to skip no-op repaints. */
  #lastStreamKey = "";
  /** True right after the bridge commits its own unterminated row (interrupt echo). */
  #lineOpen = false;
  #promptText = "";
  #questionMode = false;
  #questionDraft = "";
  /** The live question's echoed prefix (see setQuestionLabel); empty until run.
   * Questions without a label echo bare -- a missing label never strands a
   * STALE one, because exiting question mode clears it. */
  #questionLabel = "";
  #mounted = false;
  #suspended = false;
  /** The pre-neuter stdin.pause, handed over by installIoPatches. suspend()
   * is the ONE legitimate pause while mounted; null when no patches
   * were installed (rig bridges, unmounted paths). */
  #realStdinPause: (() => void) | null = null;
  #repushScheduled = false;
  /** The editor input path: owns the frame instead of the capture. */
  #editor: EditorView | null = null;
  /** Editor question focus: resolvers waiting for the next submitted line. */
  #lineWaiters: ((line: string) => void)[] = [];
  /** Last editor block the frame showed -- the interrupt echo, since the
   * view has already cleared its buffer (stash-to-draft) when the event fires. */
  #lastBlockRows: string[] = [];
  /** Status-line state (all attestation-gated; see FrameStatus). */
  #status: FrameStatus = { messageIndex: null, working: false, laneWait: false, cost: null };
  /** The 1s live-tick handle while working; null when idle (no interval
   * ever runs outside a working edge -- it cannot leak across teardown). */
  #tickHandle: unknown = null;
  /** Precomposed queue-chip text, or null for no chip. */
  #chipText: string | null = null;
  /** In-flight tool-call rows by wire index (streaming-call display). */
  #inflightCalls = new Map<number, string>();
  /**
   * True once the live streaming attempt has put bytes on screen via a
   * streaming event (the event glue calls markAttemptOutput on every chunk /
   * reasoning chunk / in-flight delta). resetStream consumes it: rows
   * committed to scrollback during the dead attempt are just as dead as an
   * open partial, but a committed row alone proves nothing about WHICH
   * attempt wrote it -- this flag is the honest knowledge that they were
   * stream bytes. Any settled-live boundary clears it (endAttemptOutput).
   */
  #attemptOutput = false;

  // ── Markdown prose highlighting (split renderer only) ──────────────────
  /**
   * Set by enableProseMarkdown: assistant Default-mode rows arrive from the
   * sink RAW (the sink's final_response wash is skipped) and every whole line
   * is painted here -- committed lines once at the newline, the in-flight row
   * on every frame repaint (the frame's erase/recompose IS the cursor move).
   * Null = feature off, byte-identical to before.
   */
  #mdPalette: ColorPalette | null = null;
  /** Fence state, advanced ONLY on committed lines; reset per turn/reset. */
  #mdState: MdStreamState = newMdStreamState();
  /** The sink's current output mode is assistant prose (Default). */
  #proseMode = false;
  /** Whether the out channel's current (unterminated) row is prose. A row's
   * provenance is fixed when the row STARTS, so the row that a mode change
   * strands mid-line (the tool-call separator terminates it) still paints. */
  #outLineProse = false;

  constructor(private readonly opts: OutputBridgeOptions) {
    this.core = new RendererCore({
      terminal: opts.terminal,
      clock: opts.clock,
      transcript: () => this.transcriptLog,
    });
    this.guard = new TeardownGuard({
      modes: this.core.modes,
      stopRenderer: () => this.core.stop(),
      drainCommitsSync: () => this.core.drainCommitsSync(),
      eraseFrame: () => this.core.eraseFrame(),
    });
    this.capture = new CaptureStream(
      (rows) => this.#paintFrame(rows),
      opts.terminal.rows,
      opts.terminal.columns,
    );
    this.#outChannel = new LineChannel(
      (lines) => this.#commitOutLines(lines),
      () => this.#repaintIfStreaming(),
    );
    this.#errChannel = new LineChannel(
      (lines) => this.#commitLines(lines),
      () => this.#repaintIfStreaming(),
    );
    // The live tick must not outlive the terminal: the guard fires on every
    // exit path (quit, signal, crash, process exit), so a working session's
    // interval is cancelled there even if no working:false edge ever lands.
    this.guard.onTeardown(() => this.#stopTick());
  }

  /**
   * The live streaming line: stdout and stderr share ONE byte stream, and
   * commitText/arbiteText flush the OTHER channel before writing, so at most
   * one channel ever holds an unterminated row. That row is the line being
   * streamed right now -- completed rows already committed into scrollback and
   * stay there. Non-prose partials are already sink-colored and pass through;
   * a PROSE partial is raw markdown and gets re-painted on every repaint (the
   * live pass is pure: same text + same fence state produce the same bytes, so
   * the no-op-repaint skip keeps holding and unclosed spans restyle as close).
   * Returns [] when nothing is mid-line (idle, or every line terminated).
   */
  #streamingRows(width: number): string[] {
    this.#lastStreamKey = this.#streamingOpen();
    const open = this.#lastStreamKey;
    if (open === "") return [];
    return wrapToWidth(this.#paintLiveProse(open), width);
  }

  /** Live repaint of the in-flight prose row; verbatim for everything else. */
  #paintLiveProse(open: string): string {
    const palette = this.#mdPalette;
    if (palette === null || !this.#outLineProse || !this.#outChannel.hasPartial) {
      return open;
    }
    return applyMarkdown(tokenizeMarkdownLive(open, this.#mdState), palette);
  }

  /** The one open (unterminated) row across both channels, "" when none. */
  #streamingOpen(): string {
    return this.#outChannel.partial + this.#errChannel.partial;
  }

  /**
   * A chunk that only grows the in-progress line commits nothing, so it never
   * triggers the commit repaint; ask for a frame repaint directly. Cheap and
   * coalesced by the core scheduler (one paint per burst). Skipped when
   * the partial is UNCHANGED (e.g. a fully-terminated write): the frame is
   * then driven by its own editor/capture events, not by an output commit --
   * a commit must never clobber a frame nothing streamed.
   */
  #repaintIfStreaming(): void {
    if (this.#suspended) return;
    if (this.#streamingOpen() === this.#lastStreamKey) return;
    this.#repaint();
  }

  /**
   * Paired enable (raw mode + ?2004h); TeardownGuard steps 4-5 are the
   * exact inverse. Idempotent. The core paints the INV-4 first frame here.
   */
  mount(): void {
    if (this.#mounted) return;
    this.#mounted = true;
    this.core.modes.setRawMode(true);
    this.core.modes.bracketedPaste(true);
    this.core.mount();
    this.opts.terminal.onResize(() => {
      // Frame erase with the OLD geometry is core.handleResize (subscribed by
      // core.mount); here the capture model re-wraps at the new width and
      // readline repaints its prompt into the fresh frame. The editor path
      // just re-wraps its own block at the new width.
      if (this.#editor) this.#repaint();
      else this.capture.setGeometry(this.opts.terminal.rows, this.opts.terminal.columns);
    });
    this.guard.installSignals(this.opts.signalHost);
  }

  /** installIoPatches hands over the pre-neuter stdin.pause; suspend()
   * consults it (handoff pause). Not cleared at restore: after restore
   * the stash is the live pause again, so the handoff stays correct either
   * way. */
  setRealStdinPause(fn: (() => void) | null): void {
    this.#realStdinPause = fn;
  }

  /** stdout channel: permanent output -> committed clean rows. */
  commitText(text: string): void {
    // An in-flight stderr partial would otherwise appear AFTER newer stdout
    // rows; flush it first so the two channels keep their temporal order.
    const open = this.#errChannel.hasPartial;
    this.#errChannel.flush();
    // A stdout row that starts with this write fixes its markdown provenance
    // NOW (the mode as of this moment); an already-open row keeps its own.
    if (!this.#outChannel.hasPartial) this.#outLineProse = this.#proseMode;
    this.#outChannel.write(this.#eatTerminator(text, open));
  }

  /** stderr/arbiter channel: foreign writes become clean permanent rows too. */
  arbiteText(text: string): void {
    const open = this.#outChannel.hasPartial;
    this.#outChannel.flush();
    this.#errChannel.write(this.#eatTerminator(text, open));
  }

  /**
   * Legacy stdout+stderr share ONE byte stream: a "\n" written while the
   * current line is unterminated is that line's TERMINATOR, never a blank
   * row. In row space the cross-channel flush above already committed the
   * open row (a committed row is implicitly terminated), so a matching
   * leading "\n" must be consumed with it -- otherwise every ad-hoc flush
   * point the sink relies on (its _flushNl separator written to the OTHER
   * stream, the TURN_END log("") after an unterminated token-usage line,
   * the interrupt notice's leading "\n" after a pinned echo) commits a
   * phantom blank row. When nothing was open the "\n" IS a real blank row
   * (cursor at column 0 in legacy too) and passes through untouched.
   */
  #eatTerminator(text: string, otherChannelClosedRow: boolean): string {
    const open = otherChannelClosedRow || this.#lineOpen;
    this.#lineOpen = false;
    return open && text.startsWith("\n") ? text.slice(1) : text;
  }

  /** Force the trailing partial lines out (question prompts, quit, exec boundaries). */
  flushPending(): void {
    this.#outChannel.flush();
    this.#errChannel.flush();
  }

  setPrompt(text: string): void {
    this.#promptText = text;
    if (this.#editor) {
      // The view never self-paints (setPrompt's contract), so a MODEL_CHANGE
      // retarget must repaint here or the frame keeps showing the stale model.
      this.#editor.setPrompt(text);
      this.#repaint();
    }
  }

  /**
   * The question focus flag, and the prompt draft parked while the question
   * owns the input. A half-typed draft must not merge into the answer, so
   * entering question mode stashes the buffer (and clears it); every exit
   * path restores it. EditorCliInput.collectAnswers flips this flag in a
   * try/finally, so resolve, abort, and error exits all run the restore --
   * setText only replaces buffer text and repaints, it never submits, so
   * the revived draft waits for its own Enter.
   */
  setQuestionMode(on: boolean): void {
    if (on === this.#questionMode) return;
    this.#questionMode = on;
    const view = this.#editor;
    if (!on) this.#questionLabel = "";
    if (!view) return; // capture/readline path has no editor buffer to park
    if (on) {
      this.#questionDraft = view.text;
      view.setText("");
    } else {
      const draft = this.#questionDraft;
      this.#questionDraft = "";
      view.setText(draft);
    }
  }

  /**
   * The prefix an answer echo carries while question mode is on (echo
   * rule): `  ? Pick a flavor > vanilla`. runQuestions
   * sets it per question to the exact spoof-safe question line it printed,
   * so a committed answer row in write-once scrollback forever names the
   * question it answers -- even after a collapse or a stolen post-cancel
   * line. Exiting question mode clears it (stale labels never echo).
   */
  setQuestionLabel(text: string): void {
    this.#questionLabel = text;
  }

  /** Answer echo shape: `<label> > <answer>`, or the bare line with no label. */
  #answerEcho(answer: string): string {
    return this.#questionLabel === "" ? answer : `${this.#questionLabel} > ${answer}`;
  }

  /**
   * Merge a status-line patch. Working EDGES are settled here, in one place,
   * so every attester (bus events, the TURN_END hook, the tick itself) rides
   * the same state machine: opening a turn stamps the start (the Clock seam
   * is the only clock the renderer reads), arms the 1s tick, and clears the
   * turn-scoped segments (a fresh turn attests nothing yet -- webui's reset
   * rule); closing one stamps the last-response clock and the worked-for
   * total from the OBSERVED edge span (an interrupt's final row is honest
   * time-to-stop, never a guess), stops the tick, and drops the live-span
   * fields. Idempotent on same-value patches, so TURN_END and the bus's
   * working:false can land in either order and only the real edge stamps.
   * Repaints only when the composed row text actually changes, so a
   * token-usage tick with unchanged numbers (or an idle working:false on an
   * already-idle frame) never storms paints.
   */
  updateStatus(patch: Partial<FrameStatus>): void {
    const before = statusRowText(this.#status);
    let next: FrameStatus = { ...this.#status, ...patch };
    const opened = patch.working === true && !this.#status.working;
    const closed = patch.working === false && this.#status.working;
    if (opened) {
      const now = this.opts.clock.now();
      next = { ...next, turnStartMs: now, tickMs: now, ctxUsed: null, ctxTotal: null, callMs: null };
    } else if (closed) {
      const now = this.opts.clock.now();
      const start = this.#status.turnStartMs;
      next = {
        ...next,
        lastAtMs: now,
        workedMs: typeof start === "number" ? now - start : null,
        turnStartMs: null,
        tickMs: null,
      };
    }
    this.#status = next;
    if (opened) this.#armTick();
    if (closed) this.#stopTick();
    if (statusRowText(this.#status) !== before) this.#repaint();
  }

  /**
   * The live elapsed timer for the turn in flight: a self-rescheduling
   * 1s Clock-seam setTimeout (the seam has no setInterval; the chain is
   * deterministic under FakeClock and cancellable like any handle). Each
   * tick refreshes tickMs; updateStatus's text-diff keeps the repaint to
   * once per second, not per timer fire. The chain ends on the working
   * edge (stopTick), on a dead renderer, and via the teardown hook
   * registered in the constructor -- never across teardown. While
   * suspended the update is skipped (a stdio-inherit child owns the
   * screen; the resume thunk refreshes the elapsed segment).
   */
  #armTick(): void {
    if (this.#tickHandle !== null) return;
    this.#tickHandle = this.opts.clock.setTimeout(() => {
      this.#tickHandle = null;
      if (this.core.isDead || !this.#status.working) return;
      if (!this.#suspended) this.updateStatus({ tickMs: this.opts.clock.now() });
      if (this.#status.working && !this.core.isDead) this.#armTick();
    }, 1000);
  }

  #stopTick(): void {
    if (this.#tickHandle === null) return;
    this.opts.clock.clearTimeout(this.#tickHandle);
    this.#tickHandle = null;
  }

  /** TURN_END: the turn settled, so the working and lane-wait hints go with
   * it (the bus's working:false is idempotent here -- whichever closes the
   * edge first stamps worked/last-response, the second is a no-op). */
  endTurn(): void {
    this.updateStatus({ working: false, laneWait: false });
    // The turn settled: whatever streamed is either committed live output or
    // gone with the run. No later reset may claim it.
    this.endAttemptOutput();
  }

  /** Explicit purge-and-reprint: the /redraw command's entry,
   * the same path as the ctrl-l key binding. */
  redraw(): void {
    this.core.purgeAndReprint();
  }

  /** The QUEUE_UPDATE chip row: pending undelivered steering. */
  setQueueChip(pending: number, preview: string): void {
    const next = queueChipText(pending, preview);
    if (next === this.#chipText) return;
    this.#chipText = next;
    this.#repaint();
  }

  /**
   * The in-flight tool-call rows (streaming-call display): one sink-composed
   * row per wire index, painted directly BELOW the streaming line (the
   * transcript above has already committed; these calls are still being
   * generated). Rows are the sink's policy -- the bridge only holds and
   * wraps them. Same-text updates skip the repaint (delta storms coalesce
   * in the core scheduler; this keeps the no-change case free).
   */
  setInflightCall(index: number, text: string): void {
    if (this.#inflightCalls.get(index) === text) return;
    this.#inflightCalls.set(index, text);
    this.#repaint();
  }

  /** Drop all in-flight rows (final tool_call commit, TOOL_RESULT, turn end). Idempotent. */
  clearInflightCalls(): void {
    if (this.#inflightCalls.size === 0) return;
    this.#inflightCalls.clear();
    this.#repaint();
  }

  /**
   * STREAM_RESET (mid-stream provider failure being retried): retract the
   * failed attempt's in-flight render state -- the unterminated streaming
   * row on either channel (it must NOT commit; the retry re-streams its own
   * text) and every in-flight tool-call row (the processor cleared its call
   * buffer, and the retry re-emits deltas from zero). Completed rows already
   * committed to scrollback stay: the frame surface is write-once there, and
   * a terminal cannot retrace it -- the same honest ceiling the legacy sink
   * has, scoped now to only what the frame still holds. Idempotent.
   */
  resetStream(): void {
    const hadPartial = this.#streamingOpen() !== "";
    // Dead-bytes rule: the marker prints only when the dead attempt actually
    // showed something the retry will duplicate. The honest knowledge here is
    // (a) an open partial row on either channel and (b) the attempt-output
    // flag -- rows committed to scrollback during the attempt count as shown
    // only because the streaming events themselves marked them; a bare commit
    // (tool row, user echo) is not evidence of stream bytes.
    const deadShown = hadPartial || this.#attemptOutput;
    this.#attemptOutput = false;
    this.#outChannel.discardPartial();
    this.#errChannel.discardPartial();
    // The retry re-streams the whole response: the fence document restarts.
    this.#mdState = newMdStreamState();
    this.#outLineProse = false;
    this.clearInflightCalls();
    if (deadShown) {
      // One plain marker row at the duplication point, committed like any
      // transcript line (write-once, purge-and-reprint honest). Plain bytes:
      // the constant carries no styling and nothing untrusted lands on it.
      this.#commitLines([STREAM_RETRY_MARKER]);
    }
    if (hadPartial) this.#repaint();
  }

  /** Stream bytes are on screen: called by the event glue on every chunk /
   * reasoning chunk / in-flight delta of the live attempt. */
  markAttemptOutput(): void {
    this.#attemptOutput = true;
  }

  /**
   * Any printed row that is not stream bytes (tool rows, user echo, thinking,
   * the committed response, a system notice, turn end) settles the previous
   * attempt's bytes as LIVE output: no later reset may claim them, so the
   * marker stays silent until fresh stream bytes land.
   */
  endAttemptOutput(): void {
    this.#attemptOutput = false;
  }

  /** In-flight rows composed for the frame: each entry ANSI-wrapped to width. */
  #inflightRows(width: number): string[] {
    const rows: string[] = [];
    for (const text of this.#inflightCalls.values()) {
      rows.push(...wrapToWidth(text, width));
    }
    return rows;
  }

  /** True while a question owns the input (the popup is suppressed). */
  get questionMode(): boolean {
    return this.#questionMode;
  }

  /**
   * Editor question focus: resolves with the NEXT submitted editor line
   * instead of delivering it to the normal submit handler, which is what
   * makes the question exclusive. cancel() detaches the wait so a line typed
   * after the caller gave up (run abort) flows back to the normal handler
   * rather than vanishing into a dead question loop.
   */
  waitForLine(): { line: Promise<string>; cancel: () => void } {
    let settle!: (line: string) => void;
    const line = new Promise<string>((resolve) => {
      settle = resolve;
    });
    const waiter = (text: string): void => settle(text);
    this.#lineWaiters.push(waiter);
    return {
      line,
      cancel: () => {
        const at = this.#lineWaiters.indexOf(waiter);
        if (at >= 0) this.#lineWaiters.splice(at, 1);
      },
    };
  }

  /** The mounted editor, or null on the readline/capture path. */
  get editor(): EditorView | null {
    return this.#editor;
  }

  /**
   * Editor input: StdinBuffer decodes the KeySource, EditorView owns
   * the buffer/history/popup, and the frame becomes popup rows + wrapped
   * editor block (composer order) instead of the readline capture. The two
   * input paths never coexist; this replaces the capture as the frame source.
   * The returned fn detaches input.
   */
  mountEditorInput(source: KeySource, handlers: EditorInputHandlers): () => void {
    if (this.#editor) throw new Error("editor input already mounted");
    const stdin = new StdinBuffer(source, this.opts.clock);
    const view = new EditorView({ width: () => this.opts.terminal.columns });
    view.setPrompt(this.#promptText);
    view.onEvent((e) => this.#onEditorEvent(e, handlers));
    const detach = view.attachStdin(stdin);
    this.#editor = view;
    this.#repaint();
    return () => {
      detach();
      this.#editor = null;
    };
  }

  #onEditorEvent(e: EditorEvent, h: EditorInputHandlers): void {
    switch (e.type) {
      case "submit": {
        // A pending question owns the input: the line answers it and never
        // reaches the normal submit handler (question exclusivity).
        const waiter = this.#lineWaiters.shift();
        if (e.text.trim() === "") {
          if (waiter) {
            // An empty answer is legitimate free text, and per the echo rule
            // it commits a self-describing row -- the question
            // prefix plus `(no answer)` -- instead of resolving silently.
            // A blank answer now leaves a trace naming its question;
            // lineSubmitted runs the question prefix, the flush and repaint.
            this.lineSubmitted(NO_ANSWER_MARK);
            waiter(e.text);
            return;
          }
          // Legacy's lineHandler treats a trimmed-blank line (empty or
          // whitespace-only, either one) as "repaint the prompt, do
          // nothing", and readline writes no scrollback byte for it. The
          // editor echo would freeze the bare "(model)> " into write-once
          // scrollback, so a blank submit never echo-commits; the frame
          // repaint (the view already cleared its buffer) and the normal
          // handler still run so lineHandler executes its own blank
          // early-return like the readline "line" event did.
          this.#repaint();
          h.submit(e.text);
          return;
        }
        // Prompt+line become the transcript row; the view has already reset.
        this.lineSubmitted(e.text);
        if (waiter) waiter(e.text);
        else h.submit(e.text);
        return;
      }
      case "interrupt":
        this.flushEcho();
        h.interrupt();
        return;
      case "quit":
        h.quit();
        return;
      case "redraw":
        // ctrl-l: purge scrollback, reprint the transcript, repaint the frame.
        this.core.purgeAndReprint();
        return;
      case "popup":
        if (e.phase === "request") {
          const candidates = h.popup?.(e.word, e.from, e.to);
          // openPopup/close emit, which repaint; an empty set never opens.
          if (candidates) this.#editor?.openPopup(candidates, e.from);
        } else {
          this.#repaint();
        }
        return;
      case "history":
      case "change":
        this.#repaint();
        return;
      case "unhandled":
        h.unhandled?.(e.key);
        return;
    }
  }

  /**
   * Enter was pressed: today's readline echo (prompt + line + newline)
   * becomes a committed transcript row, then the frame resets to empty. In
   * question mode the row is the answer echo (`<question> > <answer>`),
   * not the main prompt's shape -- the answer names its question forever.
   */
  lineSubmitted(line: string): void {
    this.flushPending();
    this.#commitLines([this.#questionMode ? this.#answerEcho(line) : this.#promptText + line]);
    if (this.#editor) this.#repaint(); // view buffer already cleared by submit
    else this.capture.reset();
  }

  /**
   * Interrupt path: today the typed echo stays on screen as the interrupt
   * notice prints below it. The echo lives in the frame, so make it a
   * permanent row first, then clear the frame for the fresh prompt.
   */
  flushEcho(): void {
    if (this.#editor) {
      // The view cleared its buffer before the interrupt event fired, so
      // commit what the frame last showed (blank rows trimmed, capture parity).
      const rows = [...this.#lastBlockRows];
      while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
      this.#repaint();
      if (rows.length > 0) {
        this.#commitLines(rows);
        this.#lineOpen = true;
      }
      return;
    }
    const rows = this.capture.frameRows();
    this.capture.reset();
    if (rows.length > 0) {
      this.#commitLines(rows);
      // Legacy cursor sat at the end of the unpinned echo (no newline was
      // written); the "\n" the interrupt notice leads with is that row's
      // terminator, not a blank row.
      this.#lineOpen = true;
    }
  }

  /** Quit path: settle the rows, restore the terminal, then let exit proceed. */
  shutdown(): void {
    this.flushPending();
    this.guard.run();
  }

  /**
   * Suspend()/Resume(): hand the terminal to a stdio:"inherit" child
   * (shell exec). While mounted, stray stdin.pause is neutered (the
   * stray-pause pitfall) -- but releasing the "data" listeners does NOT stop input under Bun:
   * the stream's native poller keeps pulling tty bytes into the JS buffer,
   * starving the child (measured: a 1-byte reader under hotdog received a
   * third of an `ESC O B` burst; the tail arrived as "BO" debris or never).
   * The handoff therefore: commit the tail, erase the frame (INV-5),
   * `?2004l`, raw off, RELEASE all stdin "data" listeners (readline's,
   * clipboard-paste's interceptor -- whoever is attached), then PAUSE the
   * stream via the real pause installIoPatches stashed on the bridge. The
   * returned thunk is Resume(): modes back on, frame repainted, listeners
   * re-attached BEFORE the stream is resumed, so a byte arriving the instant
   * flow returns has a home. Repeated suspend while suspended is a no-op.
   */
  suspend(stdin: StdinHandoffHost): () => void {
    if (this.#suspended) return () => {};
    // Flush FIRST (still unsuspended) so the onChange repaint drops the
    // streaming partial from the frame once it commits -- otherwise the
    // frozen-frame drain paints it again above the freshly committed row.
    this.flushPending();
    this.#suspended = true;
    // Teardown order: drain queued commits synchronously BEFORE the erase, or a
    // pending print repaints the frame over the erase (INV-2 machinery
    // restores frame rows around a print).
    this.core.drainCommitsSync();
    this.core.eraseFrame();
    this.core.modes.bracketedPaste(false);
    this.core.modes.setRawMode(false);
    const saved = stdin.rawListeners("data");
    stdin.removeAllListeners("data");
    // Detach FIRST, then the real pause: with no listeners left, the stream
    // has nothing to feed, and the pause takes the poller off the tty so
    // the child reads it uncontended.
    this.#realStdinPause?.();
    return () => {
      if (!this.#suspended) return;
      this.#suspended = false;
      this.core.modes.setRawMode(true);
      this.core.modes.bracketedPaste(true);
      // Ticks skipped updates while the child held the screen; refresh the
      // elapsed segment so the row never shows handoff time as the stale
      // pre-suspend value (the repaint below restores the erased frame either
      // way; updateStatus's text-diff keeps this to at most one extra paint).
      if (this.#status.working) this.updateStatus({ tickMs: this.opts.clock.now() });
      this.#repaint();
      for (const listener of saved) stdin.on("data", listener);
      stdin.resume();
    };
  }

  #commitLines(lines: string[]): void {
    this.transcriptLog.push(...lines);
    this.core.commit(lines);
  }

  /**
   * Turn markdown prose highlighting on (split renderer, config default-on).
   * Pairs with the sink's `markdownHighlight` option: the sink stops washing
   * Default-mode text and reports mode changes through `setProseMode`; the
   * tokenizer state lives here because the repaint loop does. Re-enabling
   * mid-session resets the fence state (a fresh document view).
   */
  enableProseMarkdown(palette: ColorPalette): void {
    this.#mdPalette = palette;
    this.#mdState = newMdStreamState();
  }

  /**
   * The sink's output-mode signal: true while streaming assistant prose.
   * A rising edge starts a fresh fence document: every Default segment is its
   * own message surface (message boundaries are the tool calls between them).
   */
  setProseMode(prose: boolean): void {
    if (prose && !this.#proseMode) this.#mdState = newMdStreamState();
    this.#proseMode = prose;
  }

  /**
   * stdout commits pass through the markdown painter for prose rows. The
   * first row may predate a mode change (a tool call stranding an unterminated
   * prose line): its provenance is the row-start flag, NOT the mode as of
   * now. Rows that start inside this write follow the current mode.
   */
  #commitOutLines(lines: string[]): void {
    const palette = this.#mdPalette;
    if (palette !== null) {
      let prose = this.#outLineProse;
      const painted: string[] = [];
      for (const line of lines) {
        painted.push(
          prose ? applyMarkdown(tokenizeMarkdownLine(line, this.#mdState), palette) : line,
        );
        prose = this.#proseMode;
      }
      // A trailing partial produced by this write started under this mode.
      this.#outLineProse = prose;
      this.#commitLines(painted);
      return;
    }
    this.#commitLines(lines);
  }

  /**
   * Repaint the frame from whichever input path is live: the editor composer
   * (status row on top, popup rows immediately above the wrapped block,
   * queue chip below it) or the readline capture.
   */
  #repaint(): void {
    const editor = this.#editor;
    const width = this.opts.terminal.columns;
    const stream = this.#streamingRows(width);
    if (!editor) {
      this.#paintFrame(this.capture.frameRows());
      return;
    }
    // Status/chip rows are editor-path features (split mode only);
    // the block's height budget accounts for every non-block row (INV-2
    // sees the frame grow). The streaming line sits ABOVE everything: the
    // transcript above it has already committed into scrollback. The status
    // row wraps like the other chrome rows -- a footer-style row on a narrow
    // terminal must never clip into the frame's geometry.
    const statusText = statusRowText(this.#status);
    const status = statusText ? wrapToWidth(statusText, width) : [];
    const chip = this.#chipText;
    const inflight = this.#inflightRows(width);
    const popup = editor.popupRows(width);
    const chrome =
      stream.length + inflight.length + popup.length + status.length + (chip ? 1 : 0);
    const block = editor.view(width, Math.max(1, this.opts.terminal.rows - chrome));
    const rows = [
      ...stream,
      ...inflight,
      ...status,
      ...popup,
      ...block.rows,
      ...(chip ? [chip] : []),
    ];
    this.#lastBlockRows = block.rows;
    this.#setFrame(rows, {
      row: stream.length + inflight.length + status.length + popup.length + block.cursorRow,
      col: block.cursorCol,
    });
  }

  #paintFrame(rows: string[]): void {
    const stream = this.#streamingRows(this.opts.terminal.columns);
    const inflight = this.#inflightRows(this.opts.terminal.columns);
    const capture = this.capture.cursor();
    this.#setFrame([...stream, ...inflight, ...rows], {
      row: capture.row + stream.length + inflight.length,
      col: capture.col,
    });
  }

  #setFrame(rows: string[], cursor: { row: number; col: number }): void {
    const before = this.core.droppedMutationCount;
    this.core.setFrame(rows, cursor);
    if (this.core.droppedMutationCount > before) this.#scheduleRepush();
  }

  /**
   * INV-6 drops frame mutations while a commit print is pending; the echo
   * must not be lost, so re-apply the current frame content after the drain
   * (the core's flush immediate was queued first and runs before this one).
   */
  #scheduleRepush(): void {
    if (this.#repushScheduled) return;
    this.#repushScheduled = true;
    this.opts.clock.setImmediate(() => {
      this.#repushScheduled = false;
      // Skipped while suspended: the frame is erased (INV-5) and the child
      // owns the screen -- repainting here paints the ghost prompt row over
      // it (the erase's scheduler.cancelPending does not reach this
      // immediate). Resume's repaint re-applies the frame content anyway.
      if (!this.core.isDead && !this.#suspended) this.#repaint();
    });
  }
}

/** The process surface installIoPatches swaps; tests inject their own rig. */
export interface IoPatchHost {
  stdout: { write(chunk: string | Uint8Array, encoding?: unknown, cb?: unknown): boolean };
  stderr: { write(chunk: string | Uint8Array, encoding?: unknown, cb?: unknown): boolean };
  stdin: { pause(): unknown };
  console: {
    log(...args: unknown[]): void;
    error(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    // Routed diagnostic methods. Optional so rig consoles may stay 3-method
    // shaped; the real globalThis.console always carries all six. A rig that
    // omits one still gets it patched while mounted and gets the (undefined)
    // original back at restore.
    debug?(...args: unknown[]): void;
    info?(...args: unknown[]): void;
    trace?(...args: unknown[]): void;
  };
}

function consoleArgs(args: unknown[]): string {
  return args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
}

/**
 * The renderer is the only writer during a mounted session: route
 * stdout -> commit channel, stderr -> arbiter, console.* -> the same two
 * channels (Bun's console bypasses process.stdout.write at the fd level, so
 * patching the stream alone would miss it), and neuter stdin.pause: no
 * stray caller may pause the shared stream while mounted. The
 * pre-neuter pause is handed to the bridge (setRealStdinPause): the ONE
 * legitimate pause owner is the child handoff, because releasing the
 * data listeners alone does not stop Bun's poller from starving an
 * stdio-inherit child.
 * Returns the restore function (registered as a TeardownGuard hook, so the
 * restore runs exactly once on every exit path).
 *
 * console.error/warn go to the arbiter, and console.debug/info/trace ride
 * the SAME arbiter path -- they are diagnostics exactly like warn/error,
 * and a live frame must not shred them or swallow them. console.log keeps
 * its PRE-EXISTING commit-channel patch: it is permanent output (the uiOut
 * default lands here once the session rebinds), it predates the bridge,
 * existing assertions pin it, and nothing here changes its semantics.
 */
export function installIoPatches(bridge: OutputBridge, host: IoPatchHost): () => void {
  const origOutWrite = host.stdout.write;
  const origErrWrite = host.stderr.write;
  const origStdinPause = host.stdin.pause;
  const origLog = host.console.log;
  const origError = host.console.error;
  const origWarn = host.console.warn;
  const origDebug = host.console.debug;
  const origInfo = host.console.info;
  const origTrace = host.console.trace;

  const routed = (channel: (text: string) => void) => {
    return (chunk: unknown, a2?: unknown, a3?: unknown): boolean => {
      const cb = typeof a2 === "function" ? a2 : typeof a3 === "function" ? a3 : null;
      channel(coerce(chunk));
      if (cb) (cb as (err?: Error | null) => void)(null);
      return true;
    };
  };

  host.stdout.write = routed((t) => bridge.commitText(t));
  host.stderr.write = routed((t) => bridge.arbiteText(t));
  host.stdin.pause = (): unknown => host.stdin;
  bridge.setRealStdinPause(origStdinPause.bind(host.stdin));
  host.console.log = (...args: unknown[]): void => bridge.commitText(consoleArgs(args) + "\n");
  host.console.error = (...args: unknown[]): void => bridge.arbiteText(consoleArgs(args) + "\n");
  host.console.warn = (...args: unknown[]): void => bridge.arbiteText(consoleArgs(args) + "\n");
  host.console.debug = (...args: unknown[]): void => bridge.arbiteText(consoleArgs(args) + "\n");
  host.console.info = (...args: unknown[]): void => bridge.arbiteText(consoleArgs(args) + "\n");
  host.console.trace = (...args: unknown[]): void => bridge.arbiteText(consoleArgs(args) + "\n");

  return () => {
    host.stdout.write = origOutWrite;
    host.stderr.write = origErrWrite;
    host.stdin.pause = origStdinPause;
    host.console.log = origLog;
    host.console.error = origError;
    host.console.warn = origWarn;
    host.console.debug = origDebug;
    host.console.info = origInfo;
    host.console.trace = origTrace;
  };
}

export interface SplitMountOptions {
  /** The uiInteractiveCli.renderer knob value (only "legacy" opts out; unset is the split default). */
  knob: unknown;
  stdinIsTTY?: unknown;
  stdoutIsTTY?: unknown;
  /**
   * Environment the dumb gate reads (TERM). Defaults to process.env;
   * tests inject. NO_COLOR is deliberately NOT read here -- see the
   * shouldMountRenderer header (frames are geometry, not color).
   */
  env?: Record<string, string | undefined>;
  /** Process surface to patch; defaults to the real process (tests inject). */
  host?: IoPatchHost;
}

/** Process surface the crash route needs; tests inject a fake emitter. */
export interface CrashTeardownHost {
  /** Register one handler for both crash events; returns the fn that removes both. */
  onCrash(handler: (err: unknown) => void): () => void;
  writeStderr(text: string): void;
  exit(code: number): void;
}

export const processCrashTeardownHost: CrashTeardownHost = {
  onCrash(handler: (err: unknown) => void): () => void {
    const onException = (err: Error): void => handler(err);
    const onRejection = (reason: unknown): void => handler(reason);
    process.on("uncaughtException", onException);
    process.on("unhandledRejection", onRejection);
    return () => {
      process.off("uncaughtException", onException);
      process.off("unhandledRejection", onRejection);
    };
  },
  writeStderr(text: string): void {
    process.stderr.write(text);
  },
  exit(code: number): void {
    process.exit(code);
  },
};

/** The crash route's exit code: the conventional generic-failure value. */
export const CRASH_EXIT_CODE = 1;

/**
 * Crash teardown for the mounted session. On uncaughtException or
 * unhandledRejection: report the error (the real host's stderr write lands on
 * the bridge arbiter while the io patches are live, so the row commits above
 * the restored screen instead of shredding a mid-frame paint), run the
 * idempotent TeardownGuard (raw mode and bracketed paste off exactly once,
 * even mid-frame or on a second crash), then exit non-zero. Nothing here
 * swallows the crash: the handler never returns control to the event loop,
 * and a handler that turned a crash into a silent hang would be worse than
 * no handler at all. The install lives in mountSplitRenderer only, and the
 * returned unregister is registered as a TeardownGuard hook, so a clean
 * session end removes both handlers (a leaked uncaughtException handler
 * would neuter the test runner's and any later legacy run's crash reporting).
 */
export function installCrashTeardown(bridge: OutputBridge, host: CrashTeardownHost): () => void {
  const onCrash = (err: unknown): void => {
    try {
      host.writeStderr(`${formatError(err)}\n`);
    } catch (writeErr: unknown) {
      // The report stream itself died; the exit code and the mode restore
      // still happen below.
      void writeErr;
    }
    // shutdown() flushes pending rows BEFORE the guard; if that flush itself
    // throws, the idempotent guard.run() in the finally still unwinds raw
    // mode + bracketed paste, and the exit still fires non-zero. The handler
    // never returns control to the event loop.
    try {
      bridge.shutdown();
    } finally {
      bridge.guard.run();
      host.exit(CRASH_EXIT_CODE);
    }
  };
  const unregister = host.onCrash(onCrash);
  bridge.guard.onTeardown(unregister);
  return unregister;
}

/**
 * Mount everything the split mode owns, or return null WITHOUT touching a
 * single global (the legacy/passthrough guarantee). The Terminal writes
 * through handles captured BEFORE the patches land -- writing through
 * process.stdout.write after patching would recurse into the bridge.
 *
 * The gate is the full mount rule (see shouldMountRenderer for the long form):
 * knob not "legacy" AND both stdio streams TTY AND the environment not naming
 * itself dumb. A TTY whose TERM is exactly "dumb" (the same strict comparison
 * colors.ts's colorDisabledByEnv uses) declines HERE, before the Terminal is
 * constructed and before any console/stream global is patched -- the same
 * shape as the knob and non-TTY declines, so a declined session emits zero
 * frame bytes, zero mode bytes and runs today's legacy path byte-identically.
 * NO_COLOR never declines: frames are geometry, and color-off rendering is
 * already colors.ts's job on the transcript channels.
 */
export function mountSplitRenderer(options: SplitMountOptions): OutputBridge | null {
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY;
  const env = options.env ?? process.env;
  if (!shouldMountRenderer(options.knob, stdinIsTTY, stdoutIsTTY, env.TERM)) return null;

  const realStdout = process.stdout;
  const rawWrite = realStdout.write.bind(realStdout);
  const terminal = new ProcessTerminal({
    isTTY: true,
    get columns(): number {
      return realStdout.columns ?? 80;
    },
    get rows(): number {
      return realStdout.rows ?? 24;
    },
    write(s: string): unknown {
      return rawWrite(s);
    },
    on(event: "resize", cb: () => void): unknown {
      return realStdout.on(event, cb);
    },
    off(event: "resize", cb: () => void): unknown {
      return realStdout.off(event, cb);
    },
  });

  const bridge = new OutputBridge({
    terminal,
    clock: new SystemClock(),
    signalHost: processSignalHost,
  });
  bridge.mount();
  const host: IoPatchHost = options.host ?? {
    stdout: process.stdout,
    stderr: process.stderr,
    stdin: process.stdin,
    console: globalThis.console,
  };
  bridge.guard.onTeardown(installIoPatches(bridge, host));
  // Crash route: report + restore + non-zero exit on uncaughtException /
  // unhandledRejection; the paired unregister is a teardown hook, so a clean
  // session end removes both handlers and leaves nothing behind for other
  // processes' files or legacy runs to trip over.
  installCrashTeardown(bridge, processCrashTeardownHost);
  // Last-chance teardown: anything that exits without an explicit teardown still
  // restores the terminal. Idempotent with onQuit/rl-close/signal paths.
  process.on("exit", () => bridge.guard.run());
  return bridge;
}
