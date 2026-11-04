// Tests for webui/ui/utils.ts. Pure functions run anywhere; the clipboard
// copyText path rides the dom-helper stub preloaded for the whole suite.

import { describe, it, expect, afterEach } from "bun:test";
import {
  formatTime,
  formatTokenCount,
  formatCallDuration,
  shortId,
  sanitize,
  resolveQuestionAnswer,
  clampSidebarWidth,
  copyText,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
} from "@extensions/webui/ui/utils.ts";

describe("formatTime", () => {
  it("formats a timestamp as HH:MM", () => {
    const ts = new Date("2024-01-01T14:30:00Z").getTime();
    const result = formatTime(ts);
    expect(result).toMatch(/^\d{2}:\d{2}$/);
  });

  it("pads single-digit hours and minutes", () => {
    // Use a fixed date where we know the local time
    const ts = new Date("2024-01-01T09:05:00").getTime();
    const result = formatTime(ts);
    expect(result).toMatch(/^\d{2}:\d{2}$/);
    const parts = result.split(":");
    expect(parts[0]!.length).toBe(2);
    expect(parts[1]!.length).toBe(2);
  });
});

describe("formatCallDuration", () => {
  it("keeps one decimal below 10s so a fast call never reads as 0s", () => {
    expect(formatCallDuration(900)).toBe("0.9s");
    expect(formatCallDuration(4200)).toBe("4.2s");
    expect(formatCallDuration(9999)).toBe("10.0s"); // rounds up at the band edge
  });

  it("delegates the whole-second house format above 10s", () => {
    expect(formatCallDuration(10_000)).toBe("10s");
    expect(formatCallDuration(61_000)).toBe("1m 01s");
    expect(formatCallDuration(3_909_000)).toBe("1h 05m 09s");
  });

  it("0 renders 0.0s (a measured instant is attested, not absent)", () => {
    expect(formatCallDuration(0)).toBe("0.0s");
  });
});

describe("formatTokenCount", () => {
  it("renders plain integers below 1000", () => {
    expect(formatTokenCount(0)).toBe("0");
    expect(formatTokenCount(15)).toBe("15");
    expect(formatTokenCount(999)).toBe("999");
  });

  it("uses one-decimal k below 10k, stripping a trailing .0", () => {
    expect(formatTokenCount(1000)).toBe("1k");
    expect(formatTokenCount(1900)).toBe("1.9k");
    expect(formatTokenCount(2869)).toBe("2.9k");
    // 1.959 rounds to 2.0 at one decimal, then the .0 is stripped.
    expect(formatTokenCount(1959)).toBe("2k");
    // 9.999 rounds to 10.0 across the band edge.
    expect(formatTokenCount(9999)).toBe("10k");
  });

  it("uses integer k below 1M", () => {
    expect(formatTokenCount(10_000)).toBe("10k");
    expect(formatTokenCount(12_000)).toBe("12k");
    expect(formatTokenCount(153_281)).toBe("153k");
    expect(formatTokenCount(200_000)).toBe("200k");
    // 999.999 rounds up across the band edge: 1000k, not 1M.
    expect(formatTokenCount(999_999)).toBe("1000k");
  });

  it("uses one-decimal M at 1M and above, stripping a trailing .0", () => {
    expect(formatTokenCount(1_000_000)).toBe("1M");
    expect(formatTokenCount(1_234_567)).toBe("1.2M");
    expect(formatTokenCount(1_500_000)).toBe("1.5M");
    expect(formatTokenCount(12_000_000)).toBe("12M");
  });

  it("passes non-finite and negative values through unchanged", () => {
    expect(formatTokenCount(NaN)).toBe("NaN");
    expect(formatTokenCount(Infinity)).toBe("Infinity");
    expect(formatTokenCount(-Infinity)).toBe("-Infinity");
    expect(formatTokenCount(-5)).toBe("-5");
  });
});

describe("shortId", () => {
  it("returns first 8 chars of sessionId", () => {
    expect(shortId("abcdef12-3456-7890-abcd-ef1234567890")).toBe("abcdef12");
  });

  it("returns full string when shorter than 8 chars", () => {
    expect(shortId("abc")).toBe("abc");
  });

  it("returns '???' for null/undefined", () => {
    expect(shortId(null)).toBe("???");
    expect(shortId(undefined)).toBe("???");
  });
});

