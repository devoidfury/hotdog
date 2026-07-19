// Tests for core/extensions/tool-utils.ts — tool definition helpers,
// argument parsing, result formatting, and XML utilities.

import { describe, it, expect, beforeAll } from "bun:test";
import {
  toolDef,
  param,
  parseToolArgs,
  toolResult,
  truncateOutput,
  generateDiff,
  getRequiredStr,
  ToolResult,
} from "../../src/core/extensions/tool-utils.ts";

describe("toolDef", () => {
  it("creates a tool definition", () => {
    const def = toolDef("test", "A test tool", {
      properties: { x: { type: "string" } },
    });
    expect(def).toEqual({
      type: "function",
      function: {
        name: "test",
        description: "A test tool",
        parameters: {
          schema: "https://json-schema.org/draft/2020-12/schema",
          type: "object",
          properties: { x: { type: "string" } },
          required: [],
        },
      },
    });
  });

  it("includes required fields", () => {
    const def = toolDef("test", "desc", { required: ["x", "y"] });
    expect(def.function.parameters.required).toEqual(["x", "y"]);
  });

  it("handles missing parameters", () => {
    const def = toolDef("test", "desc", {});
    expect(def.function.parameters.properties).toEqual({});
    expect(def.function.parameters.required).toEqual([]);
  });
});

describe("param", () => {
  it("creates a parameter with description", () => {
    expect(param("string", "A path")).toEqual({
      type: "string",
      description: "A path",
    });
  });

  it("creates a parameter without description", () => {
    expect(param("integer", "")).toEqual({ type: "integer", description: "" });
  });
});

describe("parseToolArgs", () => {
  it("parses valid JSON string", () => {
    expect(parseToolArgs('{"x": 1}')).toEqual({ x: 1 });
  });

  it("returns raw string on parse failure", () => {
    expect(parseToolArgs("not json")).toEqual({ input: "not json" });
  });

  it("returns object as-is", () => {
    const obj = { x: 1 };
    expect(parseToolArgs(obj)).toBe(obj);
  });
});

describe("toolResult", () => {
  it("returns string as-is", () => {
    expect(toolResult("result")).toBe("result");
  });

  it("stringifies objects", () => {
    expect(toolResult({ key: "val" })).toBe('{"key":"val"}');
  });

  it("converts numbers to string", () => {
    expect(toolResult(42)).toBe("42");
  });

  it("converts null to string", () => {
    expect(toolResult(null)).toBe("null");
  });
});

describe("truncateOutput", () => {
  it("returns empty string for null", () => {
    expect(truncateOutput(null as any, 10)).toBe("");
  });

  it("returns empty string for undefined", () => {
    expect(truncateOutput(undefined as any, 10)).toBe("");
  });

  it("returns text under limit", () => {
    const text = "line1\nline2\nline3";
    expect(truncateOutput(text, 10)).toBe(text);
  });

  it("truncates text over limit", () => {
    const lines = Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join(
      "\n",
    );
    const result = truncateOutput(lines, 3);
    expect(result).toContain("line3");
    expect(result).toContain("[truncated, 2 more lines]");
  });

  it("handles single line", () => {
    expect(truncateOutput("single", 1)).toBe("single");
  });

  it("handles zero max lines", () => {
    const result = truncateOutput("line1\nline2", 0);
    expect(result).toBe("\n--- [truncated, 2 more lines] ---");
  });
});

describe("generateDiff", () => {
  it("returns empty for identical text", () => {
    expect(generateDiff("hello", "hello")).toBe("");
  });

  it("shows changed lines", () => {
    const oldText = "line1\nold\nline3";
    const newText = "line1\nnew\nline3";
    const diff = generateDiff(oldText, newText);
    expect(diff).toContain("- old");
    expect(diff).toContain("+ new");
  });

  it("shows added lines", () => {
    const diff = generateDiff("a", "a\nb");
    expect(diff).toContain("+ b");
  });

  it("shows removed lines", () => {
    const diff = generateDiff("a\nb", "a");
    expect(diff).toContain("- b");
  });

  it("limits comparison phase", () => {
    const oldLines = Array.from({ length: 50 }, (_, i) => `old${i}`).join("\n");
    const newLines = Array.from({ length: 50 }, (_, i) => `new${i}`).join("\n");
    const diff = generateDiff(oldLines, newLines, 5);
    // maxLines limits comparison phase; remaining lines still added
    const diffLines = diff.split("\n");
    expect(diffLines.length).toBeGreaterThan(10);
  });
});

