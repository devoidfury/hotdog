// Commit protocol (design note §1, san ADR-0002): the managed frame is the
// bottom region of the primary screen; settled rows are committed above it
// into native scrollback, which is write-once -- a bad commit is permanent.
//
// The cursor bookkeeping is purely relative: every paint and every commit
// starts and ends with the cursor parked at the frame's top row (the anchor),
// so absolute rows never enter the math and reflow of committed content above
// the frame cannot corrupt it.

import type { Clock, Terminal } from "./seams.ts";
import { wrapToWidth } from "./width.ts";
import { BoundedWriter } from "./writer.ts";
import { FrameScheduler } from "./scheduler.ts";
import { TerminalModes } from "./teardown.ts";

const CSI = "\x1b[";
const ERASE_DOWN = `${CSI}J`; // ED(0)
const ERASE_LINE = `${CSI}K`; // EL(0)
const CLEAR_SCREEN = `${CSI}2J`;
const CLEAR_SCROLLBACK = `${CSI}3J`;
const HOME = `${CSI}H`;

const up = (n: number): string => (n > 0 ? `${CSI}${n}A` : "");
const down = (n: number): string => (n > 0 ? `${CSI}${n}B` : "");
const insertLines = (n: number): string => `${CSI}${n}L`; // SCI

export interface RendererCoreOptions {
  terminal: Terminal;
  clock: Clock;
  /** Re-emittable transcript log for purge-and-reprint (§6, required day 1). */
  transcript?: () => string[];
}

export class RendererCore {
  readonly modes: TerminalModes;
  readonly scheduler: FrameScheduler;

  private readonly terminal: Terminal;
  private readonly clock: Clock;
  private readonly transcriptSource: () => string[];
  private readonly out: BoundedWriter;

  private frameRows: string[] = [];
  private paintedHeight = 0;
  private mounted = false;
  private dead = false;
  private forceEraseNext = false;

  private pendingCommits: string[] = [];
  private flushScheduled = false;
  private flushing = false;
  private droppedMutations = 0;
  private offResize: (() => void) | null = null;

  constructor(opts: RendererCoreOptions) {
    this.terminal = opts.terminal;
    this.clock = opts.clock;
    this.transcriptSource = opts.transcript ?? (() => []);
    this.modes = new TerminalModes(opts.terminal);
    this.out = new BoundedWriter((chunk) => this.terminal.write(chunk));
    this.scheduler = new FrameScheduler(this.clock, () => this.paintScheduled());
  }

  /** Paint the (possibly empty) first frame and subscribe to resize. */
  mount(): void {
    if (this.mounted || this.dead) return;
    this.mounted = true;
    this.offResize = this.terminal.onResize(() => this.handleResize());
    this.paintScheduled();
  }

  /**
   * Transient frame content (§2 rubric 2: only the renderer paints these).
   * Coalesced through the scheduler normally; DROPPED while a commit print is
   * pending -- INV-6: nothing transient rides in the frame between the freeze
   * and the insert.
   */
  setFrame(rows: string[]): void {
    if (this.dead) return;
    if (this.printPending()) {
      this.droppedMutations++;
      return;
    }
    this.frameRows = rows;
    if (this.mounted) this.scheduler.requestRender();
  }

