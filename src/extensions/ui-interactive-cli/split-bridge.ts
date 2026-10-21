// Split-mode bridge: the stage-2b wiring between the stage-2a renderer core
// (src/utils/cli/renderer) and the interactive CLI. Design note
// /home/agent/hotdog-cli-renderer-design-2026-10-19.md §2 (ownership),
// §9 (mount rule), §10 (teardown), §12 (stage 2).
//
// This file owns POLICY-FREE plumbing only: mount decision, line framing of
// the routed channels, the readline capture stream (kept as a bridge-level
// capability; the stage-3b swap means the interactive session no longer
// constructs readline at all, so on a mounted session the editor path is the
// only frame source), the stage-3b editor input mount, and process-level
// install/restore. Every terminal byte goes through the core's TerminalModes
// (teardown.ts is the sole byte home, §10); the bridge never embeds
// ?2026/?2004/?25/raw sequences itself.

import { EventEmitter } from "node:events";
import { formatError } from "@core/error.ts";
import { RendererCore } from "@utils/cli/renderer/commit.ts";
import { Grid } from "@utils/cli/renderer/grid.ts";
import { ProcessTerminal } from "@utils/cli/renderer/terminal.ts";
import { SystemClock } from "@utils/cli/renderer/clock.ts";
import { TeardownGuard } from "@utils/cli/renderer/teardown.ts";
import { StdinBuffer } from "@utils/cli/renderer/stdin-buffer.ts";
import { EditorView, type EditorEvent } from "@utils/cli/renderer/editor-view.ts";
import type { Completion } from "@utils/cli/renderer/popup.ts";
import type { Clock, KeySource, SignalHost, Terminal } from "@utils/cli/renderer/seams.ts";

/**
 * §9 mount rule (stage-3c wording): the renderer attaches iff the knob is
 * "split" AND stdin.isTTY AND stdout.isTTY AND the environment does not name
 * itself a dumb terminal. Any other combination runs today's passthrough
 * path -- non-TTY is a code path that never mounts, not a set of conditionals
 * inside the renderer. Legacy knob = never, byte-identical.
 *
 * The dumb check mirrors the EXACT comparison colors.ts makes in
 * colorDisabledByEnv(): `env.TERM === "dumb"` -- strict equality against the
 * lowercase terminfo convention string. That comparison is deliberately
 * case-sensitive and substring-free here too: "DUMB", "dumb-" or " xterm"
 * are not the convention and do not decline. NO_COLOR is NOT consulted at
 * this gate (owner ruling 2026-10-21): frames are geometry, not color; a
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
  return knob === "split" && stdinIsTTY === true && stdoutIsTTY === true && term !== "dumb";
}

/** What mountSplitRenderer's §9 gate would decide, with the "why" attached. */
export interface RendererPosture {
  /** The knob reading: "split", or anything else (the default) = "legacy". */
  mode: "split" | "legacy";
  /** True only when EVERY gate is open for this exact environment. */
  mount: boolean;
  /** Short honest reason for the decision, shaped for `hotdog info`. */
  reason: string;
}

/**
 * The §9 gate as a pure decision with a reason. It re-derives each condition
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
  if (knob !== "split") {
    return { mode: "legacy", mount: false, reason: "knob off; split renderer never mounts" };
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

  constructor(private readonly onLines: (lines: string[]) => void) {}

  get hasPartial(): boolean {
    return this.#partial !== "";
  }

  write(text: string): void {
    const parts = (this.#partial + text).split("\n");
    this.#partial = parts.pop() ?? "";
    if (parts.length > 0) this.onLines(parts);
  }

  flush(): void {
    if (this.#partial === "") return;
    const line = this.#partial;
    this.#partial = "";
    this.onLines([line]);
  }
}

/**
 * readline's output stream, redirected into the frame (kilocode
 * capture-stdout pattern, note §2): every byte readline paints is fed to an
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
}

/**
 * The owner's responses to editor input (stage 3b). submit/interrupt/quit
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

/** What a blank answer echoes as (fix-3 ruling): the trace that says an
 * answer arrived and it was empty, distinct from ordinary vertical spacing. */
const NO_ANSWER_MARK = "(no answer)";

/** Status-line state (§12 stage 4, owner ruling 4): turn count + lane-wait +
 * working state by default; `cost` is a preformatted USD string that exists
 * only when `modelPricing` is configured. Context-% stays off. */
export interface FrameStatus {
  turns: number;
  working: boolean;
  laneWait: boolean;
  cost: string | null;
}

/**
 * The status row text, or null for nothing-to-show (before the first turn
 * and while idle: the frame is just the editor then). While active the
 * counter reads as the turn in flight (#turns+1); lane-wait shows over
 * working -- waiting for a provider lane IS the current activity.
 */
export function statusRowText(s: FrameStatus): string | null {
  if (s.turns === 0 && !s.working) return null;
  let text = s.working ? `#${s.turns + 1}` : `#${s.turns}`;
  const state = s.laneWait ? "waiting for lane" : s.working ? "working" : null;
  if (state) text += ` · ${state}`;
  if (s.cost) text += ` · ${s.cost}`;
  return text;
}

