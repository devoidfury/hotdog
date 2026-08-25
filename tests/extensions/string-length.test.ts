import { describe, it, expect } from "bun:test";
import {
  StringLengthTool,
  measureString,
} from "../../src/extensions/string-length/index.ts";
import type { ToolResult } from "../../src/core/extensions/tool-utils.ts";
import { resultStr, toolCtx } from "../helpers.ts";

const tool = new StringLengthTool();

// ZWJ family: man + ZWJ + woman + ZWJ + girl + ZWJ + boy
const FAMILY = "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F466}";
// e + combining acute accent
const COMBINING = "e\u0301";

async function runAsync(
  input: string | Record<string, unknown> | null,
): Promise<ToolResult> {
  return (await tool.execute(input, toolCtx())) as ToolResult;
}

// ── Tool Definition ─────────────────────────────────────────────────────────

describe("StringLengthTool.toToolDef", () => {
  it("returns a tool definition named string_length", () => {
    const def = tool.toToolDef();
    expect(def.type).toBe("function");
    expect(def.function.name).toBe("string_length");
  });

  it("requires the string parameter", () => {
    const def = tool.toToolDef();
    expect(def.function.parameters.required).toEqual(["string"]);
  });
});

// ── callDisplay ─────────────────────────────────────────────────────────────

describe("StringLengthTool.callDisplay", () => {
  it("shows a short label regardless of input size", () => {
    const display = tool.callDisplay({ string: "x".repeat(10_000) });
    expect(display).toBe("measuring string length...");
  });

  it("falls back for null input", () => {
    expect(tool.callDisplay(null)).toBe("measuring string length...");
  });
});

// ── execute ─────────────────────────────────────────────────────────────────

describe("StringLengthTool.execute", () => {
  it("measures an ASCII string identically in all units", async () => {
    const result = await runAsync({ string: "hello" });
    expect(result.success).toBe(true);
    const parsed = JSON.parse(resultStr(result));
    expect(parsed).toEqual({ utf16: 5, codepoints: 5, bytes: 5, graphemes: 5 });
  });

  it("measures CJK text (multibyte UTF-8, 1:1 code points)", async () => {
    const parsed = JSON.parse(resultStr(await runAsync({ string: "日本語" })));
    expect(parsed).toEqual({ utf16: 3, codepoints: 3, bytes: 9, graphemes: 3 });
  });

  it("counts a surrogate-pair emoji as 1 code point / 2 UTF-16 units / 4 bytes", async () => {
    const parsed = JSON.parse(resultStr(await runAsync({ string: "\u{1F44B}" })));
    expect(parsed).toEqual({ utf16: 2, codepoints: 1, bytes: 4, graphemes: 1 });
  });

  it("counts a ZWJ emoji sequence as a single grapheme", async () => {
    const parsed = JSON.parse(resultStr(await runAsync({ string: FAMILY })));
    expect(parsed.utf16).toBe(11);
    expect(parsed.codepoints).toBe(7);
    expect(parsed.bytes).toBe(25);
    expect(parsed.graphemes).toBe(1);
  });

  it("counts a base character plus combining mark as a single grapheme", async () => {
    const parsed = JSON.parse(resultStr(await runAsync({ string: COMBINING })));
    expect(parsed).toEqual({ utf16: 2, codepoints: 2, bytes: 3, graphemes: 1 });
  });

  it("measures the empty string as all zeros", async () => {
    const parsed = JSON.parse(resultStr(await runAsync({ string: "" })));
    expect(parsed).toEqual({ utf16: 0, codepoints: 0, bytes: 0, graphemes: 0 });
  });

  it("accepts a JSON-string input", async () => {
    const parsed = JSON.parse(resultStr(await runAsync(JSON.stringify({ string: "ab" }))));
    expect(parsed).toEqual({ utf16: 2, codepoints: 2, bytes: 2, graphemes: 2 });
  });

  it("attaches unit counts to result metadata", async () => {
    const result = await runAsync({ string: "\u{1F44B}" });
    const meta = result.metadata;
    expect(meta?.get("utf16")).toBe("2");
    expect(meta?.get("codepoints")).toBe("1");
    expect(meta?.get("bytes")).toBe("4");
    expect(meta?.get("graphemes")).toBe("1");
  });
});

// ── error handling ──────────────────────────────────────────────────────────

describe("StringLengthTool.execute errors", () => {
  it("rejects missing string argument", async () => {
    const result = await runAsync({});
    expect(result.success).toBe(false);
    expect((result as ToolResult).error).toMatch(/required/);
  });

  it("rejects non-string argument", async () => {
    const result = await runAsync({ string: 42 });
    expect(result.success).toBe(false);
    expect((result as ToolResult).error).toMatch(/must be a string/);
  });

  it("rejects unparseable input", async () => {
    const result = await runAsync("not json at all");
    expect(result.success).toBe(false);
    expect((result as ToolResult).error).toMatch(/parsing/);
  });

  it("rejects null input", async () => {
    const result = await runAsync(null);
    expect(result.success).toBe(false);
  });
});

// ── measureString (exported helper) ─────────────────────────────────────────

describe("measureString", () => {
  it("returns consistent results for mixed-script input", () => {
    const m = measureString(`a\u{1F600}中`);
    expect(m.utf16).toBe(4); // 'a' + surrogate pair + 中
    expect(m.codepoints).toBe(3);
    expect(m.bytes).toBe(1 + 4 + 3);
    expect(m.graphemes).toBe(3);
  });

  it("handles strings with only surrogate-pair code points", () => {
    const m = measureString("\u{1F30D}\u{1F30D}");
    expect(m.utf16).toBe(4);
    expect(m.codepoints).toBe(2);
    expect(m.graphemes).toBe(2);
  });
});
