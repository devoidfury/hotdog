// Split-mode bridge: the stage-2b wiring between the stage-2a renderer core
// (src/utils/cli/renderer) and the interactive CLI. Design note
// /home/agent/hotdog-cli-renderer-design-2026-10-19.md §2 (ownership),
// §9 (mount rule), §10 (teardown), §12 (stage 2).
//
// This file owns POLICY-FREE plumbing only: mount decision, line framing of
// the routed channels, the readline capture stream, and process-level
// install/restore. Every terminal byte goes through the core's TerminalModes
// (teardown.ts is the sole byte home, §10); the bridge never embeds
// ?2026/?2004/?25/raw sequences itself.

import { EventEmitter } from "node:events";
import { RendererCore } from "@utils/cli/renderer/commit.ts";
import { Grid } from "@utils/cli/renderer/grid.ts";
import { ProcessTerminal } from "@utils/cli/renderer/terminal.ts";
import { SystemClock } from "@utils/cli/renderer/clock.ts";
import { TeardownGuard } from "@utils/cli/renderer/teardown.ts";
import type { Clock, SignalHost, Terminal } from "@utils/cli/renderer/seams.ts";

/**
 * §9 mount rule, verbatim: the renderer attaches iff the knob is "split"
 * AND stdin.isTTY AND stdout.isTTY. Any other combination runs today's
 * passthrough path -- non-TTY is a code path that never mounts, not a set
 * of conditionals inside the renderer. Legacy knob = never, byte-identical.
 */
export function shouldMountRenderer(
  knob: unknown,
  stdinIsTTY: unknown,
  stdoutIsTTY: unknown,
): boolean {
  return knob === "split" && stdinIsTTY === true && stdoutIsTTY === true;
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
  #mounted = false;
  #suspended = false;
  #repushScheduled = false;

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
      // readline repaints its prompt into the fresh frame.
      this.capture.setGeometry(this.opts.terminal.rows, this.opts.terminal.columns);
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
  }

  /** During a question takeover the main prompt is not what the user answers. */
  setQuestionMode(on: boolean): void {
    this.#questionMode = on;
  }

  /**
   * Enter was pressed: today's readline echo (prompt + line + newline)
   * becomes a committed transcript row, then the frame resets to empty.
   */
  lineSubmitted(line: string): void {
    this.flushPending();
    this.#commitLines([this.#questionMode ? line : this.#promptText + line]);
    this.capture.reset();
  }

  /**
   * Interrupt path: today the typed echo stays on screen as the interrupt
   * notice prints below it. The echo lives in the frame, so make it a
   * permanent row first, then clear the frame for the fresh prompt.
   */
  flushEcho(): void {
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
      this.#paintFrame(this.capture.frameRows());
      for (const listener of saved) stdin.on("data", listener);
    };
  }

  #commitLines(lines: string[]): void {
    this.transcriptLog.push(...lines);
    this.core.commit(lines);
  }

  #paintFrame(rows: string[]): void {
    const before = this.core.droppedMutationCount;
    this.core.setFrame(rows, this.capture.cursor());
    if (this.core.droppedMutationCount > before) this.#scheduleRepush();
  }

  /**
   * INV-6 drops frame mutations while a commit print is pending; the echo
   * must not be lost, so re-apply the current capture after the drain (the
   * core's flush immediate was queued first and runs before this one).
   */
  #scheduleRepush(): void {
    if (this.#repushScheduled) return;
    this.#repushScheduled = true;
    this.opts.clock.setImmediate(() => {
      this.#repushScheduled = false;
      if (!this.core.isDead) this.#paintFrame(this.capture.frameRows());
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
 * Returns the restore function (registered as a TeardownGuard hook).
 */
export function installIoPatches(bridge: OutputBridge, host: IoPatchHost): () => void {
  const origOutWrite = host.stdout.write;
  const origErrWrite = host.stderr.write;
  const origStdinPause = host.stdin.pause;
  const origLog = host.console.log;
  const origError = host.console.error;
  const origWarn = host.console.warn;

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

  return () => {
    host.stdout.write = origOutWrite;
    host.stderr.write = origErrWrite;
    host.stdin.pause = origStdinPause;
    host.console.log = origLog;
    host.console.error = origError;
    host.console.warn = origWarn;
  };
}

export interface SplitMountOptions {
  /** The uiInteractiveCli.renderer knob value (anything but "split" is legacy). */
  knob: unknown;
  stdinIsTTY?: unknown;
  stdoutIsTTY?: unknown;
  /** Process surface to patch; defaults to the real process (tests inject). */
  host?: IoPatchHost;
}

/**
 * Mount everything the split mode owns, or return null WITHOUT touching a
 * single global (the legacy/passthrough guarantee). The Terminal writes
 * through handles captured BEFORE the patches land -- writing through
 * process.stdout.write after patching would recurse into the bridge.
 */
export function mountSplitRenderer(options: SplitMountOptions): OutputBridge | null {
  const stdinIsTTY = options.stdinIsTTY ?? process.stdin.isTTY;
  const stdoutIsTTY = options.stdoutIsTTY ?? process.stdout.isTTY;
  if (!shouldMountRenderer(options.knob, stdinIsTTY, stdoutIsTTY)) return null;

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
  // §10 last-chance: anything that exits without an explicit teardown still
  // restores the terminal. Idempotent with onQuit/rl-close/signal paths.
  process.on("exit", () => bridge.guard.run());
  return bridge;
}
