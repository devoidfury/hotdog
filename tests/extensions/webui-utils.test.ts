// Tests for webui/ui/utils.ts — pure utility functions.
// Note: DOM-dependent UI components (app.ts, chat.ts, login.ts, message-list.ts,
// sessions.ts) cannot be tested in Bun without a DOM polyfill.

import { describe, it, expect } from "bun:test";
import {
  formatTime,
  shortId,
  sanitize,
  escapeJson,
  resolveQuestionAnswer,
} from "../../src/extensions/webui/ui/utils.ts";

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


// ── resolveQuestionAnswer ───────────────────────────────────────────────────

describe("resolveQuestionAnswer", () => {
  const noSel = { text: "", selectedOption: null as string | null };

  it("uses free text over option selection", () => {
    const q = { key: "k", options: ["a", "b"] };
    const res = resolveQuestionAnswer(q, { text: "custom", selectedOption: "a" });
    expect(res).toEqual({ value: "custom", error: null });
  });

  it("uses selected option when no text", () => {
    const q = { key: "k", options: ["a", "b"] };
    const res = resolveQuestionAnswer(q, { text: "", selectedOption: "b" });
    expect(res).toEqual({ value: "b", error: null });
  });

  it("falls back to default when nothing selected and default is an option", () => {
    const q = { key: "k", options: ["a", "b"], default: "a" };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res).toEqual({ value: "a", error: null });
  });

  it("free text without options", () => {
    const q = { key: "k" };
    const res = resolveQuestionAnswer(q, { text: "hello", selectedOption: null });
    expect(res).toEqual({ value: "hello", error: null });
  });

  it("default without options", () => {
    const q = { key: "k", default: "fallback" };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res).toEqual({ value: "fallback", error: null });
  });

  it("required rejects empty value", () => {
    const q = { key: "k", required: true };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res.error).toBe("This question is required.");
    expect(res.value).toBe("");
  });

  it("optional question allows empty value", () => {
    const q = { key: "k", required: false, default: "" };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res).toEqual({ value: "", error: null });
  });

  it("strict options (allowOther=false) rejects non-matching text", () => {
    const q = { key: "k", options: ["a", "b"], allowOther: false };
    const res = resolveQuestionAnswer(q, { text: "zzz", selectedOption: null });
    expect(res.error).toBe("Must be one of: a, b");
  });

  it("strict options accepts text that matches an option", () => {
    const q = { key: "k", options: ["a", "b"], allowOther: false };
    const res = resolveQuestionAnswer(q, { text: "a", selectedOption: null });
    expect(res).toEqual({ value: "a", error: null });
  });

  it("strict options falls back to default when it is an option", () => {
    const q = { key: "k", options: ["a", "b"], default: "b", allowOther: false };
    const res = resolveQuestionAnswer(q, noSel);
    expect(res).toEqual({ value: "b", error: null });
  });

  it("trims whitespace from text", () => {
    const q = { key: "k" };
    const res = resolveQuestionAnswer(q, { text: "  padded  ", selectedOption: null });
    expect(res).toEqual({ value: "padded", error: null });
  });

  it("empty text with selected option in allowOther mode", () => {
    const q = { key: "k", options: ["x", "y"] };
    const res = resolveQuestionAnswer(q, { text: "   ", selectedOption: "y" });
    expect(res).toEqual({ value: "y", error: null });
  });
});
