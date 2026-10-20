// TeardownGuard (design note §10): idempotent, single object, owning the
// paired terminal primitives. This file is the ONLY home of raw-mode,
// bracketed-paste, cursor-visibility, and synchronized-output bytes in the
// renderer -- the FrameScheduler/commit engine go through TerminalModes
// instead of embedding escape literals (contract-tested in
// tests/utils/cli/renderer/architecture.test.ts).
//
// Step order is normative (§10): scheduler first, then commit-or-drop, then
// the frame erase, then mode unwinding -- kilocode's lesson: hand stdout back
// before killing the capture pipeline, nothing may capture into a stopped
// region (pitfall 8).

import { formatError } from "@core/error.ts";
import type { SignalHost, Terminal } from "./seams.ts";

/** Home of every paired mode byte. Renderer paints borrow begin/endSync + hide/show here. */
export class TerminalModes {
  constructor(readonly terminal: Terminal) {}

  beginSync(): void {
    this.terminal.write("\x1b[?2026h");
  }

  endSync(): void {
    this.terminal.write("\x1b[?2026l");
  }

  hideCursor(): void {
    this.terminal.write("\x1b[?25l");
  }

  showCursor(): void {
    this.terminal.write("\x1b[?25h");
  }

  bracketedPaste(on: boolean): void {
    this.terminal.write(on ? "\x1b[?2004h" : "\x1b[?2004l");
  }

  setRawMode(on: boolean): void {
    this.terminal.setRawMode(on);
  }

  resetSgr(): void {
    this.terminal.write("\x1b[0m");
  }
}

export interface TeardownDeps {
  modes: TerminalModes;
  /** Step 1: cancel pending frame timers, mark the renderer dead. */
  stopRenderer(): void;
  /** Step 2: queued finalized rows commit synchronously; transient content drops. */
  drainCommitsSync(): void;
  /** Step 3: erase the live frame with INV-5 mechanics (shrink to zero from the anchor). */
  eraseFrame(): void;
}

export class TeardownGuard {
  private ran = false;
  private hooks: (() => void)[] = [];
  private signalOffs: (() => void)[] = [];

  constructor(private readonly deps: TeardownDeps) {}

  /** Hook for later stages (arbiter close, editor state flush); fires once after the restore steps. */
  onTeardown(cb: () => void): void {
    if (this.ran) cb();
    else this.hooks.push(cb);
  }

  get fired(): boolean {
    return this.ran;
  }

  /**
   * Separate SIGTERM/SIGHUP handlers: Bun delivers no signal name to a shared
   * handler, so one function registered for both cannot pick its exit code
   * (§5/§10, minicode TERMINAL_CONTRACT precedent).
   */
  installSignals(host: SignalHost): void {
    const term = (): void => {
      this.run();
      host.exit(128 + 15);
    };
    const hup = (): void => {
      this.run();
      host.exit(128 + 12);
    };
    this.signalOffs.push(host.on("SIGTERM", term), host.on("SIGHUP", hup));
  }

  run(): void {
    if (this.ran) return;
    this.ran = true;
    this.safe(() => this.deps.stopRenderer()); // 1
    this.safe(() => this.deps.drainCommitsSync()); // 2
    this.safe(() => this.deps.eraseFrame()); // 3
    this.safe(() => this.deps.modes.beginSync()); // 4..6 as one synchronized block
    this.safe(() => this.deps.modes.bracketedPaste(false)); // 4
    this.safe(() => this.deps.modes.setRawMode(false)); // 5
    this.safe(() => {
      // 6
      this.deps.modes.showCursor();
      this.deps.modes.resetSgr();
    });
    this.safe(() => this.deps.modes.endSync());
    for (const hook of this.hooks) this.safe(hook);
    // 7: default signal behavior resumes (the signal paths themselves exit 128+n)
    for (const off of this.signalOffs) this.safe(off);
    this.signalOffs = [];
  }

  // Teardown is best-effort: a throwing step is reported and skipped, never
  // allowed to skip the mode-unwinding steps behind it. Reporting itself is
  // wrapped -- a detached/throwing stderr (Bun-on-Windows, §13) must not turn
  // a skipped step into a crashed teardown.
  private safe(fn: () => void): void {
    try {
      fn();
    } catch (e: unknown) {
      try {
        this.deps.modes.terminal.write(`${formatError(e)}\n`);
      } catch {
        // The terminal is gone; there is nobody left to tell.
      }
    }
  }
}
