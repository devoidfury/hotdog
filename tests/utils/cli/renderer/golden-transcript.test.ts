// Byte-exact golden transcript tests (design note §11 suite 1): the full
// session lifecycle, the INV-1 insertAbove recipe, prevDiff/damage tracking
// (when the shrink-erase fires), INV-6 drops during a LIVE flush, frame
// composition over OSC 8 / CJK / emoji geometry, and the documented
// shrink-float -> re-pin sequence. The Grid proves state; the recorder pins
// bytes -- scrollback is write-once, so the exact bytes are the contract.

import { describe, it, expect } from "bun:test";
import { GridTerminal } from "@utils/cli/renderer/grid.ts";
import { FakeClock } from "@utils/cli/renderer/fake-clock.ts";
import { RendererCore } from "@utils/cli/renderer/commit.ts";
import { TeardownGuard } from "@utils/cli/renderer/teardown.ts";
import type { Terminal } from "@utils/cli/renderer/seams.ts";

const W = {
  on: "\x1b[?2026h",
  off: "\x1b[?2026l",
  hide: "\x1b[?25l",
  show: "\x1b[?25h",
  el: "\x1b[K",
  ed: "\x1b[J",
  sgr: "\x1b[0m",
  pasteOn: "\x1b[?2004h",
  pasteOff: "\x1b[?2004l",
};

// The two normative byte recipes (commit.ts paintBody / insertAbove), restated
// here so a drift in the implementation FAILS the golden instead of both
// sides silently agreeing.
const paint = (rows: string[], erase = false): string =>
  "\r" +
  (erase ? W.ed : "") +
  rows.map((r) => r + W.el).join("\r\n") +
  "\r" +
  (rows.length > 1 ? `\x1b[${rows.length - 1}A` : "");

const insertAbove = (payload: string[], h: number): string =>
  (h > 1 ? `\x1b[${h - 1}B` : "") +
  "\r\n".repeat(payload.length) +
  `\x1b[${payload.length + h - 1}A` +
  `\x1b[${payload.length}L` +
  payload.map((r) => r + W.el + "\r\n").join("");

/** Records every write and feeds a Grid for state checks. */
function recorder(rows: number, cols: number) {
  const inner = new GridTerminal({ rows, cols });
  const bytes: string[] = [];
  const t: Terminal = {
    write: (s) => {
      bytes.push(s);
      inner.write(s);
    },
    get isTTY() {
      return true;
    },
    get columns() {
      return inner.columns;
    },
    get rows() {
      return inner.rows;
    },
    setRawMode: (on) => inner.setRawMode(on),
    onResize: (cb) => inner.onResize(cb),
  };
  const clock = new FakeClock();
  const core = new RendererCore({ terminal: t, clock });
  inner.grid.cursorRow = rows - 1; // mount at the shell prompt: bottom row
  // gt exposes the GridTerminal (resize fires onResize like process.stdout).
  return { inner, gt: inner, t, clock, core, stream: () => bytes.join("") };
}

describe("golden transcript: full session lifecycle (byte-exact)", () => {
  it("mount -> grow -> commit -> shrink -> teardown, every byte pinned", () => {
    const { inner, clock, core, stream } = recorder(6, 10);

    core.setFrame(["A1", "A2"]); // pre-mount: must not write anything
    expect(stream()).toBe("");

    core.mount();
    const mount = W.on + W.hide + paint(["A1", "A2"]) + W.show + W.off;
    expect(stream()).toBe(mount);

    core.setFrame(["A1", "A2", "A3"]); // grow: repaint, never an erase
    clock.runImmediates();
    const grow = W.on + W.hide + paint(["A1", "A2", "A3"]) + W.show + W.off;
    expect(stream()).toBe(mount + grow);

    core.commit(["T1"]);
    clock.runAll();
    const flush =
      W.on +
      W.hide +
      paint(["A1", "A2", "A3"]) + // INV-3: frozen frame repaints FIRST
      insertAbove(["T1"], 3) +
      W.show +
      W.off;
    expect(stream()).toBe(mount + grow + flush);
    expect(inner.grid.snapshot().screen).toEqual(["", "", "T1", "A1", "A2", "A3"]);

    core.setFrame(["B1"]); // shrink: INV-5 erase at the anchor
    clock.runAll();
    expect(stream()).toBe(
      mount + grow + flush + W.on + W.hide + paint(["B1"], true) + W.show + W.off
    );

    // Teardown through the guard: erase-frame bytes, then the mode unwind as
    // one synchronized block (raw-mode/paste changes are mode-log, not bytes).
    core.modes.setRawMode(true);
    core.modes.bracketedPaste(true);
    const guard = new TeardownGuard({
      modes: core.modes,
      stopRenderer: () => core.stop(),
      drainCommitsSync: () => core.drainCommitsSync(),
      eraseFrame: () => core.eraseFrame(),
    });
    const mark = stream().length;
    guard.run();
    expect(stream().slice(mark)).toBe("\r" + W.ed + W.on + W.pasteOff + W.show + W.sgr + W.off);

    const snap = inner.grid.snapshot();
    expect(snap.screen).toEqual(["", "", "T1", "", "", ""]); // committed row survives
    for (const row of [...snap.scrollback, ...snap.screen]) expect(row).not.toContain("A2");
    // Mode pairing across the whole session (§10): every PAINT window hides
    // the cursor right after ?2026h and shows it right before ?2026l; the
    // teardown window shows+sgr without a matching hide (step 6 is the
    // catch-all for exit paths that stopped painting).
    const full = stream();
    const opens = full.split(W.on).length - 1;
    const closes = full.split(W.off).length - 1;
    expect([opens, closes]).toEqual([5, 5]); // mount, grow, flush, shrink, teardown
    expect(full.split(W.on + W.hide).length - 1).toBe(4); // paint windows only
    expect(full.split(W.show + W.off).length - 1).toBe(4);
    expect(full.split(W.hide).length - 1).toBe(4);
    expect(full.split(W.show).length - 1).toBe(5); // teardown's final show included
  });
});