/**
 * The queue-chip row text (§8 steer affordance): `↑ queued: <first 40 runes>`
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
 * the core's FIFO (§2 rubric 1/3), the readline capture stream (§2 stage-2
 * row), and the TeardownGuard paired enable/restore of raw mode + bracketed
 * paste (§5/§10).
 */
export class OutputBridge {
  readonly core: RendererCore;
  readonly guard: TeardownGuard;
  readonly capture: CaptureStream;
  /** Re-emittable transcript log for purge-and-reprint (§6, day-1 requirement). */
  readonly transcriptLog: string[] = [];

  readonly #outChannel: LineChannel;
  readonly #errChannel: LineChannel;
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
  #repushScheduled = false;
  /** The editor input path (stage 3b): owns the frame instead of the capture. */
  #editor: EditorView | null = null;
  /** Editor question focus (§8): resolvers waiting for the next submitted line. */
  #lineWaiters: ((line: string) => void)[] = [];
  /** Last editor block the frame showed -- the interrupt echo, since the
   * view has already cleared its buffer (stash-to-draft) when the event fires. */
  #lastBlockRows: string[] = [];
  /** Status-line state (§12 stage 4). */
  #status: FrameStatus = { turns: 0, working: false, laneWait: false, cost: null };
  /** Precomposed queue-chip text (§8), or null for no chip. */
  #chipText: string | null = null;

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
    this.#outChannel = new LineChannel((lines) => this.#commitLines(lines));
    this.#errChannel = new LineChannel((lines) => this.#commitLines(lines));
  }

  /**
   * Paired enable (raw mode + ?2004h, §5); TeardownGuard steps 4-5 are the
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

  /** stdout channel (§2 rubric 1): permanent output -> committed clean rows. */
  commitText(text: string): void {
    // An in-flight stderr partial would otherwise appear AFTER newer stdout
    // rows; flush it first so the two channels keep their temporal order.
    const open = this.#errChannel.hasPartial;
    this.#errChannel.flush();
    this.#outChannel.write(this.#eatTerminator(text, open));
  }

  /** stderr/arbiter channel (§2 rubric 3): foreign writes become clean permanent rows too. */
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
   * §8 question focus flag, and the prompt draft parked while the question
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
   * The prefix an answer echo carries while question mode is on (fix-3 echo
   * ruling, question-echo.md): `  ? Pick a flavor > vanilla`. runQuestions
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
   * Merge a status-line patch (§12 stage 4). Repaint only when the composed
   * row text actually changes, so a token-usage tick with an unchanged cost
   * (or an idle working:false on an already-idle frame) never storms paints.
   */
  updateStatus(patch: Partial<FrameStatus>): void {
    const before = statusRowText(this.#status);
    this.#status = { ...this.#status, ...patch };
    if (statusRowText(this.#status) !== before) this.#repaint();
  }

  /** TURN_END: bump the turn counter; the turn settled, so the working and
   * lane-wait hints go with it (the bus's working:false is idempotent here). */
  addTurn(): void {
    this.updateStatus({ turns: this.#status.turns + 1, working: false, laneWait: false });
  }

  /** The QUEUE_UPDATE chip row (§8): pending undelivered steering. */
  setQueueChip(pending: number, preview: string): void {
    const next = queueChipText(pending, preview);
    if (next === this.#chipText) return;
    this.#chipText = next;
    this.#repaint();
  }

  /** True while a question owns the input (the popup is suppressed, §8). */
  get questionMode(): boolean {
    return this.#questionMode;
  }

  /**
   * §8 editor question focus: resolves with the NEXT submitted editor line
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

  /** The mounted editor (stage 3b), or null on the readline/capture path. */
  get editor(): EditorView | null {
    return this.#editor;
  }

  /**
   * Stage-3b editor input: StdinBuffer decodes the KeySource, EditorView owns
   * the buffer/history/popup, and the frame becomes popup rows + wrapped
   * editor block (§4 composer order) instead of the readline capture. The two
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
        // reaches the normal submit handler (§8 exclusivity).
        const waiter = this.#lineWaiters.shift();
        if (e.text.trim() === "") {
          if (waiter) {
            // An empty answer is legitimate free text (§8), and per the fix-3
            // echo ruling it commits a self-describing row -- the question
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
        // ctrl-l: purge scrollback, reprint the transcript, repaint the frame (§6).
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
   * question mode the row is the fix-3 answer echo (`<question> > <answer>`),
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
   * §5 Suspend()/Resume(): hand the terminal to a stdio:"inherit" child
   * (shell exec). While mounted, stdin.pause is neutered (§2, pitfall 6), so
   * the legacy rl.pause() bracket does nothing to input -- hotdog's stdin
   * listener and the child race for the tty byte stream, shredding arrow-key
   * escapes (application-cursor-mode `\x1bOB` arrives as "BO" debris and the
   * child eats the rest). The handoff instead: commit the tail, erase the
   * frame (INV-5), `?2004l`, raw off, and RELEASE all stdin "data" listeners
   * (readline's, clipboard-paste's interceptor -- whoever is attached).
   * Removing the listeners is what stops input; the stream is never paused.
   * The returned thunk is Resume(): modes back on, frame repainted, listeners
   * re-attached. Repeated suspend while suspended is a no-op.
   */
  suspend(stdin: StdinHandoffHost): () => void {
    if (this.#suspended) return () => {};
    this.#suspended = true;
    this.flushPending();
    // §10 order: drain queued commits synchronously BEFORE the erase, or a
    // pending print repaints the frame over the erase (INV-2 machinery
    // restores frame rows around a print).
    this.core.drainCommitsSync();
    this.core.eraseFrame();
    this.core.modes.bracketedPaste(false);
    this.core.modes.setRawMode(false);
    const saved = stdin.rawListeners("data");
    stdin.removeAllListeners("data");
    return () => {
      if (!this.#suspended) return;
      this.#suspended = false;
      this.core.modes.setRawMode(true);
      this.core.modes.bracketedPaste(true);
      this.#repaint();
      for (const listener of saved) stdin.on("data", listener);
    };
  }

  #commitLines(lines: string[]): void {
    this.transcriptLog.push(...lines);
    this.core.commit(lines);
  }

  /**
   * Repaint the frame from whichever input path is live: the editor composer
   * (status row on top, popup rows immediately above the wrapped block §4,
   * queue chip below it) or the readline capture.
   */
  #repaint(): void {
    const editor = this.#editor;
    if (!editor) {
      this.#paintFrame(this.capture.frameRows());
      return;
    }
    const width = this.opts.terminal.columns;
    // Status/chip rows are stage-4 editor-path features (split mode only);
    // the block's height budget accounts for every non-block row (INV-2
    // sees the frame grow).
    const status = statusRowText(this.#status);
    const chip = this.#chipText;
    const popup = editor.popupRows(width);
    const chrome = popup.length + (status ? 1 : 0) + (chip ? 1 : 0);
    const block = editor.view(width, Math.max(1, this.opts.terminal.rows - chrome));
    const rows = [...(status ? [status] : []), ...popup, ...block.rows, ...(chip ? [chip] : [])];
    this.#lastBlockRows = block.rows;
    this.#setFrame(rows, {
      row: (status ? 1 : 0) + popup.length + block.cursorRow,
      col: block.cursorCol,
    });
  }

  #paintFrame(rows: string[]): void {
    this.#setFrame(rows, this.capture.cursor());
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
      if (!this.core.isDead) this.#repaint();
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
    // Stage-3c routed methods. Optional so rig consoles may stay 3-method
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
 * The renderer is the only writer during a mounted session (§2): route
 * stdout -> commit channel, stderr -> arbiter, console.* -> the same two
 * channels (Bun's console bypasses process.stdout.write at the fd level, so
 * patching the stream alone would miss it), and neuter stdin.pause --
 * pitfall 6: the shell-exec bracket may stay, but it must never pause the
 * shared stream; the child handoff is OutputBridge.suspend()/resume() (§5).
 * Returns the restore function (registered as a TeardownGuard hook, so the
 * restore runs exactly once on every exit path).
 *
 * console.error/warn go to the arbiter; stage 3c (owner ruling) adds
 * console.debug/info/trace to the SAME arbiter path -- they are diagnostics
 * exactly like warn/error, and a live frame must not shred them or swallow
 * them. console.log keeps its PRE-EXISTING commit-channel patch from stage
 * 2b: it is permanent output (the uiOut default lands here once the session
 * rebinds), it predates this batch, existing assertions pin it, and this
 * batch changes its semantics not at all.
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
  /** The uiInteractiveCli.renderer knob value (anything but "split" is legacy). */
  knob: unknown;
  stdinIsTTY?: unknown;
  stdoutIsTTY?: unknown;
  /**
   * Environment the §9 dumb gate reads (TERM). Defaults to process.env;
   * tests inject. NO_COLOR is deliberately NOT read here -- see the
   * shouldMountRenderer header (frames are geometry, not color).
   */
  env?: Record<string, string | undefined>;
  /** Process surface to patch; defaults to the real process (tests inject). */
  host?: IoPatchHost;
}

/** Process surface the §10 crash route needs; tests inject a fake emitter. */
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
 * §10 crash teardown for the mounted session. On uncaughtException or
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
 * The gate is the full §9 rule (see shouldMountRenderer for the long form):
 * knob "split" AND both stdio streams TTY AND the environment not naming
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
  // §10 crash route: report + restore + non-zero exit on uncaughtException /
  // unhandledRejection; the paired unregister is a teardown hook, so a clean
  // session end removes both handlers and leaves nothing behind for other
  // processes' files or legacy runs to trip over.
  installCrashTeardown(bridge, processCrashTeardownHost);
  // §10 last-chance: anything that exits without an explicit teardown still
  // restores the terminal. Idempotent with onQuit/rl-close/signal paths.
  process.on("exit", () => bridge.guard.run());
  return bridge;
}