describe("sanitize", () => {
  it("escapes HTML entities", () => {
    expect(sanitize("<script>alert('xss')</script>")).toBe("&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;");
  });

  it("escapes all special characters", () => {
    expect(sanitize('a & b < c > d "e" \'f\'')).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &#39;f&#39;");
  });

  it("returns empty string for null/undefined", () => {
    expect(sanitize(null)).toBe("");
    expect(sanitize(undefined)).toBe("");
  });

  it("returns unchanged string with no special chars", () => {
    expect(sanitize("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(sanitize("")).toBe("");
  });
});


// ── resolveQuestionAnswer (shared module wiring) ────────────────────────────

describe("question resolver wiring", () => {
  it("webui utils re-export the shared @utils/question-answer resolver", async () => {
    const shared = await import("@utils/question-answer.ts");
    expect(resolveQuestionAnswer).toBe(shared.resolveQuestionAnswer);
  });
});


// ── Sidebar resize clamp ────────────────────────────────────────────────────

describe("clampSidebarWidth", () => {
  it("passes through values in range", () => {
    expect(clampSidebarWidth(300, 1200)).toBe(300);
  });

  it("clamps below to the minimum", () => {
    expect(clampSidebarWidth(50, 1200)).toBe(200);
  });

  it("clamps above to 520 on wide viewports", () => {
    expect(clampSidebarWidth(800, 1200)).toBe(520);
  });

  it("caps at half the viewport when that is tighter", () => {
    expect(clampSidebarWidth(500, 900)).toBe(450);
  });

  it("keeps the minimum on degenerate sub-400px viewports", () => {
    expect(clampSidebarWidth(100, 300)).toBe(200);
  });

  it("matches the exported bounds", () => {
    expect(clampSidebarWidth(0, 4000)).toBe(SIDEBAR_MIN_WIDTH);
    expect(clampSidebarWidth(9999, 4000)).toBe(SIDEBAR_MAX_WIDTH);
    expect(clampSidebarWidth(SIDEBAR_DEFAULT_WIDTH, 1200)).toBe(SIDEBAR_DEFAULT_WIDTH);
  });
});

// ── copyText (DOM via the preloaded dom-helper stub) ────────────────────────

describe("copyText", () => {
  const g = globalThis as Record<string, unknown>;
  const doc = document as unknown as { execCommand?: (cmd: string) => boolean };
  const prevNavigator = g.navigator;
  const prevExec = doc.execCommand;

  afterEach(() => {
    g.navigator = prevNavigator;
    doc.execCommand = prevExec;
  });

  it("resolves through the async clipboard in a secure context", async () => {
    const written: string[] = [];
    g.navigator = { clipboard: { writeText: async (t: string) => void written.push(t) } };
    expect(await copyText("id-42")).toBe(true);
    expect(written).toEqual(["id-42"]);
  });

  it("falls back to the legacy textarea copy when the clipboard API rejects", async () => {
    g.navigator = { clipboard: { writeText: async () => { throw new Error("permission denied"); } } };
    const seen: { cmd: string | null } = { cmd: null };
    doc.execCommand = (c: string) => { seen.cmd = c; return true; };
    const before = document.body.childNodes.length;
    expect(await copyText("legacy")).toBe(true);
    expect(seen.cmd).toBe("copy");
    // The injected textarea is torn down with the copy, not left in the body.
    expect(document.body.childNodes.length).toBe(before);
  });

  it("falls back when the clipboard API is absent entirely", async () => {
    g.navigator = {};
    const seen: { cmd: string | null } = { cmd: null };
    doc.execCommand = (c: string) => { seen.cmd = c; return true; };
    expect(await copyText("plain-http")).toBe(true);
    expect(seen.cmd).toBe("copy");
  });

  it("reports failure when execCommand says no", async () => {
    g.navigator = {};
    doc.execCommand = () => false;
    expect(await copyText("x")).toBe(false);
  });

  it("reports failure when execCommand throws", async () => {
    g.navigator = {};
    doc.execCommand = () => { throw new Error("unsupported"); };
    expect(await copyText("x")).toBe(false);
  });
});
