// Parented tool events render as indented inner rows under the
// open parent call (split mode only). Drives the REAL stack -- OutputBridge
// over the Grid/FakeClock seams, a real CliOutputSink routed into the bridge
// channels, NestedRowsView + attachNestedRows -- and captures the render.
// No mock.module.

import { describe, it, expect } from "bun:test";
import { CliOutputSink } from "@utils/cli/cli.ts";
import { ColorPalette } from "@utils/cli/colors.ts";
import { OUTPUT_EVENT, type OutputEvent } from "@core/context/output.ts";
import { formatToolResult } from "@core/extensions/tool-utils.ts";
import { GridTerminal, FakeClock } from "@utils/cli/renderer/index.ts";
import type { SignalHost } from "@utils/cli/renderer/index.ts";
import { OutputBridge } from "@extensions/ui-interactive-cli/split-bridge.ts";
import {
  NestedRowsView,
  attachNestedRows,
  parentOf,
  NESTED_MAX_FRAME_ROWS,
} from "@extensions/ui-interactive-cli/nested-rows.ts";

class FakeSignalHost implements SignalHost {
  on(): () => void {
    return () => {};
  }
  exit(): void {}
}

interface Rig {
  bridge: OutputBridge;
  clock: FakeClock;
  sink: CliOutputSink;
  view: NestedRowsView;
  /** Live frame rows (trailing blanks trimmed per row). */
  screen(): string[];
  screenText(): string;
  /** Fire pending paint immediates + the 16ms throttled frame timer.
   *  (advance, never runAll, once a working tick is armed: the tick chain
   *  self-reschedules and runAll's runaway guard would (rightly) throw.) */
  drain(): void;
}

/** The split-session miniature: bridge + sink wired like runInteractiveSession
 *  does, the view attached, view + bridge sharing one scripted Clock. */
function makeRig(): Rig {
  const term = new GridTerminal({ rows: 24, cols: 80 });
  const clock = new FakeClock();
  const bridge = new OutputBridge({ terminal: term, clock, signalHost: new FakeSignalHost() });
  bridge.mount();
  const sink = new CliOutputSink({ palette: new ColorPalette({ use_colors: false }) });
  sink.outStream = { write: (s: string) => (bridge.commitText(s), true) } as never;
  sink.altStream = { write: (s: string) => (bridge.arbiteText(s), true) } as never;
  sink.logRouter = (m: string) => bridge.commitText(m + "\n");
  const view = new NestedRowsView({
    now: () => clock.now(),
    repaint: () => bridge.refreshNestedRows(),
    commit: (rows) => {
      if (rows.length > 0) sink._processContent(`\n${rows.join("\n")}`);
    },
  });
  bridge.setNestedRows(() => view.snapshot());
  attachNestedRows(sink, view);
  const screen = (): string[] =>
    term.grid.snapshot().screen.map((r) => r.replace(/\s+$/, ""));
  return {
    bridge,
    clock,
    sink,
    view,
    screen,
    screenText: () => screen().join("\n"),
    drain: () => clock.advance(20),
  };
}

const call = (toolName: string, toolCallId: string, parentToolCallId?: string): OutputEvent =>
  ({
    type: OUTPUT_EVENT.TOOL_CALL,
    toolName,
    input: "{}",
    toolCallId,
    ...(parentToolCallId ? { parentToolCallId } : {}),
  }) as OutputEvent;

const result = (
  toolName: string,
  toolCallId: string,
  ok: boolean,
  parentToolCallId?: string,
): OutputEvent =>
  ({
    type: OUTPUT_EVENT.TOOL_RESULT,
    toolName,
    input: "{}",
    content: [formatToolResult(ok ? "done" : "denied by rule", toolName, ok)],
    toolCallId,
    ...(parentToolCallId ? { parentToolCallId } : {}),
  }) as OutputEvent;

describe("parented events render nested, not top-level", () => {
  it("inner call + result ride ↳ rows under the parent call row; nothing top-level", () => {
    const { bridge, clock, sink, view, screenText, drain } = makeRig();
    sink.emit(call("codemode", "c1"));
    sink.emit(call("read", "c1/1", "c1"));
    clock.advance(12);
    sink.emit(result("read", "c1/1", true, "c1"));
    drain();

    // While the parent is open the inner row is a FRAME row (the live tree),
    // finalized with checkmark + duration once answered.
    expect(screenText()).toContain("  ↳ read ✓ 12ms");

    sink.emit(result("codemode", "c1", true));
    bridge.flushPending();
    clock.runAll();

    const lines = bridge.transcriptLog;
    const callAt = lines.findIndex((l) => l.includes("🔧 codemode"));
    const rowAt = lines.findIndex((l) => l === "  ↳ read ✓ 12ms");
    expect(callAt).toBeGreaterThanOrEqual(0);
    // Indented row directly under the parent's call row, before the result box.
    expect(rowAt).toBe(callAt + 1);
    // The inner call NEVER appears as a top-level tool-call row.
    expect(lines.filter((l) => l.includes("🔧 read"))).toHaveLength(0);
    // The live tree is empty again (the committed row stays on the
    // write-once terminal screen exactly like any other history row).
    expect(view.snapshot()).toBeNull();
  });

  it("a failed inner call renders ✗; concurrency keeps call order", () => {
    const { bridge, clock, sink } = makeRig();
    sink.emit(call("codemode", "c1"));
    sink.emit(call("bash", "c1/1", "c1"));
    sink.emit(call("read", "c1/2", "c1"));
    clock.advance(3000);
    sink.emit(result("bash", "c1/1", false, "c1"));
    sink.emit(result("read", "c1/2", true, "c1"));
    sink.emit(result("codemode", "c1", true));
    bridge.flushPending();
    clock.runAll();

    const lines = bridge.transcriptLog.filter((l) => l.startsWith("  ↳"));
    expect(lines).toEqual(["  ↳ bash ✗ 3.0s", "  ↳ read ✓ 3.0s"]);
  });
});

