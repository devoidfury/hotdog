// Golden-grid commit-protocol tests (design note §11 suite 1+2): scripted
// sequences against the in-memory Grid, no PTY, no mock.module.
//
// Harness note: the renderer paints the frame downward from wherever the
// cursor sits at mount; the real world mounts at the shell prompt, i.e. the
// bottom row. Tests reproduce that by parking the grid cursor on the bottom
// row before mount() -- every commit then keeps the frame bottom-anchored,
// exactly as the INV-2 capacity math (H - h) assumes.

import { describe, it, expect } from "bun:test";
import { GridTerminal } from "@utils/cli/renderer/grid.ts";
import { FakeClock } from "@utils/cli/renderer/fake-clock.ts";
import { RendererCore } from "@utils/cli/renderer/commit.ts";
import type { Terminal } from "@utils/cli/renderer/seams.ts";

function harness(rows = 8, cols = 20, opts: { transcript?: () => string[]; preRoll?: string } = {}) {
  const t = new GridTerminal({ rows, cols });
  // Pre-session history: written BEFORE mount. Seeding after mount would drop
  // bytes into the live frame region and contaminate the scroll arithmetic.
  if (opts.preRoll) t.grid.feed(opts.preRoll);
  const clock = new FakeClock();
  const core = new RendererCore({ terminal: t, clock, transcript: opts.transcript });
  t.grid.cursorRow = rows - 1;
  core.mount();
  return { t, grid: t.grid, clock, core };
}