describe("ToolResult", () => {
  it("creates success result with ok()", () => {
    const r = ToolResult.ok("hello");
    expect(r.success).toBe(true);
    expect(r.output).toBe("hello");
    expect(r.error).toBeNull();
    expect(r.isOk()).toBe(true);
    expect(r.isErr()).toBe(false);
  });

  it("creates error result with err()", () => {
    const r = ToolResult.err("not found");
    expect(r.success).toBe(false);
    expect(r.output).toBe("");
    expect(r.error).toBe("not found");
    expect(r.isOk()).toBe(false);
    expect(r.isErr()).toBe(true);
  });

  it("chains withEntry to add metadata", () => {
    const r = ToolResult.ok("out").withEntry("key", "val");
    expect(r.metadata!).toBeInstanceOf(Map);
    expect(r.metadata!.get("key")).toBe("val");
  });

  it("chains withEntries to add multiple metadata", () => {
    const r = ToolResult.ok("out").withEntries({ a: "1", b: "2" });
    expect(r.metadata!.get("a")).toBe("1");
    expect(r.metadata!.get("b")).toBe("2");
  });

  it("chains withOutputTag", () => {
    const r = ToolResult.ok("data").withOutputTag("result");
    expect(r.outputTag).toBe("result");
  });

  it("chains withImages", () => {
    const images = [{ type: "image_url", mimeType: "image/png", data: "base64..." }];
    const r = ToolResult.ok("img").withImages(images);
    expect(r.images).toBe(images);
  });

  it("toDisplay returns output", () => {
    expect(ToolResult.ok("hello world").toDisplay()).toBe("hello world");
  });

  it("toDisplay appends error for failures", () => {
    const r = ToolResult.err("command failed");
    expect(r.toDisplay()).toBe("Error: command failed");
  });

  it("toDisplay combines output + error", () => {
    const r = ToolResult.ok("partial output").withEntry("x", "1");
    r.success = false;
    r.error = "partial failure";
    expect(r.toDisplay()).toBe("partial output\nError: partial failure");
  });

  it("toApiContent success no metadata", () => {
    const r = ToolResult.ok("hello world");
    const content = r.toApiContent("bash");
    expect(content).toBe(
      '<tool name="bash" status="success">\n  <output>hello world</output>\n</tool>',
    );
  });

  it("toApiContent failure with error", () => {
    const r = ToolResult.err("command not found");
    const content = r.toApiContent("bash");
    expect(content).toContain('<tool name="bash" status="failure">');
    expect(content).toContain("<error>command not found</error>");
    expect(content).toContain("<output></output>");
  });

  it("toApiContent with metadata", () => {
    const r = ToolResult.ok("output")
      .withEntry("key1", "val1")
      .withEntry("key2", "val2");
    const content = r.toApiContent("read_file");
    expect(content).toContain('<tool name="read_file" status="success">');
    expect(content).toContain("<output>output</output>");
    expect(content).toContain("<key1>val1</key1>");
    expect(content).toContain("<key2>val2</key2>");
  });

  it("toApiContent no error when success", () => {
    const content = ToolResult.ok("ok").toApiContent("bash");
    expect(content).not.toContain("<error>");
  });

  it("toApiContent custom output tag", () => {
    const content = ToolResult.ok("hello world")
      .withOutputTag("result")
      .toApiContent("bash");
    expect(content).toBe(
      '<tool name="bash" status="success">\n  <result>hello world</result>\n</tool>',
    );
  });

  it("toApiContent short metadata as attributes", () => {
    const r = ToolResult.ok("output")
      .withEntry("truncated", "true")
      .withEntry("page", "1")
      .withEntry("total_pages", "3")
      .withEntry("duration_ms", "42")
      .withEntry("diff", "--- a/file\n+++ b/file");
    const content = r.toApiContent("edit");
    expect(content).toContain('name="edit"');
    expect(content).toContain('status="success"');
    expect(content).toContain('duration_ms="42"');
    expect(content).toContain('page="1"');
    expect(content).toContain('total_pages="3"');
    expect(content).toContain('truncated="true"');
    expect(content).toContain("<diff>--- a/file\n+++ b/file</diff>");
    expect(content).toContain("<output>output</output>");
  });

  it("toApiContent does NOT escape output content", () => {
    const r = ToolResult.ok("a < b & c > d");
    const content = r.toApiContent("bash");
    // Output content is raw (not XML-escaped)
    expect(content).toContain("a < b & c > d");
  });

  it("toolResult passes through ToolResult via toDisplay()", () => {
    const r = ToolResult.ok("hello").withEntry("x", "1");
    expect(toolResult(r)).toBe("hello");

    const err = ToolResult.err("boom");
    expect(toolResult(err)).toBe("Error: boom");
  });

  it("toolResult with toolName wraps ToolResult in XML", () => {
    const r = ToolResult.ok("hello");
    const result = toolResult(r, "bash");
    expect(result).toContain('<tool name="bash"');
    expect(result).toContain('status="success"');
    expect(result).toContain("<output>hello</output>");
  });

  it("toolResult with toolName wraps string in XML", () => {
    const result = toolResult("plain text", "read");
    expect(result).toContain('<tool name="read"');
    expect(result).toContain("<output>plain text</output>");
  });

  it("toolResult with toolName wraps object in XML", () => {
    const result = toolResult({ key: "val" }, "fetch");
    expect(result).toContain('<tool name="fetch"');
    expect(result).toContain("<output>");
    expect(result).toContain('{"key":"val"}');
  });

  it("toolResult with toolName wraps number in XML", () => {
    const result = toolResult(42, "calc");
    expect(result).toContain('<tool name="calc"');
    expect(result).toContain("<output>42</output>");
  });

  it("ToolResult.from() creates a result with defaults", () => {
    const r = ToolResult.from({ output: "hello", error: null });
    expect(r.success).toBe(true);
    expect(r.output).toBe("hello");
    expect(r.error).toBeNull();
  });

  it("ToolResult.from() auto-fails when error provided", () => {
    const r = ToolResult.from({ output: "", error: "fail" });
    expect(r.success).toBe(false);
    expect(r.error).toBe("fail");
  });

  it("ToolResult.from() overrides success when error provided (even if success=true)", () => {
    const r = ToolResult.from({ output: "partial", error: "warning", success: true });
    expect(r.success).toBe(false); // error overrides success
    expect(r.output).toBe("partial");
    expect(r.error).toBe("warning");
  });

  it("ToolResult.from() preserves success=false with error", () => {
    const r = ToolResult.from({ output: "partial", error: "warning", success: false });
    expect(r.success).toBe(false);
    expect(r.output).toBe("partial");
    expect(r.error).toBe("warning");
  });

  it("ToolResult.from() accepts metadata and outputTag", () => {
    const metadata = new Map();
    metadata.set("key", "value");
    const r = ToolResult.from({ output: "out", error: null, metadata, outputTag: "result" });
    expect(r.metadata).toBe(metadata);
    expect(r.outputTag).toBe("result");
  });

  it("ToolResult.from() accepts images", () => {
    const images = [{ type: "image_url", mimeType: "image/png", data: "base64..." }];
    const r = ToolResult.from({ output: "img", images });
    expect(r.images).toBe(images);
  });
});