describe("live inner row: elapsed-timer tail on the working tick", () => {
  it("open rows tick with the bridge's 1s chain; completion freezes the duration", () => {
    const { bridge, clock, sink, screenText, drain } = makeRig();
    bridge.updateStatus({ working: true });
    sink.emit(call("codemode", "c1"));
    sink.emit(call("bash", "c1/1", "c1"));
    drain();
    expect(screenText()).toContain("  ↳ bash 00:00");

    // The working tick repaints (the status row's elapsed advances); the
    // nested tail is recomposed at paint time -- no timer of its own.
    clock.advance(5000);
    expect(screenText()).toContain("  ↳ bash 00:05");

    // Completion freezes the REAL span; the turn tick keeps running.
    sink.emit(result("bash", "c1/1", true, "c1"));
    drain();
    expect(screenText()).toContain("  ↳ bash ✓ 5.0s");
    bridge.updateStatus({ working: false });
  });
});

describe("cold replay: unknown parentToolCallId renders with no UI break", () => {
  it("an orphan parented result (no call, no run) commits finalized rows, no duration claim", () => {
    const { bridge, clock, sink, view } = makeRig();
    sink.emit(result("read", "old/1", true, "p-old"));
    sink.emit(result("bash", "p-old/2", false, "p-old"));
    sink.log(""); // terminate the open rows
    clock.runAll();

    const lines = bridge.transcriptLog.filter((l) => l.startsWith("  ↳"));
    // Marks ride, durations do not: nothing was ever measured for a replay.
    expect(lines).toEqual(["  ↳ read ✓", "  ↳ bash ✗"]);
    // No phantom tree was opened, so nothing can strand in the frame.
    expect(view.snapshot()).toBeNull();
  });

  it("a result whose CALL was skipped joins the open tree and commits with it", () => {
    // The executor's unavailable-name path answers a nested dispatch with a
    // tool_result and never emits its tool_call; the row must ride the tree.
    const { bridge, clock, sink } = makeRig();
    sink.emit(call("codemode", "c1"));
    sink.emit(result("ghost", "c1/1", false, "c1"));
    sink.emit(result("codemode", "c1", true));
    bridge.flushPending();
    clock.runAll();
    expect(bridge.transcriptLog.filter((l) => l.startsWith("  ↳"))).toEqual(["  ↳ ghost ✗"]);
  });

  it("a duplicate late event for an answered id commits nothing extra", () => {
    const { bridge, clock, sink } = makeRig();
    sink.emit(call("codemode", "c1"));
    sink.emit(call("read", "c1/1", "c1"));
    sink.emit(result("read", "c1/1", true, "c1"));
    sink.emit(result("read", "c1/1", true, "c1")); // late duplicate
    sink.emit(result("codemode", "c1", true));
    bridge.flushPending();
    clock.runAll();
    expect(bridge.transcriptLog.filter((l) => l.startsWith("  ↳"))).toHaveLength(1);
  });
});

