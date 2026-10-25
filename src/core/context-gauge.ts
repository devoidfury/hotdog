/**
 * Context-window gauge (pure, zero imports). Fill percentage of the context
 * window plus a quarter-circle glyph for human display.
 *
 * `used` is the last call's input total (net prompt + cached): the freshest
 * honest measure of what occupied the window. Overfill is reported as-is in
 * the number; only the glyph clamps.
 */

const GLYPHS = ["○", "◔", "◑", "◕", "●"] as const;
const GLYPH_STEP = 25; // percent per quarter-circle step

export function contextUsagePercent(used: number, window: number): number {
  // !> guard: rejects NaN/undefined too, not just non-positive numbers.
  if (!(window > 0) || !(used > 0)) return 0;
  return Math.round((used / window) * 100);
}

export function contextGaugeGlyph(percent: number): string {
  const step = Math.round(percent / GLYPH_STEP);
  return GLYPHS[Math.min(Math.max(step, 0), GLYPHS.length - 1)]!;
}

/** `◔ 34% (68,000/200,000)`, or null when no window is configured. */
export function contextGaugeSegment(used: number, window: number): string | null {
  if (!(window > 0)) return null;
  const percent = contextUsagePercent(used, window);
  const group = new Intl.NumberFormat("en-US");
  return `${contextGaugeGlyph(percent)} ${percent}% (${group.format(used)}/${group.format(window)})`;
}
