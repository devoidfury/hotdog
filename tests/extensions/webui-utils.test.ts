// Tests for webui/ui/utils.ts — pure utility functions.
// Note: DOM-dependent UI components (app.ts, chat.ts, login.ts, message-list.ts,
// sessions.ts) cannot be tested in Bun without a DOM polyfill.

import { describe, it, expect } from "bun:test";
import {
  formatTime,
  formatTokenCount,
  shortId,
  sanitize,
  escapeJson,
  resolveQuestionAnswer,
  clampSidebarWidth,
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
    expect(sanitize('a & b < c > d "e" \'f\'')).toBe("a &amp; b &lt; c &gt; d &#34;e&#34; &#39;f&#39;");
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

describe("escapeJson", () => {
  it("escapes backslashes, quotes, and newlines", () => {
    // Input: line1<newline>line2<tab>"quoted"<backslash>path
    // Output: line1\nline2\t\"quoted\"\\path (literal backslash sequences)
    const input = "line1\nline2\t\"quoted\"\\path";
    const result = escapeJson(input);
    expect(result).toContain("\\n");
    expect(result).toContain("\\t");
    expect(result).toContain("\\\"quoted\\\"");
    expect(result).toContain("\\\\path");
  });

  it("handles empty string", () => {
    expect(escapeJson("")).toBe("");
  });

  it("handles string with no special chars", () => {
    expect(escapeJson("hello")).toBe("hello");
  });

  it("escapes carriage returns", () => {
    const result = escapeJson("line1\r\nline2");
    expect(result).toContain("\\r");
    expect(result).toContain("\\n");
  });

  it("escapes each special char individually", () => {
    expect(escapeJson("\\")).toBe("\\\\");
    expect(escapeJson('"')).toBe('\\"');
    expect(escapeJson("\n")).toBe("\\n");
    expect(escapeJson("\r")).toBe("\\r");
    expect(escapeJson("\t")).toBe("\\t");
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