  /** Finalized rows to print above the frame (INV-1). FIFO queue, next-tick flush. */
  commit(rows: string[]): void {
    if (rows.length === 0) return;
    if (this.dead) {
      // §10 step 1: renderer stopped -- plain passthrough, no protocol.
      this.out.write(`${rows.join("\r\n")}\r\n`);
      return;
    }
    this.mount(); // permanent output implies a live frame; INV-4 says it is never zero rows
    this.pendingCommits.push(...rows);
    // Schedule even while a flush is mid-flight: rows pushed by a reentrant
    // writer (the stage-2b arbiter) land in a fresh queue that the current
    // drain will not see, so dropping the schedule would strand them.
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      this.clock.setImmediate(() => {
        this.flushScheduled = false;
        this.flush();
      });
    }
  }

  /**
   * Keystroke signal: paint immediately, cancelling the pending frame timer first (§3).
   * Dropped while a print is pending (INV-6): setFrame cannot have mutated the
   * frame in that window, so there is nothing new to paint -- and painting
   * between the drain's chunks would interleave frames into one ?2026 window.
   */
  notifyInput(): void {
    if (this.dead || !this.mounted || this.printPending()) return;
    this.scheduler.paintNow();
  }

  /**
   * §6: erase the frame with the OLD geometry (the frame's own rows are ours;
   * committed rows above are the terminal's reflow problem), then repaint
   * under the new width. Purge-and-reprint is NOT on this path (shrink
   * ruling): ESC[3J would destroy pre-session scrollback on every drag.
   * While a print is pending the erase is remembered and the repaint defers
   * through the scheduler -- it lands as the first paint after the drain.
   */
  handleResize(): void {
    if (this.dead || !this.mounted) return;
    this.forceEraseNext = true;
    if (this.printPending()) {
      this.scheduler.requestRender();
      return;
    }
    this.scheduler.paintNow();
  }

  /**
   * Purge-and-reprint recovery (desync only, §6): clear screen + scrollback,
   * home, re-emit the transcript log, repaint the frame. Not ESC[c --
   * iTerm/Terminal.app keep scrollback through RIS, so it would not even
   * accomplish the clear (§6 grok caveat; recipe is ESC[2J ESC[3J ESC[H).
   */
  purgeAndReprint(): void {
    if (this.dead || !this.mounted) return;
    this.modes.beginSync();
    this.modes.hideCursor();
    this.out.write(`${CLEAR_SCREEN}${CLEAR_SCROLLBACK}${HOME}`);
    const width = this.terminal.columns;
    for (const row of this.transcriptSource().flatMap((r) => wrapToWidth(r, width))) {
      this.out.write(`${row}\r\n`);
    }
    // Fresh page under the transcript: paint body without shrink-erase --
    // nothing above needs preserving, and a nested window would be noise.
    this.paintedHeight = 0;
    this.forceEraseNext = false;
    const rows = this.wrappedFrame();
    this.paintBody(rows, false);
    this.paintedHeight = rows.length;
    this.modes.showCursor();
    this.modes.endSync();
  }

  /** §10 step 1: stop everything; later writes fall through to plain passthrough. */
  stop(): void {
    this.dead = true;
    this.scheduler.stop();
    if (this.offResize) {
      this.offResize();
      this.offResize = null;
    }
  }

  get isDead(): boolean {
    return this.dead;
  }

  /** Observable for the INV-6 suite: mutations refused while a print was pending. */
  get droppedMutationCount(): number {
    return this.droppedMutations;
  }

  // ── internals ──────────────────────────────────────────────────────────

  private printPending(): boolean {
    return this.flushScheduled || this.flushing;
  }

  /** Frame rows wrapped for the CURRENT width -- width is read at paint time, never cached (§6). */
  private wrappedFrame(): string[] {
    const width = this.terminal.columns;
    const wrapped = this.frameRows.flatMap((r) => wrapToWidth(r, width));
    // INV-4: the frame is never zero rows -- nothing to show is one blank row.
    return wrapped.length > 0 ? wrapped : [""];
  }

  /** Standalone repaint (scheduler path): one synchronized window around the paint body. */
  private paintScheduled(): void {
    if (!this.mounted) return;
    const rows = this.wrappedFrame();
    const erase = this.forceEraseNext || rows.length < this.paintedHeight;
    this.modes.beginSync();
    this.modes.hideCursor();
    this.paintBody(rows, erase);
    this.modes.showCursor();
    this.modes.endSync();
    this.paintedHeight = rows.length;
    this.forceEraseNext = false;
  }

  /**
   * INV-5 paint body; cursor sits at the frame top (the anchor) on entry and
   * is parked there again on exit. `erase` (frame shrank / resize) erases from
   * the anchor with the PREVIOUS geometry -- erasing from the current cursor
   * row leaves the old frame's upper rows on screen, and the next commit's
   * line feeds push those ghosts into scrollback forever (the bubbletea bug
   * san's fork fixed).
   */
  private paintBody(rows: string[], erase: boolean): void {
    let s = "\r";
    if (erase) s += ERASE_DOWN; // anchor row, erase down
    for (let i = 0; i < rows.length; i++) {
      s += rows[i]! + ERASE_LINE;
      if (i < rows.length - 1) s += "\r\n";
    }
    s += `\r${up(rows.length - 1)}`; // park at the anchor
    this.out.write(s);
  }

  /**
   * INV-3 freeze-and-paint + INV-1 inserts, single-flight. The frame is
   * frozen and repainted BEFORE the first insert; prints are one synchronous
   * FIFO drain, so nothing mutates the frame mid-sequence (INV-6 holds by
   * construction -- setFrame is refused while pending).
   */
  private flush(): void {
    if (this.flushing || this.pendingCommits.length === 0) return;
    this.flushing = true;
    try {
      const rows = this.pendingCommits;
      this.pendingCommits = [];

      // Freeze: frame snapshot and paint-time height taken here.
      const frozen = this.wrappedFrame();
      const h = frozen.length;

      // INV-2 -- this is a rule, printed above the code:
      //
      //        N <= H - h
      //
      // N rows of one commit print, H terminal rows, h current frame height.
      // A print taller than the room above the frame scrolls the frame itself
      // into scrollback and strands it. Chunked prints split so every chunk
      // satisfies the inequality, computed after the freeze, at paint-time
      // height. H - h >= 1 follows from INV-4 (h >= 1) for any sane terminal;
      // if the frame is >= H rows (degenerate), one chunk per print is the
      // ceiling and scrolling is accepted -- a frame taller than the screen
      // is broken regardless of commits.
      const capacity = Math.max(1, this.terminal.rows - h);
      const width = this.terminal.columns;
      const payload = rows.flatMap((r) => wrapToWidth(r, width));

      this.modes.beginSync();
      this.modes.hideCursor();
      this.paintBody(frozen, h < this.paintedHeight); // repaint the frozen frame first
      this.paintedHeight = h;
      for (let off = 0; off < payload.length; off += capacity) {
        this.insertAbove(payload.slice(off, off + capacity), h);
      }
      this.modes.showCursor();
      this.modes.endSync();
    } finally {
      this.flushing = false;
    }
  }

  /**
   * INV-1 mechanics: move to the frame's bottom row, emit N line feeds, move
   * up N+h-1, insert N lines at that point (SCI), write the payload there;
   * the next frame flush repaints under the inserted block. Starts and ends
   * with the cursor at the (new) frame top.
   */
  private insertAbove(chunk: string[], h: number): void {
    const n = chunk.length;
    let s = down(h - 1); // frame top -> frame bottom
    s += "\r\n".repeat(n); // scroll N rows of room in; INV-2 keeps the frame on-screen
    s += up(n + h - 1); // lands on the frame's top row
    s += insertLines(n); // push the frame down over the scrolled-in blanks
    for (const row of chunk) s += row + ERASE_LINE + "\r\n";
    this.out.write(s);
  }

  /** §10 step 2 + step 3 helpers, used through TeardownGuard. */
  drainCommitsSync(): void {
    this.flush();
  }

  eraseFrame(): void {
    if (!this.mounted || this.paintedHeight === 0) return;
    // INV-5 shrink-to-zero from the anchor: the cursor is parked there.
    this.out.write(`\r${ERASE_DOWN}`);
    this.paintedHeight = 0;
  }
}