describe("getRequiredStr", () => {
  it("returns string value", () => {
    expect(getRequiredStr({ name: "Alice" }, "name")).toBe("Alice");
  });

  it("throws for missing key", () => {
    expect(() => getRequiredStr({ name: "Alice" }, "age")).toThrow(
      "Missing required argument: age",
    );
  });

  it("throws for non-string value", () => {
    expect(() => getRequiredStr({ count: 42 }, "count")).toThrow(
      "Missing required argument: count",
    );
  });

  it("throws for null input", () => {
    expect(() => getRequiredStr(null as any, "key")).toThrow(
      "Missing required argument: key",
    );
  });
});

// ── Additional tool-utils.ts coverage ────────────────────────────────────────

describe("xmlEscape", () => {
  let xmlEscape: (s: string) => string;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/tool-utils.ts");
    xmlEscape = mod.xmlEscape;
  });

  it("escapes & < > \" '", () => {
    expect(xmlEscape("a & b < c > d \"e\" 'f'")).toBe("a &amp; b &lt; c &gt; d &quot;e&quot; &apos;f&apos;");
  });

  it("returns unchanged string with no special chars", () => {
    expect(xmlEscape("hello world")).toBe("hello world");
  });

  it("handles empty string", () => {
    expect(xmlEscape("")).toBe("");
  });
});