describe("INV-2 capacity boundary (N <= H - h)", () => {
  it("a commit of exactly H-h rows lands above the frame without scrolling the frame out", () => {
    const { t, clock, core } = harness(8, 20, { preRoll: "banner\r\n" }); // row 0 of pre-session history
    core.setFrame(["F1", "F2"]);
    clock.runAll();
    core.commit(["P1", "P2", "P3", "P4", "P5", "P6"]); // N=6 == H-h exactly
    clock.runAll();

    const snap = t.grid.snapshot();
    expect(snap.screen).toEqual(["P1", "P2", "P3", "P4", "P5", "P6", "F1", "F2"]);
    // The frame stayed on screen; the six line feeds pushed the six previous
    // screen rows (banner first) into write-once scrollback.
    expect(snap.scrollback).toEqual(["banner", "", "", "", "", "", ""]);
  });

  it("a commit of H-h+1 rows chunks into two INV-2-legal prints; frame never strands", () => {
    const { t, clock, core } = harness(8, 20, { preRoll: "banner\r\n" });
    core.setFrame(["F1", "F2"]);
    clock.runAll();
    core.commit(["P1", "P2", "P3", "P4", "P5", "P6", "P7"]); // N=7 == H-h+1
    clock.runAll();

    const snap = t.grid.snapshot();
    // Chunked 6 + 1; the second chunk's line feed scrolls P1 out of the screen.
    expect(snap.screen).toEqual(["P2", "P3", "P4", "P5", "P6", "P7", "F1", "F2"]);
    expect(snap.scrollback).toEqual(["banner", "", "", "", "", "", "", "P1"]);
  });

  it("chunk capacity is recomputed at paint time, after freeze, not at commit time", () => {
    // Queue a 7-row commit at H=8 (capacity 6), then shrink the viewport to
    // H=6 before the flush -- the chunker must see H=6/h and split 4+3.
    const { t, clock, core } = harness(8);
    core.setFrame(["F1", "F2"]);
    clock.runAll();
    core.commit(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"]);
    t.resize(20, 6); // fires the resize listener; flush has not run yet
    clock.runAll();

    const snap = t.grid.snapshot();
    // Frame must be the bottom h=2 rows of the NEW height, fully visible.
    expect(snap.screen.slice(4)).toEqual(["F1", "F2"]);
    // Every committed row survives somewhere, in order, with nothing stranded.
    const all = [...snap.scrollback, ...snap.screen].filter((r) => r.startsWith("Q"));
    expect(all).toEqual(["Q1", "Q2", "Q3", "Q4", "Q5", "Q6", "Q7"]);
  });
});

describe("INV-5 shrink erases from the frame top with previous geometry", () => {
  it("5-row frame -> 2-row frame -> commit leaves zero ghost rows (byte-identical)", () => {
    const { t, clock, core } = harness(8, 20, { preRoll: "banner\r\n" });
    core.setFrame(["r1", "r2", "r3", "r4", "r5"]);
    clock.runAll();
    core.commit(["C1"]); // grows scrollback; frame stays at rows 3..7
    clock.runAll();

    core.setFrame(["s1", "s2"]); // shrink: must erase r1..r5 at the anchor
    clock.runAll();
    expect(t.grid.snapshot().screen).toEqual(["", "", "C1", "s1", "s2", "", "", ""]);

    // The moment of truth: this commit's line feeds would push any surviving
    // ghost rows (r2..r5) into scrollback forever.
    core.commit(["C2"]);
    clock.runAll();

    const snap = t.grid.snapshot();
    expect(snap.screen).toEqual(["", "", "C1", "C2", "s1", "s2", "", ""]);
    expect(snap.scrollback).toEqual(["banner", "", "", "", ""]);
    for (const row of [...snap.scrollback, ...snap.screen]) {
      expect(row.startsWith("r")).toBe(false); // no ghosts, anywhere
    }
  });
});

describe("INV-3 freeze-and-paint + INV-4 never-zero frame", () => {
  it("the frozen frame repaints before the first insert, inside one ?2026 window", () => {
    // Recording wrapper: order assertions need the raw byte stream, which the
    // Grid consumes as it parses.
    const inner = new GridTerminal({ rows: 8, cols: 20 });
    const bytes: string[] = [];
    const rec: Terminal = {
      write: (s) => {
        bytes.push(s);
        inner.write(s);
      },
      get isTTY() { return true; },
      get columns() { return inner.columns; },
      get rows() { return inner.rows; },
      setRawMode: () => {},
      onResize: () => () => {},
    };
    const core = new RendererCore({ terminal: rec, clock: new FakeClock() });
    inner.grid.cursorRow = 7;
    core.setFrame(["F1"]);
    core.mount();
    core.commit(["P1"]);
    core.drainCommitsSync(); // synchronous drain of the queued print

    const stream = bytes.join("");
    const flushStart = stream.lastIndexOf("?2026h");
    expect(flushStart).toBeGreaterThan(-1);
    expect(stream.indexOf("F1", flushStart)).toBeLessThan(stream.indexOf("P1", flushStart));
    expect(stream.indexOf("?2026l", flushStart)).toBeGreaterThan(stream.indexOf("P1", flushStart));
  });

  it("an empty frame is one blank row and commits never leak a blank seam line", () => {
    const { t, clock, core } = harness(8, 20, { preRoll: "old\r\n" });
    // Never call setFrame: the mounted frame is the INV-4 single blank row.
    core.commit(["P1"]);
    clock.runAll();

    const snap = t.grid.snapshot();
    expect(snap.screen[6]).toBe("P1"); // directly above the frame row
    expect(snap.screen[7]).toBe(""); // the one-blank-row frame, no doubled blank
    // Write-once check: the h=0 regression leaks a BLANK row into scrollback
    // (a doubled scroll), which the screen rows alone cannot see.
    expect(snap.scrollback).toEqual(["old"]);
    expect(snap.screen.slice(0, 6)).toEqual(["", "", "", "", "", ""]);
  });
});

describe("INV-6 nothing transient rides the frame while a print is pending", () => {
  it("setFrame during a queued commit is dropped, not painted", () => {
    const { t, clock, core } = harness(8);
    core.setFrame(["F1"]);
    clock.runAll();

    core.commit(["P1"]); // queued only: runAll would drain it before the next line
    core.setFrame(["F1", "GHOST"]); // mutation arrives while the print is queued
    expect(core.droppedMutationCount).toBe(1);

    clock.runAll(); // flush: freeze paints F1, inserts P1
    const snap = t.grid.snapshot();
    expect(snap.screen).toEqual(["", "", "", "", "", "", "P1", "F1"]);
    for (const row of [...snap.scrollback, ...snap.screen]) {
      expect(row).not.toContain("GHOST");
    }

    // The frame recovers on the next mutation after the print drains.
    core.setFrame(["F1", "after"]);
    clock.runAll();
    expect(t.grid.snapshot().screen.slice(6)).toEqual(["F1", "after"]);
  });
});

describe("single-flight FIFO commit queue", () => {
  it("batches queued before the tick drain as one print, batch order preserved", () => {
    const { t, clock, core } = harness(8);
    core.commit(["A1", "A2"]);
    core.commit(["B1"]); // queued behind A, same tick
    clock.runAll();

    const snap = t.grid.snapshot();
    expect(snap.screen.slice(4, 7)).toEqual(["A1", "A2", "B1"]);
    // mount paint + one synchronized window for the whole drain
    const t0 = t.grid.modeLog.filter((m) => m === "?2026h").length;
    expect(t0).toBe(2);

    // A second commit after the drain gets its own window, still after the first.
    core.commit(["C1"]);
    clock.runAll();
    expect(t.grid.snapshot().screen.slice(3, 7)).toEqual(["A1", "A2", "B1", "C1"]);
    expect(t.grid.modeLog.filter((m) => m === "?2026h").length).toBe(3);
  });

  it("commits issued from inside a live flush still drain (no stranded queue)", () => {
    // Reentrancy path the stage-2b arbiter will use: a commit that lands
    // between drain start and the next tick must schedule its own follow-up.
    const { t, clock, core } = harness(8);
    core.commit(["X1"]);
    core.drainCommitsSync(); // flush now, bypassing the queued immediate
    core.commit(["X2"]); // nothing scheduled yet -> must schedule fresh
    clock.runAll();
    expect(t.grid.snapshot().screen.slice(5, 7)).toEqual(["X1", "X2"]);
  });
});

describe("resize: width read per line at paint time (§6)", () => {
  it("pending coalesced paint uses the NEW width; frame rows never exceed it", () => {
    const { t, clock, core } = harness(8, 40);
    core.setFrame(["x".repeat(35)]);
    clock.runAll();
    expect(t.grid.snapshot().screen[7]).toBe("x".repeat(35));

    core.setFrame(["x".repeat(35)]); // coalesce a request, do NOT run immediates
    t.resize(10, 8); // resize listener also repaints (old-geometry erase)
    clock.runAll(); // the coalesced paint now runs at the new width

    const snap = t.grid.snapshot();
    for (const row of snap.screen) expect(row.length).toBeLessThanOrEqual(10);
    // 35 x's at width 10 = 4 frame rows, bottom-anchored.
    expect(snap.screen.slice(4)).toEqual(["x".repeat(10), "x".repeat(10), "x".repeat(10), "x".repeat(5)]);
  });

  it("commit payloads wrap to the paint-time width after a live resize", () => {
    const { t, clock, core } = harness(8, 40);
    core.setFrame(["F"]);
    clock.runAll();
    t.resize(10, 8);
    core.commit(["y".repeat(25)]);
    clock.runAll();

    // 25 y's wrap to 3 rows of <=10 at flush time; frame row ends up at the
    // screen bottom under the payload.
    // Trace: 3 LFs scroll the frame row up to row 4, SCI pushes it back to
    // the screen bottom, payload lands in the 3 inserted rows above it.
    const snap = t.grid.snapshot();
    expect(snap.screen.slice(4)).toEqual([
      "y".repeat(10),
      "y".repeat(10),
      "y".repeat(5),
      "F",
    ]);
  });
});

describe("purge-and-reprint recovery (§6, never RIS)", () => {
  it("clears screen + scrollback, re-emits the transcript log exactly, repaints the frame", () => {
    const transcript = ["T1", "T2"];
    const { t, clock, core } = harness(8, 20, { transcript: () => transcript });
    core.setFrame(["F1"]);
    clock.runAll();
    core.commit(["D1"]);
    clock.runAll();
    expect(t.grid.scrollback.length).toBeGreaterThan(0);

    core.purgeAndReprint();
    const snap = t.grid.snapshot();
    expect(snap.scrollback).toEqual([]); // ESC[3J did its job
    expect(snap.screen.slice(0, 2)).toEqual(["T1", "T2"]);
    expect(snap.screen[2]).toBe("F1"); // frame repaints directly under the re-emitted log

    // Byte-level: the recipe is ESC[2J ESC[3J ESC[H and NEVER RIS (ESC c) --
    // iTerm/Terminal.app keep scrollback through RIS (§6 grok caveat).
    const inner = new GridTerminal({ rows: 8, cols: 20 });
    const bytes: string[] = [];
    const rec: Terminal = {
      write: (s) => {
        bytes.push(s);
        inner.write(s);
      },
      get isTTY() { return true; },
      get columns() { return inner.columns; },
      get rows() { return inner.rows; },
      setRawMode: () => {},
      onResize: () => () => {},
    };
    const core2 = new RendererCore({ terminal: rec, clock: new FakeClock(), transcript: () => ["R1"] });
    inner.grid.cursorRow = 7;
    core2.mount();
    core2.purgeAndReprint();
    const stream = bytes.join("");
    expect(stream).toContain("\x1b[2J\x1b[3J\x1b[H");
    expect(stream).not.toContain("\x1bc");
    expect(stream).not.toContain("\x1b[!p");
  });

  it("the injected transcript source is consulted per purge, wrapped at current width", () => {
    const wide = "w".repeat(30);
    const { t, clock, core } = harness(8, 20, { transcript: () => [wide] });
    clock.runAll();
    core.purgeAndReprint();
    expect(t.grid.snapshot().screen.slice(0, 2)).toEqual(["w".repeat(20), "w".repeat(10)]);
  });
});

describe("renderer stop (§10 step 1): writes fall through to passthrough", () => {
  it("post-stop commits carry no protocol bytes and paint raw", () => {
    const inner = new GridTerminal({ rows: 8, cols: 20 });
    const bytes: string[] = [];
    const rec: Terminal = {
      write: (s) => {
        bytes.push(s);
        inner.write(s);
      },
      get isTTY() { return true; },
      get columns() { return inner.columns; },
      get rows() { return inner.rows; },
      setRawMode: () => {},
      onResize: () => () => {},
    };
    const clock = new FakeClock();
    const core = new RendererCore({ terminal: rec, clock });
    inner.grid.cursorRow = 7;
    core.mount();
    const before = bytes.join("").length;

    core.stop();
    expect(core.isDead).toBe(true);
    core.commit(["late"]);
    clock.runAll();
    expect(bytes.join("").slice(before)).toBe("late\r\n"); // exactly the rows, nothing else
    expect(core.droppedMutationCount).toBe(0); // setFrame after stop is ignored silently
  });
});