describe("skip-unknown: unmappable parent fields keep today's top-level rendering", () => {
  it("empty or non-string parentToolCallId is no parent at all", () => {
    expect(parentOf({ parentToolCallId: "" })).toBeNull();
    expect(parentOf({ parentToolCallId: 42 })).toBeNull();
    expect(parentOf({})).toBeNull();
    expect(parentOf({ parentToolCallId: "c1" })).toBe("c1");

    const { bridge, clock, sink } = makeRig();
    const garbage = (base: OutputEvent, parentToolCallId: unknown): OutputEvent =>
      ({ ...base, parentToolCallId }) as unknown as OutputEvent;
    sink.emit(garbage(call("read", "r1"), ""));
    sink.emit(garbage(result("read", "r1", true), ""));
    bridge.flushPending();
    clock.runAll();
    // A top-level tool-call row printed; no nested row anywhere.
    expect(bridge.transcriptLog.some((l) => l.includes("🔧 read"))).toBe(true);
    expect(bridge.transcriptLog.filter((l) => l.startsWith("  ↳"))).toHaveLength(0);
  });

  it("a parented RESULT for a run that never opened commits nothing phantom", () => {
    const { bridge, clock, sink } = makeRig();
    sink.emit(result("ghostly", "g1", false, "never-opened"));
    sink.log("");
    clock.runAll();
    // The orphan path commits exactly one finalized row and keeps painting.
    expect(bridge.transcriptLog.filter((l) => l.startsWith("  ↳"))).toEqual(["  ↳ ghostly ✗"]);
    sink.emit(call("read", "later")); // the sink still renders normally
    bridge.flushPending();
    clock.runAll();
    expect(bridge.transcriptLog.some((l) => l.includes("🔧 read"))).toBe(true);
  });

  it("hideTools hides inner rows too, and the tree still closes silently", () => {
    const { bridge, clock, sink } = makeRig();
    sink.hideTools = true;
    sink.emit(call("codemode", "c1"));
    sink.emit(call("read", "c1/1", "c1"));
    sink.emit(result("read", "c1/1", true, "c1"));
    sink.emit(result("codemode", "c1", true));
    bridge.flushPending();
    clock.runAll();
    expect(bridge.transcriptLog.filter((l) => l.startsWith("  ↳"))).toHaveLength(0);
    // Nothing stranded: the next run starts from an empty tree.
    sink.hideTools = false;
    sink.emit(call("codemode", "c2"));
    sink.emit(call("read", "c2/1", "c2"));
    sink.emit(result("codemode", "c2", true));
    bridge.flushPending();
    clock.runAll();
    expect(bridge.transcriptLog.filter((l) => l.startsWith("  ↳"))).toEqual([
      "  ↳ read ✗ (no result)",
    ]);
  });
});

describe("frame cap and turn teardown", () => {
  it("the live tree caps at NESTED_MAX_FRAME_ROWS plus a tail line; commits stay uncapped", () => {
    const { bridge, clock, sink, screen } = makeRig();
    sink.emit(call("codemode", "c1"));
    for (let i = 1; i <= NESTED_MAX_FRAME_ROWS + 3; i++) {
      sink.emit(call("read", `c1/${i}`, "c1"));
    }
    clock.runAll();
    const rows = screen().filter((r) => r.includes("↳"));
    expect(rows).toHaveLength(NESTED_MAX_FRAME_ROWS + 1);
    expect(rows[NESTED_MAX_FRAME_ROWS]).toContain("(+3 more)");

    sink.emit(result("codemode", "c1", true));
    bridge.flushPending();
    clock.runAll();
    expect(bridge.transcriptLog.filter((l) => l.startsWith("  ↳"))).toHaveLength(
      NESTED_MAX_FRAME_ROWS + 3,
    );
  });

  it("turn end drops live rows; a late answer still lands as history", () => {
    const { bridge, clock, sink, view, screen, drain } = makeRig();
    bridge.updateStatus({ working: true });
    sink.emit(call("codemode", "c1"));
    sink.emit(call("bash", "c1/1", "c1"));
    drain();
    expect(screen().some((r) => r.includes("↳ bash"))).toBe(true);

    // The glue's working:false branch: clearInflight + endAttempt + clearAll.
    bridge.updateStatus({ working: false });
    view.clearAll();
    drain();
    // The live row was never committed, so a repaint takes it off screen.
    expect(screen().some((r) => r.includes("↳ bash"))).toBe(false);

    // Cancel result arriving after the turn stopped: still history.
    sink.emit(result("bash", "c1/1", false, "c1"));
    sink.log("");
    clock.runAll();
    expect(bridge.transcriptLog.filter((l) => l.startsWith("  ↳ bash ✗"))).toHaveLength(1);
  });

  it("a parent answered while an inner call is open closes it as (no result)", () => {
    const { bridge, clock, sink } = makeRig();
    sink.emit(call("codemode", "c1"));
    sink.emit(call("bash", "c1/1", "c1"));
    sink.emit(result("codemode", "c1", true));
    bridge.flushPending();
    clock.runAll();
    expect(bridge.transcriptLog.filter((l) => l.startsWith("  ↳"))).toEqual([
      "  ↳ bash ✗ (no result)",
    ]);
  });
});

describe("legacy path byte-identical: no attach, no behavior", () => {
  it("an unattached sink renders a parented event exactly like an unparented one", () => {
    function capture(parented: boolean): string[] {
      const written: string[] = [];
      const sink = new CliOutputSink({ palette: new ColorPalette({ use_colors: false }) });
      const out = { write: (s: string) => (written.push(s), true) };
      sink.outStream = out as never;
      sink.altStream = out as never;
      sink.emit(call("read", parented ? "x/1" : "x1", parented ? "x" : undefined));
      sink.emit(result("read", parented ? "x/1" : "x1", true, parented ? "x" : undefined));
      return written;
    }
    // Same bytes up to the ids: the parent field changes nothing when no
    // nested view is wired (the whole legacy / one-shot surface).
    const a = capture(true).join("|").replaceAll("x/1", "#");
    const b = capture(false).join("|").replaceAll("x1", "#");
    expect(a).toBe(b);
    expect(a).toContain("🔧 read");
  });
});