describe("parseToolInput", () => {
  let parseToolInput: (input: string | Record<string, unknown> | null) => Record<string, unknown> | null;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/tool-utils.ts");
    parseToolInput = mod.parseToolInput;
  });

  it("parses valid JSON string", () => {
    expect(parseToolInput('{"key": "value"}')).toEqual({ key: "value" });
  });

  it("returns null for invalid JSON string", () => {
    expect(parseToolInput("not json")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseToolInput("")).toBeNull();
  });

  it("returns null for whitespace-only string", () => {
    expect(parseToolInput("   ")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(parseToolInput(null)).toBeNull();
  });

  it("returns object as-is", () => {
    const obj = { key: "value" };
    expect(parseToolInput(obj)).toBe(obj);
  });
});

describe("defaultCallDisplay", () => {
  let defaultCallDisplay: (
    input: string | Record<string, unknown> | null,
    templateFn: (args: Record<string, unknown>) => string,
    options?: string | ((input: string | Record<string, unknown> | null) => string) | { fallback?: string | ((input: string | Record<string, unknown> | null) => string); returnRawOnParseError?: boolean } | undefined,
  ) => string;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/tool-utils.ts");
    defaultCallDisplay = mod.defaultCallDisplay;
  });

  it("renders template from valid JSON input", () => {
    const result = defaultCallDisplay('{"path": "/tmp"}', (args) => args.path as string);
    expect(result).toBe("/tmp");
  });

  it("renders template from object input", () => {
    const result = defaultCallDisplay({ path: "/tmp" }, (args) => args.path as string);
    expect(result).toBe("/tmp");
  });

  it("returns fallback string on parse error", () => {
    const result = defaultCallDisplay("not json", () => "template", "fallback");
    expect(result).toBe("fallback");
  });

  it("returns fallback function result on parse error", () => {
    const result = defaultCallDisplay("not json", () => "template", (input) => `raw: ${input}`);
    expect(result).toBe("raw: not json");
  });

  it("returns raw input on parse error when returnRawOnParseError is true", () => {
    const result = defaultCallDisplay("not json", () => "template", { returnRawOnParseError: true });
    expect(result).toBe("not json");
  });

  it("returns empty string for null input", () => {
    const result = defaultCallDisplay(null, () => "template");
    expect(result).toBe("");
  });

  it("returns empty string for empty string input", () => {
    const result = defaultCallDisplay("", () => "template");
    expect(result).toBe("");
  });
});

describe("formatToolResult", () => {
  let formatToolResult: (result: unknown, toolName: string, success: boolean) => string;

  beforeAll(async () => {
    const mod = await import("../../src/core/extensions/tool-utils.ts");
    formatToolResult = mod.formatToolResult;
  });

  it("delegates to toApiContent for ToolResult instances", () => {
    const r = ToolResult.ok("hello");
    const result = formatToolResult(r, "bash", true);
    expect(result).toContain("bash");
    expect(result).toContain("hello");
  });

  it("wraps string in XML on success", () => {
    const result = formatToolResult("output", "read", true);
    expect(result).toContain('name="read"');
    expect(result).toContain('status="success"');
    expect(result).toContain("<output>output</output>");
  });

  it("wraps string in XML on failure", () => {
    const result = formatToolResult("output", "read", false);
    expect(result).toContain('name="read"');
    expect(result).toContain('status="error"');
  });

  it("stringifies objects (with XML escaping)", () => {
    const result = formatToolResult({ key: "val" }, "fetch", true);
    expect(result).toContain("&quot;key&quot;:&quot;val&quot;");
  });

  it("escapes XML in string content", () => {
    const result = formatToolResult("a < b", "bash", true);
    expect(result).toContain("&lt;");
  });
});
