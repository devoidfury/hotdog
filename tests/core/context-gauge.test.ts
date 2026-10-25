import { describe, it, expect } from "bun:test";
import {
  contextUsagePercent,
  contextGaugeGlyph,
  contextGaugeSegment,
} from "@core/context-gauge.ts";

describe("contextUsagePercent", () => {
  it("computes rounded percent of a window", () => {
    expect(contextUsagePercent(100_000, 200_000)).toBe(50);
    expect(contextUsagePercent(68_000, 200_000)).toBe(34);
    expect(contextUsagePercent(33_333, 100_000)).toBe(33);
    expect(contextUsagePercent(190_000, 200_000)).toBe(95);
  });

  it("is 0 for empty or non-positive windows", () => {
    expect(contextUsagePercent(0, 200_000)).toBe(0);
    expect(contextUsagePercent(50, 0)).toBe(0);
    expect(contextUsagePercent(50, -1)).toBe(0);
    expect(contextUsagePercent(-5, 200_000)).toBe(0);
  });

  it("reports overfill honestly (no clamp of the number)", () => {
    expect(contextUsagePercent(250_000, 200_000)).toBe(125);
  });
});

describe("contextGaugeGlyph", () => {
  it("maps quarters with round-half-up steps", () => {
    expect(contextGaugeGlyph(0)).toBe("○");
    expect(contextGaugeGlyph(12)).toBe("○"); // round(0.48) = 0
    expect(contextGaugeGlyph(13)).toBe("◔"); // round(0.52) = 1
    expect(contextGaugeGlyph(37)).toBe("◔"); // round(1.48) = 1
    expect(contextGaugeGlyph(38)).toBe("◑"); // round(1.52) = 2
    expect(contextGaugeGlyph(63)).toBe("◕"); // round(2.52) = 3
    expect(contextGaugeGlyph(100)).toBe("●");
  });

  it("clamps out-of-range percents to the ends", () => {
    expect(contextGaugeGlyph(-5)).toBe("○");
    expect(contextGaugeGlyph(125)).toBe("●");
  });
});

describe("contextGaugeSegment", () => {
  it("renders glyph, percent, and grouped counts (en-US)", () => {
    expect(contextGaugeSegment(68_000, 200_000)).toBe("◔ 34% (68,000/200,000)");
    expect(contextGaugeSegment(0, 200_000)).toBe("○ 0% (0/200,000)");
    expect(contextGaugeSegment(250_000, 200_000)).toBe("● 125% (250,000/200,000)");
  });

  it("returns null when there is no window to measure against", () => {
    expect(contextGaugeSegment(68_000, 0)).toBeNull();
  });
});
