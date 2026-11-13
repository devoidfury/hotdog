// Subagent sidebar row helpers + status glyph (src/extensions/webui/ui/
// subagents.tsx): the elapsed clock semantics and the glyph map are the
// migrated pins from the retired strip suite (formatElapsed / parked /
// SubagentStatusGlyph), restated for the sidebar rows. The section DOM
// itself (rows, disclosure, routing) is pinned in tests/dom-helper/
// sessions.test.tsx; the feed + main-view transcript in webui-chat.test.ts.

import { describe, it, expect } from "bun:test";
import {
  formatElapsed,
  chipLabel,
  runDiscriminators,
} from "@extensions/webui/ui/subagents.tsx";
import { SubagentStatusGlyph } from "@extensions/webui/ui/icons.tsx";
import { renderToString } from "@utils/jsx";
import type { TaskInfoWire } from "@extensions/websocket/protocol.ts";

const taskInfoWire: TaskInfoWire = {
  taskId: "t1",
  description: "worker",
  sessionId: "s1",
  status: "running",
  createdAt: 0,
  startedAt: null,
  endedAt: null,
  activeMs: 0,
  inRun: false,
  turnStartedAt: null,
};

// ── formatElapsed ───────────────────────────────────────────────────────────

describe("formatElapsed", () => {
  it("ticks accumulated active time only during an in-flight turn", () => {
    const live: TaskInfoWire = {
      ...taskInfoWire,
      activeMs: 65_000,
      inRun: true,
      turnStartedAt: 1_000,
    };
    expect(formatElapsed(live, 1_000)).toBe("1m 5s");
    expect(formatElapsed(live, 31_000)).toBe("1m 35s"); // ticks with `now` while running
  });

  it("freezes parked-running and terminal tasks at the accumulated total", () => {
    // RUNNING with no turn in flight = parked (judge running for it, waiting
    // on a lane slot, between warm retries): the clock must not tick.
    const parked: TaskInfoWire = { ...taskInfoWire, activeMs: 65_000, inRun: false, turnStartedAt: null };
    expect(formatElapsed(parked, 9_999_999)).toBe("1m 5s");
    // Completed total is the accumulated active time, not endedAt - startedAt.
    const done: TaskInfoWire = {
      ...parked,
      status: "completed",
      startedAt: 0,
      endedAt: 90_000,
    };
    expect(formatElapsed(done, 9_999_999)).toBe("1m 5s");
  });

  it("queued tasks still show their wall-clock wait", () => {
    const queued: TaskInfoWire = {
      ...taskInfoWire,
      status: "queued",
      createdAt: 0,
      activeMs: 0,
      inRun: false,
      turnStartedAt: null,
    };
    expect(formatElapsed(queued, 3_720_000)).toBe("1h 2m");
  });
});

// ── Labels ──────────────────────────────────────────────────────────────────

describe("chipLabel + runDiscriminators", () => {
  it("labels the step name after the last ':', falls back to description words, then the raw id", () => {
    expect(chipLabel({ taskId: "hotdog-archeology:review#2", description: "x" })).toBe("review#2");
    expect(chipLabel({ taskId: "plain-id", description: "do the thing now please" })).toBe(
      "do the thing now please",
    );
    expect(chipLabel({ taskId: "plain-id", description: "one two three four five six" })).toBe(
      "one two three four five",
    );
    expect(chipLabel({ taskId: "plain-id", description: "" })).toBe("plain-id");
  });

  it("prefixes per-run discriminators only when the list spans 2+ runs", () => {
    const oneRun = [
      { ...taskInfoWire, taskId: "20261017-1848-hotdog-archeology:review#1" },
      { ...taskInfoWire, taskId: "20261017-1848-hotdog-archeology:report#2" },
    ];
    expect(runDiscriminators(oneRun).size).toBe(0);

    const twoRuns = [
      ...oneRun,
      { ...taskInfoWire, taskId: "20261017-1848-hotdog-reprint:pass#1" },
    ];
    const discs = runDiscriminators(twoRuns);
    // The shortest unique tail: no reprinting of the shared timestamp run.
    expect(discs.get("20261017-1848-hotdog-archeology:review#1")).toBe("archeology");
    expect(discs.get("20261017-1848-hotdog-reprint:pass#1")).toBe("reprint");
  });
});

// ── Status glyph ────────────────────────────────────────────────────────────

describe("SubagentStatusGlyph", () => {
  it("picks one inline-SVG glyph per token (parked wins, unknown dots)", () => {
    // The map names the shape on the svg class; decoration and
    // tab-invisibility are pinned on the same render.
    const cls = (status: string, parked = false): string =>
      renderToString(<SubagentStatusGlyph status={status} parked={parked} />);
    expect(cls("completed")).toContain('class="subagent-glyph subagent-glyph-completed"');
    expect(cls("failed")).toContain("subagent-glyph-failed");
    expect(cls("cancelled")).toContain("subagent-glyph-cancelled");
    expect(cls("running")).toContain("subagent-glyph-running");
    expect(cls("queued")).toContain("subagent-glyph-queued");
    expect(cls("weird")).toContain("subagent-glyph-unknown");
    expect(cls("running", true)).toContain("subagent-glyph-parked");
    const one = cls("queued");
    expect(one).toContain('aria-hidden="true"');
    expect(one).toContain('tabindex="-1"');
    expect(one).toContain('stroke="currentColor"');
  });
});
