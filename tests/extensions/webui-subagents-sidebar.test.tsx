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
  openTargetFor,
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
  it("adoptedLive ticks the WALL clock since spawn (no turn anchor exists)", () => {
    // turnStartedAt is null by contract (the in-flight turn started in a
    // dead lifetime), so the clock reads now - createdAt.
    const adoptedLive: TaskInfoWire = {
      ...taskInfoWire,
      status: "running",
      durable: true,
      adoptedLive: true,
      createdAt: 10_000,
      activeMs: 120_000, // the PREVIOUS lifetime's banked number must NOT ride the live tick
      inRun: true,
      turnStartedAt: null,
    };
    expect(formatElapsed(adoptedLive, 40_000)).toBe("30s");
    expect(formatElapsed(adoptedLive, 95_000)).toBe("1m 25s");
    // Settled: the durable reading again.
    const settled: TaskInfoWire = { ...adoptedLive, adoptedLive: undefined, status: "adopted-completed" };
    expect(formatElapsed(settled, 9_999_999)).toBe("2m 0s");
  });

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

// ── Durable (restart-rebuilt) rows ──────────────────────────────────────────

describe("openTargetFor", () => {
  it("B4: a live row opens the worker's OWN session; a settled row opens its durable log", () => {
    expect(openTargetFor({ ...taskInfoWire, agentSessionId: "w1" })).toEqual({ sessionId: "w1" });
    expect(
      openTargetFor({ ...taskInfoWire, status: "queued", agentSessionId: "w1" }),
    ).toEqual({ sessionId: "w1" });
    expect(
      openTargetFor({ ...taskInfoWire, status: "completed", inRun: false, agentSessionId: "w1" }),
    ).toEqual({ logId: "w1" });
  });

  it("a row whose worker key was never recorded has NO target (no dead click)", () => {
    // Queued before the agent was built, or a task that died pre-join.
    expect(openTargetFor(taskInfoWire)).toBeNull();
    expect(openTargetFor({ ...taskInfoWire, status: "completed" })).toBeNull();
  });

  it("a durable row with a recorded worker key opens the worker's durable log", () => {
    expect(
      openTargetFor({
        ...taskInfoWire,
        status: "interrupted",
        durable: true,
        agentSessionId: "worker-9",
      }),
    ).toEqual({ logId: "worker-9" });
  });

  it("a durable row written before the agent join has NO target (no dead click)", () => {
    expect(openTargetFor({ ...taskInfoWire, status: "completed", durable: true })).toBeNull();
  });

  it("adoptedLive: the durable card whose worker is LIVE here opens the live attach", () => {
    // Durable card, live session: switchSession, NOT viewLog.
    expect(
      openTargetFor({
        ...taskInfoWire,
        status: "running",
        durable: true,
        adoptedLive: true,
        agentSessionId: "worker-live-1",
      }),
    ).toEqual({ sessionId: "worker-live-1" });
    // No worker key, no target: the overlay never invents a join.
    expect(
      openTargetFor({ ...taskInfoWire, status: "running", durable: true, adoptedLive: true }),
    ).toBeNull();
  });

  it("settled adopted cards fall back to the cold log (adoptedLive dropped with the row)", () => {
    expect(
      openTargetFor({
        ...taskInfoWire,
        status: "adopted-completed",
        durable: true,
        agentSessionId: "worker-live-1",
      }),
    ).toEqual({ logId: "worker-live-1" });
  });
});

describe("SubagentStatusGlyph: adopted terminals", () => {
  it("the adopted tokens get done/cross shapes, and the row token is never renamed", () => {
    const done = renderToString(<SubagentStatusGlyph status="adopted-completed" />);
    const died = renderToString(<SubagentStatusGlyph status="adopted-died" />);
    expect(done).toContain("subagent-glyph-adopted-completed");
    expect(died).toContain("subagent-glyph-adopted-died");
    // Twins of the completed/failed paths, not the unknown dot.
    expect(done).not.toContain("subagent-glyph-unknown");
    expect(died).not.toContain("subagent-glyph-unknown");
    expect(done).toContain('M4 12l5 5L20 6');
    expect(died).toContain('M6 6 18 18M18 6 6 18');
  });
});

describe("SubagentStatusGlyph: interrupted", () => {
  it("severs its own broken-ring shape, not the unknown dot", () => {
    const cls = renderToString(<SubagentStatusGlyph status="interrupted" />);
    expect(cls).toContain("subagent-glyph-interrupted");
    expect(cls).not.toContain("subagent-glyph-unknown");
    // Parked still wins its dashed ring over any status token.
    expect(renderToString(<SubagentStatusGlyph status="interrupted" parked />)).toContain(
      "subagent-glyph-parked",
    );
  });
});