describe("golden transcript: INV-1 insertAbove byte recipe", () => {
  it("frame top -> down(h-1) -> N line feeds -> up(N+h-1) -> SCI -> payload rows", () => {
    const { inner, core, stream } = recorder(8, 20);
    core.setFrame(["F1", "F2", "F3"]);
    core.mount();
    const before = stream();
    core.commit(["M1", "M2", "M3"]);
    core.drainCommitsSync();

    const flush = stream().slice(before.length);
    expect(flush).toBe(
      W.on +
        W.hide +
        paint(["F1", "F2", "F3"]) +
        "\x1b[2B" + // down(h-1): frame top -> frame bottom
        "\r\n\r\n\r\n" + // N line feeds scroll the room in (INV-2: 3 <= 8-3)
        "\x1b[5A" + // up(N+h-1): lands on the risen frame top
        "\x1b[3L" + // SCI: frame back to the bottom rows, blanks above it
        "M1" + W.el + "\r\n" +
        "M2" + W.el + "\r\n" +
        "M3" + W.el + "\r\n" +
        W.show +
        W.off
    );
    // Payload contiguous with the frame, cursor parked at the new frame top.
    expect(inner.grid.snapshot().screen).toEqual(["", "", "M1", "M2", "M3", "F1", "F2", "F3"]);
  });
});

describe("prevDiff tracking: erase only when the frame shrank or was forced", () => {
  it("equal-height and grow repaints keep the frame state correct without erasing", () => {
    const { inner, clock, core } = recorder(8, 10);
    core.setFrame(["L1", "L2"]);
    core.mount();

    core.setFrame(["L1", "L2x"]); // equal height: overwrite
    clock.runAll();
    core.setFrame(["L1", "L2x", "L3"]); // grow: repaint down, scrolls to make room
    clock.runAll();
    core.setFrame(["L1"]); // shrink: anchor erase (byte-asserted in the next test)
    clock.runAll();

    expect(inner.grid.snapshot().screen[5]).toBe("L1"); // shrunk frame floats at its anchor
    expect(inner.grid.modeLog.filter((m) => m === "?2026h").length).toBe(4); // mount + 3 repaints
  });

  it("byte-level: the shrink window contains the anchor erase, grow/equal do not", () => {
    const { gt, clock, core, stream } = recorder(8, 10);
    core.setFrame(["L1", "L2"]);
    core.mount();
    expect(stream().split(W.ed).length - 1).toBe(0);

    core.setFrame(["L1", "L2x"]);
    clock.runAll();
    expect(stream().split(W.ed).length - 1).toBe(0); // equal: overwrite only

    core.setFrame(["L1", "L2x", "L3"]);
    clock.runAll();
    expect(stream().split(W.ed).length - 1).toBe(0); // grow: no erase ever

    core.setFrame(["L1"]);
    clock.runAll();
    expect(stream().split("\r" + W.ed).length - 1).toBe(1); // shrink: exactly one, at the anchor

    // Resize forces the old-geometry erase even at equal height (§6).
    gt.resize(8, 8);
    clock.runAll();
    expect(stream().split("\r" + W.ed).length - 1).toBe(2);

    // Commit flushes carry no erase unless the frame also shrank.
    const before = stream().split(W.ed).length - 1;
    core.commit(["C1"]);
    clock.runAll();
    expect(stream().split(W.ed).length - 1).toBe(before);
  });
});

