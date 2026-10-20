// TeardownGuard (§10): idempotent, exact 7-step order, sole home of the
// raw-mode/bracketed-paste/cursor bytes, separate SIGTERM/SIGHUP handlers
// exiting 128+n. Order is asserted through the Grid mode log and a call-order
// recorder -- orphaned terminals are this project's worst failure mode.

import { describe, it, expect } from "bun:test";
import { GridTerminal } from "@utils/cli/renderer/grid.ts";
import { FakeClock } from "@utils/cli/renderer/fake-clock.ts";
import { RendererCore } from "@utils/cli/renderer/commit.ts";
import { TeardownGuard, TerminalModes, type TeardownDeps } from "@utils/cli/renderer/teardown.ts";
import type { SignalHost } from "@utils/cli/renderer/seams.ts";

class FakeSignalHost implements SignalHost {
  readonly handlers = new Map<string, (() => void)[]>();
  readonly exits: number[] = [];
  readonly removed: string[] = [];

  on(signal: "SIGTERM" | "SIGHUP", cb: () => void): () => void {
    const list = this.handlers.get(signal) ?? [];
    list.push(cb);
    this.handlers.set(signal, list);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.removed.push(signal);
      this.handlers.set(signal, (this.handlers.get(signal) ?? []).filter((f) => f !== cb));
    };
  }

  exit(code: number): void {
    this.exits.push(code);
  }

  fire(signal: "SIGTERM" | "SIGHUP"): void {
    for (const cb of [...(this.handlers.get(signal) ?? [])]) cb();
  }
}

/** Full stack on the Grid; returns the pieces a teardown test needs. */
function live(rows = 8) {
  const t = new GridTerminal({ rows, cols: 20 });
  const clock = new FakeClock();
  const core = new RendererCore({ terminal: t, clock });
  t.grid.cursorRow = rows - 1;
  core.mount();
  const modes = core.modes;
  const guard = new TeardownGuard({
    modes,
    stopRenderer: () => core.stop(),
    drainCommitsSync: () => core.drainCommitsSync(),
    eraseFrame: () => core.eraseFrame(),
  });
  return { t, clock, core, modes, guard };
}

describe("TeardownGuard step order (§10, normative)", () => {
  it("runs steps 1-3 in order, then unwinds modes as ?2026h ?2004l raw:off ?25h ?2026l", () => {
    const t = new GridTerminal({ rows: 8, cols: 20 });
    const order: string[] = [];
    const deps: TeardownDeps = {
      modes: new TerminalModes(t),
      stopRenderer: () => order.push("stopRenderer"),
      drainCommitsSync: () => order.push("drainCommitsSync"),
      eraseFrame: () => order.push("eraseFrame"),
    };
    const guard = new TeardownGuard(deps);
    // Mount-side modes (stage-2b wiring does this; the log needs them present
    // so the unwind order below is a real pairing).
    deps.modes.setRawMode(true);
    deps.modes.bracketedPaste(true);
    const mark = t.grid.modeLog.length;

    guard.run();

    expect(order).toEqual(["stopRenderer", "drainCommitsSync", "eraseFrame"]); // 1,2,3
    expect(t.grid.modeLog.slice(mark)).toEqual(["?2026h", "?2004l", "raw:off", "?25h", "?2026l"]); // 4,5,6
    // step 7 is asserted via signal removal + hooks below
  });

  it("hooks fire once, after the restore steps", () => {
    const t = new GridTerminal();
    const seen: string[] = [];
    const guard = new TeardownGuard({
      modes: new TerminalModes(t),
      stopRenderer: () => seen.push("stop"),
      drainCommitsSync: () => seen.push("drain"),
      eraseFrame: () => seen.push("erase"),
    });
    guard.onTeardown(() => seen.push("hook"));
    guard.run();
    guard.run(); // idempotent
    expect(seen).toEqual(["stop", "drain", "erase", "hook"]);
    expect(guard.fired).toBe(true);
  });

  it("a throwing early step never skips the mode unwind", () => {
    const t = new GridTerminal({ rows: 24, cols: 60 });
    const guard = new TeardownGuard({
      modes: new TerminalModes(t),
      stopRenderer: () => {
        throw new Error("bug");
      },
      drainCommitsSync: () => {},
      eraseFrame: () => {},
    });
    guard.run();
    expect(t.grid.modeLog).toEqual(["?2026h", "?2004l", "raw:off", "?25h", "?2026l"]);
    const all = [...t.grid.snapshot().scrollback, ...t.grid.snapshot().screen].join("\n");
    expect(all).toContain("bug"); // reported through formatError
  });
});

describe("TeardownGuard idempotency + full-stack behavior", () => {
  it("queued commits drain synchronously, the frame erases, and a double run changes nothing", () => {
    const { t, clock, core, guard } = live(8);
    core.setFrame(["F1", "F2"]);
    clock.runAll();
    core.commit(["C1"]); // still queued when teardown starts

    guard.run();

    // Step 2: queued finalized rows committed synchronously. The flush
    // immediate is left in the queue; running the clock must find the queue
    // already drained and print C1 nowhere a second time (single-flight).
    const countC1 = () => [...t.grid.snapshot().scrollback, ...t.grid.snapshot().screen].filter((r) => r === "C1").length;
    expect(countC1()).toBe(1);
    clock.runAll(); // stale flush immediate runs: must be a no-op
    expect(countC1()).toBe(1);
    // Step 3: INV-5 shrink-to-zero -- everything below the committed row blank.
    const after = t.grid.snapshot();
    expect(after.screen.slice(after.screen.indexOf("C1") + 1)).toEqual(["", ""]); // frame rows only
    expect(core.isDead).toBe(true);

    const bytes = () => JSON.stringify(t.grid.snapshot()) + t.grid.modeLog.join(",");
    const before = bytes();
    guard.run();
    guard.run();
    expect(bytes()).toBe(before); // truly idempotent
  });

  it("post-teardown commits fall through to plain passthrough (kilocode order)", () => {
    const { t, clock, core, guard } = live(8);
    core.setFrame(["F1"]);
    clock.runAll();
    guard.run();
    core.commit(["after"]);
    // Plain passthrough: the row lands at the cursor, no frames, no modes.
    expect(t.grid.snapshot().screen.some((r) => r.includes("after"))).toBe(true);
  });
});

describe("signal handling (Bun nameless-signal caveat, §5/§10)", () => {
  it("SIGTERM and SIGHUP register separate handlers and exit 128+n", () => {
    const a = live(8);
    const hostA = new FakeSignalHost();
    a.guard.installSignals(hostA);
    const term = a.guard;
    expect(hostA.handlers.get("SIGTERM")!.length).toBe(1);
    expect(hostA.handlers.get("SIGHUP")!.length).toBe(1);
    expect(hostA.handlers.get("SIGTERM")![0]).not.toBe(hostA.handlers.get("SIGHUP")![0]);

    hostA.fire("SIGTERM");
    expect(term.fired).toBe(true);
    expect(hostA.exits).toEqual([128 + 15]);
  });

  it("SIGHUP exits 128+12; handlers remove themselves (step 7)", () => {
    const b = live(8);
    const hostB = new FakeSignalHost();
    b.guard.installSignals(hostB);
    hostB.fire("SIGHUP");
    expect(hostB.exits).toEqual([128 + 12]);
    expect(hostB.removed).toEqual(["SIGTERM", "SIGHUP"]); // step 7: default behavior resumes
    expect(hostB.handlers.get("SIGTERM")!.length).toBe(0);
  });
});