describe("INV-6 during a LIVE flush (reentrant), and scheduler bypass paths", () => {
  it("setFrame re-entered from a write DURING the flush is dropped, not painted", () => {
    const inner = new GridTerminal({ rows: 8, cols: 20 });
    const bytes: string[] = [];
    let core: RendererCore | null = null;
    let armed = false;
    const t: Terminal = {
      write: (s) => {
        bytes.push(s);
        // The stage-2b arbiter could re-enter from a writer callback; the
        // freeze-to-insert window must refuse frame mutation mid-flight.
        if (armed && core && s.includes("M1")) {
          armed = false;
          core.setFrame(["EVIL"]);
        }
        inner.write(s);
      },
      get isTTY() {
        return true;
      },
      get columns() {
        return inner.columns;
      },
      get rows() {
        return inner.rows;
      },
      setRawMode: (on) => inner.setRawMode(on),
      onResize: (cb) => inner.onResize(cb),
    };
    core = new RendererCore({ terminal: t, clock: new FakeClock() });
    const c = core;
    inner.grid.cursorRow = 7;
    c.setFrame(["F1"]);
    c.mount();
    c.commit(["M1"]);
    armed = true;
    c.drainCommitsSync(); // synchronous flush; write hook re-enters mid-window

    expect(c.droppedMutationCount).toBe(1);
    const all = [...inner.grid.snapshot().scrollback, ...inner.grid.snapshot().screen].join("\n");
    expect(all).not.toContain("EVIL");
    expect(bytes.join("")).not.toContain("EVIL");

    // The drain completes untouched by the re-entrant mutation; the frame
    // still repaints normally afterwards (next tick, not exercised here).
    expect(inner.grid.snapshot().screen[7]).toBe("F1");
  });

  it("notifyInput during the queued-commit window paints nothing (INV-6 window)", () => {
    const { inner, clock, core, stream } = recorder(8, 10);
    core.setFrame(["F1"]);
    clock.runAll();
    core.commit(["P1"]); // queued; flush immediate not run yet
    const before = stream();
    core.notifyInput();
    expect(stream()).toBe(before); // zero bytes: nothing transient may ride the window
    clock.runAll();
    expect(stream()).not.toBe(before); // the commit itself still lands
    expect(inner.grid.snapshot().screen.slice(6)).toEqual(["P1", "F1"]);
  });

  it("resize during the queued-commit window defers the forced erase into the first post-drain paint", () => {
    const { inner, gt, clock, core, stream } = recorder(8, 10);
    core.setFrame(["F1", "F2"]);
    clock.runAll();
    core.commit(["R1"]); // queued
    gt.resize(6, 8); // fires handleResize while the print is pending
    const flushMark = stream().length;
    clock.runAll(); // drain first (paint-time width 6), then the deferred erase-repaint

    const after = stream().slice(flushMark);
    expect(after).toContain("R1");
    expect(after.split("\r" + W.ed).length - 1).toBe(1); // exactly one forced old-geometry erase
    for (const row of inner.grid.snapshot().screen) expect(row.length).toBeLessThanOrEqual(6);
    const all = [...inner.grid.snapshot().scrollback, ...inner.grid.snapshot().screen].join("\n");
    expect(all).toContain("R1");
  });
});

describe("frame composition: OSC 8 + CJK + emoji bottom-anchored geometry", () => {
  it("frame rows wrap by visible width and occupy exactly the bottom h rows", () => {
    const { inner, core } = recorder(6, 4);
    const link = "\x1b]8;;https://example.com/a/very/long/target\x07link\x1b]8;;\x07";
    core.setFrame([link, "日本語", "\u{1f600}hi"]);
    core.mount(); // mount paints the frame immediately (no scheduler wait)
    const snap = inner.grid.snapshot();
    expect(snap.screen).toEqual(["", "", "link", "日本", "語", "\u{1f600}hi"]);
    // OSC 8 bytes rode the write but carry no geometry; the frame is 4 rows,
    // bottom-anchored (h = wrapped row count, INV-4 minimum respected).
    expect(snap.screen.slice(0, 2).every((r) => r === "")).toBe(true);
  });
});

describe("shrink float -> re-pin (documented consequence of the literal INV-5)", () => {
  it("a shrunk frame floats above the bottom margin; commits consume the gap and re-pin it, INV-2 math exact throughout", () => {
    const { inner, clock, core } = recorder(6, 10);
    core.setFrame(["A1", "A2"]);
    core.mount(); // frame rows 4..5, anchor 4
    core.setFrame(["B1"]); // shrink at the anchor: B1 lands at 4, gap = row 5
    clock.runAll();
    expect(inner.grid.snapshot().screen).toEqual(["", "", "", "", "B1", ""]);

    core.commit(["C1"]); // the line feed eats the one gap row; SCI slots B1 under C1
    clock.runAll();
    expect(inner.grid.snapshot().screen).toEqual(["", "", "", "", "C1", "B1"]); // pinned again

    core.commit(["C2"]); // classic INV-1 insert from the pinned state (N=1 <= 6-1)
    clock.runAll();
    expect(inner.grid.snapshot().screen).toEqual(["", "", "", "C1", "C2", "B1"]);

    core.commit(["C3"]);
    clock.runAll();
    expect(inner.grid.snapshot().screen).toEqual(["", "", "C1", "C2", "C3", "B1"]);

    // Nothing was ever lost: every committed row exists in order; the scrolls
    // that made room only ever pushed BLANK rows above the frame top.
    const all = [...inner.grid.snapshot().scrollback, ...inner.grid.snapshot().screen].filter((r) =>
      r.startsWith("C") || r === "B1"
    );
    expect(all).toEqual(["C1", "C2", "C3", "B1"]);
  });
});
